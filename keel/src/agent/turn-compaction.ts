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
  captureContextCompactionAccountingSnapshot,
  compactMessages,
  contextCompactionStatsForCurrentMessages,
  shouldCompactBeforeRequest,
} from "./context-compaction.ts";
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

export interface CompactionConfig {
  readonly provider: LLMProvider;
  readonly systemPrompt: string;
  readonly signal: AbortSignal;
  readonly contextCompaction: ContextCompactionOptions | undefined;
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
    ...(state.contextAccounting !== undefined
      ? { contextAccounting: state.contextAccounting }
      : {}),
    requestMetadata,
    ...(options?.allowCurrentToolOutputCompaction === true
      ? { allowCurrentToolOutputCompaction: true }
      : {}),
  });
  let finalResult = result;
  if (result.compacted) {
    state.contextAccounting = undefined;
    streamOptions.setLedger(sessionLedgerFromMessages(targetMessages));
    try {
      await config.onContextCompacted?.(targetMessages);
    } finally {
      streamOptions.setLedger(sessionLedgerFromMessages(targetMessages));
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

export async function* streamTurnWithOverflowRecovery(
  config: CompactionConfig,
  state: CompactionState,
  streamOptions: LedgerTurnOptions,
): AsyncGenerator<AgentEvent, AgentTurn> {
  let overflowRecoveryAttempted = false;
  let compactedBeforeRequest = false;

  for (;;) {
    const requestMessages = projectSessionLedgerToProviderMessages(
      streamOptions.getLedger(),
    );
    if (
      !compactedBeforeRequest &&
      shouldCompactBeforeRequest(
        config.systemPrompt,
        requestMessages,
        config.contextCompaction,
        state.contextAccounting,
        requestMetadataForStream(streamOptions),
      )
    ) {
      compactedBeforeRequest = true;
      const compaction = await attemptContextCompaction(
        config,
        state,
        streamOptions,
      );
      if (compaction.compacted) {
        yield {
          type: "context_compacted",
          reason: "proactive",
          ...compaction.stats,
        };
      }
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
          const compaction = await attemptContextCompaction(
            config,
            state,
            streamOptions,
            { allowCurrentToolOutputCompaction: true },
          );
          if (compaction.compacted) {
            yield {
              type: "context_compacted",
              reason: "overflow_recovery",
              ...compaction.stats,
            };
            compactedBeforeRequest = true;
            continue;
          }
        }
        throw error.error;
      }
      throw error;
    }
  }
}
