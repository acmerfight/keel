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
  compactCurrentToolOutputs,
  compactCurrentToolOutputsWithArtifacts,
  EMPTY_STALE_TOOL_OUTPUT_COMPACTION_STATS,
  isCompactedCurrentToolOutput as isCompactedCurrentToolOutputFromContent,
  mergeStaleToolOutputCompactionStats,
} from "./context-compaction/stale-tool-output.ts";
import {
  buildCompactedMessages,
  collectCompactionSummary,
} from "./context-compaction/summary.ts";

export { currentToolRound } from "./context-compaction/current-tool-round.ts";

import {
  captureContextCompactionAccountingSnapshot as captureContextCompactionAccountingSnapshotFromAccounting,
  contextCompactionStatsForCurrentMessages as contextCompactionStatsForCurrentMessagesFromAccounting,
  estimateRequestTokens,
  type ContextCompactionAccountingSnapshot as InternalContextCompactionAccountingSnapshot,
  type ContextCompactionStats as InternalContextCompactionStats,
  shouldCompactBeforeRequest as shouldCompactBeforeRequestFromAccounting,
} from "./context-compaction/token-accounting.ts";
import type {
  ToolOutputArtifactNotice,
  ToolOutputArtifactsOptions,
} from "./tool-output-artifacts.ts";

export type ContextCompactionOptions = InternalContextCompactionOptions;
export type ContextCompactionRequestMetadata =
  InternalContextCompactionRequestMetadata;
export type ContextCompactionAccountingSnapshot =
  InternalContextCompactionAccountingSnapshot;
export type ContextCompactionStats = InternalContextCompactionStats;

export function isCompactedCurrentToolOutput(text: string): boolean {
  return isCompactedCurrentToolOutputFromContent(text);
}

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
  readonly allowCurrentToolOutputCompaction?: boolean;
  readonly toolOutputArtifacts?: ToolOutputArtifactsOptions;
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
      readonly artifactNotices?: readonly ToolOutputArtifactNotice[];
    };

function artifactNoticesResult(
  ...sources: readonly (readonly ToolOutputArtifactNotice[] | undefined)[]
): { readonly artifactNotices?: readonly ToolOutputArtifactNotice[] } {
  const artifactNotices = sources.flatMap((source) => source ?? []);
  return artifactNotices.length > 0 ? { artifactNotices } : {};
}

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
    if (options.allowCurrentToolOutputCompaction === true) {
      const currentToolOutputCompaction =
        options.toolOutputArtifacts === undefined
          ? compactCurrentToolOutputs(
              options.messages,
              resolved.toolOutputMaxChars,
            )
          : await compactCurrentToolOutputsWithArtifacts(
              options.messages,
              resolved.toolOutputMaxChars,
              options.toolOutputArtifacts.store,
            );
      /* v8 ignore next: V8 does not attribute the fall-through branch here; overflow-edge-cases covers both no-op and compacted current-output paths. */
      if (currentToolOutputCompaction.stats.toolOutputsCompacted === 0) {
        return { compacted: false, usage: ZERO_USAGE };
      }
      options.messages.splice(
        0,
        options.messages.length,
        ...currentToolOutputCompaction.messages,
      );
      return {
        compacted: true,
        usage: ZERO_USAGE,
        stats: {
          beforeMessageCount,
          afterMessageCount: options.messages.length,
          beforeEstimatedTokens,
          afterEstimatedTokens: estimateRequestTokens(
            options.systemPrompt,
            options.messages,
          ),
          ...currentToolOutputCompaction.stats,
        },
        ...artifactNoticesResult(currentToolOutputCompaction.artifactNotices),
      };
    }
    // The protected current suffix starts at the beginning of the transcript and
    // has no oversized current tool output we can shrink. Creating an empty
    // checkpoint would only make the retry larger, so report no compaction.
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
  const compacted = await buildCompactedMessages(
    options.messages,
    plan.firstRetainedIndex,
    summaryTurn.text,
    resolved,
    options.toolOutputArtifacts,
  );
  const currentToolOutputCompaction =
    options.allowCurrentToolOutputCompaction === true
      ? options.toolOutputArtifacts === undefined
        ? compactCurrentToolOutputs(
            compacted.messages,
            resolved.toolOutputMaxChars,
          )
        : await compactCurrentToolOutputsWithArtifacts(
            compacted.messages,
            resolved.toolOutputMaxChars,
            options.toolOutputArtifacts.store,
          )
      : {
          messages: compacted.messages,
          stats: EMPTY_STALE_TOOL_OUTPUT_COMPACTION_STATS,
        };
  const toolOutputStats = mergeStaleToolOutputCompactionStats(
    compacted.staleToolOutputStats,
    currentToolOutputCompaction.stats,
  );
  options.messages.splice(
    0,
    options.messages.length,
    ...currentToolOutputCompaction.messages,
  );
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
      ...toolOutputStats,
    },
    ...artifactNoticesResult(
      compacted.artifactNotices,
      currentToolOutputCompaction.artifactNotices,
    ),
  };
}
