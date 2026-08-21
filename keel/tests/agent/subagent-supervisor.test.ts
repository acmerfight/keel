import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import {
  createSharedCostBudgetAccount,
  createSharedCostBudgetedProvider,
  type SharedCostBudgetedProvider,
} from "../../src/agent/cost-budget.ts";
import type { ProjectInstructions } from "../../src/agent/prompt.ts";
import { subagentCapabilityIsWriter } from "../../src/agent/subagent-capability.ts";
import {
  type AgentId,
  type SubagentCanonicalResult,
  type SubagentLifecyclePersistence,
  SubagentPersistenceError,
  type SubagentRunId,
  type SubagentTerminalSnapshot,
} from "../../src/agent/subagent-lifecycle.ts";
import {
  builtinSubagentProfileCatalog,
  createSubagentProfileRegistry,
  resolveBuiltinSubagentProfile,
  type SubagentProfileRegistry,
} from "../../src/agent/subagent-profile.ts";
import {
  createSubagentSupervisor,
  projectSubagentResult,
  type SubagentBackgroundRun,
  type SubagentBackgroundRuntime,
  type SubagentContinuationRequest,
  type SubagentProgressEvent,
  type SubagentSupervisor,
} from "../../src/agent/subagent-supervisor.ts";
import type {
  SubagentWriteWorkspaceReference,
  SubagentWriteWorkspaceRuntime,
  SubagentWriteWorkspaceSettlement,
} from "../../src/agent/subagent-workspace.ts";
import type {
  AbortableToolOutputArtifactStore,
  ToolOutputArtifactSaveInput,
} from "../../src/agent/tool-output-artifacts.ts";
import type { CostModel } from "../../src/core/cost.ts";
import { KeelError } from "../../src/core/error.ts";
import type { LLMProvider, Usage } from "../../src/llm/types.ts";
import type { McpRuntime } from "../../src/mcp/runtime-types.ts";
import type { DelegationToolResult } from "../../src/tools/delegation.ts";
import { executeToolCall } from "../../src/tools/execution.ts";
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

const explorerCapability = resolveBuiltinSubagentProfile("explorer").snapshot;
const writerCapability = resolveBuiltinSubagentProfile("writer").snapshot;

function deliveredContent(result: DelegationToolResult): string {
  if (result.delivery === "rejected") {
    throw new Error(
      `expected delivered result, got rejection: ${result.reason}`,
    );
  }
  return result.content;
}

function rejectionReason(result: DelegationToolResult): string {
  if (result.delivery !== "rejected") {
    throw new Error(`expected rejection, got ${result.delivery}`);
  }
  return result.reason;
}

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

function settledWriteWorkspaceRuntime(input: {
  readonly workspace: string;
  readonly settlement: (
    reference: SubagentWriteWorkspaceReference,
  ) => SubagentWriteWorkspaceSettlement;
  readonly onPrepare?: () => void;
  readonly onSettle?: () => void;
}): SubagentWriteWorkspaceRuntime {
  const prepared = (reference: SubagentWriteWorkspaceReference) => ({
    kind: "prepared" as const,
    workspace: {
      reference,
      activate: () => ({
        kind: "acquired" as const,
        lease: {
          reference,
          verify: () => {},
          settle: () => {
            input.onSettle?.();
            return input.settlement(reference);
          },
        },
      }),
    },
  });
  return {
    prepare: ({ childRunId }) => {
      input.onPrepare?.();
      const reference: SubagentWriteWorkspaceReference = {
        kind: "isolated_write",
        leaseId: childRunId,
        baseCommit: "a".repeat(40),
        branch: `keel/subagent/${childRunId.slice("subagent-".length)}`,
        worktreePath: join(input.workspace, "writer-worktree"),
        workspaceRoot: join(input.workspace, "writer-worktree"),
      };
      return prepared(reference);
    },
    reacquire: ({ childRunId, previous }) => {
      const reacquired = prepared({ ...previous, leaseId: childRunId });
      return reacquired.workspace.activate();
    },
  };
}

const unusedWriteWorkspaceReacquisition: SubagentWriteWorkspaceRuntime["reacquire"] =
  () => ({
    kind: "rejected",
    reason: "writer continuation is outside this test",
    recovery: "Use the continuation-owned fixture.",
  });

function durableLifecycleSink(): SubagentLifecyclePersistence {
  return {
    accepted: () => {
      const transcript = {
        initialize: () => {},
        append: () => {},
        replace: () => {},
      };
      return {
        transcriptRef: "agent-transcript:test/background",
        transcript,
        pendingInput: () => {},
        running: () => ({
          transcriptRef: "agent-transcript:test/background",
          transcript,
          pendingInput: () => {},
          accounting: () => {},
          terminal: () => {},
        }),
        terminal: () => {},
      };
    },
    rejected: () => {},
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
        yield { type: "text", text: "module.ts exports 42." };
      }
      completeAttempt(options, requestUsage);
      yield { type: "stop", reason: "stop", usage: requestUsage };
    },
  };
}

function singleFinalProvider(finalText: string): LLMProvider {
  return {
    id: "single-final",
    estimateInputTokens: () => 100,
    async *stream(options) {
      yield { type: "text", text: finalText };
      completeAttempt(options, requestUsage);
      yield { type: "stop", reason: "stop", usage: requestUsage };
    },
  };
}

function supervisorFixture(
  options: {
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
    readonly additionalHiddenWorkspacePaths?: () => readonly string[];
    readonly projectInstructions?: ProjectInstructions;
    readonly onContinuationLease?: (
      input: Parameters<SharedCostBudgetedProvider["leaseContinuation"]>[0],
    ) => void;
    readonly onContinuationReleased?: () => void;
    readonly maxActiveAgentRuns?: number;
    readonly maxTotalChildRuns?: number;
    readonly providerBlocked?: () => boolean;
    readonly profileRegistry?: SubagentProfileRegistry;
    readonly writeWorkspace?: SubagentWriteWorkspaceRuntime;
  } & (
    | {
        readonly lifecyclePersistence?: SubagentLifecyclePersistence;
        readonly background?: never;
      }
    | {
        readonly lifecyclePersistence: SubagentLifecyclePersistence;
        readonly background: SubagentBackgroundRuntime;
      }
  ),
): {
  readonly supervisor: SubagentSupervisor;
  readonly rootBudget: SharedCostBudgetedProvider;
  readonly artifacts: ArtifactCapture;
} {
  const rootMaxCostUsd = options.rootMaxCostUsd ?? 0.01;
  const provider: LLMProvider =
    options.providerAbortSignalSupport === false
      ? options.provider
      : { ...options.provider, abortSignalSupport: true };
  const sharedCostBudget = createSharedCostBudgetAccount(rootMaxCostUsd);
  const sharedRootBudget = createSharedCostBudgetedProvider({
    provider,
    model: costModel,
    maxCostUsd: rootMaxCostUsd,
    sharedAccount: sharedCostBudget,
  });
  const rootBudget: SharedCostBudgetedProvider = {
    ...sharedRootBudget,
    leaseContinuation: (input) => {
      options.onContinuationLease?.(input);
      const reservedUsd = rootMaxCostUsd * 0.25;
      const additionalRequestBudgetUsd =
        sharedRootBudget.remainingUsd() - reservedUsd;
      const release = () => options.onContinuationReleased?.();
      return additionalRequestBudgetUsd > 0
        ? {
            kind: "granted",
            reservedUsd,
            additionalRequestBudgetUsd,
            estimatedContinuationInputTokens: 1_000,
            continuation: {
              provider: sharedRootBudget.provider,
              requestShape: {
                systemPrompt: "main",
                toolExposure: {
                  kind: "auto",
                  delegation: {
                    mode: "background",
                    profileCatalog: builtinSubagentProfileCatalog,
                  },
                },
              },
              release,
            },
            release,
          }
        : { kind: "rejected", reason: "insufficient_budget" };
    },
  };
  const artifacts = createArtifactCapture();
  const lifecycleOwnership =
    options.background === undefined
      ? options.lifecyclePersistence === undefined
        ? {}
        : { lifecyclePersistence: options.lifecyclePersistence }
      : {
          background: options.background,
          backgroundModelOperations: undefined,
          lifecyclePersistence: options.lifecyclePersistence,
        };
  return {
    rootBudget,
    artifacts,
    supervisor: createSubagentSupervisor({
      workspace: options.workspace,
      platform: process.platform,
      parent: {
        kind: "main",
        runId: "main-run",
        childDelegation: "none",
      },
      rootBudget,
      sharedCostBudget,
      ...(options.writeWorkspace !== undefined
        ? { writeWorkspace: options.writeWorkspace }
        : {}),
      profileRegistry:
        options.profileRegistry ??
        createSubagentProfileRegistry({
          execution: { providerId: "fake", model: "test-model" },
          ...(options.maxTurns !== undefined
            ? { maxTurns: options.maxTurns }
            : {}),
          ...(options.deadlineMs !== undefined
            ? { deadlineMs: options.deadlineMs }
            : {}),
        }),
      resolveExecution: (snapshot) => ({
        snapshot,
        provider,
        costModel,
      }),
      transcriptStore: options.transcriptStore ?? artifacts.store,
      ...lifecycleOwnership,
      now: options.now ?? (() => 0),
      onProgress: options.onProgress ?? (() => {}),
      ...(options.hiddenWorkspacePaths !== undefined
        ? { hiddenWorkspacePaths: options.hiddenWorkspacePaths }
        : {}),
      ...(options.additionalHiddenWorkspacePaths !== undefined
        ? {
            additionalHiddenWorkspacePaths:
              options.additionalHiddenWorkspacePaths,
          }
        : {}),
      ...(options.projectInstructions !== undefined
        ? { projectInstructions: options.projectInstructions }
        : {}),
      ...(options.settlementGraceMs !== undefined
        ? { settlementGraceMs: options.settlementGraceMs }
        : {}),
      ...(options.maxActiveAgentRuns !== undefined
        ? { maxActiveAgentRuns: options.maxActiveAgentRuns }
        : {}),
      ...(options.maxTotalChildRuns !== undefined
        ? { maxTotalChildRuns: options.maxTotalChildRuns }
        : {}),
      ...(options.providerBlocked !== undefined
        ? { providerBlocked: options.providerBlocked }
        : {}),
    }),
  };
}

describe("Subagent Supervisor", () => {
  test(`Given policy disables writer authority or a writer profile requests remote tools,
    When the profile registry builds the model-visible catalog,
    Then it omits every writer profile or rejects the expanding configuration`, () => {
    const execution = { providerId: "fake" as const, model: "test-model" };
    const disabled = createSubagentProfileRegistry({
      execution,
      writer: "disabled",
      repoProfiles: [{ name: "repo:writer", base: "writer" }],
    });
    expect(disabled.resolve("writer")).toBeUndefined();
    expect(disabled.resolve("repo:writer")).toBeUndefined();

    const mcpSnapshot = {
      serverId: "catalog",
      rawToolName: "search",
      serverIncarnation: "server-v1",
      configurationDigest: "a".repeat(64),
      authorizationIdentity: { kind: "anonymous" as const },
    };
    expect(() =>
      createSubagentProfileRegistry({
        execution,
        repoProfiles: [
          {
            name: "repo:remote-writer",
            base: "writer",
            mcp: [{ server: "catalog", tool: "search" }],
          },
        ],
        mcpRuntime: {
          kind: "enabled",
          resolveTool: () => mcpSnapshot,
          resolveCurrent: async () => [mcpSnapshot],
          createRuntime: () => undefined,
        },
      }),
    ).toThrow("cannot attach Skills or MCP tools");

    const narrowedWriter = createSubagentProfileRegistry({
      execution,
      repoProfiles: [{ name: "repo:focused-writer", base: "writer" }],
    });
    expect(narrowedWriter.resolve("repo:focused-writer")?.base).toBe("writer");
  });

  test(`Given delegation names an unknown profile or requests unleased resources,
    When the Supervisor resolves optional read-only and writer requests,
    Then valid omissions run while every unknown authority is rejected before provider work`, async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-subagent-profile-selection-"),
    );
    let providerCalls = 0;
    const fixture = supervisorFixture({
      workspace,
      background: {
        signal: new AbortController().signal,
        register: () => {
          throw new Error("rejected optional writer must not register");
        },
      },
      lifecyclePersistence: durableLifecycleSink(),
      provider: {
        ...singleFinalProvider("Selection complete."),
        async *stream(options) {
          providerCalls++;
          yield { type: "text", text: "Selection complete." };
          completeAttempt(options, requestUsage);
          yield { type: "stop", reason: "stop", usage: requestUsage };
        },
      },
    });
    const signal = new AbortController().signal;

    try {
      const validRead = await fixture.supervisor.capability.delegate({
        toolCallId: "optional-read-resources",
        profile: "explorer",
        mode: "foreground",
        task: "Inspect without optional resources.",
        mcp: [],
        focusPaths: [],
        signal,
      });
      const unknown = await fixture.supervisor.capability.delegate({
        toolCallId: "unknown-profile",
        profile: "repo:missing",
        mode: "foreground",
        task: "Use a profile that does not exist.",
        mcp: [],
        focusPaths: [],
        signal,
      });
      const unleasedSkill = await fixture.supervisor.capability.delegate({
        toolCallId: "unleased-skill",
        profile: "explorer",
        mode: "foreground",
        task: "Use a Skill outside the profile lease.",
        skills: ["repo:missing"],
        mcp: [],
        focusPaths: [],
        signal,
      });
      const unleasedMcp = await fixture.supervisor.capability.delegate({
        toolCallId: "unleased-mcp",
        profile: "explorer",
        mode: "foreground",
        task: "Use MCP outside the profile lease.",
        mcp: [{ server: "missing", tool: "search" }],
        focusPaths: [],
        signal,
      });
      const optionalWriter = await fixture.supervisor.capability.delegate({
        toolCallId: "optional-writer-resources",
        profile: "writer",
        mode: "background",
        task: "Try a writer without optional resources.",
        mcp: [],
        focusPaths: [],
        signal,
      });

      expect(validRead).toMatchObject({ delivery: "fresh", ok: true });
      expect(rejectionReason(unknown)).toContain("unknown subagent profile");
      expect(rejectionReason(unleasedSkill)).toContain(
        "does not allow every requested workflow Skill",
      );
      expect(rejectionReason(unleasedMcp)).toContain(
        "does not allow every requested MCP tool",
      );
      expect(rejectionReason(optionalWriter)).toContain("foreground-only");
      expect(providerCalls).toBe(1);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a writer result has a maximum persisted path and summary,
    When Main receives the bounded terminal handoff,
    Then the base, branch, patch reference, and exact preserved path remain inspectable`, () => {
    const worktreePath = `/${"w".repeat(4_094)}`;
    const result: SubagentCanonicalResult = {
      delegationId: "writer-result",
      childAgentId: "agent-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      childRunId: "subagent-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      task: "Change the file in an isolated writer.",
      usage: requestUsage,
      turns: 2,
      costUsd: 0.001,
      transcriptRef: "agent-transcript:test/writer-result",
      pendingInputCount: 0,
      status: "completed",
      finalText: "Changed the requested file.".repeat(200),
      error: null,
      workspace: {
        kind: "isolated_write",
        leaseId: "subagent-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        baseCommit: "a".repeat(40),
        branch: "keel/subagent/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        disposition: "preserved",
        worktreePath,
        workspaceRoot: worktreePath,
        patchRef: "tool-output:test/writer-result",
        patchSha256: "b".repeat(64),
        patchSourceTruncated: false,
        summary: "M changed.ts\n".repeat(300),
        error: null,
      },
    };

    const projection = projectSubagentResult(result);
    const parsed = z
      .object({
        workspace: z.object({
          baseCommit: z.string(),
          branch: z.string(),
          worktreePath: z.string(),
          patchRef: z.string(),
        }),
        truncated: z.boolean(),
      })
      .passthrough()
      .parse(JSON.parse(projection));

    expect(projection.length).toBeLessThanOrEqual(6_000);
    expect(parsed.workspace).toEqual({
      baseCommit: "a".repeat(40),
      branch: "keel/subagent/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      worktreePath,
      patchRef: "tool-output:test/writer-result",
    });
    expect(parsed.truncated).toBe(true);
  });

  test(`Given the root budget cannot reserve an isolated agent result continuation,
    When Main asks to wait for the result,
    Then result admission rejects before exposing an unbudgeted continuation`, async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-subagent-result-budget-"),
    );
    const fixture = supervisorFixture({
      workspace,
      provider: singleFinalProvider("unused"),
      rootMaxCostUsd: 0,
    });

    try {
      expect(
        fixture.supervisor.resultContinuationBudget.lease(["agent-wait"]),
      ).toEqual({ kind: "rejected" });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a background child is attached to a saved-session owner,
    When the Main turn that created it is cancelled,
    Then the child keeps running until its own completion because turn cancellation is not its owner`, async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-background-turn-cancel-"),
    );
    const childEntered = Promise.withResolvers<void>();
    const releaseChild = Promise.withResolvers<void>();
    const sessionOwner = new AbortController();
    const childSignals: AbortSignal[] = [];
    const registeredRuns: SubagentBackgroundRun[] = [];
    const fixture = supervisorFixture({
      workspace,
      provider: {
        id: "background-turn-cancel",
        abortSignalSupport: true,
        estimateInputTokens: () => 100,
        async *stream(options) {
          childSignals.push(options.signal);
          childEntered.resolve();
          await releaseChild.promise;
          yield { type: "text", text: "background completed" };
          completeAttempt(options, requestUsage);
          yield { type: "stop", reason: "stop", usage: requestUsage };
        },
      },
      background: {
        signal: sessionOwner.signal,
        register: (run) => {
          registeredRuns.push(run);
        },
      },
      lifecyclePersistence: durableLifecycleSink(),
    });
    const mainTurn = new AbortController();

    try {
      const acknowledgement = await fixture.supervisor.capability.delegate({
        toolCallId: "background-turn",
        profile: "explorer" as const,
        mode: "background",
        task: "Finish independently of the Main turn.",
        mcp: [],
        focusPaths: [],
        signal: mainTurn.signal,
      });
      await childEntered.promise;
      await expect(
        fixture.supervisor.capability.delegate({
          toolCallId: "background-turn",
          profile: "explorer" as const,
          mode: "background",
          task: "Replay while the background child is still live.",
          mcp: [],
          focusPaths: [],
          signal: new AbortController().signal,
        }),
      ).resolves.toMatchObject({
        delivery: "replayed",
        ok: true,
        content: expect.stringContaining('"status":"running"'),
      });
      expect(registeredRuns).toHaveLength(1);
      mainTurn.abort(new Error("Main turn cancelled"));
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(acknowledgement).toMatchObject({
        delivery: "background",
        ok: true,
      });
      expect(childSignals[0]?.aborted).toBe(false);
      releaseChild.resolve();
      const backgroundRun = registeredRuns[0];
      if (backgroundRun === undefined) {
        throw new Error("background run was not registered");
      }
      await expect(backgroundRun.result).resolves.toMatchObject({
        status: "completed",
        finalText: "background completed",
      });
      await expect(
        fixture.supervisor.capability.delegate({
          toolCallId: "background-turn",
          profile: "explorer" as const,
          mode: "background",
          task: "Changed replay text must not create another background run.",
          mcp: [],
          focusPaths: [],
          signal: new AbortController().signal,
        }),
      ).resolves.toMatchObject({
        delivery: "replayed",
        ok: true,
        content: expect.stringContaining('"status":"completed"'),
      });
      expect(registeredRuns).toHaveLength(1);
    } finally {
      sessionOwner.abort();
      releaseChild.resolve();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a running background child receives bounded follow-up input before its provider returns,
    When the child reaches that terminal boundary,
    Then the same Run consumes the accepted input and rejects overflow without creating another Run`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-child-input-"));
    const firstRequestEntered = Promise.withResolvers<void>();
    const releaseFirstRequest = Promise.withResolvers<void>();
    const registeredRuns: SubagentBackgroundRun[] = [];
    let providerCalls = 0;
    const fixture = supervisorFixture({
      workspace,
      provider: {
        id: "live-child-input",
        abortSignalSupport: true,
        estimateInputTokens: () => 100,
        async *stream(options) {
          providerCalls++;
          if (providerCalls === 1) {
            firstRequestEntered.resolve();
            await releaseFirstRequest.promise;
            yield { type: "text", text: "Initial answer." };
          } else {
            expect(options.messages.at(-1)).toEqual({
              role: "user",
              content: "Additional context 16.",
            });
            yield { type: "text", text: "The callers are sound too." };
          }
          completeAttempt(options, requestUsage);
          yield { type: "stop", reason: "stop", usage: requestUsage };
        },
      },
      background: {
        signal: new AbortController().signal,
        register: (run) => registeredRuns.push(run),
      },
      lifecyclePersistence: durableLifecycleSink(),
    });

    try {
      await fixture.supervisor.capability.delegate({
        toolCallId: "live-input",
        profile: "explorer" as const,
        mode: "background",
        task: "Inspect the boundary.",
        mcp: [],
        focusPaths: [],
        signal: new AbortController().signal,
      });
      await firstRequestEntered.promise;
      const run = registeredRuns[0];
      if (run === undefined) throw new Error("missing background Run");
      for (let index = 1; index <= 16; index++) {
        expect(run.input(`Additional context ${index}.`)).toEqual({
          kind: "accepted",
        });
      }
      expect(run.input("This exceeds the queue bound.")).toEqual({
        kind: "full",
      });
      releaseFirstRequest.resolve();

      await expect(run.result).resolves.toMatchObject({
        childRunId: run.childRunId,
        status: "completed",
        finalText: "The callers are sound too.",
        turns: 2,
      });
      expect(registeredRuns).toHaveLength(1);
      expect(providerCalls).toBe(2);
      expect(run.input("Too late.")).toEqual({ kind: "closed" });
    } finally {
      releaseFirstRequest.resolve();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a terminal child thread has prior provider context,
    When the continuation capability resumes it,
    Then one admitted background Run keeps the Agent ID, gets a new Run ID, and receives the prior context plus follow-up`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-child-resume-"));
    const childAgentId: AgentId = "agent-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const previousRunId: SubagentRunId =
      "subagent-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const accepted: Parameters<SubagentLifecyclePersistence["accepted"]>[0][] =
      [];
    const registeredRuns: SubagentBackgroundRun[] = [];
    const sink = durableLifecycleSink();
    const fixture = supervisorFixture({
      workspace,
      provider: {
        id: "continued-child",
        abortSignalSupport: true,
        estimateInputTokens: () => 100,
        async *stream(options) {
          expect(options.messages).toMatchObject([
            { role: "user", content: "Inspect the boundary." },
            { role: "assistant", content: "The boundary is sound." },
            { role: "user", content: "Now inspect its callers." },
          ]);
          yield { type: "text", text: "The callers are sound too." };
          completeAttempt(options, requestUsage);
          yield { type: "stop", reason: "stop", usage: requestUsage };
        },
      },
      background: {
        signal: new AbortController().signal,
        register: (run) => registeredRuns.push(run),
      },
      lifecyclePersistence: {
        accepted: (lifecycle) => {
          accepted.push(lifecycle);
          return sink.accepted(lifecycle);
        },
        rejected: sink.rejected,
      },
    });

    try {
      const request: SubagentContinuationRequest = {
        childAgentId,
        previousRunId,
        workspaceAccess: "read_only",
        capability: explorerCapability,
        threadCapabilityCeiling: explorerCapability,
        workspace: null,
        execution: {
          providerId: "fake",
          model: "test-model",
          effort: null,
        },
        toolCallId: "resume-child",
        message: "Now inspect its callers.",
        skills: [],
        mcp: [],
        focusPaths: [],
        systemPrompt: "Read-only child instructions.",
        priorMessages: [
          {
            role: "user" as const,
            content: "Inspect the boundary.",
            origin: { type: "runtime_subagent_delegation" as const },
          },
          {
            role: "assistant" as const,
            content: "The boundary is sound.",
            toolCalls: [],
          },
        ],
        signal: new AbortController().signal,
      };
      const firstReceipt =
        await fixture.supervisor.continuation.resume(request);
      expect(firstReceipt).toMatchObject({
        ok: true,
        content: expect.stringContaining(`"agentId":"${childAgentId}"`),
      });
      const resumed = registeredRuns[0];
      if (resumed === undefined) throw new Error("missing resumed Run");
      await expect(
        fixture.supervisor.continuation.resume(request),
      ).resolves.toMatchObject({
        ok: true,
        content: expect.stringContaining(`"runId":"${resumed.childRunId}"`),
      });
      expect(registeredRuns).toHaveLength(1);
      expect(resumed.childAgentId).toBe(childAgentId);
      expect(resumed.childRunId).not.toBe(previousRunId);
      expect(accepted).toMatchObject([
        {
          childAgentId,
          childRunId: resumed.childRunId,
          lineage: { kind: "continuation", previousRunId },
        },
      ]);
      await expect(resumed.result).resolves.toMatchObject({
        status: "completed",
        finalText: "The callers are sound too.",
      });
      await expect(
        fixture.supervisor.continuation.resume(request),
      ).resolves.toMatchObject({
        ok: true,
        content: expect.stringContaining('"status":"completed"'),
      });
      expect(registeredRuns).toHaveLength(1);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a terminal child cannot satisfy continuation ownership, provider, workspace, budget, or capacity rules,
    When resume admission is attempted,
    Then it rejects before provider work and repeats the same durable receipt for the same request`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-resume-admission-"));
    const childAgentId: AgentId = "agent-aaaaaaaa";
    const previousRunId: SubagentRunId = "subagent-aaaaaaaa";
    let providerCalls = 0;
    const provider: LLMProvider = {
      ...singleFinalProvider("must not run"),
      async *stream() {
        providerCalls++;
        yield { type: "text", text: "must not run" };
      },
    };
    const background: SubagentBackgroundRuntime = {
      signal: new AbortController().signal,
      register: () => {
        throw new Error("rejected resume must not register a Run");
      },
    };
    type ReadOnlyContinuationRequest = Extract<
      SubagentContinuationRequest,
      { readonly workspaceAccess: "read_only" }
    >;
    const request = (
      toolCallId: string,
      overrides: Partial<ReadOnlyContinuationRequest> = {},
    ): ReadOnlyContinuationRequest => ({
      childAgentId,
      previousRunId,
      workspaceAccess: "read_only",
      capability: explorerCapability,
      threadCapabilityCeiling: explorerCapability,
      workspace: null,
      execution: {
        providerId: "fake",
        model: "test-model",
        effort: null,
      },
      toolCallId,
      message: "Inspect callers.",
      skills: [],
      mcp: [],
      focusPaths: [],
      systemPrompt: "Read-only child instructions.",
      priorMessages: [],
      signal: new AbortController().signal,
      ...overrides,
    });
    const rejectedContent = async (
      fixture: ReturnType<typeof supervisorFixture>,
      continuation: SubagentContinuationRequest,
    ): Promise<string> => {
      const result = await fixture.supervisor.continuation.resume(continuation);
      expect(result.ok).toBe(false);
      return result.content;
    };

    try {
      const detached = supervisorFixture({
        workspace,
        provider,
        lifecyclePersistence: durableLifecycleSink(),
      });
      expect(await rejectedContent(detached, request("detached"))).toContain(
        "saved-session background owner",
      );

      const closedOwner = new AbortController();
      closedOwner.abort(new Error("saved session owner exited"));
      let closedOwnerAcceptances = 0;
      const closed = supervisorFixture({
        workspace,
        provider,
        background: {
          signal: closedOwner.signal,
          register: () => {
            throw new Error("closed owner must not register a Run");
          },
        },
        lifecyclePersistence: {
          accepted: (lifecycle) => {
            closedOwnerAcceptances++;
            return durableLifecycleSink().accepted(lifecycle);
          },
          rejected: () => {},
        },
      });
      expect(await rejectedContent(closed, request("closed-owner"))).toContain(
        "owner is shutting down",
      );
      await expect(
        closed.supervisor.capability.delegate({
          toolCallId: "closed-owner-delegate",
          profile: "explorer" as const,
          mode: "background",
          task: "Must not outlive the closed owner.",
          mcp: [],
          focusPaths: [],
          signal: new AbortController().signal,
        }),
      ).resolves.toMatchObject({
        ok: false,
        reason: expect.stringContaining("owner is shutting down"),
      });
      expect(closedOwnerAcceptances).toBe(0);

      const blocked = supervisorFixture({
        workspace,
        provider,
        background,
        lifecyclePersistence: durableLifecycleSink(),
        providerBlocked: () => true,
      });
      const blockedRequest = request("provider-blocked");
      const firstBlocked = await rejectedContent(blocked, blockedRequest);
      expect(firstBlocked).toContain("provider access is blocked");
      expect(await rejectedContent(blocked, blockedRequest)).toBe(firstBlocked);

      const unsettled = supervisorFixture({
        workspace,
        provider: singleFinalProvider("must not run"),
        providerAbortSignalSupport: false,
        background,
        lifecyclePersistence: durableLifecycleSink(),
      });
      expect(
        await rejectedContent(unsettled, request("abort-unsupported")),
      ).toContain("does not certify cancellation settlement");

      const invalidPath = supervisorFixture({
        workspace,
        provider,
        background,
        lifecyclePersistence: durableLifecycleSink(),
      });
      expect(
        await rejectedContent(
          invalidPath,
          request("invalid-path", { focusPaths: ["../outside"] }),
        ),
      ).toContain("outside the workspace");
      const invalidSkillLease = supervisorFixture({
        workspace,
        provider,
        background,
        lifecyclePersistence: durableLifecycleSink(),
      });
      expect(
        await rejectedContent(
          invalidSkillLease,
          request("invalid-skill-lease", { skills: ["repo:unleased"] }),
        ),
      ).toContain("task Skill lease is outside");

      const unknownEstimate = supervisorFixture({
        workspace,
        provider: { ...provider, estimateInputTokens: () => Number.NaN },
        background,
        lifecyclePersistence: durableLifecycleSink(),
      });
      expect(
        await rejectedContent(unknownEstimate, request("unknown-estimate")),
      ).toContain("cost cannot be estimated");

      const noBudget = supervisorFixture({
        workspace,
        provider,
        rootMaxCostUsd: 0.000001,
        background,
        lifecyclePersistence: durableLifecycleSink(),
      });
      expect(await rejectedContent(noBudget, request("no-budget"))).toContain(
        "remaining root budget",
      );

      const activeLimit = supervisorFixture({
        workspace,
        provider,
        maxActiveAgentRuns: 1,
        background,
        lifecyclePersistence: durableLifecycleSink(),
      });
      expect(
        await rejectedContent(activeLimit, request("active-limit")),
      ).toContain("active child Run limit");

      const totalLimit = supervisorFixture({
        workspace,
        provider,
        maxTotalChildRuns: 0,
        background,
        lifecyclePersistence: durableLifecycleSink(),
      });
      expect(
        await rejectedContent(totalLimit, request("total-limit")),
      ).toContain("total child Run limit");
      expect(providerCalls).toBe(0);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a terminal writer lacks a valid task lease, workspace adapter, or reacquisition,
    When Main resumes that Thread,
    Then continuation rejects before durable acceptance or provider work`, async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-writer-resume-rejected-"),
    );
    let providerCalls = 0;
    let acceptances = 0;
    const baseWorkspaceRuntime = settledWriteWorkspaceRuntime({
      workspace,
      settlement: (reference) => ({
        disposition: "preserved",
        worktreePath: reference.worktreePath,
        patch: {
          content: "",
          sourceTruncated: false,
          summary: "clean at base commit",
        },
      }),
    });
    const background: SubagentBackgroundRuntime = {
      signal: new AbortController().signal,
      register: () => {
        throw new Error("rejected writer must not register");
      },
    };
    const lifecyclePersistence: SubagentLifecyclePersistence = {
      accepted: (lifecycle) => {
        acceptances++;
        return durableLifecycleSink().accepted(lifecycle);
      },
      rejected: () => {},
    };
    type WriterContinuationRequest = Extract<
      SubagentContinuationRequest,
      { readonly workspaceAccess: "isolated_write" }
    >;
    const request = (
      toolCallId: string,
      overrides: Partial<WriterContinuationRequest> = {},
    ): WriterContinuationRequest => ({
      childAgentId: "agent-80808080-8080-4808-8808-808080808080",
      previousRunId: "subagent-80808080-8080-4808-8808-808080808080",
      workspaceAccess: "isolated_write",
      capability: writerCapability,
      threadCapabilityCeiling: writerCapability,
      workspace: {
        kind: "isolated_write",
        leaseId: "subagent-80808080-8080-4808-8808-808080808080",
        baseCommit: "a".repeat(40),
        branch: "keel/subagent/80808080-8080-4808-8808-808080808080",
        worktreePath: join(workspace, "preserved-writer"),
        workspaceRoot: join(workspace, "preserved-writer"),
      },
      execution: {
        providerId: "fake",
        model: "test-model",
        effort: null,
      },
      toolCallId,
      message: "Adjust the preserved patch.",
      skills: [],
      mcp: [],
      focusPaths: [],
      systemPrompt: "Writer instructions.",
      priorMessages: [],
      signal: new AbortController().signal,
      ...overrides,
    });
    const fixture = supervisorFixture({
      workspace,
      provider: {
        ...singleFinalProvider("must not run"),
        async *stream() {
          providerCalls++;
          yield { type: "text", text: "must not run" };
        },
      },
      background,
      lifecyclePersistence,
      writeWorkspace: {
        ...baseWorkspaceRuntime,
        reacquire: () => ({
          kind: "rejected",
          reason: "preserved writer branch drifted",
          recovery: "Inspect the preserved branch.",
        }),
      },
    });

    try {
      await expect(
        fixture.supervisor.continuation.resume(
          request("resume-writer-unleased-skill", {
            skills: ["repo:unleased"],
          }),
        ),
      ).resolves.toMatchObject({
        ok: false,
        content: expect.stringContaining("task Skill lease is outside"),
      });

      const unavailable = supervisorFixture({
        workspace,
        provider: fixture.rootBudget.provider,
        background,
        lifecyclePersistence,
      });
      await expect(
        unavailable.supervisor.continuation.resume(
          request("resume-writer-without-workspace-adapter"),
        ),
      ).resolves.toEqual({
        ok: false,
        content:
          "Agent resume rejected because writer workspace isolation is unavailable.",
      });

      const result = await fixture.supervisor.continuation.resume(
        request("resume-drifted-writer"),
      );

      expect(result).toEqual({
        ok: false,
        content: "preserved writer branch drifted",
      });
      expect(acceptances).toBe(0);
      expect(providerCalls).toBe(0);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a writer follow-up fails after preserving its patch,
    When the same foreground resume receipt is replayed,
    Then the failure is returned unchanged without rerunning and the artifacts retain resume provenance`, async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-writer-resume-replay-"),
    );
    await mkdir(join(workspace, "writer-worktree"));
    let providerCalls = 0;
    const fixture = supervisorFixture({
      workspace,
      provider: {
        id: "failed-writer-follow-up",
        estimateInputTokens: () => 100,
        async *stream() {
          providerCalls++;
          yield { type: "text", text: "Partial writer output." };
          throw new Error("writer follow-up provider failed");
        },
      },
      background: {
        signal: new AbortController().signal,
        register: () => {
          throw new Error("foreground writer follow-up must not register");
        },
      },
      lifecyclePersistence: durableLifecycleSink(),
      writeWorkspace: settledWriteWorkspaceRuntime({
        workspace,
        settlement: (reference) => ({
          disposition: "preserved",
          worktreePath: reference.worktreePath,
          patch: {
            content: "diff --git a/file b/file\n",
            sourceTruncated: false,
            summary: "M file",
          },
        }),
      }),
    });
    const request: SubagentContinuationRequest = {
      childAgentId: "agent-90909090-9090-4909-8909-909090909090",
      previousRunId: "subagent-90909090-9090-4909-8909-909090909090",
      workspaceAccess: "isolated_write",
      capability: writerCapability,
      threadCapabilityCeiling: writerCapability,
      workspace: {
        kind: "isolated_write",
        leaseId: "subagent-90909090-9090-4909-8909-909090909090",
        baseCommit: "a".repeat(40),
        branch: "keel/subagent/90909090-9090-4909-8909-909090909090",
        worktreePath: join(workspace, "writer-worktree"),
        workspaceRoot: join(workspace, "writer-worktree"),
      },
      execution: {
        providerId: "fake",
        model: "test-model",
        effort: null,
      },
      toolCallId: "resume-failed-writer",
      message: "Adjust the preserved patch.",
      skills: [],
      mcp: [],
      focusPaths: [],
      systemPrompt: "Writer instructions.",
      priorMessages: [],
      signal: new AbortController().signal,
    };

    try {
      const first = await fixture.supervisor.continuation.resume(request);
      const callsAfterFirst = providerCalls;
      const replay = await fixture.supervisor.continuation.resume(request);

      expect(first).toMatchObject({
        ok: false,
        content: expect.stringContaining("writer follow-up provider failed"),
      });
      expect(first.content).toContain('"disposition":"preserved"');
      expect(replay).toEqual(first);
      expect(providerCalls).toBe(callsAfterFirst);
      expect(fixture.artifacts.inputs).toContainEqual(
        expect.objectContaining({
          toolCallId: "resume-failed-writer",
          toolName: "agent_resume",
          content: "diff --git a/file b/file\n",
        }),
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a terminal child previously leased an MCP tool whose configuration is no longer current,
    When Main requests the same MCP lease on resume,
    Then continuation rejects before provider work instead of restoring stale authority`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-resume-mcp-"));
    let providerCalls = 0;
    const provider: LLMProvider = {
      ...singleFinalProvider("must not run"),
      async *stream() {
        providerCalls++;
        yield { type: "text", text: "must not run" };
      },
    };
    const mcpSnapshot = {
      serverId: "catalog",
      rawToolName: "search",
      serverIncarnation: "server-v1",
      configurationDigest: "a".repeat(64),
      authorizationIdentity: { kind: "anonymous" as const },
    };
    const profileRegistry = createSubagentProfileRegistry({
      execution: { providerId: "fake", model: "test-model" },
      repoProfiles: [
        {
          name: "repo:remote",
          base: "explorer",
          mcp: [{ server: "catalog", tool: "search" }],
        },
      ],
      mcpRuntime: {
        kind: "enabled",
        resolveTool: () => mcpSnapshot,
        resolveCurrent: async () => [],
        createRuntime: () => undefined,
      },
    });
    const profile = profileRegistry.resolve("repo:remote");
    if (
      profile === undefined ||
      subagentCapabilityIsWriter(profile.capability)
    ) {
      throw new Error("missing read-only MCP test profile");
    }
    const fixture = supervisorFixture({
      workspace,
      provider,
      profileRegistry,
      background: {
        signal: new AbortController().signal,
        register: () => {
          throw new Error("stale MCP resume must not register a Run");
        },
      },
      lifecyclePersistence: durableLifecycleSink(),
    });

    try {
      const result = await fixture.supervisor.continuation.resume({
        childAgentId: "agent-aaaaaaaa",
        previousRunId: "subagent-aaaaaaaa",
        workspaceAccess: "read_only",
        capability: profile.capability,
        threadCapabilityCeiling: profile.capability,
        workspace: null,
        execution: profile.execution,
        toolCallId: "resume-stale-mcp",
        message: "Search again.",
        skills: [],
        mcp: [{ server: "catalog", tool: "search" }],
        focusPaths: [],
        systemPrompt: "Read-only child instructions.",
        priorMessages: [],
        signal: new AbortController().signal,
      });

      expect(result).toMatchObject({
        ok: false,
        content: expect.stringContaining("task MCP lease is outside"),
      });
      expect(providerCalls).toBe(0);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given continuation lifecycle acceptance cannot be stored durably,
    When resume attempts to create the new Run,
    Then ordinary storage errors become a stable rejection while indeterminate writes remain fatal`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-resume-storage-"));
    const request: SubagentContinuationRequest = {
      childAgentId: "agent-aaaaaaaa",
      previousRunId: "subagent-aaaaaaaa",
      workspaceAccess: "read_only",
      capability: explorerCapability,
      threadCapabilityCeiling: explorerCapability,
      workspace: null,
      execution: {
        providerId: "fake",
        model: "test-model",
        effort: null,
      },
      toolCallId: "resume-storage",
      message: "Inspect callers.",
      skills: [],
      mcp: [],
      focusPaths: [],
      systemPrompt: "Read-only child instructions.",
      priorMessages: [],
      signal: new AbortController().signal,
    };
    const background: SubagentBackgroundRuntime = {
      signal: new AbortController().signal,
      register: () => {
        throw new Error("failed persistence must not register a Run");
      },
    };

    try {
      const ordinary = supervisorFixture({
        workspace,
        provider: singleFinalProvider("must not run"),
        background,
        lifecyclePersistence: {
          accepted: () => {
            throw new Error("disk unavailable");
          },
          rejected: () => {},
        },
      });
      await expect(
        ordinary.supervisor.continuation.resume(request),
      ).resolves.toMatchObject({
        ok: false,
        content: expect.stringContaining("disk unavailable"),
      });

      const indeterminate = supervisorFixture({
        workspace,
        provider: singleFinalProvider("must not run"),
        background,
        lifecyclePersistence: {
          accepted: () => {
            throw new SubagentPersistenceError("write outcome is unknown");
          },
          rejected: () => {},
        },
      });
      await expect(
        indeterminate.supervisor.continuation.resume({
          ...request,
          toolCallId: "resume-indeterminate",
        }),
      ).rejects.toThrow("write outcome is unknown");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given provider failure races queued follow-up input,
    When the child cannot reach another safe turn boundary,
    Then the terminal result exposes one pending durable input for the next Run`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-input-failure-"));
    const providerEntered = Promise.withResolvers<void>();
    const releaseProvider = Promise.withResolvers<void>();
    const appendedContents: string[] = [];
    const registeredRuns: SubagentBackgroundRun[] = [];
    const transcript = {
      initialize: () => {},
      append: (messages: readonly { readonly content: string }[]) => {
        appendedContents.push(...messages.map((message) => message.content));
      },
      replace: () => {},
    };
    const fixture = supervisorFixture({
      workspace,
      provider: {
        id: "failed-child-input",
        estimateInputTokens: () => 100,
        async *stream() {
          providerEntered.resolve();
          await releaseProvider.promise;
          yield { type: "text", text: "Partial answer before failure." };
          throw new Error("provider failed before input boundary");
        },
      },
      background: {
        signal: new AbortController().signal,
        register: (run) => registeredRuns.push(run),
      },
      lifecyclePersistence: {
        accepted: () => ({
          transcriptRef: "agent-transcript:test/failed-input",
          transcript,
          pendingInput: (messages) => {
            appendedContents.push(
              ...messages.map((message) => message.content),
            );
          },
          running: () => ({
            transcriptRef: "agent-transcript:test/failed-input",
            transcript,
            pendingInput: (messages) => {
              appendedContents.push(
                ...messages.map((message) => message.content),
              );
            },
            accounting: () => {},
            terminal: () => {},
          }),
          terminal: () => {},
        }),
        rejected: () => {},
      },
    });

    try {
      await fixture.supervisor.capability.delegate({
        toolCallId: "failed-input",
        profile: "explorer" as const,
        mode: "background",
        task: "Inspect the boundary.",
        mcp: [],
        focusPaths: [],
        signal: new AbortController().signal,
      });
      await providerEntered.promise;
      const run = registeredRuns[0];
      if (run === undefined) throw new Error("missing background Run");
      expect(run.input("Also inspect callers.")).toEqual({ kind: "accepted" });
      releaseProvider.resolve();
      const result = await run.result;
      expect(result).toMatchObject({
        status: "failed",
        error: "provider failed before input boundary",
        pendingInputCount: 1,
        workspace: null,
      });
      expect(projectSubagentResult(result)).toContain('"pendingInputCount":1');
      expect(appendedContents).toContain("Also inspect callers.");
    } finally {
      releaseProvider.resolve();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a saved-session lifecycle sink is configured,
    When a child is admitted and completes,
    Then durable acceptance precedes provider work and the canonical result precedes terminal progress`, async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-subagent-supervisor-"),
    );
    const events: string[] = [];
    const liveFinalText = "durable sk-liveResult123456";
    const baseProvider = singleFinalProvider(liveFinalText);
    const fixture = supervisorFixture({
      workspace,
      provider: {
        ...baseProvider,
        async *stream(options) {
          events.push("provider");
          yield* baseProvider.stream(options);
        },
      },
      lifecyclePersistence: {
        accepted: () => {
          events.push("accepted");
          const transcript = {
            initialize: () => {
              events.push("transcript-initialize");
            },
            append: () => {},
            replace: () => {},
          };
          const terminal = (snapshot: SubagentTerminalSnapshot) => {
            events.push("terminal");
            expect(snapshot.finalText).toBe(liveFinalText);
          };
          return {
            transcriptRef: "agent-transcript:test/agent-1",
            transcript,
            pendingInput: () => {},
            running: () => {
              events.push("running");
              return {
                transcriptRef: "agent-transcript:test/agent-1",
                transcript,
                pendingInput: () => {},
                accounting: () => {
                  events.push("accounting");
                },
                terminal,
              };
            },
            terminal,
          };
        },
        rejected: () => {},
      },
      onProgress: (event) => {
        events.push(`progress:${event.status}`);
      },
    });

    try {
      const result = await fixture.supervisor.capability.delegate({
        toolCallId: "durable",
        profile: "explorer" as const,
        mode: "foreground" as const,
        task: "Return a durable result.",
        mcp: [],
        focusPaths: [],
        signal: new AbortController().signal,
      });

      expect(result).toMatchObject({ delivery: "fresh", ok: true });
      expect(result.content).toContain(liveFinalText);
      expect(events.indexOf("accepted")).toBeLessThan(
        events.indexOf("progress:queued"),
      );
      expect(events.indexOf("running")).toBeLessThan(
        events.indexOf("provider"),
      );
      expect(events.indexOf("terminal")).toBeLessThan(
        events.indexOf("progress:completed"),
      );
      expect(fixture.artifacts.inputs).toEqual([]);
      expect(fixture.supervisor.runSnapshots()[0]?.terminal).toMatchObject({
        status: "completed",
        transcriptRef: "agent-transcript:test/agent-1",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a writer workspace activation will fail,
    When the Supervisor admits the writer,
    Then durable acceptance records the exact workspace intent before any Git side effect`, async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-subagent-writer-order-"),
    );
    const events: string[] = [];
    let providerCalls = 0;
    let preparedReference: SubagentWriteWorkspaceReference | undefined;
    const transcript = {
      initialize: () => {},
      append: () => {},
      replace: () => {},
    };
    const fixture = supervisorFixture({
      workspace,
      provider: {
        ...singleFinalProvider("must not run"),
        async *stream() {
          providerCalls++;
          yield { type: "text", text: "must not run" };
        },
      },
      writeWorkspace: {
        reacquire: unusedWriteWorkspaceReacquisition,
        prepare: ({ childRunId }) => {
          const reference = {
            kind: "isolated_write" as const,
            leaseId: childRunId,
            baseCommit: "a".repeat(40),
            branch: `keel/subagent/${childRunId.slice("subagent-".length)}`,
            worktreePath: join(workspace, "planned-worktree"),
            workspaceRoot: join(workspace, "planned-worktree"),
          };
          preparedReference = reference;
          return {
            kind: "prepared",
            workspace: {
              reference,
              activate: () => {
                events.push("activate");
                return {
                  kind: "failed",
                  worktreePath: reference.worktreePath,
                  error: "simulated Git activation failure",
                  recovery: "Inspect the planned path.",
                };
              },
            },
          };
        },
      },
      lifecyclePersistence: {
        accepted: (lifecycle) => {
          events.push("accepted");
          expect(lifecycle.workspace).toEqual(preparedReference);
          return {
            transcriptRef: "agent-transcript:test/writer-order",
            transcript,
            pendingInput: () => {},
            running: () => {
              events.push("running");
              return {
                transcriptRef: "agent-transcript:test/writer-order",
                transcript,
                pendingInput: () => {},
                accounting: () => {},
                terminal: () => events.push("terminal"),
              };
            },
            terminal: () => {},
          };
        },
        rejected: () => {},
      },
    });

    try {
      const result = await fixture.supervisor.capability.delegate({
        toolCallId: "writer-order",
        profile: "writer",
        mode: "foreground",
        task: "Make one isolated change.",
        mcp: [],
        focusPaths: [],
        signal: new AbortController().signal,
      });

      expect(result).toMatchObject({ delivery: "fresh", ok: false });
      expect(deliveredContent(result)).toContain(
        "simulated Git activation failure",
      );
      expect(events).toEqual(["accepted", "activate", "running", "terminal"]);
      expect(providerCalls).toBe(0);
      expect(
        fixture.supervisor.runSnapshots()[0]?.terminal?.workspace,
      ).toMatchObject({
        disposition: "cleanup_failed",
        worktreePath: preparedReference?.worktreePath,
        workspaceRoot: preparedReference?.workspaceRoot,
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given writer requests violate foreground or single-child admission,
    When the Supervisor plans those delegations,
    Then it rejects them before preparing any write workspace`, async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-subagent-writer-admission-"),
    );
    let preparationCount = 0;
    const fixture = supervisorFixture({
      workspace,
      provider: singleFinalProvider("read-only child may be cancelled"),
      background: {
        signal: new AbortController().signal,
        register: () => {
          throw new Error("rejected writer must not register");
        },
      },
      lifecyclePersistence: durableLifecycleSink(),
      writeWorkspace: settledWriteWorkspaceRuntime({
        workspace,
        settlement: (reference) => ({
          disposition: "preserved",
          worktreePath: reference.worktreePath,
          patch: {
            content: "",
            sourceTruncated: false,
            summary: "clean at base commit",
          },
        }),
        onPrepare: () => preparationCount++,
      }),
    });
    const signal = new AbortController().signal;

    try {
      const background = await fixture.supervisor.capability.delegate({
        toolCallId: "background-writer",
        profile: "writer",
        mode: "background",
        task: "Make a background change.",
        mcp: [],
        focusPaths: [],
        signal,
      });
      expect(rejectionReason(background)).toContain("foreground-only");

      const writerRequest = {
        toolCallId: "batched-writer",
        profile: "writer" as const,
        mode: "foreground" as const,
        task: "Make a batched change.",
        mcp: [],
        focusPaths: [],
        signal,
      };
      const explorerRequest = {
        toolCallId: "batched-explorer",
        profile: "explorer" as const,
        mode: "foreground" as const,
        task: "Inspect beside the writer.",
        mcp: [],
        focusPaths: [],
        signal,
      };
      const batch = fixture.supervisor.capability.prepareBatch([
        { kind: "request", request: writerRequest },
        { kind: "request", request: explorerRequest },
      ]);
      const batchedWriter = await batch.executor.delegate(writerRequest);
      batch.close();

      expect(rejectionReason(batchedWriter)).toContain("only child");
      expect(preparationCount).toBe(0);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given durable writer activation fails before a worktree is materialized,
    When the Supervisor records the terminal Run,
    Then it does not claim that either workspace path exists`, async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-subagent-writer-pre-materialization-"),
    );
    const fixture = supervisorFixture({
      workspace,
      provider: singleFinalProvider("must not run"),
      lifecyclePersistence: durableLifecycleSink(),
      writeWorkspace: {
        reacquire: unusedWriteWorkspaceReacquisition,
        prepare: ({ childRunId }) => {
          const reference: SubagentWriteWorkspaceReference = {
            kind: "isolated_write",
            leaseId: childRunId,
            baseCommit: "a".repeat(40),
            branch: `keel/subagent/${childRunId.slice("subagent-".length)}`,
            worktreePath: join(workspace, "planned-worktree"),
            workspaceRoot: join(workspace, "planned-worktree"),
          };
          return {
            kind: "prepared",
            workspace: {
              reference,
              activate: () => ({
                kind: "failed",
                worktreePath: null,
                error: "activation stopped before materialization",
                recovery: "Retry from a clean checkout.",
              }),
            },
          };
        },
      },
    });

    try {
      const result = await fixture.supervisor.capability.delegate({
        toolCallId: "writer-before-materialization",
        profile: "writer",
        mode: "foreground",
        task: "Make one isolated change.",
        mcp: [],
        focusPaths: [],
        signal: new AbortController().signal,
      });

      expect(result).toMatchObject({ delivery: "fresh", ok: false });
      expect(
        fixture.supervisor.runSnapshots()[0]?.terminal?.workspace,
      ).toMatchObject({
        disposition: "cleanup_failed",
        worktreePath: null,
        workspaceRoot: null,
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a writer profile is exposed without a workspace adapter,
    When Main delegates one valid foreground writer,
    Then admission fails closed before provider execution`, async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-subagent-writer-unavailable-"),
    );
    let providerCalls = 0;
    const fixture = supervisorFixture({
      workspace,
      provider: {
        ...singleFinalProvider("must not run"),
        async *stream() {
          providerCalls++;
          yield { type: "text", text: "must not run" };
        },
      },
    });

    try {
      const result = await fixture.supervisor.capability.delegate({
        toolCallId: "missing-writer-workspace",
        profile: "writer",
        mode: "foreground",
        task: "Make one isolated change.",
        mcp: [],
        focusPaths: [],
        signal: new AbortController().signal,
      });

      expect(rejectionReason(result)).toContain(
        "workspace isolation is unavailable",
      );
      expect(providerCalls).toBe(0);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an unsaved writer cannot activate its prepared worktree,
    When Main delegates through the foreground Supervisor,
    Then it receives a rejection and the provider never starts`, async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-subagent-writer-activation-rejection-"),
    );
    let providerCalls = 0;
    const fixture = supervisorFixture({
      workspace,
      provider: {
        ...singleFinalProvider("must not run"),
        async *stream() {
          providerCalls++;
          yield { type: "text", text: "must not run" };
        },
      },
      writeWorkspace: {
        reacquire: unusedWriteWorkspaceReacquisition,
        prepare: ({ childRunId }) => {
          const reference: SubagentWriteWorkspaceReference = {
            kind: "isolated_write",
            leaseId: childRunId,
            baseCommit: "a".repeat(40),
            branch: `keel/subagent/${childRunId.slice("subagent-".length)}`,
            worktreePath: join(workspace, "unavailable-worktree"),
            workspaceRoot: join(workspace, "unavailable-worktree"),
          };
          return {
            kind: "prepared",
            workspace: {
              reference,
              activate: () => ({
                kind: "failed",
                worktreePath: null,
                error: "Git refused worktree activation",
                recovery: "Repair Git and retry.",
              }),
            },
          };
        },
      },
    });

    try {
      const result = await fixture.supervisor.capability.delegate({
        toolCallId: "writer-activation-rejection",
        profile: "writer",
        mode: "foreground",
        task: "Make one isolated change.",
        mcp: [],
        focusPaths: [],
        signal: new AbortController().signal,
      });

      expect(rejectionReason(result)).toContain(
        "rejected during isolated workspace activation",
      );
      expect(rejectionReason(result)).toContain("Git refused");
      expect(providerCalls).toBe(0);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given Main hides workspace resources from an isolated writer,
    When the child attempts to read a projected hidden path,
    Then the child receives the same denial inside its worktree`, async () => {
    const workspace = await realpath(
      await mkdtemp(join(tmpdir(), "keel-subagent-writer-hidden-")),
    );
    const childWorkspace = join(workspace, "writer-worktree");
    await mkdir(childWorkspace);
    await writeFile(join(childWorkspace, "secret.txt"), "hidden\n");
    let calls = 0;
    const fixture = supervisorFixture({
      workspace,
      hiddenWorkspacePaths: [
        "secret.txt",
        join(workspace, "absolute-secret.txt"),
        join(workspace, "..", "outside-parent.txt"),
      ],
      projectInstructions: {
        relativePath: "AGENTS.md",
        content: "Keep writer patches narrowly scoped.",
      },
      provider: {
        id: "writer-hidden-path",
        estimateInputTokens: () => 100,
        async *stream(options) {
          calls++;
          if (calls === 1) {
            yield {
              type: "tool_call",
              id: "read-hidden-writer-path",
              tool: "read",
              path: "secret.txt",
            };
          } else {
            yield { type: "text", text: "The hidden file was unavailable." };
          }
          completeAttempt(options, requestUsage);
          yield { type: "stop", reason: "stop", usage: requestUsage };
        },
      },
      writeWorkspace: settledWriteWorkspaceRuntime({
        workspace,
        settlement: (reference) => ({
          disposition: "preserved",
          worktreePath: reference.worktreePath,
          patch: {
            content: "",
            sourceTruncated: false,
            summary: "clean at base commit",
          },
        }),
      }),
    });

    try {
      const result = await fixture.supervisor.capability.delegate({
        toolCallId: "writer-hidden-path",
        profile: "writer",
        mode: "foreground",
        task: "Read secret.txt.",
        mcp: [],
        focusPaths: [],
        signal: new AbortController().signal,
      });

      expect(result).toMatchObject({ delivery: "fresh", ok: true });
      expect(fixture.artifacts.inputs[0]?.content).toContain(
        "read failed: ignored path: secret.txt",
      );
      expect(fixture.artifacts.inputs[0]?.content).toContain(
        "Keep writer patches narrowly scoped.",
      );
      expect(fixture.artifacts.inputs[0]?.content).not.toContain('"hidden\\n"');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given writer settlement cannot persist its patch artifact,
    When the child completes its isolated edit,
    Then the Run fails with the preserved workspace and exact storage error`, async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-subagent-writer-artifact-failure-"),
    );
    const fixture = supervisorFixture({
      workspace,
      provider: singleFinalProvider("Writer edit complete."),
      transcriptStore: {
        abortSignalSupport: true,
        verifyReusable: async () => ({ status: "not_reusable" }),
        save: async () => ({
          status: "failed",
          reason: "artifact storage unavailable",
        }),
        discard: async () => {},
      },
      writeWorkspace: settledWriteWorkspaceRuntime({
        workspace,
        settlement: (reference) => ({
          disposition: "preserved",
          worktreePath: reference.worktreePath,
          patch: {
            content: "diff --git a/file b/file\n",
            sourceTruncated: true,
            summary: "M file",
          },
        }),
      }),
    });

    try {
      const result = await fixture.supervisor.capability.delegate({
        toolCallId: "writer-artifact-failure",
        profile: "writer",
        mode: "foreground",
        task: "Make one isolated change.",
        mcp: [],
        focusPaths: [],
        signal: new AbortController().signal,
      });

      expect(result).toMatchObject({ delivery: "fresh", ok: false });
      expect(deliveredContent(result)).toContain(
        "artifact storage unavailable",
      );
      expect(
        fixture.supervisor.runSnapshots()[0]?.terminal?.workspace,
      ).toMatchObject({
        disposition: "preserved",
        patchRef: null,
        patchSourceTruncated: true,
        error: expect.stringContaining("artifact storage unavailable"),
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an admitted writer is never consumed from its prepared batch,
    When Main closes that batch,
    Then the Supervisor settles the isolated workspace once and records cancellation`, async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-subagent-unused-writer-"),
    );
    let settlementCount = 0;
    const fixture = supervisorFixture({
      workspace,
      provider: singleFinalProvider("must not run"),
      writeWorkspace: settledWriteWorkspaceRuntime({
        workspace,
        settlement: (reference) => ({
          disposition: "preserved",
          worktreePath: reference.worktreePath,
          patch: {
            content: "diff --git a/unexpected b/unexpected\n",
            sourceTruncated: false,
            summary: "M unexpected",
          },
        }),
        onSettle: () => settlementCount++,
      }),
    });
    const request = {
      toolCallId: "unused-writer",
      profile: "writer" as const,
      mode: "foreground" as const,
      task: "Make one isolated change.",
      mcp: [],
      focusPaths: [],
      signal: new AbortController().signal,
    };

    try {
      const batch = fixture.supervisor.capability.prepareBatch([
        { kind: "request", request },
      ]);
      batch.close();

      expect(settlementCount).toBe(1);
      expect(fixture.supervisor.runSnapshots()[0]?.terminal).toMatchObject({
        status: "cancelled",
        workspace: {
          disposition: "cleanup_failed",
          patchRef: null,
          summary: "M unexpected",
          error: expect.stringContaining("Unused child worktree changed"),
        },
      });

      const cleanupFixture = supervisorFixture({
        workspace,
        provider: singleFinalProvider("must not run"),
        writeWorkspace: settledWriteWorkspaceRuntime({
          workspace,
          settlement: () => ({
            disposition: "cleanup_failed",
            worktreePath: null,
            patch: null,
            error: "worktree disappeared before execution",
          }),
        }),
      });
      const cleanupRequest = {
        ...request,
        toolCallId: "unused-writer-cleanup-failed",
      };
      const cleanupBatch = cleanupFixture.supervisor.capability.prepareBatch([
        { kind: "request", request: cleanupRequest },
      ]);
      cleanupBatch.close();
      expect(
        cleanupFixture.supervisor.runSnapshots()[0]?.terminal?.workspace,
      ).toMatchObject({
        disposition: "cleanup_failed",
        worktreePath: null,
        workspaceRoot: null,
        patchSourceTruncated: false,
        summary: "workspace requires inspection",
        error: "worktree disappeared before execution",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given workspace settlement fails after producing an inspectable patch,
    When the writer child reaches its terminal boundary,
    Then the failed Run retains both the patch artifact and cleanup evidence`, async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-subagent-writer-settlement-failure-"),
    );
    const fixture = supervisorFixture({
      workspace,
      provider: singleFinalProvider("Writer edit complete."),
      lifecyclePersistence: durableLifecycleSink(),
      writeWorkspace: settledWriteWorkspaceRuntime({
        workspace,
        settlement: (reference) => ({
          disposition: "cleanup_failed",
          worktreePath: reference.worktreePath,
          patch: {
            content: "diff --git a/file b/file\n",
            sourceTruncated: false,
            summary: "M file",
          },
          error: "workspace identity changed during settlement",
        }),
      }),
    });

    try {
      const result = await fixture.supervisor.capability.delegate({
        toolCallId: "writer-settlement-failure",
        profile: "writer",
        mode: "foreground",
        task: "Make one isolated change.",
        mcp: [],
        focusPaths: [],
        signal: new AbortController().signal,
      });

      expect(result).toMatchObject({ delivery: "fresh", ok: false });
      expect(deliveredContent(result)).toContain("identity changed");
      expect(
        fixture.supervisor.runSnapshots()[0]?.terminal?.workspace,
      ).toMatchObject({
        disposition: "cleanup_failed",
        patchRef: expect.stringContaining("writer-settlement-failure"),
        patchSourceTruncated: false,
        error: "workspace identity changed during settlement",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test.each([
    {
      scenario: "no patch survived settlement",
      patch: null,
      artifactFailure: false,
      expectedError: "workspace vanished",
      expectedSummary: "workspace requires inspection",
    },
    {
      scenario: "patch storage also failed",
      patch: {
        content: "diff --git a/file b/file\n",
        sourceTruncated: true,
        summary: "M file",
      },
      artifactFailure: true,
      expectedError: "artifact storage unavailable",
      expectedSummary: "M file",
    },
  ])(
    `Given cleanup failed and $scenario,
    When the writer reaches its terminal handoff,
    Then Main receives truthful cleanup and artifact evidence`,
    async ({ patch, artifactFailure, expectedError, expectedSummary }) => {
      const workspace = await mkdtemp(
        join(tmpdir(), "keel-subagent-writer-cleanup-evidence-"),
      );
      const fixture = supervisorFixture({
        workspace,
        provider: singleFinalProvider("Writer edit complete."),
        ...(artifactFailure
          ? {
              transcriptStore: {
                abortSignalSupport: true as const,
                verifyReusable: async () => ({
                  status: "not_reusable" as const,
                }),
                save: async () => ({
                  status: "failed" as const,
                  reason: "artifact storage unavailable",
                }),
                discard: async () => {},
              },
            }
          : {}),
        writeWorkspace: settledWriteWorkspaceRuntime({
          workspace,
          settlement: () => ({
            disposition: "cleanup_failed",
            worktreePath: null,
            patch,
            error: "workspace vanished",
          }),
        }),
      });

      try {
        const result = await fixture.supervisor.capability.delegate({
          toolCallId: `writer-cleanup-${artifactFailure ? "artifact" : "missing"}`,
          profile: "writer",
          mode: "foreground",
          task: "Make one isolated change.",
          mcp: [],
          focusPaths: [],
          signal: new AbortController().signal,
        });

        expect(result).toMatchObject({ delivery: "fresh", ok: false });
        expect(deliveredContent(result)).toContain(expectedError);
        expect(
          fixture.supervisor.runSnapshots()[0]?.terminal?.workspace,
        ).toMatchObject({
          disposition: "cleanup_failed",
          worktreePath: null,
          workspaceRoot: null,
          patchRef: null,
          patchSourceTruncated: patch?.sourceTruncated ?? false,
          summary: expectedSummary,
          error: expect.stringContaining(expectedError),
        });
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    },
  );

  test(`Given an accepted child's durable lifecycle writer fails before provider work,
    When the Supervisor starts that child,
    Then the persistence failure escapes instead of becoming a normal rejected or failed child result`, async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-subagent-supervisor-"),
    );
    let providerCalls = 0;
    const fixture = supervisorFixture({
      workspace,
      provider: {
        ...singleFinalProvider("must not run"),
        async *stream() {
          providerCalls++;
          yield { type: "text", text: "must not run" };
        },
      },
      lifecyclePersistence: {
        accepted: () => ({
          transcriptRef: "agent-transcript:test/fatal",
          transcript: {
            initialize: () => {},
            append: () => {},
            replace: () => {},
          },
          pendingInput: () => {},
          running: () => {
            throw new SubagentPersistenceError("durable writer failed");
          },
          terminal: () => {},
        }),
        rejected: () => {},
      },
    });

    try {
      await expect(
        fixture.supervisor.capability.delegate({
          toolCallId: "fatal-persistence",
          profile: "explorer" as const,
          mode: "foreground" as const,
          task: "Do not continue after durable storage fails.",
          mcp: [],
          focusPaths: [],
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow(SubagentPersistenceError);
      expect(providerCalls).toBe(0);
      expect(fixture.supervisor.activeChildRunCount()).toBe(0);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a root allows two active children and three total children,
    When main prepares an oversized batch and later delegates again,
    Then admission is root-inclusive, atomic, and retains the total limit after slots release`, async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-subagent-supervisor-"),
    );
    const firstPairStarted = Promise.withResolvers<void>();
    const releaseFirstPair = Promise.withResolvers<void>();
    const continuationMessageCounts: number[] = [];
    let providerCalls = 0;
    const provider: LLMProvider = {
      id: "admission-boundary-provider",
      estimateInputTokens: () => 100,
      async *stream(options) {
        providerCalls++;
        if (providerCalls <= 2) {
          if (providerCalls === 2) firstPairStarted.resolve();
          await firstPairStarted.promise;
          await releaseFirstPair.promise;
        }
        yield { type: "text", text: "child completed" };
        completeAttempt(options, requestUsage);
        yield { type: "stop", reason: "stop", usage: requestUsage };
      },
    };
    const fixture = supervisorFixture({
      workspace,
      provider,
      maxActiveAgentRuns: 3,
      maxTotalChildRuns: 3,
      onContinuationLease: (input) => {
        continuationMessageCounts.push(input.additionalMessages.length);
      },
    });
    const signal = new AbortController().signal;
    const requests = ["one", "two", "three"].map((toolCallId) => ({
      toolCallId,
      profile: "explorer" as const,
      mode: "foreground" as const,
      task: `Inspect ${toolCallId}.`,
      mcp: [],
      focusPaths: [],
      signal,
    }));

    try {
      const batch = fixture.supervisor.capability.prepareBatch(
        requests.map((request) => ({ kind: "request", request })),
      );
      expect(continuationMessageCounts).toEqual([3]);
      expect(fixture.supervisor.activeAgentRunCount()).toBe(3);
      expect(fixture.supervisor.activeChildRunCount()).toBe(2);
      expect(fixture.supervisor.totalAcceptedCount()).toBe(2);
      const firstPair = requests.map((request) =>
        batch.executor.delegate(request),
      );
      await firstPairStarted.promise;
      const third = await firstPair[2];
      expect(third).toMatchObject({
        delivery: "rejected",
        reason: expect.stringContaining("active agent limit"),
      });
      releaseFirstPair.resolve();
      const [first, second] = await Promise.all(firstPair.slice(0, 2));
      batch.close();
      expect(first).toMatchObject({ delivery: "fresh", ok: true });
      expect(second).toMatchObject({ delivery: "fresh", ok: true });
      expect(fixture.supervisor.activeAgentRunCount()).toBe(1);

      const lastAccepted = await fixture.supervisor.capability.delegate({
        toolCallId: "four",
        profile: "explorer" as const,
        mode: "foreground" as const,
        task: "Inspect four.",
        mcp: [],
        focusPaths: [],
        signal,
      });
      const overTotal = await fixture.supervisor.capability.delegate({
        toolCallId: "five",
        profile: "explorer" as const,
        mode: "foreground" as const,
        task: "Inspect five.",
        mcp: [],
        focusPaths: [],
        signal,
      });
      expect(lastAccepted).toMatchObject({ delivery: "fresh", ok: true });
      expect(overTotal).toMatchObject({
        delivery: "rejected",
        reason: expect.stringContaining("total child limit"),
      });
      expect(fixture.supervisor.totalAcceptedCount()).toBe(3);
      expect(fixture.supervisor.runSnapshots()).toHaveLength(3);
      expect(providerCalls).toBe(3);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a delegate batch reserves one queued child,
    When dispatch receives an unprepared call and then closes before starting the admitted call,
    Then the foreign call fails closed and the queued child is durably cancelled without provider work`, async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-subagent-supervisor-"),
    );
    let providerCalls = 0;
    let continuationReleases = 0;
    const persistedTerminals: SubagentTerminalSnapshot[] = [];
    const baseProvider = singleFinalProvider("unreachable");
    const fixture = supervisorFixture({
      workspace,
      provider: {
        ...baseProvider,
        async *stream(options) {
          providerCalls++;
          yield* baseProvider.stream(options);
        },
      },
      onContinuationReleased: () => {
        continuationReleases++;
      },
      lifecyclePersistence: {
        accepted: (lifecycle) => {
          const transcript = {
            initialize: () => {},
            append: () => {},
            replace: () => {},
          };
          const terminal = (snapshot: SubagentTerminalSnapshot) => {
            persistedTerminals.push(snapshot);
            return {
              delegationId: lifecycle.delegationId,
              childAgentId: lifecycle.childAgentId,
              childRunId: lifecycle.childRunId,
              task: lifecycle.task,
              transcriptRef: "agent-transcript:test/cancelled-before-start",
              ...snapshot,
            };
          };
          return {
            transcriptRef: "agent-transcript:test/cancelled-before-start",
            transcript,
            pendingInput: () => {},
            running: () => ({
              transcriptRef: "agent-transcript:test/cancelled-before-start",
              transcript,
              pendingInput: () => {},
              accounting: () => {},
              terminal,
            }),
            terminal,
          };
        },
        rejected: () => {},
      },
    });
    const request = {
      toolCallId: "prepared",
      profile: "explorer" as const,
      mode: "foreground" as const,
      task: "Do not start this child.",
      mcp: [],
      focusPaths: [],
      signal: new AbortController().signal,
    };

    try {
      const batch = fixture.supervisor.capability.prepareBatch([
        { kind: "request", request },
      ]);
      const foreign = await batch.executor.delegate({
        ...request,
        toolCallId: "foreign",
      });
      batch.close();

      expect(foreign).toMatchObject({
        delivery: "rejected",
        reason: expect.stringContaining("not part of the prepared tool batch"),
      });
      expect(providerCalls).toBe(0);
      expect(continuationReleases).toBe(1);
      expect(persistedTerminals).toEqual([
        {
          status: "cancelled",
          finalText: null,
          error: "Child was cancelled before execution started.",
          usage: {
            inputTokens: 0,
            cachedInputTokens: 0,
            uncachedInputTokens: 0,
            outputTokens: 0,
          },
          turns: 0,
          costUsd: 0,
          pendingInputCount: 0,
          workspace: null,
        },
      ]);
      expect(fixture.supervisor.activeChildRunCount()).toBe(0);
      expect(fixture.supervisor.runSnapshots()).toMatchObject([
        {
          state: "terminal",
          terminal: {
            status: "cancelled",
            transcriptRef: "agent-transcript:test/cancelled-before-start",
          },
        },
      ]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an ephemeral delegate batch reserves a queued child,
    When the batch closes before dispatch,
    Then the in-memory receipt becomes cancelled and releases without provider work`, async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-subagent-supervisor-"),
    );
    let providerCalls = 0;
    const baseProvider = singleFinalProvider("unreachable");
    const fixture = supervisorFixture({
      workspace,
      provider: {
        ...baseProvider,
        async *stream(options) {
          providerCalls++;
          yield* baseProvider.stream(options);
        },
      },
    });
    const request = {
      toolCallId: "ephemeral-queued",
      profile: "explorer" as const,
      mode: "foreground" as const,
      task: "Do not start this child.",
      mcp: [],
      focusPaths: [],
      signal: new AbortController().signal,
    };

    try {
      const batch = fixture.supervisor.capability.prepareBatch([
        { kind: "request", request },
      ]);
      batch.close();

      expect(providerCalls).toBe(0);
      expect(fixture.supervisor.activeChildRunCount()).toBe(0);
      expect(fixture.supervisor.runSnapshots()).toMatchObject([
        {
          state: "terminal",
          terminal: { status: "cancelled", transcriptRef: null },
        },
      ]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given two foreground children share the parent AbortSignal,
    When the parent is cancelled while both providers are live,
    Then cancellation cascades to both and no active child remains`, async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-subagent-supervisor-"),
    );
    const bothStarted = Promise.withResolvers<void>();
    let activeProviderCalls = 0;
    const provider: LLMProvider = {
      id: "multi-child-cancellation-provider",
      estimateInputTokens: () => 100,
      async *stream(options) {
        activeProviderCalls++;
        if (activeProviderCalls === 2) bothStarted.resolve();
        try {
          await new Promise<void>((_resolve, reject) => {
            const abort = () =>
              reject(new KeelError("provider_aborted", "child aborted"));
            if (options.signal.aborted) abort();
            else
              options.signal.addEventListener("abort", abort, { once: true });
          });
        } finally {
          activeProviderCalls--;
        }
        yield { type: "text", text: "unreachable" };
      },
    };
    const fixture = supervisorFixture({ workspace, provider });
    const parent = new AbortController();
    const requests = ["one", "two"].map((toolCallId) => ({
      toolCallId,
      profile: "explorer" as const,
      mode: "foreground" as const,
      task: `Wait in ${toolCallId}.`,
      mcp: [],
      focusPaths: [],
      signal: parent.signal,
    }));

    try {
      const batch = fixture.supervisor.capability.prepareBatch(
        requests.map((request) => ({ kind: "request", request })),
      );
      const results = requests.map((request) =>
        batch.executor.delegate(request),
      );
      await bothStarted.promise;
      parent.abort(new Error("cancel the parent"));
      const settled = await Promise.all(results);
      batch.close();

      expect(
        settled.map((result) => JSON.parse(deliveredContent(result)).status),
      ).toEqual(["cancelled", "cancelled"]);
      expect(activeProviderCalls).toBe(0);
      expect(fixture.supervisor.activeChildRunCount()).toBe(0);
      expect(fixture.supervisor.runSnapshots()).toMatchObject([
        { state: "terminal", terminal: { status: "cancelled" } },
        { state: "terminal", terminal: { status: "cancelled" } },
      ]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given one sibling fails with a non-circuit provider error while another is independent,
    When both foreground children run in one prepared batch,
    Then Supervisor waits for both and preserves the unrelated successful result in source order`, async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-subagent-supervisor-"),
    );
    const bothStarted = Promise.withResolvers<void>();
    let providerCalls = 0;
    const provider: LLMProvider = {
      id: "sibling-isolation-provider",
      estimateInputTokens: () => 100,
      async *stream(options) {
        providerCalls++;
        const attempt = options.providerRequestAttempts?.begin();
        if (providerCalls === 2) bothStarted.resolve();
        await bothStarted.promise;
        const task = options.messages
          .filter((message) => message.role === "user")
          .map((message) => message.content)
          .join("\n");
        if (task.includes("Fail independently")) {
          attempt?.finish({
            outcome: "terminal_error",
            errorCode: "provider_network_error",
          });
          throw new KeelError(
            "provider_network_error",
            "one child lost its connection",
          );
        }
        yield { type: "text", text: "independent sibling completed" };
        attempt?.finish({ outcome: "completed", usage: requestUsage });
        yield { type: "stop", reason: "stop", usage: requestUsage };
      },
    };
    const fixture = supervisorFixture({ workspace, provider });
    const signal = new AbortController().signal;
    const requests = [
      {
        toolCallId: "failed",
        profile: "explorer" as const,
        mode: "foreground" as const,
        task: "Fail independently.",
        mcp: [],
        focusPaths: [],
        signal,
      },
      {
        toolCallId: "successful",
        profile: "explorer" as const,
        mode: "foreground" as const,
        task: "Complete independently.",
        mcp: [],
        focusPaths: [],
        signal,
      },
    ];

    try {
      const batch = fixture.supervisor.capability.prepareBatch(
        requests.map((request) => ({ kind: "request", request })),
      );
      const settled = await Promise.all(
        requests.map((request) => batch.executor.delegate(request)),
      );
      batch.close();

      expect(
        settled.map((result) => ({
          ok: result.ok,
          status: JSON.parse(deliveredContent(result)).status,
        })),
      ).toEqual([
        { ok: false, status: "failed" },
        { ok: true, status: "completed" },
      ]);
      const completedSibling = settled[1];
      if (completedSibling === undefined) {
        throw new Error("completed sibling result was not returned");
      }
      expect(deliveredContent(completedSibling)).toContain(
        "independent sibling completed",
      );
      expect(fixture.supervisor.activeChildRunCount()).toBe(0);
      expect(providerCalls).toBe(2);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a provider does not certify AbortSignal settlement,
    When main requests a child,
    Then admission fails before starting provider work or registering a run`, async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-subagent-supervisor-"),
    );
    let providerCalls = 0;
    let acceptedLifecycleCount = 0;
    const rejectedTasks: string[] = [];
    const fixture = supervisorFixture({
      workspace,
      providerAbortSignalSupport: false,
      lifecyclePersistence: {
        accepted: () => {
          acceptedLifecycleCount++;
          throw new Error("unexpected accepted lifecycle");
        },
        rejected: (lifecycle) => {
          rejectedTasks.push(lifecycle.task);
        },
      },
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
        profile: "explorer" as const,
        mode: "foreground" as const,
        task: "Do not start this child.",
        mcp: [],
        focusPaths: [],
        signal: new AbortController().signal,
      });

      expect(result).toEqual({
        delivery: "rejected",
        ok: false,
        reason:
          "Delegation rejected: the selected child provider does not certify AbortSignal settlement.",
        recovery:
          "Continue in Main, or select a child model whose provider certifies cancellation settlement.",
        maxResultChars: 6_000,
      });
      expect(providerCalls).toBe(0);
      expect(acceptedLifecycleCount).toBe(0);
      expect(rejectedTasks).toEqual(["Do not start this child."]);
      expect(fixture.supervisor.totalAcceptedCount()).toBe(0);
      expect(fixture.supervisor.runSnapshots()).toEqual([]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a delegation must be rejected before admission but its durable receipt cannot be written,
    When main receives the rejection,
    Then no child starts and the stable receipt reports the storage failure`, async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-subagent-supervisor-"),
    );
    let providerCalls = 0;
    const fixture = supervisorFixture({
      workspace,
      providerAbortSignalSupport: false,
      lifecyclePersistence: {
        accepted: () => {
          throw new Error("accepted lifecycle must not be created");
        },
        rejected: () => {
          throw new Error("receipt disk unavailable");
        },
      },
      provider: {
        id: "uncertified-provider",
        async *stream() {
          providerCalls++;
          yield { type: "text", text: "unreachable" };
        },
      },
    });

    try {
      const result = await fixture.supervisor.capability.delegate({
        toolCallId: "rejection-storage-failure",
        profile: "explorer" as const,
        mode: "foreground" as const,
        task: "Reject without starting a child.",
        mcp: [],
        focusPaths: [],
        signal: new AbortController().signal,
      });

      expect(result).toMatchObject({
        delivery: "rejected",
        ok: false,
        reason: expect.stringContaining(
          "Lifecycle receipt could not be stored: receipt disk unavailable",
        ),
      });
      expect(providerCalls).toBe(0);
      expect(fixture.supervisor.totalAcceptedCount()).toBe(0);
      expect(fixture.supervisor.runSnapshots()).toEqual([]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a hard-rejection receipt may have been partially committed,
    When persistence reports an indeterminate write,
    Then delegation fails fatally instead of disguising ledger corruption as a normal rejection`, async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-subagent-supervisor-"),
    );
    const failure = new SubagentPersistenceError(
      "rejection receipt state is indeterminate",
    );
    const fixture = supervisorFixture({
      workspace,
      provider: singleFinalProvider("must not run"),
      providerAbortSignalSupport: false,
      lifecyclePersistence: {
        accepted: () => {
          throw new Error("accepted lifecycle must not be created");
        },
        rejected: () => {
          throw failure;
        },
      },
    });

    try {
      await expect(
        fixture.supervisor.capability.delegate({
          toolCallId: "indeterminate-rejection",
          profile: "explorer" as const,
          mode: "foreground" as const,
          task: "Reject without corrupting the durable ledger.",
          mcp: [],
          focusPaths: [],
          signal: new AbortController().signal,
        }),
      ).rejects.toBe(failure);
      expect(fixture.supervisor.totalAcceptedCount()).toBe(0);
      expect(fixture.supervisor.runSnapshots()).toEqual([]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test.each([
    {
      failure: new Error("acceptance ledger unavailable"),
      expected:
        "Delegation rejected: lifecycle could not be stored before child admission.",
      fatal: false,
    },
    {
      failure: new SubagentPersistenceError(
        "acceptance state is indeterminate",
      ),
      expected: "acceptance state is indeterminate",
      fatal: true,
    },
  ])(
    `Given durable acceptance fails with $failure,
    When main tries to admit the child,
    Then provider work never starts and the failure follows its recoverability contract`,
    async ({ failure, expected, fatal }) => {
      const workspace = await mkdtemp(
        join(tmpdir(), "keel-subagent-supervisor-"),
      );
      let providerCalls = 0;
      const fixture = supervisorFixture({
        workspace,
        lifecyclePersistence: {
          accepted: () => {
            throw failure;
          },
          rejected: () => {},
        },
        provider: {
          id: "must-not-run-after-acceptance-failure",
          estimateInputTokens: () => 100,
          async *stream() {
            providerCalls++;
            yield { type: "text", text: "unreachable" };
          },
        },
      });

      try {
        const pending = fixture.supervisor.capability.delegate({
          toolCallId: `acceptance-${fatal ? "fatal" : "recoverable"}`,
          profile: "explorer" as const,
          mode: "foreground" as const,
          task: "Do not start without durable acceptance.",
          mcp: [],
          focusPaths: [],
          signal: new AbortController().signal,
        });
        if (fatal) {
          await expect(pending).rejects.toThrow(expected);
        } else {
          await expect(pending).resolves.toMatchObject({
            delivery: "rejected",
            reason: expect.stringContaining(expected),
          });
        }
        expect(providerCalls).toBe(0);
        expect(fixture.supervisor.totalAcceptedCount()).toBe(0);
        expect(fixture.supervisor.runSnapshots()).toEqual([]);
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    },
  );

  test(`Given one delegation completes and its result is replayed alone and beside fresh work,
    When every batch reserves its provider-shaped continuation,
    Then replay is priced without duplicate usage while the unique child gets its own run`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-subagent-supervisor-"),
    );
    await writeFile(
      join(workspace, "module.ts"),
      "export const answer = 42;\n",
    );
    const exposedTools: string[][] = [];
    const continuationMessages: (readonly { readonly content: string }[])[] =
      [];
    let continuationReleases = 0;
    const fixture = supervisorFixture({
      workspace,
      provider: scriptedSuccessfulProvider(exposedTools),
      hiddenWorkspacePaths: [],
      onContinuationReleased: () => {
        continuationReleases++;
      },
      onContinuationLease: (input) => {
        continuationMessages.push(input.additionalMessages);
      },
    });
    const signal = new AbortController().signal;

    try {
      expect(fixture.supervisor.capability.available()).toBe(true);
      // When
      const first = await fixture.supervisor.capability.delegate({
        toolCallId: "delegate-1",
        profile: "explorer" as const,
        mode: "foreground" as const,
        task: "Inspect module.ts.",
        mcp: [],
        focusPaths: ["module.ts"],
        signal,
      });
      const replayOnly = await fixture.supervisor.capability.delegate({
        toolCallId: "delegate-1",
        profile: "explorer" as const,
        mode: "foreground" as const,
        task: "Changed replay text must not create a new run.",
        mcp: [],
        focusPaths: [],
        signal,
      });
      const replayRequest = {
        toolCallId: "delegate-1",
        profile: "explorer" as const,
        mode: "foreground" as const,
        task: "Replay beside one fresh child.",
        mcp: [],
        focusPaths: [],
        signal,
      };
      const secondRequest = {
        toolCallId: "delegate-2",
        profile: "explorer" as const,
        mode: "foreground" as const,
        task: "Inspect it again.",
        mcp: [],
        focusPaths: [],
        signal,
      };
      const mixedBatch = fixture.supervisor.capability.prepareBatch([
        { kind: "request", request: replayRequest },
        { kind: "request", request: secondRequest },
      ]);
      const [replayBesideFresh, second] = await Promise.all([
        mixedBatch.executor.delegate(replayRequest),
        mixedBatch.executor.delegate(secondRequest),
      ]);
      mixedBatch.close();

      // Then
      expect(first.delivery).toBe("fresh");
      expect(first.ok).toBe(true);
      expect(continuationReleases).toBe(3);
      expect(first.usage).toEqual({
        inputTokens: 200,
        cachedInputTokens: 0,
        uncachedInputTokens: 200,
        outputTokens: 20,
      });
      expect(replayOnly).toEqual({
        delivery: "replayed",
        ok: true,
        content: first.content,
      });
      expect(replayBesideFresh).toEqual(replayOnly);
      expect(second).toMatchObject({ delivery: "fresh", ok: true });
      expect(continuationMessages.map((messages) => messages.length)).toEqual([
        1, 1, 2,
      ]);
      expect(continuationMessages[1]?.[0]?.content).toBe(first.content);
      expect(continuationMessages[2]?.[0]?.content).toBe(first.content);
      expect(fixture.supervisor.totalAcceptedCount()).toBe(2);
      expect(fixture.supervisor.capability.available()).toBe(true);
      expect(fixture.supervisor.activeChildRunCount()).toBe(0);
      expect(fixture.supervisor.runSnapshots()).toMatchObject([
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
        {
          delegationId: "main-run:delegate-2",
          task: "Inspect it again.",
          state: "terminal",
          terminal: {
            status: "completed",
            usage: requestUsage,
            turns: 1,
            transcriptRef: "tool-output:test/delegate-2",
          },
        },
      ]);
      expect(fixture.artifacts.inputs).toHaveLength(2);
      expect(fixture.artifacts.inputs[0]?.content).toContain(
        '"delegationId":"main-run:delegate-1"',
      );
      expect(fixture.artifacts.inputs[0]?.content).toMatch(
        /"childRunId":"subagent-[^"]+"/u,
      );
      expect(exposedTools).toHaveLength(3);
      for (const tools of exposedTools) {
        expect(tools.toSorted()).toEqual(
          [...explorerCapability.builtinTools].toSorted(),
        );
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given one completed child has a long identity and a large source batch replays it,
    When aggregate result admission projects every replay,
    Then each delivery fits its share and the batch never exceeds the tree result ceiling`, async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-subagent-supervisor-"),
    );
    const toolCallId = `long-${"x".repeat(2_000)}`;
    const continuationMessages: (readonly { readonly content: string }[])[] =
      [];
    const fixture = supervisorFixture({
      workspace,
      provider: singleFinalProvider("stable child result"),
      onContinuationLease: (input) => {
        continuationMessages.push(input.additionalMessages);
      },
    });
    const request = {
      toolCallId,
      profile: "explorer" as const,
      mode: "foreground" as const,
      task: "Return one stable result.",
      mcp: [],
      focusPaths: [],
      signal: new AbortController().signal,
    };

    try {
      const first = await fixture.supervisor.capability.delegate(request);
      expect(first.delivery).toBe("fresh");
      const replayEntries = Array.from({ length: 40 }, () => ({
        kind: "request" as const,
        request,
      }));
      const batch = fixture.supervisor.capability.prepareBatch(replayEntries);
      const replays = await Promise.all(
        replayEntries.map(() => batch.executor.delegate(request)),
      );
      batch.close();

      expect(replays).toHaveLength(40);
      expect(replays.every((result) => result.delivery === "replayed")).toBe(
        true,
      );
      const replayContents = replays.map(deliveredContent);
      expect(replayContents.every((content) => content.length <= 600)).toBe(
        true,
      );
      expect(
        replayContents.reduce((total, content) => total + content.length, 0),
      ).toBeLessThanOrEqual(24_000);
      expect(
        continuationMessages.at(-1)?.map((message) => message.content),
      ).toEqual(replayContents);
      expect(fixture.supervisor.totalAcceptedCount()).toBe(1);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a large delegate batch is rejected with long path diagnostics,
    When Main receives the rejected tool results,
    Then priced continuation messages exactly match delivery and retain each recovery action`, async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-subagent-supervisor-"),
    );
    const continuationMessages: (readonly { readonly content: string }[])[] =
      [];
    const fixture = supervisorFixture({
      workspace,
      provider: singleFinalProvider("unused"),
      onContinuationLease: (input) => {
        continuationMessages.push(input.additionalMessages);
      },
    });
    const signal = new AbortController().signal;
    const entries = Array.from({ length: 40 }, (_, index) => {
      const task = `Inspect rejected path ${index}.`;
      const focusPaths = [`../${"x".repeat(480)}-${index}`];
      return {
        kind: "request" as const,
        request: {
          toolCallId: `rejected-${index}`,
          profile: "explorer" as const,
          mode: "foreground" as const,
          task,
          mcp: [],
          focusPaths,
          signal,
        },
        toolCall: {
          id: `rejected-${index}`,
          tool: "delegate" as const,
          profile: "explorer" as const,
          mode: "foreground" as const,
          task,
          mcp: [],
          focusPaths,
        },
      };
    });

    try {
      const batch = fixture.supervisor.capability.prepareBatch(entries);
      const deliveries = await Promise.all(
        entries.map((entry) =>
          executeToolCall({
            workspace,
            signal,
            bash: { kind: "disabled" },
            builtinToolAuthority: {
              kind: "auto",
              delegation: {
                mode: "foreground",
                profileCatalog: builtinSubagentProfileCatalog,
              },
            },
            toolCall: entry.toolCall,
            delegation: batch.executor,
          }),
        ),
      );
      batch.close();

      const pricedContents = continuationMessages
        .at(-1)
        ?.map((message) => message.content);
      const deliveredContents = deliveries.map((delivery) => delivery.content);
      expect(pricedContents).toEqual(deliveredContents);
      expect(
        deliveredContents.every((content) =>
          content.includes(
            "Recovery: Correct or omit the invalid workspace-relative focus path before delegating again.",
          ),
        ),
      ).toBe(true);
      expect(deliveredContents.every((content) => content.length <= 600)).toBe(
        true,
      );
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
            profile: "explorer" as const,
            mode: "foreground" as const,
            task: "A replay must join the registered run.",
            mcp: [],
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
        profile: "explorer" as const,
        mode: "foreground" as const,
        task: "Inspect module.ts.",
        mcp: [],
        focusPaths: ["module.ts"],
        signal: new AbortController().signal,
      });
      if (replay === undefined)
        throw new Error("queued replay was not observed");
      await replay;

      expect(result.ok).toBe(true);
      expect(supervisor.totalAcceptedCount()).toBe(1);
      expect(supervisor.activeChildRunCount()).toBe(0);
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
          profile: "explorer" as const,
          mode: "foreground" as const,
          task: "Complete despite observation failure.",
          mcp: [],
          focusPaths: ["module.ts"],
          signal: new AbortController().signal,
        });

        expect(result.ok).toBe(true);
        expect(fixture.supervisor.activeChildRunCount()).toBe(0);
        expect(fixture.supervisor.runSnapshots()).toMatchObject([
          { state: "terminal", terminal: { status: "completed", turns: 2 } },
        ]);
        expect(progress.map((event) => event.status)).toEqual([
          "queued",
          "running",
          "turn",
          "tool",
          "turn",
          "completed",
        ]);
        expect(progress.every((event) => event.elapsedMs === 0)).toBe(true);
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    },
  );

  test(`Given delegation requests lack a background owner, have an invalid focus path, or cannot preserve main synthesis budget,
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
      const unattachedFixture = supervisorFixture({ workspace, provider });
      const unattached = await unattachedFixture.supervisor.capability.delegate(
        {
          toolCallId: "unattached-background",
          profile: "explorer" as const,
          mode: "background",
          task: "Do not detach from this ephemeral owner.",
          mcp: [],
          focusPaths: [],
          signal: new AbortController().signal,
        },
      );
      const invalidFixture = supervisorFixture({ workspace, provider });
      const invalid = await invalidFixture.supervisor.capability.delegate({
        toolCallId: "invalid-focus",
        profile: "explorer" as const,
        mode: "foreground" as const,
        task: "Inspect an invalid path.",
        mcp: [],
        focusPaths: ["../outside"],
        signal: new AbortController().signal,
      });
      const invalidReplay = await invalidFixture.supervisor.capability.delegate(
        {
          toolCallId: "invalid-focus",
          profile: "explorer" as const,
          mode: "foreground" as const,
          task: "A replay cannot change admission.",
          mcp: [],
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
        profile: "explorer" as const,
        mode: "foreground" as const,
        task: "Inspect without a child budget.",
        mcp: [],
        focusPaths: [],
        signal: new AbortController().signal,
      });
      const invalidEstimateFixture = supervisorFixture({
        workspace,
        provider: {
          ...provider,
          estimateInputTokens: () => Number.NaN,
        },
      });
      const invalidEstimate =
        await invalidEstimateFixture.supervisor.capability.delegate({
          toolCallId: "invalid-input-estimate",
          profile: "explorer" as const,
          mode: "foreground" as const,
          task: "Reject before running with an invalid provider estimate.",
          mcp: [],
          focusPaths: [],
          signal: new AbortController().signal,
        });
      const blockedFixture = supervisorFixture({
        workspace,
        provider,
        providerBlocked: () => true,
      });
      const providerBlocked =
        await blockedFixture.supervisor.capability.delegate({
          toolCallId: "provider-blocked",
          profile: "explorer" as const,
          mode: "foreground" as const,
          task: "Do not start after the provider circuit opens.",
          mcp: [],
          focusPaths: [],
          signal: new AbortController().signal,
        });

      expect(unattached).toEqual({
        delivery: "rejected",
        ok: false,
        reason:
          "Delegation rejected: background mode requires a saved interactive session owner.",
        recovery:
          "Use foreground delegation, or start a saved interactive session before requesting background mode.",
        maxResultChars: 6_000,
      });
      expect(invalid.ok).toBe(false);
      expect(rejectionReason(invalid)).toContain("invalid focus path");
      expect(invalidReplay).toEqual(invalid);
      expect(noBudget).toEqual({
        delivery: "rejected",
        ok: false,
        reason:
          "Delegation rejected: the available tree budget cannot fund this child while preserving one admitted aggregate parent continuation.",
        recovery:
          "Do not retry with the same session budget. Continue in the current agent, or ask the user to start a new run with a higher --max-cost.",
        maxResultChars: 6_000,
      });
      expect(invalidEstimate).toEqual({
        delivery: "rejected",
        ok: false,
        reason:
          "Delegation rejected: the child request cost cannot be estimated.",
        recovery:
          "Continue in Main, or select a provider and model with known token estimation before delegating again.",
        maxResultChars: 6_000,
      });
      expect(rejectionReason(providerBlocked)).toContain(
        "auth/quota circuit is open",
      );
      expect(unattachedFixture.supervisor.totalAcceptedCount()).toBe(0);
      expect(invalidFixture.supervisor.totalAcceptedCount()).toBe(0);
      expect(budgetFixture.supervisor.totalAcceptedCount()).toBe(0);
      expect(invalidEstimateFixture.supervisor.totalAcceptedCount()).toBe(0);
      expect(blockedFixture.supervisor.totalAcceptedCount()).toBe(0);
      expect(providerCalls).toBe(0);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the provider prices maxOutputTokens in the finalized child request,
    When the root budget is two tokens short of funding both minimum child work and main continuation,
    Then admission rejects before accepting a child or starting child provider work`, async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-subagent-supervisor-"),
    );
    let rawProviderCalls = 0;
    const usage = {
      inputTokens: 0,
      cachedInputTokens: 0,
      uncachedInputTokens: 0,
      outputTokens: 0,
    } as const;
    const rawProvider: LLMProvider = {
      id: "shape-sensitive-child-admission",
      abortSignalSupport: true,
      estimateInputTokens: (options) =>
        options.maxOutputTokens === undefined ? 100 : 110,
      async *stream(options) {
        rawProviderCalls++;
        if (rawProviderCalls === 1) {
          yield {
            type: "tool_call",
            id: "delegate-call",
            tool: "delegate",
            profile: "explorer" as const,
            mode: "foreground",
            task: "Inspect the workspace.",
          };
        } else {
          yield { type: "text", text: "unexpected child work" };
        }
        completeAttempt(options, usage);
        yield { type: "stop", reason: "stop", usage };
      },
    };
    const sharedCostBudget = createSharedCostBudgetAccount(0.008922);
    const rootBudget = createSharedCostBudgetedProvider({
      provider: rawProvider,
      model: costModel,
      maxCostUsd: 0.008922,
      sharedAccount: sharedCostBudget,
    });
    const artifacts = createArtifactCapture();
    const supervisor = createSubagentSupervisor({
      workspace,
      platform: process.platform,
      parent: {
        kind: "main",
        runId: "shape-sensitive-main",
        childDelegation: "none",
      },
      rootBudget,
      sharedCostBudget,
      profileRegistry: createSubagentProfileRegistry({
        execution: { providerId: "fake", model: "test-model" },
      }),
      resolveExecution: (snapshot) => ({
        snapshot,
        provider: rawProvider,
        costModel,
      }),
      transcriptStore: artifacts.store,
      now: () => 0,
      onProgress: () => {},
    });

    try {
      for await (const _event of rootBudget.provider.stream({
        systemPrompt: "main",
        messages: [{ role: "user", content: "Use a subagent." }],
        signal: new AbortController().signal,
        toolExposure: {
          kind: "auto",
          delegation: {
            mode: "foreground",
            profileCatalog: builtinSubagentProfileCatalog,
          },
        },
      })) {
        // Establish the completed main request used by the continuation lease.
      }

      const result = await supervisor.capability.delegate({
        toolCallId: "delegate-call",
        profile: "explorer" as const,
        mode: "foreground" as const,
        task: "Inspect the workspace.",
        mcp: [],
        focusPaths: [],
        signal: new AbortController().signal,
      });

      expect(result).toEqual({
        delivery: "rejected",
        ok: false,
        reason:
          "Delegation rejected: the available tree budget cannot fund this child while preserving one admitted aggregate parent continuation.",
        recovery:
          "Do not retry with the same session budget. Continue in the current agent, or ask the user to start a new run with a higher --max-cost.",
        maxResultChars: 6_000,
      });
      expect(supervisor.totalAcceptedCount()).toBe(0);
      expect(supervisor.runSnapshots()).toEqual([]);
      expect(rawProviderCalls).toBe(1);
      expect(artifacts.inputs).toEqual([]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a child returns more final text than main may admit,
    When Supervisor stores the canonical transcript and projects the result,
    Then the main-facing payload is bounded while the full final message remains inspectable`, async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-subagent-supervisor-"),
    );
    await writeFile(join(workspace, "module.ts"), "export const value = 1;\n");
    const fixture = supervisorFixture({
      workspace,
      provider: singleFinalProvider("s".repeat(8_000)),
    });

    try {
      const result = await fixture.supervisor.capability.delegate({
        toolCallId: "bounded",
        profile: "explorer" as const,
        mode: "foreground" as const,
        task: "Return a deliberately large result.",
        mcp: [],
        focusPaths: ["module.ts"],
        signal: new AbortController().signal,
      });
      const admitted = z
        .object({
          status: z.literal("completed"),
          finalText: z.string(),
          transcriptRef: z.string().nullable(),
        })
        .passthrough()
        .parse(JSON.parse(deliveredContent(result)));

      expect(result.ok).toBe(true);
      expect(admitted.finalText).toHaveLength(4_000);
      expect(admitted.finalText.endsWith("...")).toBe(true);
      expect(fixture.artifacts.inputs[0]?.content).toContain("s".repeat(7_000));
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
      provider: singleFinalProvider("\0".repeat(8_000)),
    });

    try {
      const result = await fixture.supervisor.capability.delegate({
        toolCallId: "aggregate-bound",
        profile: "explorer" as const,
        mode: "foreground" as const,
        task: "Return JSON-expanding bounded fields.",
        mcp: [],
        focusPaths: ["module.ts"],
        signal: new AbortController().signal,
      });
      const admitted = z
        .object({
          status: z.literal("completed"),
          transcriptRef: z.string().nullable(),
          truncated: z.literal(true),
          finalText: z.string(),
        })
        .passthrough()
        .parse(JSON.parse(deliveredContent(result)));

      expect(result.ok).toBe(true);
      expect(deliveredContent(result).length).toBeLessThanOrEqual(24_000);
      expect(admitted.finalText.length).toBeGreaterThan(800);
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
      let continuationReleases = 0;
      const fixture = supervisorFixture({
        workspace,
        provider,
        onContinuationReleased: () => {
          continuationReleases++;
        },
      });

      try {
        const result = await fixture.supervisor.capability.delegate({
          toolCallId: "failure",
          profile: "explorer" as const,
          mode: "foreground" as const,
          task: "Encounter the provider failure.",
          mcp: [],
          focusPaths: [],
          signal: new AbortController().signal,
        });

        expect(result.ok).toBe(false);
        expect(result.content).toContain(`"status":"${expectedStatus}"`);
        expect(result.content).toContain(providerError.message);
        expect(fixture.artifacts.inputs).toHaveLength(1);
        expect(fixture.supervisor.activeChildRunCount()).toBe(0);
        expect(continuationReleases).toBe(1);
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
        profile: "explorer" as const,
        mode: "foreground" as const,
        task: "Read once before provider failure.",
        mcp: [],
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
        profile: "explorer" as const,
        mode: "foreground" as const,
        task: "Encounter a large provider failure.",
        mcp: [],
        focusPaths: [],
        signal: new AbortController().signal,
      });
      const admitted = z
        .object({
          status: z.literal("failed"),
          transcriptRef: z.string(),
          truncated: z.literal(true),
          error: z.string(),
        })
        .passthrough()
        .parse(JSON.parse(deliveredContent(result)));

      expect(result.ok).toBe(false);
      expect(deliveredContent(result).length).toBeLessThan(4_000);
      expect(admitted.error).toHaveLength(2_000);
      expect(admitted.error.endsWith("...")).toBe(true);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a child uses workspace tools but its final text claims another path,
    When host constructs the handoff and a separate transcript store fails,
    Then the handoff stays tool-agnostic, the transcript preserves the calls, and storage failure cannot complete`, async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-subagent-supervisor-"),
    );
    await writeFile(join(workspace, "module.ts"), "export const value = 1;\n");
    let calls = 0;
    const provenanceFixture = supervisorFixture({
      workspace,
      provider: {
        id: "resource-provenance",
        estimateInputTokens: () => 100,
        async *stream(options) {
          calls++;
          if (calls === 1) {
            yield {
              type: "tool_call",
              id: "workspace-list",
              tool: "ls",
            };
            yield {
              type: "tool_call",
              id: "observed-read",
              tool: "read",
              path: "module.ts",
              offset: 1,
              limit: 1,
            };
          } else {
            yield {
              type: "text",
              text: "module.ts was inspected; ../outside was not inspected.",
            };
          }
          completeAttempt(options, requestUsage);
          yield { type: "stop", reason: "stop", usage: requestUsage };
        },
      },
    });
    const storageFixture = supervisorFixture({
      workspace,
      provider: singleFinalProvider("Storage-dependent result."),
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
      const provenance = await provenanceFixture.supervisor.capability.delegate(
        {
          toolCallId: "resource-provenance",
          profile: "explorer" as const,
          mode: "foreground" as const,
          task: "Report only observed resources.",
          mcp: [],
          focusPaths: ["module.ts"],
          signal: new AbortController().signal,
        },
      );
      const storageFailed = await storageFixture.supervisor.capability.delegate(
        {
          toolCallId: "storage-failed",
          profile: "explorer" as const,
          mode: "foreground" as const,
          task: "Fail transcript storage.",
          mcp: [],
          focusPaths: [],
          signal: new AbortController().signal,
        },
      );

      expect(provenance.ok).toBe(true);
      expect(provenance.content).not.toContain("observedResources");
      expect(provenanceFixture.artifacts.inputs[0]?.content).toContain(
        '"tool":"read","path":"module.ts","offset":1,"limit":1',
      );
      expect(provenanceFixture.artifacts.inputs[0]?.content).toContain(
        '"role":"tool","toolCallId":"observed-read"',
      );
      expect(provenanceFixture.artifacts.inputs[0]?.content).toContain(
        '"tool":"ls"',
      );
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
    { scenario: "empty final message", expected: "failed" },
    { scenario: "provider length", expected: "failed" },
    { scenario: "turn limit", expected: "turn_limited" },
  ])(
    `Given a child reaches $scenario,
    When Supervisor maps the agent stop reason,
    Then main receives the $expected terminal status without fabricated completion`,
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
            yield {
              type: "text",
              text: scenario === "empty final message" ? "   " : "partial",
            };
          }
          completeAttempt(options, requestUsage);
          yield {
            type: "stop",
            reason: scenario === "provider length" ? "length" : "stop",
            usage: requestUsage,
          };
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
      });

      try {
        const result = await fixture.supervisor.capability.delegate({
          toolCallId: `terminal-${scenario}`,
          profile: "explorer" as const,
          mode: "foreground" as const,
          task: "Reach the requested terminal state.",
          mcp: [],
          focusPaths: [],
          signal: new AbortController().signal,
        });

        expect(result.ok).toBe(false);
        expect(result.content).toContain(`"status":"${expected}"`);
        expect(result.content).toContain('"finalText":null');
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    },
  );

  test(`Given the admitted child allocation cannot fund its minimum provider request,
    When the child loop reaches the shared cost guard,
    Then main receives an honest budget_limited handoff without provider work`, async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-subagent-supervisor-"),
    );
    let providerCalls = 0;
    const fixture = supervisorFixture({
      workspace,
      rootMaxCostUsd: 0.00001,
      provider: {
        id: "child-budget-limited",
        estimateInputTokens: () => 100,
        async *stream() {
          providerCalls++;
          yield { type: "text", text: "must not run" };
        },
      },
    });

    try {
      const result = await fixture.supervisor.capability.delegate({
        toolCallId: "child-budget-limited",
        profile: "explorer" as const,
        mode: "foreground" as const,
        task: "Reach the child budget guard.",
        mcp: [],
        focusPaths: [],
        signal: new AbortController().signal,
      });

      expect(result.ok).toBe(false);
      expect(result.content).toContain('"status":"budget_limited"');
      expect(result.content).toContain("Child exhausted its cost budget.");
      expect(providerCalls).toBe(0);
      expect(fixture.supervisor.runSnapshots()).toMatchObject([
        {
          state: "terminal",
          terminal: { status: "budget_limited", error: expect.any(String) },
        },
      ]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

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
      provider: singleFinalProvider("The child finished before storage."),
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
        profile: "explorer" as const,
        mode: "foreground" as const,
        task: "Complete before slow storage settles.",
        mcp: [],
        focusPaths: ["module.ts"],
        signal: new AbortController().signal,
      });

      expect(storageSettled).toBe(true);
      expect(result.ok).toBe(false);
      expect(result.content).toContain('"status":"timed_out"');
      expect(fixture.supervisor.activeChildRunCount()).toBe(0);
      expect(artifacts.inputs).toHaveLength(1);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given discovery-owned hidden paths fail validation after a child Run is accepted,
    When Supervisor resolves the child workspace authority,
    Then provider work never starts and durable lifecycle plus child resources settle`, async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-child-hidden-authority-failure-"),
    );
    let providerCalls = 0;
    let mcpCloseCalls = 0;
    const terminalSnapshots: SubagentTerminalSnapshot[] = [];
    const authorityError =
      'Cannot enforce workflow Skill package "repo:review" because its discovered directory is no longer available.';
    const mcpSnapshot = {
      serverId: "catalog",
      rawToolName: "search",
      serverIncarnation: "server-v1",
      configurationDigest: "a".repeat(64),
      authorizationIdentity: { kind: "anonymous" as const },
    };
    const childMcpRuntime: McpRuntime = {
      prepareTurn: async () => {},
      exposureSnapshot: async () => ({
        snapshotId: "empty",
        catalogAvailable: true,
        tools: [],
      }),
      search: async () => ({ ok: false, content: "unused" }),
      execute: async () => ({
        identity: "unidentified",
        content: "unused",
        ok: false,
      }),
      close: async () => {
        mcpCloseCalls++;
      },
    };
    const profileRegistry = createSubagentProfileRegistry({
      execution: { providerId: "fake", model: "test-model" },
      repoProfiles: [
        {
          name: "repo:remote",
          base: "explorer",
          mcp: [{ server: "catalog", tool: "search" }],
        },
      ],
      mcpRuntime: {
        kind: "enabled",
        resolveTool: () => mcpSnapshot,
        resolveCurrent: async () => [mcpSnapshot],
        createRuntime: () => childMcpRuntime,
      },
    });
    const fixture = supervisorFixture({
      workspace,
      provider: {
        ...singleFinalProvider("must not run"),
        async *stream() {
          providerCalls++;
          yield { type: "text", text: "must not run" };
        },
      },
      profileRegistry,
      additionalHiddenWorkspacePaths: () => {
        throw new Error(authorityError);
      },
      lifecyclePersistence: {
        accepted: () => {
          const transcript = {
            initialize: () => {},
            append: () => {},
            replace: () => {},
          };
          const terminal = (snapshot: SubagentTerminalSnapshot) => {
            terminalSnapshots.push(snapshot);
          };
          return {
            transcriptRef: "agent-transcript:test/authority-failure",
            transcript,
            pendingInput: () => {},
            running: () => ({
              transcriptRef: "agent-transcript:test/authority-failure",
              transcript,
              pendingInput: () => {},
              accounting: () => {},
              terminal,
            }),
            terminal,
          };
        },
        rejected: () => {},
      },
    });

    try {
      const result = await fixture.supervisor.capability.delegate({
        toolCallId: "hidden-authority-failure",
        profile: "repo:remote",
        mode: "foreground",
        task: "Inspect with discovery-owned Skill authority.",
        mcp: [{ server: "catalog", tool: "search" }],
        focusPaths: [],
        signal: new AbortController().signal,
      });

      expect(result).toMatchObject({ delivery: "fresh", ok: false });
      expect(JSON.parse(deliveredContent(result))).toMatchObject({
        error: authorityError,
      });
      expect(providerCalls).toBe(0);
      expect(mcpCloseCalls).toBe(1);
      expect(terminalSnapshots).toEqual([
        expect.objectContaining({
          status: "failed",
          error: authorityError,
        }),
      ]);
      expect(fixture.supervisor.activeChildRunCount()).toBe(0);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a child MCP transport never settles its close promise,
    When the child finishes,
    Then Supervisor bounds cleanup and settles the Run instead of hanging forever`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-child-mcp-close-"));
    const mcpSnapshot = {
      serverId: "catalog",
      rawToolName: "search",
      serverIncarnation: "server-v1",
      configurationDigest: "a".repeat(64),
      authorizationIdentity: { kind: "anonymous" as const },
    };
    const neverClosed = Promise.withResolvers<void>();
    const closeStarted = Promise.withResolvers<void>();
    const childMcpRuntime: McpRuntime = {
      prepareTurn: async () => {},
      exposureSnapshot: async () => ({
        snapshotId: "empty",
        catalogAvailable: true,
        tools: [],
      }),
      search: async () => ({ ok: false, content: "unused" }),
      execute: async () => ({
        identity: "unidentified",
        content: "unused",
        ok: false,
      }),
      close: async () => {
        closeStarted.resolve();
        await neverClosed.promise;
      },
    };
    const profileRegistry = createSubagentProfileRegistry({
      execution: { providerId: "fake", model: "test-model" },
      repoProfiles: [
        {
          name: "repo:remote",
          base: "explorer",
          mcp: [{ server: "catalog", tool: "search" }],
        },
      ],
      mcpRuntime: {
        kind: "enabled",
        resolveTool: () => mcpSnapshot,
        resolveCurrent: async () => [mcpSnapshot],
        createRuntime: () => childMcpRuntime,
      },
    });
    const fixture = supervisorFixture({
      workspace,
      provider: singleFinalProvider("Child work completed."),
      profileRegistry,
      settlementGraceMs: 5,
    });

    try {
      const result = await fixture.supervisor.capability.delegate({
        toolCallId: "mcp-close-hang",
        profile: "repo:remote",
        mode: "foreground",
        task: "Finish without using the remote tool.",
        mcp: [{ server: "catalog", tool: "search" }],
        focusPaths: [],
        signal: new AbortController().signal,
      });

      await closeStarted.promise;
      expect(result.ok).toBe(false);
      expect(result.content).toContain("Child MCP runtime could not close");
      expect(fixture.supervisor.activeChildRunCount()).toBe(0);
    } finally {
      neverClosed.resolve();
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
        profile: "explorer" as const,
        mode: "foreground" as const,
        task: "Settle the already-cancelled child.",
        mcp: [],
        focusPaths: [],
        signal: controller.signal,
      });

      expect(storageSettled).toBe(true);
      expect(result.ok).toBe(false);
      expect(result.content).toContain('"status":"timed_out"');
      expect(fixture.supervisor.activeChildRunCount()).toBe(0);
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
      provider: singleFinalProvider("Child work completed."),
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
        profile: "explorer" as const,
        mode: "foreground" as const,
        task: "Complete before parent cancellation.",
        mcp: [],
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
      expect(fixture.supervisor.activeChildRunCount()).toBe(0);
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
          profile: "explorer" as const,
          mode: "foreground" as const,
          task: "Wait for cancellation.",
          mcp: [],
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
        expect(fixture.supervisor.activeChildRunCount()).toBe(0);
        expect(fixture.artifacts.inputs).toHaveLength(1);
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    },
  );
});
