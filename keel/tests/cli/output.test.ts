import { describe, expect, test } from "vitest";
import type { AgentEvent } from "../../src/agent/loop.ts";
import { printAgentEvents } from "../../src/cli/output.ts";

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
});
