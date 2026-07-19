import { PassThrough } from "node:stream";
import { describe, expect, test } from "vitest";
import type { AgentEvent } from "../../../src/agent/events.ts";
import type { SessionQueuedInput } from "../../../src/cli/session-store.ts";
import type { LLMProvider, Message } from "../../../src/llm/types.ts";
import {
  EPHEMERAL_INTERACTIVE_SESSION,
  ForcedExit,
  runInteractiveSessionWithoutMemory as runInteractiveSession,
  savedInteractiveSession,
  withProviderRequestAttemptAccounting,
  withTimeout,
  ZERO_COST_MODEL,
  ZERO_USAGE,
} from "../../../src/testing/interactive-session-fixtures.ts";

describe("Interactive Session - Queued Input", () => {
  test(`Given a user types while an interactive tool turn is running,
    When the assistant continues after the tool result,
    Then the typed message steers the same turn`, async () => {
    // Given
    let turn = 0;
    let steeringWritten = false;
    const observedContexts: Message[][] = [];
    const provider: LLMProvider = withProviderRequestAttemptAccounting({
      id: "fake",
      async *stream(options) {
        turn++;
        observedContexts.push([...options.messages]);
        if (turn === 1) {
          yield {
            type: "tool_call",
            id: "interactive_steering_read",
            tool: "read",
            path: "package.json",
            limit: 1,
          };
        } else if (turn === 2) {
          yield { type: "text", text: "Steered." };
        } else {
          yield { type: "text", text: "Queued follow-up." };
        }
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    });
    const input = new PassThrough();
    let stdout = "";
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled", reportFile: "report.json" },
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
          if (event.type === "tool_start" && !steeringWritten) {
            steeringWritten = true;
            input.write("focus on scripts\n");
          } else if (event.type === "text") {
            stdout += event.text;
          } else if (event.type === "end") {
            finalEnd = event;
            input.end();
          }
        }
        return finalEnd;
      },
      formatCostReport: () => "",
    });

    // When
    input.write("inspect package\n");

    // Then
    const result = await session;
    expect(stdout).toBe("Steered.\n");
    expect(observedContexts).toEqual([
      [{ role: "user", content: "inspect package" }],
      [
        { role: "user", content: "inspect package" },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "interactive_steering_read",
              tool: "read",
              path: "package.json",
              limit: 1,
            },
          ],
        },
        expect.objectContaining({
          role: "tool",
          toolCallId: "interactive_steering_read",
        }),
        { role: "user", content: "focus on scripts" },
      ],
    ]);
    expect(result.report?.tasks).toMatchObject([
      {
        ordinal: 1,
        trigger: "user_prompt",
        agentRuns: [
          {
            ordinal: 1,
            trigger: "user_prompt",
            agentLoopTurns: 2,
          },
        ],
        outcome: "completed",
      },
    ]);
  });

  test(`Given user enters /compact while an interactive tool turn is running,
    When the assistant continues after the tool result,
    Then the compact command is deferred instead of injected as steering`, async () => {
    // Given
    const focusInstruction = "keep the tool result and next action";
    let turn = 0;
    let compactWritten = false;
    const observedContexts: Message[][] = [];
    let summaryPrompt = "";
    const provider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        if (options.toolChoice === "none") {
          summaryPrompt = options.messages[0]?.content ?? "";
          yield { type: "text", text: "Deferred compact summary." };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }

        turn++;
        observedContexts.push(structuredClone([...options.messages]));
        if (turn === 1) {
          yield {
            type: "tool_call",
            id: "deferred_compact_read",
            tool: "read",
            path: "package.json",
            limit: 1,
          };
        } else if (turn === 2) {
          yield { type: "text", text: "Tool turn done." };
        } else {
          yield { type: "text", text: "After compact done." };
        }
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
          if (event.type === "tool_start" && !compactWritten) {
            compactWritten = true;
            input.write(`/compact ${focusInstruction}\n`);
            input.end("after compact\n");
          } else if (event.type === "text") {
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
    input.write("inspect package\n");

    // Then
    await session;
    expect(stdout).toBe("Tool turn done.\nAfter compact done.\n");
    expect(stderr).toContain("Context compacted: manual");
    expect(summaryPrompt).toContain(focusInstruction);
    expect(summaryPrompt).not.toContain("/compact");
    expect(observedContexts[1]).toEqual([
      { role: "user", content: "inspect package" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "deferred_compact_read",
            tool: "read",
            path: "package.json",
            limit: 1,
          },
        ],
      },
      expect.objectContaining({
        role: "tool",
        toolCallId: "deferred_compact_read",
      }),
    ]);
    expect(JSON.stringify(observedContexts[1])).not.toContain("/compact");
    expect(observedContexts[2]).toEqual([
      {
        role: "user",
        content: expect.stringContaining("<conversation-checkpoint>"),
        contextCompaction: {
          evidence: [
            expect.objectContaining({
              handle: "read:package.json@limit=1",
            }),
          ],
        },
      },
      { role: "assistant", content: "Tool turn done.", toolCalls: [] },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          expect.objectContaining({
            id: "post_compaction_read_0",
            tool: "read",
            path: expect.stringContaining("package.json"),
            limit: 1,
          }),
        ],
      },
      expect.objectContaining({
        role: "tool",
        toolCallId: "post_compaction_read_0",
        content: expect.stringContaining(
          "Read output stopped at requested limit of 1 lines",
        ),
      }),
      { role: "user", content: "after compact" },
    ]);
    expect(JSON.stringify(observedContexts[2])).not.toContain("/compact");
  });

  test(`Given user enters /help while an interactive tool turn is running,
    When the assistant continues after the tool result,
    Then the help command is deferred instead of injected as steering`, async () => {
    // Given
    let turn = 0;
    let helpWritten = false;
    const observedContexts: Message[][] = [];
    const provider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        turn++;
        observedContexts.push(structuredClone([...options.messages]));
        if (turn === 1) {
          yield {
            type: "tool_call",
            id: "deferred_help_read",
            tool: "read",
            path: "package.json",
            limit: 1,
          };
        } else if (turn === 2) {
          yield { type: "text", text: "Tool turn done." };
        } else {
          yield { type: "text", text: "After help done." };
        }
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
          if (event.type === "tool_start" && !helpWritten) {
            helpWritten = true;
            input.write("/help\n");
            input.end("after help\n");
          } else if (event.type === "text") {
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
    input.write("inspect package\n");

    // Then
    await session;
    expect(stdout).toContain("Tool turn done.\n");
    expect(stdout).toContain("Interactive commands:");
    expect(stdout).toContain("After help done.\n");
    expect(observedContexts[1]).toEqual([
      { role: "user", content: "inspect package" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "deferred_help_read",
            tool: "read",
            path: "package.json",
            limit: 1,
          },
        ],
      },
      expect.objectContaining({
        role: "tool",
        toolCallId: "deferred_help_read",
      }),
    ]);
    expect(observedContexts[2]).toContainEqual({
      role: "user",
      content: "after help",
    });
    expect(JSON.stringify(observedContexts)).not.toContain("/help");
  });

  test(`Given user enters /title while an interactive tool turn is running,
    When the assistant continues after the tool result,
    Then the title command is deferred, consumed, and not sent to the provider`, async () => {
    // Given
    let turn = 0;
    let titleWritten = false;
    const observedContexts: Message[][] = [];
    const persistedQueuedInputs: SessionQueuedInput[] = [];
    const consumedMessageInputIds: string[][] = [];
    let titlePersisted = "";
    let titleConsumedInputIds: readonly string[] = [];
    const provider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        turn++;
        observedContexts.push(structuredClone([...options.messages]));
        if (turn === 1) {
          yield {
            type: "tool_call",
            id: "deferred_title_read",
            tool: "read",
            path: "package.json",
            limit: 1,
          };
        } else if (turn === 2) {
          yield { type: "text", text: "Tool turn done." };
        } else {
          yield { type: "text", text: "After title done." };
        }
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const input = new PassThrough();
    let stdout = "";
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
      platform: process.platform,
      session: savedInteractiveSession({
        id: "queued-title",
        persistQueuedInput: (queuedInput) => {
          const persisted = {
            id: `queued-${queuedInput.sequence}`,
            timestamp: `1970-01-01T00:00:0${queuedInput.sequence}.000Z`,
            sequence: queuedInput.sequence,
            line: queuedInput.line,
          };
          persistedQueuedInputs.push(persisted);
          return persisted;
        },
        persistTitle: (titleRecord) => {
          titlePersisted = titleRecord.title;
          titleConsumedInputIds = titleRecord.consumedInputIds;
          return titleRecord.title;
        },
        persistMessages: ({
          messages: _messages,
          reason: _reason,
          consumedInputIds,
        }) => {
          consumedMessageInputIds.push([...consumedInputIds]);
        },
      }),

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
          if (event.type === "tool_start" && !titleWritten) {
            titleWritten = true;
            input.write("/title Queued session title\n");
            input.end("after title\n");
          } else if (event.type === "text") {
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
    input.write("inspect package\n");

    // Then
    await session;
    expect(stdout).toBe(
      "Tool turn done.\nSession title set to: Queued session title\nAfter title done.\n",
    );
    expect(
      persistedQueuedInputs.map((queuedInput) => queuedInput.line),
    ).toEqual(["/title Queued session title", "after title"]);
    expect(titlePersisted).toBe("Queued session title");
    expect(titleConsumedInputIds).toEqual(["queued-2"]);
    expect(consumedMessageInputIds).toContainEqual(["queued-3"]);
    expect(observedContexts[2]).toContainEqual({
      role: "user",
      content: "after title",
    });
    expect(JSON.stringify(observedContexts)).not.toContain("/title");
    expect(JSON.stringify(observedContexts)).not.toContain(
      "Queued session title",
    );
  });

  test(`Given user enters /fork while an interactive tool turn is running,
    When the assistant continues after the tool result,
    Then the fork command is deferred instead of injected as steering`, async () => {
    // Given
    let turn = 0;
    let forkWritten = false;
    const observedContexts: Message[][] = [];
    let forkTarget = "";
    let forkBeforeMessageId: string | undefined;
    const provider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        turn++;
        observedContexts.push(structuredClone([...options.messages]));
        if (turn === 1) {
          yield {
            type: "tool_call",
            id: "deferred_fork_read",
            tool: "read",
            path: "package.json",
            limit: 1,
          };
        } else if (turn === 2) {
          yield { type: "text", text: "Tool turn done." };
        } else {
          yield { type: "text", text: "After fork done." };
        }
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const input = new PassThrough();
    let stdout = "";
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
      platform: process.platform,
      session: savedInteractiveSession({
        id: "test-session",
        fork: (request) => {
          forkTarget = request.targetSessionId;
          forkBeforeMessageId = request.beforeMessageId;
          return 'Forked session "source" to "target" before message msg_beta.\nresume: keel --resume target\n';
        },
      }),
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
          if (event.type === "tool_start" && !forkWritten) {
            forkWritten = true;
            input.write("/fork target --before-message msg_beta\n");
            input.end("after fork\n");
          } else if (event.type === "text") {
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
    input.write("inspect package\n");

    // Then
    await session;
    expect(stdout).toBe(
      [
        "Tool turn done.",
        'Forked session "source" to "target" before message msg_beta.',
        "resume: keel --resume target",
        "After fork done.",
        "",
      ].join("\n"),
    );
    expect(forkTarget).toBe("target");
    expect(forkBeforeMessageId).toBe("msg_beta");
    expect(observedContexts[1]).toEqual([
      { role: "user", content: "inspect package" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "deferred_fork_read",
            tool: "read",
            path: "package.json",
            limit: 1,
          },
        ],
      },
      expect.objectContaining({
        role: "tool",
        toolCallId: "deferred_fork_read",
      }),
    ]);
    expect(observedContexts[2]).toContainEqual({
      role: "user",
      content: "after fork",
    });
    expect(JSON.stringify(observedContexts)).not.toContain("/fork");
  });

  test(`Given queued input exists before a deferred compact command,
    When more input arrives before a later steering drain,
    Then all deferred lines are replayed in original order`, async () => {
    // Given
    const focusInstruction = "keep queued order and tool results";
    let turn = 0;
    let firstCompactWritten = false;
    let laterInputWritten = false;
    const observedContexts: Message[][] = [];
    let summaryPrompt = "";
    const provider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        if (options.toolChoice === "none") {
          summaryPrompt = options.messages[0]?.content ?? "";
          yield { type: "text", text: "Ordered deferred compact summary." };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }

        turn++;
        observedContexts.push(structuredClone([...options.messages]));
        if (turn === 1) {
          yield {
            type: "tool_call",
            id: "ordered_deferred_first_read",
            tool: "read",
            path: "package.json",
            limit: 1,
          };
        } else if (turn === 2) {
          yield {
            type: "tool_call",
            id: "ordered_deferred_second_read",
            tool: "read",
            path: "tsconfig.json",
            limit: 1,
          };
        } else if (turn === 3) {
          yield { type: "text", text: "Tool turn done." };
        } else {
          const lastUserMessage = options.messages.findLast(
            (message) => message.role === "user",
          );
          yield {
            type: "text",
            text:
              lastUserMessage?.content === "queued before compact"
                ? "Queued before compact done."
                : "After compact done.",
          };
        }
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const input = new PassThrough();
    let stdout = "";
    let stderr = "";
    input.write("inspect package\nqueued before compact\n");
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
          if (
            event.type === "tool_start" &&
            event.toolCall.id === "ordered_deferred_first_read" &&
            !firstCompactWritten
          ) {
            firstCompactWritten = true;
            input.write(`/compact ${focusInstruction}\n`);
          } else if (
            event.type === "tool_start" &&
            event.toolCall.id === "ordered_deferred_second_read" &&
            !laterInputWritten
          ) {
            laterInputWritten = true;
            input.end("after compact\n");
          } else if (event.type === "text") {
            stdout += event.text;
          } else if (event.type === "end") {
            finalEnd = event;
          }
        }
        return finalEnd;
      },
      formatCostReport: () => "",
    });

    // When the queued input and active-turn compact command are processed

    // Then
    await session;
    expect(stdout).toBe(
      "Tool turn done.\nQueued before compact done.\nAfter compact done.\n",
    );
    expect(stderr).toContain("Context compacted: manual");
    expect(summaryPrompt).toContain(focusInstruction);
    expect(summaryPrompt).not.toContain("/compact");
    expect(summaryPrompt).not.toContain("after compact");
    expect(JSON.stringify(observedContexts[2])).not.toContain("/compact");
    expect(JSON.stringify(observedContexts[2])).not.toContain("after compact");
    expect(JSON.stringify(observedContexts[2])).not.toContain(
      "queued before compact",
    );
    expect(observedContexts[3]?.at(-1)).toEqual({
      role: "user",
      content: "queued before compact",
    });
    expect(observedContexts[4]?.at(-1)).toEqual({
      role: "user",
      content: "after compact",
    });
    expect(JSON.stringify(observedContexts[4])).not.toContain("/compact");
  });

  test(`Given an interactive steering message was injected into an interrupted turn,
    When the turn is cancelled,
    Then the steering message becomes the next prompt`, async () => {
    // Given
    let turn = 0;
    let steeringWritten = false;
    const observedUserContexts: string[][] = [];
    const provider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        turn++;
        observedUserContexts.push(
          options.messages
            .filter((message) => message.role === "user")
            .map((message) => message.content),
        );
        if (turn === 1) {
          yield {
            type: "tool_call",
            id: "interrupted_steering_read",
            tool: "read",
            path: "package.json",
            limit: 1,
          };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        if (turn === 2) {
          yield { type: "text", text: "Working" };
          if (!options.signal.aborted) {
            await new Promise<void>((resolve) => {
              options.signal.addEventListener("abort", () => resolve(), {
                once: true,
              });
            });
          }
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        yield { type: "text", text: "Restored prompt." };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
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
          if (event.type === "tool_start" && !steeringWritten) {
            steeringWritten = true;
            input.write("focus on scripts\n");
          } else if (event.type === "text") {
            stdout += event.text;
            if (event.text === "Working") {
              for (const handler of [...sigintHandlers]) {
                handler();
              }
            }
          } else if (event.type === "end") {
            finalEnd = event;
            if (turn >= 3) {
              input.end();
            }
          }
        }
        return finalEnd;
      },
      formatCostReport: () => "",
    });

    // When
    input.write("inspect package\n");

    // Then
    await withTimeout(session, 5000, "interrupted steering was not restored");
    expect(stdout).toBe("Working\nRestored prompt.\n");
    expect(observedUserContexts).toEqual([
      ["inspect package"],
      ["inspect package", "focus on scripts"],
      ["focus on scripts"],
    ]);
  });

  test(`Given an interactive steering message is queued before steering can be drained,
    When the tool turn is cancelled,
    Then the queued message becomes the next prompt`, async () => {
    // Given
    let turn = 0;
    let abortQueued = false;
    const observedUserContexts: string[][] = [];
    const provider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        turn++;
        observedUserContexts.push(
          options.messages
            .filter((message) => message.role === "user")
            .map((message) => message.content),
        );
        if (turn === 1) {
          yield {
            type: "tool_call",
            id: "abort_before_drain_bash",
            tool: "bash",
            command: 'node -e "setTimeout(() => {}, 10000)"',
          };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        yield { type: "text", text: "Queued prompt restored." };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    let stdout = "";
    const session = runInteractiveSession({
      cliArgs: { bashMode: "trusted" },
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
      }),
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async (stream) => {
        let finalEnd: Extract<AgentEvent, { readonly type: "end" }> | undefined;
        for await (const event of stream) {
          if (event.type === "tool_start" && !abortQueued) {
            abortQueued = true;
            input.write("queued after abort\n");
            for (const handler of [...sigintHandlers]) {
              handler();
            }
          } else if (event.type === "text") {
            stdout += event.text;
          } else if (event.type === "end") {
            finalEnd = event;
            if (turn >= 2) {
              input.end();
            }
          }
        }
        return finalEnd;
      },
      formatCostReport: () => "",
    });

    // When
    input.write("run then abort\n");

    // Then
    await withTimeout(session, 5000, "queued prompt was not replayed");
    expect(stdout).toBe("\nQueued prompt restored.\n");
    expect(observedUserContexts).toEqual([
      ["run then abort"],
      ["queued after abort"],
    ]);
  });

  test(`Given multiple interrupted steering batches are restored,
    When later prompts continue,
    Then pending prompts keep their original order`, async () => {
    // Given
    let streamCall = 0;
    let toolStarts = 0;
    const observedUserContexts: string[][] = [];
    const provider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        streamCall++;
        observedUserContexts.push(
          options.messages
            .filter((message) => message.role === "user")
            .map((message) => message.content),
        );
        if (streamCall === 1 || streamCall === 3) {
          yield {
            type: "tool_call",
            id: `ordered_restore_read_${streamCall}`,
            tool: "read",
            path: "package.json",
            limit: 1,
          };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        if (streamCall === 2 || streamCall === 4) {
          yield {
            type: "text",
            text: streamCall === 2 ? "First abort" : "Second abort",
          };
          if (!options.signal.aborted) {
            await new Promise<void>((resolve) => {
              options.signal.addEventListener("abort", () => resolve(), {
                once: true,
              });
            });
          }
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        yield {
          type: "text",
          text: streamCall === 5 ? "B done." : "C done.",
        };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
      platform: process.platform,
      session: EPHEMERAL_INTERACTIVE_SESSION,
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
          if (event.type === "tool_start") {
            toolStarts++;
            if (toolStarts === 1) {
              input.write("a\nb\n");
            } else if (toolStarts === 2) {
              input.write("c\n");
            }
          } else if (
            event.type === "text" &&
            (event.text === "First abort" || event.text === "Second abort")
          ) {
            for (const handler of [...sigintHandlers]) {
              handler();
            }
          } else if (event.type === "end") {
            finalEnd = event;
            if (streamCall >= 6) {
              input.end();
            }
          }
        }
        return finalEnd;
      },
      formatCostReport: () => "",
    });

    // When
    input.write("start\n");

    // Then
    await withTimeout(session, 5000, "restored prompts were not replayed");
    expect(observedUserContexts).toEqual([
      ["start"],
      ["start", "a", "b"],
      ["a"],
      ["a", "c"],
      ["b"],
      ["b", "c"],
    ]);
  });
});
