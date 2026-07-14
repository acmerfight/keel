import { describe, expect, test } from "vitest";
import { compactMessages } from "../../../src/agent/context-compaction.ts";
import type { LLMProvider, Message } from "../../../src/llm/types.ts";
import {
  freshSignal,
  ZERO_USAGE,
} from "../../../src/testing/context-compaction-fixtures.ts";

describe("Context Compaction Split-Turn Planning", () => {
  test(`Given oversized recent context has older user-provided content before the latest instruction,
    When compaction runs,
    Then split-turn compaction summarizes the older recent content and keeps the latest instruction verbatim`, async () => {
    // Given
    const pastedLog = [
      "PASTED_LOG_START",
      "old pasted log line ".repeat(700),
      "PASTED_LOG_END",
    ].join("\n");
    const messages: Message[] = [
      { role: "user", content: "Remember the baseline." },
      { role: "assistant", content: "Baseline remembered.", toolCalls: [] },
      { role: "user", content: pastedLog },
      {
        role: "user",
        content: "Latest instruction: only report the config drift.",
      },
    ];
    let summaryPrompt = "";
    const provider: LLMProvider = {
      id: "split-turn-user-blob-provider",
      async *stream(options) {
        summaryPrompt = options.messages[0]?.content ?? "";
        yield {
          type: "text",
          text: "Summary includes the pasted log and baseline.",
        };
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
        keepRecentTokens: 20,
      },
    });

    // Then
    expect(result.compacted).toBe(true);
    expect(summaryPrompt).toContain("PASTED_LOG_START");
    expect(summaryPrompt).toContain("PASTED_LOG_END");
    expect(messages).toEqual([
      {
        role: "user",
        content: expect.stringContaining("<conversation-checkpoint>"),
        origin: { type: "compaction_checkpoint" },
      },
      {
        role: "user",
        content: "Latest instruction: only report the config drift.",
      },
    ]);
    expect(messages[0]?.content).toContain(
      "Summary includes the pasted log and baseline.",
    );
    expect(messages).not.toContainEqual({ role: "user", content: pastedLog });
  });

  test(`Given oversized recent context contains an older consumed tool round,
    When compaction runs,
    Then split-turn compaction summarizes the consumed tool round and keeps the newest actionable suffix`, async () => {
    // Given
    const consumedToolOutput = [
      "CONSUMED_LOG_START",
      "consumed log line ".repeat(500),
      "CONSUMED_LOG_END",
    ].join("\n");
    const messages: Message[] = [
      { role: "user", content: "Remember the baseline." },
      { role: "assistant", content: "Baseline remembered.", toolCalls: [] },
      { role: "user", content: "Read the consumed log." },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "read_consumed_log",
            tool: "read",
            path: "consumed.log",
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "read_consumed_log",
        content: consumedToolOutput,
      },
      {
        role: "assistant",
        content: "Consumed log inspected; gamma is the key finding.",
        toolCalls: [],
      },
      {
        role: "user",
        content: "Latest instruction: write the gamma follow-up.",
      },
    ];
    let summaryPrompt = "";
    const provider: LLMProvider = {
      id: "split-turn-consumed-tool-provider",
      async *stream(options) {
        summaryPrompt = options.messages[0]?.content ?? "";
        yield {
          type: "text",
          text: "Summary includes the consumed tool round.",
        };
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
        keepRecentTokens: 35,
        toolOutputMaxChars: 128,
      },
    });

    // Then
    expect(result.compacted).toBe(true);
    expect(summaryPrompt).toContain('tool_call_id="read_consumed_log"');
    expect(summaryPrompt).toContain("CONSUMED_LOG_START");
    expect(messages).toEqual([
      {
        role: "user",
        content: expect.stringContaining("<conversation-checkpoint>"),
        contextCompaction: {
          evidence: [
            expect.objectContaining({
              handle: "read:consumed.log",
            }),
          ],
        },
        origin: { type: "compaction_checkpoint" },
      },
      {
        role: "assistant",
        content: "Consumed log inspected; gamma is the key finding.",
        toolCalls: [],
      },
      {
        role: "user",
        content: "Latest instruction: write the gamma follow-up.",
      },
    ]);
  });

  test(`Given oversized recent context contains a pending assistant tool request without a tool result,
    When split-turn compaction searches for a safe boundary,
    Then it does not split after the pending tool request`, async () => {
    // Given
    const messages: Message[] = [
      { role: "user", content: "Older setup ".repeat(100) },
      { role: "assistant", content: "Older setup remembered.", toolCalls: [] },
      { role: "user", content: "Read the pending report." },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "read_pending_report",
            tool: "read",
            path: "pending-report.log",
          },
        ],
      },
      {
        role: "user",
        content: "Latest instruction: keep waiting for that report.",
      },
    ];
    let summaryPrompt = "";
    const provider: LLMProvider = {
      id: "split-turn-pending-tool-request-provider",
      async *stream(options) {
        summaryPrompt = options.messages[0]?.content ?? "";
        yield { type: "text", text: "Older setup summary." };
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
        keepRecentTokens: 5,
      },
    });

    // Then
    expect(result.compacted).toBe(true);
    expect(summaryPrompt).toContain("Older setup");
    expect(messages).toEqual([
      {
        role: "user",
        content: expect.stringContaining("<conversation-checkpoint>"),
        origin: { type: "compaction_checkpoint" },
      },
      { role: "user", content: "Read the pending report." },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "read_pending_report",
            tool: "read",
            path: "pending-report.log",
          },
        ],
      },
      {
        role: "user",
        content: "Latest instruction: keep waiting for that report.",
      },
    ]);
  });

  test(`Given only an older user boundary is safe before pending work,
    When split-turn compaction runs,
    Then it falls back to that boundary and keeps the pending work`, async () => {
    // Given
    const messages: Message[] = [
      { role: "user", content: "Older setup ".repeat(100) },
      { role: "assistant", content: "Older setup remembered.", toolCalls: [] },
      {
        role: "user",
        content: "Older steering note before pending work ".repeat(80),
      },
      { role: "user", content: "Read the pending diagnostics report." },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "read_pending_diagnostics",
            tool: "read",
            path: "pending-diagnostics.log",
          },
        ],
      },
      {
        role: "user",
        content: "Latest instruction: wait for diagnostics before answering.",
      },
    ];
    let summaryPrompt = "";
    const provider: LLMProvider = {
      id: "split-turn-older-user-boundary-provider",
      async *stream(options) {
        summaryPrompt = options.messages[0]?.content ?? "";
        yield { type: "text", text: "Older pending-work summary." };
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
        keepRecentTokens: 30,
      },
    });

    // Then
    expect(result.compacted).toBe(true);
    expect(summaryPrompt).toContain("Older steering note before pending work");
    expect(messages).toEqual([
      {
        role: "user",
        content: expect.stringContaining("<conversation-checkpoint>"),
        origin: { type: "compaction_checkpoint" },
      },
      { role: "user", content: "Read the pending diagnostics report." },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "read_pending_diagnostics",
            tool: "read",
            path: "pending-diagnostics.log",
          },
        ],
      },
      {
        role: "user",
        content: "Latest instruction: wait for diagnostics before answering.",
      },
    ]);
  });

  test(`Given oversized recent context contains a malformed stray tool message,
    When split-turn compaction searches for a safe boundary,
    Then it keeps the malformed tool adjacency instead of splitting through it`, async () => {
    // Given
    const strayToolOutput = "stray tool output ".repeat(400);
    const messages: Message[] = [
      { role: "user", content: "Older setup ".repeat(100) },
      { role: "assistant", content: "Older setup remembered.", toolCalls: [] },
      {
        role: "user",
        content: "Continue from malformed history ".repeat(200),
      },
      {
        role: "assistant",
        content: "Progress before a stray tool result.",
        toolCalls: [],
      },
      {
        role: "tool",
        toolCallId: "stray_tool_result",
        content: strayToolOutput,
      },
      {
        role: "user",
        content: "Latest instruction: keep the malformed suffix intact.",
      },
    ];
    const provider: LLMProvider = {
      id: "split-turn-stray-tool-provider",
      async *stream() {
        yield { type: "text", text: "Older setup summary." };
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
        keepRecentTokens: 1_900,
      },
    });

    // Then
    expect(result.compacted).toBe(true);
    expect(messages).toContainEqual({
      role: "assistant",
      content: "Progress before a stray tool result.",
      toolCalls: [],
    });
    expect(messages).toContainEqual({
      role: "tool",
      toolCallId: "stray_tool_result",
      content: strayToolOutput,
    });
    expect(messages).toContainEqual({
      role: "user",
      content: "Latest instruction: keep the malformed suffix intact.",
    });
  });
});
