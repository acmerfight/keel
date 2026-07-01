import { describe, expect, test } from "vitest";
import type { AgentEvent } from "../../src/agent/events.ts";
import {
  formatToolOutputArtifactNotice,
  formatUndoCheckpointList,
  printAgentEvents,
  printStableInteractiveAgentEvents,
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
  test(`Given there are no undo checkpoints,
    When the CLI formats the undo checkpoint list,
    Then it tells the user there are no checkpoints`, () => {
    // Given
    const checkpoints: readonly { readonly restoredLabel: string }[] = [];

    // When
    const output = formatUndoCheckpointList(checkpoints);

    // Then
    expect(output).toBe("No undo checkpoints.\n");
  });

  test(`Given a glob tool call searches the workspace root,
    When the CLI prints agent events,
    Then the progress label only includes the pattern`, async () => {
    // Given
    let stdout = "";
    let stderr = "";

    // When
    const finalEnd = await printAgentEvents(
      agentEvents([
        {
          type: "tool_start",
          toolCall: {
            id: "glob_1",
            tool: "glob",
            pattern: "**/*.test.ts",
          },
        },
        {
          type: "tool_end",
          toolCall: {
            id: "glob_1",
            tool: "glob",
            pattern: "**/*.test.ts",
          },
          ok: true,
        },
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
    expect(stdout).toBe("");
    expect(stderr).toBe("Tool: glob **/*.test.ts\n");
    expect(finalEnd?.stopReason).toBe("completed");
  });

  test(`Given a glob tool call has an explicit search path,
    When the CLI prints agent events,
    Then the progress label includes the pattern and path`, async () => {
    // Given
    let stdout = "";
    let stderr = "";

    // When
    const finalEnd = await printAgentEvents(
      agentEvents([
        {
          type: "tool_start",
          toolCall: {
            id: "glob_1",
            tool: "glob",
            pattern: "**/*.test.ts",
            path: "tests",
          },
        },
        {
          type: "tool_end",
          toolCall: {
            id: "glob_1",
            tool: "glob",
            pattern: "**/*.test.ts",
            path: "tests",
          },
          ok: true,
        },
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
    expect(stdout).toBe("");
    expect(stderr).toBe("Tool: glob **/*.test.ts tests\n");
    expect(finalEnd?.stopReason).toBe("completed");
  });

  test(`Given an ls tool call lists the workspace root,
    When the CLI prints agent events,
    Then the progress label shows the default directory`, async () => {
    // Given
    let stdout = "";
    let stderr = "";

    // When
    const finalEnd = await printAgentEvents(
      agentEvents([
        {
          type: "tool_start",
          toolCall: {
            id: "ls_1",
            tool: "ls",
          },
        },
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
    expect(stdout).toBe("");
    expect(stderr).toBe("Tool: ls .\n");
    expect(finalEnd?.stopReason).toBe("completed");
  });

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

  test(`Given tool output artifact notices are formatted,
    When the notice is stored or failed,
    Then the user sees the inspection command or lossy recovery guidance`, () => {
    // Given / When / Then
    expect(
      formatToolOutputArtifactNotice({
        status: "stored",
        ref: "tool-output:run/artifact",
        toolCallId: "call_1",
        toolName: "read",
        sourceStatus: "complete",
        omittedChars: 1200,
      }),
    ).toBe(
      "Tool output artifact: tool-output:run/artifact (keel artifacts show tool-output:run/artifact)",
    );
    expect(
      formatToolOutputArtifactNotice({
        status: "failed",
        reason: "disk\nfull",
        toolCallId: "call_1",
        toolName: "read",
        omittedChars: 1200,
      }),
    ).toBe(
      "Tool output artifact failed: disk\\nfull; output is lossy; rerun with narrower parameters if needed",
    );
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

  test(`Given a stable interactive display receives status events and streamed text,
    When the CLI prints agent events,
    Then status lines stay separate and the assistant header is written once`, async () => {
    // Given
    let stdout = "";
    let stderr = "";

    // When
    const finalEnd = await printStableInteractiveAgentEvents(
      agentEvents([
        {
          type: "context_compacted",
          reason: "proactive",
          beforeMessageCount: 10,
          afterMessageCount: 5,
          beforeEstimatedTokens: 20000,
          afterEstimatedTokens: 4000,
          toolOutputsCompacted: 0,
          toolOutputCharsBefore: 0,
          toolOutputCharsAfter: 0,
          toolOutputEstimatedTokensBefore: 0,
          toolOutputEstimatedTokensAfter: 0,
        },
        {
          type: "provider_retry",
          provider: "deepseek",
          reason: "provider_rate_limited",
          attempt: 2,
          maxRetries: 3,
          delayMs: 123.4,
        },
        {
          type: "tool_start",
          toolCall: {
            id: "read_1",
            tool: "read",
            path: "note.txt",
          },
        },
        {
          type: "tool_end",
          toolCall: {
            id: "read_1",
            tool: "read",
            path: "note.txt",
          },
          ok: true,
        },
        {
          type: "tool_end",
          toolCall: {
            id: "edit_1",
            tool: "edit",
            path: "note.txt",
            edits: [{ oldText: "old", newText: "new" }],
          },
          ok: false,
        },
        {
          type: "tool_output_artifact",
          status: "stored",
          ref: "tool-output:interactive/artifact",
          toolCallId: "read_1",
          toolName: "read",
          sourceStatus: "complete",
          omittedChars: 1200,
        },
        { type: "text", text: "Do" },
        { type: "text", text: "ne." },
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
        writeAssistantHeader: () => {
          stderr += "assistant:\n";
        },
        writeStatusLine: (text) => {
          stderr += `status: ${text}\n`;
        },
      },
    );

    // Then
    expect(stdout).toBe("Done.");
    expect(stderr).toBe(
      [
        "status: Context compacted: proactive (10 -> 5 messages, ~20000 -> ~4000 tokens)\n",
        "status: Provider retry: deepseek rate limited (attempt 2/3 in 123ms)\n",
        "status: Tool: read note.txt\n",
        "status: Tool failed: edit note.txt\n",
        "status: Tool output artifact: tool-output:interactive/artifact (keel artifacts show tool-output:interactive/artifact)\n",
        "assistant:\n",
      ].join(""),
    );
    expect(finalEnd?.stopReason).toBe("completed");
  });
});
