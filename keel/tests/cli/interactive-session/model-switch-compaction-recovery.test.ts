import { PassThrough } from "node:stream";
import { describe, expect, test } from "vitest";
import type { AgentEvent } from "../../../src/agent/events.ts";
import type {
  ToolOutputArtifactSaveInput,
  ToolOutputArtifactStore,
} from "../../../src/agent/tool-output-artifacts.ts";
import type { ProviderSelection } from "../../../src/cli/interactive-session/types.ts";
import type { LLMProvider, Message } from "../../../src/llm/types.ts";
import { verifiedToolOutputArtifactFixture } from "../../../src/testing/context-compaction-fixtures.ts";
import {
  EPHEMERAL_INTERACTIVE_SESSION,
  ForcedExit,
  ONE_DOLLAR_PER_MILLION_INPUT,
  resolvedProvider,
  runInteractiveSessionWithoutMemory as runInteractiveSession,
  savedInteractiveSession,
  withProviderRequestAttemptAccounting,
  withTimeout,
  ZERO_COST_MODEL,
  ZERO_USAGE,
} from "../../../src/testing/interactive-session-fixtures.ts";

describe("Interactive Session - Model Switch Compaction Recovery", () => {
  test(`Given the current history does not fit a selected target context window,
    When user enters /model for that target,
    Then Keel compacts with the old provider before accepting the switch`, async () => {
    // Given
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    let stdout = "";
    let stderr = "";
    let oldProviderTurns = 0;
    let oldProviderSummaryRequests = 0;
    let targetProviderTurns = 0;
    let targetProviderSummaryRequests = 0;
    const targetRequestContexts: Message[][] = [];
    const largePrompt = "large history ".repeat(3_000).trim();
    const oldProvider: LLMProvider = withProviderRequestAttemptAccounting({
      id: "fake",
      async *stream(options) {
        if (options.toolChoice === "none") {
          oldProviderSummaryRequests++;
          yield { type: "text", text: "Downshift checkpoint summary." };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        oldProviderTurns++;
        yield { type: "text", text: `old provider ${oldProviderTurns}` };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    });
    const targetProvider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        if (options.toolChoice === "none") {
          targetProviderSummaryRequests++;
          yield { type: "text", text: "unexpected target summary" };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        targetProviderTurns++;
        targetRequestContexts.push(structuredClone([...options.messages]));
        yield { type: "text", text: `target provider ${targetProviderTurns}` };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
      platform: process.platform,
      session: EPHEMERAL_INTERACTIVE_SESSION,
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
            selection.model ?? "tiny",
            targetProvider,
            ZERO_COST_MODEL,
            {
              contextWindowTokens: 2_000,
              reserveTokens: 0,
              keepRecentTokens: 1,
            },
          );
        }
        return resolvedProvider("fake", "fake", oldProvider);
      },
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
    input.end(`${largePrompt}\n/model qwen/tiny\nsecond prompt\n`);

    // Then
    await session;
    expect(stderr).toContain("Context compacted: model switch");
    expect(stdout).toContain("Model switched to qwen/tiny");
    expect(stdout).toContain("old provider 1");
    expect(stdout).toContain("target provider 1");
    expect(oldProviderTurns).toBe(1);
    expect(oldProviderSummaryRequests).toBe(1);
    expect(targetProviderTurns).toBe(1);
    expect(targetProviderSummaryRequests).toBe(0);
    expect(targetRequestContexts).toHaveLength(1);
    expect(targetRequestContexts[0]).toEqual([
      {
        role: "user",
        content: expect.stringContaining("<conversation-checkpoint>"),
      },
      { role: "user", content: "second prompt" },
    ]);
    expect(targetRequestContexts[0]?.[0]?.content).toContain(
      "Downshift checkpoint summary.",
    );
    expect(JSON.stringify(targetRequestContexts[0])).not.toContain("/model");
    expect(sigintHandlers.size).toBe(0);
  });

  test.each([
    {
      mode: "max-cost metered",
      cliArgs: { bashMode: "disabled" as const, maxCostUsd: 1 },
      expectsCostOutput: true,
    },
    {
      mode: "report-only metered",
      cliArgs: { bashMode: "disabled" as const, reportFile: "session.json" },
      expectsCostOutput: false,
    },
    {
      mode: "unmetered",
      cliArgs: { bashMode: "disabled" as const },
      expectsCostOutput: false,
    },
  ])(`Given $mode model-switch compaction fails,
    When user enters /model for a smaller target,
    Then the old provider remains active and the transcript is unchanged`, async ({
    cliArgs,
    expectsCostOutput,
  }) => {
    // Given
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    let stdout = "";
    let stderr = "";
    let oldProviderTurns = 0;
    let oldProviderSummaryRequests = 0;
    let targetProviderTurns = 0;
    const oldRequestContexts: Message[][] = [];
    const persistedReasons: string[] = [];
    const largePrompt = "large history ".repeat(3_000).trim();
    const oldProvider: LLMProvider = withProviderRequestAttemptAccounting({
      id: "fake",
      async *stream(options) {
        if (options.toolChoice === "none") {
          oldProviderSummaryRequests++;
          yield {
            type: "text",
            text: "Partial model-switch checkpoint that must not commit",
          };
          yield { type: "stop", reason: "length", usage: ZERO_USAGE };
          return;
        }
        oldProviderTurns++;
        oldRequestContexts.push(structuredClone([...options.messages]));
        yield { type: "text", text: `old provider ${oldProviderTurns}` };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    });
    const targetProvider: LLMProvider = {
      id: "fake",
      async *stream() {
        targetProviderTurns++;
        yield { type: "text", text: "unexpected target" };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const session = runInteractiveSession({
      cliArgs,
      workspace: process.cwd(),
      platform: process.platform,
      session: savedInteractiveSession({
        id: "test-session",
        persistMessages: ({ messages: _messages, reason }) => {
          persistedReasons.push(reason);
        },
        persistModelSwitch: () => {
          throw new Error("rejected model switch must not persist");
        },
      }),
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
            selection.model ?? "tiny",
            targetProvider,
            ZERO_COST_MODEL,
            {
              contextWindowTokens: 2_000,
              reserveTokens: 0,
              keepRecentTokens: 1,
            },
          );
        }
        return resolvedProvider("fake", "fake", oldProvider);
      },
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
      formatCostReport: () => "Rejected compaction cost recorded.\n",
    });

    // When
    input.end(`${largePrompt}\n/model qwen/tiny\nsecond prompt\n`);

    // Then
    await session;
    expect(stderr).toContain(
      "Context compaction failed: fake returned length-truncated context compaction summaries after 1 attempt.",
    );
    expect(stderr.includes("Rejected compaction cost recorded.")).toBe(
      expectsCostOutput,
    );
    expect(stdout).toContain("old provider 1");
    expect(stdout).toContain("old provider 2");
    expect(stdout).not.toContain("unexpected target");
    expect(oldProviderTurns).toBe(2);
    expect(oldProviderSummaryRequests).toBe(1);
    expect(targetProviderTurns).toBe(0);
    expect(oldRequestContexts).toHaveLength(2);
    expect(oldRequestContexts[1]).toEqual([
      { role: "user", content: largePrompt },
      { role: "assistant", content: "old provider 1", toolCalls: [] },
      { role: "user", content: "second prompt" },
    ]);
    expect(JSON.stringify(oldRequestContexts[1])).not.toContain(
      "Partial model-switch checkpoint that must not commit",
    );
    expect(persistedReasons).not.toContain("compaction");
    expect(sigintHandlers.size).toBe(0);
  });

  test.each([
    {
      mode: "metered",
      cliArgs: { bashMode: "disabled" as const, reportFile: "session.json" },
      expectedUsage: {
        inputTokens: 8,
        cachedInputTokens: 0,
        uncachedInputTokens: 8,
        outputTokens: 2,
      },
    },
    {
      mode: "unmetered",
      cliArgs: { bashMode: "disabled" as const },
      expectedUsage: undefined,
    },
  ])(`Given $mode model-switch compaction completes after interruption,
    When the provider returns its billed result,
    Then Keel rolls back the switch and records usage only when metering is active`, async ({
    cliArgs,
    expectedUsage,
  }) => {
    // Given
    const initialMessages: readonly Message[] = [
      { role: "user", content: "large history ".repeat(3_000).trim() },
      { role: "assistant", content: "old provider answer", toolCalls: [] },
    ];
    let receiveSummaryRequest: () => void = () => {};
    const summaryRequested = new Promise<void>((resolve) => {
      receiveSummaryRequest = resolve;
    });
    let targetProviderTurns = 0;
    const currentProvider = withProviderRequestAttemptAccounting({
      id: "fake",
      async *stream(options) {
        receiveSummaryRequest();
        if (!options.signal.aborted) {
          await new Promise<void>((resolve) => {
            options.signal.addEventListener("abort", () => resolve(), {
              once: true,
            });
          });
        }
        yield { type: "text", text: "Cancelled model-switch checkpoint" };
        yield {
          type: "stop",
          reason: "stop",
          usage: {
            inputTokens: 8,
            cachedInputTokens: 0,
            uncachedInputTokens: 8,
            outputTokens: 2,
          },
        };
      },
    });
    const targetProvider: LLMProvider = {
      id: "fake",
      async *stream() {
        targetProviderTurns++;
        yield { type: "text", text: "unexpected target" };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    const persistedReasons: string[] = [];
    const session = runInteractiveSession({
      cliArgs,
      workspace: process.cwd(),
      platform: process.platform,
      session: savedInteractiveSession({
        id: "test-session",
        persistMessages: ({ messages: _messages, reason }) => {
          persistedReasons.push(reason);
        },
        persistModelSwitch: () => {
          throw new Error("interrupted model switch must not persist");
        },
      }),
      initialMessages,
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
      resolveProvider: (_message, selection?: ProviderSelection) =>
        selection?.providerId === "qwen"
          ? resolvedProvider(
              "qwen",
              selection.model ?? "tiny",
              targetProvider,
              ZERO_COST_MODEL,
              {
                contextWindowTokens: 2_000,
                reserveTokens: 0,
                keepRecentTokens: 1,
              },
            )
          : resolvedProvider("fake", "fake", currentProvider),
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async () => {
        throw new Error(
          "interrupted model switch must not start an agent turn",
        );
      },
      formatCostReport: () => "",
    });

    // When
    input.write("/model qwen/tiny\n");
    await withTimeout(summaryRequested, 5_000, "summary did not start");
    for (const handler of [...sigintHandlers]) {
      handler();
    }
    input.end();

    // Then
    const result = await withTimeout(session, 5_000, "session did not end");
    expect(result.report?.end.usage).toEqual(expectedUsage);
    expect(targetProviderTurns).toBe(0);
    expect(persistedReasons).not.toContain("compaction");
    expect(sigintHandlers.size).toBe(0);
  });

  test(`Given a billed model-switch summary is truncated before its retry exhausts the cost budget,
    When the retry is denied admission,
    Then Keel rejects the switch and reports the completed attempt as budget-limited`, async () => {
    // Given
    const initialMessages: readonly Message[] = [
      { role: "user", content: "Remember alpha." },
      { role: "assistant", content: "Alpha recorded.", toolCalls: [] },
      { role: "user", content: "Remember beta." },
      { role: "assistant", content: "Beta recorded.", toolCalls: [] },
      { role: "user", content: "Remember gamma." },
      { role: "assistant", content: "Gamma recorded.", toolCalls: [] },
    ];
    let summaryRequests = 0;
    let targetProviderTurns = 0;
    let stderr = "";
    const currentProvider = withProviderRequestAttemptAccounting({
      id: "fake",
      estimateInputTokens: () => 1,
      async *stream() {
        summaryRequests++;
        yield { type: "text", text: "Billed partial model-switch checkpoint" };
        yield {
          type: "stop",
          reason: "length",
          usage: {
            inputTokens: 2_000,
            cachedInputTokens: 0,
            uncachedInputTokens: 2_000,
            outputTokens: 1,
          },
        };
      },
    });
    const targetProvider: LLMProvider = {
      id: "fake",
      async *stream() {
        targetProviderTurns++;
        yield { type: "text", text: "unexpected target" };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const input = new PassThrough();
    const session = runInteractiveSession({
      cliArgs: {
        bashMode: "disabled",
        maxCostUsd: 0.001,
        reportFile: "session.json",
      },
      workspace: process.cwd(),
      platform: process.platform,
      session: savedInteractiveSession({
        id: "test-session",
        persistModelSwitch: () => {
          throw new Error("budget-limited switch must not persist");
        },
      }),
      initialMessages,
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
      resolveProvider: (_message, selection?: ProviderSelection) =>
        selection?.providerId === "qwen"
          ? resolvedProvider(
              "qwen",
              selection.model ?? "tiny",
              targetProvider,
              ONE_DOLLAR_PER_MILLION_INPUT,
              { contextWindowTokens: 1, reserveTokens: 0, keepRecentTokens: 1 },
            )
          : resolvedProvider("fake", "fake", currentProvider),
      requireKnownCostModel: () => ONE_DOLLAR_PER_MILLION_INPUT,
      printAgentEvents: async () => {
        throw new Error("budget-limited switch must not start an agent turn");
      },
      formatCostReport: (cost, maxUsd) =>
        `Cost: ${cost.spentUsd.toFixed(3)} / ${maxUsd.toFixed(3)} limited=${cost.budgetLimited}\n`,
    });

    // When
    input.end("/model qwen/tiny\n");

    // Then
    const result = await session;
    expect(summaryRequests).toBe(1);
    expect(targetProviderTurns).toBe(0);
    expect(stderr).toContain("Cost: 0.002 / 0.001 limited=true");
    expect(result.report?.end.stopReason).toBe("cost_budget");
    expect(result.report?.end.usage.inputTokens).toBe(2_000);
  });

  test(`Given model-switch compaction still exceeds the target context window,
    When user enters /model for that target,
    Then the switch is rejected and the old provider remains active`, async () => {
    // Given
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    let stdout = "";
    let stderr = "";
    let oldProviderTurns = 0;
    let oldProviderSummaryRequests = 0;
    let targetProviderTurns = 0;
    const oldRequestContexts: Message[][] = [];
    const largePrompt = "large history ".repeat(3_000).trim();
    const oldProvider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        if (options.toolChoice === "none") {
          oldProviderSummaryRequests++;
          yield { type: "text", text: "Still too large summary." };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        oldProviderTurns++;
        oldRequestContexts.push(structuredClone([...options.messages]));
        yield { type: "text", text: `old provider ${oldProviderTurns}` };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const targetProvider: LLMProvider = {
      id: "fake",
      async *stream() {
        targetProviderTurns++;
        yield { type: "text", text: "unexpected target" };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
      platform: process.platform,
      session: EPHEMERAL_INTERACTIVE_SESSION,
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
            selection.model ?? "tiny",
            targetProvider,
            ZERO_COST_MODEL,
            { contextWindowTokens: 1, reserveTokens: 0, keepRecentTokens: 1 },
          );
        }
        return resolvedProvider("fake", "fake", oldProvider);
      },
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
    input.end(`${largePrompt}\n/model qwen/tiny\nsecond prompt\n`);

    // Then
    await session;
    expect(stderr).toContain(
      "still exceeds the target context window after model-switch compaction",
    );
    expect(stdout).toContain("old provider 1");
    expect(stdout).toContain("old provider 2");
    expect(stdout).not.toContain("unexpected target");
    expect(oldProviderTurns).toBe(2);
    expect(oldProviderSummaryRequests).toBe(1);
    expect(targetProviderTurns).toBe(0);
    expect(oldRequestContexts).toHaveLength(2);
    expect(oldRequestContexts[1]).toEqual([
      { role: "user", content: largePrompt },
      { role: "assistant", content: "old provider 1", toolCalls: [] },
      { role: "user", content: "second prompt" },
    ]);
    expect(sigintHandlers.size).toBe(0);
  });

  test(`Given model-switch compaction artifact-backs retained stale tool output,
    When user switches model and continues,
    Then the target model response is based on the newly retained artifact handle`, async () => {
    // Given
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    const largeToolOutput = [
      "MODEL_SWITCH_LOG_START",
      "model switch log line ".repeat(5_000),
      "MODEL_SWITCH_LOG_END",
    ].join("\n");
    const initialMessages: readonly Message[] = [
      { role: "user", content: "Remember the setup." },
      { role: "assistant", content: "Setup remembered.", toolCalls: [] },
      { role: "user", content: "Read the old report." },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "read_model_switch_report",
            tool: "read",
            path: "model-switch-report.log",
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "read_model_switch_report",
        content: largeToolOutput,
      },
      {
        role: "assistant",
        content: "The model switch report was inspected.",
        toolCalls: [],
      },
      { role: "user", content: "Continue later." },
    ];
    const saved: ToolOutputArtifactSaveInput[] = [];
    const store: ToolOutputArtifactStore = {
      verifyReusable: async () => ({ status: "not_reusable" }),
      save: async (input) => {
        const ref = `tool-output:test/${saved.length + 1}`;
        saved.push(input);
        return { status: "stored", ref, contentSha256: "0".repeat(64) };
      },
      discard: async () => {
        saved.pop();
      },
    };
    let stdout = "";
    let stderr = "";
    let currentSummaryRequests = 0;
    let targetTurns = 0;
    const currentProvider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        expect(options.toolChoice).toBe("none");
        currentSummaryRequests++;
        yield { type: "text", text: "Model switch artifact summary." };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const targetProvider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        if (options.toolChoice === "none") {
          yield { type: "text", text: "unexpected target summary" };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        targetTurns++;
        const context = JSON.stringify(options.messages);
        const evidenceSurvived =
          context.includes("<conversation-checkpoint>") &&
          context.includes("tool-output:test/1") &&
          context.includes("keel artifacts show tool-output:test/1");
        yield {
          type: "text",
          text: evidenceSurvived
            ? "Target artifact handle survived."
            : "Target artifact handle missing.",
        };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
      platform: process.platform,
      session: EPHEMERAL_INTERACTIVE_SESSION,
      initialMessages,
      toolOutputArtifacts: { store },
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
            selection.model ?? "tiny",
            targetProvider,
            ZERO_COST_MODEL,
            {
              contextWindowTokens: 20_000,
              reserveTokens: 0,
              keepRecentTokens: 100_000,
              toolOutputMaxChars: 128,
            },
          );
        }
        return resolvedProvider("fake", "fake", currentProvider);
      },
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
    input.end("/model qwen/tiny\ncontinue on target\n");

    // Then
    await session;
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      toolCallId: "read_model_switch_report",
      toolName: "read",
      purpose: "stale-compaction",
      content: largeToolOutput,
    });
    expect(stderr).toContain("Context compacted: model switch");
    expect(stderr).toContain(
      "Tool output artifact: tool-output:test/1 (keel artifacts show tool-output:test/1)",
    );
    expect(stdout).toContain("Model switched to qwen/tiny");
    expect(stdout).toContain("Target artifact handle survived.");
    expect(currentSummaryRequests).toBe(1);
    expect(targetTurns).toBe(1);
    expect(sigintHandlers.size).toBe(0);
  });

  test(`Given model-switch compaction summarizes artifact-backed tool output,
    When user switches model and continues,
    Then the target model response is based on the retained evidence handle`, async () => {
    // Given
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    const artifactRef = "tool-output:model-switch/report";
    const previewContent = "model switch report line\n".repeat(300).trimEnd();
    const artifact = verifiedToolOutputArtifactFixture({
      ref: artifactRef,
      toolCallId: "read_model_switch_report",
      previewContent,
      omittedChars: 90_000,
      sourceStatus: "complete",
    });
    const initialMessages: readonly Message[] = [
      { role: "user", content: "Read the old report." },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "read_model_switch_report",
            tool: "read",
            path: "model-switch-report.log",
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "read_model_switch_report",
        content: `${previewContent}\n${artifact.marker}`,
      },
      {
        role: "assistant",
        content: "The model switch report was inspected.",
        toolCalls: [],
      },
      { role: "user", content: "Continue later." },
    ];
    let stdout = "";
    let stderr = "";
    let currentSummaryRequests = 0;
    let targetTurns = 0;
    const currentProvider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        expect(options.toolChoice).toBe("none");
        currentSummaryRequests++;
        yield {
          type: "text",
          text: "Model switch summary that omits the artifact ref.",
        };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const targetProvider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        if (options.toolChoice === "none") {
          yield { type: "text", text: "unexpected target summary" };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        targetTurns++;
        const context = JSON.stringify(options.messages);
        const evidenceSurvived =
          context.includes("<conversation-checkpoint>") &&
          context.includes("Evidence retained:") &&
          context.includes(artifactRef) &&
          context.includes(`inspect: keel artifacts show ${artifactRef}`);
        yield {
          type: "text",
          text: evidenceSurvived
            ? "Target evidence survived."
            : "Target evidence missing.",
        };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
      platform: process.platform,
      session: EPHEMERAL_INTERACTIVE_SESSION,
      initialMessages,
      toolOutputArtifacts: { store: artifact.store },
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
            selection.model ?? "tiny",
            targetProvider,
            ZERO_COST_MODEL,
            {
              contextWindowTokens: 1_000,
              reserveTokens: 0,
              keepRecentTokens: 1,
              toolOutputMaxChars: 128,
            },
          );
        }
        return resolvedProvider("fake", "fake", currentProvider);
      },
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
    input.end("/model qwen/tiny\ncontinue on target\n");

    // Then
    await session;
    expect(stderr).toContain("Context compacted: model switch");
    expect(stdout).toContain("Model switched to qwen/tiny");
    expect(stdout).toContain("Target evidence survived.");
    expect(currentSummaryRequests).toBe(1);
    expect(targetTurns).toBe(1);
    expect(sigintHandlers.size).toBe(0);
  });
});
