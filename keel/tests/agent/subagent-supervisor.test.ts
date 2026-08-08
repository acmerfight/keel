import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import {
  createSharedCostBudgetedProvider,
  type SharedCostBudgetedProvider,
} from "../../src/agent/cost-budget.ts";
import {
  createSubagentSupervisor,
  type SubagentProgressEvent,
  type SubagentSupervisor,
} from "../../src/agent/subagent-supervisor.ts";
import type {
  AbortableToolOutputArtifactStore,
  ToolOutputArtifactSaveInput,
} from "../../src/agent/tool-output-artifacts.ts";
import type { CostModel } from "../../src/core/cost.ts";
import { KeelError } from "../../src/core/error.ts";
import type { LLMProvider, Usage } from "../../src/llm/types.ts";
import type { SubmittedAgentResult } from "../../src/tools/delegation.ts";
import { openAICompatibleTools } from "../../src/tools/registry.ts";

const costModel: CostModel = {
  type: "fixed",
  uncachedInputPerMillionTokens: 1,
  cachedInputPerMillionTokens: 0.5,
  outputPerMillionTokens: 2,
};

const requestUsage: Usage = {
  inputTokens: 100,
  cachedInputTokens: 0,
  uncachedInputTokens: 100,
  outputTokens: 10,
};

interface ArtifactCapture {
  readonly inputs: ToolOutputArtifactSaveInput[];
  readonly store: AbortableToolOutputArtifactStore;
}

function createArtifactCapture(): ArtifactCapture {
  const inputs: ToolOutputArtifactSaveInput[] = [];
  return {
    inputs,
    store: {
      abortSignalSupport: true,
      verifyReusable: async () => ({ status: "not_reusable" }),
      save: async (input) => {
        inputs.push(input);
        return {
          status: "stored",
          ref: `tool-output:test/${input.toolCallId}`,
          contentSha256: "0".repeat(64),
        };
      },
      discard: async () => {},
    },
  };
}

function completeAttempt(
  options: Parameters<LLMProvider["stream"]>[0],
  usage: Usage,
): void {
  options.providerRequestAttempts
    ?.begin()
    .finish({ outcome: "completed", usage });
}

function scriptedSuccessfulProvider(capturedTools: string[][]): LLMProvider {
  let calls = 0;
  return {
    id: "scripted-subagent",
    estimateInputTokens: () => 100,
    async *stream(options) {
      calls++;
      capturedTools.push(
        openAICompatibleTools(options.toolExposure ?? { kind: "auto" }).map(
          (tool) => tool.function.name,
        ),
      );
      if (calls === 1) {
        yield {
          type: "tool_call",
          id: "read_once",
          tool: "read",
          path: "module.ts",
        };
      } else {
        yield {
          type: "tool_call",
          id: "submit_once",
          tool: "submit_agent_result",
          summary: "module.ts exports 42.",
          evidence: [{ path: "module.ts", line: 1, detail: "answer is 42" }],
          risks: [],
        };
      }
      completeAttempt(options, requestUsage);
      yield { type: "stop", reason: "stop", usage: requestUsage };
    },
  };
}

function singleSubmissionProvider(result: SubmittedAgentResult): LLMProvider {
  return {
    id: "single-submission",
    estimateInputTokens: () => 100,
    async *stream(options) {
      yield {
        type: "tool_call",
        id: "submit_once",
        tool: "submit_agent_result",
        summary: result.summary,
        evidence: result.evidence.map((evidence) => ({ ...evidence })),
        risks: [...result.risks],
      };
      completeAttempt(options, requestUsage);
      yield { type: "stop", reason: "stop", usage: requestUsage };
    },
  };
}

function supervisorFixture(options: {
  readonly workspace: string;
  readonly provider: LLMProvider;
  readonly deadlineMs?: number;
  readonly settlementGraceMs?: number;
  readonly maxTurns?: number;
  readonly rootMaxCostUsd?: number;
  readonly transcriptStore?: AbortableToolOutputArtifactStore;
  readonly now?: () => number;
  readonly onProgress?: (event: SubagentProgressEvent) => void;
  readonly providerAbortSignalSupport?: boolean;
  readonly hiddenWorkspacePaths?: readonly string[];
}): {
  readonly supervisor: SubagentSupervisor;
  readonly rootBudget: SharedCostBudgetedProvider;
  readonly artifacts: ArtifactCapture;
} {
  const rootMaxCostUsd = options.rootMaxCostUsd ?? 0.01;
  const provider: LLMProvider =
    options.providerAbortSignalSupport === false
      ? options.provider
      : { ...options.provider, abortSignalSupport: true };
  const rootBudget = createSharedCostBudgetedProvider({
    provider,
    model: costModel,
    maxCostUsd: rootMaxCostUsd,
  });
  const artifacts = createArtifactCapture();
  return {
    rootBudget,
    artifacts,
    supervisor: createSubagentSupervisor({
      workspace: options.workspace,
      platform: process.platform,
      parentRunId: "main-run",
      provider: rootBudget.provider,
      providerId: provider.id,
      model: "test-model",
      costModel,
      rootMaxCostUsd,
      rootBudget,
      transcriptStore: options.transcriptStore ?? artifacts.store,
      now: options.now ?? (() => 0),
      onProgress: options.onProgress ?? (() => {}),
      ...(options.hiddenWorkspacePaths !== undefined
        ? { hiddenWorkspacePaths: options.hiddenWorkspacePaths }
        : {}),
      ...(options.deadlineMs !== undefined
        ? { deadlineMs: options.deadlineMs }
        : {}),
      ...(options.settlementGraceMs !== undefined
        ? { settlementGraceMs: options.settlementGraceMs }
        : {}),
      ...(options.maxTurns !== undefined ? { maxTurns: options.maxTurns } : {}),
    }),
  };
}

describe("Subagent Supervisor", () => {
  test(`Given a provider does not certify AbortSignal settlement,
    When main requests a child,
    Then admission fails before starting provider work or registering a run`, async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-subagent-supervisor-"),
    );
    let providerCalls = 0;
    const fixture = supervisorFixture({
      workspace,
      providerAbortSignalSupport: false,
      provider: {
        id: "uncertified-provider",
        estimateInputTokens: () => 100,
        async *stream() {
          providerCalls++;
          await new Promise<never>(() => {});
          yield { type: "text", text: "unreachable" };
        },
      },
    });

    try {
      const result = await fixture.supervisor.capability.delegate({
        toolCallId: "uncertified",
        task: "Do not start this child.",
        focusPaths: [],
        signal: new AbortController().signal,
      });

      expect(result).toEqual({
        ok: false,
        content:
          "Delegation rejected: the configured provider does not certify AbortSignal settlement.",
      });
      expect(providerCalls).toBe(0);
      expect(fixture.supervisor.totalAcceptedCount()).toBe(0);
      expect(fixture.supervisor.runSnapshots()).toEqual([]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given one delegation completes and the same parent tool call is replayed,
    When both calls settle and a second unique child is requested,
    Then only one child ran, replay usage is not counted twice, and the new child is rejected`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-subagent-supervisor-"),
    );
    await writeFile(
      join(workspace, "module.ts"),
      "export const answer = 42;\n",
    );
    const exposedTools: string[][] = [];
    const fixture = supervisorFixture({
      workspace,
      provider: scriptedSuccessfulProvider(exposedTools),
      hiddenWorkspacePaths: [],
    });
    const signal = new AbortController().signal;

    try {
      // When
      const first = await fixture.supervisor.capability.delegate({
        toolCallId: "delegate-1",
        task: "Inspect module.ts.",
        focusPaths: ["module.ts"],
        signal,
      });
      const replay = await fixture.supervisor.capability.delegate({
        toolCallId: "delegate-1",
        task: "Changed replay text must not create a new run.",
        focusPaths: [],
        signal,
      });
      const second = await fixture.supervisor.capability.delegate({
        toolCallId: "delegate-2",
        task: "Inspect it again.",
        focusPaths: [],
        signal,
      });

      // Then
      expect(first.ok).toBe(true);
      expect(first.usage).toEqual({
        inputTokens: 200,
        cachedInputTokens: 0,
        uncachedInputTokens: 200,
        outputTokens: 20,
      });
      expect(replay).toEqual({ ok: true, content: first.content });
      expect(second).toEqual({
        ok: false,
        content:
          "Delegation rejected: Slice 1 permits only one accepted child per root run.",
      });
      expect(fixture.supervisor.totalAcceptedCount()).toBe(1);
      expect(fixture.supervisor.activeRunCount()).toBe(0);
      expect(fixture.supervisor.runSnapshots()).toEqual([
        {
          delegationId: "main-run:delegate-1",
          childRunId: expect.stringMatching(/^subagent-/u),
          task: "Inspect module.ts.",
          state: "terminal",
          terminal: expect.objectContaining({
            status: "completed",
            usage: first.usage,
            turns: 2,
            costUsd: 0.00024,
            transcriptRef: "tool-output:test/delegate-1",
            error: null,
          }),
        },
      ]);
      expect(fixture.artifacts.inputs).toHaveLength(1);
      expect(fixture.artifacts.inputs[0]?.content).toContain(
        '"delegationId":"main-run:delegate-1"',
      );
      expect(fixture.artifacts.inputs[0]?.content).toMatch(
        /"childRunId":"subagent-[^"]+"/u,
      );
      expect(exposedTools).toHaveLength(2);
      for (const tools of exposedTools) {
        expect(tools.toSorted()).toEqual(
          [
            "git_diff",
            "git_status",
            "glob",
            "grep",
            "ls",
            "read",
            "submit_agent_result",
          ].toSorted(),
        );
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given progress delivery synchronously replays the accepted tool call and then throws,
    When Supervisor publishes queued and later lifecycle events,
    Then the receipt was registered first and observer failure cannot fork or strand the child`, async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-subagent-supervisor-"),
    );
    await writeFile(join(workspace, "module.ts"), "export const value = 1;\n");
    const exposedTools: string[][] = [];
    let supervisor: SubagentSupervisor | undefined;
    let replay: Promise<unknown> | undefined;
    let queuedSnapshot:
      | ReturnType<SubagentSupervisor["runSnapshots"]>[number]
      | undefined;
    const fixture = supervisorFixture({
      workspace,
      provider: scriptedSuccessfulProvider(exposedTools),
      onProgress: (event) => {
        if (event.status === "queued" && supervisor !== undefined) {
          queuedSnapshot = supervisor.runSnapshots()[0];
          replay = supervisor.capability.delegate({
            toolCallId: "reentrant",
            task: "A replay must join the registered run.",
            focusPaths: [],
            signal: new AbortController().signal,
          });
        }
        throw new Error("progress sink failed");
      },
    });
    supervisor = fixture.supervisor;

    try {
      const result = await supervisor.capability.delegate({
        toolCallId: "reentrant",
        task: "Inspect module.ts.",
        focusPaths: ["module.ts"],
        signal: new AbortController().signal,
      });
      if (replay === undefined)
        throw new Error("queued replay was not observed");
      await replay;

      expect(result.ok).toBe(true);
      expect(supervisor.totalAcceptedCount()).toBe(1);
      expect(supervisor.activeRunCount()).toBe(0);
      expect(exposedTools).toHaveLength(2);
      expect(queuedSnapshot).toMatchObject({
        state: "queued",
        terminal: null,
      });
      expect(supervisor.runSnapshots()[0]).toMatchObject({
        state: "terminal",
        terminal: { status: "completed" },
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test.each([
    {
      adapter: "throws",
      now: () => {
        throw new Error("clock adapter failed");
      },
    },
    { adapter: "returns a non-finite value", now: () => Number.NaN },
  ])(
    `Given the progress clock adapter $adapter at every lifecycle observation,
    When one accepted child runs to completion,
    Then observation failure cannot strand the receipt, change the terminal, or retain an active slot`,
    async ({ now }) => {
      const workspace = await mkdtemp(
        join(tmpdir(), "keel-subagent-supervisor-"),
      );
      await writeFile(
        join(workspace, "module.ts"),
        "export const value = 1;\n",
      );
      const progress: SubagentProgressEvent[] = [];
      const fixture = supervisorFixture({
        workspace,
        provider: scriptedSuccessfulProvider([]),
        now,
        onProgress: (event) => progress.push(event),
      });

      try {
        const result = await fixture.supervisor.capability.delegate({
          toolCallId: "throwing-clock",
          task: "Complete despite observation failure.",
          focusPaths: ["module.ts"],
          signal: new AbortController().signal,
        });

        expect(result.ok).toBe(true);
        expect(fixture.supervisor.activeRunCount()).toBe(0);
        expect(fixture.supervisor.runSnapshots()).toMatchObject([
          { state: "terminal", terminal: { status: "completed", turns: 2 } },
        ]);
        expect(progress.map((event) => event.status)).toEqual([
          "queued",
          "running",
          "turn",
          "tool",
          "turn",
          "tool",
          "completed",
        ]);
        expect(progress.every((event) => event.elapsedMs === 0)).toBe(true);
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    },
  );

  test(`Given delegation requests have an invalid focus path or cannot preserve main synthesis budget,
    When Supervisor performs admission and the rejected call is replayed,
    Then no child starts and each stable receipt returns the original rejection`, async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-subagent-supervisor-"),
    );
    let providerCalls = 0;
    const provider: LLMProvider = {
      id: "must-not-run",
      async *stream() {
        providerCalls++;
        yield { type: "text", text: "unexpected" };
      },
    };

    try {
      const invalidFixture = supervisorFixture({ workspace, provider });
      const invalid = await invalidFixture.supervisor.capability.delegate({
        toolCallId: "invalid-focus",
        task: "Inspect an invalid path.",
        focusPaths: ["../outside"],
        signal: new AbortController().signal,
      });
      const invalidReplay = await invalidFixture.supervisor.capability.delegate(
        {
          toolCallId: "invalid-focus",
          task: "A replay cannot change admission.",
          focusPaths: [],
          signal: new AbortController().signal,
        },
      );
      const budgetFixture = supervisorFixture({
        workspace,
        provider,
        rootMaxCostUsd: 0,
      });
      const noBudget = await budgetFixture.supervisor.capability.delegate({
        toolCallId: "no-budget",
        task: "Inspect without a child budget.",
        focusPaths: [],
        signal: new AbortController().signal,
      });

      expect(invalid.ok).toBe(false);
      expect(invalid.content).toContain("invalid focus path");
      expect(invalidReplay).toEqual(invalid);
      expect(noBudget).toEqual({
        ok: false,
        content:
          "Delegation rejected: the root budget cannot fund a child while preserving the main synthesis reserve.",
      });
      expect(invalidFixture.supervisor.totalAcceptedCount()).toBe(0);
      expect(budgetFixture.supervisor.totalAcceptedCount()).toBe(0);
      expect(providerCalls).toBe(0);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a child submits more valid content than main may admit,
    When Supervisor stores the canonical transcript and projects the result,
    Then the main-facing payload is bounded while full submitted content remains inspectable`, async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-subagent-supervisor-"),
    );
    await writeFile(join(workspace, "module.ts"), "export const value = 1;\n");
    const fixture = supervisorFixture({
      workspace,
      provider: singleSubmissionProvider({
        summary: "s".repeat(8_000),
        evidence: Array.from({ length: 20 }, (_, index) => ({
          path: "module.ts",
          ...(index === 0 ? { line: 1 } : {}),
          detail: `e${index}:${"d".repeat(990)}`,
        })),
        risks: Array.from(
          { length: 10 },
          (_, index) => `r${index}:${"x".repeat(990)}`,
        ),
      }),
    });

    try {
      const result = await fixture.supervisor.capability.delegate({
        toolCallId: "bounded",
        task: "Return a deliberately large result.",
        focusPaths: ["module.ts"],
        signal: new AbortController().signal,
      });
      const admitted = z
        .object({
          status: z.literal("completed"),
          summary: z.string(),
          evidence: z.array(
            z.object({
              path: z.string(),
              line: z.number().optional(),
              detail: z.string(),
            }),
          ),
          risks: z.array(z.string()),
          transcriptRef: z.string(),
        })
        .passthrough()
        .parse(JSON.parse(result.content));

      expect(result.ok).toBe(true);
      expect(admitted.summary).toHaveLength(4_000);
      expect(admitted.summary.endsWith("...")).toBe(true);
      expect(admitted.evidence).toHaveLength(10);
      expect(admitted.evidence[0]?.line).toBe(1);
      expect(admitted.evidence[1]).not.toHaveProperty("line");
      expect(
        admitted.evidence.every((entry) => entry.detail.length <= 500),
      ).toBe(true);
      expect(admitted.risks).toHaveLength(5);
      expect(admitted.risks.every((risk) => risk.length <= 500)).toBe(true);
      expect(fixture.artifacts.inputs[0]?.content).toContain("d".repeat(900));
      expect(fixture.artifacts.inputs[0]?.content).toContain("r9:");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given individually bounded child fields expand beyond the aggregate JSON budget,
    When Supervisor serializes the admitted projection,
    Then it falls back to a complete compact schema instead of emitting truncated JSON`, async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-subagent-supervisor-"),
    );
    await writeFile(join(workspace, "module.ts"), "export const value = 1;\n");
    const fixture = supervisorFixture({
      workspace,
      provider: singleSubmissionProvider({
        summary: "\0".repeat(8_000),
        evidence: [{ path: "module.ts", detail: "\0".repeat(1_000) }],
        risks: ["\0".repeat(1_000)],
      }),
    });

    try {
      const result = await fixture.supervisor.capability.delegate({
        toolCallId: "aggregate-bound",
        task: "Return JSON-expanding bounded fields.",
        focusPaths: ["module.ts"],
        signal: new AbortController().signal,
      });
      const admitted = z
        .object({
          status: z.literal("completed"),
          transcriptRef: z.string(),
          truncated: z.literal(true),
          summary: z.string(),
          evidence: z.array(z.never()),
          risks: z.array(z.never()),
        })
        .passthrough()
        .parse(JSON.parse(result.content));

      expect(result.ok).toBe(true);
      expect(result.content.length).toBeLessThanOrEqual(24_000);
      expect(admitted.summary).toHaveLength(1_000);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test.each([
    {
      name: "provider auth failure",
      providerError: new KeelError("provider_auth_failed", "bad credentials"),
      expectedStatus: "provider_blocked",
    },
    {
      name: "provider rate limit",
      providerError: new KeelError("provider_rate_limited", "rate limited"),
      expectedStatus: "provider_blocked",
    },
    {
      name: "provider HTTP failure",
      providerError: new KeelError("provider_http_error", "bad gateway"),
      expectedStatus: "provider_blocked",
    },
    {
      name: "provider server failure",
      providerError: new KeelError("provider_server_error", "server failed"),
      expectedStatus: "provider_blocked",
    },
    {
      name: "non-blocking typed provider failure",
      providerError: new KeelError("provider_network_error", "network failed"),
      expectedStatus: "failed",
    },
    {
      name: "unexpected provider failure",
      providerError: new Error("provider exploded"),
      expectedStatus: "failed",
    },
  ])(
    `Given a child encounters $name,
    When Supervisor settles and stores the partial transcript,
    Then main receives the explicit $expectedStatus terminal result`,
    async ({ providerError, expectedStatus }) => {
      const workspace = await mkdtemp(
        join(tmpdir(), "keel-subagent-supervisor-"),
      );
      const provider: LLMProvider = {
        id: "failing-child",
        estimateInputTokens: () => 100,
        async *stream() {
          yield { type: "text", text: "" };
          throw providerError;
        },
      };
      const fixture = supervisorFixture({ workspace, provider });

      try {
        const result = await fixture.supervisor.capability.delegate({
          toolCallId: "failure",
          task: "Encounter the provider failure.",
          focusPaths: [],
          signal: new AbortController().signal,
        });

        expect(result.ok).toBe(false);
        expect(result.content).toContain(`"status":"${expectedStatus}"`);
        expect(result.content).toContain(providerError.message);
        expect(fixture.artifacts.inputs).toHaveLength(1);
        expect(fixture.supervisor.activeRunCount()).toBe(0);
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    },
  );

  test(`Given a child completes one billed read turn before a later provider block,
    When Supervisor emits the non-completed canonical result,
    Then the result retains all usage observed before the failure`, async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-subagent-supervisor-"),
    );
    await writeFile(join(workspace, "module.ts"), "export const value = 1;\n");
    let calls = 0;
    const provider: LLMProvider = {
      id: "partially-billed-child",
      estimateInputTokens: () => 100,
      async *stream(options) {
        calls++;
        if (calls === 1) {
          yield {
            type: "tool_call",
            id: "billed_read",
            tool: "read",
            path: "module.ts",
          };
          completeAttempt(options, requestUsage);
          yield { type: "stop", reason: "stop", usage: requestUsage };
          return;
        }
        yield { type: "text", text: "" };
        throw new KeelError("provider_auth_failed", "auth failed later");
      },
    };
    const fixture = supervisorFixture({ workspace, provider });

    try {
      const result = await fixture.supervisor.capability.delegate({
        toolCallId: "partially-billed",
        task: "Read once before provider failure.",
        focusPaths: ["module.ts"],
        signal: new AbortController().signal,
      });

      expect(result.ok).toBe(false);
      expect(result.content).toContain('"status":"provider_blocked"');
      expect(result.usage).toEqual(requestUsage);
      expect(calls).toBe(2);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a provider returns an extremely large failure reason,
    When Supervisor builds the admitted result,
    Then the projection stays valid and bounded with status and transcriptRef preserved`, async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-subagent-supervisor-"),
    );
    const provider: LLMProvider = {
      id: "large-failure",
      estimateInputTokens: () => 100,
      async *stream() {
        yield { type: "text", text: "" };
        throw new Error(`large:${"x".repeat(200_000)}`);
      },
    };
    const fixture = supervisorFixture({ workspace, provider });

    try {
      const result = await fixture.supervisor.capability.delegate({
        toolCallId: "large-failure",
        task: "Encounter a large provider failure.",
        focusPaths: [],
        signal: new AbortController().signal,
      });
      const admitted = z
        .object({
          status: z.literal("failed"),
          transcriptRef: z.string(),
          truncated: z.literal(true),
          summary: z.string(),
        })
        .passthrough()
        .parse(JSON.parse(result.content));

      expect(result.ok).toBe(false);
      expect(result.content.length).toBeLessThan(4_000);
      expect(admitted.summary).toHaveLength(2_000);
      expect(admitted.summary.endsWith("...")).toBe(true);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a child submits evidence outside the workspace and transcript storage fails,
    When each run settles,
    Then neither invalid canonical result is admitted as child evidence`, async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-subagent-supervisor-"),
    );
    const submittedOutside = singleSubmissionProvider({
      summary: "Untrusted summary must not be admitted.",
      evidence: [{ path: "../outside", detail: "outside workspace" }],
      risks: [],
    });
    const invalidFixture = supervisorFixture({
      workspace,
      provider: submittedOutside,
    });
    const storageFixture = supervisorFixture({
      workspace,
      provider: singleSubmissionProvider({
        summary: "Storage-dependent result.",
        evidence: [{ path: "ROADMAP.md", detail: "valid path" }],
        risks: [],
      }),
      transcriptStore: {
        abortSignalSupport: true,
        verifyReusable: async () => ({ status: "not_reusable" }),
        save: () => {
          throw new Error("artifact store unavailable");
        },
        discard: async () => {},
      },
    });

    try {
      const invalid = await invalidFixture.supervisor.capability.delegate({
        toolCallId: "invalid-evidence",
        task: "Submit invalid evidence.",
        focusPaths: [],
        signal: new AbortController().signal,
      });
      const storageFailed = await storageFixture.supervisor.capability.delegate(
        {
          toolCallId: "storage-failed",
          task: "Fail transcript storage.",
          focusPaths: [],
          signal: new AbortController().signal,
        },
      );

      expect(invalid.ok).toBe(false);
      expect(invalid.content).toContain(
        "Submitted evidence includes an invalid workspace path.",
      );
      expect(invalid.content).not.toContain("Untrusted summary");
      expect(storageFailed.ok).toBe(false);
      expect(storageFailed.content).toContain(
        "Child transcript could not be stored: artifact store unavailable",
      );
      expect(storageFailed.content).not.toContain("Storage-dependent result");
      expect(storageFailed.usage).toEqual(requestUsage);
      expect(storageFixture.supervisor.runSnapshots()).toMatchObject([
        {
          state: "terminal",
          terminal: { status: "failed", usage: requestUsage, turns: 1 },
        },
      ]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test.each([
    { scenario: "completed without submission", expected: "failed" },
    { scenario: "turn limit", expected: "turn_limited" },
    { scenario: "child budget admission", expected: "budget_limited" },
  ])(
    `Given a child reaches $scenario,
    When Supervisor maps the agent stop reason,
    Then main receives the $expected terminal status without fabricated evidence`,
    async ({ scenario, expected }) => {
      const workspace = await mkdtemp(
        join(tmpdir(), "keel-subagent-supervisor-"),
      );
      let calls = 0;
      const provider: LLMProvider = {
        id: "terminal-child",
        estimateInputTokens: () => 100,
        async *stream(options) {
          calls++;
          if (scenario === "turn limit" && calls === 1) {
            yield {
              type: "tool_call",
              id: "read_until_limit",
              tool: "read",
              path: "module.ts",
            };
          } else {
            yield { type: "text", text: "no structured submission" };
          }
          completeAttempt(options, requestUsage);
          yield { type: "stop", reason: "stop", usage: requestUsage };
        },
      };
      await writeFile(
        join(workspace, "module.ts"),
        "export const value = 1;\n",
      );
      const fixture = supervisorFixture({
        workspace,
        provider,
        ...(scenario === "turn limit" ? { maxTurns: 1 } : {}),
        ...(scenario === "child budget admission"
          ? { rootMaxCostUsd: 0.0005 }
          : {}),
      });

      try {
        const result = await fixture.supervisor.capability.delegate({
          toolCallId: `terminal-${scenario}`,
          task: "Reach the requested terminal state.",
          focusPaths: [],
          signal: new AbortController().signal,
        });

        expect(result.ok).toBe(false);
        expect(result.content).toContain(`"status":"${expected}"`);
        expect(result.content).toContain('"evidence":[]');
        expect(result.content).toContain('"risks":[]');
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    },
  );

  test(`Given the child finishes but transcript storage crosses the full lifecycle deadline,
    When storage eventually settles,
    Then Supervisor reports timed_out only after no child work remains`, async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-subagent-supervisor-"),
    );
    await writeFile(join(workspace, "module.ts"), "export const value = 1;\n");
    const artifacts = createArtifactCapture();
    let storageSettled = false;
    const fixture = supervisorFixture({
      workspace,
      provider: singleSubmissionProvider({
        summary: "The child finished before storage.",
        evidence: [{ path: "module.ts", detail: "valid evidence" }],
        risks: [],
      }),
      deadlineMs: 5,
      settlementGraceMs: 10,
      transcriptStore: {
        ...artifacts.store,
        save: (input) => {
          artifacts.inputs.push(input);
          return new Promise((_resolve, reject) => {
            const abort = () => {
              storageSettled = true;
              reject(input.signal?.reason ?? new Error("storage aborted"));
            };
            if (input.signal?.aborted === true) {
              abort();
            } else {
              input.signal?.addEventListener("abort", abort, { once: true });
            }
          });
        },
      },
    });

    try {
      const result = await fixture.supervisor.capability.delegate({
        toolCallId: "storage-deadline",
        task: "Complete before slow storage settles.",
        focusPaths: ["module.ts"],
        signal: new AbortController().signal,
      });

      expect(storageSettled).toBe(true);
      expect(result.ok).toBe(false);
      expect(result.content).toContain('"status":"timed_out"');
      expect(fixture.supervisor.activeRunCount()).toBe(0);
      expect(artifacts.inputs).toHaveLength(1);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given parent cancellation starts settlement before the execution deadline,
    When the deadline fires while transcript storage is still settling,
    Then repeated cancellation keeps the first settlement timer and the lifecycle still joins`, async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-subagent-supervisor-"),
    );
    const controller = new AbortController();
    controller.abort(new Error("parent cancelled first"));
    let storageSettled = false;
    const fixture = supervisorFixture({
      workspace,
      provider: {
        id: "pre-cancelled-provider",
        estimateInputTokens: () => 100,
        async *stream(options) {
          options.signal.throwIfAborted();
          yield { type: "stop", reason: "stop", usage: requestUsage };
        },
      },
      deadlineMs: 5,
      settlementGraceMs: 15,
      transcriptStore: {
        abortSignalSupport: true,
        verifyReusable: async () => ({ status: "not_reusable" }),
        save: (input) =>
          new Promise((_resolve, reject) => {
            const abort = () => {
              storageSettled = true;
              reject(input.signal?.reason ?? new Error("storage aborted"));
            };
            if (input.signal?.aborted === true) abort();
            else input.signal?.addEventListener("abort", abort, { once: true });
          }),
        discard: async () => {},
      },
    });

    try {
      const result = await fixture.supervisor.capability.delegate({
        toolCallId: "cancel-then-deadline",
        task: "Settle the already-cancelled child.",
        focusPaths: [],
        signal: controller.signal,
      });

      expect(storageSettled).toBe(true);
      expect(result.ok).toBe(false);
      expect(result.content).toContain('"status":"timed_out"');
      expect(fixture.supervisor.activeRunCount()).toBe(0);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given parent cancellation arrives after child completion while transcript persistence is active,
    When persistence settles within cleanup grace,
    Then Supervisor commits one cancelled terminal with the inspectable partial transcript`, async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-subagent-supervisor-"),
    );
    await writeFile(join(workspace, "module.ts"), "export const value = 1;\n");
    let markStorageStarted: () => void = () => {};
    let releaseStorage: () => void = () => {};
    const storageStarted = new Promise<void>((resolve) => {
      markStorageStarted = resolve;
    });
    const storageRelease = new Promise<void>((resolve) => {
      releaseStorage = resolve;
    });
    const fixture = supervisorFixture({
      workspace,
      provider: singleSubmissionProvider({
        summary: "Child work completed.",
        evidence: [{ path: "module.ts", detail: "valid evidence" }],
        risks: [],
      }),
      settlementGraceMs: 100,
      transcriptStore: {
        abortSignalSupport: true,
        verifyReusable: async () => ({ status: "not_reusable" }),
        save: async (input) => {
          markStorageStarted();
          await storageRelease;
          input.signal?.throwIfAborted();
          return {
            status: "stored",
            ref: "tool-output:test/persistence-cancel",
            contentSha256: "0".repeat(64),
          };
        },
        discard: async () => {},
      },
    });
    const controller = new AbortController();

    try {
      const pending = fixture.supervisor.capability.delegate({
        toolCallId: "persistence-cancel",
        task: "Complete before parent cancellation.",
        focusPaths: ["module.ts"],
        signal: controller.signal,
      });
      await storageStarted;
      controller.abort(new Error("parent cancelled during persistence"));
      releaseStorage();
      const result = await pending;

      expect(result.ok).toBe(false);
      expect(result.content).toContain('"status":"cancelled"');
      expect(result.content).toContain(
        '"transcriptRef":"tool-output:test/persistence-cancel"',
      );
      expect(fixture.supervisor.runSnapshots()).toMatchObject([
        {
          state: "terminal",
          terminal: {
            status: "cancelled",
            transcriptRef: "tool-output:test/persistence-cancel",
          },
        },
      ]);
      expect(fixture.supervisor.activeRunCount()).toBe(0);
    } finally {
      releaseStorage();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test.each([
    { terminal: "cancelled", deadlineMs: undefined, preAborted: false },
    { terminal: "cancelled", deadlineMs: undefined, preAborted: true },
    { terminal: "timed_out", deadlineMs: 10, preAborted: false },
  ])(
    `Given a child provider remains active until abort,
    When the child is $terminal,
    Then the provider settles and the supervisor has no live child`,
    async ({ terminal, deadlineMs, preAborted }) => {
      // Given
      const workspace = await mkdtemp(
        join(tmpdir(), "keel-subagent-supervisor-"),
      );
      let markStarted: () => void = () => {};
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      const provider: LLMProvider = {
        id: "abortable-subagent",
        estimateInputTokens: () => 100,
        async *stream(options) {
          const attempt = options.providerRequestAttempts?.begin();
          markStarted();
          try {
            await new Promise<void>((_resolve, reject) => {
              const abort = () =>
                reject(new DOMException("aborted", "AbortError"));
              if (options.signal.aborted) {
                abort();
              } else {
                options.signal.addEventListener("abort", abort, { once: true });
              }
            });
          } catch (error) {
            attempt?.finish({ outcome: "aborted" });
            throw error;
          }
        },
      };
      const fixture = supervisorFixture({
        workspace,
        provider,
        ...(deadlineMs !== undefined ? { deadlineMs } : {}),
      });
      const controller = new AbortController();
      if (preAborted) controller.abort(new Error("cancel before admission"));

      try {
        // When
        const pending = fixture.supervisor.capability.delegate({
          toolCallId: "delegate-abort",
          task: "Wait for cancellation.",
          focusPaths: [],
          signal: controller.signal,
        });
        if (!preAborted) {
          await started;
          if (deadlineMs === undefined) controller.abort();
        }
        const result = await pending;

        // Then
        expect(result.ok).toBe(false);
        expect(result.content).toContain(`"status":"${terminal}"`);
        expect(fixture.supervisor.activeRunCount()).toBe(0);
        expect(fixture.artifacts.inputs).toHaveLength(1);
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    },
  );
});
