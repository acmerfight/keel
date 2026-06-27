import { describe, expect, test } from "vitest";
import { compactMessages } from "../../../src/agent/context-compaction.ts";
import { runAgentTurn } from "../../../src/agent/loop.ts";
import { defaultStopPolicy } from "../../../src/agent/stop-policy.ts";
import { KeelError } from "../../../src/core/error.ts";
import type { LLMProvider, Message } from "../../../src/llm/types.ts";
import {
  collect,
  endEvent,
  estimatedTextTokens,
  freshSignal,
  onlyContextCompactedEvent,
  workspace,
  ZERO_USAGE,
} from "../../../src/testing/context-compaction-fixtures.ts";

describe("Context Compaction Stale Tool Output", () => {
  test(`Given retained recent context contains a stale large tool output,
    When overflow recovery compacts the conversation,
    Then the retry shrinks the stale tool output while keeping the latest instruction`, async () => {
    // Given
    const largeToolOutput = [
      "REPORT_START",
      "old report line ".repeat(500),
      "REPORT_END",
    ].join("\n");
    const messages: Message[] = [
      { role: "user", content: "Remember the setup." },
      { role: "assistant", content: "Setup remembered.", toolCalls: [] },
      { role: "user", content: "Read the old report." },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "read_old_report",
            tool: "read",
            path: "old-report.log",
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "read_old_report",
        content: largeToolOutput,
      },
      {
        role: "assistant",
        content: "The old report was inspected; alpha is the key finding.",
        toolCalls: [],
      },
      { role: "user", content: "Continue with the latest instruction." },
    ];
    let mainRequests = 0;
    let retriedMessages: readonly Message[] = [];
    const provider: LLMProvider = {
      id: "stale-tool-output-overflow-provider",
      async *stream(options) {
        if (options.toolChoice === "none") {
          yield { type: "text", text: "Earlier setup summary." };
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

        mainRequests++;
        if (mainRequests === 1) {
          throw new KeelError(
            "provider_context_overflow",
            "Request exceeded context before compaction",
          );
        }

        retriedMessages = [...options.messages];
        const retainedToolOutput =
          retriedMessages.find(
            (message) =>
              message.role === "tool" &&
              message.toolCallId === "read_old_report",
          )?.content ?? "";
        if (retainedToolOutput.includes("REPORT_END")) {
          throw new KeelError(
            "provider_context_overflow",
            "Retry still includes the full stale tool output",
          );
        }

        yield {
          type: "text",
          text: "Continued after shrinking stale tool output.",
        };
        yield {
          type: "stop",
          reason: "stop",
          usage: {
            inputTokens: 10,
            cachedInputTokens: 0,
            uncachedInputTokens: 10,
            outputTokens: 5,
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
          keepRecentTokens: 20_000,
          toolOutputMaxChars: 128,
        },
      }),
    );

    // Then
    const compactionEvent = onlyContextCompactedEvent(events);
    expect(mainRequests).toBe(2);
    expect(retriedMessages).toContainEqual({
      role: "user",
      content: "Continue with the latest instruction.",
    });
    const toolCallIndex = retriedMessages.findIndex(
      (message) =>
        message.role === "assistant" &&
        message.toolCalls.some((toolCall) => toolCall.id === "read_old_report"),
    );
    const toolResultIndex = retriedMessages.findIndex(
      (message) =>
        message.role === "tool" && message.toolCallId === "read_old_report",
    );
    expect(toolCallIndex).toBeGreaterThan(-1);
    expect(toolResultIndex).toBe(toolCallIndex + 1);
    const retainedToolOutput = retriedMessages[toolResultIndex]?.content ?? "";
    expect(retriedMessages[toolResultIndex]).toEqual({
      role: "tool",
      toolCallId: "read_old_report",
      content: expect.stringContaining(
        "[stale tool output compacted: approximately omitted",
      ),
    });
    expect(retriedMessages[toolResultIndex]?.content).not.toContain(
      "REPORT_END",
    );
    expect(compactionEvent).toMatchObject({
      reason: "overflow_recovery",
      toolOutputsCompacted: 1,
      toolOutputCharsBefore: largeToolOutput.length,
      toolOutputCharsAfter: retainedToolOutput.length,
      toolOutputEstimatedTokensBefore: estimatedTextTokens(largeToolOutput),
      toolOutputEstimatedTokensAfter: estimatedTextTokens(retainedToolOutput),
    });
    expect(compactionEvent.toolOutputCharsBefore).toBeGreaterThan(
      compactionEvent.toolOutputCharsAfter,
    );
    expect(compactionEvent.toolOutputEstimatedTokensBefore).toBeGreaterThan(
      compactionEvent.toolOutputEstimatedTokensAfter,
    );
    expect(events).toContainEqual({
      type: "text",
      text: "Continued after shrinking stale tool output.",
    });
    expect(endEvent(events).usage).toEqual({
      inputTokens: 40,
      cachedInputTokens: 0,
      uncachedInputTokens: 40,
      outputTokens: 9,
    });
  });

  test(`Given retained recent context contains multiple stale large tool outputs,
    When overflow recovery compacts the conversation,
    Then the context_compacted event aggregates all stale tool-output reductions`, async () => {
    // Given
    const firstToolOutput = [
      "FIRST_LOG_START",
      "first log line ".repeat(500),
      "FIRST_LOG_END",
    ].join("\n");
    const secondToolOutput = [
      "SECOND_LOG_START",
      "second log line ".repeat(400),
      "SECOND_LOG_END",
    ].join("\n");
    const messages: Message[] = [
      { role: "user", content: "Remember the setup." },
      { role: "assistant", content: "Setup remembered.", toolCalls: [] },
      { role: "user", content: "Read the first log." },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "read_first_log", tool: "read", path: "first.log" }],
      },
      {
        role: "tool",
        toolCallId: "read_first_log",
        content: firstToolOutput,
      },
      {
        role: "assistant",
        content: "The first log was inspected.",
        toolCalls: [],
      },
      { role: "user", content: "Read the second log." },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "read_second_log", tool: "read", path: "second.log" },
        ],
      },
      {
        role: "tool",
        toolCallId: "read_second_log",
        content: secondToolOutput,
      },
      {
        role: "assistant",
        content: "The second log was inspected.",
        toolCalls: [],
      },
      { role: "user", content: "Continue with the latest instruction." },
    ];
    let mainRequests = 0;
    let retriedMessages: readonly Message[] = [];
    const provider: LLMProvider = {
      id: "multiple-stale-tool-output-provider",
      async *stream(options) {
        if (options.toolChoice === "none") {
          yield { type: "text", text: "Earlier setup summary." };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }

        mainRequests++;
        if (mainRequests === 1) {
          throw new KeelError(
            "provider_context_overflow",
            "Request exceeded context before compaction",
          );
        }

        retriedMessages = [...options.messages];
        yield {
          type: "text",
          text: "Continued after shrinking stale tool outputs.",
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
        stopPolicy: defaultStopPolicy(),
        contextCompaction: {
          keepRecentTokens: 20_000,
          toolOutputMaxChars: 128,
        },
      }),
    );

    // Then
    const compactionEvent = onlyContextCompactedEvent(events);
    const compactedToolOutputs = retriedMessages.filter(
      (message): message is Extract<Message, { readonly role: "tool" }> =>
        message.role === "tool",
    );
    const toolOutputCharsAfter = compactedToolOutputs.reduce(
      (total, message) => total + message.content.length,
      0,
    );
    const toolOutputEstimatedTokensAfter = compactedToolOutputs.reduce(
      (total, message) => total + estimatedTextTokens(message.content),
      0,
    );
    expect(mainRequests).toBe(2);
    expect(retriedMessages).toContainEqual({
      role: "user",
      content: "Continue with the latest instruction.",
    });
    expect(compactedToolOutputs).toHaveLength(2);
    expect(compactedToolOutputs).toEqual([
      expect.objectContaining({
        toolCallId: "read_first_log",
        content: expect.stringContaining(
          "[stale tool output compacted: approximately omitted",
        ),
      }),
      expect.objectContaining({
        toolCallId: "read_second_log",
        content: expect.stringContaining(
          "[stale tool output compacted: approximately omitted",
        ),
      }),
    ]);
    expect(compactionEvent).toMatchObject({
      reason: "overflow_recovery",
      toolOutputsCompacted: 2,
      toolOutputCharsBefore: firstToolOutput.length + secondToolOutput.length,
      toolOutputCharsAfter,
      toolOutputEstimatedTokensBefore:
        estimatedTextTokens(firstToolOutput) +
        estimatedTextTokens(secondToolOutput),
      toolOutputEstimatedTokensAfter,
    });
    expect(compactionEvent.toolOutputCharsBefore).toBeGreaterThan(
      compactionEvent.toolOutputCharsAfter,
    );
    expect(compactionEvent.toolOutputEstimatedTokensBefore).toBeGreaterThan(
      compactionEvent.toolOutputEstimatedTokensAfter,
    );
    expect(events).toContainEqual({
      type: "text",
      text: "Continued after shrinking stale tool outputs.",
    });
    expect(endEvent(events).usage).toEqual({
      inputTokens: 0,
      cachedInputTokens: 0,
      uncachedInputTokens: 0,
      outputTokens: 0,
    });
  });

  test(`Given a consumed large tool output appears after the latest user,
    When overflow recovery compacts the conversation,
    Then the retry shrinks the consumed tool output`, async () => {
    // Given
    const largeToolOutput = [
      "SINGLE_USER_LOG_START",
      "single user log line ".repeat(500),
      "SINGLE_USER_LOG_END",
    ].join("\n");
    const messages: Message[] = [
      { role: "user", content: "Remember the setup." },
      { role: "assistant", content: "Setup remembered.", toolCalls: [] },
      { role: "user", content: "Analyze the current log." },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "read_single_user_log",
            tool: "read",
            path: "current.log",
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "read_single_user_log",
        content: largeToolOutput,
      },
      {
        role: "assistant",
        content: "The current log was inspected; beta is the key finding.",
        toolCalls: [],
      },
    ];
    let mainRequests = 0;
    let retriedMessages: readonly Message[] = [];
    const provider: LLMProvider = {
      id: "single-user-consumed-tool-overflow-provider",
      async *stream(options) {
        if (options.toolChoice === "none") {
          yield { type: "text", text: "Earlier setup summary." };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }

        mainRequests++;
        if (mainRequests === 1) {
          throw new KeelError(
            "provider_context_overflow",
            "Request exceeded context before compaction",
          );
        }

        retriedMessages = [...options.messages];
        const retainedToolOutput =
          retriedMessages.find(
            (message) =>
              message.role === "tool" &&
              message.toolCallId === "read_single_user_log",
          )?.content ?? "";
        if (retainedToolOutput.includes("SINGLE_USER_LOG_END")) {
          throw new KeelError(
            "provider_context_overflow",
            "Retry still includes the full consumed tool output",
          );
        }

        yield {
          type: "text",
          text: "Continued after shrinking consumed tool output.",
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
        stopPolicy: defaultStopPolicy(),
        contextCompaction: {
          keepRecentTokens: 20_000,
          toolOutputMaxChars: 128,
        },
      }),
    );

    // Then
    expect(mainRequests).toBe(2);
    expect(retriedMessages).toContainEqual({
      role: "user",
      content: "Analyze the current log.",
    });
    expect(
      retriedMessages.find(
        (message) =>
          message.role === "tool" &&
          message.toolCallId === "read_single_user_log",
      ),
    ).toEqual({
      role: "tool",
      toolCallId: "read_single_user_log",
      content: expect.stringContaining(
        "[stale tool output compacted: approximately omitted",
      ),
    });
    expect(events).toContainEqual({
      type: "text",
      text: "Continued after shrinking consumed tool output.",
    });
  });

  test(`Given retained recent context already contains a compacted stale tool output,
    When compaction runs again,
    Then the stale tool output marker is not compacted again`, async () => {
    // Given
    const compactedToolOutput = `${"old report line ".repeat(
      8,
    )}\n[stale tool output compacted: approximately omitted 8000 chars]`;
    const messages: Message[] = [
      { role: "user", content: "Remember the setup." },
      { role: "assistant", content: "Setup remembered.", toolCalls: [] },
      { role: "user", content: "Read the old report." },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "read_compacted_report",
            tool: "read",
            path: "old-report.log",
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "read_compacted_report",
        content: compactedToolOutput,
      },
      {
        role: "assistant",
        content: "The compacted old report was already inspected.",
        toolCalls: [],
      },
      { role: "user", content: "Continue with the latest instruction." },
    ];
    const provider: LLMProvider = {
      id: "already-compacted-tool-provider",
      async *stream() {
        yield { type: "text", text: "Earlier setup summary." };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };

    // When
    const result = await compactMessages({
      provider,
      systemPrompt: "You are helpful.",
      messages,
      signal: freshSignal(),
      contextCompaction: {
        keepRecentTokens: 20_000,
        toolOutputMaxChars: 128,
      },
    });

    // Then
    expect(result.compacted).toBe(true);
    expect(
      messages.find(
        (message) =>
          message.role === "tool" &&
          message.toolCallId === "read_compacted_report",
      )?.content,
    ).toBe(compactedToolOutput);
  });

  test(`Given stale tool output ends with text matching the compaction marker,
    When compaction runs,
    Then the original large tool output is still compacted`, async () => {
    // Given
    const largeToolOutput = [
      "MARKER_SUFFIX_LOG_START",
      "ordinary log line ".repeat(500),
      "[stale tool output compacted: approximately omitted 8000 chars]",
    ].join("\n");
    const messages: Message[] = [
      { role: "user", content: "Remember the setup." },
      { role: "assistant", content: "Setup remembered.", toolCalls: [] },
      { role: "user", content: "Read the old report." },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "read_marker_suffix_log",
            tool: "read",
            path: "marker-suffix.log",
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "read_marker_suffix_log",
        content: largeToolOutput,
      },
      {
        role: "assistant",
        content: "The marker suffix log was already inspected.",
        toolCalls: [],
      },
      { role: "user", content: "Continue with the latest instruction." },
    ];
    const provider: LLMProvider = {
      id: "marker-suffix-tool-provider",
      async *stream() {
        yield { type: "text", text: "Earlier setup summary." };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };

    // When
    const result = await compactMessages({
      provider,
      systemPrompt: "You are helpful.",
      messages,
      signal: freshSignal(),
      contextCompaction: {
        keepRecentTokens: 20_000,
        toolOutputMaxChars: 128,
      },
    });

    // Then
    expect(result.compacted).toBe(true);
    const retainedToolOutput =
      messages.find(
        (message) =>
          message.role === "tool" &&
          message.toolCallId === "read_marker_suffix_log",
      )?.content ?? "";
    expect(retainedToolOutput).toContain(
      "[stale tool output compacted: approximately omitted",
    );
    expect(retainedToolOutput.length).toBeLessThan(largeToolOutput.length);
  });

  test(`Given stale tool output contains compaction marker text as ordinary content,
    When compaction runs,
    Then the stale tool output is still compacted`, async () => {
    // Given
    const largeToolOutput = [
      "MARKER_LOG_START",
      "ordinary log line ".repeat(20),
      "[stale tool output compacted: this text came from the log]",
      "ordinary log line ".repeat(500),
      "MARKER_LOG_END",
    ].join("\n");
    const messages: Message[] = [
      { role: "user", content: "Remember the setup." },
      { role: "assistant", content: "Setup remembered.", toolCalls: [] },
      { role: "user", content: "Read the old report." },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "read_marker_log",
            tool: "read",
            path: "marker.log",
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "read_marker_log",
        content: largeToolOutput,
      },
      {
        role: "assistant",
        content: "The marker log was already inspected.",
        toolCalls: [],
      },
      { role: "user", content: "Continue with the latest instruction." },
    ];
    const provider: LLMProvider = {
      id: "marker-text-tool-provider",
      async *stream() {
        yield { type: "text", text: "Earlier setup summary." };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };

    // When
    const result = await compactMessages({
      provider,
      systemPrompt: "You are helpful.",
      messages,
      signal: freshSignal(),
      contextCompaction: {
        keepRecentTokens: 20_000,
        toolOutputMaxChars: 128,
      },
    });

    // Then
    expect(result.compacted).toBe(true);
    const retainedToolOutput =
      messages.find(
        (message) =>
          message.role === "tool" && message.toolCallId === "read_marker_log",
      )?.content ?? "";
    expect(retainedToolOutput).toContain(
      "[stale tool output compacted: approximately omitted",
    );
    expect(retainedToolOutput).not.toContain("MARKER_LOG_END");
  });
});
