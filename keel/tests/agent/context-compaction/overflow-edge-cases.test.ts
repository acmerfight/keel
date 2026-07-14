import { createHash } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { compactMessages } from "../../../src/agent/context-compaction.ts";
import { runAgentTurn } from "../../../src/agent/loop.ts";
import {
  defaultStopPolicy,
  maxTurnFallbackPolicy,
} from "../../../src/agent/stop-policy.ts";
import type {
  ToolOutputArtifactSaveInput,
  ToolOutputArtifactStore,
} from "../../../src/agent/tool-output-artifacts.ts";
import { KeelError } from "../../../src/core/error.ts";
import type { LLMProvider, Message } from "../../../src/llm/types.ts";
import {
  collect,
  endEvent,
  estimatedTextTokens,
  failingStream,
  freshSignal,
  onlyContextCompactedEvent,
  workspace,
  ZERO_USAGE,
} from "../../../src/testing/context-compaction-fixtures.ts";
import { createWorkspace } from "../../../src/testing/file-editing-fixtures.ts";

interface SavedToolOutputArtifact {
  readonly input: ToolOutputArtifactSaveInput;
}

interface ExistingToolOutputArtifact {
  readonly ref: string;
  readonly toolCallId: string;
  readonly sourceStatus: "complete" | "source-truncated";
  readonly content: string;
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function failingArtifactStore(
  saved: SavedToolOutputArtifact[],
  options?: {
    readonly reason?: string;
    readonly existingArtifacts?: readonly ExistingToolOutputArtifact[];
  },
): ToolOutputArtifactStore {
  const existingArtifacts = new Map(
    (options?.existingArtifacts ?? []).map((artifact) => [
      artifact.ref,
      artifact,
    ]),
  );
  return {
    verifyReusable: async (input) => {
      const artifact = existingArtifacts.get(input.ref);
      if (artifact === undefined) {
        return { status: "not_reusable" };
      }
      const contentSha256 = sha256(artifact.content);
      const contentLengthMatches =
        artifact.content.length ===
        input.previewContent.length + input.omittedChars;
      const previewMatches =
        input.previewKind === "prefix"
          ? artifact.content.startsWith(input.previewContent)
          : input.contentSha256 === contentSha256;
      if (
        artifact.toolCallId !== input.toolCallId ||
        artifact.sourceStatus !== input.sourceStatus ||
        !contentLengthMatches ||
        (input.contentSha256 !== undefined &&
          input.contentSha256 !== contentSha256) ||
        !previewMatches
      ) {
        return { status: "not_reusable" };
      }
      return { status: "reusable", contentSha256 };
    },
    save: async (input) => {
      saved.push({ input });
      return { status: "failed", reason: options?.reason ?? "disk full" };
    },
    discard: async () => {},
  };
}

describe("Context Compaction Overflow Edge Cases", () => {
  test(`Given the current tool output was already compacted by overflow recovery,
    When current tool-output compaction runs again with no history to summarize,
    Then it reports no compaction instead of compacting the marker again`, async () => {
    // Given
    const alreadyCompactedOutput = [
      "large log output",
      "[current tool output compacted after context overflow: approximately omitted 6000 chars; rerun the tool with narrower parameters if needed]",
    ].join("\n");
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
        content: alreadyCompactedOutput,
      },
    ];
    const provider: LLMProvider = {
      id: "already-compacted-current-output-provider",
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
        keepRecentTokens: 1,
        toolOutputMaxChars: 128,
      },
      allowCurrentToolOutputCompaction: true,
    });

    // Then
    expect(result).toEqual({
      compacted: false,
      usage: ZERO_USAGE,
    });
    expect(messages).toEqual([
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
        content: alreadyCompactedOutput,
      },
    ]);
  });

  test(`Given artifact storage is enabled and current tool output is already small,
    When current tool-output compaction runs with no history to summarize,
    Then it leaves the messages unchanged without saving an artifact`, async () => {
    // Given
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
        content: "small note output",
      },
    ];
    const saved: SavedToolOutputArtifact[] = [];
    const store: ToolOutputArtifactStore = {
      verifyReusable: async () => ({ status: "not_reusable" }),
      save: async (input) => {
        saved.push({ input });
        return {
          status: "stored",
          ref: "tool-output:test/1",
          contentSha256: "0".repeat(64),
        };
      },
      discard: async () => {},
    };
    const provider: LLMProvider = {
      id: "small-current-output-artifact-provider",
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
        keepRecentTokens: 1,
        toolOutputMaxChars: 128,
      },
      allowCurrentToolOutputCompaction: true,
      toolOutputArtifacts: { store },
    });

    // Then
    expect(result).toEqual({
      compacted: false,
      usage: ZERO_USAGE,
    });
    expect(saved).toEqual([]);
    expect(messages).toEqual([
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
        content: "small note output",
      },
    ]);
  });

  test(`Given current tool output overflows and artifact storage fails,
    When overflow recovery compacts the current tool output,
    Then the retry sees a lossy marker with rerun guidance`, async () => {
    // Given
    const currentToolOutput = [
      "CURRENT_START",
      "[bash stdout truncated: showing last 20000 bytes]",
      "current output line ".repeat(500),
      "CURRENT_END",
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
      },
    ];
    const saved: SavedToolOutputArtifact[] = [];
    let mainRequests = 0;
    let retriedMessages: readonly Message[] = [];
    const provider: LLMProvider = {
      id: "current-output-artifact-failure-provider",
      async *stream(options) {
        mainRequests++;
        if (mainRequests === 1) {
          throw new KeelError(
            "provider_context_overflow",
            "Request exceeded context before current output compaction",
          );
        }

        retriedMessages = [...options.messages];
        yield {
          type: "text",
          text: "Continued after lossy current output compaction.",
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
          keepRecentTokens: 1,
          toolOutputMaxChars: 128,
        },
        toolOutputArtifacts: {
          store: failingArtifactStore(saved, { reason: " \n\t " }),
        },
      }),
    );

    // Then
    expect(mainRequests).toBe(2);
    expect(saved).toHaveLength(1);
    expect(saved[0]?.input).toMatchObject({
      toolCallId: "run_noisy_command",
      toolName: "bash",
      purpose: "current-overflow-compaction",
      sourceStatus: "source-truncated",
      content: currentToolOutput,
    });
    const retriedToolOutput =
      retriedMessages.find(
        (message) =>
          message.role === "tool" && message.toolCallId === "run_noisy_command",
      )?.content ?? "";
    expect(retriedToolOutput).toContain(
      "artifact storage failed: unknown storage error",
    );
    expect(retriedToolOutput).toContain(
      "model recovery: rerun the tool with narrower parameters if needed",
    );
    expect(retriedToolOutput.match(/model recovery:/gu)).toHaveLength(1);
    expect(retriedToolOutput).toContain("CURRENT_END");
    expect(onlyContextCompactedEvent(events)).toMatchObject({
      reason: "overflow_recovery",
      toolOutputsCompacted: 1,
    });
  });

  test(`Given current tool output already has an artifact-backed settlement marker,
    When overflow recovery compacts the current tool output,
    Then the retry reuses the original artifact ref without saving another artifact`, async () => {
    // Given
    const currentPreview = [
      "CURRENT_SETTLED_START",
      "settled current output line ".repeat(500),
      "CURRENT_SETTLED_PREVIEW_END",
    ].join("\n");
    const currentFullOutput = `${currentPreview}\n${"hidden settled output ".repeat(
      500,
    )}`;
    const currentOmittedChars =
      currentFullOutput.length - currentPreview.length;
    const currentToolOutput = `${currentPreview}\n[tool output shortened: omitted ${currentOmittedChars} chars; full output artifact: tool-output:run/current-first; inspect with: keel artifacts show tool-output:run/current-first; source status: source-truncated/lossy before artifact capture]`;
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
    const saved: SavedToolOutputArtifact[] = [];
    let mainRequests = 0;
    let retriedMessages: readonly Message[] = [];
    const provider: LLMProvider = {
      id: "current-output-reuses-existing-artifact-provider",
      async *stream(options) {
        mainRequests++;
        if (mainRequests === 1) {
          throw new KeelError(
            "provider_context_overflow",
            "Settled current output made request too large",
          );
        }

        retriedMessages = [...options.messages];
        yield {
          type: "text",
          text: "Continued after reusing the current output artifact.",
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
          keepRecentTokens: 1,
          toolOutputMaxChars: 128,
        },
        toolOutputArtifacts: {
          store: failingArtifactStore(saved, {
            existingArtifacts: [
              {
                ref: "tool-output:run/current-first",
                toolCallId: "read_large_log",
                sourceStatus: "source-truncated",
                content: currentFullOutput,
              },
            ],
          }),
        },
      }),
    );

    // Then
    expect(mainRequests).toBe(2);
    expect(saved).toHaveLength(0);
    const retriedToolOutput =
      retriedMessages.find(
        (message) =>
          message.role === "tool" && message.toolCallId === "read_large_log",
      )?.content ?? "";
    expect(retriedToolOutput).toContain(
      "[current tool output compacted after context overflow:",
    );
    expect(retriedToolOutput).toContain(
      "inspect with: keel artifacts show tool-output:run/current-first",
    );
    expect(retriedToolOutput).toContain(
      "source status: source-truncated/lossy before artifact capture",
    );
    expect(retriedToolOutput).not.toContain("CURRENT_SETTLED_PREVIEW_END");
    expect(events.some((event) => event.type === "tool_output_artifact")).toBe(
      false,
    );
    expect(events).toContainEqual({
      type: "text",
      text: "Continued after reusing the current output artifact.",
    });
  });

  test(`Given a real current read result overflows before assistant output,
    When overflow recovery compacts the current tool output,
    Then the retry does not restore a duplicate post-compaction read`, async () => {
    // Given
    const workspace = await createWorkspace();
    const messages: Message[] = [
      { role: "user", content: "Read the large log and continue." },
    ];
    const largeLogOutput = "large log output ".repeat(400);
    let mainRequests = 0;
    let summaryRequests = 0;
    let retriedMessages: readonly Message[] = [];
    const provider: LLMProvider = {
      id: "real-current-read-overflow-provider",
      async *stream(options) {
        if (options.toolChoice === "none") {
          summaryRequests++;
          yield { type: "text", text: "Unexpected summary." };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }

        mainRequests++;
        if (mainRequests === 1) {
          yield {
            type: "tool_call",
            id: "read_large_log",
            tool: "read",
            path: "large.log",
          };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }

        if (mainRequests === 2) {
          throw new KeelError(
            "provider_context_overflow",
            "Current read result made request too large",
          );
        }

        retriedMessages = [...options.messages];
        yield {
          type: "text",
          text: "Continued after compacting the current read result.",
        };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };

    try {
      await writeFile(join(workspace, "large.log"), largeLogOutput, "utf8");

      // When
      const events = await collect(
        runAgentTurn({
          workspace,
          provider,
          messages,
          systemPrompt: "You are helpful.",
          signal: freshSignal(),
          allowBash: false,
          stopPolicy: defaultStopPolicy(),
          contextCompaction: {
            keepRecentTokens: 1,
            toolOutputMaxChars: 128,
          },
        }),
      );

      // Then
      expect(mainRequests).toBe(3);
      expect(summaryRequests).toBe(0);
      const retriedToolMessages = retriedMessages.filter(
        (message): message is Extract<Message, { readonly role: "tool" }> =>
          message.role === "tool",
      );
      expect(retriedToolMessages).toHaveLength(1);
      expect(retriedToolMessages[0]).toEqual({
        role: "tool",
        toolCallId: "read_large_log",
        content: expect.stringContaining(
          "[current tool output compacted after context overflow:",
        ),
      });
      expect(
        retriedMessages
          .flatMap((message) =>
            message.role === "assistant" ? message.toolCalls : [],
          )
          .some((toolCall) => toolCall.id.startsWith("post_compaction_read")),
      ).toBe(false);
      expect(events).toContainEqual({
        type: "text",
        text: "Continued after compacting the current read result.",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an unconsumed tool result is the final message when the provider reports context overflow,
    When preserving the latest user and current tool round leaves no history to summarize,
    Then overflow recovery compacts the current tool output and retries without a summary request`, async () => {
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
    let retriedMessages: readonly Message[] = [];
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

        retriedMessages = [...options.messages];
        const retriedToolOutput =
          retriedMessages.find(
            (message) =>
              message.role === "tool" &&
              message.toolCallId === "read_large_log",
          )?.content ?? "";
        if (
          retriedToolOutput === currentToolOutput ||
          !retriedToolOutput.includes(
            "[current tool output compacted after context overflow:",
          )
        ) {
          throw new KeelError(
            "provider_context_overflow",
            "Retry did not compact the current tool output",
          );
        }

        yield {
          type: "text",
          text: "Continued after shrinking current tool output.",
        };
        yield {
          type: "stop",
          reason: "stop",
          usage: {
            inputTokens: 20,
            cachedInputTokens: 0,
            uncachedInputTokens: 20,
            outputTokens: 7,
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
          keepRecentTokens: 1,
          toolOutputMaxChars: 128,
        },
      }),
    );

    // Then
    const compactionEvent = onlyContextCompactedEvent(events);
    expect(mainRequests).toBe(2);
    expect(summaryRequests).toBe(0);
    expect(summaryPrompt).toBe("");
    expect(retriedMessages).toContainEqual({
      role: "user",
      content: "Read the large log and continue.",
    });
    const toolCallIndex = retriedMessages.findIndex(
      (message) =>
        message.role === "assistant" &&
        message.toolCalls.some((toolCall) => toolCall.id === "read_large_log"),
    );
    const toolResultIndex = retriedMessages.findIndex(
      (message) =>
        message.role === "tool" && message.toolCallId === "read_large_log",
    );
    expect(toolCallIndex).toBeGreaterThan(-1);
    expect(toolResultIndex).toBe(toolCallIndex + 1);
    const retriedToolOutput =
      retriedMessages[toolResultIndex]?.role === "tool"
        ? retriedMessages[toolResultIndex].content
        : "";
    expect(retriedToolOutput).toContain("large log output");
    expect(retriedToolOutput).toContain(
      "[current tool output compacted after context overflow:",
    );
    expect(retriedToolOutput).not.toBe(currentToolOutput);
    expect(compactionEvent).toMatchObject({
      reason: "overflow_recovery",
      toolOutputsCompacted: 1,
      toolOutputCharsBefore: currentToolOutput.length,
      toolOutputCharsAfter: retriedToolOutput.length,
      toolOutputEstimatedTokensBefore: estimatedTextTokens(currentToolOutput),
      toolOutputEstimatedTokensAfter: estimatedTextTokens(retriedToolOutput),
    });
    expect(events).toContainEqual({
      type: "text",
      text: "Continued after shrinking current tool output.",
    });
    expect(endEvent(events).usage).toEqual({
      inputTokens: 20,
      cachedInputTokens: 0,
      uncachedInputTokens: 20,
      outputTokens: 7,
    });
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
      turns: 1,
      stopReason: "turn_limit",
    });
    expect(messages.at(-1)).toEqual({
      role: "assistant",
      content: "Need to inspect.\nStopped before running tools.",
      toolCalls: [],
    });
  });
});
