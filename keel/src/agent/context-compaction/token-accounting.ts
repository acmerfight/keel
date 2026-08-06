import type {
  AssistantProviderMetadata,
  ProviderMessage,
  ToolCall,
  Usage,
} from "../../llm/types.ts";
import {
  modelToolExposuresEqual,
  toolCallCanonicalArguments,
} from "../../tools/registry.ts";
import type { SessionMessage } from "../session-message.ts";
import type {
  ContextCompactionOptions,
  ContextCompactionRequestMetadata,
  ResolvedContextCompactionRequestMetadata,
} from "./options.ts";
import {
  resolveContextCompactionOptions,
  resolvedRequestMetadata,
} from "./options.ts";

type ContextMessage = ProviderMessage | SessionMessage;

interface ToolCallFingerprintCache {
  readonly id: string;
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
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
      readonly providerMetadata: AssistantProviderMetadata | null;
      readonly toolCalls: readonly ToolCallFingerprintCache[];
      readonly fingerprint: string;
    }
  | {
      readonly role: "tool";
      readonly toolCallId: string;
      readonly content: string;
      readonly fingerprint: string;
    };

export interface ContextCompactionAccountingSnapshot {
  readonly systemPrompt: string;
  readonly messageFingerprintCache: readonly MessageFingerprintCache[];
  readonly requestMetadata: ResolvedContextCompactionRequestMetadata;
  readonly inputTokens: number;
}

export interface ContextCompactionStats {
  readonly beforeMessageCount: number;
  readonly afterMessageCount: number;
  readonly beforeEstimatedTokens: number;
  readonly afterEstimatedTokens: number;
  readonly toolOutputsCompacted: number;
  readonly staleToolOutputsCompacted: number;
  readonly currentToolOutputsCompacted: number;
  readonly toolOutputCharsBefore: number;
  readonly toolOutputCharsAfter: number;
  readonly toolOutputEstimatedTokensBefore: number;
  readonly toolOutputEstimatedTokensAfter: number;
}

export function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function estimateToolCallTokens(toolCall: ToolCall): number {
  return estimateTextTokens(JSON.stringify(toolCall));
}

function estimateAssistantProviderMetadataTokens(
  providerMetadata: AssistantProviderMetadata | undefined,
): number {
  return estimateTextTokens(
    providerMetadata?.openaiCompatible.reasoningContent ?? "",
  );
}

export function estimateMessageTokens(message: ContextMessage): number {
  const roleOverhead = 4;
  switch (message.role) {
    case "user":
      return roleOverhead + estimateTextTokens(message.content);
    case "assistant":
      return (
        roleOverhead +
        estimateTextTokens(message.content) +
        estimateAssistantProviderMetadataTokens(message.providerMetadata) +
        message.toolCalls.reduce(
          (total, toolCall) => total + estimateToolCallTokens(toolCall),
          0,
        )
      );
    case "tool":
      return roleOverhead + estimateTextTokens(message.content);
  }
}

export function estimateMessagesTokens(
  messages: readonly ContextMessage[],
): number {
  return messages.reduce(
    (total, message) => total + estimateMessageTokens(message),
    0,
  );
}

function compareStableKeys(left: string, right: string): number {
  return Number(left > right) - Number(left < right);
}

function stableJson(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return `${JSON.stringify(value)}`;
  }
  /* v8 ignore next 3: tool fingerprints are built from JSON-compatible canonical arguments. */
  if (typeof value !== "object") {
    return "null";
  }
  const entries = Object.entries(value).sort(([left], [right]) =>
    compareStableKeys(left, right),
  );
  return `{${entries
    .map(([key, item]) => `${stableJson(key)}:${stableJson(item)}`)
    .join(",")}}`;
}

function stableClone(value: unknown): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(stableClone);
  }
  /* v8 ignore next 3: tool fingerprints are built from JSON-compatible canonical arguments. */
  if (typeof value !== "object") {
    return null;
  }
  const clone: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    clone[key] = stableClone(item);
  }
  return clone;
}

function stableRecordClone(
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const clone: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    clone[key] = stableClone(item);
  }
  return clone;
}

function stableValuesEqual(left: unknown, right: unknown): boolean {
  if (
    left === null ||
    right === null ||
    typeof left !== "object" ||
    typeof right !== "object"
  ) {
    return left === right;
  }
  const leftEntries = Object.entries(left).sort(([leftKey], [rightKey]) =>
    compareStableKeys(leftKey, rightKey),
  );
  const rightEntries = Object.entries(right).sort(([leftKey], [rightKey]) =>
    compareStableKeys(leftKey, rightKey),
  );
  return (
    leftEntries.length === rightEntries.length &&
    leftEntries.every(([key, item], index) => {
      const rightEntry = rightEntries[index];
      return (
        rightEntry !== undefined &&
        key === rightEntry[0] &&
        stableValuesEqual(item, rightEntry[1])
      );
    })
  );
}

function toolCallFingerprintCache(
  toolCall: ToolCall,
): ToolCallFingerprintCache {
  return {
    id: toolCall.id,
    tool: toolCall.tool,
    args: stableRecordClone(toolCallCanonicalArguments(toolCall)),
  };
}

function toolCallFingerprint(toolCall: ToolCall): string {
  return stableJson(toolCallFingerprintCache(toolCall));
}

function captureToolCallFingerprint(
  toolCall: ToolCall,
): CapturedToolCallFingerprint {
  const cache = toolCallFingerprintCache(toolCall);
  return {
    cache,
    fingerprint: stableJson(cache),
  };
}

function toolCallMatchesFingerprintCache(
  toolCall: ToolCall,
  cache: ToolCallFingerprintCache,
): boolean {
  const current = toolCallFingerprintCache(toolCall);
  return (
    current.id === cache.id &&
    current.tool === cache.tool &&
    stableValuesEqual(current.args, cache.args)
  );
}

function messageFingerprint(message: ContextMessage): string {
  switch (message.role) {
    case "user":
      return JSON.stringify([message.role, message.content]);
    case "assistant":
      return JSON.stringify([
        message.role,
        message.content,
        message.providerMetadata ?? null,
        message.toolCalls.map(toolCallFingerprint),
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
  message: ContextMessage,
): MessageFingerprintCache {
  switch (message.role) {
    case "user":
      return {
        role: message.role,
        content: message.content,
        fingerprint: JSON.stringify([message.role, message.content]),
      };
    case "assistant": {
      const toolCalls = message.toolCalls.map(captureToolCallFingerprint);
      return {
        role: message.role,
        content: message.content,
        providerMetadata: message.providerMetadata ?? null,
        toolCalls: toolCalls.map((toolCall) => toolCall.cache),
        fingerprint: JSON.stringify([
          message.role,
          message.content,
          message.providerMetadata ?? null,
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
  message: ContextMessage,
  cache: MessageFingerprintCache,
): string {
  switch (message.role) {
    case "user":
      return cache.role === "user" && cache.content === message.content
        ? cache.fingerprint
        : messageFingerprint(message);
    case "assistant": {
      if (cache.role !== "assistant") {
        return messageFingerprint(message);
      }
      const { toolCalls } = message;
      const toolCallCaches = cache.toolCalls;
      if (
        cache.content === message.content &&
        stableJson(cache.providerMetadata) ===
          stableJson(message.providerMetadata ?? null) &&
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

export function estimateRequestTokens(
  systemPrompt: string,
  messages: readonly ContextMessage[],
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

export function contextCompactionStatsForCurrentMessages(options: {
  readonly stats: ContextCompactionStats;
  readonly systemPrompt: string;
  readonly messages: readonly ContextMessage[];
  readonly requestMetadata?: ContextCompactionRequestMetadata;
}): ContextCompactionStats {
  return {
    ...options.stats,
    afterMessageCount: options.messages.length,
    afterEstimatedTokens: estimateRequestTokens(
      options.systemPrompt,
      options.messages,
      undefined,
      options.requestMetadata,
    ),
  };
}

function estimateRequestTokensFromAccounting(
  systemPrompt: string,
  messages: readonly ContextMessage[],
  accounting: ContextCompactionAccountingSnapshot | undefined,
  metadata: ContextCompactionRequestMetadata | undefined,
): number | null {
  const currentMetadata = resolvedRequestMetadata(metadata);
  if (
    accounting === undefined ||
    accounting.systemPrompt !== systemPrompt ||
    !modelToolExposuresEqual(accounting.requestMetadata, currentMetadata) ||
    accounting.messageFingerprintCache.length > messages.length
  ) {
    return null;
  }

  for (const [index, cache] of accounting.messageFingerprintCache.entries()) {
    const message = messages[index];
    if (
      message === undefined ||
      cachedMessageFingerprint(message, cache) !== cache.fingerprint
    ) {
      return null;
    }
  }

  return (
    accounting.inputTokens +
    estimateMessagesTokens(
      messages.slice(accounting.messageFingerprintCache.length),
    )
  );
}

function isUsableInputTokenCount(inputTokens: number): boolean {
  return Number.isSafeInteger(inputTokens) && inputTokens > 0;
}

export function captureContextCompactionAccountingSnapshot(options: {
  readonly systemPrompt: string;
  readonly messages: readonly ContextMessage[];
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
    // Store field-level cache metadata so later checks can validate the prefix
    // without rebuilding unchanged historical fingerprints.
    messageFingerprintCache,
    requestMetadata: resolvedRequestMetadata(options.requestMetadata),
    inputTokens: options.usage.inputTokens,
  };
}

export function shouldCompactBeforeRequest(
  systemPrompt: string,
  messages: readonly ContextMessage[],
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
