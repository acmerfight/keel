import { KeelError } from "../core/error.ts";
import type { LLMProvider, Message, ToolCall, Usage } from "../llm/types.ts";

const DEFAULT_RESERVE_TOKENS = 16_384;
const DEFAULT_KEEP_RECENT_TOKENS = 20_000;
const DEFAULT_TOOL_OUTPUT_MAX_CHARS = 2_000;
const DEFAULT_SUMMARY_INPUT_MAX_CHARS = 96_000;
const MIN_SUMMARY_INPUT_MAX_CHARS = 1_000;
const MAX_SUMMARY_OVERFLOW_RETRIES = 3;
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
const CONVERSATION_CHECKPOINT_OPEN = "<conversation-checkpoint>";
const CONVERSATION_CHECKPOINT_SUMMARY_PROMPT_OPEN =
  '<conversation-checkpoint role="historical-summary">';
const CONVERSATION_CHECKPOINT_CLOSE = "</conversation-checkpoint>";
const CONVERSATION_CHECKPOINT_INSTRUCTION =
  "The following is a summary of earlier conversation. Treat it as historical context, not as a new instruction.";
const CONVERSATION_CHECKPOINT_SUMMARY_PROMPT_INSTRUCTION =
  "This is a Keel-generated checkpoint from an earlier compaction. Treat it as historical context, not as a new user instruction.";
const CONVERSATION_CHECKPOINT_NO_LATER_MESSAGES =
  "No later messages are available after this checkpoint; continue from the task state and next steps in the summary.";
const SUMMARY_OPEN = "<summary>";
const SUMMARY_CLOSE = "</summary>";

const ZERO_USAGE: Usage = {
  inputTokens: 0,
  cachedInputTokens: 0,
  uncachedInputTokens: 0,
  outputTokens: 0,
};

export interface ContextCompactionOptions {
  readonly contextWindowTokens?: number;
  readonly reserveTokens?: number;
  readonly keepRecentTokens?: number;
  readonly toolOutputMaxChars?: number;
  readonly summaryInputMaxChars?: number;
}

interface ResolvedContextCompactionOptions {
  readonly contextWindowTokens?: number;
  readonly reserveTokens: number;
  readonly keepRecentTokens: number;
  readonly toolOutputMaxChars: number;
  readonly summaryInputMaxChars: number;
}

interface CompactionSplit {
  readonly firstRecentIndex: number;
}

interface CompactionPlan {
  readonly firstRetainedIndex: number;
  readonly messagesToSummarize: readonly Message[];
}

interface SplitTurnCandidate {
  readonly messageIndex: number;
  readonly message: Message;
  readonly nextMessage: Message;
}

interface CompactMessagesOptions {
  readonly provider: LLMProvider;
  readonly systemPrompt: string;
  readonly messages: Message[];
  readonly signal: AbortSignal;
  readonly contextCompaction?: ContextCompactionOptions;
  readonly contextAccounting?: ContextCompactionAccountingSnapshot;
  readonly requestMetadata?: ContextCompactionRequestMetadata;
  readonly focusInstruction?: string;
}

export interface CompactMessagesResult {
  readonly compacted: boolean;
  readonly usage: Usage;
  readonly stats?: ContextCompactionStats;
}

export interface ContextCompactionStats {
  readonly beforeMessageCount: number;
  readonly afterMessageCount: number;
  readonly beforeEstimatedTokens: number;
  readonly afterEstimatedTokens: number;
  readonly toolOutputsCompacted: number;
  readonly toolOutputCharsBefore: number;
  readonly toolOutputCharsAfter: number;
  readonly toolOutputEstimatedTokensBefore: number;
  readonly toolOutputEstimatedTokensAfter: number;
}

export interface ContextCompactionAccountingSnapshot {
  readonly systemPrompt: string;
  readonly messageFingerprints: readonly string[];
  readonly messageFingerprintCache?: readonly MessageFingerprintCache[];
  readonly requestMetadata: ResolvedContextCompactionRequestMetadata;
  readonly inputTokens: number;
}

export interface ContextCompactionRequestMetadata {
  readonly toolChoice?: "none";
  readonly allowBash?: boolean;
}

interface ResolvedContextCompactionRequestMetadata {
  readonly toolChoice: "auto" | "none";
  readonly allowBash: boolean;
}

interface TextOnlyTurn {
  readonly text: string;
  readonly usage: Usage;
}

interface ConversationCheckpoint {
  readonly summary: string;
  readonly noLaterMessages: boolean;
}

interface StaleToolOutputCompactionStats {
  readonly toolOutputsCompacted: number;
  readonly toolOutputCharsBefore: number;
  readonly toolOutputCharsAfter: number;
  readonly toolOutputEstimatedTokensBefore: number;
  readonly toolOutputEstimatedTokensAfter: number;
}

type ToolCallFingerprintPart = string | number | boolean | null;

interface ToolCallFingerprintCache {
  readonly parts: readonly ToolCallFingerprintPart[];
}

interface CapturedToolCallFingerprint {
  readonly cache: ToolCallFingerprintCache;
  readonly fingerprint: string;
}

type MessageFingerprintCache =
  | {
      readonly role: "user";
      readonly content: string;
      readonly fingerprint: string;
    }
  | {
      readonly role: "assistant";
      readonly content: string;
      readonly toolCalls: readonly ToolCallFingerprintCache[];
      readonly fingerprint: string;
    }
  | {
      readonly role: "tool";
      readonly toolCallId: string;
      readonly content: string;
      readonly fingerprint: string;
    };

interface StaleToolOutputCompactionResult {
  readonly messages: readonly Message[];
  readonly stats: StaleToolOutputCompactionStats;
}

interface StaleToolOutputCompactionEntry {
  readonly message: Message;
  readonly stats: StaleToolOutputCompactionStats;
}

interface BuildCompactedMessagesResult {
  readonly messages: readonly Message[];
  readonly staleToolOutputStats: StaleToolOutputCompactionStats;
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

function resolveContextCompactionOptions(
  options: ContextCompactionOptions | undefined,
): ResolvedContextCompactionOptions {
  const base = {
    reserveTokens: options?.reserveTokens ?? DEFAULT_RESERVE_TOKENS,
    keepRecentTokens: options?.keepRecentTokens ?? DEFAULT_KEEP_RECENT_TOKENS,
    toolOutputMaxChars:
      options?.toolOutputMaxChars ?? DEFAULT_TOOL_OUTPUT_MAX_CHARS,
    summaryInputMaxChars:
      options?.summaryInputMaxChars ?? DEFAULT_SUMMARY_INPUT_MAX_CHARS,
  };
  if (options?.contextWindowTokens === undefined) {
    return base;
  }

  const summaryContextBudgetChars = Math.max(
    MIN_SUMMARY_INPUT_MAX_CHARS,
    Math.max(1, options.contextWindowTokens - base.reserveTokens) * 3,
  );
  return {
    ...base,
    contextWindowTokens: options.contextWindowTokens,
    summaryInputMaxChars: Math.min(
      base.summaryInputMaxChars,
      summaryContextBudgetChars,
    ),
  };
}

function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function normalizeCheckpointSummary(summary: string): string {
  const trimmed = summary.trim();
  const fallback = trimmed === "" ? "(no summary available)" : trimmed;
  return escapeCheckpointStructuralTags(fallback);
}

function escapeCheckpointStructuralTags(text: string): string {
  return text
    .replaceAll("<conversation-checkpoint", "&lt;conversation-checkpoint")
    .replaceAll(
      CONVERSATION_CHECKPOINT_CLOSE,
      "&lt;/conversation-checkpoint&gt;",
    )
    .replaceAll(SUMMARY_OPEN, "&lt;summary&gt;")
    .replaceAll(SUMMARY_CLOSE, "&lt;/summary&gt;");
}

function renderConversationCheckpointBlock(options: {
  readonly openTag: string;
  readonly instruction: string;
  readonly checkpoint: ConversationCheckpoint;
}): string {
  return [
    options.openTag,
    options.instruction,
    options.checkpoint.noLaterMessages
      ? CONVERSATION_CHECKPOINT_NO_LATER_MESSAGES
      : "",
    SUMMARY_OPEN,
    options.checkpoint.summary,
    SUMMARY_CLOSE,
    CONVERSATION_CHECKPOINT_CLOSE,
  ]
    .filter((part) => part !== "")
    .join("\n");
}

function renderConversationCheckpoint(
  checkpoint: ConversationCheckpoint,
): string {
  return renderConversationCheckpointBlock({
    openTag: CONVERSATION_CHECKPOINT_OPEN,
    instruction: CONVERSATION_CHECKPOINT_INSTRUCTION,
    checkpoint,
  });
}

function parseConversationCheckpointMessage(
  message: Extract<Message, { readonly role: "user" }>,
): ConversationCheckpoint | null {
  const lines = message.content.split("\n");
  if (
    lines.length < 5 ||
    lines[0] !== CONVERSATION_CHECKPOINT_OPEN ||
    lines[1] !== CONVERSATION_CHECKPOINT_INSTRUCTION ||
    lines.at(-2) !== SUMMARY_CLOSE ||
    lines.at(-1) !== CONVERSATION_CHECKPOINT_CLOSE
  ) {
    return null;
  }

  const noLaterMessages =
    lines[2] === CONVERSATION_CHECKPOINT_NO_LATER_MESSAGES;
  // The optional no-later marker is generated only before <summary>, so this
  // positional check distinguishes exact Keel checkpoints from user XML text.
  const summaryOpenIndex = noLaterMessages ? 3 : 2;
  if (lines[summaryOpenIndex] !== SUMMARY_OPEN) {
    return null;
  }
  const summary = lines.slice(summaryOpenIndex + 1, -2).join("\n");
  if (summary !== normalizeCheckpointSummary(summary)) {
    return null;
  }

  return {
    summary,
    noLaterMessages,
  };
}

function serializeCheckpointForSummaryPrompt(
  checkpoint: ConversationCheckpoint,
): string {
  return renderConversationCheckpointBlock({
    openTag: CONVERSATION_CHECKPOINT_SUMMARY_PROMPT_OPEN,
    instruction: CONVERSATION_CHECKPOINT_SUMMARY_PROMPT_INSTRUCTION,
    checkpoint,
  });
}

function estimateToolCallTokens(toolCall: ToolCall): number {
  return estimateTextTokens(JSON.stringify(toolCall));
}

function estimateMessageTokens(message: Message): number {
  const roleOverhead = 4;
  switch (message.role) {
    case "user":
      return roleOverhead + estimateTextTokens(message.content);
    case "assistant":
      return (
        roleOverhead +
        estimateTextTokens(message.content) +
        (message.toolCalls ?? []).reduce(
          (total, toolCall) => total + estimateToolCallTokens(toolCall),
          0,
        )
      );
    case "tool":
      return roleOverhead + estimateTextTokens(message.content);
  }
}

function estimateMessagesTokens(messages: readonly Message[]): number {
  return messages.reduce(
    (total, message) => total + estimateMessageTokens(message),
    0,
  );
}

function resolvedRequestMetadata(
  metadata: ContextCompactionRequestMetadata | undefined,
): ResolvedContextCompactionRequestMetadata {
  const toolChoice = metadata?.toolChoice ?? "auto";
  return {
    toolChoice,
    allowBash: toolChoice === "none" ? false : metadata?.allowBash === true,
  };
}

function toolCallFingerprintParts(
  toolCall: ToolCall,
): readonly ToolCallFingerprintPart[] {
  switch (toolCall.tool) {
    case "read":
      return [
        toolCall.id,
        toolCall.tool,
        toolCall.path,
        toolCall.offset ?? null,
        toolCall.limit ?? null,
      ];
    case "grep":
      return [
        toolCall.id,
        toolCall.tool,
        toolCall.pattern,
        toolCall.path ?? null,
      ];
    case "edit":
      return [
        toolCall.id,
        toolCall.tool,
        toolCall.path,
        toolCall.oldString,
        toolCall.newString,
        toolCall.replaceAll ?? null,
      ];
    case "write":
      return [toolCall.id, toolCall.tool, toolCall.path, toolCall.content];
    case "bash":
      return [
        toolCall.id,
        toolCall.tool,
        toolCall.command,
        toolCall.timeoutMs ?? null,
      ];
  }
  /* v8 ignore start: compile-time exhaustiveness guard for future tools. */
  const exhaustive: never = toolCall;
  return exhaustive;
  /* v8 ignore stop */
}

function toolCallFingerprint(toolCall: ToolCall): string {
  return JSON.stringify(toolCallFingerprintParts(toolCall));
}

function captureToolCallFingerprint(
  toolCall: ToolCall,
): CapturedToolCallFingerprint {
  const parts = toolCallFingerprintParts(toolCall);
  return {
    cache: { parts },
    fingerprint: JSON.stringify(parts),
  };
}

function toolCallMatchesFingerprintCache(
  toolCall: ToolCall,
  cache: ToolCallFingerprintCache,
): boolean {
  const parts = toolCallFingerprintParts(toolCall);
  return (
    parts.length === cache.parts.length &&
    parts.every((part, index) => part === cache.parts[index])
  );
}

function messageFingerprint(message: Message): string {
  switch (message.role) {
    case "user":
      return JSON.stringify([message.role, message.content]);
    case "assistant":
      return JSON.stringify([
        message.role,
        message.content,
        (message.toolCalls ?? []).map(toolCallFingerprint),
      ]);
    case "tool":
      return JSON.stringify([
        message.role,
        message.toolCallId,
        message.content,
      ]);
  }
}

function captureMessageFingerprintCache(
  message: Message,
): MessageFingerprintCache {
  switch (message.role) {
    case "user":
      return {
        role: message.role,
        content: message.content,
        fingerprint: JSON.stringify([message.role, message.content]),
      };
    case "assistant": {
      const toolCalls = (message.toolCalls ?? []).map(
        captureToolCallFingerprint,
      );
      return {
        role: message.role,
        content: message.content,
        toolCalls: toolCalls.map((toolCall) => toolCall.cache),
        fingerprint: JSON.stringify([
          message.role,
          message.content,
          toolCalls.map((toolCall) => toolCall.fingerprint),
        ]),
      };
    }
    case "tool":
      return {
        role: message.role,
        toolCallId: message.toolCallId,
        content: message.content,
        fingerprint: JSON.stringify([
          message.role,
          message.toolCallId,
          message.content,
        ]),
      };
  }
}

function cachedMessageFingerprint(
  message: Message,
  cache: MessageFingerprintCache | undefined,
): string {
  if (cache === undefined) {
    return messageFingerprint(message);
  }

  switch (message.role) {
    case "user":
      return cache.role === "user" && cache.content === message.content
        ? cache.fingerprint
        : messageFingerprint(message);
    case "assistant": {
      if (cache.role !== "assistant") {
        return messageFingerprint(message);
      }
      const toolCalls = message.toolCalls ?? [];
      const toolCallCaches = cache.toolCalls;
      if (
        cache.content === message.content &&
        toolCalls.length === toolCallCaches.length &&
        toolCalls.every((toolCall, index) => {
          const toolCallCache = toolCallCaches[index];
          return (
            toolCallCache !== undefined &&
            toolCallMatchesFingerprintCache(toolCall, toolCallCache)
          );
        })
      ) {
        return cache.fingerprint;
      }
      return messageFingerprint(message);
    }
    case "tool":
      return cache.role === "tool" &&
        cache.toolCallId === message.toolCallId &&
        cache.content === message.content
        ? cache.fingerprint
        : messageFingerprint(message);
  }
}

function estimateRequestTokens(
  systemPrompt: string,
  messages: readonly Message[],
  accounting?: ContextCompactionAccountingSnapshot,
  metadata?: ContextCompactionRequestMetadata,
): number {
  const accountedTokens = estimateRequestTokensFromAccounting(
    systemPrompt,
    messages,
    accounting,
    metadata,
  );
  if (accountedTokens !== null) {
    return accountedTokens;
  }
  return estimateTextTokens(systemPrompt) + estimateMessagesTokens(messages);
}

function estimateRequestTokensFromAccounting(
  systemPrompt: string,
  messages: readonly Message[],
  accounting: ContextCompactionAccountingSnapshot | undefined,
  metadata: ContextCompactionRequestMetadata | undefined,
): number | null {
  const currentMetadata = resolvedRequestMetadata(metadata);
  if (
    accounting === undefined ||
    accounting.systemPrompt !== systemPrompt ||
    accounting.requestMetadata.toolChoice !== currentMetadata.toolChoice ||
    accounting.requestMetadata.allowBash !== currentMetadata.allowBash ||
    accounting.messageFingerprints.length > messages.length
  ) {
    return null;
  }

  for (const [
    index,
    accountedFingerprint,
  ] of accounting.messageFingerprints.entries()) {
    const message = messages[index];
    if (
      message === undefined ||
      cachedMessageFingerprint(
        message,
        accounting.messageFingerprintCache?.[index],
      ) !== accountedFingerprint
    ) {
      return null;
    }
  }

  return (
    accounting.inputTokens +
    estimateMessagesTokens(
      messages.slice(accounting.messageFingerprints.length),
    )
  );
}

function isUsableInputTokenCount(inputTokens: number): boolean {
  return Number.isSafeInteger(inputTokens) && inputTokens > 0;
}

export function captureContextCompactionAccountingSnapshot(options: {
  readonly systemPrompt: string;
  readonly messages: readonly Message[];
  readonly usage: Usage;
  readonly requestMetadata?: ContextCompactionRequestMetadata;
}): ContextCompactionAccountingSnapshot | undefined {
  if (!isUsableInputTokenCount(options.usage.inputTokens)) {
    return undefined;
  }
  const messageFingerprintCache = options.messages.map(
    captureMessageFingerprintCache,
  );
  return {
    systemPrompt: options.systemPrompt,
    // Provider usage only maps clearly to the exact completed request shape.
    // Store stable fingerprints and field-level cache metadata so later checks
    // detect mutations without rebuilding unchanged historical fingerprints.
    messageFingerprints: messageFingerprintCache.map(
      (cache) => cache.fingerprint,
    ),
    messageFingerprintCache,
    requestMetadata: resolvedRequestMetadata(options.requestMetadata),
    inputTokens: options.usage.inputTokens,
  };
}

export function shouldCompactBeforeRequest(
  systemPrompt: string,
  messages: readonly Message[],
  options: ContextCompactionOptions | undefined,
  accounting?: ContextCompactionAccountingSnapshot,
  metadata?: ContextCompactionRequestMetadata,
): boolean {
  const resolved = resolveContextCompactionOptions(options);
  if (resolved.contextWindowTokens === undefined) {
    return false;
  }
  return (
    estimateRequestTokens(systemPrompt, messages, accounting, metadata) >
    resolved.contextWindowTokens - resolved.reserveTokens
  );
}

function canSplitAfter(
  message: Message,
  nextMessage: Message | undefined,
): boolean {
  if (message.role === "user") {
    return false;
  }
  if (message.role === "assistant" && (message.toolCalls ?? []).length > 0) {
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

function selectCompactionSplit(
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

function currentToolOutputSuffixStart(
  messages: readonly Message[],
): number | null {
  const toolRequestIndex = messages.findLastIndex(
    (message) => message.role === "assistant",
  );
  const toolRequest = messages[toolRequestIndex];
  if (
    toolRequest?.role !== "assistant" ||
    (toolRequest.toolCalls ?? []).length === 0
  ) {
    return null;
  }

  if (messages[toolRequestIndex + 1]?.role !== "tool") {
    return null;
  }

  for (
    let messageIndex = toolRequestIndex - 1;
    messageIndex >= 0;
    messageIndex--
  ) {
    if (messages[messageIndex]?.role === "user") {
      return messageIndex;
    }
  }
  return toolRequestIndex;
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
  if (message.role === "assistant" && (message.toolCalls ?? []).length > 0) {
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
  const protectedSuffixStart = currentToolOutputSuffixStart(messages);
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
  const protectedSuffixStart = currentToolOutputSuffixStart(messages);
  return protectedSuffixStart !== null &&
    firstRetainedIndex > protectedSuffixStart
    ? protectedSuffixStart
    : firstRetainedIndex;
}

function planCompaction(
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
  /* v8 ignore next 5: compactStaleToolOutputs is a content-only rewrite. */
  if (compactedRecent.length !== recentMessages.length) {
    throw new Error(
      "Stale tool output compaction must preserve message count and order",
    );
  }
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

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}\n[truncated ${text.length - maxChars} chars]`;
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

function compactStaleToolOutputs(
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

function serializeMessage(
  message: Message,
  toolOutputMaxChars: number,
): string {
  switch (message.role) {
    case "user": {
      const checkpoint = parseConversationCheckpointMessage(message);
      if (checkpoint !== null) {
        return serializeCheckpointForSummaryPrompt(checkpoint);
      }
      return `<message role="user">\n${message.content}\n</message>`;
    }
    case "assistant": {
      const toolCalls = message.toolCalls ?? [];
      const toolCallText =
        toolCalls.length === 0
          ? ""
          : `\n<tool-calls>\n${JSON.stringify(toolCalls)}\n</tool-calls>`;
      return `<message role="assistant">\n${message.content}${toolCallText}\n</message>`;
    }
    case "tool":
      return `<message role="tool" tool_call_id="${message.toolCallId}">\n${truncateText(
        message.content,
        toolOutputMaxChars,
      )}\n</message>`;
  }
}

function buildSummaryPrompt(
  messages: readonly Message[],
  options: ResolvedContextCompactionOptions,
  summaryInputMaxChars = options.summaryInputMaxChars,
  focusInstruction?: string,
): string {
  const normalizedFocusInstruction =
    normalizeFocusInstruction(focusInstruction);
  const selected = selectSummaryInput(
    messages.map((message) =>
      serializeMessage(message, options.toolOutputMaxChars),
    ),
    summaryInputMaxChars,
  );
  const promptParts = [
    "Create a compact checkpoint summary for an ongoing coding-agent conversation.",
    "Do not call tools. Output concise Markdown only.",
    "Preserve exact file paths, commands, errors, user constraints, current task state, decisions, and next steps.",
  ];
  if (normalizedFocusInstruction !== undefined) {
    promptParts.push(
      `User manual compaction focus instruction:\n${normalizedFocusInstruction}`,
    );
  }
  promptParts.push(
    "Use these sections in order: Current Task, Constraints, Completed, In Progress, Relevant Files, Commands and Tests, Errors and Fixes, Next Steps.",
    "<conversation>",
  );
  if (selected.omittedCount > 0) {
    promptParts.push(
      `[${selected.omittedCount} older message(s) omitted to fit the compaction request]`,
    );
  }
  promptParts.push(selected.context, "</conversation>");
  return promptParts.join("\n\n");
}

function normalizeFocusInstruction(
  focusInstruction: string | undefined,
): string | undefined {
  const trimmed = focusInstruction?.trim();
  if (trimmed === undefined || trimmed === "") {
    return undefined;
  }
  return trimmed;
}

function selectSummaryInput(
  serializedMessages: readonly string[],
  maxChars: number,
): { readonly context: string; readonly omittedCount: number } {
  let remaining = Math.max(0, maxChars);
  const selected: string[] = [];

  const indexedMessages = Array.from(serializedMessages.entries()).reverse();
  for (const [index, message] of indexedMessages) {
    const separatorChars = selected.length === 0 ? 0 : 2;
    if (message.length + separatorChars <= remaining) {
      selected.push(message);
      remaining -= message.length + separatorChars;
      continue;
    }

    if (remaining > 200) {
      selected.push(
        `[earlier content in this message omitted]\n${message.slice(-remaining)}`,
      );
      selected.reverse();
      return { context: selected.join("\n\n"), omittedCount: index };
    }
    selected.reverse();
    return { context: selected.join("\n\n"), omittedCount: index + 1 };
  }

  selected.reverse();
  return { context: selected.join("\n\n"), omittedCount: 0 };
}

function buildCompactedMessages(
  messages: readonly Message[],
  firstRetainedIndex: number,
  summary: string,
  options: ResolvedContextCompactionOptions,
): BuildCompactedMessagesResult {
  const recent = compactStaleToolOutputs(
    messages.slice(firstRetainedIndex),
    options.toolOutputMaxChars,
  );
  const checkpoint = renderConversationCheckpoint({
    summary: normalizeCheckpointSummary(summary),
    noLaterMessages: recent.messages.length === 0,
  });
  return {
    messages: [
      {
        role: "user",
        content: checkpoint,
      },
      ...recent.messages,
    ],
    staleToolOutputStats: recent.stats,
  };
}

async function collectTextOnlyTurn(options: {
  readonly provider: LLMProvider;
  readonly systemPrompt: string;
  readonly messages: readonly Message[];
  readonly signal: AbortSignal;
}): Promise<TextOnlyTurn> {
  let text = "";
  let usage: Usage | null = null;
  for await (const event of options.provider.stream({
    systemPrompt: options.systemPrompt,
    messages: options.messages,
    signal: options.signal,
    toolChoice: "none",
  })) {
    switch (event.type) {
      case "text":
        text += event.text;
        break;
      case "tool_call":
        throw new KeelError(
          "provider_protocol_error",
          `${options.provider.id} returned a tool call during context compaction`,
        );
      case "provider_retry":
        break;
      case "stop":
        usage = event.usage;
        break;
    }
  }
  if (usage === null) {
    throw new KeelError(
      "agent_missing_stop",
      "LLM stream ended without stop event",
    );
  }
  return { text, usage };
}

function isProviderContextOverflow(error: unknown): boolean {
  return (
    error instanceof KeelError && error.code === "provider_context_overflow"
  );
}

async function collectCompactionSummary(options: {
  readonly provider: LLMProvider;
  readonly systemPrompt: string;
  readonly messagesToSummarize: readonly Message[];
  readonly signal: AbortSignal;
  readonly contextCompaction: ResolvedContextCompactionOptions;
  readonly focusInstruction?: string;
}): Promise<TextOnlyTurn> {
  let summaryInputMaxChars = options.contextCompaction.summaryInputMaxChars;

  let attempt = 0;
  while (true) {
    const prompt = buildSummaryPrompt(
      options.messagesToSummarize,
      options.contextCompaction,
      summaryInputMaxChars,
      options.focusInstruction,
    );
    try {
      return await collectTextOnlyTurn({
        provider: options.provider,
        systemPrompt: options.systemPrompt,
        messages: [{ role: "user", content: prompt }],
        signal: options.signal,
      });
    } catch (error) {
      if (!isProviderContextOverflow(error)) {
        throw error;
      }
      const reduced = Math.floor(summaryInputMaxChars / 2);
      if (
        attempt === MAX_SUMMARY_OVERFLOW_RETRIES ||
        reduced < MIN_SUMMARY_INPUT_MAX_CHARS
      ) {
        throw error;
      }
      attempt++;
      summaryInputMaxChars = reduced;
    }
  }
}

export async function compactMessages(
  options: CompactMessagesOptions,
): Promise<CompactMessagesResult> {
  const resolved = resolveContextCompactionOptions(options.contextCompaction);
  const beforeMessageCount = options.messages.length;
  const beforeEstimatedTokens = estimateRequestTokens(
    options.systemPrompt,
    options.messages,
    options.contextAccounting,
    options.requestMetadata,
  );

  const split = selectCompactionSplit(options.messages, {
    keepRecentTokens: resolved.keepRecentTokens,
  });
  if (split === null) {
    return { compacted: false, usage: ZERO_USAGE };
  }

  const plan = planCompaction(options.messages, split, resolved);
  if (plan.messagesToSummarize.length === 0) {
    // The protected current suffix starts at the beginning of the transcript.
    // Creating an empty checkpoint would only make the retry larger, so report
    // no compaction and allow overflow recovery to surface the provider error.
    return { compacted: false, usage: ZERO_USAGE };
  }

  const summaryTurn = await collectCompactionSummary({
    provider: options.provider,
    systemPrompt: options.systemPrompt,
    messagesToSummarize: plan.messagesToSummarize,
    signal: options.signal,
    contextCompaction: resolved,
    ...(options.focusInstruction !== undefined
      ? { focusInstruction: options.focusInstruction }
      : {}),
  });
  const compacted = buildCompactedMessages(
    options.messages,
    plan.firstRetainedIndex,
    summaryTurn.text,
    resolved,
  );
  options.messages.splice(0, options.messages.length, ...compacted.messages);
  return {
    compacted: true,
    usage: summaryTurn.usage,
    stats: {
      beforeMessageCount,
      afterMessageCount: options.messages.length,
      beforeEstimatedTokens,
      afterEstimatedTokens: estimateRequestTokens(
        options.systemPrompt,
        options.messages,
      ),
      ...compacted.staleToolOutputStats,
    },
  };
}
