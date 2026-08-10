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
  type SubagentLifecyclePersistence,
  SubagentPersistenceError,
  type SubagentTerminalSnapshot,
} from "../../src/agent/subagent-lifecycle.ts";
import {
  createSubagentSupervisor,
  type SubagentBackgroundRun,
  type SubagentBackgroundRuntime,
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
        running: () => ({
          transcriptRef: "agent-transcript:test/background",
          transcript,
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
    readonly onContinuationLease?: (
      input: Parameters<SharedCostBudgetedProvider["leaseContinuation"]>[0],
    ) => void;
    readonly onContinuationReleased?: () => void;
    readonly maxActiveAgentRuns?: number;
    readonly maxTotalChildRuns?: number;
    readonly providerBlocked?: () => boolean;
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
  const sharedRootBudget = createSharedCostBudgetedProvider({
    provider,
    model: costModel,
    maxCostUsd: rootMaxCostUsd,
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
                toolExposure: { kind: "auto", delegation: "background" },
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
      parentRunId: "main-run",
      provider: rootBudget.provider,
      providerId: provider.id,
      model: "test-model",
      costModel,
      rootBudget,
      transcriptStore: options.transcriptStore ?? artifacts.store,
      ...lifecycleOwnership,
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
        mode: "background",
        task: "Finish independently of the Main turn.",
        focusPaths: [],
        signal: mainTurn.signal,
      });
      await childEntered.promise;
      await expect(
        fixture.supervisor.capability.delegate({
          toolCallId: "background-turn",
          mode: "background",
          task: "Replay while the background child is still live.",
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
          mode: "background",
          task: "Changed replay text must not create another background run.",
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
            running: () => {
              events.push("running");
              return {
                transcriptRef: "agent-transcript:test/agent-1",
                transcript,
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
        mode: "foreground" as const,
        task: "Return a durable result.",
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
          mode: "foreground" as const,
          task: "Do not continue after durable storage fails.",
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
      mode: "foreground" as const,
      task: `Inspect ${toolCallId}.`,
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
        mode: "foreground" as const,
        task: "Inspect four.",
        focusPaths: [],
        signal,
      });
      const overTotal = await fixture.supervisor.capability.delegate({
        toolCallId: "five",
        mode: "foreground" as const,
        task: "Inspect five.",
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
            running: () => ({
              transcriptRef: "agent-transcript:test/cancelled-before-start",
              transcript,
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
      mode: "foreground" as const,
      task: "Do not start this child.",
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
      mode: "foreground" as const,
      task: "Do not start this child.",
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
      mode: "foreground" as const,
      task: `Wait in ${toolCallId}.`,
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
        mode: "foreground" as const,
        task: "Fail independently.",
        focusPaths: [],
        signal,
      },
      {
        toolCallId: "successful",
        mode: "foreground" as const,
        task: "Complete independently.",
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
        mode: "foreground" as const,
        task: "Do not start this child.",
        focusPaths: [],
        signal: new AbortController().signal,
      });

      expect(result).toEqual({
        delivery: "rejected",
        ok: false,
        reason:
          "Delegation rejected: the configured provider does not certify AbortSignal settlement.",
        recovery:
          "Continue in Main without delegating, or switch to a provider that certifies cancellation settlement.",
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
        mode: "foreground" as const,
        task: "Reject without starting a child.",
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
          mode: "foreground" as const,
          task: "Reject without corrupting the durable ledger.",
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
          mode: "foreground" as const,
          task: "Do not start without durable acceptance.",
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
        mode: "foreground" as const,
        task: "Inspect module.ts.",
        focusPaths: ["module.ts"],
        signal,
      });
      const replayOnly = await fixture.supervisor.capability.delegate({
        toolCallId: "delegate-1",
        mode: "foreground" as const,
        task: "Changed replay text must not create a new run.",
        focusPaths: [],
        signal,
      });
      const replayRequest = {
        toolCallId: "delegate-1",
        mode: "foreground" as const,
        task: "Replay beside one fresh child.",
        focusPaths: [],
        signal,
      };
      const secondRequest = {
        toolCallId: "delegate-2",
        mode: "foreground" as const,
        task: "Inspect it again.",
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
          ["git_diff", "git_status", "glob", "grep", "ls", "read"].toSorted(),
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
      mode: "foreground" as const,
      task: "Return one stable result.",
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
          mode: "foreground" as const,
          task,
          focusPaths,
          signal,
        },
        toolCall: {
          id: `rejected-${index}`,
          tool: "delegate" as const,
          mode: "foreground" as const,
          task,
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
              delegation: "foreground",
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
            mode: "foreground" as const,
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
        mode: "foreground" as const,
        task: "Inspect module.ts.",
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
          mode: "foreground" as const,
          task: "Complete despite observation failure.",
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
          mode: "background",
          task: "Do not detach from this ephemeral owner.",
          focusPaths: [],
          signal: new AbortController().signal,
        },
      );
      const invalidFixture = supervisorFixture({ workspace, provider });
      const invalid = await invalidFixture.supervisor.capability.delegate({
        toolCallId: "invalid-focus",
        mode: "foreground" as const,
        task: "Inspect an invalid path.",
        focusPaths: ["../outside"],
        signal: new AbortController().signal,
      });
      const invalidReplay = await invalidFixture.supervisor.capability.delegate(
        {
          toolCallId: "invalid-focus",
          mode: "foreground" as const,
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
        mode: "foreground" as const,
        task: "Inspect without a child budget.",
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
          mode: "foreground" as const,
          task: "Reject before running with an invalid provider estimate.",
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
          mode: "foreground" as const,
          task: "Do not start after the provider circuit opens.",
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
          "Delegation rejected: the root budget cannot fund this child while preserving one admitted aggregate main continuation.",
        recovery:
          "Do not retry with the same session budget. Continue the investigation in Main, or ask the user to start a new run with a higher --max-cost.",
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
    const rootBudget = createSharedCostBudgetedProvider({
      provider: rawProvider,
      model: costModel,
      maxCostUsd: 0.008922,
    });
    const artifacts = createArtifactCapture();
    const supervisor = createSubagentSupervisor({
      workspace,
      platform: process.platform,
      parentRunId: "shape-sensitive-main",
      provider: rootBudget.provider,
      providerId: rawProvider.id,
      model: "test-model",
      costModel,
      rootBudget,
      transcriptStore: artifacts.store,
      now: () => 0,
      onProgress: () => {},
    });

    try {
      for await (const _event of rootBudget.provider.stream({
        systemPrompt: "main",
        messages: [{ role: "user", content: "Use a subagent." }],
        signal: new AbortController().signal,
        toolExposure: { kind: "auto", delegation: "foreground" },
      })) {
        // Establish the completed main request used by the continuation lease.
      }

      const result = await supervisor.capability.delegate({
        toolCallId: "delegate-call",
        mode: "foreground" as const,
        task: "Inspect the workspace.",
        focusPaths: [],
        signal: new AbortController().signal,
      });

      expect(result).toEqual({
        delivery: "rejected",
        ok: false,
        reason:
          "Delegation rejected: the root budget cannot fund this child while preserving one admitted aggregate main continuation.",
        recovery:
          "Do not retry with the same session budget. Continue the investigation in Main, or ask the user to start a new run with a higher --max-cost.",
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
        mode: "foreground" as const,
        task: "Return a deliberately large result.",
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
        mode: "foreground" as const,
        task: "Return JSON-expanding bounded fields.",
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
          mode: "foreground" as const,
          task: "Encounter the provider failure.",
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
        mode: "foreground" as const,
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
        mode: "foreground" as const,
        task: "Encounter a large provider failure.",
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
          mode: "foreground" as const,
          task: "Report only observed resources.",
          focusPaths: ["module.ts"],
          signal: new AbortController().signal,
        },
      );
      const storageFailed = await storageFixture.supervisor.capability.delegate(
        {
          toolCallId: "storage-failed",
          mode: "foreground" as const,
          task: "Fail transcript storage.",
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
          mode: "foreground" as const,
          task: "Reach the requested terminal state.",
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
        mode: "foreground" as const,
        task: "Reach the child budget guard.",
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
        mode: "foreground" as const,
        task: "Complete before slow storage settles.",
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
        mode: "foreground" as const,
        task: "Settle the already-cancelled child.",
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
        mode: "foreground" as const,
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
          mode: "foreground" as const,
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
        expect(fixture.supervisor.activeChildRunCount()).toBe(0);
        expect(fixture.artifacts.inputs).toHaveLength(1);
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    },
  );
});
