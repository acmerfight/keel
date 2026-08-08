import type { SessionTaskProgress } from "../core/task-progress.ts";
import type { LLMProvider } from "../llm/types.ts";
import {
  addRequestAccounting,
  type CostTrackingOptions,
  type RunAccounting,
} from "./accounting.ts";
import {
  type CompactMessagesResult,
  type ContextCompactionAccountingSnapshot,
  type ContextCompactionOptions,
  type ContextCompactionRequestMetadata,
  type CurrentToolOutputCompaction,
  captureContextCompactionAccountingSnapshot,
  compactMessages,
  contextCompactionStatsForCurrentMessages,
  shouldCompactBeforeRequest,
  shouldCompactCurrentToolOutputBeforeHistoricalCompaction,
} from "./context-compaction.ts";
import type { AgentEvent } from "./events.ts";
import type {
  ModelOperationHandle,
  ModelOperationInstrumentation,
  ModelOperationRecoveryTarget,
  ModelOperationRequest,
} from "./model-operations.ts";
import {
  type AgentTurn,
  ContextOverflowBeforeAssistantError,
  type StreamTurnOptions,
  streamAgentTurn,
} from "./provider-turn.ts";
import {
  projectSessionLedgerToProviderMessages,
  replaceSessionLedgerMessages,
  type SessionLedger,
  sessionLedgerMessages,
} from "./session-ledger.ts";
import type { SessionMessage } from "./session-message.ts";
import type { ToolOutputArtifactsOptions } from "./tool-output-artifacts.ts";

export interface CompactionConfig {
  readonly provider: LLMProvider;
  readonly systemPrompt: string;
  readonly requestSystemPrompt?: () => string;
  readonly summarySystemPrompt?: string;
  readonly signal: AbortSignal;
  readonly contextCompaction: ContextCompactionOptions | undefined;
  readonly toolOutputArtifacts?: ToolOutputArtifactsOptions;
  readonly taskProgress?: () => SessionTaskProgress;
  readonly costTracking: CostTrackingOptions | undefined;
  readonly modelOperations: ModelOperationInstrumentation | null;
  readonly onContextCompacted: (
    messages: SessionMessage[],
  ) => Promise<ContextCompactionFinalization>;
}

interface ContextCompactionFinalization {
  readonly rollback: () => void;
}

const NO_CONTEXT_COMPACTION_FINALIZATION: ContextCompactionFinalization = {
  rollback: () => {},
};

export type CompactionState = {
  contextAccounting: ContextCompactionAccountingSnapshot | undefined;
  accounting: RunAccounting;
};

export interface LedgerTurnOptions extends StreamTurnOptions {
  readonly ledger: SessionLedger;
  readonly modelOperation: ModelOperationRequest<
    "agent_turn" | "subagent_turn" | "turn_limit_summary"
  > | null;
}

type ContextCompactionAttempt =
  | {
      readonly kind: "proactive_history";
      readonly recoveryFor?: never;
      readonly preflightRecompaction?: never;
    }
  | {
      readonly kind: "preflight_current";
      readonly recoveryFor?: never;
      readonly preflightRecompaction?: never;
    }
  | {
      readonly kind: "overflow_recovery";
      readonly recoveryFor: ModelOperationRecoveryTarget | null;
      readonly preflightRecompaction?: {
        readonly maxChars: number;
      };
    };

function requestMetadataForStream(
  options: StreamTurnOptions,
): ContextCompactionRequestMetadata {
  return options.toolExposure;
}

function currentToolOutputPolicy(
  attempt: ContextCompactionAttempt,
): CurrentToolOutputCompaction | undefined {
  switch (attempt.kind) {
    case "proactive_history":
      return undefined;
    case "preflight_current":
      return {
        mode: "current_only",
        reason: "preflight",
      };
    case "overflow_recovery":
      return {
        mode: "combined",
        reason: "overflow_recovery",
        preflightCompactedOutputs:
          attempt.preflightRecompaction === undefined
            ? "preserve"
            : "recompact",
        ...(attempt.preflightRecompaction !== undefined
          ? { maxChars: attempt.preflightRecompaction.maxChars }
          : {}),
      };
  }
}

async function attemptContextCompaction(
  config: CompactionConfig,
  state: CompactionState,
  streamOptions: LedgerTurnOptions,
  attempt: ContextCompactionAttempt,
): Promise<CompactMessagesResult> {
  const sourceMessages = sessionLedgerMessages(streamOptions.ledger);
  const targetMessages = [...sourceMessages];
  const requestMetadata = requestMetadataForStream(streamOptions);
  const taskProgress = config.taskProgress?.();
  const currentToolOutputCompaction = currentToolOutputPolicy(attempt);
  const result = await compactMessages({
    provider: config.provider,
    systemPrompt: config.systemPrompt,
    ...(config.summarySystemPrompt !== undefined
      ? { summarySystemPrompt: config.summarySystemPrompt }
      : {}),
    messages: targetMessages,
    signal: config.signal,
    ...(config.contextCompaction !== undefined
      ? { contextCompaction: config.contextCompaction }
      : {}),
    ...(config.toolOutputArtifacts !== undefined
      ? { toolOutputArtifacts: config.toolOutputArtifacts }
      : {}),
    ...(state.contextAccounting !== undefined
      ? { contextAccounting: state.contextAccounting }
      : {}),
    requestMetadata,
    ...(taskProgress !== undefined ? { taskProgress } : {}),
    ...(currentToolOutputCompaction !== undefined
      ? { currentToolOutputCompaction }
      : {}),
    ...(config.modelOperations !== null
      ? {
          modelOperation: {
            instrumentation: config.modelOperations,
            purpose: "context_compaction" as const,
            recoveryFor:
              attempt.kind === "overflow_recovery" ? attempt.recoveryFor : null,
          },
        }
      : {}),
  });
  let finalResult = result;
  if (result.compacted) {
    let finalization = NO_CONTEXT_COMPACTION_FINALIZATION;
    if (attempt.kind !== "preflight_current") {
      finalization = await config.onContextCompacted(targetMessages);
    }

    const finalStats = contextCompactionStatsForCurrentMessages({
      stats: result.stats,
      systemPrompt: config.systemPrompt,
      messages: targetMessages,
      requestMetadata,
    });
    const rejectsGrowingHistoryCompaction =
      attempt.kind === "proactive_history" &&
      result.historyCompacted &&
      finalStats.afterEstimatedTokens >= finalStats.beforeEstimatedTokens;
    if (rejectsGrowingHistoryCompaction) {
      finalization.rollback();
      finalResult = {
        compacted: false,
        usage: result.usage,
      };
    } else {
      state.contextAccounting = undefined;
      replaceSessionLedgerMessages(streamOptions.ledger, targetMessages);
      finalResult = {
        ...result,
        stats: finalStats,
      };
    }
  }
  state.accounting = addRequestAccounting(
    state.accounting,
    result.usage,
    config.costTracking,
  );
  if (!result.compacted && result.failure?.code === "summary_error") {
    throw result.failure.error;
  }
  return finalResult;
}

async function* attemptPreflightCurrentOutputCompaction(
  config: CompactionConfig,
  state: CompactionState,
  streamOptions: LedgerTurnOptions,
): AsyncGenerator<AgentEvent> {
  const compaction = await attemptContextCompaction(
    config,
    state,
    streamOptions,
    {
      kind: "preflight_current",
    },
  );
  if (!compaction.compacted) {
    return;
  }
  yield {
    type: "context_compacted",
    reason: "preflight",
    historyCompacted: compaction.historyCompacted,
    artifacts: compaction.artifactReports ?? [],
    ...compaction.stats,
  };
  for (const notice of compaction.artifactNotices ?? []) {
    yield { type: "tool_output_artifact", ...notice };
  }
}

export async function* streamTurnWithOverflowRecovery(
  config: CompactionConfig,
  state: CompactionState,
  streamOptions: LedgerTurnOptions,
): AsyncGenerator<AgentEvent, AgentTurn> {
  let overflowRecoveryAttempted = false;
  let historicalCompactionAttemptedBeforeRequest = false;
  let preflightCurrentOutputCompactionAttempted = false;
  let operation: ModelOperationHandle | null = null;
  let operationFinished = false;
  const startOperation = (): ModelOperationHandle | null => {
    if (operation !== null || streamOptions.modelOperation === null) {
      return operation;
    }
    const request = streamOptions.modelOperation;
    switch (request.purpose) {
      case "agent_turn":
        operation = request.instrumentation.recorder.beginModelOperation({
          ...request.instrumentation,
          purpose: request.purpose,
          recoveryFor: null,
        });
        break;
      case "subagent_turn":
        operation = request.instrumentation.recorder.beginModelOperation({
          ...request.instrumentation,
          purpose: request.purpose,
          recoveryFor: null,
        });
        break;
      case "turn_limit_summary":
        operation = request.instrumentation.recorder.beginModelOperation({
          ...request.instrumentation,
          purpose: request.purpose,
          recoveryFor: null,
        });
        break;
    }
    return operation;
  };
  const finishOperation = (
    outcome: Parameters<ModelOperationHandle["finish"]>[0]["outcome"],
  ): void => {
    if (operation === null || operationFinished) {
      return;
    }
    operationFinished = true;
    operation.finish({ outcome });
  };
  const finishOperationFromError = (error: unknown): void => {
    if (operation === null || operationFinished) {
      return;
    }
    operationFinished = true;
    operation.finishFromError(error);
  };

  try {
    for (;;) {
      const requestMessages = sessionLedgerMessages(streamOptions.ledger);
      if (
        !preflightCurrentOutputCompactionAttempted &&
        shouldCompactCurrentToolOutputBeforeHistoricalCompaction(
          config.systemPrompt,
          requestMessages,
          config.contextCompaction,
          state.contextAccounting,
          requestMetadataForStream(streamOptions),
        )
      ) {
        preflightCurrentOutputCompactionAttempted = true;
        yield* attemptPreflightCurrentOutputCompaction(
          config,
          state,
          streamOptions,
        );
      }
      const historicalRequestMessages = sessionLedgerMessages(
        streamOptions.ledger,
      );
      if (
        !historicalCompactionAttemptedBeforeRequest &&
        shouldCompactBeforeRequest(
          config.systemPrompt,
          historicalRequestMessages,
          config.contextCompaction,
          state.contextAccounting,
          requestMetadataForStream(streamOptions),
        )
      ) {
        historicalCompactionAttemptedBeforeRequest = true;
        const compaction = await attemptContextCompaction(
          config,
          state,
          streamOptions,
          {
            kind: "proactive_history",
          },
        );
        if (compaction.compacted) {
          yield {
            type: "context_compacted",
            reason: "proactive",
            historyCompacted: compaction.historyCompacted,
            artifacts: compaction.artifactReports ?? [],
            ...compaction.stats,
          };
          for (const notice of compaction.artifactNotices ?? []) {
            yield { type: "tool_output_artifact", ...notice };
          }
        }
      }
      const preflightRequestMessages = sessionLedgerMessages(
        streamOptions.ledger,
      );
      if (
        !preflightCurrentOutputCompactionAttempted &&
        // After historical compaction, any remaining over-budget request is
        // worth a current-output-only preflight attempt even when the original
        // overage was not dominated by the current tool round.
        shouldCompactBeforeRequest(
          config.systemPrompt,
          preflightRequestMessages,
          config.contextCompaction,
          state.contextAccounting,
          requestMetadataForStream(streamOptions),
        )
      ) {
        preflightCurrentOutputCompactionAttempted = true;
        yield* attemptPreflightCurrentOutputCompaction(
          config,
          state,
          streamOptions,
        );
      }
      try {
        const currentRequestMessages = projectSessionLedgerToProviderMessages(
          streamOptions.ledger,
        );
        const currentOperation = startOperation();
        let currentSystemPrompt =
          config.requestSystemPrompt?.() ?? streamOptions.systemPrompt;
        let firstPhysicalRequest = true;
        const refreshSystemPrompt = config.requestSystemPrompt;
        const requestSystemPrompt =
          refreshSystemPrompt === undefined
            ? undefined
            : () => {
                if (firstPhysicalRequest) {
                  firstPhysicalRequest = false;
                  return currentSystemPrompt;
                }
                currentSystemPrompt = refreshSystemPrompt();
                return currentSystemPrompt;
              };
        const turn = yield* streamAgentTurn({
          provider: streamOptions.provider,
          systemPrompt: currentSystemPrompt,
          ...(requestSystemPrompt !== undefined ? { requestSystemPrompt } : {}),
          messages: currentRequestMessages,
          signal: streamOptions.signal,
          toolExposure: streamOptions.toolExposure,
          ...(streamOptions.textPrefix !== undefined
            ? { textPrefix: streamOptions.textPrefix }
            : {}),
          ...(currentOperation !== null
            ? {
                providerRequestAttempts:
                  currentOperation.providerRequestAttempts,
              }
            : {}),
        });
        finishOperation("completed");
        state.contextAccounting =
          config.contextCompaction === undefined
            ? undefined
            : captureContextCompactionAccountingSnapshot({
                systemPrompt: currentSystemPrompt,
                messages: currentRequestMessages,
                usage: turn.usage,
                requestMetadata: requestMetadataForStream(streamOptions),
              });
        return turn;
      } catch (error) {
        if (error instanceof ContextOverflowBeforeAssistantError) {
          if (!overflowRecoveryAttempted) {
            overflowRecoveryAttempted = true;
            const recoveryOperation = startOperation();
            const recoveryFor =
              recoveryOperation === null
                ? null
                : recoveryOperation.latestContextOverflowRecoveryTarget();
            let compaction: CompactMessagesResult;
            try {
              compaction = await attemptContextCompaction(
                config,
                state,
                streamOptions,
                {
                  kind: "overflow_recovery",
                  recoveryFor,
                  ...(preflightCurrentOutputCompactionAttempted
                    ? {
                        preflightRecompaction: { maxChars: 1 },
                      }
                    : {}),
                },
              );
            } catch (recoveryError) {
              finishOperationFromError(error.error);
              throw recoveryError;
            }
            if (compaction.compacted) {
              yield {
                type: "context_compacted",
                reason: "overflow_recovery",
                historyCompacted: compaction.historyCompacted,
                artifacts: compaction.artifactReports ?? [],
                ...compaction.stats,
              };
              for (const notice of compaction.artifactNotices ?? []) {
                yield { type: "tool_output_artifact", ...notice };
              }
              historicalCompactionAttemptedBeforeRequest = true;
              preflightCurrentOutputCompactionAttempted = true;
              continue;
            }
            if (compaction.failure !== undefined) {
              const recoveryError = new Error(compaction.failure.message);
              finishOperationFromError(error.error);
              throw recoveryError;
            }
          }
          finishOperationFromError(error.error);
          throw error.error;
        }
        finishOperationFromError(error);
        throw error;
      }
    }
  } catch (error) {
    finishOperationFromError(error);
    throw error;
  }
}
