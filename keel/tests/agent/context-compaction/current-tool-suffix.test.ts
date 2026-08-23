import { describe, expect, test } from "vitest";
import { runAgentTurn } from "../../../src/agent/loop.ts";
import type { SessionMessage } from "../../../src/agent/session-message.ts";
import { defaultStopPolicy } from "../../../src/agent/stop-policy.ts";
import { KeelError } from "../../../src/core/error.ts";
import type { LLMProvider, ProviderMessage } from "../../../src/llm/types.ts";
import {
  collect,
  freshSignal,
  workspace,
  ZERO_USAGE,
} from "../../../src/testing/context-compaction-fixtures.ts";
import { sessionLedgerMirroringMessages } from "../../../src/testing/session-ledger-fixtures.ts";

const CURRENT_TOOL_OUTPUT_MARKER =
  "[current tool output compacted after context overflow:";

describe("Context Compaction Current Tool Suffix", () => {
  test(`Given retained recent context contains an unconsumed large tool output before a steering user,
    When overflow recovery compacts the conversation,
    Then the retry keeps the current tool linkage and compacts the current tool output`, async () => {
    // Given
    const currentToolOutput = [
      "CURRENT_LOG_START",
      "current log line ".repeat(500),
      "CURRENT_LOG_END",
    ].join("\n");
    const messages: SessionMessage[] = [
      { role: "user", content: "Remember the setup." },
      { role: "assistant", content: "Setup remembered.", toolCalls: [] },
      { role: "user", content: "Read the current log." },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "read_current_log",
            tool: "read",
            path: "current.log",
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "read_current_log",
        content: currentToolOutput,
      },
      {
        role: "user",
        content: "Steering update: answer only after using the current log.",
      },
    ];
    let mainRequests = 0;
    let retriedMessages: readonly ProviderMessage[] = [];
    const provider: LLMProvider = {
      id: "current-tool-output-overflow-provider",
      async *stream(options) {
        if (options.toolExposure?.kind === "none") {
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
              message.toolCallId === "read_current_log",
          )?.content ?? "";
        if (
          !retainedToolOutput.includes(CURRENT_TOOL_OUTPUT_MARKER) ||
          retainedToolOutput.includes("CURRENT_LOG_END")
        ) {
          throw new KeelError(
            "provider_context_overflow",
            "Retry did not compact the unconsumed current tool output",
          );
        }

        yield {
          type: "text",
          text: "Continued with the compacted current tool output.",
        };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };

    // When
    const events = await collect(
      runAgentTurn({
        workspace: workspace(),
        provider,
        ledger: sessionLedgerMirroringMessages(messages),
        systemPrompt: "You are helpful.",
        signal: freshSignal(),
        bash: { kind: "trusted" },
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
      content: "Steering update: answer only after using the current log.",
    });
    const retainedTool = retriedMessages.find(
      (message) =>
        message.role === "tool" && message.toolCallId === "read_current_log",
    );
    expect(retainedTool).toEqual({
      role: "tool",
      toolCallId: "read_current_log",
      content: expect.stringContaining(CURRENT_TOOL_OUTPUT_MARKER),
    });
    expect(retainedTool?.content).not.toBe(currentToolOutput);
    expect(retainedTool?.content).not.toContain("CURRENT_LOG_END");
    expect(retainedTool?.content).not.toContain(
      "[stale tool output compacted:",
    );
    expect(events).toContainEqual({
      type: "text",
      text: "Continued with the compacted current tool output.",
    });
  });

  test(`Given split-turn compaction would keep an oversized unconsumed tool result,
    When overflow recovery retries after summarizing older context,
    Then the unconsumed tool result is compacted before the retry`, async () => {
    // Given
    const currentToolOutput = [
      "UNCONSUMED_LOG_START",
      "unconsumed current log line ".repeat(700),
      "UNCONSUMED_LOG_END",
    ].join("\n");
    const messages: SessionMessage[] = [
      { role: "user", content: "Remember the baseline." },
      { role: "assistant", content: "Baseline remembered.", toolCalls: [] },
      { role: "user", content: "Review the older recent note." },
      {
        role: "assistant",
        content: "Older recent note can be summarized.",
        toolCalls: [],
      },
      { role: "user", content: "Read the current log." },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "read_unconsumed_log",
            tool: "read",
            path: "current.log",
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "read_unconsumed_log",
        content: currentToolOutput,
      },
      {
        role: "user",
        content: "Latest instruction: answer only after using that log.",
      },
    ];
    let mainRequests = 0;
    let summaryPrompt = "";
    let retriedMessages: readonly ProviderMessage[] = [];
    const provider: LLMProvider = {
      id: "split-turn-unconsumed-tool-overflow-provider",
      async *stream(options) {
        if (options.toolExposure?.kind === "none") {
          summaryPrompt = options.messages[0]?.content ?? "";
          yield {
            type: "text",
            text: "Summary before unconsumed tool output.",
          };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }

        mainRequests++;
        if (mainRequests === 1) {
          throw new KeelError(
            "provider_context_overflow",
            "Request exceeded context before split-turn compaction",
          );
        }

        retriedMessages = [...options.messages];
        const retriedToolOutput =
          retriedMessages.find(
            (message) =>
              message.role === "tool" &&
              message.toolCallId === "read_unconsumed_log",
          )?.content ?? "";
        if (
          !retriedToolOutput.includes(CURRENT_TOOL_OUTPUT_MARKER) ||
          retriedToolOutput.includes("UNCONSUMED_LOG_END")
        ) {
          throw new KeelError(
            "provider_context_overflow",
            "Retry did not compact the unconsumed tool output",
          );
        }

        yield {
          type: "text",
          text: "Continued after compacting the unconsumed tool output.",
        };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };

    // When
    const events = await collect(
      runAgentTurn({
        workspace: workspace(),
        provider,
        ledger: sessionLedgerMirroringMessages(messages),
        systemPrompt: "You are helpful.",
        signal: freshSignal(),
        bash: { kind: "trusted" },
        stopPolicy: defaultStopPolicy(),
        contextCompaction: {
          keepRecentTokens: 20,
          toolOutputMaxChars: 128,
        },
      }),
    );

    // Then
    expect(mainRequests).toBe(2);
    expect(summaryPrompt).toContain("Older recent note can be summarized.");
    expect(summaryPrompt).not.toContain("Read the current log.");
    expect(summaryPrompt).not.toContain("UNCONSUMED_LOG_END");
    const toolCallIndex = retriedMessages.findIndex(
      (message) =>
        message.role === "assistant" &&
        message.toolCalls.some(
          (toolCall) => toolCall.id === "read_unconsumed_log",
        ),
    );
    const toolResultIndex = retriedMessages.findIndex(
      (message) =>
        message.role === "tool" && message.toolCallId === "read_unconsumed_log",
    );
    expect(toolCallIndex).toBeGreaterThan(-1);
    expect(toolResultIndex).toBe(toolCallIndex + 1);
    expect(retriedMessages).toContainEqual({
      role: "user",
      content: "Read the current log.",
    });
    expect(retriedMessages[toolResultIndex]).toEqual({
      role: "tool",
      toolCallId: "read_unconsumed_log",
      content: expect.stringContaining(CURRENT_TOOL_OUTPUT_MARKER),
    });
    expect(retriedMessages[toolResultIndex]?.content).not.toBe(
      currentToolOutput,
    );
    expect(retriedMessages[toolResultIndex]?.content).not.toContain(
      "UNCONSUMED_LOG_END",
    );
    expect(retriedMessages).toContainEqual({
      role: "user",
      content: "Latest instruction: answer only after using that log.",
    });
    expect(events).toContainEqual({
      type: "text",
      text: "Continued after compacting the unconsumed tool output.",
    });
  });

  test(`Given an unconsumed tool result is followed by multiple steering users,
    When split-turn compaction retries after context overflow,
    Then no steering boundary can drop the compacted current tool result`, async () => {
    // Given
    const currentToolOutput = [
      "QUEUED_STEERING_LOG_START",
      "queued steering log line ".repeat(700),
      "QUEUED_STEERING_LOG_END",
    ].join("\n");
    const messages: SessionMessage[] = [
      { role: "user", content: "Remember the baseline." },
      { role: "assistant", content: "Baseline remembered.", toolCalls: [] },
      { role: "user", content: "Read the queued steering log." },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "read_queued_steering_log",
            tool: "read",
            path: "queued-steering.log",
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "read_queued_steering_log",
        content: currentToolOutput,
      },
      {
        role: "user",
        content: "Steering update A: preserve the current tool result.",
      },
      {
        role: "user",
        content: "Steering update B: answer from that result.",
      },
    ];
    let mainRequests = 0;
    let retriedMessages: readonly ProviderMessage[] = [];
    const provider: LLMProvider = {
      id: "split-turn-multiple-steering-provider",
      async *stream(options) {
        if (options.toolExposure?.kind === "none") {
          yield {
            type: "text",
            text: "Summary before the queued steering tool result.",
          };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }

        mainRequests++;
        if (mainRequests === 1) {
          throw new KeelError(
            "provider_context_overflow",
            "Request exceeded context before split-turn compaction",
          );
        }

        retriedMessages = [...options.messages];
        const toolResult = retriedMessages.find(
          (message) =>
            message.role === "tool" &&
            message.toolCallId === "read_queued_steering_log",
        );
        if (
          toolResult?.content.includes(CURRENT_TOOL_OUTPUT_MARKER) !== true ||
          toolResult.content.includes("QUEUED_STEERING_LOG_END")
        ) {
          throw new KeelError(
            "provider_context_overflow",
            "Retry did not compact the current tool result behind steering users",
          );
        }

        yield {
          type: "text",
          text: "Continued with queued steering and current tool output.",
        };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };

    // When
    const events = await collect(
      runAgentTurn({
        workspace: workspace(),
        provider,
        ledger: sessionLedgerMirroringMessages(messages),
        systemPrompt: "You are helpful.",
        signal: freshSignal(),
        bash: { kind: "trusted" },
        stopPolicy: defaultStopPolicy(),
        contextCompaction: {
          keepRecentTokens: 20,
          toolOutputMaxChars: 128,
        },
      }),
    );

    // Then
    expect(mainRequests).toBe(2);
    expect(retriedMessages).toContainEqual({
      role: "user",
      content: "Read the queued steering log.",
    });
    expect(retriedMessages).toContainEqual({
      role: "tool",
      toolCallId: "read_queued_steering_log",
      content: expect.stringContaining(CURRENT_TOOL_OUTPUT_MARKER),
    });
    expect(retriedMessages).toContainEqual({
      role: "user",
      content: "Steering update A: preserve the current tool result.",
    });
    expect(retriedMessages).toContainEqual({
      role: "user",
      content: "Steering update B: answer from that result.",
    });
    expect(events).toContainEqual({
      type: "text",
      text: "Continued with queued steering and current tool output.",
    });
  });

  test(`Given split-turn compaction retains an unconsumed multi-tool round,
    When overflow recovery retries,
    Then the retry keeps the assistant tool calls and all compacted sibling tool results together`, async () => {
    // Given
    const firstToolOutput = [
      "FIRST_CURRENT_LOG_START",
      "first current log line ".repeat(500),
      "FIRST_CURRENT_LOG_END",
    ].join("\n");
    const secondToolOutput = [
      "SECOND_CURRENT_LOG_START",
      "second current log line ".repeat(500),
      "SECOND_CURRENT_LOG_END",
    ].join("\n");
    const messages: SessionMessage[] = [
      { role: "user", content: "Remember the baseline." },
      { role: "assistant", content: "Baseline remembered.", toolCalls: [] },
      { role: "user", content: "Read both current logs." },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "read_first_current_log",
            tool: "read",
            path: "first-current.log",
          },
          {
            id: "read_second_current_log",
            tool: "read",
            path: "second-current.log",
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "read_first_current_log",
        content: firstToolOutput,
      },
      {
        role: "tool",
        toolCallId: "read_second_current_log",
        content: secondToolOutput,
      },
      {
        role: "user",
        content: "Latest instruction: answer after using both logs.",
      },
    ];
    let mainRequests = 0;
    let retriedMessages: readonly ProviderMessage[] = [];
    const provider: LLMProvider = {
      id: "split-turn-multi-tool-round-provider",
      async *stream(options) {
        if (options.toolExposure?.kind === "none") {
          yield {
            type: "text",
            text: "Summary before the current multi-tool round.",
          };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }

        mainRequests++;
        if (mainRequests === 1) {
          throw new KeelError(
            "provider_context_overflow",
            "Request exceeded context before split-turn compaction",
          );
        }

        retriedMessages = [...options.messages];
        const toolRequestIndex = retriedMessages.findIndex(
          (message) =>
            message.role === "assistant" && message.toolCalls.length === 2,
        );
        const firstToolIndex = retriedMessages.findIndex(
          (message) =>
            message.role === "tool" &&
            message.toolCallId === "read_first_current_log",
        );
        const secondToolIndex = retriedMessages.findIndex(
          (message) =>
            message.role === "tool" &&
            message.toolCallId === "read_second_current_log",
        );
        if (
          toolRequestIndex < 0 ||
          firstToolIndex !== toolRequestIndex + 1 ||
          secondToolIndex !== toolRequestIndex + 2
        ) {
          throw new KeelError(
            "provider_context_overflow",
            "Retry broke the current multi-tool round",
          );
        }

        yield {
          type: "text",
          text: "Continued with both compacted current tool results.",
        };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };

    // When
    const events = await collect(
      runAgentTurn({
        workspace: workspace(),
        provider,
        ledger: sessionLedgerMirroringMessages(messages),
        systemPrompt: "You are helpful.",
        signal: freshSignal(),
        bash: { kind: "trusted" },
        stopPolicy: defaultStopPolicy(),
        contextCompaction: {
          keepRecentTokens: 20,
          toolOutputMaxChars: 128,
        },
      }),
    );

    // Then
    expect(mainRequests).toBe(2);
    expect(retriedMessages).toContainEqual({
      role: "tool",
      toolCallId: "read_first_current_log",
      content: expect.stringContaining(CURRENT_TOOL_OUTPUT_MARKER),
    });
    expect(retriedMessages).toContainEqual({
      role: "tool",
      toolCallId: "read_second_current_log",
      content: expect.stringContaining(CURRENT_TOOL_OUTPUT_MARKER),
    });
    expect(retriedMessages).toContainEqual({
      role: "user",
      content: "Latest instruction: answer after using both logs.",
    });
    expect(events).toContainEqual({
      type: "text",
      text: "Continued with both compacted current tool results.",
    });
  });

  test(`Given an unconsumed current tool result follows earlier tool progress in the same user turn,
    When split-turn compaction retries after context overflow,
    Then the retry keeps the original user instruction and compacts the final unconsumed tool result`, async () => {
    // Given
    const firstToolOutput = [
      "SEQUENTIAL_FIRST_LOG_START",
      "first sequential log line ".repeat(200),
      "SEQUENTIAL_FIRST_LOG_END",
    ].join("\n");
    const secondToolOutput = [
      "SEQUENTIAL_SECOND_LOG_START",
      "second sequential log line ".repeat(700),
      "SEQUENTIAL_SECOND_LOG_END",
    ].join("\n");
    const messages: SessionMessage[] = [
      { role: "user", content: "Remember the baseline." },
      { role: "assistant", content: "Baseline remembered.", toolCalls: [] },
      { role: "user", content: "Inspect both logs before answering." },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "read_sequential_first_log",
            tool: "read",
            path: "sequential-first.log",
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "read_sequential_first_log",
        content: firstToolOutput,
      },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "read_sequential_second_log",
            tool: "read",
            path: "sequential-second.log",
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "read_sequential_second_log",
        content: secondToolOutput,
      },
    ];
    let mainRequests = 0;
    let retriedMessages: readonly ProviderMessage[] = [];
    const provider: LLMProvider = {
      id: "split-turn-sequential-tool-round-provider",
      async *stream(options) {
        if (options.toolExposure?.kind === "none") {
          yield {
            type: "text",
            text: "Summary before the sequential current tool suffix.",
          };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }

        mainRequests++;
        if (mainRequests === 1) {
          throw new KeelError(
            "provider_context_overflow",
            "Request exceeded context before split-turn compaction",
          );
        }

        retriedMessages = [...options.messages];
        yield {
          type: "text",
          text: "Continued with the compacted sequential tool suffix.",
        };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };

    // When
    const events = await collect(
      runAgentTurn({
        workspace: workspace(),
        provider,
        ledger: sessionLedgerMirroringMessages(messages),
        systemPrompt: "You are helpful.",
        signal: freshSignal(),
        bash: { kind: "trusted" },
        stopPolicy: defaultStopPolicy(),
        contextCompaction: {
          keepRecentTokens: 20,
          toolOutputMaxChars: 128,
        },
      }),
    );

    // Then
    expect(mainRequests).toBe(2);
    expect(retriedMessages).toContainEqual({
      role: "user",
      content: "Inspect both logs before answering.",
    });
    const firstToolResult = retriedMessages.find(
      (message) =>
        message.role === "tool" &&
        message.toolCallId === "read_sequential_first_log",
    );
    expect(firstToolResult?.content).toContain("SEQUENTIAL_FIRST_LOG_START");
    expect(firstToolResult?.content).toContain("[stale tool output compacted:");
    const secondToolResult = retriedMessages.find(
      (message) =>
        message.role === "tool" &&
        message.toolCallId === "read_sequential_second_log",
    );
    expect(secondToolResult).toEqual({
      role: "tool",
      toolCallId: "read_sequential_second_log",
      content: expect.stringContaining(CURRENT_TOOL_OUTPUT_MARKER),
    });
    expect(secondToolResult?.content).not.toBe(secondToolOutput);
    expect(secondToolResult?.content).not.toContain(
      "SEQUENTIAL_SECOND_LOG_END",
    );
    expect(events).toContainEqual({
      type: "text",
      text: "Continued with the compacted sequential tool suffix.",
    });
  });
});
