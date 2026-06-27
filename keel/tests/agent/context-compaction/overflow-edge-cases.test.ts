import { describe, expect, test } from "vitest";
import { compactMessages } from "../../../src/agent/context-compaction.ts";
import { runAgentTurn } from "../../../src/agent/loop.ts";
import {
  defaultStopPolicy,
  maxTurnFallbackPolicy,
} from "../../../src/agent/stop-policy.ts";
import { KeelError } from "../../../src/core/error.ts";
import type { LLMProvider, Message } from "../../../src/llm/types.ts";
import {
  collect,
  endEvent,
  failingStream,
  freshSignal,
  workspace,
  ZERO_USAGE,
} from "../../../src/testing/context-compaction-fixtures.ts";

describe("Context Compaction Overflow Edge Cases", () => {
  test(`Given an unconsumed tool result is the final message when the provider reports context overflow,
    When preserving the latest user and current tool round leaves no history to summarize,
    Then overflow recovery surfaces the overflow without adding an empty checkpoint`, async () => {
    // Given
    const currentToolOutput = "large log output ".repeat(400);
    const messages: Message[] = [
      { role: "user", content: "Read the large log and continue." },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "read_large_log",
            tool: "read",
            path: "large.log",
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "read_large_log",
        content: currentToolOutput,
      },
    ];
    let mainRequests = 0;
    let summaryRequests = 0;
    let summaryPrompt = "";
    const provider: LLMProvider = {
      id: "tool-tail-overflow-provider",
      async *stream(options) {
        if (options.toolChoice === "none") {
          summaryRequests++;
          summaryPrompt = options.messages[0]?.content ?? "";
          yield { type: "text", text: "The log was read; continue analysis." };
          yield {
            type: "stop",
            reason: "stop",
            usage: {
              inputTokens: 30,
              cachedInputTokens: 0,
              uncachedInputTokens: 30,
              outputTokens: 5,
            },
          };
          return;
        }

        mainRequests++;
        if (mainRequests === 1) {
          throw new KeelError(
            "provider_context_overflow",
            "Tool result made request too large",
          );
        }
        throw new Error(
          "Overflow recovery should not retry without compaction",
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
          allowBash: false,
          stopPolicy: defaultStopPolicy(),
          contextCompaction: {
            keepRecentTokens: 1,
          },
        }),
      ),
    ).rejects.toMatchObject({
      name: "KeelError",
      code: "provider_context_overflow",
    });

    expect(mainRequests).toBe(1);
    expect(summaryRequests).toBe(0);
    expect(summaryPrompt).toBe("");
    expect(messages).toEqual([
      {
        role: "user",
        content: "Read the large log and continue.",
      },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "read_large_log",
            tool: "read",
            path: "large.log",
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "read_large_log",
        content: currentToolOutput,
      },
    ]);
  });

  test(`Given a malformed current tool suffix has no preceding user,
    When compaction would need to preserve that suffix from the beginning,
    Then it reports no compaction instead of adding an empty checkpoint`, async () => {
    // Given
    const currentToolOutput = "headless current tool output ".repeat(200);
    const messages: Message[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "headless_tool",
            tool: "read",
            path: "headless.log",
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "headless_tool",
        content: currentToolOutput,
      },
      {
        role: "user",
        content: "Latest instruction: continue from malformed history.",
      },
    ];
    const provider: LLMProvider = {
      id: "headless-current-tool-provider",
      async *stream() {
        yield { type: "text", text: "Unexpected summary request." };
        throw new Error("Compaction should not summarize a protected suffix");
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
      },
    });

    // Then
    expect(result).toEqual({
      compacted: false,
      usage: ZERO_USAGE,
    });
    expect(messages).toEqual([
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "headless_tool",
            tool: "read",
            path: "headless.log",
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "headless_tool",
        content: currentToolOutput,
      },
      {
        role: "user",
        content: "Latest instruction: continue from malformed history.",
      },
    ]);
  });

  test(`Given proactive compaction has no safe split,
    When a long current request starts,
    Then the agent sends the original request without adding an empty checkpoint`, async () => {
    // Given
    const messages: Message[] = [
      { role: "user", content: "Only current request. ".repeat(200) },
    ];
    let summaryRequests = 0;
    let mainRequestMessages: readonly Message[] = [];
    const provider: LLMProvider = {
      id: "proactive-without-safe-split-provider",
      async *stream(options) {
        if (options.toolChoice === "none") {
          summaryRequests++;
          throw new Error("Compaction should not summarize an empty prefix");
        }
        mainRequestMessages = options.messages;
        yield { type: "text", text: "Answered without empty checkpoint." };
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
          contextWindowTokens: 50,
          reserveTokens: 0,
          keepRecentTokens: 1,
        },
      }),
    );

    // Then
    expect(summaryRequests).toBe(0);
    expect(mainRequestMessages).toEqual([
      { role: "user", content: "Only current request. ".repeat(200) },
    ]);
    expect(events.some((event) => event.type === "context_compacted")).toBe(
      false,
    );
    expect(events).toContainEqual({
      type: "text",
      text: "Answered without empty checkpoint.",
    });
  });

  test(`Given overflow recovery already retried once,
    When the compacted request still overflows,
    Then the agent fails instead of compacting in a loop`, async () => {
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
    const provider: LLMProvider = {
      id: "persistent-overflow",
      async *stream(options) {
        requestCount++;
        if (options.toolChoice === "none") {
          yield { type: "text", text: "Earlier task summary." };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
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
          allowBash: false,
          stopPolicy: defaultStopPolicy(),
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
      {
        role: "assistant",
        content: "Earlier progress ".repeat(80),
        toolCalls: [],
      },
      { role: "user", content: "Finish now." },
    ];
    let mainRequests = 0;
    const provider: LLMProvider = {
      id: "empty-delta-overflow-provider",
      async *stream(options) {
        if (options.toolChoice === "none") {
          yield { type: "text", text: "Earlier task summary." };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
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
          allowBash: false,
          stopPolicy: defaultStopPolicy(),
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

  test(`Given provider context overflow happens before output without explicit compaction options,
    When default overflow recovery can summarize older history,
    Then the agent compacts and retries once`, async () => {
    // Given
    const messages: Message[] = [
      { role: "user", content: "Earlier context ".repeat(6000) },
      {
        role: "assistant",
        content: "Earlier answer ".repeat(6000),
        toolCalls: [],
      },
      { role: "user", content: "Finish now." },
    ];
    let mainRequests = 0;
    let summaryRequests = 0;
    const provider: LLMProvider = {
      id: "default-overflow-recovery-provider",
      async *stream(options) {
        if (options.toolChoice === "none") {
          summaryRequests++;
          yield { type: "text", text: "Default context summary." };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }

        mainRequests++;
        if (mainRequests === 1) {
          throw new KeelError(
            "provider_context_overflow",
            "Provider reports prompt too long",
          );
        }

        yield { type: "text", text: "Recovered with defaults." };
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
      }),
    );

    // Then
    expect(mainRequests).toBe(2);
    expect(summaryRequests).toBe(1);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "context_compacted",
        reason: "overflow_recovery",
        beforeMessageCount: 3,
        afterMessageCount: 2,
        beforeEstimatedTokens: expect.any(Number),
        afterEstimatedTokens: expect.any(Number),
        toolOutputsCompacted: 0,
      }),
    );
    expect(events).toContainEqual({
      type: "text",
      text: "Recovered with defaults.",
    });
  });

  test(`Given separate model requests overflow in the same agent run,
    When each request has not recovered before,
    Then each request gets its own compact-and-retry attempt`, async () => {
    // Given
    const messages: Message[] = [
      { role: "user", content: "Earlier context ".repeat(80) },
      {
        role: "assistant",
        content: "Earlier answer ".repeat(80),
        toolCalls: [],
      },
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
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
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
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }

        yield { type: "text", text: "Answered after second recovery." };
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
          keepRecentTokens: 1,
        },
        drainInjectedUserMessages: () => {
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
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
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
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
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
      toolCalls: [],
    });
  });
});
