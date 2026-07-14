import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { describe, expect, test } from "vitest";
import type { AgentEvent } from "../../../src/agent/events.ts";
import type { ProviderSelection } from "../../../src/cli/interactive-session/types.ts";
import { runInteractiveSession } from "../../../src/cli/interactive-session.ts";
import {
  createSessionStore,
  persistSessionGoal,
  persistSessionMessages,
  persistSessionQueuedInput,
  resumeSessionStore,
  type SessionQueuedInput,
} from "../../../src/cli/session-store.ts";
import { KeelError } from "../../../src/core/error.ts";
import type { SessionGoal } from "../../../src/core/session-goal.ts";
import type { LLMProvider, Message, Usage } from "../../../src/llm/types.ts";
import {
  EXPENSIVE_USAGE,
  ForcedExit,
  ONE_DOLLAR_PER_MILLION_INPUT,
  resolvedProvider,
  withProviderRequestAttemptAccounting,
  withTimeout,
  ZERO_COST_MODEL,
  ZERO_USAGE,
} from "../../../src/testing/interactive-session-fixtures.ts";

describe("Interactive Session - Reports And Queued Input", () => {
  test(`Given an interactive report already contains a completed turn,
    When user switches models and continues,
    Then the report groups usage and cost by the models that actually ran`, async () => {
    // Given
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    let stdout = "";
    let stderr = "";
    let fakeReportTurns = 0;
    let qwenReportTurns = 0;
    const fakeUsage: Usage = {
      inputTokens: 1_000,
      cachedInputTokens: 0,
      uncachedInputTokens: 1_000,
      outputTokens: 10,
    };
    const qwenUsage: Usage = {
      inputTokens: 2_000,
      cachedInputTokens: 0,
      uncachedInputTokens: 2_000,
      outputTokens: 20,
    };
    const fakeReportProvider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        const attempt = options.providerRequestAttempts?.begin();
        fakeReportTurns++;
        yield { type: "text", text: `fake report ${fakeReportTurns}` };
        attempt?.finish({ outcome: "completed", usage: fakeUsage });
        yield { type: "stop", reason: "stop", usage: fakeUsage };
      },
    };
    const qwenReportProvider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        const attempt = options.providerRequestAttempts?.begin();
        qwenReportTurns++;
        yield { type: "text", text: `qwen report ${qwenReportTurns}` };
        attempt?.finish({ outcome: "completed", usage: qwenUsage });
        yield { type: "stop", reason: "stop", usage: qwenUsage };
      },
    };
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled", reportFile: "report.json" },
      workspace: process.cwd(),
      platform: process.platform,
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
      },
      onSigint: (handler) => {
        sigintHandlers.add(handler);
      },
      offSigint: (handler) => {
        sigintHandlers.delete(handler);
      },
      setExitCode: () => {},
      forceExit: (code) => {
        throw new ForcedExit(code);
      },
      resolveProvider: (_message, selection?: ProviderSelection) => {
        if (selection?.providerId === "qwen") {
          return resolvedProvider(
            "qwen",
            selection.model ?? "qwen3.7-plus",
            qwenReportProvider,
            ONE_DOLLAR_PER_MILLION_INPUT,
          );
        }
        return resolvedProvider(
          "deepseek",
          "deepseek-v4-flash",
          fakeReportProvider,
          ONE_DOLLAR_PER_MILLION_INPUT,
        );
      },
      requireKnownCostModel: (resolved) => {
        if (resolved.costModel === null) {
          throw new Error("unknown target pricing");
        }
        return resolved.costModel;
      },
      printAgentEvents: async (stream) => {
        let finalEnd: Extract<AgentEvent, { readonly type: "end" }> | undefined;
        for await (const event of stream) {
          if (event.type === "text") {
            stdout += event.text;
          } else if (event.type === "end") {
            finalEnd = event;
          }
        }
        return finalEnd;
      },
      formatCostReport: () => "",
    });

    // When
    input.end("first prompt\n/model qwen/qwen3.7-plus\nsecond prompt\n");

    // Then
    const result = await session;
    expect(stderr).toBe("");
    expect(stdout).toContain("fake report 1");
    expect(stdout).toContain("qwen report 1");
    expect(fakeReportTurns).toBe(1);
    expect(qwenReportTurns).toBe(1);
    expect(result.report?.modelsUsed).toEqual([
      { provider: "deepseek", model: "deepseek-v4-flash" },
      { provider: "qwen", model: "qwen3.7-plus" },
    ]);
    expect(result.report?.usageByModel).toEqual([
      {
        provider: "deepseek",
        model: "deepseek-v4-flash",
        agentLoopTurns: 1,
        usage: fakeUsage,
        costUsd: 0.001,
      },
      {
        provider: "qwen",
        model: "qwen3.7-plus",
        agentLoopTurns: 1,
        usage: qwenUsage,
        costUsd: 0.002,
      },
    ]);
    expect(result.report?.end.turns).toBe(2);
    expect(result.report?.end.usage).toEqual({
      inputTokens: 3_000,
      cachedInputTokens: 0,
      uncachedInputTokens: 3_000,
      outputTokens: 30,
    });
    expect(result.report?.end.cost.spentUsd).toBeCloseTo(0.003);
    expect(sigintHandlers.size).toBe(0);
  });

  test(`Given an interactive turn has cost tracking,
    When the turn completes,
    Then the session prints the cost report`, async () => {
    // Given
    const provider: LLMProvider = {
      id: "fake",
      async *stream() {
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    let stderr = "";
    let resolvedProviders = 0;
    const session = runInteractiveSession({
      cliArgs: { bashMode: "trusted", maxCostUsd: 1 },
      workspace: process.cwd(),
      platform: process.platform,
      input,
      writeStdout: () => {},
      writeStderr: (text) => {
        stderr += text;
      },
      onSigint: (handler) => {
        sigintHandlers.add(handler);
      },
      offSigint: (handler) => {
        sigintHandlers.delete(handler);
      },
      setExitCode: () => {},
      forceExit: (code) => {
        throw new ForcedExit(code);
      },
      resolveProvider: () => {
        resolvedProviders++;
        return {
          provider,
          providerId: "fake",
          model: "fake",
          costModel: ZERO_COST_MODEL,
        };
      },
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async (stream) => {
        let finalEnd: Extract<AgentEvent, { readonly type: "end" }> | undefined;
        for await (const event of stream) {
          if (event.type === "end") {
            finalEnd = event;
          }
        }
        return finalEnd;
      },
      formatCostReport: () => "Cost: $0\n",
    });

    // When
    input.write("\nhello\n");
    input.end();

    // Then
    await session;
    expect(stderr).toBe("Cost: $0\n");
    expect(resolvedProviders).toBe(1);
    expect(sigintHandlers.size).toBe(0);
  });

  test(`Given an interactive session cost limit is exhausted,
    When more prompt input is already queued,
    Then the session stops before starting another model turn`, async () => {
    // Given
    let providerCalls = 0;
    const provider: LLMProvider = {
      id: "fake",
      async *stream() {
        providerCalls++;
        yield { type: "text", text: "expensive answer" };
        yield { type: "stop", reason: "stop", usage: EXPENSIVE_USAGE };
      },
    };
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    let stderr = "";
    const session = runInteractiveSession({
      cliArgs: { bashMode: "trusted", maxCostUsd: 1 },
      workspace: process.cwd(),
      platform: process.platform,
      input,
      writeStdout: () => {},
      writeStderr: (text) => {
        stderr += text;
      },
      onSigint: (handler) => {
        sigintHandlers.add(handler);
      },
      offSigint: (handler) => {
        sigintHandlers.delete(handler);
      },
      setExitCode: () => {},
      forceExit: (code) => {
        throw new ForcedExit(code);
      },
      resolveProvider: () => ({
        provider,
        providerId: "fake",
        model: "fake",
        costModel: ONE_DOLLAR_PER_MILLION_INPUT,
      }),
      requireKnownCostModel: () => ONE_DOLLAR_PER_MILLION_INPUT,
      printAgentEvents: async (stream) => {
        let finalEnd: Extract<AgentEvent, { readonly type: "end" }> | undefined;
        for await (const event of stream) {
          if (event.type === "end") {
            finalEnd = event;
          }
        }
        return finalEnd;
      },
      formatCostReport: (cost) =>
        `Cost: ${cost.spentUsd.toFixed(2)} exceeded=${String(
          cost.budgetLimited,
        )}\n`,
    });

    // When
    input.end("first prompt\nsecond prompt\n");

    // Then
    await session;
    expect(providerCalls).toBe(1);
    expect(stderr).toBe("Cost: 2.00 exceeded=true\n");
    expect(sigintHandlers.size).toBe(0);
  });

  test(`Given automatic goal continuations emit different prose without tools,
    When the hard continuation turn cap is reached,
    Then Keel does not send a stagnation recovery hint`, async () => {
    // Given
    const initialGoal: SessionGoal = {
      objective: "Finish the continuation goal",
      status: "active",
      budget: {},
      usage: { turns: 0, tokens: 0, activeTimeMs: 0 },
      criterionKind: "assertion",
      completionCriterion: "The final report exists.",
    };
    const observedUserContexts: string[][] = [];
    let persistedMessages: readonly Message[] = [];
    const persistedGoals: SessionGoal[] = [];
    let providerCalls = 0;
    const provider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        providerCalls++;
        observedUserContexts.push(
          options.messages
            .filter((message) => message.role === "user")
            .map((message) => message.content),
        );
        yield {
          type: "text",
          text:
            providerCalls === 1
              ? "Initial turn left the goal active."
              : `No progress continuation ${providerCalls - 1}.`,
        };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const input = new PassThrough();
    let stdout = "";
    let stderr = "";
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
      platform: process.platform,
      initialSessionGoal: initialGoal,
      goalAutomaticContinuationTurnLimit: 2,
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
      },
      onSigint: () => {},
      offSigint: () => {},
      setExitCode: () => {},
      forceExit: (code) => {
        throw new ForcedExit(code);
      },
      resolveProvider: () => ({
        provider,
        providerId: "fake",
        model: "fake",
        costModel: ZERO_COST_MODEL,
      }),
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async (stream) => {
        let finalEnd: Extract<AgentEvent, { readonly type: "end" }> | undefined;
        for await (const event of stream) {
          if (event.type === "text") {
            stdout += event.text;
          } else if (event.type === "end") {
            finalEnd = event;
          }
        }
        return finalEnd;
      },
      formatCostReport: () => "",
      persistSessionMessages: (messages) => {
        persistedMessages = [...messages];
      },
      persistSessionGoal: (update) => {
        if (update.goal !== null) {
          persistedGoals.push(update.goal);
          return update.goal;
        }
        return undefined;
      },
    });
    input.end("start the goal\n");

    // When
    await withTimeout(session, 5000, "goal continuation did not hit turn cap");

    // Then
    expect(providerCalls).toBe(3);
    expect(stdout).toBe(
      [
        "Initial turn left the goal active.",
        "No progress continuation 1.",
        "No progress continuation 2.",
        "",
      ].join("\n"),
    );
    expect(stderr).toBe(
      "Session goal: usage_limited - Finish the continuation goal; criterion(assertion): The final report exists.; reason: Automatic goal continuation stopped after 2 continuation turns without completing the active goal.\n",
    );
    expect(observedUserContexts[1]?.at(-1)).toContain(
      "Keel runtime goal continuation",
    );
    expect(observedUserContexts[2]?.at(-1)).toContain(
      "Keel runtime goal continuation",
    );
    expect(
      persistedMessages.filter(
        (message) =>
          message.role === "user" &&
          message.content.includes('source="goal_stagnation_recovery"'),
      ),
    ).toHaveLength(0);
    expect(persistedGoals.at(-1)).toEqual({
      objective: "Finish the continuation goal",
      status: "usage_limited",
      budget: {},
      usage: { turns: 3, tokens: 0, activeTimeMs: expect.any(Number) },
      statusReason:
        "Automatic goal continuation stopped after 2 continuation turns without completing the active goal.",
      latestRuntimeOutcome: {
        kind: "limit_reached",
        reason:
          "Automatic goal continuation stopped after 2 continuation turns without completing the active goal.",
      },
      criterionKind: "assertion",
      completionCriterion: "The final report exists.",
    });
  });

  test(`Given automatic goal continuations repeat identical prose without tools,
    When the same response is observed three consecutive times,
    Then Keel sends one recovery hint without stopping the goal`, async () => {
    // Given
    const initialGoal: SessionGoal = {
      objective: "Finish the prose-only continuation goal",
      status: "active",
      budget: {},
      usage: { turns: 0, tokens: 0, activeTimeMs: 0 },
      criterionKind: "assertion",
      completionCriterion: "The final report exists.",
    };
    let persistedMessages: readonly Message[] = [];
    const automaticContinuationTurnLimit = 4;
    let providerCalls = 0;
    const provider: LLMProvider = {
      id: "fake",
      async *stream() {
        providerCalls++;
        yield {
          type: "text",
          text:
            providerCalls === 1
              ? "Initial turn left the goal active."
              : "The work is done.",
        };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const input = new PassThrough();
    let stderr = "";
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
      platform: process.platform,
      initialSessionGoal: initialGoal,
      goalAutomaticContinuationTurnLimit: automaticContinuationTurnLimit,
      input,
      writeStdout: () => {},
      writeStderr: (text) => {
        stderr += text;
      },
      onSigint: () => {},
      offSigint: () => {},
      setExitCode: () => {},
      forceExit: (code) => {
        throw new ForcedExit(code);
      },
      resolveProvider: () => ({
        provider,
        providerId: "fake",
        model: "fake",
        costModel: ZERO_COST_MODEL,
      }),
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async (stream) => {
        let finalEnd: Extract<AgentEvent, { readonly type: "end" }> | undefined;
        for await (const event of stream) {
          if (event.type === "end") {
            finalEnd = event;
          }
        }
        return finalEnd;
      },
      formatCostReport: () => "",
      persistSessionMessages: (messages) => {
        persistedMessages = [...messages];
      },
    });
    input.end("start the goal\n");

    // When
    await withTimeout(session, 5000, "goal continuation did not hit turn cap");

    // Then
    expect(providerCalls).toBe(1 + automaticContinuationTurnLimit);
    expect(
      persistedMessages.filter(
        (message) =>
          message.role === "user" &&
          message.content.includes('source="goal_stagnation_recovery"'),
      ),
    ).toHaveLength(1);
    expect(stderr).toContain(
      `Automatic goal continuation stopped after ${automaticContinuationTurnLimit} continuation turns without completing the active goal.`,
    );
  });

  test(`Given a saved goal receives a stagnation recovery hint,
    When the user pauses, resumes the session, and runs /goal,
    Then Keel shows the durable latest runtime outcome`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-goal-outcome-"));
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    try {
      let clock = 0;
      const runtime = {
        env: (key: string) => (key === "KEEL_HOME" ? home : undefined),
        now: () => ++clock,
      };
      const storedSession = createSessionStore({
        sessionId: "durable-goal-outcome",
        workspace,
        runtime,
      });
      const initialGoal: SessionGoal = {
        objective: "Recover from repeated prose",
        status: "active",
        budget: {},
        usage: { turns: 0, tokens: 0, activeTimeMs: 0 },
        criterionKind: "assertion",
        completionCriterion: "The final report exists.",
      };
      const persistedInitialGoal = persistSessionGoal({
        session: storedSession,
        goal: initialGoal,
        runtime,
      });
      let persistedMessages: readonly Message[] = storedSession.messages;
      const firstInput = new PassThrough();
      let providerCalls = 0;
      const provider: LLMProvider = {
        id: "fake",
        async *stream(options) {
          providerCalls++;
          if (
            options.messages.some(
              (message) =>
                message.role === "user" &&
                message.content.includes('source="goal_stagnation_recovery"'),
            )
          ) {
            firstInput.end("/goal pause\n");
            await setImmediate();
          }
          yield {
            type: "text",
            text:
              providerCalls === 1
                ? "The initial turn left the goal active."
                : "The work is done.",
          };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
        },
      };
      const firstRun = runInteractiveSession({
        cliArgs: { bashMode: "disabled" },
        workspace,
        platform: process.platform,
        ...(persistedInitialGoal !== undefined
          ? { initialSessionGoal: persistedInitialGoal }
          : {}),
        input: firstInput,
        writeStdout: () => {},
        writeStderr: () => {},
        onSigint: () => {},
        offSigint: () => {},
        setExitCode: () => {},
        forceExit: (code) => {
          throw new ForcedExit(code);
        },
        resolveProvider: () => ({
          provider,
          providerId: "fake",
          model: "fake",
          costModel: ZERO_COST_MODEL,
        }),
        requireKnownCostModel: () => ZERO_COST_MODEL,
        printAgentEvents: async (stream) => {
          let finalEnd:
            | Extract<AgentEvent, { readonly type: "end" }>
            | undefined;
          for await (const event of stream) {
            if (event.type === "end") {
              finalEnd = event;
            }
          }
          return finalEnd;
        },
        formatCostReport: () => "",
        persistSessionMessages: (messages, reason, consumedInputIds) => {
          persistedMessages = persistSessionMessages({
            session: storedSession,
            previousMessages: persistedMessages,
            currentMessages: messages,
            runtime,
            reason,
            consumedInputIds,
          });
        },
        persistSessionGoal: ({ goal, consumedInputIds }) =>
          persistSessionGoal({
            session: storedSession,
            goal,
            runtime,
            consumedInputIds,
          }),
      });
      firstInput.write("start the goal\n");
      await withTimeout(firstRun, 5000, "goal recovery did not pause");

      const resumed = resumeSessionStore({
        sessionId: "durable-goal-outcome",
        workspace,
        runtime,
      });
      const secondInput = new PassThrough();
      let resumedStdout = "";
      let resumedProviderCalls = 0;
      const secondRun = runInteractiveSession({
        cliArgs: { bashMode: "disabled" },
        workspace,
        platform: process.platform,
        ...(resumed.goal !== undefined
          ? { initialSessionGoal: resumed.goal }
          : {}),
        input: secondInput,
        writeStdout: (text) => {
          resumedStdout += text;
        },
        writeStderr: () => {},
        onSigint: () => {},
        offSigint: () => {},
        setExitCode: () => {},
        forceExit: (code) => {
          throw new ForcedExit(code);
        },
        resolveProvider: () => ({
          provider: {
            id: "fake",
            async *stream() {
              resumedProviderCalls++;
              yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
            },
          },
          providerId: "fake",
          model: "fake",
          costModel: ZERO_COST_MODEL,
        }),
        requireKnownCostModel: () => ZERO_COST_MODEL,
        printAgentEvents: async () => undefined,
        formatCostReport: () => "",
      });

      // When
      secondInput.end("/goal\n");
      await secondRun;

      // Then
      expect(providerCalls).toBe(5);
      expect(resumedProviderCalls).toBe(0);
      expect(resumed.goal).toMatchObject({
        status: "paused",
        latestRuntimeOutcome: {
          kind: "recovery_requested",
          reason:
            "Repeated automatic goal continuations showed the same response or tool-use pattern without an observed workspace, task, or goal state change.",
        },
      });
      expect(resumedStdout).toContain(
        "Session goal outcome: recovery requested - Repeated automatic goal continuations showed the same response or tool-use pattern without an observed workspace, task, or goal state change.",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given an active goal has an older recovery outcome,
    When a later goal turn changes durable task progress,
    Then the progress fact replaces the older outcome`, async () => {
    // Given
    const input = new PassThrough();
    const persistedGoals: SessionGoal[] = [];
    let providerCalls = 0;
    const provider: LLMProvider = {
      id: "fake",
      async *stream() {
        providerCalls++;
        if (providerCalls === 1) {
          yield {
            type: "tool_call",
            id: "record_progress",
            tool: "update_plan",
            plan: [{ step: "Write the final report", status: "in_progress" }],
          };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        input.end("/goal pause\n");
        await setImmediate();
        yield { type: "text", text: "Progress recorded." };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
      platform: process.platform,
      initialSessionGoal: {
        objective: "Replace stale recovery metadata",
        status: "active",
        budget: {},
        usage: { turns: 0, tokens: 0, activeTimeMs: 0 },
        criterionKind: "assertion",
        completionCriterion: "The final report exists.",
        latestRuntimeOutcome: {
          kind: "recovery_requested",
          reason: "An earlier continuation repeated.",
        },
      },
      input,
      writeStdout: () => {},
      writeStderr: () => {},
      onSigint: () => {},
      offSigint: () => {},
      setExitCode: () => {},
      forceExit: (code) => {
        throw new ForcedExit(code);
      },
      resolveProvider: () => ({
        provider,
        providerId: "fake",
        model: "fake",
        costModel: ZERO_COST_MODEL,
      }),
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async (stream) => {
        let finalEnd: Extract<AgentEvent, { readonly type: "end" }> | undefined;
        for await (const event of stream) {
          if (event.type === "end") {
            finalEnd = event;
          }
        }
        return finalEnd;
      },
      formatCostReport: () => "",
      persistSessionGoal: ({ goal }) => {
        if (goal !== null) {
          persistedGoals.push(goal);
          return goal;
        }
        return undefined;
      },
    });
    input.write("continue the goal\n");

    // When
    await withTimeout(session, 5000, "progress outcome was not persisted");

    // Then
    expect(providerCalls).toBe(2);
    expect(persistedGoals.at(-1)).toMatchObject({
      status: "paused",
      latestRuntimeOutcome: {
        kind: "progress_observed",
        reason: "The latest goal turn changed task progress.",
      },
    });
  });

  test.each([
    {
      name: "a workspace mutation",
      kind: "workspace" as const,
      bashMode: "disabled" as const,
      criterionKind: "assertion" as const,
      completionCriterion: "The final report exists.",
      expectedReason: "The latest goal turn changed the workspace.",
    },
    {
      name: "an exact successful completion command",
      kind: "verification" as const,
      bashMode: "trusted" as const,
      criterionKind: "command" as const,
      completionCriterion: 'node -e "process.exit(0)"',
      expectedReason:
        'Completion command "node -e \\"process.exit(0)\\"" exited 0 after the latest workspace mutation.',
    },
  ])(`Given an active goal has an older recovery outcome,
    When a later goal turn produces $name,
    Then the observed fact replaces the older outcome`, async ({
    kind,
    bashMode,
    criterionKind,
    completionCriterion,
    expectedReason,
  }) => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-goal-observation-"));
    try {
      const input = new PassThrough();
      let persistedGoal: SessionGoal | undefined = {
        objective: "Replace stale recovery with an observed fact",
        status: "active",
        budget: {},
        usage: { turns: 0, tokens: 0, activeTimeMs: 0 },
        criterionKind,
        completionCriterion,
        latestRuntimeOutcome: {
          kind: "recovery_requested",
          reason: "An earlier continuation repeated.",
        },
      };
      let providerCalls = 0;
      const provider: LLMProvider = {
        id: "fake",
        async *stream() {
          providerCalls++;
          if (providerCalls === 1) {
            if (kind === "workspace") {
              yield {
                type: "tool_call",
                id: "write_observed_progress",
                tool: "write",
                path: "report.txt",
                content: "done\n",
              };
            } else {
              yield {
                type: "tool_call",
                id: "verify_observed_progress",
                tool: "bash",
                command: completionCriterion,
              };
            }
            yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
            return;
          }
          input.end("/goal pause\n");
          await setImmediate();
          yield { type: "text", text: "Observed fact recorded." };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
        },
      };
      const session = runInteractiveSession({
        cliArgs: { bashMode },
        workspace,
        platform: process.platform,
        initialSessionGoal: persistedGoal,
        input,
        writeStdout: () => {},
        writeStderr: () => {},
        onSigint: () => {},
        offSigint: () => {},
        setExitCode: () => {},
        forceExit: (code) => {
          throw new ForcedExit(code);
        },
        resolveProvider: () => ({
          provider,
          providerId: "fake",
          model: "fake",
          costModel: ZERO_COST_MODEL,
        }),
        requireKnownCostModel: () => ZERO_COST_MODEL,
        printAgentEvents: async (stream) => {
          let finalEnd:
            | Extract<AgentEvent, { readonly type: "end" }>
            | undefined;
          for await (const event of stream) {
            if (event.type === "end") {
              finalEnd = event;
            }
          }
          return finalEnd;
        },
        formatCostReport: () => "",
        persistSessionGoal: ({ goal }) => {
          persistedGoal = goal ?? undefined;
          return persistedGoal;
        },
      });
      input.write("continue the goal\n");

      // When
      await withTimeout(session, 5000, "observed outcome was not persisted");

      // Then
      expect(providerCalls).toBe(2);
      expect(persistedGoal).toMatchObject({
        status: "paused",
        latestRuntimeOutcome: {
          kind: "progress_observed",
          reason: expectedReason,
        },
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given repeated completion rejections only update runtime outcome metadata,
    When automatic continuations repeat the same failed proposal three times,
    Then the metadata does not masquerade as progress and suppress recovery`, async () => {
    // Given
    const input = new PassThrough();
    let persistedMessages: readonly Message[] = [];
    let persistedGoal: SessionGoal | undefined = {
      objective: "Verify before completing",
      status: "active",
      budget: {},
      usage: { turns: 0, tokens: 0, activeTimeMs: 0 },
      criterionKind: "command",
      completionCriterion: "pnpm test",
    };
    let providerCalls = 0;
    const provider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        providerCalls++;
        if (
          options.messages.some(
            (message) =>
              message.role === "user" &&
              message.content.includes('source="goal_stagnation_recovery"'),
          )
        ) {
          input.end("/goal pause\n");
          await setImmediate();
          yield { type: "text", text: "I will change strategy." };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        if ([2, 4, 6].includes(providerCalls)) {
          yield {
            type: "tool_call",
            id: `rejected_completion_${providerCalls}`,
            tool: "update_goal",
            status: "completed",
          };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        yield {
          type: "text",
          text:
            providerCalls === 1
              ? "The initial turn left the goal active."
              : "Completion was proposed.",
        };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
      platform: process.platform,
      initialSessionGoal: persistedGoal,
      input,
      writeStdout: () => {},
      writeStderr: () => {},
      onSigint: () => {},
      offSigint: () => {},
      setExitCode: () => {},
      forceExit: (code) => {
        throw new ForcedExit(code);
      },
      resolveProvider: () => ({
        provider,
        providerId: "fake",
        model: "fake",
        costModel: ZERO_COST_MODEL,
      }),
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async (stream) => {
        let finalEnd: Extract<AgentEvent, { readonly type: "end" }> | undefined;
        for await (const event of stream) {
          if (event.type === "end") {
            finalEnd = event;
          }
        }
        return finalEnd;
      },
      formatCostReport: () => "",
      persistSessionMessages: (messages) => {
        persistedMessages = [...messages];
      },
      persistSessionGoal: ({ goal }) => {
        persistedGoal = goal ?? undefined;
        return persistedGoal;
      },
    });
    input.write("start the goal\n");

    // When
    await withTimeout(session, 5000, "completion rejection did not recover");

    // Then
    expect(providerCalls).toBe(8);
    expect(
      persistedMessages.filter(
        (message) =>
          message.role === "user" &&
          message.content.includes('source="goal_stagnation_recovery"'),
      ),
    ).toHaveLength(1);
    expect(persistedGoal).toMatchObject({
      status: "paused",
      latestRuntimeOutcome: {
        kind: "recovery_requested",
      },
    });
  });

  test.each([
    {
      name: "the same read result",
      recoveryReadPath: "package.json",
      injectSteering: false,
      expectedOutcome: {
        kind: "recovery_requested",
        reason:
          "Repeated automatic goal continuations showed the same response or tool-use pattern without an observed workspace, task, or goal state change.",
      },
    },
    {
      name: "a different read result",
      recoveryReadPath: "tsconfig.json",
      injectSteering: false,
      expectedOutcome: {
        kind: "progress_observed",
        reason: "The latest goal turn produced new tool-result evidence.",
      },
    },
    {
      name: "a different read result after injected user steering",
      recoveryReadPath: "tsconfig.json",
      injectSteering: true,
      expectedOutcome: {
        kind: "progress_observed",
        reason: "The latest goal turn produced new tool-result evidence.",
      },
    },
  ])(`Given repeated reads produced an older recovery outcome,
    When the recovery turn produces $name,
    Then only fresh tool evidence replaces the recovery outcome`, async ({
    recoveryReadPath,
    injectSteering,
    expectedOutcome,
  }) => {
    // Given
    const input = new PassThrough();
    let persistedGoal: SessionGoal | undefined = {
      objective: "Observe evidence after recovery",
      status: "active",
      budget: {},
      usage: { turns: 0, tokens: 0, activeTimeMs: 0 },
      criterionKind: "assertion",
      completionCriterion: "The user confirms the evidence is sufficient.",
    };
    let providerCalls = 0;
    const provider: LLMProvider = {
      id: "fake",
      async *stream() {
        providerCalls++;
        if ([2, 4, 6].includes(providerCalls)) {
          yield {
            type: "tool_call",
            id: `repeated_evidence_${providerCalls}`,
            tool: "read",
            path: "package.json",
          };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        if (providerCalls === 8) {
          if (injectSteering) {
            input.write("Use the newly observed evidence.\n");
            await setImmediate();
          }
          yield {
            type: "tool_call",
            id: "evidence_after_recovery",
            tool: "read",
            path: recoveryReadPath,
          };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        if (providerCalls === 9) {
          input.end("/goal pause\n");
          await setImmediate();
        }
        yield {
          type: "text",
          text:
            providerCalls === 1
              ? "The initial turn left the goal active."
              : "Evidence observed.",
        };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
      platform: process.platform,
      initialSessionGoal: persistedGoal,
      input,
      writeStdout: () => {},
      writeStderr: () => {},
      onSigint: () => {},
      offSigint: () => {},
      setExitCode: () => {},
      forceExit: (code) => {
        throw new ForcedExit(code);
      },
      resolveProvider: () => ({
        provider,
        providerId: "fake",
        model: "fake",
        costModel: ZERO_COST_MODEL,
      }),
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async (stream) => {
        let finalEnd: Extract<AgentEvent, { readonly type: "end" }> | undefined;
        for await (const event of stream) {
          if (event.type === "end") {
            finalEnd = event;
          }
        }
        return finalEnd;
      },
      formatCostReport: () => "",
      persistSessionGoal: ({ goal }) => {
        persistedGoal = goal ?? undefined;
        return persistedGoal;
      },
    });
    input.write("start the goal\n");

    // When
    await withTimeout(session, 5000, "post-recovery evidence did not finish");

    // Then
    expect(providerCalls).toBe(9);
    expect(persistedGoal).toMatchObject({
      status: "paused",
      latestRuntimeOutcome: expectedOutcome,
    });
  });

  test(`Given automatic goal continuations restore changing read evidence after compaction,
    When the assistant repeats the same prose without ordinary tool executions,
    Then Keel does not send a prose stagnation recovery hint`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-goal-compaction-"));
    try {
      const statusPath = join(workspace, "status.txt");
      await writeFile(statusPath, "initial evidence\n", "utf8");
      const initialGoal: SessionGoal = {
        objective: "Track changing evidence through compaction",
        status: "active",
        budget: {},
        usage: { turns: 0, tokens: 0, activeTimeMs: 0 },
        criterionKind: "assertion",
        completionCriterion: "The external status is complete.",
      };
      let persistedMessages: readonly Message[] = [];
      const restoredEvidence: string[] = [];
      const automaticContinuationTurnLimit = 4;
      let mainRequests = 0;
      let summaryRequests = 0;
      let compactionEvents = 0;
      const provider: LLMProvider = {
        id: "fake",
        async *stream(options) {
          if (options.toolChoice === "none") {
            summaryRequests++;
            yield {
              type: "text",
              text: `Compaction summary ${summaryRequests}.`,
            };
            yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
            return;
          }
          mainRequests++;
          if (mainRequests === 1) {
            yield {
              type: "tool_call",
              id: "read_status_before_compaction",
              tool: "read",
              path: "status.txt",
            };
            yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
            return;
          }
          if (mainRequests >= 3 && mainRequests % 2 === 1) {
            await writeFile(
              statusPath,
              `restored evidence ${mainRequests}\n`,
              "utf8",
            );
            throw new KeelError(
              "provider_context_overflow",
              "Force post-compaction read restoration",
            );
          }
          if (mainRequests >= 4) {
            const restoredRead = options.messages.findLast(
              (message) =>
                message.role === "tool" &&
                message.toolCallId.startsWith("post_compaction_read_"),
            );
            if (restoredRead?.role === "tool") {
              restoredEvidence.push(restoredRead.content);
            }
          }
          yield { type: "text", text: "Still working." };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
        },
      };
      const input = new PassThrough();
      let stderr = "";
      const session = runInteractiveSession({
        cliArgs: { bashMode: "disabled" },
        workspace,
        platform: process.platform,
        initialSessionGoal: initialGoal,
        goalAutomaticContinuationTurnLimit: automaticContinuationTurnLimit,
        input,
        writeStdout: () => {},
        writeStderr: (text) => {
          stderr += text;
        },
        onSigint: () => {},
        offSigint: () => {},
        setExitCode: () => {},
        forceExit: (code) => {
          throw new ForcedExit(code);
        },
        resolveProvider: () => ({
          provider,
          providerId: "fake",
          model: "fake",
          costModel: ZERO_COST_MODEL,
          contextCompaction: {
            keepRecentTokens: 1,
            summaryInputMaxChars: 4_000,
          },
        }),
        requireKnownCostModel: () => ZERO_COST_MODEL,
        printAgentEvents: async (stream) => {
          let finalEnd:
            | Extract<AgentEvent, { readonly type: "end" }>
            | undefined;
          for await (const event of stream) {
            if (event.type === "context_compacted") {
              compactionEvents++;
            } else if (event.type === "end") {
              finalEnd = event;
            }
          }
          return finalEnd;
        },
        formatCostReport: () => "",
        persistSessionMessages: (messages) => {
          persistedMessages = [...messages];
        },
      });
      input.end("start the goal\n");

      // When
      await withTimeout(session, 5000, "compacted goal did not hit turn cap");

      // Then
      expect(mainRequests).toBe(2 + automaticContinuationTurnLimit * 2);
      expect(summaryRequests).toBe(automaticContinuationTurnLimit);
      expect(compactionEvents).toBe(automaticContinuationTurnLimit);
      expect(restoredEvidence).toHaveLength(automaticContinuationTurnLimit);
      expect(new Set(restoredEvidence)).toHaveLength(
        automaticContinuationTurnLimit,
      );
      expect(
        persistedMessages.filter(
          (message) =>
            message.role === "user" &&
            message.content.includes('source="goal_stagnation_recovery"'),
        ),
      ).toHaveLength(0);
      expect(stderr).toContain(
        `Automatic goal continuation stopped after ${automaticContinuationTurnLimit} continuation turns without completing the active goal.`,
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given automatic goal continuation reaches the cost budget,
    When no user input is queued,
    Then the session stops with a budget-limited goal`, async () => {
    // Given
    const initialGoal: SessionGoal = {
      objective: "Finish the budget-limited continuation goal",
      status: "active",
      budget: {},
      usage: { turns: 0, tokens: 0, activeTimeMs: 0 },
    };
    const persistedGoals: SessionGoal[] = [];
    let providerCalls = 0;
    const provider: LLMProvider = {
      id: "fake",
      async *stream() {
        providerCalls++;
        yield {
          type: "text",
          text:
            providerCalls === 1
              ? "Initial turn left the goal active."
              : "Continuation exhausted budget.",
        };
        yield {
          type: "stop",
          reason: "stop",
          usage: providerCalls === 1 ? ZERO_USAGE : EXPENSIVE_USAGE,
        };
      },
    };
    const input = new PassThrough();
    let stderr = "";
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled", maxCostUsd: 1 },
      workspace: process.cwd(),
      platform: process.platform,
      initialSessionGoal: initialGoal,
      input,
      writeStdout: () => {},
      writeStderr: (text) => {
        stderr += text;
      },
      onSigint: () => {},
      offSigint: () => {},
      setExitCode: () => {},
      forceExit: (code) => {
        throw new ForcedExit(code);
      },
      resolveProvider: () => ({
        provider,
        providerId: "fake",
        model: "fake",
        costModel: ONE_DOLLAR_PER_MILLION_INPUT,
      }),
      requireKnownCostModel: () => ONE_DOLLAR_PER_MILLION_INPUT,
      printAgentEvents: async (stream) => {
        let finalEnd: Extract<AgentEvent, { readonly type: "end" }> | undefined;
        for await (const event of stream) {
          if (event.type === "end") {
            finalEnd = event;
          }
        }
        return finalEnd;
      },
      formatCostReport: () => "",
      persistSessionGoal: (update) => {
        if (update.goal !== null) {
          persistedGoals.push(update.goal);
          return update.goal;
        }
        return undefined;
      },
    });
    input.end("start the goal\n");

    // When
    await session;

    // Then
    expect(providerCalls).toBe(2);
    expect(stderr).toBe(
      "Session goal: budget_limited - Finish the budget-limited continuation goal; criterion: missing; reason: Session cost budget could not admit another provider request before the active goal completed.\n",
    );
    expect(persistedGoals.at(-1)).toEqual({
      objective: "Finish the budget-limited continuation goal",
      status: "budget_limited",
      budget: {},
      usage: {
        turns: 2,
        tokens: 2_000_000,
        activeTimeMs: expect.any(Number),
      },
      statusReason:
        "Session cost budget could not admit another provider request before the active goal completed.",
      latestRuntimeOutcome: {
        kind: "limit_reached",
        reason:
          "Session cost budget could not admit another provider request before the active goal completed.",
      },
    });
  });

  test(`Given an assertion completion leaves too little cost budget for its evaluator,
    When the evaluator request is rejected before provider spend,
    Then the interactive owner durably limits the active goal instead of crashing`, async () => {
    // Given
    const initialGoal: SessionGoal = {
      objective: "Finish the assertion within budget",
      status: "active",
      budget: {},
      usage: { turns: 0, tokens: 0, activeTimeMs: 0 },
      criterionKind: "assertion",
      completionCriterion: "The assertion is demonstrably satisfied.",
    };
    const persistedGoals: SessionGoal[] = [];
    let persistedMessages: readonly Message[] = [];
    let providerCalls = 0;
    const provider: LLMProvider = {
      id: "interactive-unaffordable-assertion-evaluator",
      estimateInputTokens: () => 1,
      async *stream(options) {
        const attempt = options.providerRequestAttempts?.begin();
        providerCalls++;
        yield {
          type: "tool_call",
          id: "complete_goal",
          tool: "update_goal",
          status: "completed",
        };
        const usage = {
          inputTokens: 499_800,
          cachedInputTokens: 0,
          uncachedInputTokens: 499_800,
          outputTokens: 0,
        };
        attempt?.finish({ outcome: "completed", usage });
        yield {
          type: "stop",
          reason: "stop",
          usage,
        };
      },
    };
    const costModel = {
      type: "fixed",
      uncachedInputPerMillionTokens: 1,
      cachedInputPerMillionTokens: 0.5,
      outputPerMillionTokens: 2,
    } as const;
    const input = new PassThrough();
    let stderr = "";
    const session = runInteractiveSession({
      cliArgs: {
        bashMode: "disabled",
        maxCostUsd: 0.5,
        reportFile: "session.json",
      },
      workspace: process.cwd(),
      platform: process.platform,
      initialSessionGoal: initialGoal,
      input,
      writeStdout: () => {},
      writeStderr: (text) => {
        stderr += text;
      },
      onSigint: () => {},
      offSigint: () => {},
      setExitCode: () => {},
      forceExit: (code) => {
        throw new ForcedExit(code);
      },
      resolveProvider: () => ({
        provider,
        providerId: "fake",
        model: "fake",
        costModel,
      }),
      requireKnownCostModel: () => costModel,
      printAgentEvents: async (stream) => {
        let finalEnd: Extract<AgentEvent, { readonly type: "end" }> | undefined;
        for await (const event of stream) {
          if (event.type === "end") finalEnd = event;
        }
        return finalEnd;
      },
      formatCostReport: () => "",
      persistSessionMessages: (messages) => {
        persistedMessages = structuredClone([...messages]);
      },
      persistSessionGoal: (update) => {
        if (update.goal === null) return undefined;
        persistedGoals.push(update.goal);
        return update.goal;
      },
    });
    input.end("complete the assertion goal\n");

    // When
    const result = await session;

    // Then
    expect(providerCalls).toBe(1);
    expect(result.report?.end.stopReason).toBe("cost_budget");
    expect(stderr).toContain(
      "Session goal: budget_limited - Finish the assertion within budget",
    );
    expect(persistedGoals.at(-1)).toMatchObject({
      objective: "Finish the assertion within budget",
      status: "budget_limited",
      statusReason:
        "Session cost budget could not admit another provider request before the active goal completed.",
      latestRuntimeOutcome: { kind: "limit_reached" },
    });
    const completionRequest = persistedMessages.find(
      (message) =>
        message.role === "assistant" &&
        message.toolCalls.some((toolCall) => toolCall.id === "complete_goal"),
    );
    expect(completionRequest).toBeDefined();
    expect(persistedMessages).toContainEqual({
      role: "tool",
      toolCallId: "complete_goal",
      content:
        "Goal completion was not evaluated because the remaining session cost budget could not admit the assertion evaluator request.",
    });
  });

  test(`Given an active saved goal has turn, token, and active-time budgets,
    When goal work reaches the configured boundary,
    Then Keel durably accounts usage and stops automatic continuation`, async () => {
    // Given
    const firstTurnUsage: Usage = {
      inputTokens: 30,
      cachedInputTokens: 0,
      uncachedInputTokens: 30,
      outputTokens: 20,
    };
    const secondTurnUsage: Usage = {
      inputTokens: 40,
      cachedInputTokens: 0,
      uncachedInputTokens: 40,
      outputTokens: 20,
    };
    const initialGoal: SessionGoal = {
      objective: "Finish checkout within its goal budget",
      status: "active",
      budget: { turns: 2, tokens: 100, activeTimeMs: 5_000 },
      usage: { turns: 0, tokens: 0, activeTimeMs: 0 },
    };
    let persistedGoal: SessionGoal | undefined;
    let providerCalls = 0;
    const provider: LLMProvider = {
      id: "fake",
      async *stream() {
        providerCalls++;
        yield { type: "text", text: `Goal turn ${providerCalls}.` };
        yield {
          type: "stop",
          reason: "stop",
          usage: providerCalls === 1 ? firstTurnUsage : secondTurnUsage,
        };
      },
    };
    const timestamps = [0, 1_000, 1_000, 2_500];
    const input = new PassThrough();
    let stderr = "";
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
      platform: process.platform,
      initialSessionGoal: initialGoal,
      now: () => timestamps.shift() ?? 2_500,
      input,
      writeStdout: () => {},
      writeStderr: (text) => {
        stderr += text;
      },
      onSigint: () => {},
      offSigint: () => {},
      setExitCode: () => {},
      forceExit: (code) => {
        throw new ForcedExit(code);
      },
      resolveProvider: () => ({
        provider,
        providerId: "fake",
        model: "fake",
        costModel: ZERO_COST_MODEL,
      }),
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async (stream) => {
        let finalEnd: Extract<AgentEvent, { readonly type: "end" }> | undefined;
        for await (const event of stream) {
          if (event.type === "end") {
            finalEnd = event;
          }
        }
        return finalEnd;
      },
      formatCostReport: () => "",
      persistSessionGoal: (update) => {
        persistedGoal = update.goal ?? undefined;
        return persistedGoal;
      },
    });
    input.end("start the goal\n");

    // When
    await withTimeout(session, 5_000, "goal budget did not stop continuation");

    // Then
    expect(providerCalls).toBe(2);
    expect(persistedGoal).toEqual({
      objective: "Finish checkout within its goal budget",
      status: "budget_limited",
      statusReason: "Session goal budget reached: turns 2/2; tokens 110/100.",
      latestRuntimeOutcome: {
        kind: "limit_reached",
        reason: "Session goal budget reached: turns 2/2; tokens 110/100.",
      },
      budget: { turns: 2, tokens: 100, activeTimeMs: 5_000 },
      usage: { turns: 2, tokens: 110, activeTimeMs: 2_500 },
    });
    expect(stderr).toBe(
      "Session goal: budget_limited - Finish checkout within its goal budget; criterion: missing; reason: Session goal budget reached: turns 2/2; tokens 110/100; usage: 2 turns, 110 tokens, 2.5s active; budget: 2 turns, 100 tokens, 5s active\n",
    );
  });

  test(`Given an active budgeted goal turn produces no final end event,
    When Keel closes the goal turn boundary,
    Then it accounts zero tokens and still enforces the turn budget`, async () => {
    const input = new PassThrough();
    let persistedGoal: SessionGoal | undefined;
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
      platform: process.platform,
      initialSessionGoal: {
        objective: "Account a missing final end event",
        status: "active",
        budget: { turns: 1 },
        usage: { turns: 0, tokens: 0, activeTimeMs: 0 },
      },
      now: () => 0,
      input,
      writeStdout: () => {},
      writeStderr: () => {},
      onSigint: () => {},
      offSigint: () => {},
      setExitCode: () => {},
      forceExit: (code) => {
        throw new ForcedExit(code);
      },
      resolveProvider: () => ({
        provider: {
          id: "unused",
          async *stream() {
            yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          },
        },
        providerId: "fake",
        model: "fake",
        costModel: ZERO_COST_MODEL,
      }),
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async () => undefined,
      formatCostReport: () => "",
      persistSessionGoal: ({ goal }) => {
        persistedGoal = goal ?? undefined;
        return persistedGoal;
      },
    });
    input.end("start goal\n");

    await session;

    expect(persistedGoal).toEqual({
      objective: "Account a missing final end event",
      status: "budget_limited",
      statusReason: "Session goal budget reached: turns 1/1.",
      latestRuntimeOutcome: {
        kind: "limit_reached",
        reason: "Session goal budget reached: turns 1/1.",
      },
      budget: { turns: 1 },
      usage: { turns: 1, tokens: 0, activeTimeMs: 0 },
    });
  });

  test(`Given an interactive report ends while the durable goal is budget-limited,
    When the provider turn itself completed normally,
    Then the report exposes the goal budget stop instead of false completion`, async () => {
    const input = new PassThrough();
    const provider: LLMProvider = withProviderRequestAttemptAccounting({
      id: "fake",
      async *stream() {
        yield { type: "text", text: "Reached token budget." };
        yield {
          type: "stop",
          reason: "stop",
          usage: {
            inputTokens: 2,
            cachedInputTokens: 0,
            uncachedInputTokens: 2,
            outputTokens: 1,
          },
        };
      },
    });
    const session = runInteractiveSession({
      cliArgs: {
        bashMode: "disabled",
        maxCostUsd: 1,
        reportFile: "report.json",
      },
      workspace: process.cwd(),
      platform: process.platform,
      initialSessionGoal: {
        objective: "Report goal budget exhaustion",
        status: "active",
        budget: { tokens: 1 },
        usage: { turns: 0, tokens: 0, activeTimeMs: 0 },
      },
      now: () => 0,
      input,
      writeStdout: () => {},
      writeStderr: () => {},
      onSigint: () => {},
      offSigint: () => {},
      setExitCode: () => {},
      forceExit: (code) => {
        throw new ForcedExit(code);
      },
      resolveProvider: () => ({
        provider,
        providerId: "fake",
        model: "fake",
        costModel: ONE_DOLLAR_PER_MILLION_INPUT,
      }),
      requireKnownCostModel: () => ONE_DOLLAR_PER_MILLION_INPUT,
      printAgentEvents: async (stream) => {
        let finalEnd: Extract<AgentEvent, { readonly type: "end" }> | undefined;
        for await (const event of stream) {
          if (event.type === "end") finalEnd = event;
        }
        return finalEnd;
      },
      formatCostReport: () => "",
      persistSessionGoal: ({ goal }) => goal ?? undefined,
    });
    input.end("start goal\n");

    const result = await session;

    expect(result.report?.end.stopReason).toBe("goal_budget");
  });

  test(`Given a newly activated goal exhausts goal and session cost budgets in the same turn,
    When Keel starts the goal and builds the interactive report,
    Then the terminal session cost reason takes precedence`, async () => {
    const input = new PassThrough();
    const provider: LLMProvider = withProviderRequestAttemptAccounting({
      id: "fake",
      async *stream() {
        yield { type: "text", text: "Reached both budgets." };
        yield { type: "stop", reason: "stop", usage: EXPENSIVE_USAGE };
      },
    });
    const session = runInteractiveSession({
      cliArgs: {
        bashMode: "disabled",
        maxCostUsd: 1,
        reportFile: "report.json",
      },
      workspace: process.cwd(),
      platform: process.platform,
      now: () => 0,
      input,
      writeStdout: () => {},
      writeStderr: () => {},
      onSigint: () => {},
      offSigint: () => {},
      setExitCode: () => {},
      forceExit: (code) => {
        throw new ForcedExit(code);
      },
      resolveProvider: () => ({
        provider,
        providerId: "fake",
        model: "fake",
        costModel: ONE_DOLLAR_PER_MILLION_INPUT,
      }),
      requireKnownCostModel: () => ONE_DOLLAR_PER_MILLION_INPUT,
      printAgentEvents: async (stream) => {
        let finalEnd: Extract<AgentEvent, { readonly type: "end" }> | undefined;
        for await (const event of stream) {
          if (event.type === "end") finalEnd = event;
        }
        return finalEnd;
      },
      formatCostReport: () => "",
      persistSessionGoal: ({ goal }) => goal ?? undefined,
    });
    input.end(
      "/goal Report session cost precedence\n/goal budget --tokens 1\n",
    );

    const result = await session;

    expect(result.report?.end.stopReason).toBe("cost_budget");
  });

  test(`Given a goal reaches its own budget while remediation commands are queued,
    When the user clears the budget and resumes the goal,
    Then Keel remains interactive instead of exiting like a session cost limit`, async () => {
    // Given
    const input = new PassThrough();
    let providerCalls = 0;
    let stdout = "";
    let stderr = "";
    let persistedGoal: SessionGoal | undefined;
    const provider: LLMProvider = {
      id: "fake",
      async *stream() {
        providerCalls++;
        yield { type: "text", text: "Reached the goal turn budget." };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
      platform: process.platform,
      initialSessionGoal: {
        objective: "Remain interactive after goal budget exhaustion",
        status: "active",
        budget: { turns: 1 },
        usage: { turns: 0, tokens: 0, activeTimeMs: 0 },
        criterionKind: "assertion",
        completionCriterion: "The session remains interactive",
      },
      now: () => 0,
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
      },
      onSigint: () => {},
      offSigint: () => {},
      setExitCode: () => {},
      forceExit: (code) => {
        throw new ForcedExit(code);
      },
      resolveProvider: () => ({
        provider,
        providerId: "fake",
        model: "fake",
        costModel: ZERO_COST_MODEL,
      }),
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async (stream) => {
        let finalEnd: Extract<AgentEvent, { readonly type: "end" }> | undefined;
        for await (const event of stream) {
          if (event.type === "end") finalEnd = event;
        }
        return finalEnd;
      },
      formatCostReport: () => "",
      persistSessionGoal: ({ goal }) => {
        persistedGoal = goal ?? undefined;
        return persistedGoal;
      },
    });
    input.end(
      [
        "start goal",
        "/goal budget clear",
        "/goal resume",
        "/goal pause",
        "/goal",
        "",
      ].join("\n"),
    );

    // When
    await withTimeout(session, 5_000, "goal budget remediation did not finish");

    // Then
    expect(providerCalls).toBe(1);
    expect(persistedGoal).toEqual({
      objective: "Remain interactive after goal budget exhaustion",
      status: "paused",
      budget: {},
      usage: { turns: 1, tokens: 0, activeTimeMs: 0 },
      criterionKind: "assertion",
      completionCriterion: "The session remains interactive",
      latestRuntimeOutcome: {
        kind: "limit_reached",
        reason: "Session goal budget reached: turns 1/1.",
      },
    });
    expect(stderr).toContain(
      "Session goal: budget_limited - Remain interactive after goal budget exhaustion",
    );
    expect(stdout).toContain("Goal budget cleared.\n");
    expect(stdout).toContain(
      "Goal resumed: Remain interactive after goal budget exhaustion\n",
    );
    expect(stdout).toContain(
      "Session goal: paused - Remain interactive after goal budget exhaustion; criterion(assertion): The session remains interactive\n",
    );
  });

  test(`Given automatic goal continuations repeat the same tool results and re-emit equal task state,
    When the repeated pattern persists,
    Then Keel sends one recovery hint and only the hard turn cap stops the goal`, async () => {
    // Given
    const initialGoal: SessionGoal = {
      objective: "Keep reading without completing",
      status: "active",
      budget: {},
      usage: { turns: 0, tokens: 0, activeTimeMs: 0 },
      criterionKind: "assertion",
      completionCriterion: "The goal is explicitly marked complete.",
    };
    const persistedGoals: SessionGoal[] = [];
    let persistedMessages: readonly Message[] = [];
    const automaticContinuationTurnLimit = 5;
    let providerCalls = 0;
    const provider: LLMProvider = {
      id: "fake",
      async *stream() {
        providerCalls++;
        if (providerCalls > 1 && providerCalls % 2 === 0) {
          yield {
            type: "tool_call",
            id: `same_plan_${providerCalls}`,
            tool: "update_plan",
            plan: [{ step: "Inspect package.json", status: "in_progress" }],
          };
          yield {
            type: "tool_call",
            id: `read_${providerCalls}`,
            tool: "read",
            path: "package.json",
          };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        yield { type: "text", text: `Turn ${providerCalls} remained active.` };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const input = new PassThrough();
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
      platform: process.platform,
      initialSessionGoal: initialGoal,
      goalAutomaticContinuationTurnLimit: automaticContinuationTurnLimit,
      input,
      writeStdout: () => {},
      writeStderr: () => {},
      onSigint: () => {},
      offSigint: () => {},
      setExitCode: () => {},
      forceExit: (code) => {
        throw new ForcedExit(code);
      },
      resolveProvider: () => ({
        provider,
        providerId: "fake",
        model: "fake",
        costModel: ZERO_COST_MODEL,
      }),
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async (stream) => {
        let finalEnd: Extract<AgentEvent, { readonly type: "end" }> | undefined;
        for await (const event of stream) {
          if (event.type === "end") {
            finalEnd = event;
          }
        }
        return finalEnd;
      },
      formatCostReport: () => "",
      persistSessionMessages: (messages) => {
        persistedMessages = [...messages];
      },
      persistSessionGoal: (update) => {
        if (update.goal !== null) {
          persistedGoals.push(update.goal);
          return update.goal;
        }
        return undefined;
      },
    });
    input.end("start the goal\n");

    // When
    await withTimeout(session, 5000, "goal continuation did not hit turn cap");

    // Then
    expect(providerCalls).toBe(1 + automaticContinuationTurnLimit * 2);
    const recoveryMessages = persistedMessages.filter(
      (message) =>
        message.role === "user" &&
        message.content.includes('source="goal_stagnation_recovery"'),
    );
    expect(recoveryMessages).toHaveLength(1);
    expect(recoveryMessages[0]?.content).toContain(
      "repeated the same response or tool-use pattern",
    );
    expect(recoveryMessages[0]?.content).toContain(
      "Reassess the blocker and choose a materially different next action",
    );
    expect(persistedGoals.at(-1)).toEqual({
      objective: "Keep reading without completing",
      status: "usage_limited",
      budget: {},
      usage: { turns: 6, tokens: 0, activeTimeMs: expect.any(Number) },
      statusReason: `Automatic goal continuation stopped after ${automaticContinuationTurnLimit} continuation turns without completing the active goal.`,
      latestRuntimeOutcome: {
        kind: "limit_reached",
        reason: `Automatic goal continuation stopped after ${automaticContinuationTurnLimit} continuation turns without completing the active goal.`,
      },
      criterionKind: "assertion",
      completionCriterion: "The goal is explicitly marked complete.",
    });
  });

  test(`Given repeated reads trigger a recovery hint,
    When the model changes strategy and produces fresh command evidence,
    Then the goal completes normally without heuristic termination`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-goal-recovery-"));
    try {
      const verificationCommand = 'node -e "process.exit(0)"';
      let persistedMessages: readonly Message[] = [];
      let persistedGoal: SessionGoal | undefined = {
        objective: "Recover and verify the finished work",
        status: "active",
        budget: {},
        usage: { turns: 0, tokens: 0, activeTimeMs: 0 },
        criterionKind: "command",
        completionCriterion: verificationCommand,
      };
      let providerCalls = 0;
      const provider: LLMProvider = {
        id: "fake",
        async *stream() {
          providerCalls++;
          if ([2, 4, 6].includes(providerCalls)) {
            yield {
              type: "tool_call",
              id: `repeated_read_${providerCalls}`,
              tool: "read",
              path: "package.json",
            };
            yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
            return;
          }
          if (providerCalls === 8) {
            yield {
              type: "tool_call",
              id: "recovery_verification",
              tool: "bash",
              command: verificationCommand,
            };
            yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
            return;
          }
          if (providerCalls === 9) {
            yield {
              type: "tool_call",
              id: "complete_after_recovery",
              tool: "update_goal",
              status: "completed",
            };
            yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
            return;
          }
          yield { type: "text", text: `Turn ${providerCalls} finished.` };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
        },
      };
      const input = new PassThrough();
      const session = runInteractiveSession({
        cliArgs: { bashMode: "trusted" },
        workspace,
        platform: process.platform,
        initialSessionGoal: persistedGoal,
        input,
        writeStdout: () => {},
        writeStderr: () => {},
        onSigint: () => {},
        offSigint: () => {},
        setExitCode: () => {},
        forceExit: (code) => {
          throw new ForcedExit(code);
        },
        resolveProvider: () => ({
          provider,
          providerId: "fake",
          model: "fake",
          costModel: ZERO_COST_MODEL,
        }),
        requireKnownCostModel: () => ZERO_COST_MODEL,
        printAgentEvents: async (stream) => {
          let finalEnd:
            | Extract<AgentEvent, { readonly type: "end" }>
            | undefined;
          for await (const event of stream) {
            if (event.type === "end") {
              finalEnd = event;
            }
          }
          return finalEnd;
        },
        formatCostReport: () => "",
        persistSessionMessages: (messages) => {
          persistedMessages = [...messages];
        },
        persistSessionGoal: ({ goal }) => {
          persistedGoal = goal ?? undefined;
          return persistedGoal;
        },
      });
      input.end("start the goal\n");

      // When
      await withTimeout(session, 5000, "recovered goal did not complete");

      // Then
      expect(providerCalls).toBe(10);
      expect(
        persistedMessages.filter(
          (message) =>
            message.role === "user" &&
            message.content.includes('source="goal_stagnation_recovery"'),
        ),
      ).toHaveLength(1);
      expect(persistedGoal).toMatchObject({
        objective: "Recover and verify the finished work",
        status: "completed",
        completionEvidence: {
          kind: "command",
          command: verificationCommand,
          exitCode: 0,
        },
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given automatic goal continuations alternate tool evidence for only two cycles,
    When the hard continuation turn cap is reached,
    Then Keel does not send a stagnation recovery hint`, async () => {
    // Given
    const initialGoal: SessionGoal = {
      objective: "Inspect distinct project evidence",
      status: "active",
      budget: {},
      usage: { turns: 0, tokens: 0, activeTimeMs: 0 },
      criterionKind: "assertion",
      completionCriterion: "Every relevant project file has been inspected.",
    };
    let persistedMessages: readonly Message[] = [];
    const automaticContinuationTurnLimit = 4;
    const readPaths = ["package.json", "tsconfig.json"] as const;
    let providerCalls = 0;
    const provider: LLMProvider = {
      id: "fake",
      async *stream() {
        providerCalls++;
        if (providerCalls > 1 && providerCalls % 2 === 0) {
          const continuationIndex = providerCalls / 2 - 1;
          yield {
            type: "tool_call",
            id: `read_distinct_${providerCalls}`,
            tool: "read",
            path:
              continuationIndex % readPaths.length === 0
                ? readPaths[0]
                : readPaths[1],
          };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        yield { type: "text", text: `Turn ${providerCalls} remained active.` };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const input = new PassThrough();
    let stderr = "";
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
      platform: process.platform,
      initialSessionGoal: initialGoal,
      goalAutomaticContinuationTurnLimit: automaticContinuationTurnLimit,
      input,
      writeStdout: () => {},
      writeStderr: (text) => {
        stderr += text;
      },
      onSigint: () => {},
      offSigint: () => {},
      setExitCode: () => {},
      forceExit: (code) => {
        throw new ForcedExit(code);
      },
      resolveProvider: () => ({
        provider,
        providerId: "fake",
        model: "fake",
        costModel: ZERO_COST_MODEL,
      }),
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async (stream) => {
        let finalEnd: Extract<AgentEvent, { readonly type: "end" }> | undefined;
        for await (const event of stream) {
          if (event.type === "end") {
            finalEnd = event;
          }
        }
        return finalEnd;
      },
      formatCostReport: () => "",
      persistSessionMessages: (messages) => {
        persistedMessages = [...messages];
      },
    });
    input.end("start the goal\n");

    // When
    await withTimeout(session, 5000, "goal continuation did not hit turn cap");

    // Then
    expect(
      persistedMessages.filter(
        (message) =>
          message.role === "user" &&
          message.content.includes('source="goal_stagnation_recovery"'),
      ),
    ).toHaveLength(0);
    expect(stderr).toContain(
      `Automatic goal continuation stopped after ${automaticContinuationTurnLimit} continuation turns without completing the active goal.`,
    );
  });

  test(`Given automatic goal continuations repeat an exact two-step tool cycle,
    When the same cycle is observed three consecutive times,
    Then Keel sends one recovery hint without stopping the goal`, async () => {
    // Given
    const initialGoal: SessionGoal = {
      objective: "Inspect cycling project evidence",
      status: "active",
      budget: {},
      usage: { turns: 0, tokens: 0, activeTimeMs: 0 },
      criterionKind: "assertion",
      completionCriterion: "Every relevant project file has been inspected.",
    };
    let persistedMessages: readonly Message[] = [];
    const automaticContinuationTurnLimit = 8;
    const readPaths = ["package.json", "tsconfig.json"] as const;
    let providerCalls = 0;
    const provider: LLMProvider = {
      id: "fake",
      async *stream() {
        providerCalls++;
        if (providerCalls > 1 && providerCalls % 2 === 0) {
          const continuationIndex = providerCalls / 2 - 1;
          yield {
            type: "tool_call",
            id: `read_cycle_${providerCalls}`,
            tool: "read",
            path:
              continuationIndex % readPaths.length === 0
                ? readPaths[0]
                : readPaths[1],
          };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        yield { type: "text", text: `Turn ${providerCalls} remained active.` };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const input = new PassThrough();
    let stderr = "";
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
      platform: process.platform,
      initialSessionGoal: initialGoal,
      goalAutomaticContinuationTurnLimit: automaticContinuationTurnLimit,
      input,
      writeStdout: () => {},
      writeStderr: (text) => {
        stderr += text;
      },
      onSigint: () => {},
      offSigint: () => {},
      setExitCode: () => {},
      forceExit: (code) => {
        throw new ForcedExit(code);
      },
      resolveProvider: () => ({
        provider,
        providerId: "fake",
        model: "fake",
        costModel: ZERO_COST_MODEL,
      }),
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async (stream) => {
        let finalEnd: Extract<AgentEvent, { readonly type: "end" }> | undefined;
        for await (const event of stream) {
          if (event.type === "end") {
            finalEnd = event;
          }
        }
        return finalEnd;
      },
      formatCostReport: () => "",
      persistSessionMessages: (messages) => {
        persistedMessages = [...messages];
      },
    });
    input.end("start the goal\n");

    // When
    await withTimeout(session, 5000, "goal continuation did not hit turn cap");

    // Then
    expect(providerCalls).toBe(1 + automaticContinuationTurnLimit * 2);
    expect(
      persistedMessages.filter(
        (message) =>
          message.role === "user" &&
          message.content.includes('source="goal_stagnation_recovery"'),
      ),
    ).toHaveLength(1);
    expect(stderr).toContain(
      `Automatic goal continuation stopped after ${automaticContinuationTurnLimit} continuation turns without completing the active goal.`,
    );
  });

  test.each([
    {
      description: "successful",
      command: "printf changed >> state.txt",
    },
    {
      description: "non-verification failing",
      command: "printf changed >> state.txt; false",
    },
  ])(`Given repeated $description bash calls can mutate the workspace with identical output,
    When automatic goal continuation reaches the hard turn cap,
    Then Keel does not classify the calls as strong stagnation evidence`, async ({
    command,
  }) => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-goal-bash-mutation-"));
    try {
      const initialGoal: SessionGoal = {
        objective: "Wait for the shell-driven workspace task to finish",
        status: "active",
        budget: {},
        usage: { turns: 0, tokens: 0, activeTimeMs: 0 },
        criterionKind: "assertion",
        completionCriterion: "The shell-driven workspace task is finished.",
      };
      let persistedMessages: readonly Message[] = [];
      const automaticContinuationTurnLimit = 4;
      let providerCalls = 0;
      const provider: LLMProvider = {
        id: "fake",
        async *stream() {
          providerCalls++;
          if (providerCalls > 1 && providerCalls % 2 === 0) {
            yield {
              type: "tool_call",
              id: `mutating_bash_${providerCalls}`,
              tool: "bash",
              command,
            };
            yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
            return;
          }
          yield {
            type: "text",
            text: `Turn ${providerCalls} remained active.`,
          };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
        },
      };
      const input = new PassThrough();
      const session = runInteractiveSession({
        cliArgs: { bashMode: "trusted" },
        workspace,
        platform: process.platform,
        initialSessionGoal: initialGoal,
        goalAutomaticContinuationTurnLimit: automaticContinuationTurnLimit,
        input,
        writeStdout: () => {},
        writeStderr: () => {},
        onSigint: () => {},
        offSigint: () => {},
        setExitCode: () => {},
        forceExit: (code) => {
          throw new ForcedExit(code);
        },
        resolveProvider: () => ({
          provider,
          providerId: "fake",
          model: "fake",
          costModel: ZERO_COST_MODEL,
        }),
        requireKnownCostModel: () => ZERO_COST_MODEL,
        printAgentEvents: async (stream) => {
          let finalEnd:
            | Extract<AgentEvent, { readonly type: "end" }>
            | undefined;
          for await (const event of stream) {
            if (event.type === "end") {
              finalEnd = event;
            }
          }
          return finalEnd;
        },
        formatCostReport: () => "",
        persistSessionMessages: (messages) => {
          persistedMessages = [...messages];
        },
      });
      input.end("start the goal\n");

      // When
      await withTimeout(
        session,
        5000,
        "mutating bash continuation did not hit turn cap",
      );

      // Then
      expect(await readFile(join(workspace, "state.txt"), "utf8")).toBe(
        "changed".repeat(automaticContinuationTurnLimit),
      );
      expect(
        persistedMessages.filter(
          (message) =>
            message.role === "user" &&
            message.content.includes('source="goal_stagnation_recovery"'),
        ),
      ).toHaveLength(0);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a command goal repeatedly runs the same failing verification,
    When the third identical failure completes without other state changes,
    Then Keel sends one recovery hint and only the hard turn cap stops the goal`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-goal-bash-verification-"),
    );
    try {
      const verificationCommand = 'node -e "process.exit(1)"';
      const initialGoal: SessionGoal = {
        objective: "Make the failing verification pass",
        status: "active",
        budget: {},
        usage: { turns: 0, tokens: 0, activeTimeMs: 0 },
        criterionKind: "command",
        completionCriterion: verificationCommand,
      };
      let persistedMessages: readonly Message[] = [];
      let persistedGoal: SessionGoal | undefined = initialGoal;
      const automaticContinuationTurnLimit = 4;
      let providerCalls = 0;
      const provider: LLMProvider = {
        id: "fake",
        async *stream() {
          providerCalls++;
          if (providerCalls > 1 && providerCalls % 2 === 0) {
            yield {
              type: "tool_call",
              id: `failing_verification_${providerCalls}`,
              tool: "bash",
              command: verificationCommand,
            };
            yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
            return;
          }
          yield {
            type: "text",
            text: `Verification turn ${providerCalls} remained active.`,
          };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
        },
      };
      const input = new PassThrough();
      const session = runInteractiveSession({
        cliArgs: { bashMode: "trusted" },
        workspace,
        platform: process.platform,
        initialSessionGoal: initialGoal,
        goalAutomaticContinuationTurnLimit: automaticContinuationTurnLimit,
        input,
        writeStdout: () => {},
        writeStderr: () => {},
        onSigint: () => {},
        offSigint: () => {},
        setExitCode: () => {},
        forceExit: (code) => {
          throw new ForcedExit(code);
        },
        resolveProvider: () => ({
          provider,
          providerId: "fake",
          model: "fake",
          costModel: ZERO_COST_MODEL,
        }),
        requireKnownCostModel: () => ZERO_COST_MODEL,
        printAgentEvents: async (stream) => {
          let finalEnd:
            | Extract<AgentEvent, { readonly type: "end" }>
            | undefined;
          for await (const event of stream) {
            if (event.type === "end") {
              finalEnd = event;
            }
          }
          return finalEnd;
        },
        formatCostReport: () => "",
        persistSessionMessages: (messages) => {
          persistedMessages = [...messages];
        },
        persistSessionGoal: ({ goal }) => {
          persistedGoal = goal ?? undefined;
          return persistedGoal;
        },
      });
      input.end("start the goal\n");

      // When
      await withTimeout(
        session,
        5000,
        "failing verification continuation did not hit turn cap",
      );

      // Then
      expect(providerCalls).toBe(1 + automaticContinuationTurnLimit * 2);
      expect(
        persistedMessages.filter(
          (message) =>
            message.role === "user" &&
            message.content.includes('source="goal_stagnation_recovery"'),
        ),
      ).toHaveLength(1);
      expect(persistedGoal).toMatchObject({
        objective: initialGoal.objective,
        status: "usage_limited",
        statusReason: `Automatic goal continuation stopped after ${automaticContinuationTurnLimit} continuation turns without completing the active goal.`,
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given user input arrives when a repeated pattern qualifies for recovery,
    When automatic continuation yields control,
    Then ordinary user steering preempts the synthetic recovery hint`, async () => {
    // Given
    const initialGoal: SessionGoal = {
      objective: "Keep user steering authoritative",
      status: "active",
      budget: {},
      usage: { turns: 0, tokens: 0, activeTimeMs: 0 },
      criterionKind: "assertion",
      completionCriterion: "The user confirms the work is complete.",
    };
    const input = new PassThrough();
    let persistedMessages: readonly Message[] = [];
    let persistedGoal: SessionGoal | undefined = initialGoal;
    let providerCalls = 0;
    const provider: LLMProvider = {
      id: "fake",
      async *stream() {
        providerCalls++;
        if (providerCalls > 1 && providerCalls % 2 === 0) {
          yield {
            type: "tool_call",
            id: `read_before_pause_${providerCalls}`,
            tool: "read",
            path: "package.json",
          };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        if (providerCalls === 7) {
          input.end("inspect a different file next\n/goal pause\n");
        }
        yield { type: "text", text: `Turn ${providerCalls} remained active.` };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
      platform: process.platform,
      initialSessionGoal: initialGoal,
      input,
      writeStdout: () => {},
      writeStderr: () => {},
      onSigint: () => {},
      offSigint: () => {},
      setExitCode: () => {},
      forceExit: (code) => {
        throw new ForcedExit(code);
      },
      resolveProvider: () => ({
        provider,
        providerId: "fake",
        model: "fake",
        costModel: ZERO_COST_MODEL,
      }),
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async (stream) => {
        let finalEnd: Extract<AgentEvent, { readonly type: "end" }> | undefined;
        for await (const event of stream) {
          if (event.type === "end") {
            finalEnd = event;
          }
        }
        return finalEnd;
      },
      formatCostReport: () => "",
      persistSessionMessages: (messages) => {
        persistedMessages = [...messages];
      },
      persistSessionGoal: ({ goal }) => {
        persistedGoal = goal ?? undefined;
        return persistedGoal;
      },
    });
    input.write("start the goal\n");

    // When
    await withTimeout(session, 5000, "queued user steering was not processed");

    // Then
    expect(providerCalls).toBe(9);
    expect(persistedMessages).toContainEqual({
      role: "user",
      content: "inspect a different file next",
    });
    expect(
      persistedMessages.filter(
        (message) =>
          message.role === "user" &&
          message.content.includes('source="goal_stagnation_recovery"'),
      ),
    ).toHaveLength(0);
    expect(persistedGoal).toMatchObject({
      objective: initialGoal.objective,
      status: "paused",
    });
  });

  test(`Given automatic goal continuation has an invalid configured turn limit,
    When the runtime starts continuation,
    Then the session fails before running unbounded continuations`, async () => {
    // Given
    const provider: LLMProvider = {
      id: "fake",
      async *stream() {
        yield { type: "text", text: "Initial turn left the goal active." };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const input = new PassThrough();
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
      platform: process.platform,
      initialSessionGoal: {
        objective: "Continue with invalid configuration",
        status: "active",
        budget: {},
        usage: { turns: 0, tokens: 0, activeTimeMs: 0 },
      },
      goalAutomaticContinuationTurnLimit: 0,
      input,
      writeStdout: () => {},
      writeStderr: () => {},
      onSigint: () => {},
      offSigint: () => {},
      setExitCode: () => {},
      forceExit: (code) => {
        throw new ForcedExit(code);
      },
      resolveProvider: () => ({
        provider,
        providerId: "fake",
        model: "fake",
        costModel: ZERO_COST_MODEL,
      }),
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async (stream) => {
        let finalEnd: Extract<AgentEvent, { readonly type: "end" }> | undefined;
        for await (const event of stream) {
          if (event.type === "end") {
            finalEnd = event;
          }
        }
        return finalEnd;
      },
      formatCostReport: () => "",
    });
    input.end("start the goal\n");

    // When / Then
    await expect(session).rejects.toThrow(
      "goalAutomaticContinuationTurnLimit must be a positive safe integer.",
    );
  });

  test(`Given a third repeated continuation would qualify for recovery,
    When SIGINT aborts that continuation turn,
    Then the session rolls back the pending signature and leaves the goal active`, async () => {
    // Given
    const initialGoal: SessionGoal = {
      objective: "Abort continuation safely",
      status: "active",
      budget: {},
      usage: { turns: 0, tokens: 0, activeTimeMs: 0 },
      criterionKind: "assertion",
      completionCriterion: "The goal is explicitly marked complete.",
    };
    const sigintHandlers = new Set<() => void>();
    const persistedGoals: SessionGoal[] = [];
    let persistedMessages: readonly Message[] = [];
    let providerCalls = 0;
    const provider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        providerCalls++;
        if ([2, 4, 6].includes(providerCalls)) {
          yield {
            type: "tool_call",
            id: `read_before_abort_${providerCalls}`,
            tool: "read",
            path: "package.json",
          };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        yield {
          type: "text",
          text:
            providerCalls === 1
              ? "Initial turn left the goal active."
              : "Continuation waiting for abort.",
        };
        if (providerCalls === 7) {
          for (const handler of [...sigintHandlers]) {
            handler();
          }
          if (!options.signal.aborted) {
            await new Promise<void>((resolve) => {
              options.signal.addEventListener("abort", () => resolve(), {
                once: true,
              });
            });
          }
        }
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const input = new PassThrough();
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
      platform: process.platform,
      initialSessionGoal: initialGoal,
      input,
      writeStdout: () => {},
      writeStderr: () => {},
      onSigint: (handler) => {
        sigintHandlers.add(handler);
      },
      offSigint: (handler) => {
        sigintHandlers.delete(handler);
      },
      setExitCode: () => {},
      forceExit: (code) => {
        throw new ForcedExit(code);
      },
      resolveProvider: () => ({
        provider,
        providerId: "fake",
        model: "fake",
        costModel: ZERO_COST_MODEL,
      }),
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async (stream) => {
        let finalEnd: Extract<AgentEvent, { readonly type: "end" }> | undefined;
        for await (const event of stream) {
          if (event.type === "end") {
            finalEnd = event;
          }
        }
        return finalEnd;
      },
      formatCostReport: () => "",
      persistSessionMessages: (messages) => {
        persistedMessages = [...messages];
      },
      persistSessionGoal: (update) => {
        if (update.goal !== null) {
          persistedGoals.push(update.goal);
          return update.goal;
        }
        return undefined;
      },
    });
    input.end("start the goal\n");

    // When
    await withTimeout(session, 5000, "goal continuation abort did not stop");

    // Then
    expect(providerCalls).toBe(7);
    expect(persistedGoals.at(-1)).toMatchObject({
      objective: "Abort continuation safely",
      status: "active",
      budget: {},
      usage: { turns: 3, tokens: 0, activeTimeMs: expect.any(Number) },
      criterionKind: "assertion",
      completionCriterion: "The goal is explicitly marked complete.",
      latestRuntimeOutcome: {
        kind: "progress_observed",
        reason: "The latest goal turn produced new tool-result evidence.",
      },
    });
    expect(
      persistedMessages.filter(
        (message) =>
          message.role === "user" &&
          message.content.includes('source="goal_stagnation_recovery"'),
      ),
    ).toHaveLength(0);
    expect(
      persistedMessages.filter(
        (message) =>
          message.role === "user" &&
          message.content.includes('source="goal_continuation"'),
      ),
    ).toHaveLength(2);
    expect(sigintHandlers.size).toBe(0);
  });

  test(`Given a goal turn records a newer runtime outcome before it finishes,
    When SIGINT aborts that turn,
    Then the pending outcome rolls back to the prior durable value`, async () => {
    // Given
    const initialGoal: SessionGoal = {
      objective: "Keep the durable outcome on abort",
      status: "active",
      budget: {},
      usage: { turns: 0, tokens: 0, activeTimeMs: 0 },
      criterionKind: "command",
      completionCriterion: "pnpm test",
      latestRuntimeOutcome: {
        kind: "progress_observed",
        reason: "A prior turn changed task progress.",
      },
    };
    const sigintHandlers = new Set<() => void>();
    let persistedGoal: SessionGoal | undefined = initialGoal;
    let providerCalls = 0;
    const provider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        providerCalls++;
        if (providerCalls === 1) {
          yield {
            type: "tool_call",
            id: "rejected_before_abort",
            tool: "update_goal",
            status: "completed",
          };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        for (const handler of [...sigintHandlers]) {
          handler();
        }
        if (!options.signal.aborted) {
          await new Promise<void>((resolve) => {
            options.signal.addEventListener("abort", () => resolve(), {
              once: true,
            });
          });
        }
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const input = new PassThrough();
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
      platform: process.platform,
      initialSessionGoal: initialGoal,
      input,
      writeStdout: () => {},
      writeStderr: () => {},
      onSigint: (handler) => {
        sigintHandlers.add(handler);
      },
      offSigint: (handler) => {
        sigintHandlers.delete(handler);
      },
      setExitCode: () => {},
      forceExit: (code) => {
        throw new ForcedExit(code);
      },
      resolveProvider: () => ({
        provider,
        providerId: "fake",
        model: "fake",
        costModel: ZERO_COST_MODEL,
      }),
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async (stream) => {
        for await (const _event of stream) {
          // Drain the event stream so the pending outcome is observed before
          // the second provider request aborts the enclosing goal turn.
        }
        return undefined;
      },
      formatCostReport: () => "",
      persistSessionGoal: ({ goal }) => {
        persistedGoal = goal ?? undefined;
        return persistedGoal;
      },
    });
    input.end("start the goal\n");

    // When
    await withTimeout(session, 5000, "goal outcome abort did not finish");

    // Then
    expect(providerCalls).toBe(2);
    expect(persistedGoal).toEqual(initialGoal);
    expect(sigintHandlers.size).toBe(0);
  });

  test(`Given a named session resumes with queued input from an interrupted run,
    When stdin closes before new input arrives,
    Then the queued input runs once and is consumed with the persisted turn`, async () => {
    // Given
    const pendingInput: SessionQueuedInput = {
      id: "queued-follow-up",
      timestamp: "1970-01-01T00:00:00.001Z",
      sequence: 7,
      line: "continue with beta",
    };
    const observedUserContexts: string[][] = [];
    const provider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        observedUserContexts.push(
          options.messages
            .filter((message) => message.role === "user")
            .map((message) => message.content),
        );
        yield { type: "text", text: "Queued turn done." };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const input = new PassThrough();
    const consumedInputIds: string[][] = [];
    let persistedMessages: readonly Message[] = [];
    let stdout = "";
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
      platform: process.platform,
      initialQueuedInputs: [pendingInput],
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: () => {},
      onSigint: () => {},
      offSigint: () => {},
      setExitCode: () => {},
      forceExit: (code) => {
        throw new ForcedExit(code);
      },
      resolveProvider: () => ({
        provider,
        providerId: "fake",
        model: "fake",
        costModel: ZERO_COST_MODEL,
      }),
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async (stream) => {
        let finalEnd: Extract<AgentEvent, { readonly type: "end" }> | undefined;
        for await (const event of stream) {
          if (event.type === "text") {
            stdout += event.text;
          } else if (event.type === "end") {
            finalEnd = event;
          }
        }
        return finalEnd;
      },
      formatCostReport: () => "",
      persistSessionMessages: (messages, _reason, inputIds) => {
        persistedMessages = [...messages];
        consumedInputIds.push([...inputIds]);
      },
    });
    input.end();

    // When / Then
    await withTimeout(session, 5000, "resumed queued input was not processed");
    expect(stdout).toBe("Queued turn done.\n");
    expect(observedUserContexts).toEqual([["continue with beta"]]);
    expect(consumedInputIds).toEqual([["queued-follow-up"]]);
    expect(persistedMessages).toEqual([
      { role: "user", content: "continue with beta" },
      { role: "assistant", content: "Queued turn done.", toolCalls: [] },
    ]);
  });

  test(`Given a named session resumes with blank queued input,
    When stdin closes before new input arrives,
    Then the blank input is consumed without starting a model turn`, async () => {
    // Given
    const pendingInput: SessionQueuedInput = {
      id: "blank-queued-input",
      timestamp: "1970-01-01T00:00:00.001Z",
      sequence: 8,
      line: "   ",
    };
    const consumedInputIds: string[][] = [];
    const input = new PassThrough();
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
      platform: process.platform,
      initialQueuedInputs: [pendingInput],
      input,
      writeStdout: () => {},
      writeStderr: () => {},
      onSigint: () => {},
      offSigint: () => {},
      setExitCode: () => {},
      forceExit: (code) => {
        throw new ForcedExit(code);
      },
      resolveProvider: () => {
        throw new Error("blank queued input should not resolve a provider");
      },
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async () => undefined,
      formatCostReport: () => "",
      consumeQueuedInputs: (inputIds) => {
        consumedInputIds.push([...inputIds]);
      },
    });
    input.end();

    // When
    await withTimeout(session, 5000, "blank queued input was not consumed");

    // Then
    expect(consumedInputIds).toEqual([["blank-queued-input"]]);
  });

  test(`Given a queued prompt is typed while a named session turn is running,
    When the process stops before the turn transcript is persisted,
    Then the queued prompt is durable and resumes exactly once`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-interactive-inbox-"));
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    let now = 0;
    const runtime = {
      env: (key: string) => (key === "KEEL_HOME" ? home : undefined),
      now: () => now,
    };
    const session = createSessionStore({
      sessionId: "durable-inbox",
      workspace,
      runtime,
    });
    let persistedMessages: readonly Message[] = session.messages;
    const crash = new Error("simulated process stop");
    const firstProvider: LLMProvider = {
      id: "fake",
      async *stream() {
        yield {
          type: "tool_call",
          id: "durable_inbox_read",
          tool: "read",
          path: "package.json",
        };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const firstInput = new PassThrough();
    const firstRun = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace,
      platform: process.platform,
      initialMessages: session.messages,
      initialQueuedInputs: session.pendingInputs,
      input: firstInput,
      writeStdout: () => {},
      writeStderr: () => {},
      onSigint: () => {},
      offSigint: () => {},
      setExitCode: () => {},
      forceExit: (code) => {
        throw new ForcedExit(code);
      },
      resolveProvider: () => ({
        provider: firstProvider,
        providerId: "fake",
        model: "fake",
        costModel: ZERO_COST_MODEL,
      }),
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async (stream) => {
        for await (const event of stream) {
          if (event.type === "tool_start") {
            now = 1;
            firstInput.write("continue after restart\n");
            await setImmediate();
            firstInput.end();
            throw crash;
          }
        }
        return undefined;
      },
      formatCostReport: () => "",
      persistQueuedInput: (input) =>
        persistSessionQueuedInput({
          session,
          sequence: input.sequence,
          line: input.line,
          runtime,
        }),
      persistSessionMessages: (messages, reason, consumedInputIds) => {
        now = 2;
        persistedMessages = persistSessionMessages({
          session,
          previousMessages: persistedMessages,
          currentMessages: messages,
          runtime,
          reason,
          consumedInputIds,
        });
      },
    });

    try {
      firstInput.write("start slow tool\n");
      await expect(firstRun).rejects.toThrow("simulated process stop");

      const ledgerAfterCrash = (await readFile(session.filePath, "utf8"))
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(ledgerAfterCrash).toHaveLength(2);
      expect(ledgerAfterCrash[1]).toMatchObject({
        type: "input_admitted",
        line: "continue after restart",
      });
      const resumed = resumeSessionStore({
        sessionId: "durable-inbox",
        workspace,
        runtime,
      });
      expect(resumed.messages).toEqual([]);
      expect(resumed.pendingInputs).toHaveLength(1);

      const observedUserContexts: string[][] = [];
      const secondProvider: LLMProvider = {
        id: "fake",
        async *stream(options) {
          observedUserContexts.push(
            options.messages
              .filter((message) => message.role === "user")
              .map((message) => message.content),
          );
          yield { type: "text", text: "Recovered queued prompt." };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
        },
      };
      const secondInput = new PassThrough();
      let resumedPersistedMessages: readonly Message[] = resumed.messages;
      const secondRun = runInteractiveSession({
        cliArgs: { bashMode: "disabled" },
        workspace,
        platform: process.platform,
        initialMessages: resumed.messages,
        initialQueuedInputs: resumed.pendingInputs,
        input: secondInput,
        writeStdout: () => {},
        writeStderr: () => {},
        onSigint: () => {},
        offSigint: () => {},
        setExitCode: () => {},
        forceExit: (code) => {
          throw new ForcedExit(code);
        },
        resolveProvider: () => ({
          provider: secondProvider,
          providerId: "fake",
          model: "fake",
          costModel: ZERO_COST_MODEL,
        }),
        requireKnownCostModel: () => ZERO_COST_MODEL,
        printAgentEvents: async (stream) => {
          let finalEnd:
            | Extract<AgentEvent, { readonly type: "end" }>
            | undefined;
          for await (const event of stream) {
            if (event.type === "end") {
              finalEnd = event;
            }
          }
          return finalEnd;
        },
        formatCostReport: () => "",
        persistSessionMessages: (messages, reason, consumedInputIds) => {
          now = 3;
          resumedPersistedMessages = persistSessionMessages({
            session: resumed,
            previousMessages: resumedPersistedMessages,
            currentMessages: messages,
            runtime,
            reason,
            consumedInputIds,
          });
        },
      });
      secondInput.end();

      // When
      await withTimeout(
        secondRun,
        5000,
        "durable queued prompt was not resumed",
      );
      const finalResume = resumeSessionStore({
        sessionId: "durable-inbox",
        workspace,
        runtime,
      });

      // Then
      expect(observedUserContexts).toEqual([["continue after restart"]]);
      expect(finalResume.pendingInputs).toEqual([]);
      expect(finalResume.messages).toEqual([
        { role: "user", content: "continue after restart" },
        {
          role: "assistant",
          content: "Recovered queued prompt.",
          toolCalls: [],
        },
      ]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given an interactive report is requested but no end event is returned,
    When the user finishes a prompt,
    Then no session report is produced`, async () => {
    // Given
    const provider: LLMProvider = {
      id: "fake",
      async *stream() {
        yield { type: "text", text: "answer" };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const input = new PassThrough();
    let stdout = "";
    const session = runInteractiveSession({
      cliArgs: { bashMode: "trusted", reportFile: "session.json" },
      workspace: process.cwd(),
      platform: process.platform,
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: () => {},
      onSigint: () => {},
      offSigint: () => {},
      setExitCode: () => {},
      forceExit: (code) => {
        throw new ForcedExit(code);
      },
      resolveProvider: () => ({
        provider,
        providerId: "fake",
        model: "fake",
        costModel: ZERO_COST_MODEL,
      }),
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async (stream) => {
        for await (const event of stream) {
          if (event.type === "text") {
            stdout += event.text;
          }
        }
        return undefined;
      },
      formatCostReport: () => "",
    });

    // When
    input.end("hello\n");

    // Then
    const result = await session;
    expect(stdout).toBe("answer\n");
    expect(result.report).toBeUndefined();
  });

  test(`Given an interactive assistant turn is still working,
    When user sends a follow-up before it finishes,
    Then the follow-up runs next with previous context`, async () => {
    // Given
    let finishFirstTurn: () => void = () => {};
    let receiveFirstText: () => void = () => {};
    const firstTurnCanFinish = new Promise<void>((resolve) => {
      finishFirstTurn = resolve;
    });
    const firstTextReceived = new Promise<void>((resolve) => {
      receiveFirstText = resolve;
    });
    const observedContexts: Array<
      Array<{ readonly role: Message["role"]; readonly content: string }>
    > = [];
    let turn = 0;
    const provider: LLMProvider = withProviderRequestAttemptAccounting({
      id: "fake",
      async *stream(options) {
        turn++;
        observedContexts.push(
          options.messages.map((message) => ({
            role: message.role,
            content: message.content,
          })),
        );

        if (turn === 1) {
          yield { type: "text", text: "First answer" };
          receiveFirstText();
          await firstTurnCanFinish;
        } else {
          yield { type: "text", text: "Second saw prior context" };
        }
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    });
    const input = new PassThrough();
    let stdout = "";
    const session = runInteractiveSession({
      cliArgs: { bashMode: "ask", reportFile: "report.json" },
      workspace: process.cwd(),
      platform: process.platform,
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: () => {
        throw new Error("follow-up input should not be treated as approval");
      },
      onSigint: () => {},
      offSigint: () => {},
      setExitCode: () => {},
      forceExit: (code) => {
        throw new ForcedExit(code);
      },
      resolveProvider: () => ({
        provider,
        providerId: "fake",
        model: "fake",
        costModel: ZERO_COST_MODEL,
      }),
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async (stream) => {
        let finalEnd: Extract<AgentEvent, { readonly type: "end" }> | undefined;
        for await (const event of stream) {
          if (event.type === "text") {
            stdout += event.text;
          } else if (event.type === "end") {
            finalEnd = event;
          }
        }
        return finalEnd;
      },
      formatCostReport: () => "",
    });

    // When
    input.write("first prompt\n");
    await withTimeout(firstTextReceived, 5000, "first turn did not start");
    input.write("second prompt\n");
    input.end();
    finishFirstTurn();

    // Then
    const result = await session;
    expect(stdout).toBe("First answer\nSecond saw prior context\n");
    expect(observedContexts).toEqual([
      [{ role: "user", content: "first prompt" }],
      [
        { role: "user", content: "first prompt" },
        { role: "assistant", content: "First answer" },
        { role: "user", content: "second prompt" },
      ],
    ]);
    expect(result.report?.tasks).toMatchObject([
      {
        ordinal: 1,
        trigger: "user_prompt",
        agentRuns: [{ ordinal: 1, trigger: "user_prompt" }],
        outcome: "completed",
      },
      {
        ordinal: 2,
        trigger: "user_prompt",
        agentRuns: [{ ordinal: 1, trigger: "user_prompt" }],
        outcome: "completed",
      },
    ]);
  });

  test(`Given a resumed session contains historical tool results,
    When the user sends a follow-up prompt,
    Then the model sees the history without re-running old tools`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-interactive-resume-"));
    const initialMessages: readonly Message[] = [
      { role: "user", content: "create the old file" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "historical_write",
            tool: "write",
            path: "old.txt",
            content: "old content\n",
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "historical_write",
        content: "Wrote old.txt",
      },
    ];
    let observedMessages: readonly Message[] = [];
    const provider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        observedMessages = options.messages;
        yield { type: "text", text: "Continuing from history." };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const input = new PassThrough();
    let stdout = "";
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace,
      platform: process.platform,
      initialMessages,
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: () => {},
      onSigint: () => {},
      offSigint: () => {},
      setExitCode: () => {},
      forceExit: (code) => {
        throw new ForcedExit(code);
      },
      resolveProvider: () => ({
        provider,
        providerId: "fake",
        model: "fake",
        costModel: ZERO_COST_MODEL,
      }),
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async (stream) => {
        let finalEnd: Extract<AgentEvent, { readonly type: "end" }> | undefined;
        for await (const event of stream) {
          if (event.type === "text") {
            stdout += event.text;
          } else if (event.type === "end") {
            finalEnd = event;
          }
        }
        return finalEnd;
      },
      formatCostReport: () => "",
    });

    try {
      // When
      input.end("continue\n");

      // Then
      await session;
      expect(stdout).toBe("Continuing from history.\n");
      expect(observedMessages).toEqual([
        ...initialMessages,
        { role: "user", content: "continue" },
      ]);
      await expect(
        readFile(join(workspace, "old.txt"), "utf8"),
      ).rejects.toThrow("ENOENT");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
