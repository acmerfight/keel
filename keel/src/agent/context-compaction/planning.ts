import type { Message } from "../../llm/types.ts";
import { currentToolRound } from "./current-tool-round.ts";
import type { ResolvedContextCompactionOptions } from "./options.ts";
import { compactStaleToolOutputs } from "./stale-tool-output.ts";
import {
  estimateMessagesTokens,
  estimateMessageTokens,
} from "./token-accounting.ts";

export interface CompactionSplit {
  readonly firstRecentIndex: number;
}

export interface CompactionPlan {
  readonly firstRetainedIndex: number;
  readonly messagesToSummarize: readonly Message[];
}

interface SplitTurnCandidate {
  readonly messageIndex: number;
  readonly message: Message;
  readonly nextMessage: Message;
}

function canSplitAfter(
  message: Message,
  nextMessage: Message | undefined,
): boolean {
  if (message.role === "user") {
    return false;
  }
  if (message.role === "assistant" && message.toolCalls.length > 0) {
    return false;
  }
  return nextMessage?.role !== "tool";
}

function firstIndexWithRecentBudget(
  messages: readonly Message[],
  keepRecentTokens: number,
): number {
  let recentTokens = 0;
  const indexedMessages = Array.from(messages.entries()).reverse();
  for (const [index, message] of indexedMessages) {
    recentTokens += estimateMessageTokens(message);
    if (recentTokens >= keepRecentTokens) {
      return index;
    }
  }
  return 0;
}

export function selectCompactionSplit(
  messages: readonly Message[],
  options: { readonly keepRecentTokens: number },
): CompactionSplit | null {
  if (messages.length < 2) {
    return null;
  }

  const target = Math.max(
    1,
    firstIndexWithRecentBudget(messages, options.keepRecentTokens),
  );
  for (const [previousIndex, previousMessage] of messages.entries()) {
    const firstRecentIndex = previousIndex + 1;
    if (firstRecentIndex < target || firstRecentIndex >= messages.length) {
      continue;
    }
    if (canSplitAfter(previousMessage, messages[firstRecentIndex])) {
      return { firstRecentIndex };
    }
  }
  const indexedMessages = Array.from(messages.entries()).reverse();
  for (const [previousIndex, previousMessage] of indexedMessages) {
    const firstRecentIndex = previousIndex + 1;
    if (firstRecentIndex >= target) {
      continue;
    }
    if (canSplitAfter(previousMessage, messages[firstRecentIndex])) {
      return { firstRecentIndex };
    }
  }
  const lastMessage = messages[messages.length - 1];
  if (lastMessage !== undefined && canSplitAfter(lastMessage, undefined)) {
    return { firstRecentIndex: messages.length };
  }
  return null;
}

function canSplitTurnAfter(
  lastAssistantIndex: number,
  messageIndex: number,
  message: Message,
  nextMessage: Message,
): boolean {
  if (message.role === "user") {
    return nextMessage.role === "user";
  }
  if (message.role === "assistant" && message.toolCalls.length > 0) {
    return false;
  }
  if (message.role === "tool" && messageIndex >= lastAssistantIndex) {
    return false;
  }
  return nextMessage.role !== "tool";
}

function selectSplitTurnBoundary(
  messages: readonly Message[],
  keepRecentTokens: number,
): number | null {
  if (messages.length < 2) {
    return null;
  }

  const firstOverBudgetIndex = firstIndexWithRecentBudget(
    messages,
    keepRecentTokens,
  );
  const target = Math.min(
    messages.length - 1,
    Math.max(1, firstOverBudgetIndex + 1),
  );
  const protectedSuffixStart =
    currentToolRound(messages)?.instructionStartIndex ?? null;
  const maxBoundary = protectedSuffixStart ?? messages.length - 1;
  const lastAssistantIndex = messages.findLastIndex(
    (message) => message.role === "assistant",
  );
  const candidates: SplitTurnCandidate[] = messages.flatMap(
    (message, messageIndex) => {
      const nextMessage = messages[messageIndex + 1];
      return nextMessage === undefined
        ? []
        : [{ messageIndex, message, nextMessage }];
    },
  );
  const safeBoundaries: number[] = [];
  for (const { messageIndex, message, nextMessage } of candidates) {
    const boundary = messageIndex + 1;
    if (boundary > maxBoundary) {
      continue;
    }
    if (
      !canSplitTurnAfter(lastAssistantIndex, messageIndex, message, nextMessage)
    ) {
      continue;
    }
    safeBoundaries.push(boundary);
    if (boundary >= target) {
      return boundary;
    }
  }
  // Prefer preserving the newest actionable suffix over forcing the retained
  // suffix under keepRecentTokens. If every safe split is before the budget
  // target, keep the latest safe suffix verbatim and let overflow recovery
  // surface the provider overflow if it still cannot fit.
  return safeBoundaries.at(-1) ?? null;
}

function firstRetainedIndexPreservingCurrentToolOutput(
  messages: readonly Message[],
  firstRetainedIndex: number,
): number {
  const protectedSuffixStart =
    currentToolRound(messages)?.instructionStartIndex ?? null;
  return protectedSuffixStart !== null &&
    firstRetainedIndex > protectedSuffixStart
    ? protectedSuffixStart
    : firstRetainedIndex;
}

export function planCompaction(
  messages: readonly Message[],
  split: CompactionSplit,
  options: ResolvedContextCompactionOptions,
): CompactionPlan {
  const baseFirstRetainedIndex = firstRetainedIndexPreservingCurrentToolOutput(
    messages,
    split.firstRecentIndex,
  );
  const recentMessages = messages.slice(baseFirstRetainedIndex);
  const compactedRecent = compactStaleToolOutputs(
    recentMessages,
    options.toolOutputMaxChars,
  ).messages;
  const splitTurnBoundary =
    estimateMessagesTokens(compactedRecent) > options.keepRecentTokens
      ? selectSplitTurnBoundary(compactedRecent, options.keepRecentTokens)
      : null;
  const firstRetainedIndex = baseFirstRetainedIndex + (splitTurnBoundary ?? 0);
  return {
    firstRetainedIndex,
    messagesToSummarize: messages.slice(0, firstRetainedIndex),
  };
}

export function smallerCompactionPrefixMessageCount(
  messages: readonly Message[],
): number | null {
  const targetTokens = Math.max(
    1,
    Math.floor(estimateMessagesTokens(messages) / 2),
  );
  let prefixTokens = 0;
  let latestSafeBoundary: number | null = null;

  const prefixCandidates = messages.slice(0, -1);
  for (const [index, message] of prefixCandidates.entries()) {
    prefixTokens += estimateMessageTokens(message);
    if (!canSplitAfter(message, messages[index + 1])) {
      continue;
    }
    latestSafeBoundary = index + 1;
    if (prefixTokens >= targetTokens) {
      return latestSafeBoundary;
    }
  }

  return latestSafeBoundary;
}
