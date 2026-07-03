import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  compactCurrentToolOutputs,
  compactCurrentToolOutputsWithArtifacts,
  compactMessages,
  isCompactedCurrentToolOutput,
} from "../../../src/agent/context-compaction.ts";
import type { AgentEvent } from "../../../src/agent/events.ts";
import { runAgentTurn } from "../../../src/agent/loop.ts";
import { defaultStopPolicy } from "../../../src/agent/stop-policy.ts";
import type {
  ToolOutputArtifactSaveInput,
  ToolOutputArtifactStore,
} from "../../../src/agent/tool-output-artifacts.ts";
import {
  formatContextCompactionReport,
  printAgentEvents,
} from "../../../src/cli/output.ts";
import { KeelError } from "../../../src/core/error.ts";
import type { LLMProvider, Message } from "../../../src/llm/types.ts";
import {
  collect,
  contextCompactedEvents,
  estimatedTextTokens,
  failingStream,
  freshSignal,
  onlyContextCompactedEvent,
  workspace,
  ZERO_USAGE,
} from "../../../src/testing/context-compaction-fixtures.ts";

const PREFLIGHT_CURRENT_TOOL_OUTPUT_MARKER =
  "[current tool output compacted before provider request:";

interface SavedToolOutputArtifact {
  readonly input: ToolOutputArtifactSaveInput;
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function storingArtifactStore(
  saved: SavedToolOutputArtifact[],
): ToolOutputArtifactStore {
  return {
    verifyReusable: async () => ({ status: "not_reusable" }),
    save: async (input) => {
      saved.push({ input });
      return {
        status: "stored",
        ref: `tool-output:test/${saved.length}`,
        contentSha256: sha256(input.content),
      };
    },
  };
}

function capturedToolOutput(
  messages: readonly Message[],
  toolCallId: string,
): string {
  return (
    messages.find(
      (message) => message.role === "tool" && message.toolCallId === toolCallId,
    )?.content ?? ""
  );
}

describe("Context Compaction Preflight Current Tool Output", () => {
  test(`Given a huge current tool output would predictably overflow the next provider request,
    When the local estimate is over budget before the request starts,
    Then the agent compacts that current output before the first provider call`, async () => {
    // Given
    const currentToolOutput = [
      "PREFLIGHT_LOG_START",
      "preflight log line ".repeat(600),
      "PREFLIGHT_LOG_END",
    ].join("\n");
    const evidence = [
      {
        handle: "tool-output:prior/evidence",
        label: "prior evidence",
        source: "complete",
        why: "must survive preflight current-output compaction",
        inspectCommand: "keel artifacts show tool-output:prior/evidence",
      },
    ];
    const messages: Message[] = [
      {
        role: "user",
        content: "Read the large log and continue.",
        contextCompaction: { evidence },
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
    ];
    let mainRequests = 0;
    let summaryRequests = 0;
    let acceptedMessages: readonly Message[] = [];
    const provider: LLMProvider = {
      id: "preflight-current-output-provider",
      async *stream(options) {
        if (options.toolChoice === "none") {
          summaryRequests++;
          throw new Error("Current-output preflight should not summarize");
        }

        mainRequests++;
        acceptedMessages = [...options.messages];
        if (
          capturedToolOutput(options.messages, "read_large_log") ===
          currentToolOutput
        ) {
          throw new KeelError(
            "provider_context_overflow",
            "Provider should not see the uncompacted current output",
          );
        }

        yield { type: "text", text: "Continued after preflight compaction." };
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
          contextWindowTokens: 700,
          reserveTokens: 0,
          keepRecentTokens: 1,
          toolOutputMaxChars: 128,
        },
      }),
    );

    // Then
    expect(mainRequests).toBe(1);
    expect(summaryRequests).toBe(0);
    expect(acceptedMessages[0]).toEqual({
      role: "user",
      content: "Read the large log and continue.",
      contextCompaction: { evidence },
    });
    const acceptedToolOutput = capturedToolOutput(
      acceptedMessages,
      "read_large_log",
    );
    expect(acceptedToolOutput).toContain("PREFLIGHT_LOG_START");
    expect(acceptedToolOutput).toContain(PREFLIGHT_CURRENT_TOOL_OUTPUT_MARKER);
    expect(acceptedToolOutput).not.toContain("PREFLIGHT_LOG_END");
    const toolCallIndex = acceptedMessages.findIndex(
      (message) =>
        message.role === "assistant" &&
        message.toolCalls.some((toolCall) => toolCall.id === "read_large_log"),
    );
    const toolResultIndex = acceptedMessages.findIndex(
      (message) =>
        message.role === "tool" && message.toolCallId === "read_large_log",
    );
    expect(toolCallIndex).toBeGreaterThan(-1);
    expect(toolResultIndex).toBe(toolCallIndex + 1);
    expect(onlyContextCompactedEvent(events)).toMatchObject({
      reason: "preflight",
      toolOutputsCompacted: 1,
      toolOutputCharsBefore: currentToolOutput.length,
      toolOutputCharsAfter: acceptedToolOutput.length,
      toolOutputEstimatedTokensBefore: estimatedTextTokens(currentToolOutput),
      toolOutputEstimatedTokensAfter: estimatedTextTokens(acceptedToolOutput),
    });
    expect(events).toContainEqual({
      type: "text",
      text: "Continued after preflight compaction.",
    });
  });

  test(`Given several medium current tool outputs are individually under the inline cap but collectively over budget,
    When the aggregate current round would predictably overflow,
    Then preflight compaction shrinks the aggregate before one provider call`, async () => {
    // Given
    const firstOutput = [
      "FIRST_MEDIUM_OUTPUT_START",
      "first medium output row ".repeat(35),
      "FIRST_MEDIUM_OUTPUT_END",
    ].join("\n");
    const secondOutput = [
      "SECOND_MEDIUM_OUTPUT_START",
      "second medium output row ".repeat(35),
      "SECOND_MEDIUM_OUTPUT_END",
    ].join("\n");
    expect(firstOutput.length).toBeLessThan(1_000);
    expect(secondOutput.length).toBeLessThan(1_000);
    const messages: Message[] = [
      { role: "user", content: "Read both reports and continue." },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "read_first_report",
            tool: "read",
            path: "first.log",
          },
          {
            id: "read_second_report",
            tool: "read",
            path: "second.log",
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "read_first_report",
        content: firstOutput,
      },
      {
        role: "tool",
        toolCallId: "read_second_report",
        content: secondOutput,
      },
    ];
    let mainRequests = 0;
    let acceptedMessages: readonly Message[] = [];
    const provider: LLMProvider = {
      id: "aggregate-current-output-provider",
      async *stream(options) {
        if (options.toolChoice === "none") {
          throw new Error("Aggregate current preflight should not summarize");
        }

        mainRequests++;
        acceptedMessages = [...options.messages];
        if (
          capturedToolOutput(options.messages, "read_first_report") ===
            firstOutput ||
          capturedToolOutput(options.messages, "read_second_report") ===
            secondOutput
        ) {
          throw new KeelError(
            "provider_context_overflow",
            "Provider should not see the aggregate current outputs intact",
          );
        }

        yield { type: "text", text: "Continued after aggregate preflight." };
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
          contextWindowTokens: 300,
          reserveTokens: 0,
          keepRecentTokens: 1,
          toolOutputMaxChars: 1_000,
        },
      }),
    );

    // Then
    expect(mainRequests).toBe(1);
    expect(
      acceptedMessages.flatMap((message) =>
        message.role === "assistant"
          ? message.toolCalls.map((toolCall) => toolCall.id)
          : [],
      ),
    ).toEqual(["read_first_report", "read_second_report"]);
    expect(
      acceptedMessages.flatMap((message) =>
        message.role === "tool" ? [message.toolCallId] : [],
      ),
    ).toEqual(["read_first_report", "read_second_report"]);
    const firstCompactedOutput = capturedToolOutput(
      acceptedMessages,
      "read_first_report",
    );
    const secondCompactedOutput = capturedToolOutput(
      acceptedMessages,
      "read_second_report",
    );
    expect(firstCompactedOutput).toContain(
      PREFLIGHT_CURRENT_TOOL_OUTPUT_MARKER,
    );
    expect(secondCompactedOutput).toContain(
      PREFLIGHT_CURRENT_TOOL_OUTPUT_MARKER,
    );
    expect(firstCompactedOutput).not.toContain("FIRST_MEDIUM_OUTPUT_END");
    expect(secondCompactedOutput).not.toContain("SECOND_MEDIUM_OUTPUT_END");
    expect(onlyContextCompactedEvent(events)).toMatchObject({
      reason: "preflight",
      toolOutputsCompacted: 2,
      toolOutputCharsBefore: firstOutput.length + secondOutput.length,
      toolOutputCharsAfter:
        firstCompactedOutput.length + secondCompactedOutput.length,
    });
  });

  test(`Given a current tool output is larger than the inline cap but the request is under budget,
    When the next provider request starts,
    Then the agent does not compact the current output unconditionally`, async () => {
    // Given
    const currentToolOutput = [
      "UNDER_BUDGET_START",
      "under budget current output ".repeat(80),
      "UNDER_BUDGET_END",
    ].join("\n");
    const messages: Message[] = [
      { role: "user", content: "Read the note and continue." },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "read_note",
            tool: "read",
            path: "note.txt",
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "read_note",
        content: currentToolOutput,
      },
    ];
    let mainRequests = 0;
    let acceptedMessages: readonly Message[] = [];
    const provider: LLMProvider = {
      id: "under-budget-current-output-provider",
      async *stream(options) {
        mainRequests++;
        acceptedMessages = [...options.messages];
        yield { type: "text", text: "Continued without preflight." };
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
          contextWindowTokens: 4_000,
          reserveTokens: 0,
          keepRecentTokens: 1,
          toolOutputMaxChars: 128,
        },
      }),
    );

    // Then
    expect(mainRequests).toBe(1);
    expect(capturedToolOutput(acceptedMessages, "read_note")).toBe(
      currentToolOutput,
    );
    expect(contextCompactedEvents(events)).toEqual([]);
  });

  test(`Given normal historical compaction can bring the request under budget,
    When current tool output is oversized but retained,
    Then preflight current-output compaction is not run after the historical summary`, async () => {
    // Given
    const currentToolOutput = [
      "CURRENT_REPORT_START",
      "current report row ".repeat(120),
      "CURRENT_REPORT_END",
    ].join("\n");
    const messages: Message[] = [
      {
        role: "user",
        content: `Background context ${"older background detail ".repeat(700)}`,
      },
      {
        role: "assistant",
        content: "I have the background.",
        toolCalls: [],
      },
      { role: "user", content: "Read the current report and continue." },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "read_current_report",
            tool: "read",
            path: "current-report.txt",
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "read_current_report",
        content: currentToolOutput,
      },
    ];
    let summaryRequests = 0;
    let mainRequests = 0;
    let acceptedMessages: readonly Message[] = [];
    const provider: LLMProvider = {
      id: "historical-compaction-sufficient-provider",
      async *stream(options) {
        if (options.toolChoice === "none") {
          summaryRequests++;
          yield { type: "text", text: "Earlier background summary." };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }

        mainRequests++;
        acceptedMessages = [...options.messages];
        if (
          capturedToolOutput(options.messages, "read_current_report") !==
          currentToolOutput
        ) {
          throw new KeelError(
            "provider_context_overflow",
            "Current output should remain intact when history compaction fits",
          );
        }

        yield { type: "text", text: "Continued after historical compaction." };
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
          contextWindowTokens: 2_500,
          reserveTokens: 0,
          keepRecentTokens: 800,
          toolOutputMaxChars: 128,
        },
      }),
    );

    // Then
    expect(summaryRequests).toBe(1);
    expect(mainRequests).toBe(1);
    expect(capturedToolOutput(acceptedMessages, "read_current_report")).toBe(
      currentToolOutput,
    );
    expect(onlyContextCompactedEvent(events)).toMatchObject({
      reason: "proactive",
      toolOutputsCompacted: 0,
    });
  });

  test(`Given preflight compaction stores a source-truncated current tool output artifact,
    When the provider receives the compacted request,
    Then the output marker and event carry the artifact ref and lossy source status`, async () => {
    // Given
    const currentToolOutput = [
      "TRUNCATED_PREFLIGHT_START",
      "truncated preflight row ".repeat(500),
      "TRUNCATED_PREFLIGHT_END",
    ].join("\n");
    const messages: Message[] = [
      { role: "user", content: "Run the noisy command and continue." },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "run_noisy_command",
            tool: "bash",
            command: "node noisy.js",
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "run_noisy_command",
        content: currentToolOutput,
        sourceTruncated: true,
      },
    ];
    const saved: SavedToolOutputArtifact[] = [];
    let mainRequests = 0;
    let acceptedMessages: readonly Message[] = [];
    const provider: LLMProvider = {
      id: "preflight-current-output-artifact-provider",
      async *stream(options) {
        mainRequests++;
        acceptedMessages = [...options.messages];
        if (
          capturedToolOutput(options.messages, "run_noisy_command") ===
          currentToolOutput
        ) {
          throw new KeelError(
            "provider_context_overflow",
            "Provider should receive the artifact-backed preflight output",
          );
        }

        yield { type: "text", text: "Continued after artifact preflight." };
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
          contextWindowTokens: 700,
          reserveTokens: 0,
          keepRecentTokens: 1,
          toolOutputMaxChars: 128,
        },
        toolOutputArtifacts: {
          store: storingArtifactStore(saved),
        },
      }),
    );

    // Then
    expect(mainRequests).toBe(1);
    expect(saved).toHaveLength(1);
    expect(saved[0]?.input).toMatchObject({
      toolCallId: "run_noisy_command",
      toolName: "bash",
      purpose: "current-preflight-compaction",
      sourceStatus: "source-truncated",
      content: currentToolOutput,
    });
    const acceptedToolOutput = capturedToolOutput(
      acceptedMessages,
      "run_noisy_command",
    );
    expect(acceptedToolOutput).toContain(PREFLIGHT_CURRENT_TOOL_OUTPUT_MARKER);
    expect(acceptedToolOutput).toContain(
      "full output artifact: tool-output:test/1",
    );
    expect(acceptedToolOutput).toContain(
      "source status: source-truncated/lossy before artifact capture",
    );
    expect(events).toContainEqual({
      type: "tool_output_artifact",
      status: "stored",
      ref: "tool-output:test/1",
      toolCallId: "run_noisy_command",
      toolName: "bash",
      sourceStatus: "source-truncated",
      omittedChars: expect.any(Number),
    });
    expect(onlyContextCompactedEvent(events)).toMatchObject({
      reason: "preflight",
      toolOutputsCompacted: 1,
    });
  });

  test(`Given CLI output reports a preflight current-output compaction event,
    When the agent stream is printed,
    Then stderr distinguishes it from overflow recovery and labels current tool outputs`, async () => {
    // Given
    const currentToolOutput = [
      "CLI_PREFLIGHT_START",
      "cli preflight output row ".repeat(500),
      "CLI_PREFLIGHT_END",
    ].join("\n");
    const messages: Message[] = [
      { role: "user", content: "Read the CLI log and continue." },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "read_cli_log",
            tool: "read",
            path: "cli.log",
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "read_cli_log",
        content: currentToolOutput,
      },
    ];
    let mainRequests = 0;
    const provider: LLMProvider = {
      id: "preflight-current-output-cli-provider",
      async *stream(options) {
        mainRequests++;
        if (
          capturedToolOutput(options.messages, "read_cli_log") ===
          currentToolOutput
        ) {
          throw new KeelError(
            "provider_context_overflow",
            "CLI test should compact before provider accepts the request",
          );
        }
        yield { type: "text", text: "CLI preflight done." };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    let stdout = "";
    let stderr = "";

    // When
    await printAgentEvents(
      runAgentTurn({
        workspace: workspace(),
        provider,
        messages,
        systemPrompt: "You are helpful.",
        signal: freshSignal(),
        allowBash: false,
        stopPolicy: defaultStopPolicy(),
        contextCompaction: {
          contextWindowTokens: 700,
          reserveTokens: 0,
          keepRecentTokens: 1,
          toolOutputMaxChars: 128,
        },
      }),
      {
        writeStdout(text) {
          stdout += text;
        },
        writeStderr(text) {
          stderr += text;
        },
      },
    );

    // Then
    expect(mainRequests).toBe(1);
    expect(stdout).toBe("CLI preflight done.");
    expect(stderr).toContain("Context compacted: preflight");
    expect(stderr).toContain("current tool output 1");
    expect(stderr).not.toContain("overflow recovery");
    expect(stderr).not.toContain("stale tool output 1");
  });

  test(`Given lower-level current-output compaction is called without a preflight reason,
    When current tool output is compacted,
    Then it keeps the overflow-recovery marker and recognizes both current-output markers`, () => {
    // Given
    const currentToolOutput = [
      "DEFAULT_REASON_START",
      "default reason output row ".repeat(200),
      "DEFAULT_REASON_END",
    ].join("\n");
    const messages: Message[] = [
      { role: "user", content: "Read the log." },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "read_default_reason",
            tool: "read",
            path: "default.log",
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "read_default_reason",
        content: currentToolOutput,
      },
    ];

    // When
    const result = compactCurrentToolOutputs(messages, 128);

    // Then
    const compactedOutput = capturedToolOutput(
      result.messages,
      "read_default_reason",
    );
    expect(compactedOutput).toContain(
      "[current tool output compacted after context overflow:",
    );
    expect(compactedOutput).not.toContain(PREFLIGHT_CURRENT_TOOL_OUTPUT_MARKER);
    expect(isCompactedCurrentToolOutput(compactedOutput)).toBe(true);
    expect(
      isCompactedCurrentToolOutput(
        "preview\n[current tool output compacted before provider request: approximately omitted 12 chars; rerun the tool with narrower parameters if needed]",
      ),
    ).toBe(true);
    expect(isCompactedCurrentToolOutput("ordinary output")).toBe(false);
  });

  test(`Given artifact-backed current-output compaction is called without explicit options,
    When an artifact is stored,
    Then the default purpose remains overflow recovery`, async () => {
    // Given
    const currentToolOutput = [
      "DEFAULT_ARTIFACT_START",
      "default artifact output row ".repeat(200),
      "DEFAULT_ARTIFACT_END",
    ].join("\n");
    const messages: Message[] = [
      { role: "user", content: "Run the command." },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "run_default_artifact",
            tool: "bash",
            command: "node default.js",
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "run_default_artifact",
        content: currentToolOutput,
      },
    ];
    const saved: SavedToolOutputArtifact[] = [];

    // When
    const result = await compactCurrentToolOutputsWithArtifacts(
      messages,
      128,
      storingArtifactStore(saved),
    );

    // Then
    expect(saved).toHaveLength(1);
    expect(saved[0]?.input).toMatchObject({
      toolCallId: "run_default_artifact",
      toolName: "bash",
      purpose: "current-overflow-compaction",
      content: currentToolOutput,
    });
    expect(
      capturedToolOutput(result.messages, "run_default_artifact"),
    ).toContain("[current tool output compacted after context overflow:");
  });

  test(`Given compactMessages is asked to use the preflight marker without an over-budget estimate,
    When current output still exceeds the configured inline cap,
    Then the lower-level compactor keeps the configured cap and preflight marker`, async () => {
    // Given
    const currentToolOutput = [
      "DIRECT_UNDER_BUDGET_START",
      "direct under-budget output row ".repeat(200),
      "DIRECT_UNDER_BUDGET_END",
    ].join("\n");
    const messages: Message[] = [
      { role: "user", content: "Read direct output." },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "read_direct_under_budget",
            tool: "read",
            path: "direct.log",
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "read_direct_under_budget",
        content: currentToolOutput,
      },
    ];
    const provider: LLMProvider = {
      id: "direct-under-budget-provider",
      stream() {
        return failingStream(new Error("No summary request should be needed"));
      },
    };

    // When
    const result = await compactMessages({
      provider,
      systemPrompt: "You are helpful.",
      messages,
      signal: freshSignal(),
      contextCompaction: {
        contextWindowTokens: 10_000,
        reserveTokens: 0,
        keepRecentTokens: 1,
        toolOutputMaxChars: 128,
      },
      allowCurrentToolOutputCompaction: true,
      currentToolOutputCompactionReason: "preflight",
    });

    // Then
    expect(result.compacted).toBe(true);
    const compactedOutput = capturedToolOutput(
      messages,
      "read_direct_under_budget",
    );
    expect(compactedOutput).toContain(PREFLIGHT_CURRENT_TOOL_OUTPUT_MARKER);
    expect(compactedOutput).not.toContain("DIRECT_UNDER_BUDGET_END");
  });

  test(`Given preflight current-output compaction is allowed after historical summary but no current round remains,
    When compactMessages summarizes the older history,
    Then the current-output pass is a no-op after the summary`, async () => {
    // Given
    const messages: Message[] = [
      {
        role: "user",
        content: `Older history ${"detail ".repeat(500)}`,
      },
      {
        role: "assistant",
        content: "Older history acknowledged.",
        toolCalls: [],
      },
      { role: "user", content: "Continue from the latest instruction." },
    ];
    let summaryRequests = 0;
    const provider: LLMProvider = {
      id: "no-current-round-after-summary-provider",
      async *stream(options) {
        if (options.toolChoice !== "none") {
          throw new Error("Only a summary request is expected");
        }
        summaryRequests++;
        yield { type: "text", text: "Earlier history summary." };
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
        contextWindowTokens: 1,
        reserveTokens: 0,
        keepRecentTokens: 1,
      },
      allowCurrentToolOutputCompaction: true,
      currentToolOutputCompactionReason: "preflight",
    });

    // Then
    expect(summaryRequests).toBe(1);
    expect(result.compacted).toBe(true);
    if (!result.compacted) {
      throw new Error("Expected historical compaction to run");
    }
    expect(result.stats.toolOutputsCompacted).toBe(0);
    expect(messages.some((message) => message.role === "tool")).toBe(false);
  });

  test(`Given a compaction report omits the optional tool-output scope,
    When the report includes compacted tool outputs,
    Then CLI formatting defaults that detail to stale output reporting`, () => {
    // When
    const report = formatContextCompactionReport({
      reasonLabel: "overflow recovery",
      beforeMessageCount: 4,
      afterMessageCount: 4,
      beforeEstimatedTokens: 1200,
      afterEstimatedTokens: 300,
      toolOutputsCompacted: 2,
      toolOutputCharsBefore: 4000,
      toolOutputCharsAfter: 600,
      toolOutputEstimatedTokensBefore: 1000,
      toolOutputEstimatedTokensAfter: 150,
    });

    // Then
    expect(report).toContain("Context compacted: overflow recovery");
    expect(report).toContain("stale tool outputs 2");
    expect(report).not.toContain("current tool outputs 2");
  });

  test(`Given printed agent events report overflow-recovery compaction,
    When the event contains compacted tool-output stats,
    Then CLI output labels those details as stale rather than current`, async () => {
    // Given
    let stderr = "";
    const event: AgentEvent = {
      type: "context_compacted",
      reason: "overflow_recovery",
      beforeMessageCount: 4,
      afterMessageCount: 4,
      beforeEstimatedTokens: 1200,
      afterEstimatedTokens: 300,
      toolOutputsCompacted: 1,
      toolOutputCharsBefore: 4000,
      toolOutputCharsAfter: 600,
      toolOutputEstimatedTokensBefore: 1000,
      toolOutputEstimatedTokensAfter: 150,
    };
    async function* eventStream(): AsyncIterable<AgentEvent> {
      yield event;
    }

    // When
    await printAgentEvents(eventStream(), {
      writeStdout() {},
      writeStderr(text) {
        stderr += text;
      },
    });

    // Then
    expect(stderr).toContain("Context compacted: overflow recovery");
    expect(stderr).toContain("stale tool output 1");
    expect(stderr).not.toContain("current tool output 1");
  });
});
