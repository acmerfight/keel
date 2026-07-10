import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  compactCurrentToolOutputs,
  compactCurrentToolOutputsWithArtifacts,
  compactMessages,
  isCompactedCurrentToolOutput,
} from "../../../src/agent/context-compaction.ts";
import type { AgentEvent } from "../../../src/agent/events.ts";
import { runAgentTurn } from "../../../src/agent/loop.ts";
import { postCompactionReadToolCallId } from "../../../src/agent/post-compaction-read-id.ts";
import { createReadVisibilityState } from "../../../src/agent/read-visibility.ts";
import { defaultStopPolicy } from "../../../src/agent/stop-policy.ts";
import type {
  ToolOutputArtifactSaveInput,
  ToolOutputArtifactStore,
} from "../../../src/agent/tool-output-artifacts.ts";
import { printAgentEvents } from "../../../src/cli/output.ts";
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
  readonly ref: string;
  readonly input: ToolOutputArtifactSaveInput;
  readonly contentSha256: string;
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function storingArtifactStore(
  saved: SavedToolOutputArtifact[],
  options?: {
    readonly refForIndex?: (index: number) => string;
  },
): ToolOutputArtifactStore {
  const artifacts = new Map<
    string,
    {
      readonly content: string;
      readonly input: ToolOutputArtifactSaveInput;
      readonly contentSha256: string;
    }
  >();
  return {
    verifyReusable: async (input) => {
      const artifact = artifacts.get(input.ref);
      if (artifact === undefined) {
        return { status: "not_reusable" };
      }
      const previewMatches =
        input.previewKind === "prefix"
          ? artifact.content.startsWith(input.previewContent)
          : input.contentSha256 === artifact.contentSha256;
      if (
        artifact.input.toolCallId !== input.toolCallId ||
        artifact.input.sourceStatus !== input.sourceStatus ||
        artifact.content.length !==
          input.previewContent.length + input.omittedChars ||
        (input.contentSha256 !== undefined &&
          input.contentSha256 !== artifact.contentSha256) ||
        !previewMatches
      ) {
        return { status: "not_reusable" };
      }
      return { status: "reusable", contentSha256: artifact.contentSha256 };
    },
    save: async (input) => {
      const index = saved.length + 1;
      const ref = options?.refForIndex?.(index) ?? `tool-output:test/${index}`;
      const contentSha256 = sha256(input.content);
      saved.push({ ref, input, contentSha256 });
      artifacts.set(ref, {
        content: input.content,
        input,
        contentSha256,
      });
      return {
        status: "stored",
        ref,
        contentSha256,
      };
    },
    discard: async (ref) => {
      const index = saved.findIndex((artifact) => artifact.ref === ref);
      if (index !== -1) {
        saved.splice(index, 1);
      }
      artifacts.delete(ref);
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

  test(`Given an oversized current tool output remains over the local request budget after shrinking,
    When the next provider request starts,
    Then the agent still sends the compacted current output`, async () => {
    // Given
    const currentToolOutput = [
      "LOW_WINDOW_OUTPUT_START",
      "low window output row ".repeat(600),
      "LOW_WINDOW_OUTPUT_END",
    ].join("\n");
    const messages: Message[] = [
      { role: "user", content: "Read the low-window output and continue." },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "read_low_window_output",
            tool: "read",
            path: "low-window.log",
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "read_low_window_output",
        content: currentToolOutput,
      },
    ];
    let mainRequests = 0;
    let summaryRequests = 0;
    let acceptedMessages: readonly Message[] = [];
    const provider: LLMProvider = {
      id: "preflight-current-output-over-local-budget-provider",
      async *stream(options) {
        if (options.toolChoice === "none") {
          summaryRequests++;
          throw new Error("Current-output preflight should not summarize");
        }

        mainRequests++;
        acceptedMessages = [...options.messages];
        yield {
          type: "text",
          text: "Continued with compacted current output.",
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
          contextWindowTokens: 1,
          reserveTokens: 0,
          keepRecentTokens: 1,
          toolOutputMaxChars: 128,
        },
      }),
    );

    // Then
    expect(mainRequests).toBe(1);
    expect(summaryRequests).toBe(0);
    const acceptedToolOutput = capturedToolOutput(
      acceptedMessages,
      "read_low_window_output",
    );
    expect(acceptedToolOutput).not.toBe(currentToolOutput);
    expect(acceptedToolOutput).toContain(PREFLIGHT_CURRENT_TOOL_OUTPUT_MARKER);
    expect(acceptedToolOutput).not.toContain("LOW_WINDOW_OUTPUT_END");
    expect(onlyContextCompactedEvent(events)).toMatchObject({
      reason: "preflight",
      toolOutputsCompacted: 1,
      currentToolOutputsCompacted: 1,
    });
    expect(events).toContainEqual({
      type: "text",
      text: "Continued with compacted current output.",
    });
  });

  test(`Given provider accounting covers the unchanged prompt before a tool result,
    When preflight compacts the current tool output mid-turn,
    Then the compacted request uses that accounting before deciding it fits`, async () => {
    // Given
    const workspaceDir = await mkdtemp(join(tmpdir(), "keel-preflight-"));
    const currentToolOutput = [
      "ACCOUNTED_LOG_START",
      "accounted log row ".repeat(500),
      "ACCOUNTED_LOG_END",
    ].join("\n");
    await writeFile(join(workspaceDir, "accounted.log"), currentToolOutput);
    const messages: Message[] = [
      {
        role: "user",
        content: `Read accounted.log and continue. ${"background ".repeat(
          2_500,
        )}`,
      },
    ];
    let providerRequests = 0;
    let acceptedMessages: readonly Message[] = [];
    const provider: LLMProvider = {
      id: "preflight-accounting-provider",
      async *stream(options) {
        if (options.toolChoice === "none") {
          throw new Error("Current-output preflight must not summarize");
        }

        providerRequests++;
        if (providerRequests === 1) {
          yield {
            type: "tool_call",
            id: "read_accounted_log",
            tool: "read",
            path: "accounted.log",
          };
          yield {
            type: "stop",
            reason: "stop",
            usage: {
              inputTokens: 10,
              cachedInputTokens: 0,
              uncachedInputTokens: 10,
              outputTokens: 0,
            },
          };
          return;
        }

        acceptedMessages = [...options.messages];
        if (
          capturedToolOutput(options.messages, "read_accounted_log") ===
          currentToolOutput
        ) {
          throw new KeelError(
            "provider_context_overflow",
            "Preflight should use provider accounting for the unchanged prefix",
          );
        }
        yield { type: "text", text: "Continued with accounted preflight." };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };

    try {
      // When
      const events = await collect(
        runAgentTurn({
          workspace: workspaceDir,
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
            toolOutputMaxChars: 128,
          },
        }),
      );

      // Then
      expect(providerRequests).toBe(2);
      const acceptedToolOutput = capturedToolOutput(
        acceptedMessages,
        "read_accounted_log",
      );
      expect(acceptedToolOutput).toContain(
        PREFLIGHT_CURRENT_TOOL_OUTPUT_MARKER,
      );
      expect(acceptedToolOutput).not.toContain("ACCOUNTED_LOG_END");
      expect(onlyContextCompactedEvent(events)).toMatchObject({
        reason: "preflight",
        toolOutputsCompacted: 1,
      });
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
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

  test(`Given historical compaction would restore visible reads before preflight,
    When a fresh oversized current read dominates the next request,
    Then the agent compacts that current read before historical restoration can duplicate it`, async () => {
    // Given
    const workspaceDir = await mkdtemp(join(tmpdir(), "keel-preflight-"));
    const oldOutput = [
      "OLD_RESTORED_START",
      "old restored row ".repeat(650),
      "OLD_RESTORED_END",
    ].join("\n");
    const newOutput = [
      "NEW_DOMINANT_START",
      "new dominant row ".repeat(650),
      "NEW_DOMINANT_END",
    ].join("\n");
    await writeFile(join(workspaceDir, "old.txt"), oldOutput, "utf8");
    await writeFile(join(workspaceDir, "new.txt"), newOutput, "utf8");
    const readVisibility = createReadVisibilityState();
    const messages: Message[] = [
      { role: "user", content: "Read old.txt and continue." },
    ];
    let mainRequests = 0;
    let summaryRequests = 0;
    let acceptedNewReadMessages: readonly Message[] = [];
    const provider: LLMProvider = {
      id: "preflight-before-restore-provider",
      async *stream(options) {
        if (options.toolChoice === "none") {
          summaryRequests++;
          yield { type: "text", text: "Earlier read summary." };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }

        mainRequests++;
        const newReadOutput = capturedToolOutput(options.messages, "read_new");
        if (newReadOutput !== "") {
          acceptedNewReadMessages = [...options.messages];
          if (newReadOutput === newOutput) {
            throw new KeelError(
              "provider_context_overflow",
              "Provider should not see the uncompacted fresh current read",
            );
          }
          yield { type: "text", text: "SECOND_DONE" };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }

        if (mainRequests === 1) {
          yield {
            type: "tool_call",
            id: "read_old",
            tool: "read",
            path: "old.txt",
          };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }

        if (mainRequests === 2) {
          yield { type: "text", text: "FIRST_DONE" };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }

        yield {
          type: "tool_call",
          id: "read_new",
          tool: "read",
          path: "new.txt",
        };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };

    try {
      await collect(
        runAgentTurn({
          workspace: workspaceDir,
          provider,
          messages,
          systemPrompt: "You are helpful.",
          signal: freshSignal(),
          allowBash: false,
          stopPolicy: defaultStopPolicy(),
          readVisibility,
          contextCompaction: {
            contextWindowTokens: 20_000,
          },
        }),
      );
      messages.push({ role: "user", content: "Read new.txt and continue." });

      // When
      const events = await collect(
        runAgentTurn({
          workspace: workspaceDir,
          provider,
          messages,
          systemPrompt: "You are helpful.",
          signal: freshSignal(),
          allowBash: false,
          stopPolicy: defaultStopPolicy(),
          readVisibility,
          contextCompaction: {
            contextWindowTokens: 20_000,
          },
        }),
      );

      // Then
      const acceptedNewReadOutput = capturedToolOutput(
        acceptedNewReadMessages,
        "read_new",
      );
      const acceptedToolOutputText = acceptedNewReadMessages
        .filter((message) => message.role === "tool")
        .map((message) => message.content)
        .join("\n");
      expect(acceptedNewReadOutput).toContain(
        PREFLIGHT_CURRENT_TOOL_OUTPUT_MARKER,
      );
      expect(acceptedToolOutputText).not.toContain("NEW_DOMINANT_END");
      expect(summaryRequests).toBe(0);
      expect(
        contextCompactedEvents(events).map((event) => event.reason),
      ).toEqual(["preflight"]);
      const durableRead = messages.find(
        (message) =>
          message.role === "tool" && message.toolCallId === "read_new",
      );
      expect(durableRead).toMatchObject({
        resourceObservation: {
          kind: "read_projection",
          targetPathSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
          contentSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        },
      });
      const providerRead = acceptedNewReadMessages.find(
        (message) =>
          message.role === "tool" && message.toolCallId === "read_new",
      );
      expect(providerRead).not.toHaveProperty("resourceObservation");
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });

  test(`Given historical compaction leaves the protected current round over budget,
    When preflight current-output compaction runs after that summary,
    Then it does not make a second summary provider request`, async () => {
    // Given
    const currentToolOutput = [
      "CURRENT_DOMINATES_START",
      "current dominates row ".repeat(1_200),
      "CURRENT_DOMINATES_END",
    ].join("\n");
    const messages: Message[] = [
      {
        role: "user",
        content: `Older history ${"older detail ".repeat(900)}`,
      },
      {
        role: "assistant",
        content: "Older history acknowledged.",
        toolCalls: [],
      },
      { role: "user", content: "Read the dominant current output." },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "read_dominant_current",
            tool: "read",
            path: "dominant.log",
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "read_dominant_current",
        content: currentToolOutput,
      },
    ];
    let summaryRequests = 0;
    let mainRequests = 0;
    let acceptedMessages: readonly Message[] = [];
    const provider: LLMProvider = {
      id: "preflight-current-output-no-second-summary-provider",
      async *stream(options) {
        if (options.toolChoice === "none") {
          summaryRequests++;
          if (summaryRequests > 1) {
            throw new Error(
              "Preflight current-output compaction must not summarize",
            );
          }
          yield { type: "text", text: "Earlier history summary." };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }

        mainRequests++;
        acceptedMessages = [...options.messages];
        yield { type: "text", text: "Continued after one summary." };
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
          contextWindowTokens: 900,
          reserveTokens: 0,
          keepRecentTokens: 1,
          toolOutputMaxChars: 128,
        },
      }),
    );

    // Then
    expect(summaryRequests).toBe(1);
    expect(mainRequests).toBe(1);
    expect(
      capturedToolOutput(acceptedMessages, "read_dominant_current"),
    ).toContain(PREFLIGHT_CURRENT_TOOL_OUTPUT_MARKER);
    expect(contextCompactedEvents(events).map((event) => event.reason)).toEqual(
      ["proactive", "preflight"],
    );
  });

  test(`Given the current tool output is already preflight-compacted,
    When the next request is still locally over budget,
    Then preflight does not compact the current output again`, async () => {
    // Given
    const alreadyCompactedOutput =
      "preview\n[current tool output compacted before provider request: approximately omitted 6000 chars; rerun the tool with narrower parameters if needed]";
    const messages: Message[] = [
      { role: "user", content: "Continue from the compacted output." },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "read_already_compacted",
            tool: "read",
            path: "already.log",
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "read_already_compacted",
        content: alreadyCompactedOutput,
      },
    ];
    let mainRequests = 0;
    let acceptedMessages: readonly Message[] = [];
    const provider: LLMProvider = {
      id: "already-preflight-compacted-provider",
      async *stream(options) {
        mainRequests++;
        acceptedMessages = [...options.messages];
        yield { type: "text", text: "Continued with existing compaction." };
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
          contextWindowTokens: 1,
          reserveTokens: 0,
          keepRecentTokens: 1,
          toolOutputMaxChars: 32,
        },
      }),
    );

    // Then
    expect(mainRequests).toBe(1);
    expect(capturedToolOutput(acceptedMessages, "read_already_compacted")).toBe(
      alreadyCompactedOutput,
    );
    expect(contextCompactedEvents(events)).toEqual([]);
  });

  test(`Given an over-budget conversation has no current tool output,
    When the agent continues the turn,
    Then it sends the original conversation without a compaction event`, async () => {
    // Given
    const oversizedInstruction = `Continue from this large instruction. ${"detail ".repeat(
      600,
    )}`;
    const messages: Message[] = [
      {
        role: "user",
        content: oversizedInstruction,
      },
    ];
    let mainRequests = 0;
    let acceptedMessages: readonly Message[] = [];
    const provider: LLMProvider = {
      id: "no-current-output-preflight-provider",
      async *stream(options) {
        if (options.toolChoice === "none") {
          throw new Error("Current-output preflight must not summarize");
        }

        mainRequests++;
        acceptedMessages = [...options.messages];
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
        allowBash: false,
        stopPolicy: defaultStopPolicy(),
        contextCompaction: {
          contextWindowTokens: 1,
          reserveTokens: 0,
          keepRecentTokens: 1,
          toolOutputMaxChars: 32,
        },
      }),
    );

    // Then
    expect(mainRequests).toBe(1);
    expect(acceptedMessages).toEqual([
      {
        role: "user",
        content: oversizedInstruction,
      },
    ]);
    expect(contextCompactedEvents(events)).toEqual([]);
  });

  test(`Given a restored post-compaction read remains in the current round,
    When preflight current-output compaction runs,
    Then the agent preserves the restored read output`, async () => {
    // Given
    const restoredToolCallId = postCompactionReadToolCallId(0);
    const restoredOutput = [
      "RESTORED_READ_START",
      "restored read row ".repeat(600),
      "RESTORED_READ_END",
    ].join("\n");
    const messages: Message[] = [
      { role: "user", content: "Continue from the restored read." },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: restoredToolCallId,
            tool: "read",
            path: "restored.log",
          },
        ],
      },
      {
        role: "tool",
        toolCallId: restoredToolCallId,
        content: restoredOutput,
      },
    ];
    let mainRequests = 0;
    let acceptedMessages: readonly Message[] = [];
    const provider: LLMProvider = {
      id: "preflight-restored-read-provider",
      async *stream(options) {
        if (options.toolChoice === "none") {
          throw new Error("Preflight must not summarize restored reads");
        }

        mainRequests++;
        acceptedMessages = [...options.messages];
        yield { type: "text", text: "Continued with restored read." };
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
          contextWindowTokens: 1,
          reserveTokens: 0,
          keepRecentTokens: 1,
          toolOutputMaxChars: 32,
        },
      }),
    );

    // Then
    expect(mainRequests).toBe(1);
    expect(capturedToolOutput(acceptedMessages, restoredToolCallId)).toBe(
      restoredOutput,
    );
    expect(contextCompactedEvents(events)).toEqual([]);
  });

  test(`Given the provider still rejects after preflight current-output compaction,
    When overflow recovery runs,
    Then it can shrink the preflight marker and retry the provider`, async () => {
    // Given
    const currentToolOutput = [
      "PREFLIGHT_FALLBACK_START",
      "fallback row ".repeat(220),
      "PREFLIGHT_FALLBACK_END",
    ].join("\n");
    const messages: Message[] = [
      { role: "user", content: "Read the fallback log and continue." },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "read_fallback_log",
            tool: "read",
            path: "fallback.log",
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "read_fallback_log",
        content: currentToolOutput,
      },
    ];
    let mainRequests = 0;
    let retriedMessages: readonly Message[] = [];
    const provider: LLMProvider = {
      id: "preflight-overflow-fallback-provider",
      async *stream(options) {
        if (options.toolChoice === "none") {
          throw new Error("Current-output fallback should not summarize");
        }

        mainRequests++;
        const currentOutput = capturedToolOutput(
          options.messages,
          "read_fallback_log",
        );
        if (mainRequests === 1) {
          expect(currentOutput).toContain(PREFLIGHT_CURRENT_TOOL_OUTPUT_MARKER);
          throw new KeelError(
            "provider_context_overflow",
            "Provider tokenization still rejected the preflight request",
          );
        }

        retriedMessages = [...options.messages];
        expect(currentOutput).toContain(
          "[current tool output compacted after context overflow:",
        );
        expect(currentOutput).toContain(
          `approximately omitted ${currentToolOutput.length} chars`,
        );
        expect(currentOutput).not.toContain(
          PREFLIGHT_CURRENT_TOOL_OUTPUT_MARKER,
        );
        yield { type: "text", text: "Continued after overflow fallback." };
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
          contextWindowTokens: 500,
          reserveTokens: 0,
          keepRecentTokens: 1,
          toolOutputMaxChars: 1_000,
        },
      }),
    );

    // Then
    expect(mainRequests).toBe(2);
    expect(capturedToolOutput(retriedMessages, "read_fallback_log")).toContain(
      "[current tool output compacted after context overflow:",
    );
    expect(contextCompactedEvents(events).map((event) => event.reason)).toEqual(
      ["preflight", "overflow_recovery"],
    );
  });

  test(`Given artifact-backed preflight current-output compaction is still rejected by the provider,
    When overflow recovery runs,
    Then it reuses the artifact marker and retries with the overflow-recovery marker`, async () => {
    // Given
    const currentToolOutput = [
      "ARTIFACT_PREFLIGHT_FALLBACK_START",
      "artifact fallback row ".repeat(900),
      "ARTIFACT_PREFLIGHT_FALLBACK_END",
    ].join("\n");
    const workspacePath = await mkdtemp(
      join(tmpdir(), "keel-preflight-artifact-fallback-"),
    );
    await writeFile(
      join(workspacePath, "artifact-fallback.log"),
      currentToolOutput,
      "utf8",
    );
    const messages: Message[] = [
      { role: "user", content: "Read artifact-fallback.log and continue." },
    ];
    const saved: SavedToolOutputArtifact[] = [];
    const artifactRef =
      "tool-output:run-00000000-0000-4000-8000-000000000000/00000000-0000-4000-8000-000000000001";
    let mainRequests = 0;
    let retriedMessages: readonly Message[] = [];
    const provider: LLMProvider = {
      id: "artifact-preflight-overflow-fallback-provider",
      async *stream(options) {
        if (options.toolChoice === "none") {
          throw new Error(
            "Artifact-backed current-output fallback should not summarize",
          );
        }

        mainRequests++;
        const currentOutput = capturedToolOutput(
          options.messages,
          "read_artifact_fallback_log",
        );
        if (currentOutput === "") {
          yield {
            type: "tool_call",
            id: "read_artifact_fallback_log",
            tool: "read",
            path: "artifact-fallback.log",
          };
          yield {
            type: "stop",
            reason: "stop",
            usage: {
              inputTokens: 900,
              cachedInputTokens: 0,
              uncachedInputTokens: 900,
              outputTokens: 1,
            },
          };
          return;
        }

        if (mainRequests === 2) {
          expect(currentOutput).toContain(PREFLIGHT_CURRENT_TOOL_OUTPUT_MARKER);
          expect(currentOutput).toContain(
            `full output artifact: ${artifactRef}`,
          );
          throw new KeelError(
            "provider_context_overflow",
            "Provider tokenization still rejected the artifact-backed preflight request",
          );
        }

        retriedMessages = [...options.messages];
        expect(currentOutput).toContain(
          "[current tool output compacted after context overflow:",
        );
        expect(currentOutput).toContain(
          `approximately omitted ${currentToolOutput.length} chars`,
        );
        expect(currentOutput).toContain(`full output artifact: ${artifactRef}`);
        expect(currentOutput).not.toContain(
          PREFLIGHT_CURRENT_TOOL_OUTPUT_MARKER,
        );
        expect(currentOutput).not.toContain("ARTIFACT_PREFLIGHT_FALLBACK_END");
        yield {
          type: "text",
          text: "Continued after artifact overflow fallback.",
        };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };

    // When
    let events: AgentEvent[] = [];
    try {
      events = await collect(
        runAgentTurn({
          workspace: workspacePath,
          provider,
          messages,
          systemPrompt: "You are helpful.",
          signal: freshSignal(),
          allowBash: false,
          stopPolicy: defaultStopPolicy(),
          contextCompaction: {
            contextWindowTokens: 1_000,
            reserveTokens: 0,
            keepRecentTokens: 1,
            toolOutputMaxChars: 1_000,
          },
          toolOutputArtifacts: {
            store: storingArtifactStore(saved, {
              refForIndex: () => artifactRef,
            }),
          },
        }),
      );
    } finally {
      await rm(workspacePath, { recursive: true, force: true });
    }

    // Then
    expect(mainRequests).toBe(3);
    expect(saved).toHaveLength(1);
    expect(saved[0]?.input).toMatchObject({
      toolCallId: "read_artifact_fallback_log",
      toolName: "read",
      purpose: "current-preflight-compaction",
      content: currentToolOutput,
    });
    expect(
      capturedToolOutput(retriedMessages, "read_artifact_fallback_log"),
    ).toContain("[current tool output compacted after context overflow:");
    expect(contextCompactedEvents(events).map((event) => event.reason)).toEqual(
      ["preflight", "overflow_recovery"],
    );
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

  test(`Given overflow recovery compacts retained stale and current tool outputs,
    When the agent stream is printed,
    Then stderr reports both tool-output scopes`, async () => {
    // Given
    const staleToolOutput = [
      "STALE_LOG_START",
      "stale log row ".repeat(500),
      "STALE_LOG_END",
    ].join("\n");
    const currentToolOutput = [
      "CURRENT_LOG_START",
      "current log row ".repeat(500),
      "CURRENT_LOG_END",
    ].join("\n");
    const messages: Message[] = [
      { role: "user", content: "Remember the setup." },
      { role: "assistant", content: "Setup remembered.", toolCalls: [] },
      { role: "user", content: "Read the stale log." },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "read_stale_log",
            tool: "read",
            path: "stale.log",
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "read_stale_log",
        content: staleToolOutput,
      },
      {
        role: "assistant",
        content: "The stale log was inspected.",
        toolCalls: [],
      },
      { role: "user", content: "Read the current log and continue." },
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
    ];
    let mainRequests = 0;
    let summaryRequests = 0;
    let retriedMessages: readonly Message[] = [];
    const provider: LLMProvider = {
      id: "mixed-tool-output-cli-provider",
      async *stream(options) {
        if (options.toolChoice === "none") {
          summaryRequests++;
          yield { type: "text", text: "Earlier setup summary." };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }

        mainRequests++;
        if (mainRequests === 1) {
          throw new KeelError(
            "provider_context_overflow",
            "Request exceeded context before mixed compaction",
          );
        }

        retriedMessages = [...options.messages];
        const retriedStaleOutput = capturedToolOutput(
          retriedMessages,
          "read_stale_log",
        );
        const retriedCurrentOutput = capturedToolOutput(
          retriedMessages,
          "read_current_log",
        );
        if (
          !retriedStaleOutput.includes("[stale tool output compacted:") ||
          retriedStaleOutput.includes("STALE_LOG_END") ||
          !retriedCurrentOutput.includes(
            "[current tool output compacted after context overflow:",
          ) ||
          retriedCurrentOutput.includes("CURRENT_LOG_END")
        ) {
          throw new KeelError(
            "provider_context_overflow",
            "Retry did not compact both tool-output scopes",
          );
        }

        yield {
          type: "text",
          text: "Continued after mixed tool-output compaction.",
        };
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
          keepRecentTokens: 20_000,
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
    expect(mainRequests).toBe(2);
    expect(summaryRequests).toBe(1);
    expect(stdout).toBe("Continued after mixed tool-output compaction.");
    expect(stderr).toContain("Context compacted: overflow recovery");
    expect(stderr).toContain("stale tool output 1");
    expect(stderr).toContain("current tool output 1");
    expect(stderr).not.toContain("current tool outputs 2");
    expect(stderr).not.toContain("stale tool outputs 2");
  });

  test(`Given the current-output compaction boundary receives no preflight reason,
    When current tool output is compacted,
    Then the boundary uses the overflow-recovery marker and recognizes both current-output markers`, () => {
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

  test(`Given the current-output compaction boundary receives an unsafe omitted count marker,
    When the output is recompacted,
    Then the boundary falls back to the projected omitted count`, () => {
    // Given
    const unsafeOmittedChars = "9".repeat(40);
    const currentToolOutput = `preview\n[current tool output compacted before provider request: approximately omitted ${unsafeOmittedChars} chars; rerun the tool with narrower parameters if needed]`;
    const messages: Message[] = [
      { role: "user", content: "Read the log." },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "read_unsafe_omitted_count",
            tool: "read",
            path: "unsafe.log",
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "read_unsafe_omitted_count",
        content: currentToolOutput,
      },
    ];

    // When
    const result = compactCurrentToolOutputs(messages, 1, {
      reason: "overflow_recovery",
      allowPreflightRecompaction: true,
    });

    // Then
    const compactedOutput = capturedToolOutput(
      result.messages,
      "read_unsafe_omitted_count",
    );
    expect(compactedOutput).toContain(
      "[current tool output compacted after context overflow:",
    );
    expect(compactedOutput).not.toContain(unsafeOmittedChars);
    expect(compactedOutput).not.toContain("Infinity");
  });

  test(`Given a preflight current-output compaction attempt receives the recompaction flag,
    When the current output is already preflight-compacted,
    Then only overflow recovery has authority to recompact that marker`, () => {
    // Given
    const currentToolOutput = [
      "PREFLIGHT_REAUTH_START",
      "preflight preview row ".repeat(200),
      "[current tool output compacted before provider request: approximately omitted 1200 chars; rerun the tool with narrower parameters if needed]",
    ].join("\n");
    const messages: Message[] = [
      { role: "user", content: "Read the log." },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "read_preflight_reauth",
            tool: "read",
            path: "preflight-reauth.log",
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "read_preflight_reauth",
        content: currentToolOutput,
      },
    ];

    // When
    const result = compactCurrentToolOutputs(messages, 1, {
      reason: "preflight",
      allowPreflightRecompaction: true,
    });

    // Then
    expect(result.stats.toolOutputsCompacted).toBe(0);
    expect(capturedToolOutput(result.messages, "read_preflight_reauth")).toBe(
      currentToolOutput,
    );
  });

  test(`Given the artifact-backed current-output compaction boundary receives no reason override,
    When an artifact is stored,
    Then the artifact purpose remains overflow recovery`, async () => {
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

  test(`Given artifact-backed current-output compaction would make the output larger,
    When the artifact marker is longer than the omitted content,
    Then the original current output is retained without saving an unreferenced artifact`, async () => {
    // Given
    const currentToolOutput = "small output";
    const messages: Message[] = [
      { role: "user", content: "Run the small command." },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "run_small_artifact",
            tool: "bash",
            command: "node small.js",
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "run_small_artifact",
        content: currentToolOutput,
      },
    ];
    const saved: SavedToolOutputArtifact[] = [];

    // When
    const result = await compactCurrentToolOutputsWithArtifacts(
      messages,
      1,
      storingArtifactStore(saved),
    );

    // Then
    expect(saved).toHaveLength(0);
    expect(result.stats.toolOutputsCompacted).toBe(0);
    expect(result.artifactReports).toEqual([]);
    expect(result.artifactNotices).toBeUndefined();
    expect(capturedToolOutput(result.messages, "run_small_artifact")).toBe(
      currentToolOutput,
    );
  });

  test(`Given current-output artifact storage fails before a no-op compaction,
    When the failed artifact marker would make the output larger,
    Then the original output is retained without reporting an artifact side effect`, async () => {
    // Given
    const currentToolOutput = "small output";
    const messages: Message[] = [
      { role: "user", content: "Run the small command." },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "run_small_failed_artifact",
            tool: "bash",
            command: "node small.js",
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "run_small_failed_artifact",
        content: currentToolOutput,
      },
    ];
    const discards: string[] = [];
    const store: ToolOutputArtifactStore = {
      verifyReusable: async () => ({ status: "not_reusable" }),
      save: async () => ({ status: "failed", reason: "disk full" }),
      discard: async (ref) => {
        discards.push(ref);
      },
    };

    // When
    const result = await compactCurrentToolOutputsWithArtifacts(
      messages,
      1,
      store,
    );

    // Then
    expect(discards).toEqual([]);
    expect(result.stats.toolOutputsCompacted).toBe(0);
    expect(result.artifactReports).toEqual([]);
    expect(result.artifactNotices).toBeUndefined();
    expect(
      capturedToolOutput(result.messages, "run_small_failed_artifact"),
    ).toBe(currentToolOutput);
  });

  test(`Given the compaction boundary receives an oversized current output under the request budget,
    When current output still exceeds the configured inline cap,
    Then it keeps the configured cap and preflight marker`, async () => {
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

  test(`Given printed agent events report proactive compaction,
    When the event contains compacted tool-output stats,
    Then CLI output labels those details as stale tool output`, async () => {
    // Given
    let stderr = "";
    const event: AgentEvent = {
      type: "context_compacted",
      reason: "proactive",
      historyCompacted: true,
      artifacts: [],
      beforeMessageCount: 4,
      afterMessageCount: 4,
      beforeEstimatedTokens: 1200,
      afterEstimatedTokens: 300,
      toolOutputsCompacted: 1,
      staleToolOutputsCompacted: 1,
      currentToolOutputsCompacted: 0,
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
    expect(stderr).toContain("Context compacted: proactive");
    expect(stderr).toContain("stale tool output 1");
    expect(stderr).not.toContain("current tool output 1");
  });

  test(`Given printed agent events report overflow-recovery compaction,
    When the event contains compacted tool-output stats,
    Then CLI output labels those details as current tool output`, async () => {
    // Given
    let stderr = "";
    const event: AgentEvent = {
      type: "context_compacted",
      reason: "overflow_recovery",
      historyCompacted: false,
      artifacts: [],
      beforeMessageCount: 4,
      afterMessageCount: 4,
      beforeEstimatedTokens: 1200,
      afterEstimatedTokens: 300,
      toolOutputsCompacted: 1,
      staleToolOutputsCompacted: 0,
      currentToolOutputsCompacted: 1,
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
    expect(stderr).toContain("current tool output 1");
    expect(stderr).not.toContain("stale tool output 1");
  });
});
