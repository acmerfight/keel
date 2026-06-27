import type { Message } from "../../llm/types.ts";
import { estimateTextTokens } from "./token-accounting.ts";

const STALE_TOOL_OUTPUT_COMPACTED_PREFIX =
  "[stale tool output compacted: approximately omitted ";
const STALE_TOOL_OUTPUT_COMPACTED_SUFFIX = " chars]";
const STALE_TOOL_OUTPUT_COMPACTED_SUFFIX_PATTERN =
  /\n\[stale tool output compacted: approximately omitted [0-9]+ chars\]$/;
const STALE_TOOL_OUTPUT_COMPACTED_OVERHEAD_CHARS =
  "\n".length +
  STALE_TOOL_OUTPUT_COMPACTED_PREFIX.length +
  String(Number.MAX_SAFE_INTEGER).length +
  STALE_TOOL_OUTPUT_COMPACTED_SUFFIX.length;

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
}

interface StaleToolOutputCompactionEntry {
  readonly message: Message;
  readonly stats: StaleToolOutputCompactionStats;
}

const EMPTY_STALE_TOOL_OUTPUT_COMPACTION_STATS: StaleToolOutputCompactionStats =
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

function mergeStaleToolOutputCompactionStats(
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

function staleToolOutputCompactedMarker(omittedChars: number): string {
  return `${STALE_TOOL_OUTPUT_COMPACTED_PREFIX}${omittedChars}${STALE_TOOL_OUTPUT_COMPACTED_SUFFIX}`;
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

function compactStaleToolOutput(text: string, maxChars: number): string {
  return `${text.slice(0, maxChars)}\n${staleToolOutputCompactedMarker(
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
    !isAlreadyCompactedStaleToolOutput(message.content, toolOutputMaxChars)
  );
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
