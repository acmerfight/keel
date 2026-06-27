import type { LLMProvider, Message, Usage } from "../llm/types.ts";
import type {
  ContextCompactionOptions as InternalContextCompactionOptions,
  ContextCompactionRequestMetadata as InternalContextCompactionRequestMetadata,
} from "./context-compaction/options.ts";
import { resolveContextCompactionOptions } from "./context-compaction/options.ts";
import {
  planCompaction,
  selectCompactionSplit,
} from "./context-compaction/planning.ts";
import {
  buildCompactedMessages,
  collectCompactionSummary,
} from "./context-compaction/summary.ts";
import {
  captureContextCompactionAccountingSnapshot as captureContextCompactionAccountingSnapshotFromAccounting,
  contextCompactionStatsForCurrentMessages as contextCompactionStatsForCurrentMessagesFromAccounting,
  estimateRequestTokens,
  type ContextCompactionAccountingSnapshot as InternalContextCompactionAccountingSnapshot,
  type ContextCompactionStats as InternalContextCompactionStats,
  shouldCompactBeforeRequest as shouldCompactBeforeRequestFromAccounting,
} from "./context-compaction/token-accounting.ts";

export type ContextCompactionOptions = InternalContextCompactionOptions;
export type ContextCompactionRequestMetadata =
  InternalContextCompactionRequestMetadata;
export type ContextCompactionAccountingSnapshot =
  InternalContextCompactionAccountingSnapshot;
export type ContextCompactionStats = InternalContextCompactionStats;

const ZERO_USAGE: Usage = {
  inputTokens: 0,
  cachedInputTokens: 0,
  uncachedInputTokens: 0,
  outputTokens: 0,
};

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

export type CompactMessagesResult =
  | {
      readonly compacted: false;
      readonly usage: Usage;
      readonly stats?: undefined;
    }
  | {
      readonly compacted: true;
      readonly usage: Usage;
      readonly stats: ContextCompactionStats;
    };

export function captureContextCompactionAccountingSnapshot(options: {
  readonly systemPrompt: string;
  readonly messages: readonly Message[];
  readonly usage: Usage;
  readonly requestMetadata?: ContextCompactionRequestMetadata;
}): ContextCompactionAccountingSnapshot | undefined {
  return captureContextCompactionAccountingSnapshotFromAccounting(options);
}

export function shouldCompactBeforeRequest(
  systemPrompt: string,
  messages: readonly Message[],
  options: ContextCompactionOptions | undefined,
  accounting?: ContextCompactionAccountingSnapshot,
  metadata?: ContextCompactionRequestMetadata,
): boolean {
  return shouldCompactBeforeRequestFromAccounting(
    systemPrompt,
    messages,
    options,
    accounting,
    metadata,
  );
}

export function contextCompactionStatsForCurrentMessages(options: {
  readonly stats: ContextCompactionStats;
  readonly systemPrompt: string;
  readonly messages: readonly Message[];
  readonly requestMetadata?: ContextCompactionRequestMetadata;
}): ContextCompactionStats {
  return contextCompactionStatsForCurrentMessagesFromAccounting(options);
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
