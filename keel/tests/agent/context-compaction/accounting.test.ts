import { describe, expect, test } from "vitest";
import {
  captureContextCompactionAccountingSnapshot,
  shouldCompactBeforeRequest,
} from "../../../src/agent/context-compaction.ts";
import { runAgentTurn } from "../../../src/agent/loop.ts";
import { defaultStopPolicy } from "../../../src/agent/stop-policy.ts";
import type { LLMProvider, Message } from "../../../src/llm/types.ts";
import {
  collect,
  freshSignal,
  workspace,
  ZERO_USAGE,
} from "../../../src/testing/context-compaction-fixtures.ts";

describe("Context Compaction Accounting", () => {
  test(`Given no context window is configured,
    When a long agent turn starts,
    Then proactive compaction is skipped`, async () => {
    // Given
    const messages: Message[] = [
      { role: "user", content: "Earlier context ".repeat(80) },
      {
        role: "assistant",
        content: "Earlier answer ".repeat(80),
        toolCalls: [],
      },
      { role: "user", content: "Continue." },
    ];
    let summaryRequested = false;
    const provider: LLMProvider = {
      id: "no-window-provider",
      async *stream(options) {
        if (options.toolExposure?.kind === "none") {
          summaryRequested = true;
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        yield { type: "text", text: "Continued without compaction." };
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
        bash: { kind: "disabled" },
        stopPolicy: defaultStopPolicy(),
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

  test(`Given provider usage accounting captured an unchanged completed prefix,
    When proactive compaction checks a later request,
    Then the provider-visible prefix size determines the compaction decision`, () => {
    // Given
    const completedMessages: Message[] = [
      { role: "user", content: "Completed prefix ".repeat(80) },
    ];
    const accounting = captureContextCompactionAccountingSnapshot({
      systemPrompt: "You are helpful.",
      messages: completedMessages,
      usage: {
        inputTokens: 20,
        cachedInputTokens: 0,
        uncachedInputTokens: 20,
        outputTokens: 1,
      },
    });
    const requestMessages: Message[] = [
      ...completedMessages,
      { role: "user", content: "Continue with the next step." },
    ];

    // When
    const shouldCompactWithProviderAccounting = shouldCompactBeforeRequest(
      "You are helpful.",
      requestMessages,
      {
        contextWindowTokens: 200,
        reserveTokens: 0,
      },
      accounting,
    );
    const shouldCompactFromEstimatedMessages = shouldCompactBeforeRequest(
      "You are helpful.",
      requestMessages,
      {
        contextWindowTokens: 200,
        reserveTokens: 0,
      },
    );

    // Then
    expect(shouldCompactWithProviderAccounting).toBe(false);
    expect(shouldCompactFromEstimatedMessages).toBe(true);
  });

  test(`Given assistant reasoning metadata is provider-visible replay content,
    When proactive compaction estimates the request,
    Then reasoning metadata contributes to the context budget`, () => {
    // Given
    const messages: Message[] = [
      { role: "user", content: "Continue." },
      {
        role: "assistant",
        content: "I inspected the file.",
        providerMetadata: {
          openaiCompatible: {
            reasoningContent: "large reasoning ".repeat(200),
          },
        },
        toolCalls: [],
      },
    ];

    // When
    const shouldCompact = shouldCompactBeforeRequest(
      "You are helpful.",
      messages,
      {
        contextWindowTokens: 200,
        reserveTokens: 0,
      },
    );

    // Then
    expect(shouldCompact).toBe(true);
  });

  test(`Given provider accounting belongs to a different immutable message prefix,
    When proactive compaction checks provider-visible reasoning metadata,
    Then it re-estimates the current request before deciding to compact`, () => {
    // Given
    const previousMessages: Message[] = [
      { role: "user", content: "Continue." },
      {
        role: "assistant",
        content: "I inspected the file.",
        providerMetadata: {
          openaiCompatible: {
            reasoningContent: "short reasoning",
          },
        },
        toolCalls: [],
      },
    ];
    const accounting = captureContextCompactionAccountingSnapshot({
      systemPrompt: "You are helpful.",
      messages: previousMessages,
      usage: {
        inputTokens: 1,
        cachedInputTokens: 0,
        uncachedInputTokens: 1,
        outputTokens: 1,
      },
    });
    if (accounting === undefined) {
      throw new Error("test setup expected accounting");
    }
    const updatedMessages: Message[] = [
      { role: "user", content: "Continue." },
      {
        role: "assistant",
        content: "I inspected the file.",
        providerMetadata: {
          openaiCompatible: {
            reasoningContent: "large reasoning ".repeat(200),
          },
        },
        toolCalls: [],
      },
    ];

    // When
    const shouldCompact = shouldCompactBeforeRequest(
      "You are helpful.",
      updatedMessages,
      {
        contextWindowTokens: 200,
        reserveTokens: 0,
      },
      accounting,
    );

    // Then
    expect(shouldCompact).toBe(true);
  });

  test(`Given provider usage was captured for a tool-enabled request,
    When a text-only wrap-up request checks proactive compaction,
    Then it treats the usage as ambiguous and falls back to the estimate`, () => {
    // Given
    const messages: Message[] = [
      { role: "user", content: "Previously completed request ".repeat(80) },
    ];
    const accounting = captureContextCompactionAccountingSnapshot({
      systemPrompt: "You are helpful.",
      messages,
      usage: {
        inputTokens: 1,
        cachedInputTokens: 0,
        uncachedInputTokens: 1,
        outputTokens: 1,
      },
    });

    // When
    const shouldCompact = shouldCompactBeforeRequest(
      "You are helpful.",
      messages,
      {
        contextWindowTokens: 100,
        reserveTokens: 0,
      },
      accounting,
      { kind: "none" },
    );

    // Then
    expect(shouldCompact).toBe(true);
  });

  test(`Given provider usage was captured for a text-only request,
    When another text-only request checks proactive compaction,
    Then it reuses the provider accounting`, () => {
    // Given
    const messages: Message[] = [
      { role: "user", content: "Previously completed request ".repeat(80) },
    ];
    const accounting = captureContextCompactionAccountingSnapshot({
      systemPrompt: "You are helpful.",
      messages,
      usage: {
        inputTokens: 1,
        cachedInputTokens: 0,
        uncachedInputTokens: 1,
        outputTokens: 1,
      },
      requestMetadata: { kind: "none" },
    });

    // When
    const shouldCompact = shouldCompactBeforeRequest(
      "You are helpful.",
      messages,
      {
        contextWindowTokens: 100,
        reserveTokens: 0,
      },
      accounting,
      { kind: "none" },
    );

    // Then
    expect(shouldCompact).toBe(false);
  });

  test(`Given provider usage was captured for a text-only request,
    When a tool-enabled request checks proactive compaction,
    Then it treats the usage as ambiguous and falls back to the estimate`, () => {
    // Given
    const messages: Message[] = [
      { role: "user", content: "Previously completed request ".repeat(80) },
    ];
    const accounting = captureContextCompactionAccountingSnapshot({
      systemPrompt: "You are helpful.",
      messages,
      usage: {
        inputTokens: 1,
        cachedInputTokens: 0,
        uncachedInputTokens: 1,
        outputTokens: 1,
      },
      requestMetadata: { kind: "none" },
    });

    // When
    const shouldCompact = shouldCompactBeforeRequest(
      "You are helpful.",
      messages,
      {
        contextWindowTokens: 100,
        reserveTokens: 0,
      },
      accounting,
      { kind: "auto" },
    );

    // Then
    expect(shouldCompact).toBe(true);
  });

  test(`Given provider usage was captured with bash tool exposure,
    When proactive compaction checks a request without bash exposure,
    Then it treats the request shape as ambiguous and falls back to the estimate`, () => {
    // Given
    const messages: Message[] = [
      { role: "user", content: "Previously completed request ".repeat(80) },
    ];
    const accounting = captureContextCompactionAccountingSnapshot({
      systemPrompt: "You are helpful.",
      messages,
      usage: {
        inputTokens: 1,
        cachedInputTokens: 0,
        uncachedInputTokens: 1,
        outputTokens: 1,
      },
      requestMetadata: { kind: "auto", bash: true },
    });

    // When
    const shouldCompact = shouldCompactBeforeRequest(
      "You are helpful.",
      messages,
      {
        contextWindowTokens: 100,
        reserveTokens: 0,
      },
      accounting,
      { kind: "auto" },
    );

    // Then
    expect(shouldCompact).toBe(true);
  });

  test(`Given provider usage was captured with direct memory tools,
    When proactive compaction checks a request with reviewed memory tools,
    Then it treats the request shape as ambiguous and falls back to the estimate`, () => {
    // Given
    const messages: Message[] = [
      { role: "user", content: "Previously completed request ".repeat(80) },
    ];
    const accounting = captureContextCompactionAccountingSnapshot({
      systemPrompt: "You are helpful.",
      messages,
      usage: {
        inputTokens: 1,
        cachedInputTokens: 0,
        uncachedInputTokens: 1,
        outputTokens: 1,
      },
      requestMetadata: { kind: "auto", memory: "direct" },
    });

    // When
    const shouldCompact = shouldCompactBeforeRequest(
      "You are helpful.",
      messages,
      {
        contextWindowTokens: 100,
        reserveTokens: 0,
      },
      accounting,
      { kind: "auto", memory: "reviewed" },
    );

    // Then
    expect(shouldCompact).toBe(true);
  });

  test.each([0, Number.POSITIVE_INFINITY])(
    `Given provider usage contains unusable input token count %s,
    When compaction accounting is captured,
    Then no accounting snapshot is recorded`,
    (inputTokens) => {
      // Given
      const messages: Message[] = [
        { role: "user", content: "Completed request." },
      ];

      // When
      const accounting = captureContextCompactionAccountingSnapshot({
        systemPrompt: "You are helpful.",
        messages,
        usage: {
          inputTokens,
          cachedInputTokens: 0,
          uncachedInputTokens: 0,
          outputTokens: 1,
        },
      });

      // Then
      expect(accounting).toBeUndefined();
    },
  );
});
