import { describe, expect, test } from "vitest";
import { compactMessages } from "../../../src/agent/context-compaction.ts";
import { runAgentTurn } from "../../../src/agent/loop.ts";
import { createReadVisibilityState } from "../../../src/agent/read-visibility.ts";
import { defaultStopPolicy } from "../../../src/agent/stop-policy.ts";
import { KeelError } from "../../../src/core/error.ts";
import type { LLMProvider, Message } from "../../../src/llm/types.ts";
import {
  collect,
  contextCompactedEvents,
  endEvent,
  freshSignal,
  onlyContextCompactedEvent,
  workspace,
  ZERO_USAGE,
} from "../../../src/testing/context-compaction-fixtures.ts";

describe("Context Compaction Agent Recovery", () => {
  test(`Given the compaction summary request itself exceeds provider context,
    When the smaller retry succeeds,
    Then the original turn retries with the compacted transcript`, async () => {
    // Given
    const messages: Message[] = [
      { role: "user", content: "Earlier task ".repeat(80) },
      {
        role: "assistant",
        content: "Earlier progress ".repeat(80),
        toolCalls: [],
      },
      { role: "user", content: "Finish now." },
    ];
    let mainRequests = 0;
    let summaryRequests = 0;
    const provider: LLMProvider = {
      id: "summary-overflow-provider",
      async *stream(options) {
        if (options.toolChoice === "none") {
          summaryRequests++;
          if (summaryRequests === 1) {
            throw new KeelError(
              "provider_context_overflow",
              "Summary request still exceeds context",
            );
          }
          yield { type: "text", text: "Smaller summary." };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }

        mainRequests++;
        if (mainRequests === 1) {
          throw new KeelError(
            "provider_context_overflow",
            "Main request exceeds context",
          );
        }
        yield { type: "text", text: "Finished after smaller summary." };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };

    // When
    const events = await collect(
      runAgentTurn({
        workspace: workspace(),
        provider,
        messages,
        systemPrompt: "You are helpful.",
        signal: freshSignal(),
        allowBash: false,
        stopPolicy: defaultStopPolicy(),
        contextCompaction: {
          keepRecentTokens: 6,
          summaryInputMaxChars: 4_000,
        },
      }),
    );

    // Then
    expect(summaryRequests).toBe(2);
    expect(events).toContainEqual({
      type: "text",
      text: "Finished after smaller summary.",
    });
  });

  test(`Given old conversation history exceeds the context threshold,
    When the next agent turn starts,
    Then the provider receives a checkpoint summary plus recent context`, async () => {
    // Given
    const messages: Message[] = [
      { role: "user", content: "Remember alpha ".repeat(80) },
      {
        role: "assistant",
        content: "Alpha is important. ".repeat(80),
        toolCalls: [],
      },
      { role: "user", content: "Now continue with beta." },
    ];
    const mutableProviderRequests: Message[][] = [];
    const provider: LLMProvider = {
      id: "compacting-provider",
      async *stream(options) {
        mutableProviderRequests.push([...options.messages]);
        if (options.toolChoice === "none") {
          yield { type: "text", text: "Alpha summary." };
          yield {
            type: "stop",
            reason: "stop",
            usage: {
              inputTokens: 30,
              cachedInputTokens: 0,
              uncachedInputTokens: 30,
              outputTokens: 4,
            },
          };
          return;
        }
        yield { type: "text", text: "Continued with compacted context." };
        yield {
          type: "stop",
          reason: "stop",
          usage: {
            inputTokens: 12,
            cachedInputTokens: 0,
            uncachedInputTokens: 12,
            outputTokens: 3,
          },
        };
      },
    };

    // When
    const events = await collect(
      runAgentTurn({
        workspace: workspace(),
        provider,
        messages,
        systemPrompt: "You are helpful.",
        signal: freshSignal(),
        allowBash: false,
        stopPolicy: defaultStopPolicy(),
        contextCompaction: {
          contextWindowTokens: 120,
          keepRecentTokens: 6,
          reserveTokens: 20,
        },
      }),
    );

    // Then
    const compactionEvent = onlyContextCompactedEvent(events);
    expect(compactionEvent).toMatchObject({
      reason: "proactive",
      beforeMessageCount: 3,
      afterMessageCount: 2,
    });
    expect(compactionEvent.beforeEstimatedTokens).toBeGreaterThan(
      compactionEvent.afterEstimatedTokens,
    );
    expect(mutableProviderRequests).toHaveLength(2);
    expect(mutableProviderRequests[0]).toEqual([
      expect.objectContaining({
        role: "user",
        content: expect.stringContaining("<conversation>"),
      }),
    ]);
    expect(mutableProviderRequests[1]).toEqual([
      {
        role: "user",
        content: expect.stringContaining("<conversation-checkpoint>"),
      },
      { role: "user", content: "Now continue with beta." },
    ]);
    expect(messages).toEqual([
      {
        role: "user",
        content: expect.stringContaining("<conversation-checkpoint>"),
      },
      { role: "user", content: "Now continue with beta." },
      {
        role: "assistant",
        content: "Continued with compacted context.",
        toolCalls: [],
      },
    ]);
    expect(events).toContainEqual({
      type: "text",
      text: "Continued with compacted context.",
    });
    expect(endEvent(events).usage).toEqual({
      inputTokens: 42,
      cachedInputTokens: 0,
      uncachedInputTokens: 42,
      outputTokens: 7,
    });
  });

  test(`Given post-compaction read restoration throws after summary creation,
    When proactive compaction runs,
    Then the compacted ledger is persisted before the error propagates`, async () => {
    // Given
    const messages: Message[] = [
      { role: "user", content: "Remember alpha ".repeat(80) },
      {
        role: "assistant",
        content: "Alpha is important. ".repeat(80),
        toolCalls: [],
      },
      { role: "user", content: "Now continue with beta." },
    ];
    const readVisibility = createReadVisibilityState();
    readVisibility.applyVisibleToolExecutions([
      {
        ok: true,
        content: "",
        readTargetPath: "package.json",
        readTargetOffset: 0,
      },
    ]);
    const provider: LLMProvider = {
      id: "compacting-provider-restore-throws",
      async *stream(options) {
        if (options.toolChoice === "none") {
          yield { type: "text", text: "Alpha summary." };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        yield {
          type: "text",
          text: "Should not request after failed restore.",
        };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };

    // When / Then
    await expect(
      collect(
        runAgentTurn({
          workspace: workspace(),
          provider,
          messages,
          systemPrompt: "You are helpful.",
          signal: freshSignal(),
          allowBash: false,
          stopPolicy: defaultStopPolicy(),
          readVisibility,
          contextCompaction: {
            contextWindowTokens: 120,
            keepRecentTokens: 6,
            reserveTokens: 20,
          },
        }),
      ),
    ).rejects.toThrow("Invalid builtin tool call for read");
    expect(messages).toEqual([
      {
        role: "user",
        content: expect.stringContaining("<conversation-checkpoint>"),
      },
      { role: "user", content: "Now continue with beta." },
    ]);
  });

  test(`Given a safe cut would otherwise orphan a tool result,
    When compaction selects the retained suffix,
    Then the suffix starts at a valid model message boundary`, async () => {
    // Given
    const messages: Message[] = [
      { role: "user", content: "Inspect the project." },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "read_package",
            tool: "read",
            path: "package.json",
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "read_package",
        content: "large tool output ".repeat(80),
      },
      {
        role: "assistant",
        content: "I inspected package.json.",
        toolCalls: [],
      },
      { role: "user", content: "Continue." },
    ];
    const provider: LLMProvider = {
      id: "tool-boundary-provider",
      async *stream() {
        yield { type: "text", text: "Tool result summary." };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };

    // When
    const result = await compactMessages({
      provider,
      systemPrompt: "You are helpful.",
      messages,
      signal: freshSignal(),
      contextCompaction: { keepRecentTokens: 40 },
    });

    // Then
    expect(result.compacted).toBe(true);
    expect(messages).toEqual([
      {
        role: "user",
        content: expect.stringContaining("<conversation-checkpoint>"),
      },
      {
        role: "assistant",
        content: "I inspected package.json.",
        toolCalls: [],
      },
      { role: "user", content: "Continue." },
    ]);
  });

  test(`Given the checkpoint summary still exceeds the proactive threshold,
    When the same model attempt proceeds,
    Then the agent does not compact repeatedly before sending the request`, async () => {
    // Given
    const messages: Message[] = [
      { role: "user", content: "Long prior request ".repeat(80) },
      {
        role: "assistant",
        content: "Long prior answer ".repeat(80),
        toolCalls: [],
      },
      { role: "user", content: "Continue." },
    ];
    let summaryRequests = 0;
    let finalRequestSeen = false;
    const provider: LLMProvider = {
      id: "large-summary-provider",
      async *stream(options) {
        if (options.toolChoice === "none") {
          summaryRequests++;
          if (summaryRequests > 1) {
            throw new Error("context compacted more than once");
          }
          yield { type: "text", text: "Large summary ".repeat(120) };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        finalRequestSeen = true;
        yield { type: "text", text: "Continued once." };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };

    // When
    const events = await collect(
      runAgentTurn({
        workspace: workspace(),
        provider,
        messages,
        systemPrompt: "You are helpful.",
        signal: freshSignal(),
        allowBash: false,
        stopPolicy: defaultStopPolicy(),
        contextCompaction: {
          contextWindowTokens: 80,
          keepRecentTokens: 6,
          reserveTokens: 20,
        },
      }),
    );

    // Then
    expect(summaryRequests).toBe(1);
    expect(finalRequestSeen).toBe(true);
    expect(events).toContainEqual({ type: "text", text: "Continued once." });
  });

  test(`Given provider usage is available for a completed request,
    When the next tool round would exceed the threshold only by estimate,
    Then proactive compaction uses real prefix usage and keeps the transcript intact`, async () => {
    // Given
    const messages: Message[] = [
      { role: "user", content: "prefix ".repeat(120) },
    ];
    let mainRequests = 0;
    let summaryRequests = 0;
    let secondRequestMessages: readonly Message[] = [];
    const provider: LLMProvider = {
      id: "usage-accounted-proactive-provider",
      async *stream(options) {
        if (options.toolChoice === "none") {
          summaryRequests++;
          yield { type: "text", text: "Unexpected proactive summary." };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }

        mainRequests++;
        if (mainRequests === 1) {
          yield {
            type: "tool_call",
            id: "accounting_probe",
            tool: "bash",
            command: "node -e \"process.stdout.write('tail '.repeat(56))\"",
          };
          yield {
            type: "stop",
            reason: "stop",
            usage: {
              inputTokens: 20,
              cachedInputTokens: 0,
              uncachedInputTokens: 20,
              outputTokens: 1,
            },
          };
          return;
        }

        secondRequestMessages = [...options.messages];
        yield { type: "text", text: "Finished without compaction." };
        yield {
          type: "stop",
          reason: "stop",
          usage: {
            inputTokens: 30,
            cachedInputTokens: 0,
            uncachedInputTokens: 30,
            outputTokens: 2,
          },
        };
      },
    };

    // When
    const events = await collect(
      runAgentTurn({
        workspace: workspace(),
        provider,
        messages,
        systemPrompt: "You are helpful.",
        signal: freshSignal(),
        allowBash: true,
        stopPolicy: defaultStopPolicy(),
        contextCompaction: {
          contextWindowTokens: 280,
          reserveTokens: 0,
          keepRecentTokens: 1,
        },
      }),
    );

    // Then
    expect(mainRequests).toBe(2);
    expect(summaryRequests).toBe(0);
    expect(contextCompactedEvents(events)).toEqual([]);
    expect(secondRequestMessages[0]).toEqual({
      role: "user",
      content: "prefix ".repeat(120),
    });
    expect(secondRequestMessages[0]?.content).not.toContain(
      "<conversation-checkpoint>",
    );
    expect(events).toContainEqual({
      type: "text",
      text: "Finished without compaction.",
    });
    expect(endEvent(events).usage).toEqual({
      inputTokens: 50,
      cachedInputTokens: 0,
      uncachedInputTokens: 50,
      outputTokens: 3,
    });
  });

  test(`Given provider usage keeps proactive compaction below the threshold,
    When the provider still reports context overflow,
    Then overflow recovery compacts and retries once`, async () => {
    // Given
    const messages: Message[] = [
      { role: "user", content: "prior ".repeat(50) },
      { role: "assistant", content: "answer ".repeat(45), toolCalls: [] },
      { role: "user", content: "Run the accounting probe." },
    ];
    let mainRequests = 0;
    let summaryRequests = 0;
    let retriedMessages: readonly Message[] = [];
    const provider: LLMProvider = {
      id: "usage-accounted-overflow-provider",
      async *stream(options) {
        if (options.toolChoice === "none") {
          summaryRequests++;
          yield { type: "text", text: "Earlier usage summary." };
          yield {
            type: "stop",
            reason: "stop",
            usage: {
              inputTokens: 15,
              cachedInputTokens: 0,
              uncachedInputTokens: 15,
              outputTokens: 3,
            },
          };
          return;
        }

        mainRequests++;
        if (mainRequests === 1) {
          yield {
            type: "tool_call",
            id: "accounting_overflow_probe",
            tool: "bash",
            command: "node -e \"process.stdout.write('tail '.repeat(56))\"",
          };
          yield {
            type: "stop",
            reason: "stop",
            usage: {
              inputTokens: 25,
              cachedInputTokens: 0,
              uncachedInputTokens: 25,
              outputTokens: 1,
            },
          };
          return;
        }
        if (mainRequests === 2) {
          throw new KeelError(
            "provider_context_overflow",
            "Provider accounting still overflowed",
          );
        }

        retriedMessages = [...options.messages];
        yield { type: "text", text: "Recovered after accounted overflow." };
        yield {
          type: "stop",
          reason: "stop",
          usage: {
            inputTokens: 30,
            cachedInputTokens: 0,
            uncachedInputTokens: 30,
            outputTokens: 2,
          },
        };
      },
    };

    // When
    const events = await collect(
      runAgentTurn({
        workspace: workspace(),
        provider,
        messages,
        systemPrompt: "You are helpful.",
        signal: freshSignal(),
        allowBash: true,
        stopPolicy: defaultStopPolicy(),
        contextCompaction: {
          contextWindowTokens: 260,
          reserveTokens: 0,
          keepRecentTokens: 1,
        },
      }),
    );

    // Then
    expect(mainRequests).toBe(3);
    expect(summaryRequests).toBe(1);
    expect(contextCompactedEvents(events).map((event) => event.reason)).toEqual(
      ["overflow_recovery"],
    );
    expect(retriedMessages).toEqual([
      {
        role: "user",
        content: expect.stringContaining("<conversation-checkpoint>"),
      },
      { role: "user", content: "Run the accounting probe." },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "accounting_overflow_probe",
            tool: "bash",
            command: "node -e \"process.stdout.write('tail '.repeat(56))\"",
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "accounting_overflow_probe",
        content: expect.stringContaining("stdout:"),
      },
    ]);
    expect(events).toContainEqual({
      type: "text",
      text: "Recovered after accounted overflow.",
    });
    expect(endEvent(events).usage).toEqual({
      inputTokens: 70,
      cachedInputTokens: 0,
      uncachedInputTokens: 70,
      outputTokens: 6,
    });
  });

  test(`Given the provider rejects a request before any assistant output because context is too large,
    When compaction succeeds,
    Then the same turn retries once with the compacted transcript`, async () => {
    // Given
    const messages: Message[] = [
      { role: "user", content: "Earlier task ".repeat(80) },
      {
        role: "assistant",
        content: "Earlier progress ".repeat(80),
        toolCalls: [],
      },
      { role: "user", content: "Finish now." },
    ];
    let requestCount = 0;
    let retriedMessages: readonly Message[] = [];
    const provider: LLMProvider = {
      id: "overflow-then-compact",
      async *stream(options) {
        requestCount++;
        if (requestCount === 1) {
          throw new KeelError(
            "provider_context_overflow",
            "DeepSeek API error (400): context_length_exceeded",
          );
        }
        if (options.toolChoice === "none") {
          yield { type: "text", text: "Earlier task summary." };
          yield {
            type: "stop",
            reason: "stop",
            usage: {
              inputTokens: 20,
              cachedInputTokens: 0,
              uncachedInputTokens: 20,
              outputTokens: 3,
            },
          };
          return;
        }
        retriedMessages = [...options.messages];
        yield { type: "text", text: "Finished after compaction." };
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
    };

    // When
    const events = await collect(
      runAgentTurn({
        workspace: workspace(),
        provider,
        messages,
        systemPrompt: "You are helpful.",
        signal: freshSignal(),
        allowBash: false,
        stopPolicy: defaultStopPolicy(),
        contextCompaction: {
          keepRecentTokens: 6,
        },
      }),
    );

    // Then
    const compactionEvent = onlyContextCompactedEvent(events);
    expect(compactionEvent).toMatchObject({
      reason: "overflow_recovery",
      beforeMessageCount: 3,
      afterMessageCount: 2,
      toolOutputsCompacted: 0,
      toolOutputCharsBefore: 0,
      toolOutputCharsAfter: 0,
      toolOutputEstimatedTokensBefore: 0,
      toolOutputEstimatedTokensAfter: 0,
    });
    expect(compactionEvent.beforeEstimatedTokens).toBeGreaterThan(
      compactionEvent.afterEstimatedTokens,
    );
    expect(requestCount).toBe(3);
    expect(retriedMessages).toEqual([
      {
        role: "user",
        content: expect.stringContaining("<conversation-checkpoint>"),
      },
      { role: "user", content: "Finish now." },
    ]);
    expect(events).toContainEqual({
      type: "text",
      text: "Finished after compaction.",
    });
    expect(endEvent(events).usage).toEqual({
      inputTokens: 28,
      cachedInputTokens: 0,
      uncachedInputTokens: 28,
      outputTokens: 5,
    });
  });
});
