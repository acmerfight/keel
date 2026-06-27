import { mkdtemp, readFile, rm } from "node:fs/promises";
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
  persistSessionMessages,
  persistSessionQueuedInput,
  resumeSessionStore,
  type SessionQueuedInput,
} from "../../../src/cli/session-store.ts";
import type { LLMProvider, Message, Usage } from "../../../src/llm/types.ts";
import {
  EXPENSIVE_USAGE,
  ForcedExit,
  ONE_DOLLAR_PER_MILLION_INPUT,
  resolvedProvider,
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
      async *stream() {
        fakeReportTurns++;
        yield { type: "text", text: `fake report ${fakeReportTurns}` };
        yield { type: "stop", reason: "stop", usage: fakeUsage };
      },
    };
    const qwenReportProvider: LLMProvider = {
      id: "fake",
      async *stream() {
        qwenReportTurns++;
        yield { type: "text", text: `qwen report ${qwenReportTurns}` };
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
        turns: 1,
        usage: fakeUsage,
        costUsd: 0.001,
      },
      {
        provider: "qwen",
        model: "qwen3.7-plus",
        turns: 1,
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
          cost.budgetExceeded,
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
    const provider: LLMProvider = {
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
    };
    const input = new PassThrough();
    let stdout = "";
    const session = runInteractiveSession({
      cliArgs: { bashMode: "ask" },
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
    await session;
    expect(stdout).toBe("First answer\nSecond saw prior context\n");
    expect(observedContexts).toEqual([
      [{ role: "user", content: "first prompt" }],
      [
        { role: "user", content: "first prompt" },
        { role: "assistant", content: "First answer" },
        { role: "user", content: "second prompt" },
      ],
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
