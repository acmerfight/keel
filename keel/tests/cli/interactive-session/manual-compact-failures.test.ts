import { PassThrough } from "node:stream";
import { describe, expect, test } from "vitest";
import type { AgentEvent } from "../../../src/agent/events.ts";
import type { LLMProvider, Message } from "../../../src/llm/types.ts";
import {
  EPHEMERAL_INTERACTIVE_SESSION,
  ForcedExit,
  ONE_DOLLAR_PER_MILLION_INPUT,
  runInteractiveSessionWithoutMemory as runInteractiveSession,
  savedInteractiveSession,
  withProviderRequestAttemptAccounting,
  withTimeout,
  ZERO_COST_MODEL,
  ZERO_USAGE,
} from "../../../src/testing/interactive-session-fixtures.ts";

describe("Interactive Session - Manual Compact Failures", () => {
  test(`Given an interactive session has prior history,
    When user enters /compact with a whitespace-separated focus instruction,
    Then the instruction is included in the summary prompt but not appended as a task`, async () => {
    // Given
    const focusInstruction =
      "keep the root cause, files changed, failed tests, and next steps";
    let receiveFirstEnd: () => void = () => {};
    const firstTurnEnded = new Promise<void>((resolve) => {
      receiveFirstEnd = resolve;
    });
    const observedRequestContexts: Message[][] = [];
    let summaryPrompt = "";
    let requestTurn = 0;
    const provider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        if (options.toolExposure?.kind === "none") {
          summaryPrompt = options.messages[0]?.content ?? "";
          yield { type: "text", text: "Focused checkpoint summary." };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }

        requestTurn++;
        observedRequestContexts.push(structuredClone([...options.messages]));
        yield {
          type: "text",
          text: requestTurn === 1 ? "First done" : "Second done",
        };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const input = new PassThrough();
    let stdout = "";
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
      platform: process.platform,
      session: EPHEMERAL_INTERACTIVE_SESSION,
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
        contextCompaction: { keepRecentTokens: 1 },
      }),
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async (stream) => {
        let finalEnd: Extract<AgentEvent, { readonly type: "end" }> | undefined;
        for await (const event of stream) {
          if (event.type === "text") {
            stdout += event.text;
          } else if (event.type === "end") {
            finalEnd = event;
            if (requestTurn === 1) {
              receiveFirstEnd();
            }
          }
        }
        return finalEnd;
      },
      formatCostReport: () => "",
    });

    // When
    input.write("first prompt\n");
    await withTimeout(firstTurnEnded, 5000, "first turn did not finish");
    input.write(`/compact\t${focusInstruction}\n`);
    input.write("second prompt\n");
    input.end();

    // Then
    await session;
    expect(stdout).toBe("First done\nSecond done\n");
    expect(summaryPrompt).toContain(focusInstruction);
    expect(JSON.stringify(observedRequestContexts[1])).not.toContain(
      "/compact",
    );
    expect(observedRequestContexts[1]).toEqual([
      {
        role: "user",
        content: expect.stringContaining("<conversation-checkpoint>"),
      },
      { role: "user", content: "second prompt" },
    ]);
  });

  test(`Given an interactive session has prior history,
    When user enters /compact with only surrounding whitespace,
    Then compaction runs without a focus instruction`, async () => {
    // Given
    let receiveFirstEnd: () => void = () => {};
    const firstTurnEnded = new Promise<void>((resolve) => {
      receiveFirstEnd = resolve;
    });
    const observedRequestContexts: Message[][] = [];
    let summaryPrompt = "";
    let requestTurn = 0;
    const provider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        if (options.toolExposure?.kind === "none") {
          summaryPrompt = options.messages[0]?.content ?? "";
          yield { type: "text", text: "Whitespace checkpoint summary." };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }

        requestTurn++;
        observedRequestContexts.push(structuredClone([...options.messages]));
        yield {
          type: "text",
          text: requestTurn === 1 ? "First done" : "Second done",
        };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const input = new PassThrough();
    let stdout = "";
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
      platform: process.platform,
      session: EPHEMERAL_INTERACTIVE_SESSION,
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
        contextCompaction: { keepRecentTokens: 1 },
      }),
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async (stream) => {
        let finalEnd: Extract<AgentEvent, { readonly type: "end" }> | undefined;
        for await (const event of stream) {
          if (event.type === "text") {
            stdout += event.text;
          } else if (event.type === "end") {
            finalEnd = event;
            if (requestTurn === 1) {
              receiveFirstEnd();
            }
          }
        }
        return finalEnd;
      },
      formatCostReport: () => "",
    });

    // When
    input.write("first prompt\n");
    await withTimeout(firstTurnEnded, 5000, "first turn did not finish");
    input.write("   /compact      \n");
    input.write("second prompt\n");
    input.end();

    // Then
    await session;
    expect(stdout).toBe("First done\nSecond done\n");
    expect(summaryPrompt).not.toContain("manual compaction focus");
    expect(observedRequestContexts[1]).toEqual([
      {
        role: "user",
        content: expect.stringContaining("<conversation-checkpoint>"),
      },
      { role: "user", content: "second prompt" },
    ]);
  });

  test(`Given an interactive session has no prior history,
    When user enters /compact,
    Then compaction is skipped without corrupting the next prompt`, async () => {
    // Given
    const observedRequestContexts: Message[][] = [];
    let resolvedProviders = 0;
    const provider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        observedRequestContexts.push(structuredClone([...options.messages]));
        yield { type: "text", text: "Hello done" };
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
      session: EPHEMERAL_INTERACTIVE_SESSION,
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
      resolveProvider: () => {
        resolvedProviders++;
        return {
          provider,
          providerId: "fake",
          model: "fake",
          costModel: ZERO_COST_MODEL,
          contextCompaction: { keepRecentTokens: 1 },
        };
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
    input.write("/compact\n");
    input.write("hello\n");
    input.end();

    // Then
    await session;
    expect(stdout).toBe("Hello done\n");
    expect(stderr).toContain("Context compaction skipped");
    expect(resolvedProviders).toBe(1);
    expect(observedRequestContexts).toEqual([
      [{ role: "user", content: "hello" }],
    ]);
  });

  test(`Given an interactive session has only an unsplittable prior prompt,
    When user enters /compact,
    Then compaction is skipped without changing the history`, async () => {
    // Given
    let receiveFirstEnd: () => void = () => {};
    const firstTurnEnded = new Promise<void>((resolve) => {
      receiveFirstEnd = resolve;
    });
    const observedRequestContexts: Message[][] = [];
    let requestTurn = 0;
    const provider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        requestTurn++;
        observedRequestContexts.push(structuredClone([...options.messages]));
        if (requestTurn === 1) {
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        yield { type: "text", text: "Second done" };
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
      session: EPHEMERAL_INTERACTIVE_SESSION,
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
        contextCompaction: { keepRecentTokens: 1 },
      }),
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async (stream) => {
        let finalEnd: Extract<AgentEvent, { readonly type: "end" }> | undefined;
        for await (const event of stream) {
          if (event.type === "text") {
            stdout += event.text;
          } else if (event.type === "end") {
            finalEnd = event;
            if (requestTurn === 1) {
              receiveFirstEnd();
            }
          }
        }
        return finalEnd;
      },
      formatCostReport: () => "",
    });

    // When
    input.write("first prompt\n");
    await withTimeout(firstTurnEnded, 5000, "first turn did not finish");
    input.write("/compact\n");
    input.write("second prompt\n");
    input.end();

    // Then
    await session;
    expect(stdout).toBe("\nSecond done\n");
    expect(stderr).toContain("Context compaction skipped");
    expect(observedRequestContexts).toEqual([
      [{ role: "user", content: "first prompt" }],
      [
        { role: "user", content: "first prompt" },
        { role: "user", content: "second prompt" },
      ],
    ]);
  });

  test(`Given manual compaction summary fails,
    When user sends another prompt,
    Then the session reports failure and keeps the original history`, async () => {
    // Given
    let receiveFirstEnd: () => void = () => {};
    const firstTurnEnded = new Promise<void>((resolve) => {
      receiveFirstEnd = resolve;
    });
    const observedRequestContexts: Message[][] = [];
    let requestTurn = 0;
    const provider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        if (options.toolExposure?.kind === "none") {
          throw new Error("summary\n\u001b[31m exploded");
        }

        requestTurn++;
        observedRequestContexts.push(structuredClone([...options.messages]));
        yield {
          type: "text",
          text: requestTurn === 1 ? "First done" : "Second done",
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
      session: EPHEMERAL_INTERACTIVE_SESSION,
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
        contextCompaction: { keepRecentTokens: 1 },
      }),
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async (stream) => {
        let finalEnd: Extract<AgentEvent, { readonly type: "end" }> | undefined;
        for await (const event of stream) {
          if (event.type === "text") {
            stdout += event.text;
          } else if (event.type === "end") {
            finalEnd = event;
            if (requestTurn === 1) {
              receiveFirstEnd();
            }
          }
        }
        return finalEnd;
      },
      formatCostReport: () => "",
    });

    // When
    input.write("first prompt\n");
    await withTimeout(firstTurnEnded, 5000, "first turn did not finish");
    input.write("/compact\n");
    input.write("second prompt\n");
    input.end();

    // Then
    await session;
    expect(stdout).toBe("First done\nSecond done\n");
    expect(stderr).toContain(
      "Context compaction failed: summary\\n\\x1b[31m exploded",
    );
    expect(observedRequestContexts[1]).toEqual([
      { role: "user", content: "first prompt" },
      { role: "assistant", content: "First done", toolCalls: [] },
      { role: "user", content: "second prompt" },
    ]);
  });

  test(`Given manual compaction repeatedly returns a length-truncated summary,
    When user continues the saved session,
    Then Keel reports failure without replacing or persisting the original history`, async () => {
    // Given
    const initialMessages: readonly Message[] = [
      { role: "user", content: "Remember constraint alpha." },
      {
        role: "assistant",
        content: "Constraint alpha recorded.",
        toolCalls: [],
      },
      { role: "user", content: "Remember decision beta." },
      { role: "assistant", content: "Decision beta recorded.", toolCalls: [] },
      { role: "user", content: "Remember evidence gamma." },
      { role: "assistant", content: "Evidence gamma recorded.", toolCalls: [] },
    ];
    const observedRequestContexts: Message[][] = [];
    const persistedReasons: string[] = [];
    let summaryRequests = 0;
    const provider: LLMProvider = withProviderRequestAttemptAccounting({
      id: "fake",
      async *stream(options) {
        if (options.toolExposure?.kind === "none") {
          summaryRequests++;
          yield {
            type: "text",
            text: "Partial checkpoint that must not persist",
          };
          yield {
            type: "stop",
            reason: "length",
            usage: {
              inputTokens: 10,
              cachedInputTokens: 0,
              uncachedInputTokens: 10,
              outputTokens: 2,
            },
          };
          return;
        }
        observedRequestContexts.push(structuredClone([...options.messages]));
        yield { type: "text", text: "Second done" };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    });
    const input = new PassThrough();
    let stdout = "";
    let stderr = "";
    const session = runInteractiveSession({
      cliArgs: {
        bashMode: "disabled",
        maxCostUsd: 1,
        reportFile: "session.json",
      },
      workspace: process.cwd(),
      platform: process.platform,
      session: savedInteractiveSession({
        id: "test-session",
        persistMessages: ({ messages: _messages, reason }) => {
          persistedReasons.push(reason);
        },
      }),
      initialMessages,
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
        contextCompaction: { keepRecentTokens: 1 },
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
      formatCostReport: () => "Compaction cost recorded.\n",
    });

    // When
    input.end("/compact\nsecond prompt\n");

    // Then
    const result = await session;
    expect(stdout).toBe("Second done\n");
    expect(stderr).toContain(
      "Context compaction failed: fake returned length-truncated context compaction summaries after 2 attempts.",
    );
    expect(stderr).toContain("Compaction cost recorded.");
    expect(summaryRequests).toBe(2);
    expect(persistedReasons).not.toContain("compaction");
    expect(observedRequestContexts).toEqual([
      [...initialMessages, { role: "user", content: "second prompt" }],
    ]);
    expect(JSON.stringify(observedRequestContexts)).not.toContain(
      "Partial checkpoint that must not persist",
    );
    expect(result.report?.end.usage).toEqual({
      inputTokens: 20,
      cachedInputTokens: 0,
      uncachedInputTokens: 20,
      outputTokens: 4,
    });
    expect(result.report?.modelOperations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          purpose: "manual_compaction",
          outcome: "terminal_error",
          usage: {
            inputTokens: 20,
            cachedInputTokens: 0,
            uncachedInputTokens: 20,
            outputTokens: 4,
          },
          providerRequestAttempts: [
            expect.objectContaining({ outcome: "completed" }),
            expect.objectContaining({ outcome: "completed" }),
          ],
        }),
      ]),
    );
  });

  test.each([
    {
      mode: "unmetered",
      cliArgs: { bashMode: "disabled" as const },
      expectedCostModelResolutions: 0,
      expectsReport: false,
    },
    {
      mode: "report-only metered",
      cliArgs: { bashMode: "disabled" as const, reportFile: "session.json" },
      expectedCostModelResolutions: 2,
      expectsReport: true,
    },
  ])(
    `Given $mode manual compaction returns a truncated summary,
    When the command finishes,
    Then Keel rejects the checkpoint with the configured usage accounting`,
    async ({ cliArgs, expectedCostModelResolutions, expectsReport }) => {
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
      let costModelResolutions = 0;
      let stderr = "";
      const provider: LLMProvider = {
        id: "fake",
        async *stream() {
          summaryRequests++;
          yield { type: "text", text: "Unmetered partial checkpoint" };
          yield { type: "stop", reason: "length", usage: ZERO_USAGE };
        },
      };
      const input = new PassThrough();
      const session = runInteractiveSession({
        cliArgs,
        workspace: process.cwd(),
        platform: process.platform,
        session: EPHEMERAL_INTERACTIVE_SESSION,
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
        resolveProvider: () => ({
          provider,
          providerId: "fake",
          model: "fake",
          costModel: ZERO_COST_MODEL,
          contextCompaction: { keepRecentTokens: 1 },
        }),
        requireKnownCostModel: () => {
          costModelResolutions++;
          return ZERO_COST_MODEL;
        },
        printAgentEvents: async () => {
          throw new Error("manual compaction must not start an agent turn");
        },
        formatCostReport: () => {
          throw new Error("unmetered compaction must not format cost");
        },
      });

      // When
      input.end("/compact\n");

      // Then
      const result = await session;
      expect(summaryRequests).toBe(2);
      expect(costModelResolutions).toBe(expectedCostModelResolutions);
      expect(stderr).toContain("length-truncated context compaction summaries");
      expect(result.report !== undefined).toBe(expectsReport);
    },
  );

  test(`Given a billed manual summary is truncated before its retry exhausts the cost budget,
    When the retry is denied admission,
    Then Keel records the first attempt and rejects the checkpoint as budget-limited`, async () => {
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
    let stderr = "";
    const provider = withProviderRequestAttemptAccounting({
      id: "fake",
      estimateInputTokens: () => 1,
      async *stream() {
        summaryRequests++;
        yield { type: "text", text: "Billed partial checkpoint" };
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
    const input = new PassThrough();
    const session = runInteractiveSession({
      cliArgs: {
        bashMode: "disabled",
        maxCostUsd: 0.001,
        reportFile: "session.json",
      },
      workspace: process.cwd(),
      platform: process.platform,
      session: EPHEMERAL_INTERACTIVE_SESSION,
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
      resolveProvider: () => ({
        provider,
        providerId: "fake",
        model: "fake",
        costModel: ONE_DOLLAR_PER_MILLION_INPUT,
        contextCompaction: { keepRecentTokens: 1 },
      }),
      requireKnownCostModel: () => ONE_DOLLAR_PER_MILLION_INPUT,
      printAgentEvents: async () => {
        throw new Error(
          "budget-limited compaction must not start an agent turn",
        );
      },
      formatCostReport: (cost) =>
        `Cost: ${cost.spentUsd.toFixed(3)} / ${
          cost.budget.kind === "unbounded"
            ? "unbounded"
            : cost.budget.maxUsd.toFixed(3)
        } limited=${cost.budget.kind === "budget_limited"}\n`,
    });

    // When
    input.end("/compact\n");

    // Then
    const result = await session;
    expect(summaryRequests).toBe(1);
    expect(stderr).toContain("Cost: 0.002 / 0.001 limited=true");
    expect(stderr).not.toContain("Billed partial checkpoint");
    expect(result.report?.end.stopReason).toBe("cost_budget");
    expect(result.report?.end.usage.inputTokens).toBe(2_000);
  });

  test(`Given a billed manual compaction result arrives after interruption,
    When user sends another prompt,
    Then the session restores original history, drops the cancelled checkpoint, and records usage`, async () => {
    // Given
    let receiveFirstEnd: () => void = () => {};
    const firstTurnEnded = new Promise<void>((resolve) => {
      receiveFirstEnd = resolve;
    });
    let receiveSummaryRequest: () => void = () => {};
    const summaryRequested = new Promise<void>((resolve) => {
      receiveSummaryRequest = resolve;
    });
    const observedRequestContexts: Message[][] = [];
    const compactionPrompts: string[] = [];
    let requestTurn = 0;
    const provider: LLMProvider = withProviderRequestAttemptAccounting({
      id: "fake",
      async *stream(options) {
        if (options.toolExposure?.kind === "none") {
          compactionPrompts.push(options.messages[0]?.content ?? "");
          receiveSummaryRequest();
          if (!options.signal.aborted) {
            await new Promise<void>((resolve) => {
              options.signal.addEventListener("abort", () => resolve(), {
                once: true,
              });
            });
          }
          yield { type: "text", text: "Cancelled manual summary." };
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
          return;
        }

        requestTurn++;
        observedRequestContexts.push(structuredClone([...options.messages]));
        yield {
          type: "text",
          text: requestTurn === 1 ? "First done" : "Second done",
        };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    });
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    let stdout = "";
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled", reportFile: "session.json" },
      workspace: process.cwd(),
      platform: process.platform,
      session: EPHEMERAL_INTERACTIVE_SESSION,
      input,
      writeStdout: (text) => {
        stdout += text;
      },
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
        contextCompaction: { keepRecentTokens: 1 },
      }),
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async (stream) => {
        let finalEnd: Extract<AgentEvent, { readonly type: "end" }> | undefined;
        for await (const event of stream) {
          if (event.type === "text") {
            stdout += event.text;
          } else if (event.type === "end") {
            finalEnd = event;
            if (requestTurn === 1) {
              receiveFirstEnd();
            }
          }
        }
        return finalEnd;
      },
      formatCostReport: () => "",
    });

    // When
    input.write("first prompt\n");
    await withTimeout(firstTurnEnded, 5000, "first turn did not finish");
    input.write("/compact\n");
    await withTimeout(summaryRequested, 5000, "manual summary did not start");
    for (const handler of [...sigintHandlers]) {
      handler();
    }
    input.write("second prompt\n");
    input.end();

    // Then
    const result = await session;
    expect(stdout).toBe("First done\n\nSecond done\n");
    expect(compactionPrompts).toHaveLength(1);
    expect(observedRequestContexts[1]).toEqual([
      { role: "user", content: "first prompt" },
      { role: "assistant", content: "First done", toolCalls: [] },
      { role: "user", content: "second prompt" },
    ]);
    expect(JSON.stringify(observedRequestContexts[1])).not.toContain(
      "<conversation-checkpoint>",
    );
    expect(JSON.stringify(observedRequestContexts[1])).not.toContain(
      "/compact",
    );
    expect(result.report?.end.usage).toEqual({
      inputTokens: 8,
      cachedInputTokens: 0,
      uncachedInputTokens: 8,
      outputTokens: 2,
    });
  });

  test(`Given queued manual compaction is interrupted,
    When the session exits,
    Then the queued command is consumed instead of replaying`, async () => {
    // Given
    const initialMessages: readonly Message[] = [
      { role: "user", content: "first prompt" },
      { role: "assistant", content: "First done", toolCalls: [] },
    ];
    let receiveSummaryRequest: () => void = () => {};
    const summaryRequested = new Promise<void>((resolve) => {
      receiveSummaryRequest = resolve;
    });
    const provider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        if (options.toolExposure?.kind !== "none") {
          throw new Error("queued manual compaction should not start a turn");
        }
        receiveSummaryRequest();
        if (!options.signal.aborted) {
          await new Promise<void>((resolve) => {
            options.signal.addEventListener("abort", () => resolve(), {
              once: true,
            });
          });
        }
        yield { type: "text", text: "Cancelled queued summary." };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    const consumedInputIds: string[][] = [];
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
      platform: process.platform,
      session: savedInteractiveSession({
        id: "test-session",
        consumeQueuedInputs: (inputIds) => {
          consumedInputIds.push([...inputIds]);
        },
        persistMessages: () => {
          throw new Error("interrupted queued compaction should not persist");
        },
      }),
      initialMessages,
      initialQueuedInputs: [
        {
          id: "queued-compact",
          timestamp: "1970-01-01T00:00:00.001Z",
          sequence: 9,
          line: "/compact",
        },
      ],
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
        contextCompaction: { keepRecentTokens: 1 },
      }),
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async () => {
        throw new Error("queued manual compaction should not print events");
      },
      formatCostReport: () => "",
    });

    // When
    input.end();
    await withTimeout(summaryRequested, 5000, "manual summary did not start");
    for (const handler of [...sigintHandlers]) {
      handler();
    }

    // Then
    await withTimeout(session, 5000, "interrupted session did not end");
    expect(consumedInputIds).toEqual([["queued-compact"]]);
    expect(sigintHandlers.size).toBe(0);
  });

  test(`Given manual compaction summary fails after interruption,
    When user sends another prompt,
    Then the session treats the failure as an abort and restores history`, async () => {
    // Given
    let receiveFirstEnd: () => void = () => {};
    const firstTurnEnded = new Promise<void>((resolve) => {
      receiveFirstEnd = resolve;
    });
    let receiveSummaryRequest: () => void = () => {};
    const summaryRequested = new Promise<void>((resolve) => {
      receiveSummaryRequest = resolve;
    });
    const observedRequestContexts: Message[][] = [];
    let requestTurn = 0;
    const provider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        if (options.toolExposure?.kind === "none") {
          receiveSummaryRequest();
          if (!options.signal.aborted) {
            await new Promise<void>((resolve) => {
              options.signal.addEventListener("abort", () => resolve(), {
                once: true,
              });
            });
          }
          throw new Error("summary aborted");
        }

        requestTurn++;
        observedRequestContexts.push(structuredClone([...options.messages]));
        yield {
          type: "text",
          text: requestTurn === 1 ? "First done" : "Second done",
        };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    let stdout = "";
    let stderr = "";
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
      resolveProvider: () => ({
        provider,
        providerId: "fake",
        model: "fake",
        costModel: ZERO_COST_MODEL,
        contextCompaction: { keepRecentTokens: 1 },
      }),
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async (stream) => {
        let finalEnd: Extract<AgentEvent, { readonly type: "end" }> | undefined;
        for await (const event of stream) {
          if (event.type === "text") {
            stdout += event.text;
          } else if (event.type === "end") {
            finalEnd = event;
            if (requestTurn === 1) {
              receiveFirstEnd();
            }
          }
        }
        return finalEnd;
      },
      formatCostReport: () => "",
    });

    // When
    input.write("first prompt\n");
    await withTimeout(firstTurnEnded, 5000, "first turn did not finish");
    input.write("/compact\n");
    await withTimeout(summaryRequested, 5000, "manual summary did not start");
    for (const handler of [...sigintHandlers]) {
      handler();
    }
    input.write("second prompt\n");
    input.end();

    // Then
    await session;
    expect(stdout).toBe("First done\n\nSecond done\n");
    expect(stderr).toBe("");
    expect(observedRequestContexts[1]).toEqual([
      { role: "user", content: "first prompt" },
      { role: "assistant", content: "First done", toolCalls: [] },
      { role: "user", content: "second prompt" },
    ]);
  });

  test(`Given a prompt only starts with the compact command name,
    When user enters the prompt,
    Then it is sent as a normal task message`, async () => {
    // Given
    const observedRequestContexts: Message[][] = [];
    const provider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        observedRequestContexts.push(structuredClone([...options.messages]));
        yield { type: "text", text: "Normal answer" };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const input = new PassThrough();
    let stdout = "";
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
      platform: process.platform,
      session: EPHEMERAL_INTERACTIVE_SESSION,
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

    // When
    input.write("/compactfoo\n");
    input.end();

    // Then
    await session;
    expect(stdout).toBe("Normal answer\n");
    expect(observedRequestContexts).toEqual([
      [{ role: "user", content: "/compactfoo" }],
    ]);
  });
});
