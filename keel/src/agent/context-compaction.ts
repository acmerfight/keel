import { errorMessage } from "../core/error.ts";
import type { SessionTaskProgress } from "../core/task-progress.ts";
import type { LLMProvider, Message, Usage } from "../llm/types.ts";
import { currentToolRound } from "./context-compaction/current-tool-round.ts";
import type {
  ContextCompactionOptions as InternalContextCompactionOptions,
  ContextCompactionRequestMetadata as InternalContextCompactionRequestMetadata,
  ResolvedContextCompactionOptions,
} from "./context-compaction/options.ts";
import {
  contextCompactionRequestTargetTokens,
  resolveContextCompactionOptions,
} from "./context-compaction/options.ts";
import {
  planCompaction,
  selectCompactionSplit,
} from "./context-compaction/planning.ts";
import {
  type CurrentToolOutputCompactionPolicy,
  type CurrentToolOutputCompactionReason,
  compactCurrentToolOutputs,
  compactCurrentToolOutputsWithArtifacts,
  EMPTY_STALE_TOOL_OUTPUT_COMPACTION_STATS,
  isCompactedCurrentToolOutput as isCompactedCurrentToolOutputFromContent,
  mergeStaleToolOutputCompactionStats,
  type StaleToolOutputCompactionStats,
} from "./context-compaction/stale-tool-output.ts";
import {
  buildCompactedMessages,
  type CompactionSummaryFailure,
  collectCompactionSummary,
  compactionSummaryErrorDetails,
} from "./context-compaction/summary.ts";
import type {
  ModelOperationPurpose,
  ModelOperationRequest,
} from "./model-operations.ts";

export { conversationCheckpointSummaryFromMessage } from "./context-compaction/checkpoint.ts";
export { currentToolRound } from "./context-compaction/current-tool-round.ts";
export { collectToolCompactionEvidence } from "./context-compaction/evidence.ts";
export {
  contextCompactionRequestTargetTokens,
  resolveContextCompactionOptions,
} from "./context-compaction/options.ts";
export {
  compactCurrentToolOutputs,
  compactCurrentToolOutputsWithArtifacts,
  compactStaleToolOutputs,
  compactStaleToolOutputsWithArtifacts,
} from "./context-compaction/stale-tool-output.ts";
export { projectCompactedToolOutput } from "./context-compaction/tool-output-preview.ts";

import {
  captureContextCompactionAccountingSnapshot as captureContextCompactionAccountingSnapshotFromAccounting,
  contextCompactionStatsForCurrentMessages as contextCompactionStatsForCurrentMessagesFromAccounting,
  estimateRequestTokens,
  estimateTextTokens,
  type ContextCompactionAccountingSnapshot as InternalContextCompactionAccountingSnapshot,
  type ContextCompactionStats as InternalContextCompactionStats,
  shouldCompactBeforeRequest as shouldCompactBeforeRequestFromAccounting,
} from "./context-compaction/token-accounting.ts";
import type {
  ToolOutputArtifactCompactionArtifact,
  ToolOutputArtifactNotice,
  ToolOutputArtifactsOptions,
} from "./tool-output-artifacts.ts";

export type ContextCompactionOptions = InternalContextCompactionOptions;
export type ContextCompactionRequestMetadata =
  InternalContextCompactionRequestMetadata;
export type ContextCompactionAccountingSnapshot =
  InternalContextCompactionAccountingSnapshot;
export type ContextCompactionStats = InternalContextCompactionStats;
export type {
  CurrentToolOutputCompactionPolicy,
  CurrentToolOutputCompactionReason,
};
export { estimateTextTokens };

interface CurrentToolOutputCompactionBase {
  readonly mode: "combined" | "current_only";
  readonly maxChars?: number;
}

export type CurrentToolOutputCompaction = CurrentToolOutputCompactionBase &
  CurrentToolOutputCompactionPolicy;

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
  readonly summarySystemPrompt?: string;
  readonly messages: Message[];
  readonly signal: AbortSignal;
  readonly contextCompaction?: ContextCompactionOptions;
  readonly contextAccounting?: ContextCompactionAccountingSnapshot;
  readonly requestMetadata?: ContextCompactionRequestMetadata;
  readonly taskProgress?: SessionTaskProgress;
  readonly focusInstruction?: string;
  readonly currentToolOutputCompaction?: CurrentToolOutputCompaction;
  readonly toolOutputArtifacts?: ToolOutputArtifactsOptions;
  readonly modelOperation?: ModelOperationRequest<
    Extract<
      ModelOperationPurpose,
      "context_compaction" | "manual_compaction" | "model_switch_compaction"
    >
  >;
}

export type CompactMessagesResult =
  | {
      readonly compacted: false;
      readonly usage: Usage;
      readonly stats?: undefined;
      readonly failure?: CompactionSummaryFailure;
    }
  | {
      readonly compacted: true;
      readonly historyCompacted: boolean;
      readonly usage: Usage;
      readonly stats: ContextCompactionStats;
      readonly artifactNotices?: readonly ToolOutputArtifactNotice[];
      readonly artifactReports?: readonly ToolOutputArtifactCompactionArtifact[];
    };

function artifactNoticesResult(
  ...sources: readonly (readonly ToolOutputArtifactNotice[] | undefined)[]
): { readonly artifactNotices?: readonly ToolOutputArtifactNotice[] } {
  const artifactNotices = sources.flatMap((source) => source ?? []);
  return artifactNotices.length > 0 ? { artifactNotices } : {};
}

function artifactReportsResult(
  ...sources: readonly (
    | readonly ToolOutputArtifactCompactionArtifact[]
    | undefined
  )[]
): {
  readonly artifactReports?: readonly ToolOutputArtifactCompactionArtifact[];
} {
  const artifactReports = sources.flatMap((source) => source ?? []);
  return artifactReports.length > 0 ? { artifactReports } : {};
}

async function discardStoredArtifactReports(
  options: ToolOutputArtifactsOptions | undefined,
  reports: readonly ToolOutputArtifactCompactionArtifact[],
): Promise<void> {
  if (options === undefined) {
    return;
  }
  const refs: string[] = [];
  for (const report of reports) {
    if (report.status === "stored") {
      refs.push(report.ref);
    }
  }
  await Promise.all(
    refs.map(async (ref) => {
      await options.store.discard(ref);
    }),
  );
}

const CURRENT_TOOL_OUTPUT_COMPACTION_MARKER_BUDGET_CHARS = 512;

function requestTargetTokens(
  resolved: ResolvedContextCompactionOptions,
): number | undefined {
  if (resolved.contextWindowTokens === undefined) {
    return undefined;
  }
  return contextCompactionRequestTargetTokens({
    contextWindowTokens: resolved.contextWindowTokens,
    reserveTokens: resolved.reserveTokens,
  });
}

function currentToolOutputMaxCharsForCompaction(options: {
  readonly messages: readonly Message[];
  readonly resolved: ResolvedContextCompactionOptions;
  readonly beforeEstimatedTokens: number;
}): number {
  const targetTokens = requestTargetTokens(options.resolved);
  if (targetTokens === undefined) {
    return options.resolved.toolOutputMaxChars;
  }

  const overageTokens = options.beforeEstimatedTokens - targetTokens;
  if (overageTokens <= 0) {
    return options.resolved.toolOutputMaxChars;
  }

  const currentOutputs = currentToolRound(options.messages)?.toolOutputs ?? [];
  if (currentOutputs.length === 0) {
    return options.resolved.toolOutputMaxChars;
  }

  const currentOutputChars = currentOutputs.reduce(
    (total, output) => total + output.message.content.length,
    0,
  );
  const currentOutputEstimatedTokens = Math.ceil(currentOutputChars / 4);
  if (overageTokens >= currentOutputEstimatedTokens) {
    return 1;
  }

  const targetAggregateChars = Math.max(
    currentOutputs.length,
    currentOutputChars -
      overageTokens * 4 -
      CURRENT_TOOL_OUTPUT_COMPACTION_MARKER_BUDGET_CHARS *
        currentOutputs.length,
  );
  const targetCharsPerOutput = Math.floor(
    targetAggregateChars / currentOutputs.length,
  );
  return Math.max(
    1,
    Math.min(options.resolved.toolOutputMaxChars, targetCharsPerOutput),
  );
}

function compactedCurrentOutputsExceededSettledBudget(options: {
  readonly stats: StaleToolOutputCompactionStats;
  readonly resolved: ResolvedContextCompactionOptions;
}): boolean {
  return (
    options.stats.currentToolOutputsCompacted > 0 &&
    options.stats.toolOutputCharsBefore > options.resolved.toolOutputMaxChars
  );
}

async function compactCurrentToolOutputsForRequest(options: {
  readonly systemPrompt: string;
  readonly messages: Message[];
  readonly resolved: ResolvedContextCompactionOptions;
  readonly beforeMessageCount: number;
  readonly beforeEstimatedTokens: number;
  readonly contextAccounting: ContextCompactionAccountingSnapshot | undefined;
  readonly requestMetadata: ContextCompactionRequestMetadata | undefined;
  readonly currentToolOutputCompaction: CurrentToolOutputCompaction;
  readonly toolOutputArtifacts: ToolOutputArtifactsOptions | undefined;
}): Promise<CompactMessagesResult> {
  const currentToolOutputMaxChars =
    options.currentToolOutputCompaction.maxChars ??
    currentToolOutputMaxCharsForCompaction({
      messages: options.messages,
      resolved: options.resolved,
      beforeEstimatedTokens: options.beforeEstimatedTokens,
    });
  const currentToolOutputCompaction =
    options.toolOutputArtifacts === undefined
      ? compactCurrentToolOutputs(options.messages, currentToolOutputMaxChars, {
          policy: options.currentToolOutputCompaction,
          settledMaxChars: options.resolved.toolOutputMaxChars,
        })
      : await compactCurrentToolOutputsWithArtifacts(
          options.messages,
          currentToolOutputMaxChars,
          options.toolOutputArtifacts.store,
          {
            policy: options.currentToolOutputCompaction,
            settledMaxChars: options.resolved.toolOutputMaxChars,
          },
        );
  if (currentToolOutputCompaction.stats.toolOutputsCompacted === 0) {
    return { compacted: false, usage: ZERO_USAGE };
  }

  const afterEstimatedTokens = estimateRequestTokens(
    options.systemPrompt,
    currentToolOutputCompaction.messages,
    options.contextAccounting,
    options.requestMetadata,
  );
  const allowEqualEstimatePreflightOverflowRetry =
    options.currentToolOutputCompaction.reason === "overflow_recovery" &&
    options.currentToolOutputCompaction.preflightCompactedOutputs ===
      "recompact" &&
    currentToolOutputCompaction.stats.currentToolOutputsCompacted > 0 &&
    currentToolOutputCompaction.stats.toolOutputCharsAfter <
      currentToolOutputCompaction.stats.toolOutputCharsBefore;
  const targetTokens = requestTargetTokens(options.resolved);
  if (
    afterEstimatedTokens > options.beforeEstimatedTokens ||
    (afterEstimatedTokens === options.beforeEstimatedTokens &&
      !allowEqualEstimatePreflightOverflowRetry) ||
    (options.currentToolOutputCompaction.mode === "current_only" &&
      options.currentToolOutputCompaction.reason === "preflight" &&
      targetTokens !== undefined &&
      afterEstimatedTokens > targetTokens &&
      !compactedCurrentOutputsExceededSettledBudget({
        stats: currentToolOutputCompaction.stats,
        resolved: options.resolved,
      }))
  ) {
    await discardStoredArtifactReports(
      options.toolOutputArtifacts,
      currentToolOutputCompaction.artifactReports ?? [],
    );
    return { compacted: false, usage: ZERO_USAGE };
  }

  options.messages.splice(
    0,
    options.messages.length,
    ...currentToolOutputCompaction.messages,
  );
  return {
    compacted: true,
    historyCompacted: false,
    usage: ZERO_USAGE,
    stats: {
      beforeMessageCount: options.beforeMessageCount,
      afterMessageCount: options.messages.length,
      beforeEstimatedTokens: options.beforeEstimatedTokens,
      afterEstimatedTokens,
      ...currentToolOutputCompaction.stats,
    },
    ...artifactNoticesResult(currentToolOutputCompaction.artifactNotices),
    ...artifactReportsResult(currentToolOutputCompaction.artifactReports),
  };
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

export function shouldCompactCurrentToolOutputBeforeHistoricalCompaction(
  systemPrompt: string,
  messages: readonly Message[],
  options: ContextCompactionOptions | undefined,
  accounting?: ContextCompactionAccountingSnapshot,
  metadata?: ContextCompactionRequestMetadata,
): boolean {
  const resolved = resolveContextCompactionOptions(options);
  const targetTokens = requestTargetTokens(resolved);
  if (targetTokens === undefined) {
    return false;
  }
  const beforeEstimatedTokens = estimateRequestTokens(
    systemPrompt,
    messages,
    accounting,
    metadata,
  );
  const overageTokens = beforeEstimatedTokens - targetTokens;
  if (overageTokens <= 0) {
    return false;
  }

  const currentOutputChars =
    currentToolRound(messages)?.toolOutputs.reduce(
      (total, output) => total + output.message.content.length,
      0,
    ) ?? 0;
  if (currentOutputChars <= resolved.toolOutputMaxChars) {
    return false;
  }
  return Math.ceil(currentOutputChars / 4) >= overageTokens;
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
  const currentToolOutputPolicy = options.currentToolOutputCompaction;

  if (currentToolOutputPolicy?.mode === "current_only") {
    return await compactCurrentToolOutputsForRequest({
      systemPrompt: options.systemPrompt,
      messages: options.messages,
      resolved,
      beforeMessageCount,
      beforeEstimatedTokens,
      contextAccounting: options.contextAccounting,
      requestMetadata: options.requestMetadata,
      currentToolOutputCompaction: currentToolOutputPolicy,
      toolOutputArtifacts: options.toolOutputArtifacts,
    });
  }

  const split = selectCompactionSplit(options.messages, {
    keepRecentTokens: resolved.keepRecentTokens,
  });
  if (split === null) {
    return { compacted: false, usage: ZERO_USAGE };
  }

  const plan = planCompaction(options.messages, split, resolved);
  if (plan.messagesToSummarize.length === 0) {
    if (currentToolOutputPolicy !== undefined) {
      return await compactCurrentToolOutputsForRequest({
        systemPrompt: options.systemPrompt,
        messages: options.messages,
        resolved,
        beforeMessageCount,
        beforeEstimatedTokens,
        contextAccounting: options.contextAccounting,
        requestMetadata: options.requestMetadata,
        currentToolOutputCompaction: currentToolOutputPolicy,
        toolOutputArtifacts: options.toolOutputArtifacts,
      });
    }
    // The protected current suffix starts at the beginning of the transcript and
    // has no oversized current tool output we can shrink. Creating an empty
    // checkpoint would only make the retry larger, so report no compaction.
    return { compacted: false, usage: ZERO_USAGE };
  }

  let summaryResult: Awaited<ReturnType<typeof collectCompactionSummary>>;
  try {
    summaryResult = await collectCompactionSummary({
      provider: options.provider,
      systemPrompt: options.summarySystemPrompt ?? options.systemPrompt,
      messagesToSummarize: plan.messagesToSummarize,
      signal: options.signal,
      contextCompaction: resolved,
      ...(options.toolOutputArtifacts !== undefined
        ? { toolOutputArtifacts: options.toolOutputArtifacts }
        : {}),
      ...(options.focusInstruction !== undefined
        ? { focusInstruction: options.focusInstruction }
        : {}),
      ...(options.modelOperation !== undefined
        ? { modelOperation: options.modelOperation }
        : {}),
    });
  } catch (error) {
    const details = compactionSummaryErrorDetails(error);
    if (details === null) {
      throw error;
    }
    return {
      compacted: false,
      failure: {
        code: "summary_error",
        message: errorMessage(details.error),
        error: details.error,
      },
      usage: details.usage,
    };
  }
  if (!summaryResult.complete) {
    return {
      compacted: false,
      failure: summaryResult.failure,
      usage: summaryResult.usage,
    };
  }
  const summaryTurn = summaryResult.turn;
  const compacted = await buildCompactedMessages(
    options.messages,
    summaryTurn.summarizedMessageCount,
    summaryTurn.text,
    resolved,
    options.toolOutputArtifacts,
    summaryTurn.summaryInputMaxChars,
    options.taskProgress,
  );
  const currentToolOutputMaxChars = currentToolOutputMaxCharsForCompaction({
    messages: compacted.messages,
    resolved,
    beforeEstimatedTokens: estimateRequestTokens(
      options.systemPrompt,
      compacted.messages,
      undefined,
      options.requestMetadata,
    ),
  });
  const currentToolOutputCompaction =
    currentToolOutputPolicy !== undefined
      ? options.toolOutputArtifacts === undefined
        ? compactCurrentToolOutputs(
            compacted.messages,
            currentToolOutputPolicy.maxChars ?? currentToolOutputMaxChars,
            {
              policy: currentToolOutputPolicy,
              settledMaxChars: resolved.toolOutputMaxChars,
            },
          )
        : await compactCurrentToolOutputsWithArtifacts(
            compacted.messages,
            currentToolOutputPolicy.maxChars ?? currentToolOutputMaxChars,
            options.toolOutputArtifacts.store,
            {
              policy: currentToolOutputPolicy,
              settledMaxChars: resolved.toolOutputMaxChars,
            },
          )
      : {
          messages: compacted.messages,
          stats: EMPTY_STALE_TOOL_OUTPUT_COMPACTION_STATS,
        };
  const toolOutputStats = mergeStaleToolOutputCompactionStats(
    compacted.staleToolOutputStats,
    currentToolOutputCompaction.stats,
  );
  const afterEstimatedTokens = estimateRequestTokens(
    options.systemPrompt,
    currentToolOutputCompaction.messages,
    options.contextAccounting,
    options.requestMetadata,
  );

  options.messages.splice(
    0,
    options.messages.length,
    ...currentToolOutputCompaction.messages,
  );
  return {
    compacted: true,
    historyCompacted: true,
    usage: summaryTurn.usage,
    stats: {
      beforeMessageCount,
      afterMessageCount: options.messages.length,
      beforeEstimatedTokens,
      afterEstimatedTokens,
      ...toolOutputStats,
    },
    ...artifactNoticesResult(
      compacted.artifactNotices,
      currentToolOutputCompaction.artifactNotices,
    ),
    ...artifactReportsResult(
      compacted.artifactReports,
      currentToolOutputCompaction.artifactReports,
    ),
  };
}
