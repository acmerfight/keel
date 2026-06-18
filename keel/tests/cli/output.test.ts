import { describe, expect, test } from "vitest";
import type { AgentEvent } from "../../src/agent/loop.ts";
import {
  printAgentEvents,
  sanitizeStatusLineText,
} from "../../src/cli/output.ts";

const ZERO_USAGE = {
  inputTokens: 0,
  cachedInputTokens: 0,
  uncachedInputTokens: 0,
  outputTokens: 0,
};

async function* agentEvents(
  events: readonly AgentEvent[],
): AsyncIterable<AgentEvent> {
  yield* events;
}

describe("CLI Output", () => {
  test(`Given status line text contains unsafe terminal bytes,
    When it is sanitized,
    Then controls are rendered visibly and the line is capped`, () => {
    // Given
    const unsafe = `summary\n\u001b[31m\u202etext ${"x".repeat(300)}`;

    // When
    const sanitized = sanitizeStatusLineText(unsafe);

    // Then
    expect(sanitized).toContain("summary\\n\\x1b[31m\\u{202e}text");
    expect(sanitized).toHaveLength(243);
    expect(sanitized.endsWith("...")).toBe(true);
  });

  test(`Given context compaction happens during an agent run,
    When the CLI prints agent events,
    Then the compaction report is written to stderr without polluting stdout`, async () => {
    // Given
    let stdout = "";
    let stderr = "";

    // When
    const finalEnd = await printAgentEvents(
      agentEvents([
        {
          type: "context_compacted",
          reason: "overflow_recovery",
          beforeMessageCount: 8,
          afterMessageCount: 3,
          beforeEstimatedTokens: 12345,
          afterEstimatedTokens: 678,
          toolOutputsCompacted: 0,
          toolOutputCharsBefore: 0,
          toolOutputCharsAfter: 0,
          toolOutputEstimatedTokensBefore: 0,
          toolOutputEstimatedTokensAfter: 0,
        },
        { type: "text", text: "Done." },
        {
          type: "end",
          usage: ZERO_USAGE,
          turns: 1,
          stopReason: "completed",
        },
      ]),
      {
        writeStdout: (text) => {
          stdout += text;
        },
        writeStderr: (text) => {
          stderr += text;
        },
      },
    );

    // Then
    expect(stdout).toBe("Done.");
    expect(stderr).toBe(
      "Context compacted: overflow recovery (8 -> 3 messages, ~12345 -> ~678 tokens)\n",
    );
    expect(finalEnd?.stopReason).toBe("completed");
  });

  test(`Given context compaction shrinks stale tool output,
    When the CLI prints agent events,
    Then the compaction report includes concise tool-output reduction stats`, async () => {
    // Given
    let stdout = "";
    let stderr = "";

    // When
    const finalEnd = await printAgentEvents(
      agentEvents([
        {
          type: "context_compacted",
          reason: "proactive",
          beforeMessageCount: 10,
          afterMessageCount: 5,
          beforeEstimatedTokens: 20000,
          afterEstimatedTokens: 4000,
          toolOutputsCompacted: 2,
          toolOutputCharsBefore: 12000,
          toolOutputCharsAfter: 420,
          toolOutputEstimatedTokensBefore: 3000,
          toolOutputEstimatedTokensAfter: 105,
        },
        { type: "text", text: "Done." },
        {
          type: "end",
          usage: ZERO_USAGE,
          turns: 1,
          stopReason: "completed",
        },
      ]),
      {
        writeStdout: (text) => {
          stdout += text;
        },
        writeStderr: (text) => {
          stderr += text;
        },
      },
    );

    // Then
    expect(stdout).toBe("Done.");
    expect(stderr).toBe(
      "Context compacted: proactive (10 -> 5 messages, ~20000 -> ~4000 tokens, stale tool outputs 2 (12000 -> 420 chars, ~3000 -> ~105 tokens))\n",
    );
    expect(finalEnd?.stopReason).toBe("completed");
  });

  test(`Given context compaction shrinks one stale tool output,
    When the CLI prints agent events,
    Then the compaction report uses the singular tool-output label`, async () => {
    // Given
    let stdout = "";
    let stderr = "";

    // When
    const finalEnd = await printAgentEvents(
      agentEvents([
        {
          type: "context_compacted",
          reason: "overflow_recovery",
          beforeMessageCount: 7,
          afterMessageCount: 4,
          beforeEstimatedTokens: 1200,
          afterEstimatedTokens: 300,
          toolOutputsCompacted: 1,
          toolOutputCharsBefore: 8000,
          toolOutputCharsAfter: 160,
          toolOutputEstimatedTokensBefore: 2000,
          toolOutputEstimatedTokensAfter: 40,
        },
        { type: "text", text: "Done." },
        {
          type: "end",
          usage: ZERO_USAGE,
          turns: 1,
          stopReason: "completed",
        },
      ]),
      {
        writeStdout: (text) => {
          stdout += text;
        },
        writeStderr: (text) => {
          stderr += text;
        },
      },
    );

    // Then
    expect(stdout).toBe("Done.");
    expect(stderr).toBe(
      "Context compacted: overflow recovery (7 -> 4 messages, ~1200 -> ~300 tokens, stale tool output 1 (8000 -> 160 chars, ~2000 -> ~40 tokens))\n",
    );
    expect(finalEnd?.stopReason).toBe("completed");
  });
});
