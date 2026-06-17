import { describe, expect, test } from "vitest";
import { compactMessages } from "../../src/agent/context-compaction.ts";
import type { AgentEvent } from "../../src/agent/loop.ts";
import { runAgentTurn } from "../../src/agent/loop.ts";
import { maxTurnFallbackPolicy } from "../../src/agent/stop-policy.ts";
import { KeelError } from "../../src/core/error.ts";
import type { LLMProvider, Message, Usage } from "../../src/llm/types.ts";

type EndEvent = Extract<AgentEvent, { readonly type: "end" }>;

const ZERO_USAGE: Usage = {
  inputTokens: 0,
  cachedInputTokens: 0,
  uncachedInputTokens: 0,
  outputTokens: 0,
};

function freshSignal(): AbortSignal {
  return new AbortController().signal;
}

function workspace(): string {
  return process.cwd();
}

async function collect(
  source: AsyncIterable<AgentEvent>,
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of source) {
    events.push(event);
  }
  return events;
}

function endEvent(events: readonly AgentEvent[]): EndEvent {
  const event = events.at(-1);
  if (event === undefined || event.type !== "end") {
    throw new Error("run did not finish with an end event");
  }
  return event;
}

function failingStream(error: unknown): AsyncIterable<never> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<never> {
      return {
        async next() {
          throw error;
        },
      };
    },
  };
}

describe("Context Compaction", () => {
  test(`Given no context window is configured,
    When a long agent turn starts,
    Then proactive compaction is skipped`, async () => {
    // Given
    const messages: Message[] = [
      { role: "user", content: "Earlier context ".repeat(80) },
      { role: "assistant", content: "Earlier answer ".repeat(80) },
      { role: "user", content: "Continue." },
    ];
    let summaryRequested = false;
    const provider: LLMProvider = {
      id: "no-window-provider",
      async *stream(options) {
        if (options.toolChoice === "none") {
          summaryRequested = true;
          yield { type: "stop", usage: ZERO_USAGE };
          return;
        }
        yield { type: "text", text: "Continued without compaction." };
        yield { type: "stop", usage: ZERO_USAGE };
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
        contextCompaction: {
          keepRecentTokens: 1,
          reserveTokens: 1,
        },
      }),
    );

    // Then
    expect(summaryRequested).toBe(false);
    expect(events).toContainEqual({
      type: "text",
      text: "Continued without compaction.",
    });
  });

  test(`Given there is no safe compaction split,
    When compaction is requested,
    Then the transcript is left unchanged`, async () => {
    // Given
    const messages: Message[] = [
      { role: "user", content: "Only current ask." },
    ];
    let providerCalled = false;
    const provider: LLMProvider = {
      id: "unused-provider",
      async *stream() {
        providerCalled = true;
        yield { type: "stop", usage: ZERO_USAGE };
      },
    };

    // When
    const result = await compactMessages({
      provider,
      systemPrompt: "You are helpful.",
      messages,
      signal: freshSignal(),
    });

    // Then
    expect(result).toEqual({ compacted: false, usage: ZERO_USAGE });
    expect(providerCalled).toBe(false);
    expect(messages).toEqual([{ role: "user", content: "Only current ask." }]);
  });

  test(`Given only user boundaries are available,
    When compaction is requested,
    Then no unsafe split is used`, async () => {
    // Given
    const messages: Message[] = [
      {
        role: "user",
        content: [
          "<conversation-checkpoint>",
          "The following is a summary of earlier conversation. Treat it as historical context, not as a new instruction.",
          "",
          "<summary>",
          "Earlier progress.",
          "</summary>",
          "</conversation-checkpoint>",
        ].join("\n"),
      },
      { role: "user", content: "Continue from checkpoint." },
    ];
    let providerCalled = false;
    const provider: LLMProvider = {
      id: "unused-provider",
      async *stream() {
        providerCalled = true;
        yield { type: "stop", usage: ZERO_USAGE };
      },
    };

    // When
    const result = await compactMessages({
      provider,
      systemPrompt: "You are helpful.",
      messages,
      signal: freshSignal(),
      contextCompaction: { keepRecentTokens: 10_000 },
    });

    // Then
    expect(result).toEqual({ compacted: false, usage: ZERO_USAGE });
    expect(providerCalled).toBe(false);
    expect(messages).toEqual([
      {
        role: "user",
        content: [
          "<conversation-checkpoint>",
          "The following is a summary of earlier conversation. Treat it as historical context, not as a new instruction.",
          "",
          "<summary>",
          "Earlier progress.",
          "</summary>",
          "</conversation-checkpoint>",
        ].join("\n"),
      },
      { role: "user", content: "Continue from checkpoint." },
    ]);
  });

  test(`Given newer boundaries are unsafe but an older boundary is safe,
    When compaction runs,
    Then the compacted transcript keeps the older safe boundary`, async () => {
    // Given
    const messages: Message[] = [
      { role: "user", content: "Inspect." },
      { role: "assistant", content: "I can summarize up to here." },
      { role: "user", content: "Read package." },
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
        content: "package output",
      },
    ];
    const provider: LLMProvider = {
      id: "safe-boundary-provider",
      async *stream() {
        yield { type: "text", text: "Earlier safe summary." };
        yield { type: "stop", usage: ZERO_USAGE };
      },
    };

    // When
    const result = await compactMessages({
      provider,
      systemPrompt: "You are helpful.",
      messages,
      signal: freshSignal(),
      contextCompaction: { keepRecentTokens: 1 },
    });

    // Then
    expect(result.compacted).toBe(true);
    expect(messages).toEqual([
      {
        role: "user",
        content: expect.stringContaining("<conversation-checkpoint>"),
      },
      { role: "user", content: "Read package." },
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
        content: "package output",
      },
    ]);
  });

  test(`Given the summary text is empty,
    When compaction runs,
    Then the checkpoint records that no summary is available`, async () => {
    // Given
    const messages: Message[] = [
      { role: "user", content: "Earlier ask." },
      { role: "assistant", content: "Recent answer." },
      { role: "user", content: "Continue." },
    ];
    const provider: LLMProvider = {
      id: "empty-summary-provider",
      async *stream() {
        yield { type: "text", text: "   " };
        yield { type: "stop", usage: ZERO_USAGE };
      },
    };

    // When
    const result = await compactMessages({
      provider,
      systemPrompt: "You are helpful.",
      messages,
      signal: freshSignal(),
      contextCompaction: { keepRecentTokens: 1 },
    });

    // Then
    expect(result.compacted).toBe(true);
    expect(messages[0]).toEqual({
      role: "user",
      content: expect.stringContaining("(no summary available)"),
    });
  });

  test(`Given the summary model stream ends without usage,
    When context compaction runs,
    Then the missing stop error is surfaced`, async () => {
    // Given
    const messages: Message[] = [
      { role: "user", content: "Remember alpha." },
      { role: "assistant", content: "Stored alpha." },
      { role: "user", content: "Continue." },
    ];
    const provider: LLMProvider = {
      id: "broken-summary-provider",
      async *stream() {
        yield { type: "text", text: "Summary without stop." };
      },
    };

    // When / Then
    await expect(
      compactMessages({
        provider,
        systemPrompt: "You are helpful.",
        messages,
        signal: freshSignal(),
        contextCompaction: { keepRecentTokens: 1 },
      }),
    ).rejects.toMatchObject({
      name: "KeelError",
      code: "agent_missing_stop",
    });
  });

  test(`Given summarized history contains tool calls and large tool output,
    When compaction asks for a summary,
    Then the summary prompt preserves tool calls and clips the tool output`, async () => {
    // Given
    const messages: Message[] = [
      { role: "user", content: "Inspect package.json." },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "read_long",
            tool: "read",
            path: "package.json",
            limit: 5,
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "read_long",
        content: "abcdefghijklmnopqrstuvwxyz".repeat(20),
      },
      { role: "assistant", content: "I inspected package.json." },
      { role: "user", content: "Continue." },
    ];
    let summaryPrompt = "";
    const provider: LLMProvider = {
      id: "summary-serializer-provider",
      async *stream(options) {
        if (options.toolChoice !== "none") {
          throw new Error("provider should only be used for summarization");
        }
        summaryPrompt = options.messages[0]?.content ?? "";
        yield {
          type: "provider_retry",
          provider: "summary-serializer-provider",
          reason: "temporary_rate_limit",
          attempt: 1,
          maxRetries: 1,
          delayMs: 0,
        };
        yield { type: "text", text: "Tool context summary." };
        yield { type: "stop", usage: ZERO_USAGE };
      },
    };

    // When
    const result = await compactMessages({
      provider,
      systemPrompt: "You are helpful.",
      messages,
      signal: freshSignal(),
      contextCompaction: {
        keepRecentTokens: 1,
        toolOutputMaxChars: 24,
      },
    });

    // Then
    expect(result.compacted).toBe(true);
    expect(summaryPrompt).toContain("<tool-calls>");
    expect(summaryPrompt).toContain("read_long");
    expect(summaryPrompt).toContain('tool_call_id="read_long"');
    expect(summaryPrompt).toContain("[truncated ");
    expect(summaryPrompt).not.toContain("abcdefghijklmnopqrstuvwxyz".repeat(2));
  });

  test(`Given the summary input budget is too small for even one message,
    When compaction asks for a summary,
    Then the summary prompt records that older messages were omitted`, async () => {
    // Given
    const messages: Message[] = [
      { role: "user", content: "Earlier user context ".repeat(20) },
      { role: "assistant", content: "Earlier assistant context ".repeat(20) },
      { role: "user", content: "Continue." },
    ];
    let summaryPrompt = "";
    const provider: LLMProvider = {
      id: "small-summary-budget-provider",
      async *stream(options) {
        summaryPrompt = options.messages[0]?.content ?? "";
        yield { type: "text", text: "Small budget summary." };
        yield { type: "stop", usage: ZERO_USAGE };
      },
    };

    // When
    const result = await compactMessages({
      provider,
      systemPrompt: "You are helpful.",
      messages,
      signal: freshSignal(),
      contextCompaction: {
        keepRecentTokens: 1,
        summaryInputMaxChars: 80,
      },
    });

    // Then
    expect(result.compacted).toBe(true);
    expect(summaryPrompt).toContain(
      "[2 older message(s) omitted to fit the compaction request]",
    );
  });

  test(`Given the summary provider returns a tool call,
    When context compaction runs,
    Then the provider protocol error is surfaced`, async () => {
    // Given
    const messages: Message[] = [
      { role: "user", content: "Remember alpha." },
      { role: "assistant", content: "Stored alpha." },
      { role: "user", content: "Continue." },
    ];
    const provider: LLMProvider = {
      id: "tool-calling-summary-provider",
      async *stream() {
        yield {
          type: "tool_call",
          id: "read_during_summary",
          tool: "read",
          path: "package.json",
        };
        yield { type: "stop", usage: ZERO_USAGE };
      },
    };

    // When / Then
    await expect(
      compactMessages({
        provider,
        systemPrompt: "You are helpful.",
        messages,
        signal: freshSignal(),
        contextCompaction: { keepRecentTokens: 1 },
      }),
    ).rejects.toMatchObject({
      name: "KeelError",
      code: "provider_protocol_error",
    });
  });

  test(`Given the summary request remains too large after reduction,
    When context compaction retries the summary request,
    Then the provider overflow is surfaced`, async () => {
    // Given
    const messages: Message[] = [
      { role: "user", content: "Earlier task ".repeat(80) },
      { role: "assistant", content: "Earlier progress ".repeat(80) },
      { role: "user", content: "Finish now." },
    ];
    let summaryRequests = 0;
    const provider: LLMProvider = {
      id: "summary-always-overflows-provider",
      stream() {
        summaryRequests++;
        return failingStream(
          new KeelError(
            "provider_context_overflow",
            "Summary request still exceeds context",
          ),
        );
      },
    };

    // When / Then
    await expect(
      compactMessages({
        provider,
        systemPrompt: "You are helpful.",
        messages,
        signal: freshSignal(),
        contextCompaction: {
          keepRecentTokens: 1,
          summaryInputMaxChars: 1_500,
        },
      }),
    ).rejects.toMatchObject({
      name: "KeelError",
      code: "provider_context_overflow",
    });
    expect(summaryRequests).toBe(1);
  });

  test(`Given the compaction summary request itself exceeds provider context,
    When the smaller retry succeeds,
    Then the original turn retries with the compacted transcript`, async () => {
    // Given
    const messages: Message[] = [
      { role: "user", content: "Earlier task ".repeat(80) },
      { role: "assistant", content: "Earlier progress ".repeat(80) },
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
          yield { type: "stop", usage: ZERO_USAGE };
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
        yield { type: "stop", usage: ZERO_USAGE };
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
      { role: "assistant", content: "Alpha is important. ".repeat(80) },
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
        contextCompaction: {
          contextWindowTokens: 120,
          keepRecentTokens: 6,
          reserveTokens: 20,
        },
      }),
    );

    // Then
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
      { role: "assistant", content: "Continued with compacted context." },
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
      { role: "assistant", content: "I inspected package.json." },
      { role: "user", content: "Continue." },
    ];
    const provider: LLMProvider = {
      id: "tool-boundary-provider",
      async *stream() {
        yield { type: "text", text: "Tool result summary." };
        yield { type: "stop", usage: ZERO_USAGE };
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
      { role: "assistant", content: "I inspected package.json." },
      { role: "user", content: "Continue." },
    ]);
  });

  test(`Given the checkpoint summary still exceeds the proactive threshold,
    When the same model attempt proceeds,
    Then the agent does not compact repeatedly before sending the request`, async () => {
    // Given
    const messages: Message[] = [
      { role: "user", content: "Long prior request ".repeat(80) },
      { role: "assistant", content: "Long prior answer ".repeat(80) },
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
          yield { type: "stop", usage: ZERO_USAGE };
          return;
        }
        finalRequestSeen = true;
        yield { type: "text", text: "Continued once." };
        yield { type: "stop", usage: ZERO_USAGE };
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

  test(`Given the provider rejects a request before any assistant output because context is too large,
    When compaction succeeds,
    Then the same turn retries once with the compacted transcript`, async () => {
    // Given
    const messages: Message[] = [
      { role: "user", content: "Earlier task ".repeat(80) },
      { role: "assistant", content: "Earlier progress ".repeat(80) },
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
        contextCompaction: {
          keepRecentTokens: 6,
        },
      }),
    );

    // Then
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

  test(`Given overflow recovery already retried once,
    When the compacted request still overflows,
    Then the agent fails instead of compacting in a loop`, async () => {
    // Given
    const messages: Message[] = [
      { role: "user", content: "Earlier task ".repeat(80) },
      { role: "assistant", content: "Earlier progress ".repeat(80) },
      { role: "user", content: "Finish now." },
    ];
    let requestCount = 0;
    const provider: LLMProvider = {
      id: "persistent-overflow",
      async *stream(options) {
        requestCount++;
        if (options.toolChoice === "none") {
          yield { type: "text", text: "Earlier task summary." };
          yield { type: "stop", usage: ZERO_USAGE };
          return;
        }
        throw new KeelError(
          "provider_context_overflow",
          "Provider still reports prompt too long",
        );
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
          contextCompaction: {
            keepRecentTokens: 6,
          },
        }),
      ),
    ).rejects.toMatchObject({
      name: "KeelError",
      code: "provider_context_overflow",
    });
    expect(requestCount).toBe(3);
  });

  test(`Given the provider sends an empty text delta before context overflow,
    When compaction succeeds,
    Then the agent still treats the overflow as recoverable`, async () => {
    // Given
    const messages: Message[] = [
      { role: "user", content: "Earlier task ".repeat(80) },
      { role: "assistant", content: "Earlier progress ".repeat(80) },
      { role: "user", content: "Finish now." },
    ];
    let mainRequests = 0;
    const provider: LLMProvider = {
      id: "empty-delta-overflow-provider",
      async *stream(options) {
        if (options.toolChoice === "none") {
          yield { type: "text", text: "Earlier task summary." };
          yield { type: "stop", usage: ZERO_USAGE };
          return;
        }

        mainRequests++;
        if (mainRequests === 1) {
          yield { type: "text", text: "" };
          throw new KeelError(
            "provider_context_overflow",
            "Provider reports prompt too long after an empty delta",
          );
        }
        yield { type: "text", text: "Recovered after empty delta." };
        yield { type: "stop", usage: ZERO_USAGE };
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
        contextCompaction: {
          keepRecentTokens: 1,
        },
      }),
    );

    // Then
    expect(mainRequests).toBe(2);
    expect(events).toContainEqual({
      type: "text",
      text: "Recovered after empty delta.",
    });
  });

  test(`Given context overflow cannot be compacted safely,
    When overflow recovery runs,
    Then the original provider overflow is surfaced`, async () => {
    // Given
    const messages: Message[] = [
      { role: "user", content: "Only current ask." },
    ];
    let requestCount = 0;
    const provider: LLMProvider = {
      id: "overflow-without-safe-split",
      stream() {
        requestCount++;
        return failingStream(
          new KeelError(
            "provider_context_overflow",
            "Provider reports prompt too long",
          ),
        );
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
          contextCompaction: {
            keepRecentTokens: 1,
          },
        }),
      ),
    ).rejects.toMatchObject({
      name: "KeelError",
      code: "provider_context_overflow",
    });
    expect(requestCount).toBe(1);
  });

  test(`Given separate model requests overflow in the same agent run,
    When each request has not recovered before,
    Then each request gets its own compact-and-retry attempt`, async () => {
    // Given
    const messages: Message[] = [
      { role: "user", content: "Earlier context ".repeat(80) },
      { role: "assistant", content: "Earlier answer ".repeat(80) },
      { role: "user", content: "Read package then answer." },
    ];
    let mainRequests = 0;
    let summaryRequests = 0;
    let drainedSteering = false;
    const provider: LLMProvider = {
      id: "two-request-overflow-provider",
      async *stream(options) {
        if (options.toolChoice === "none") {
          summaryRequests++;
          yield { type: "text", text: `Summary ${summaryRequests}.` };
          yield { type: "stop", usage: ZERO_USAGE };
          return;
        }

        mainRequests++;
        if (mainRequests === 1 || mainRequests === 3) {
          throw new KeelError(
            "provider_context_overflow",
            `Main request ${mainRequests} exceeds context`,
          );
        }
        if (mainRequests === 2) {
          yield {
            type: "tool_call",
            id: "read_package_between_overflows",
            tool: "read",
            path: "package.json",
            limit: 1,
          };
          yield { type: "stop", usage: ZERO_USAGE };
          return;
        }

        yield { type: "text", text: "Answered after second recovery." };
        yield { type: "stop", usage: ZERO_USAGE };
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
        contextCompaction: {
          keepRecentTokens: 1,
        },
        drainSteeringMessages: () => {
          if (drainedSteering) {
            return [];
          }
          drainedSteering = true;
          return [{ role: "user", content: "Now answer from the package." }];
        },
      }),
    );

    // Then
    expect(mainRequests).toBe(4);
    expect(summaryRequests).toBe(2);
    expect(events).toContainEqual({
      type: "text",
      text: "Answered after second recovery.",
    });
  });

  test(`Given context overflows during the max-turn wrap-up request,
    When compaction succeeds,
    Then the wrap-up request retries and the run ends with a turn-limit summary`, async () => {
    // Given
    const messages: Message[] = [
      { role: "user", content: "Inspect the package before finishing." },
    ];
    let wrapUpOverflowed = false;
    let compactedForWrapUp = false;
    const provider: LLMProvider = {
      id: "wrap-up-overflow-provider",
      async *stream(options) {
        const firstMessage = options.messages[0];
        if (
          options.toolChoice === "none" &&
          firstMessage?.role === "user" &&
          firstMessage.content.includes("<conversation>")
        ) {
          compactedForWrapUp = true;
          yield { type: "text", text: "Wrap-up context summary." };
          yield { type: "stop", usage: ZERO_USAGE };
          return;
        }

        if (options.toolChoice === "none") {
          if (!wrapUpOverflowed) {
            wrapUpOverflowed = true;
            throw new KeelError(
              "provider_context_overflow",
              "Wrap-up request exceeds context",
            );
          }
          yield { type: "text", text: "Stopped before running tools." };
          yield { type: "stop", usage: ZERO_USAGE };
          return;
        }

        yield { type: "text", text: "Need to inspect." };
        yield {
          type: "tool_call",
          id: "read_package_for_wrapup",
          tool: "read",
          path: "package.json",
          limit: 1,
        };
        yield { type: "stop", usage: ZERO_USAGE };
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
        stopPolicy: maxTurnFallbackPolicy(1),
        contextCompaction: {
          keepRecentTokens: 1,
        },
      }),
    );

    // Then
    expect(compactedForWrapUp).toBe(true);
    expect(events).toContainEqual({
      type: "text",
      text: "Stopped before running tools.",
    });
    expect(endEvent(events)).toMatchObject({
      turns: 2,
      stopReason: "turn_limit",
    });
    expect(messages.at(-1)).toEqual({
      role: "assistant",
      content: "Need to inspect.\nStopped before running tools.",
    });
  });
});
