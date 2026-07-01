import type { Message } from "../../llm/types.ts";
import {
  isGeneratedSettledToolOutput,
  type ToolOutputArtifactNotice,
  type ToolOutputArtifactPurpose,
  type ToolOutputArtifactSourceStatus,
  type ToolOutputArtifactStore,
  toolOutputArtifactFailedMarker,
  toolOutputArtifactStoredMarker,
} from "../tool-output-artifacts.ts";
import { currentToolRound } from "./current-tool-round.ts";
import { estimateTextTokens } from "./token-accounting.ts";

const STALE_TOOL_OUTPUT_COMPACTED_PREFIX =
  "[stale tool output compacted: approximately omitted ";
const STALE_TOOL_OUTPUT_COMPACTED_SUFFIX = " chars]";
const STALE_TOOL_OUTPUT_COMPACTED_SUFFIX_PATTERN =
  /\n\[stale tool output compacted: approximately omitted [0-9]+ chars(?:; [^\]]+)?\]$/;
const STALE_TOOL_OUTPUT_COMPACTED_OVERHEAD_CHARS =
  "\n".length +
  STALE_TOOL_OUTPUT_COMPACTED_PREFIX.length +
  String(Number.MAX_SAFE_INTEGER).length +
  STALE_TOOL_OUTPUT_COMPACTED_SUFFIX.length;
const CURRENT_TOOL_OUTPUT_COMPACTED_PREFIX =
  "[current tool output compacted after context overflow: approximately omitted ";
const CURRENT_TOOL_OUTPUT_COMPACTED_SUFFIX =
  " chars; rerun the tool with narrower parameters if needed]";
const CURRENT_TOOL_OUTPUT_COMPACTED_SUFFIX_PATTERN =
  /\n\[current tool output compacted after context overflow: approximately omitted [0-9]+ chars(?:; [^\]]+)?\]$/;
const CURRENT_TOOL_OUTPUT_COMPACTED_OVERHEAD_CHARS =
  "\n".length +
  CURRENT_TOOL_OUTPUT_COMPACTED_PREFIX.length +
  String(Number.MAX_SAFE_INTEGER).length +
  CURRENT_TOOL_OUTPUT_COMPACTED_SUFFIX.length;

export interface StaleToolOutputCompactionStats {
  readonly toolOutputsCompacted: number;
  readonly toolOutputCharsBefore: number;
  readonly toolOutputCharsAfter: number;
  readonly toolOutputEstimatedTokensBefore: number;
  readonly toolOutputEstimatedTokensAfter: number;
}

export interface StaleToolOutputCompactionResult {
  readonly messages: readonly Message[];
  readonly stats: StaleToolOutputCompactionStats;
  readonly artifactNotices?: readonly ToolOutputArtifactNotice[];
}

interface StaleToolOutputCompactionEntry {
  readonly message: Message;
  readonly stats: StaleToolOutputCompactionStats;
  readonly artifactNotice?: ToolOutputArtifactNotice;
}

export const EMPTY_STALE_TOOL_OUTPUT_COMPACTION_STATS: StaleToolOutputCompactionStats =
  {
    toolOutputsCompacted: 0,
    toolOutputCharsBefore: 0,
    toolOutputCharsAfter: 0,
    toolOutputEstimatedTokensBefore: 0,
    toolOutputEstimatedTokensAfter: 0,
  };

function staleToolOutputCompactionStats(
  originalContent: string,
  compactedContent: string,
): StaleToolOutputCompactionStats {
  return {
    toolOutputsCompacted: 1,
    toolOutputCharsBefore: originalContent.length,
    toolOutputCharsAfter: compactedContent.length,
    toolOutputEstimatedTokensBefore: estimateTextTokens(originalContent),
    toolOutputEstimatedTokensAfter: estimateTextTokens(compactedContent),
  };
}

export function mergeStaleToolOutputCompactionStats(
  left: StaleToolOutputCompactionStats,
  right: StaleToolOutputCompactionStats,
): StaleToolOutputCompactionStats {
  return {
    toolOutputsCompacted:
      left.toolOutputsCompacted + right.toolOutputsCompacted,
    toolOutputCharsBefore:
      left.toolOutputCharsBefore + right.toolOutputCharsBefore,
    toolOutputCharsAfter:
      left.toolOutputCharsAfter + right.toolOutputCharsAfter,
    toolOutputEstimatedTokensBefore:
      left.toolOutputEstimatedTokensBefore +
      right.toolOutputEstimatedTokensBefore,
    toolOutputEstimatedTokensAfter:
      left.toolOutputEstimatedTokensAfter +
      right.toolOutputEstimatedTokensAfter,
  };
}

function staleToolOutputCompactedMarker(
  omittedChars: number,
  artifactMarker?: string,
): string {
  if (artifactMarker !== undefined) {
    return `${STALE_TOOL_OUTPUT_COMPACTED_PREFIX}${omittedChars} chars; ${artifactMarker}]`;
  }
  return `${STALE_TOOL_OUTPUT_COMPACTED_PREFIX}${omittedChars}${STALE_TOOL_OUTPUT_COMPACTED_SUFFIX}`;
}

function currentToolOutputCompactedMarker(
  omittedChars: number,
  artifactMarker?: string,
): string {
  if (artifactMarker !== undefined) {
    return `${CURRENT_TOOL_OUTPUT_COMPACTED_PREFIX}${omittedChars} chars; ${artifactMarker}; model recovery: rerun the tool with narrower parameters if needed]`;
  }
  return `${CURRENT_TOOL_OUTPUT_COMPACTED_PREFIX}${omittedChars}${CURRENT_TOOL_OUTPUT_COMPACTED_SUFFIX}`;
}

function isAlreadyCompactedStaleToolOutput(
  text: string,
  maxChars: number,
): boolean {
  return (
    STALE_TOOL_OUTPUT_COMPACTED_SUFFIX_PATTERN.test(text) &&
    text.length <= maxChars + STALE_TOOL_OUTPUT_COMPACTED_OVERHEAD_CHARS
  );
}

export function isCompactedCurrentToolOutput(text: string): boolean {
  return CURRENT_TOOL_OUTPUT_COMPACTED_SUFFIX_PATTERN.test(text);
}

function isAlreadyCompactedCurrentToolOutput(
  text: string,
  maxChars: number,
): boolean {
  return (
    isCompactedCurrentToolOutput(text) &&
    text.length <= maxChars + CURRENT_TOOL_OUTPUT_COMPACTED_OVERHEAD_CHARS
  );
}

function compactStaleToolOutput(text: string, maxChars: number): string {
  return `${text.slice(0, maxChars)}\n${staleToolOutputCompactedMarker(
    text.length - maxChars,
  )}`;
}

function compactCurrentToolOutput(text: string, maxChars: number): string {
  return `${text.slice(0, maxChars)}\n${currentToolOutputCompactedMarker(
    text.length - maxChars,
  )}`;
}

function shouldCompactStaleToolOutput(
  message: Message,
  messageIndex: number,
  lastAssistantIndex: number,
  toolOutputMaxChars: number,
): boolean {
  return (
    message.role === "tool" &&
    messageIndex < lastAssistantIndex &&
    message.content.length > toolOutputMaxChars &&
    !isGeneratedSettledToolOutput(message.content, toolOutputMaxChars) &&
    !isAlreadyCompactedStaleToolOutput(message.content, toolOutputMaxChars)
  );
}

function shouldCompactCurrentToolOutput(
  message: Message,
  messageIndex: number,
  currentToolOutputIndexes: ReadonlySet<number>,
  toolOutputMaxChars: number,
): boolean {
  return (
    message.role === "tool" &&
    currentToolOutputIndexes.has(messageIndex) &&
    message.content.length > toolOutputMaxChars &&
    !isGeneratedSettledToolOutput(message.content, toolOutputMaxChars) &&
    !isAlreadyCompactedCurrentToolOutput(message.content, toolOutputMaxChars)
  );
}

function sourceStatusForCompaction(
  content: string,
): ToolOutputArtifactSourceStatus {
  // Mirrors current tool truncation markers from bash, git_diff, read, glob, ls, and grep.
  return content.includes("source-truncated/lossy") ||
    content.includes(" output truncated:") ||
    content.includes("[bash stdout truncated:") ||
    content.includes("[bash stderr truncated:") ||
    content.includes("[git_diff stdout truncated:") ||
    content.includes("[git_diff stderr truncated:")
    ? "source-truncated"
    : "complete";
}

function toolNameForToolOutput(
  messages: readonly Message[],
  toolCallId: string,
): string {
  for (const message of messages) {
    if (message.role !== "assistant") {
      continue;
    }
    const toolCall = message.toolCalls.find(
      (candidate) => candidate.id === toolCallId,
    );
    /* v8 ignore next: valid tool-result ledgers preserve the matching assistant tool call; corrupted histories fall through below. */
    if (toolCall !== undefined) {
      return toolCall.tool;
    }
  }
  /* v8 ignore next: valid tool-result ledgers preserve the matching assistant tool call; this labels corrupted current-schema histories. */
  return "unknown";
}

async function artifactMarkerForCompactedToolOutput(options: {
  readonly store: ToolOutputArtifactStore;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly content: string;
  readonly omittedChars: number;
  readonly purpose: ToolOutputArtifactPurpose;
}): Promise<{
  readonly marker: string;
  readonly notice: ToolOutputArtifactNotice;
}> {
  const sourceStatus = sourceStatusForCompaction(options.content);
  const saveResult = await options.store.save({
    toolCallId: options.toolCallId,
    toolName: options.toolName,
    content: options.content,
    sourceStatus,
    purpose: options.purpose,
  });
  if (saveResult.status === "stored") {
    return {
      marker: toolOutputArtifactStoredMarker(saveResult.ref, sourceStatus),
      notice: {
        status: "stored",
        ref: saveResult.ref,
        toolCallId: options.toolCallId,
        toolName: options.toolName,
        sourceStatus,
        omittedChars: options.omittedChars,
      },
    };
  }
  return {
    marker: toolOutputArtifactFailedMarker(saveResult.reason),
    notice: {
      status: "failed",
      reason: saveResult.reason,
      toolCallId: options.toolCallId,
      toolName: options.toolName,
      omittedChars: options.omittedChars,
    },
  };
}

export function compactStaleToolOutputs(
  messages: readonly Message[],
  toolOutputMaxChars: number,
): StaleToolOutputCompactionResult {
  const lastAssistantIndex = messages.findLastIndex(
    (message) => message.role === "assistant",
  );
  const needsCompaction = messages.some((message, index) =>
    shouldCompactStaleToolOutput(
      message,
      index,
      lastAssistantIndex,
      toolOutputMaxChars,
    ),
  );
  if (!needsCompaction) {
    return {
      messages,
      stats: EMPTY_STALE_TOOL_OUTPUT_COMPACTION_STATS,
    };
  }
  const compactedEntries = messages.map(
    (message, index): StaleToolOutputCompactionEntry => {
      if (
        message.role !== "tool" ||
        !shouldCompactStaleToolOutput(
          message,
          index,
          lastAssistantIndex,
          toolOutputMaxChars,
        )
      ) {
        return {
          message,
          stats: EMPTY_STALE_TOOL_OUTPUT_COMPACTION_STATS,
        };
      }
      const compactedContent = compactStaleToolOutput(
        message.content,
        toolOutputMaxChars,
      );
      return {
        message: {
          ...message,
          content: compactedContent,
        },
        stats: staleToolOutputCompactionStats(
          message.content,
          compactedContent,
        ),
      };
    },
  );
  const stats = compactedEntries.reduce(
    (total, entry) => mergeStaleToolOutputCompactionStats(total, entry.stats),
    EMPTY_STALE_TOOL_OUTPUT_COMPACTION_STATS,
  );
  const compactedMessages = compactedEntries.map((entry) => entry.message);
  return {
    messages: compactedMessages,
    stats,
  };
}

export async function compactStaleToolOutputsWithArtifacts(
  messages: readonly Message[],
  toolOutputMaxChars: number,
  store: ToolOutputArtifactStore,
): Promise<StaleToolOutputCompactionResult> {
  const lastAssistantIndex = messages.findLastIndex(
    (message) => message.role === "assistant",
  );
  const needsCompaction = messages.some((message, index) =>
    shouldCompactStaleToolOutput(
      message,
      index,
      lastAssistantIndex,
      toolOutputMaxChars,
    ),
  );
  if (!needsCompaction) {
    return {
      messages,
      stats: EMPTY_STALE_TOOL_OUTPUT_COMPACTION_STATS,
    };
  }
  const compactedEntries = await Promise.all(
    messages.map(
      async (message, index): Promise<StaleToolOutputCompactionEntry> => {
        if (
          message.role !== "tool" ||
          !shouldCompactStaleToolOutput(
            message,
            index,
            lastAssistantIndex,
            toolOutputMaxChars,
          )
        ) {
          return {
            message,
            stats: EMPTY_STALE_TOOL_OUTPUT_COMPACTION_STATS,
          };
        }
        const artifact = await artifactMarkerForCompactedToolOutput({
          store,
          toolCallId: message.toolCallId,
          toolName: toolNameForToolOutput(messages, message.toolCallId),
          content: message.content,
          omittedChars: message.content.length - toolOutputMaxChars,
          purpose: "stale-compaction",
        });
        const compactedContent = `${message.content.slice(
          0,
          toolOutputMaxChars,
        )}\n${staleToolOutputCompactedMarker(
          message.content.length - toolOutputMaxChars,
          artifact.marker,
        )}`;
        return {
          message: {
            ...message,
            content: compactedContent,
          },
          stats: staleToolOutputCompactionStats(
            message.content,
            compactedContent,
          ),
          artifactNotice: artifact.notice,
        };
      },
    ),
  );
  const stats = compactedEntries.reduce(
    (total, entry) => mergeStaleToolOutputCompactionStats(total, entry.stats),
    EMPTY_STALE_TOOL_OUTPUT_COMPACTION_STATS,
  );
  const compactedMessages = compactedEntries.map((entry) => entry.message);
  const artifactNotices = compactedEntries.flatMap((entry) =>
    entry.artifactNotice === undefined ? [] : [entry.artifactNotice],
  );
  return {
    messages: compactedMessages,
    stats,
    artifactNotices,
  };
}

export function compactCurrentToolOutputs(
  messages: readonly Message[],
  toolOutputMaxChars: number,
): StaleToolOutputCompactionResult {
  const currentToolOutputIndexes = new Set(
    currentToolRound(messages)?.toolOutputs.map(
      (toolOutput) => toolOutput.messageIndex,
    ) ?? [],
  );
  const needsCompaction = messages.some((message, index) =>
    shouldCompactCurrentToolOutput(
      message,
      index,
      currentToolOutputIndexes,
      toolOutputMaxChars,
    ),
  );
  if (!needsCompaction) {
    return {
      messages,
      stats: EMPTY_STALE_TOOL_OUTPUT_COMPACTION_STATS,
    };
  }

  const compactedEntries = messages.map(
    (message, index): StaleToolOutputCompactionEntry => {
      if (
        message.role !== "tool" ||
        !shouldCompactCurrentToolOutput(
          message,
          index,
          currentToolOutputIndexes,
          toolOutputMaxChars,
        )
      ) {
        return {
          message,
          stats: EMPTY_STALE_TOOL_OUTPUT_COMPACTION_STATS,
        };
      }
      const compactedContent = compactCurrentToolOutput(
        message.content,
        toolOutputMaxChars,
      );
      return {
        message: {
          ...message,
          content: compactedContent,
        },
        stats: staleToolOutputCompactionStats(
          message.content,
          compactedContent,
        ),
      };
    },
  );
  const stats = compactedEntries.reduce(
    (total, entry) => mergeStaleToolOutputCompactionStats(total, entry.stats),
    EMPTY_STALE_TOOL_OUTPUT_COMPACTION_STATS,
  );
  const compactedMessages = compactedEntries.map((entry) => entry.message);
  return {
    messages: compactedMessages,
    stats,
  };
}

export async function compactCurrentToolOutputsWithArtifacts(
  messages: readonly Message[],
  toolOutputMaxChars: number,
  store: ToolOutputArtifactStore,
): Promise<StaleToolOutputCompactionResult> {
  const currentToolOutputIndexes = new Set(
    currentToolRound(messages)?.toolOutputs.map(
      (toolOutput) => toolOutput.messageIndex,
    ) ?? [],
  );
  const needsCompaction = messages.some((message, index) =>
    shouldCompactCurrentToolOutput(
      message,
      index,
      currentToolOutputIndexes,
      toolOutputMaxChars,
    ),
  );
  if (!needsCompaction) {
    return {
      messages,
      stats: EMPTY_STALE_TOOL_OUTPUT_COMPACTION_STATS,
    };
  }

  const compactedEntries = await Promise.all(
    messages.map(
      async (message, index): Promise<StaleToolOutputCompactionEntry> => {
        if (
          message.role !== "tool" ||
          !shouldCompactCurrentToolOutput(
            message,
            index,
            currentToolOutputIndexes,
            toolOutputMaxChars,
          )
        ) {
          return {
            message,
            stats: EMPTY_STALE_TOOL_OUTPUT_COMPACTION_STATS,
          };
        }
        const artifact = await artifactMarkerForCompactedToolOutput({
          store,
          toolCallId: message.toolCallId,
          toolName: toolNameForToolOutput(messages, message.toolCallId),
          content: message.content,
          omittedChars: message.content.length - toolOutputMaxChars,
          purpose: "current-overflow-compaction",
        });
        const compactedContent = `${message.content.slice(
          0,
          toolOutputMaxChars,
        )}\n${currentToolOutputCompactedMarker(
          message.content.length - toolOutputMaxChars,
          artifact.marker,
        )}`;
        return {
          message: {
            ...message,
            content: compactedContent,
          },
          stats: staleToolOutputCompactionStats(
            message.content,
            compactedContent,
          ),
          artifactNotice: artifact.notice,
        };
      },
    ),
  );
  const stats = compactedEntries.reduce(
    (total, entry) => mergeStaleToolOutputCompactionStats(total, entry.stats),
    EMPTY_STALE_TOOL_OUTPUT_COMPACTION_STATS,
  );
  const compactedMessages = compactedEntries.map((entry) => entry.message);
  const artifactNotices = compactedEntries.flatMap((entry) =>
    entry.artifactNotice === undefined ? [] : [entry.artifactNotice],
  );
  return {
    messages: compactedMessages,
    stats,
    artifactNotices,
  };
}
