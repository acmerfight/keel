import type { SessionTaskProgress } from "../core/task-progress.ts";
import type { LLMProvider, Message } from "../llm/types.ts";
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
  type CurrentToolOutputCompactionReason,
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
  ModelOperationPurpose,
  ModelOperationRecoveryTarget,
} from "./model-operations.ts";
import {
  type AgentTurn,
  ContextOverflowBeforeAssistantError,
  type StreamTurnOptions,
  streamAgentTurn,
} from "./provider-turn.ts";
import {
  projectSessionLedgerToProviderMessages,
  restoreSessionResourceObservations,
  type SessionLedger,
  sessionLedgerFromMessages,
  sessionLedgerMessages,
} from "./session-ledger.ts";
import type { ToolOutputArtifactsOptions } from "./tool-output-artifacts.ts";

export interface CompactionConfig {
  readonly provider: LLMProvider;
  readonly systemPrompt: string;
  readonly signal: AbortSignal;
  readonly contextCompaction: ContextCompactionOptions | undefined;
  readonly toolOutputArtifacts?: ToolOutputArtifactsOptions;
  readonly taskProgress?: () => SessionTaskProgress;
  readonly costTracking: CostTrackingOptions | undefined;
  readonly modelOperations: ModelOperationInstrumentation | null;
  readonly onContextCompacted: (
    messages: Message[],
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
  readonly getLedger: () => SessionLedger;
  readonly setLedger: (ledger: SessionLedger) => void;
  readonly modelOperationPurpose: Extract<
    ModelOperationPurpose,
    "agent_turn" | "turn_limit_summary"
  >;
}

interface AttemptContextCompactionOptions {
  readonly allowCurrentToolOutputCompaction?: boolean;
  readonly currentToolOutputCompactionReason?: CurrentToolOutputCompactionReason;
  readonly onlyCurrentToolOutputCompaction?: boolean;
  readonly currentToolOutputMaxCharsOverride?: number;
  readonly allowPreflightCurrentToolOutputRecompaction?: boolean;
  readonly requireShrinkingHistoryCompaction?: boolean;
  readonly restoreAfterCompaction?: boolean;
  readonly modelOperationRecoveryFor: ModelOperationRecoveryTarget | null;
}

function requestMetadataForStream(
  options: StreamTurnOptions,
): ContextCompactionRequestMetadata {
  return {
    allowBash: options.allowBash,
    ...(options.allowSkill !== undefined
      ? { allowSkill: options.allowSkill }
      : {}),
    ...(options.toolChoice !== undefined
      ? { toolChoice: options.toolChoice }
      : {}),
  };
}

async function attemptContextCompaction(
  config: CompactionConfig,
  state: CompactionState,
  streamOptions: LedgerTurnOptions,
  options: AttemptContextCompactionOptions,
): Promise<CompactMessagesResult> {
  const sourceMessages = sessionLedgerMessages(streamOptions.getLedger());
  const targetMessages = [
    ...projectSessionLedgerToProviderMessages(streamOptions.getLedger()),
  ];
  const requestMetadata = requestMetadataForStream(streamOptions);
  const taskProgress = config.taskProgress?.();
  const result = await compactMessages({
    provider: config.provider,
    systemPrompt: config.systemPrompt,
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
    ...(options.allowCurrentToolOutputCompaction === true
      ? { allowCurrentToolOutputCompaction: true }
      : {}),
    ...(options.currentToolOutputCompactionReason !== undefined
      ? {
          currentToolOutputCompactionReason:
            options.currentToolOutputCompactionReason,
        }
      : {}),
    ...(options.onlyCurrentToolOutputCompaction === true
      ? { onlyCurrentToolOutputCompaction: true }
      : {}),
    ...(options.currentToolOutputMaxCharsOverride !== undefined
      ? {
          currentToolOutputMaxCharsOverride:
            options.currentToolOutputMaxCharsOverride,
        }
      : {}),
    ...(options.allowPreflightCurrentToolOutputRecompaction === true
      ? { allowPreflightCurrentToolOutputRecompaction: true }
      : {}),
    ...(config.modelOperations !== null
      ? {
          modelOperation: {
            instrumentation: config.modelOperations,
            purpose: "context_compaction" as const,
            recoveryFor: options.modelOperationRecoveryFor,
          },
        }
      : {}),
  });
  let finalResult = result;
  if (result.compacted) {
    restoreSessionResourceObservations(targetMessages, sourceMessages);
    let finalization = NO_CONTEXT_COMPACTION_FINALIZATION;
    if (options.restoreAfterCompaction !== false) {
      finalization = await config.onContextCompacted(targetMessages);
    }

    const finalStats = contextCompactionStatsForCurrentMessages({
      stats: result.stats,
      systemPrompt: config.systemPrompt,
      messages: targetMessages,
      requestMetadata,
    });
    const rejectsGrowingHistoryCompaction =
      options.requireShrinkingHistoryCompaction === true &&
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
      streamOptions.setLedger(sessionLedgerFromMessages(targetMessages));
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
      allowCurrentToolOutputCompaction: true,
      currentToolOutputCompactionReason: "preflight",
      onlyCurrentToolOutputCompaction: true,
      restoreAfterCompaction: false,
      modelOperationRecoveryFor: null,
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
  const operationPurpose: ModelOperationPurpose =
    streamOptions.modelOperationPurpose;
  let operation: ModelOperationHandle | null = null;
  let operationFinished = false;
  const startOperation = (): ModelOperationHandle | null => {
    if (operation !== null || config.modelOperations === null) {
      return operation;
    }
    operation = config.modelOperations.recorder.beginModelOperation({
      ...config.modelOperations,
      purpose: operationPurpose,
      recoveryFor: null,
    });
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
      const requestMessages = projectSessionLedgerToProviderMessages(
        streamOptions.getLedger(),
      );
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
      const historicalRequestMessages = projectSessionLedgerToProviderMessages(
        streamOptions.getLedger(),
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
            requireShrinkingHistoryCompaction: true,
            modelOperationRecoveryFor: null,
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
      const preflightRequestMessages = projectSessionLedgerToProviderMessages(
        streamOptions.getLedger(),
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
          streamOptions.getLedger(),
        );
        const currentOperation = startOperation();
        const turn = yield* streamAgentTurn({
          provider: streamOptions.provider,
          systemPrompt: streamOptions.systemPrompt,
          messages: currentRequestMessages,
          signal: streamOptions.signal,
          allowBash: streamOptions.allowBash,
          ...(streamOptions.allowSkill !== undefined
            ? { allowSkill: streamOptions.allowSkill }
            : {}),
          ...(streamOptions.toolChoice !== undefined
            ? { toolChoice: streamOptions.toolChoice }
            : {}),
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
                systemPrompt: config.systemPrompt,
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
                  allowCurrentToolOutputCompaction: true,
                  modelOperationRecoveryFor: recoveryFor,
                  ...(preflightCurrentOutputCompactionAttempted
                    ? {
                        currentToolOutputMaxCharsOverride: 1,
                        allowPreflightCurrentToolOutputRecompaction: true,
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
