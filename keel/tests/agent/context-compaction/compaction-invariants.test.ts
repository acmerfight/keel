import { createHash } from "node:crypto";
import * as fc from "fast-check";
import { describe, expect, test } from "vitest";
import {
  type CurrentToolOutputCompactionPolicy,
  type CurrentToolOutputCompactionReason,
  compactCurrentToolOutputs,
  compactCurrentToolOutputsWithArtifacts,
  compactMessages,
  compactStaleToolOutputs,
  compactStaleToolOutputsWithArtifacts,
} from "../../../src/agent/context-compaction.ts";
import type { SessionMessage } from "../../../src/agent/session-message.ts";
import type {
  ToolOutputArtifactCompactionArtifact,
  ToolOutputArtifactSaveInput,
  ToolOutputArtifactSourceStatus,
  ToolOutputArtifactStore,
} from "../../../src/agent/tool-output-artifacts.ts";
import type { LLMProvider, ToolCall } from "../../../src/llm/types.ts";

const PROPERTY_RUNS = 40;
const ZERO_TOOL_OUTPUT_STATS = {
  toolOutputsCompacted: 0,
  staleToolOutputsCompacted: 0,
  currentToolOutputsCompacted: 0,
  toolOutputCharsBefore: 0,
  toolOutputCharsAfter: 0,
  toolOutputEstimatedTokensBefore: 0,
  toolOutputEstimatedTokensAfter: 0,
};
const ZERO_USAGE = {
  inputTokens: 0,
  cachedInputTokens: 0,
  uncachedInputTokens: 0,
  outputTokens: 0,
};
const UNUSED_PROVIDER: LLMProvider = {
  id: "unused-context-compaction-invariant-provider",
  stream: () => {
    throw new Error("Provider should not be called by this compaction test");
  },
};

type ToolOutputCompactionScope = "current" | "stale";

interface SavedToolOutputArtifact {
  readonly ref: string;
  readonly input: ToolOutputArtifactSaveInput;
  readonly contentSha256: string;
}

interface ExistingToolOutputArtifact {
  readonly ref: string;
  readonly toolCallId: string;
  readonly sourceStatus: ToolOutputArtifactSourceStatus;
  readonly content: string;
}

interface RecordingArtifactStore {
  readonly store: ToolOutputArtifactStore;
  readonly saved: readonly SavedToolOutputArtifact[];
  readonly discarded: readonly string[];
  readonly saveAttempts: () => number;
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function recordingArtifactStore(options?: {
  readonly saveMode?: "failed" | "stored";
  readonly existingArtifacts?: readonly ExistingToolOutputArtifact[];
}): RecordingArtifactStore {
  const saveMode = options?.saveMode ?? "stored";
  const saved: SavedToolOutputArtifact[] = [];
  const discarded: string[] = [];
  let saveAttempts = 0;
  const artifacts = new Map<string, ExistingToolOutputArtifact>(
    (options?.existingArtifacts ?? []).map((artifact) => [
      artifact.ref,
      artifact,
    ]),
  );
  return {
    saved,
    discarded,
    saveAttempts: () => saveAttempts,
    store: {
      verifyReusable: async (input) => {
        const artifact = artifacts.get(input.ref);
        if (artifact === undefined) {
          return { status: "not_reusable" };
        }
        const contentSha256 = sha256(artifact.content);
        const previewMatches =
          input.previewKind === "prefix"
            ? artifact.content.startsWith(input.previewContent)
            : input.contentSha256 === contentSha256;
        if (
          artifact.toolCallId !== input.toolCallId ||
          artifact.sourceStatus !== input.sourceStatus ||
          artifact.content.length !==
            input.previewContent.length + input.omittedChars ||
          (input.contentSha256 !== undefined &&
            input.contentSha256 !== contentSha256) ||
          !previewMatches
        ) {
          return { status: "not_reusable" };
        }
        return { status: "reusable", contentSha256 };
      },
      save: async (input) => {
        saveAttempts++;
        if (saveMode === "failed") {
          return { status: "failed", reason: "disk full" };
        }
        const ref = `tool-output:test/${saveAttempts}`;
        const contentSha256 = sha256(input.content);
        const artifact = { ref, input, contentSha256 };
        saved.push(artifact);
        artifacts.set(ref, {
          ref,
          toolCallId: input.toolCallId,
          sourceStatus: input.sourceStatus,
          content: input.content,
        });
        return { status: "stored", ref, contentSha256 };
      },
      discard: async (ref) => {
        discarded.push(ref);
        const savedIndex = saved.findIndex((artifact) => artifact.ref === ref);
        if (savedIndex !== -1) {
          saved.splice(savedIndex, 1);
        }
        artifacts.delete(ref);
      },
    },
  };
}

function readToolCall(id: string): ToolCall {
  return {
    id,
    tool: "read",
    path: `${id}.log`,
  };
}

function messagesForScope(
  scope: ToolOutputCompactionScope,
  toolCallId: string,
  content: string,
): SessionMessage[] {
  const messages: SessionMessage[] = [
    { role: "user", content: "Inspect the tool output." },
    {
      role: "assistant",
      content: "",
      toolCalls: [readToolCall(toolCallId)],
    },
    {
      role: "tool",
      toolCallId,
      content,
    },
  ];
  if (scope === "stale") {
    messages.push({
      role: "assistant",
      content: "The tool output was inspected.",
      toolCalls: [],
    });
  }
  return messages;
}

function generatedOutput(maxChars: number, extraChars: number): string {
  return ["OUTPUT_START", "x".repeat(maxChars + extraChars), "OUTPUT_END"].join(
    "\n",
  );
}

function toolOutput(
  messages: readonly SessionMessage[],
  toolCallId: string,
): string {
  const message = messages.find(
    (candidate) =>
      candidate.role === "tool" && candidate.toolCallId === toolCallId,
  );
  if (message?.role !== "tool") {
    throw new Error(`Expected tool output ${toolCallId}`);
  }
  return message.content;
}

function toolResultIds(messages: readonly SessionMessage[]): readonly string[] {
  return messages.flatMap((message) =>
    message.role === "tool" ? [message.toolCallId] : [],
  );
}

function assistantToolCallIds(
  messages: readonly SessionMessage[],
): readonly string[] {
  return messages.flatMap((message) =>
    message.role === "assistant"
      ? message.toolCalls.map((toolCall) => toolCall.id)
      : [],
  );
}

function expectToolLinkagePreserved(
  before: readonly SessionMessage[],
  after: readonly SessionMessage[],
): void {
  expect(toolResultIds(after)).toEqual(toolResultIds(before));
  expect(assistantToolCallIds(after)).toEqual(assistantToolCallIds(before));
}

function expectNoPublishedArtifactSideEffects(result: {
  readonly artifactReports?: readonly ToolOutputArtifactCompactionArtifact[];
  readonly artifactNotices?: readonly unknown[];
}): void {
  expect(result.artifactReports ?? []).toEqual([]);
  expect(result.artifactNotices).toBeUndefined();
}

function currentToolOutputPolicy(
  reason: CurrentToolOutputCompactionReason,
): CurrentToolOutputCompactionPolicy {
  return reason === "preflight"
    ? { reason }
    : { reason, preflightCompactedOutputs: "preserve" };
}

async function compactWithStoredArtifacts(options: {
  readonly scope: ToolOutputCompactionScope;
  readonly currentReason: CurrentToolOutputCompactionReason;
  readonly messages: readonly SessionMessage[];
  readonly maxChars: number;
  readonly store: ToolOutputArtifactStore;
}) {
  return options.scope === "stale"
    ? await compactStaleToolOutputsWithArtifacts(
        options.messages,
        options.maxChars,
        options.store,
      )
    : await compactCurrentToolOutputsWithArtifacts(
        options.messages,
        options.maxChars,
        options.store,
        {
          policy: currentToolOutputPolicy(options.currentReason),
          settledMaxChars: options.maxChars,
        },
      );
}

function compactWithoutArtifacts(options: {
  readonly scope: ToolOutputCompactionScope;
  readonly currentReason: CurrentToolOutputCompactionReason;
  readonly messages: readonly SessionMessage[];
  readonly maxChars: number;
}) {
  return options.scope === "stale"
    ? compactStaleToolOutputs(options.messages, options.maxChars)
    : compactCurrentToolOutputs(options.messages, options.maxChars, {
        policy: currentToolOutputPolicy(options.currentReason),
        settledMaxChars: options.maxChars,
      });
}

describe("Context Compaction Invariants", () => {
  test(`Given generated stale and current tool outputs without artifact storage,
    When tool-output compaction accepts or rejects each candidate,
    Then only accepted candidates publish shorter provider-visible outputs`, () => {
    fc.assert(
      fc.property(
        fc.record({
          scope: fc.constantFrom<ToolOutputCompactionScope>("current", "stale"),
          currentReason: fc.constantFrom<CurrentToolOutputCompactionReason>(
            "overflow_recovery",
            "preflight",
          ),
          maxChars: fc.integer({ min: 1, max: 220 }),
          extraChars: fc.integer({ min: 1, max: 1_200 }),
        }),
        ({ scope, currentReason, maxChars, extraChars }) => {
          // Given
          const toolCallId = `${scope}_${currentReason}_plain_output`;
          const originalContent = generatedOutput(maxChars, extraChars);
          const messages = messagesForScope(scope, toolCallId, originalContent);

          // When
          const result = compactWithoutArtifacts({
            scope,
            currentReason,
            messages,
            maxChars,
          });

          // Then
          expectToolLinkagePreserved(messages, result.messages);
          expectNoPublishedArtifactSideEffects(result);
          if (result.stats.toolOutputsCompacted === 0) {
            expect(result.messages).toEqual(messages);
            expect(result.stats).toEqual(ZERO_TOOL_OUTPUT_STATS);
            return;
          }

          const compactedContent = toolOutput(result.messages, toolCallId);
          expect(compactedContent.length).toBeLessThan(originalContent.length);
          expect(compactedContent).not.toContain("full output artifact:");
          expect(result.stats.toolOutputsCompacted).toBe(1);
          expect(result.stats.toolOutputCharsAfter).toBeLessThan(
            result.stats.toolOutputCharsBefore,
          );
          expect(result.stats.staleToolOutputsCompacted).toBe(
            scope === "stale" ? 1 : 0,
          );
          expect(result.stats.currentToolOutputsCompacted).toBe(
            scope === "current" ? 1 : 0,
          );
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  test(`Given generated stale and current tool outputs with artifact storage,
    When tool-output compaction accepts or rejects each candidate,
    Then only accepted candidates publish shorter outputs and artifact side effects`, async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          scope: fc.constantFrom<ToolOutputCompactionScope>("current", "stale"),
          currentReason: fc.constantFrom<CurrentToolOutputCompactionReason>(
            "overflow_recovery",
            "preflight",
          ),
          maxChars: fc.integer({ min: 1, max: 220 }),
          extraChars: fc.integer({ min: 1, max: 1_200 }),
        }),
        async ({ scope, currentReason, maxChars, extraChars }) => {
          // Given
          const toolCallId = `${scope}_${currentReason}_generated_output`;
          const originalContent = generatedOutput(maxChars, extraChars);
          const messages = messagesForScope(scope, toolCallId, originalContent);
          const artifacts = recordingArtifactStore();

          // When
          const result = await compactWithStoredArtifacts({
            scope,
            currentReason,
            messages,
            maxChars,
            store: artifacts.store,
          });

          // Then
          expectToolLinkagePreserved(messages, result.messages);
          if (result.stats.toolOutputsCompacted === 0) {
            expect(result.messages).toEqual(messages);
            expect(result.stats).toEqual(ZERO_TOOL_OUTPUT_STATS);
            expectNoPublishedArtifactSideEffects(result);
            expect(artifacts.saved).toEqual([]);
            expect(artifacts.discarded).toHaveLength(artifacts.saveAttempts());
            return;
          }

          const compactedContent = toolOutput(result.messages, toolCallId);
          expect(compactedContent.length).toBeLessThan(originalContent.length);
          expect(compactedContent).toContain("full output artifact:");
          expect(result.stats.toolOutputsCompacted).toBe(1);
          expect(result.stats.toolOutputCharsAfter).toBeLessThan(
            result.stats.toolOutputCharsBefore,
          );
          expect(result.stats.staleToolOutputsCompacted).toBe(
            scope === "stale" ? 1 : 0,
          );
          expect(result.stats.currentToolOutputsCompacted).toBe(
            scope === "current" ? 1 : 0,
          );
          expect(artifacts.saveAttempts()).toBe(1);
          expect(artifacts.saved).toHaveLength(1);
          expect(artifacts.discarded).toEqual([]);
          expect(result.artifactReports).toHaveLength(1);
          expect(result.artifactReports?.[0]).toMatchObject({
            status: "stored",
            toolCallId,
            sourceStatus: "complete",
          });
          expect(result.artifactNotices).toHaveLength(1);
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  test(`Given artifact storage fails for generated stale and current tool outputs,
    When compaction accepts or rejects each candidate,
    Then failed artifact notices are published only for accepted shorter outputs`, async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          scope: fc.constantFrom<ToolOutputCompactionScope>("current", "stale"),
          currentReason: fc.constantFrom<CurrentToolOutputCompactionReason>(
            "overflow_recovery",
            "preflight",
          ),
          maxChars: fc.integer({ min: 1, max: 220 }),
          extraChars: fc.integer({ min: 1, max: 1_200 }),
        }),
        async ({ scope, currentReason, maxChars, extraChars }) => {
          // Given
          const toolCallId = `${scope}_${currentReason}_failed_artifact`;
          const originalContent = generatedOutput(maxChars, extraChars);
          const messages = messagesForScope(scope, toolCallId, originalContent);
          const artifacts = recordingArtifactStore({ saveMode: "failed" });

          // When
          const result = await compactWithStoredArtifacts({
            scope,
            currentReason,
            messages,
            maxChars,
            store: artifacts.store,
          });

          // Then
          expectToolLinkagePreserved(messages, result.messages);
          expect(artifacts.saved).toEqual([]);
          expect(artifacts.discarded).toEqual([]);
          if (result.stats.toolOutputsCompacted === 0) {
            expect(result.messages).toEqual(messages);
            expect(result.stats).toEqual(ZERO_TOOL_OUTPUT_STATS);
            expectNoPublishedArtifactSideEffects(result);
            return;
          }

          expect(toolOutput(result.messages, toolCallId).length).toBeLessThan(
            originalContent.length,
          );
          expect(result.artifactReports).toEqual([
            expect.objectContaining({
              status: "failed",
              reason: "disk full",
              toolCallId,
            }),
          ]);
          expect(result.artifactNotices).toEqual([
            expect.objectContaining({
              status: "failed",
              reason: "disk full",
              toolCallId,
            }),
          ]);
        },
      ),
      { numRuns: PROPERTY_RUNS },
    );
  });

  test(`Given a stale tool output already has a verified reusable artifact marker,
    When a smaller compaction candidate is accepted,
    Then the committed report reuses the artifact without saving or discarding it`, async () => {
    // Given
    const toolCallId = "read_reusable_artifact";
    const preview = [
      "REUSABLE_START",
      "reusable preview line ".repeat(120),
      "REUSABLE_PREVIEW_END",
    ].join("\n");
    const fullContent = `${preview}\n${"hidden reusable output ".repeat(300)}`;
    const omittedChars = fullContent.length - preview.length;
    const contentSha256 = sha256(fullContent);
    const ref = "tool-output:reusable/1";
    const marker = `[tool output shortened: omitted ${omittedChars} chars; full output artifact: ${ref}; inspect with: keel artifacts show ${ref}; sha256: ${contentSha256}; source status: complete]`;
    const originalContent = `${preview}\n${marker}`;
    const messages = messagesForScope("stale", toolCallId, originalContent);
    const artifacts = recordingArtifactStore({
      existingArtifacts: [
        {
          ref,
          toolCallId,
          sourceStatus: "complete",
          content: fullContent,
        },
      ],
    });

    // When
    const result = await compactStaleToolOutputsWithArtifacts(
      messages,
      80,
      artifacts.store,
    );

    // Then
    expect(result.stats.toolOutputsCompacted).toBe(1);
    expect(toolOutput(result.messages, toolCallId).length).toBeLessThan(
      originalContent.length,
    );
    expect(toolOutput(result.messages, toolCallId)).toContain(
      `full output artifact: ${ref}`,
    );
    expect(result.artifactReports).toEqual([
      expect.objectContaining({
        status: "reused",
        ref,
        toolCallId,
      }),
    ]);
    expect(result.artifactNotices).toBeUndefined();
    expect(artifacts.saveAttempts()).toBe(0);
    expect(artifacts.saved).toEqual([]);
    expect(artifacts.discarded).toEqual([]);
    expectToolLinkagePreserved(messages, result.messages);
  });

  test(`Given artifact-backed current-output compaction is rejected by the final request gate,
    When the candidate saved an artifact before the final token check,
    Then the request remains unchanged and the pending artifact is discarded`, async () => {
    const reasons: CurrentToolOutputCompactionReason[] = [
      "preflight",
      "overflow_recovery",
    ];
    for (const reason of reasons) {
      // Given
      const toolCallId = `current_final_gate_${reason}_artifact`;
      const originalContent = "x".repeat(352);
      const originalMessages = messagesForScope(
        "current",
        toolCallId,
        originalContent,
      );
      const messages = messagesForScope("current", toolCallId, originalContent);
      const artifacts = recordingArtifactStore();

      // When
      const result = await compactMessages({
        provider: UNUSED_PROVIDER,
        systemPrompt: "",
        messages,
        signal: new AbortController().signal,
        currentToolOutputCompaction:
          reason === "preflight"
            ? {
                mode: "current_only",
                reason,
                maxChars: 1,
              }
            : {
                mode: "current_only",
                reason,
                maxChars: 1,
                preflightCompactedOutputs: "preserve",
              },
        toolOutputArtifacts: { store: artifacts.store },
      });

      // Then
      expect(result).toEqual({ compacted: false, usage: ZERO_USAGE });
      expect(messages).toEqual(originalMessages);
      expect(artifacts.saveAttempts()).toBe(1);
      expect(artifacts.saved).toEqual([]);
      expect(artifacts.discarded).toEqual(["tool-output:test/1"]);
    }
  });

  test(`Given failed-artifact current-output compaction is rejected by the final request gate,
    When the candidate has no stored artifact ref to discard,
    Then the request remains unchanged and no artifact side effect is published`, async () => {
    // Given
    const toolCallId = "current_final_gate_failed_artifact";
    const originalContent = "x".repeat(251);
    const originalMessages = messagesForScope(
      "current",
      toolCallId,
      originalContent,
    );
    const messages = messagesForScope("current", toolCallId, originalContent);
    const artifacts = recordingArtifactStore({ saveMode: "failed" });

    // When
    const result = await compactMessages({
      provider: UNUSED_PROVIDER,
      systemPrompt: "",
      messages,
      signal: new AbortController().signal,
      currentToolOutputCompaction: {
        mode: "current_only",
        reason: "preflight",
        maxChars: 1,
      },
      toolOutputArtifacts: { store: artifacts.store },
    });

    // Then
    expect(result).toEqual({ compacted: false, usage: ZERO_USAGE });
    expect(messages).toEqual(originalMessages);
    expect(artifacts.saveAttempts()).toBe(1);
    expect(artifacts.saved).toEqual([]);
    expect(artifacts.discarded).toEqual([]);
  });
});
