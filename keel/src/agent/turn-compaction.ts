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
  hasSafeContextCompactionSplit,
  shouldCompactBeforeRequest,
  shouldCompactCurrentToolOutputBeforeHistoricalCompaction,
} from "./context-compaction.ts";
import {
  buildContextRescueReport,
  type ContextRescueReason,
  contextRescueReasonDetail,
  isProviderContextOverflowError,
} from "./context-rescue.ts";
import type { AgentEvent } from "./events.ts";
import {
  type AgentTurn,
  ContextOverflowBeforeAssistantError,
  type StreamTurnOptions,
  streamAgentTurn,
} from "./provider-turn.ts";
import {
  projectSessionLedgerToProviderMessages,
  type SessionLedger,
  sessionLedgerFromMessages,
} from "./session-ledger.ts";
import type { ToolOutputArtifactsOptions } from "./tool-output-artifacts.ts";

const ZERO_USAGE = {
  inputTokens: 0,
  cachedInputTokens: 0,
  uncachedInputTokens: 0,
  outputTokens: 0,
};

export interface CompactionConfig {
  readonly provider: LLMProvider;
  readonly systemPrompt: string;
  readonly signal: AbortSignal;
  readonly contextCompaction: ContextCompactionOptions | undefined;
  readonly toolOutputArtifacts?: ToolOutputArtifactsOptions;
  readonly costTracking: CostTrackingOptions | undefined;
  readonly onContextCompacted?: (messages: Message[]) => Promise<void>;
}

export type CompactionState = {
  contextAccounting: ContextCompactionAccountingSnapshot | undefined;
  accounting: RunAccounting;
};

export interface LedgerTurnOptions extends StreamTurnOptions {
  readonly getLedger: () => SessionLedger;
  readonly setLedger: (ledger: SessionLedger) => void;
}

interface AttemptContextCompactionOptions {
  readonly allowCurrentToolOutputCompaction?: boolean;
  readonly currentToolOutputCompactionReason?: CurrentToolOutputCompactionReason;
  readonly onlyCurrentToolOutputCompaction?: boolean;
  readonly currentToolOutputMaxCharsOverride?: number;
  readonly allowPreflightCurrentToolOutputRecompaction?: boolean;
  readonly restoreAfterCompaction?: boolean;
}

function requestMetadataForStream(
  options: StreamTurnOptions,
): ContextCompactionRequestMetadata {
  return {
    allowBash: options.allowBash,
    ...(options.toolChoice !== undefined
      ? { toolChoice: options.toolChoice }
      : {}),
  };
}

function contextRescueTurn(): AgentTurn {
  return {
    text: "",
    reasoningContent: null,
    toolCalls: [],
    usage: ZERO_USAGE,
    stopReason: "context_rescue",
  };
}

function hasNoSafeCompactionSplit(
  config: CompactionConfig,
  messages: readonly Message[],
): boolean {
  return !hasSafeContextCompactionSplit(messages, config.contextCompaction);
}

async function buildTurnContextRescueReport(options: {
  readonly config: CompactionConfig;
  readonly streamOptions: LedgerTurnOptions;
  readonly reason: ContextRescueReason;
  readonly reasonDetail: string;
  readonly messages?: readonly Message[];
}) {
  return buildContextRescueReport({
    reason: options.reason,
    reasonDetail: options.reasonDetail,
    systemPrompt: options.config.systemPrompt,
    messages:
      options.messages ??
      projectSessionLedgerToProviderMessages(options.streamOptions.getLedger()),
    contextCompaction: options.config.contextCompaction,
    toolOutputArtifacts: options.config.toolOutputArtifacts,
    requestMetadata: requestMetadataForStream(options.streamOptions),
  });
}

async function attemptContextCompaction(
  config: CompactionConfig,
  state: CompactionState,
  streamOptions: LedgerTurnOptions,
  options?: AttemptContextCompactionOptions,
): Promise<CompactMessagesResult> {
  const targetMessages = [
    ...projectSessionLedgerToProviderMessages(streamOptions.getLedger()),
  ];
  const requestMetadata = requestMetadataForStream(streamOptions);
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
    ...(options?.allowCurrentToolOutputCompaction === true
      ? { allowCurrentToolOutputCompaction: true }
      : {}),
    ...(options?.currentToolOutputCompactionReason !== undefined
      ? {
          currentToolOutputCompactionReason:
            options.currentToolOutputCompactionReason,
        }
      : {}),
    ...(options?.onlyCurrentToolOutputCompaction === true
      ? { onlyCurrentToolOutputCompaction: true }
      : {}),
    ...(options?.currentToolOutputMaxCharsOverride !== undefined
      ? {
          currentToolOutputMaxCharsOverride:
            options.currentToolOutputMaxCharsOverride,
        }
      : {}),
    ...(options?.allowPreflightCurrentToolOutputRecompaction === true
      ? { allowPreflightCurrentToolOutputRecompaction: true }
      : {}),
  });
  let finalResult = result;
  if (result.compacted) {
    state.contextAccounting = undefined;
    streamOptions.setLedger(sessionLedgerFromMessages(targetMessages));
    if (options?.restoreAfterCompaction !== false) {
      try {
        await config.onContextCompacted?.(targetMessages);
      } finally {
        streamOptions.setLedger(sessionLedgerFromMessages(targetMessages));
      }
    }
    finalResult = {
      ...result,
      stats: contextCompactionStatsForCurrentMessages({
        stats: result.stats,
        systemPrompt: config.systemPrompt,
        messages: targetMessages,
        requestMetadata,
      }),
    };
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
    },
  );
  if (!compaction.compacted) {
    return;
  }
  yield {
    type: "context_compacted",
    reason: "preflight",
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
  let overflowRecoveryProducedRetry = false;
  let historicalCompactionAttemptedBeforeRequest = false;
  let preflightCurrentOutputCompactionAttempted = false;

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
      let compaction: CompactMessagesResult;
      try {
        compaction = await attemptContextCompaction(
          config,
          state,
          streamOptions,
        );
      } catch (error) {
        if (isProviderContextOverflowError(error)) {
          yield {
            type: "context_rescue",
            report: await buildTurnContextRescueReport({
              config,
              streamOptions,
              reason: "summary_request_overflow",
              reasonDetail: contextRescueReasonDetail(error),
              messages: historicalRequestMessages,
            }),
          };
          return contextRescueTurn();
        }
        throw error;
      }
      if (compaction.compacted) {
        yield {
          type: "context_compacted",
          reason: "proactive",
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
      const turn = yield* streamAgentTurn({
        provider: streamOptions.provider,
        systemPrompt: streamOptions.systemPrompt,
        messages: currentRequestMessages,
        signal: streamOptions.signal,
        allowBash: streamOptions.allowBash,
        ...(streamOptions.toolChoice !== undefined
          ? { toolChoice: streamOptions.toolChoice }
          : {}),
        ...(streamOptions.textPrefix !== undefined
          ? { textPrefix: streamOptions.textPrefix }
          : {}),
      });
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
          let compaction: CompactMessagesResult;
          try {
            compaction = await attemptContextCompaction(
              config,
              state,
              streamOptions,
              {
                allowCurrentToolOutputCompaction: true,
                ...(preflightCurrentOutputCompactionAttempted
                  ? {
                      currentToolOutputMaxCharsOverride: 1,
                      allowPreflightCurrentToolOutputRecompaction: true,
                    }
                  : {}),
              },
            );
          } catch (compactionError) {
            if (isProviderContextOverflowError(compactionError)) {
              yield {
                type: "context_rescue",
                report: await buildTurnContextRescueReport({
                  config,
                  streamOptions,
                  reason: "summary_request_overflow",
                  reasonDetail: contextRescueReasonDetail(compactionError),
                }),
              };
              return contextRescueTurn();
            }
            throw compactionError;
          }
          if (compaction.compacted) {
            yield {
              type: "context_compacted",
              reason: "overflow_recovery",
              ...compaction.stats,
            };
            for (const notice of compaction.artifactNotices ?? []) {
              yield { type: "tool_output_artifact", ...notice };
            }
            historicalCompactionAttemptedBeforeRequest = true;
            preflightCurrentOutputCompactionAttempted = true;
            overflowRecoveryProducedRetry = true;
            continue;
          }
        }
        const recoveryMessages = projectSessionLedgerToProviderMessages(
          streamOptions.getLedger(),
        );
        const noSafeSplit =
          !overflowRecoveryProducedRetry &&
          hasNoSafeCompactionSplit(config, recoveryMessages);
        yield {
          type: "context_rescue",
          report: await buildTurnContextRescueReport({
            config,
            streamOptions,
            reason: noSafeSplit
              ? "no_safe_compaction_split"
              : "overflow_recovery_failed",
            reasonDetail: noSafeSplit
              ? "Provider rejected the request, and no tool-safe historical boundary is available for compaction."
              : contextRescueReasonDetail(error.error),
            messages: recoveryMessages,
          }),
        };
        return contextRescueTurn();
      }
      throw error;
    }
  }
}
