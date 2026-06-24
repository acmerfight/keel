import { type CostModel, calculateRequestCostBatchUsd } from "../core/cost.ts";
import { KeelError } from "../core/error.ts";
import {
  type RecordLastBatchCheckpointOperation,
  recordLastTaskCheckpoint,
} from "../core/git.ts";
import type {
  LLMProvider,
  LLMStopReason,
  Message,
  ToolCall,
  Usage,
} from "../llm/types.ts";
import type { BashPermissionPolicy } from "../permissions/bash.ts";
import { executeToolCall, type ToolExecution } from "../tools/execution.ts";
import {
  normalizeProviderToolCall,
  toolCallConcurrency,
} from "../tools/registry.ts";
import {
  type CompactMessagesResult,
  type ContextCompactionAccountingSnapshot,
  type ContextCompactionOptions,
  type ContextCompactionRequestMetadata,
  type ContextCompactionStats,
  captureContextCompactionAccountingSnapshot,
  compactMessages,
  contextCompactionStatsForCurrentMessages,
  shouldCompactBeforeRequest,
} from "./context-compaction.ts";
import {
  appendSessionLedgerMessage,
  appendSessionLedgerMessages,
  projectSessionLedgerToProviderMessages,
  type SessionLedger,
  sessionLedgerFromMessages,
  syncMessagesFromSessionLedger,
} from "./session-ledger.ts";
import type { AgentStopPolicy } from "./stop-policy.ts";
import {
  executeParallelToolCallsInSourceOrder,
  planToolCallExecutionSegments,
  type ScheduledToolCall,
} from "./tool-scheduler.ts";

export interface CostReport {
  readonly spentUsd: number;
  readonly maxUsd?: number;
  readonly budgetExceeded: boolean;
}

interface CostTrackingOptions {
  readonly model: CostModel;
  readonly maxCostUsd?: number;
}

// stopReason is "completed" when the assistant finished with a plain answer;
// otherwise it is the stop policy's reason label (e.g. "cost_budget",
// "repeated_tool_call", "turn_limit").
type ContextCompactionReason = "proactive" | "overflow_recovery";
const POST_COMPACTION_MAX_RESTORED_FILES = 5;
const POST_COMPACTION_MAX_FILE_CHARS = 20_000;
const POST_COMPACTION_MAX_TOTAL_CHARS = 50_000;

export type AgentEvent =
  | { readonly type: "text"; readonly text: string }
  | ({
      readonly type: "context_compacted";
      readonly reason: ContextCompactionReason;
    } & ContextCompactionStats)
  | {
      readonly type: "provider_retry";
      readonly provider: string;
      readonly reason: string;
      readonly attempt: number;
      readonly maxRetries: number;
      readonly delayMs: number;
    }
  | { readonly type: "tool_start"; readonly toolCall: ToolCall }
  | {
      readonly type: "tool_end";
      readonly toolCall: ToolCall;
      readonly ok: boolean;
    }
  | {
      readonly type: "end";
      readonly usage: Usage;
      readonly turns: number;
      readonly stopReason: string;
      readonly cost?: CostReport;
    };

export interface RunAgentOptions {
  readonly workspace: string;
  readonly provider: LLMProvider;
  readonly userMessage: string;
  readonly systemPrompt: string;
  readonly signal: AbortSignal;
  readonly allowBash: boolean;
  readonly stopPolicy: AgentStopPolicy;
  readonly costTracking?: CostTrackingOptions;
  readonly bashPermission?: BashPermissionPolicy;
  readonly contextCompaction?: ContextCompactionOptions;
  readonly onTranscriptReady?: (messages: readonly Message[]) => void;
}

type InjectedUserMessage = Extract<Message, { readonly role: "user" }>;

export interface RunAgentTurnOptions {
  readonly workspace: string;
  readonly provider: LLMProvider;
  // Mutated in place: user messages are supplied by the session owner, while
  // agent turns append assistant/tool messages so later turns share context.
  readonly messages: Message[];
  readonly systemPrompt: string;
  readonly signal: AbortSignal;
  readonly allowBash: boolean;
  readonly stopPolicy: AgentStopPolicy;
  readonly costTracking?: CostTrackingOptions;
  readonly bashPermission?: BashPermissionPolicy;
  readonly contextCompaction?: ContextCompactionOptions;
  readonly readVisibility?: ReadVisibilityState;
  readonly recordCheckpointOperations?: (
    operations: readonly RecordLastBatchCheckpointOperation[],
  ) => void;
  readonly drainInjectedUserMessages?: () =>
    | readonly InjectedUserMessage[]
    | Promise<readonly InjectedUserMessage[]>;
}

class ContextOverflowBeforeAssistantError extends Error {
  readonly error: unknown;

  constructor(error: unknown) {
    super("Provider context overflowed before assistant output started");
    this.name = "ContextOverflowBeforeAssistantError";
    this.error = error;
  }
}

function isProviderContextOverflow(error: unknown): boolean {
  return (
    error instanceof KeelError && error.code === "provider_context_overflow"
  );
}

interface AgentTurn {
  readonly text: string;
  readonly toolCalls: readonly ToolCall[];
  readonly usage: Usage;
  readonly stopReason: LLMStopReason;
}

interface AgentTurnStop {
  readonly usage: Usage;
  readonly reason: LLMStopReason;
}

interface VisibleReadSnapshot {
  readonly targetPath: string;
  readonly offset?: number;
  readonly limit?: number;
}

export interface ReadVisibilityState {
  readonly hasRead: (targetPath: string) => boolean;
  readonly visibleReadsMostRecentFirst: () => readonly VisibleReadSnapshot[];
  readonly clear: () => void;
  readonly applyImmediateMutation: (execution: ToolExecution) => void;
  readonly applyVisibleToolExecutions: (
    executions: readonly ToolExecution[],
  ) => void;
}

export function createReadVisibilityState(): ReadVisibilityState {
  const visibleReads = new Map<string, VisibleReadSnapshot>();
  const applyMutation = (execution: ToolExecution): void => {
    if (execution.ok && execution.mutatedTargetPath !== undefined) {
      visibleReads.delete(execution.mutatedTargetPath);
    }
    if (execution.ok && execution.mutatedTargetPaths !== undefined) {
      for (const targetPath of execution.mutatedTargetPaths) {
        visibleReads.delete(targetPath);
      }
    }
  };
  return {
    hasRead: (targetPath) => visibleReads.has(targetPath),
    visibleReadsMostRecentFirst: () => [...visibleReads.values()].reverse(),
    clear: () => visibleReads.clear(),
    applyImmediateMutation: applyMutation,
    applyVisibleToolExecutions: (executions) => {
      for (const execution of executions) {
        if (!execution.ok) continue;
        applyMutation(execution);
        if (execution.readTargetPath !== undefined) {
          // Delete+set refreshes Map insertion order so iteration is recency ordered.
          visibleReads.delete(execution.readTargetPath);
          visibleReads.set(execution.readTargetPath, {
            targetPath: execution.readTargetPath,
            ...(execution.readTargetOffset !== undefined
              ? { offset: execution.readTargetOffset }
              : {}),
            ...(execution.readTargetLimit !== undefined
              ? { limit: execution.readTargetLimit }
              : {}),
          });
        }
      }
    },
  };
}

export function clearReadVisibilityState(state: ReadVisibilityState): void {
  state.clear();
}

function addUsage(left: Usage, right: Usage): Usage {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
    uncachedInputTokens: left.uncachedInputTokens + right.uncachedInputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
  };
}

function priorToolCallsFromMessages(messages: readonly Message[]): ToolCall[] {
  const lastUserIndex = messages.findLastIndex(
    (message) => message.role === "user",
  );
  const currentTurnHistory =
    lastUserIndex < 0 ? messages : messages.slice(lastUserIndex + 1);
  return currentTurnHistory.flatMap((message) =>
    message.role === "assistant" ? message.toolCalls : [],
  );
}

function toolRequestMessage(turn: AgentTurn): Message {
  return {
    role: "assistant",
    content: turn.text,
    toolCalls: turn.toolCalls,
  };
}

function scheduledToolCalls(
  toolCalls: readonly ToolCall[],
): readonly ScheduledToolCall[] {
  return toolCalls.map((toolCall) => ({
    toolCall,
    concurrency: toolCallConcurrency(toolCall),
  }));
}

function finalReplyMessage(text: string): Message | null {
  return text === ""
    ? null
    : { role: "assistant", content: text, toolCalls: [] };
}

function finishAgentTurn(
  assistantText: readonly string[],
  pendingToolCalls: readonly ToolCall[],
  stop: AgentTurnStop | null,
): AgentTurn {
  if (stop === null) {
    throw new KeelError(
      "agent_missing_stop",
      "LLM stream ended without stop event",
    );
  }
  if (stop.reason === "length" && pendingToolCalls.length > 0) {
    throw new KeelError(
      "provider_protocol_error",
      "LLM stream stopped with length after tool calls",
    );
  }

  return {
    text: assistantText.join(""),
    toolCalls: pendingToolCalls,
    usage: stop.usage,
    stopReason: stop.reason,
  };
}

function agentStopReasonFromProvider(reason: LLMStopReason): string {
  return reason === "length" ? "provider_length" : "completed";
}

function buildCostReport(
  spentUsd: number,
  costTracking: CostTrackingOptions | undefined,
): CostReport | undefined {
  if (costTracking === undefined) {
    return undefined;
  }
  const budgetExceeded =
    costTracking.maxCostUsd !== undefined && spentUsd > costTracking.maxCostUsd;
  return {
    spentUsd,
    ...(costTracking.maxCostUsd !== undefined
      ? { maxUsd: costTracking.maxCostUsd }
      : {}),
    budgetExceeded,
  };
}

interface RunAccounting {
  readonly totalUsage: Usage;
  readonly totalCostUsd: number;
}

function emptyRunAccounting(): RunAccounting {
  return {
    totalUsage: {
      inputTokens: 0,
      cachedInputTokens: 0,
      uncachedInputTokens: 0,
      outputTokens: 0,
    },
    totalCostUsd: 0,
  };
}

function addRequestAccounting(
  accounting: RunAccounting,
  requestUsage: Usage,
  costTracking: CostTrackingOptions | undefined,
): RunAccounting {
  return {
    totalUsage: addUsage(accounting.totalUsage, requestUsage),
    totalCostUsd:
      costTracking === undefined
        ? accounting.totalCostUsd
        : accounting.totalCostUsd +
          calculateRequestCostBatchUsd(
            { requests: [{ usage: requestUsage }] },
            costTracking.model,
          ),
  };
}

const WRAP_UP_INSTRUCTION =
  "You have used all available tool rounds for this task. Do not request any more tools. Briefly summarize what you completed and what remains to be done.";

const MISSING_SUMMARY_NOTICE =
  "\nReached the tool round limit before the task finished; the model did not provide a summary of the remaining work.";

interface StreamTurnOptions {
  readonly provider: LLMProvider;
  readonly systemPrompt: string;
  readonly signal: AbortSignal;
  readonly allowBash: boolean;
  readonly toolChoice?: "none";
  readonly textPrefix?: string;
}

interface LedgerTurnOptions extends StreamTurnOptions {
  readonly getLedger: () => SessionLedger;
  readonly setLedger: (ledger: SessionLedger) => void;
}

interface ProviderTurnOptions extends StreamTurnOptions {
  readonly messages: readonly Message[];
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

async function* streamAgentTurn(
  options: ProviderTurnOptions,
): AsyncGenerator<AgentEvent, AgentTurn> {
  const { provider, systemPrompt, messages, signal, allowBash } = options;
  let textPrefix = options.textPrefix ?? "";
  const stream = provider.stream({
    systemPrompt,
    messages,
    signal,
    ...(allowBash ? { allowBash: true } : {}),
    ...(options.toolChoice !== undefined
      ? { toolChoice: options.toolChoice }
      : {}),
  });

  let stop: AgentTurnStop | null = null;
  const assistantText: string[] = [];
  const pendingToolCalls: ToolCall[] = [];
  let assistantStarted = false;

  try {
    for await (const event of stream) {
      switch (event.type) {
        case "text":
          if (event.text !== "") {
            assistantStarted = true;
          }
          if (event.text !== "" && textPrefix !== "") {
            if (!event.text.startsWith("\n")) {
              assistantText.push(textPrefix);
              yield { type: "text", text: textPrefix };
            }
            textPrefix = "";
          }
          assistantText.push(event.text);
          yield { type: "text", text: event.text };
          break;
        case "tool_call": {
          assistantStarted = true;
          const { type: _llmEventType, ...toolCall } = event;
          if (toolCall.tool === "edit") {
            pendingToolCalls.push(normalizeProviderToolCall(toolCall));
          } else {
            pendingToolCalls.push(toolCall);
          }
          break;
        }
        case "provider_retry":
          yield event;
          break;
        case "stop":
          stop = { usage: event.usage, reason: event.reason };
          break;
      }
    }
  } catch (error) {
    if (isProviderContextOverflow(error) && !assistantStarted) {
      throw new ContextOverflowBeforeAssistantError(error);
    }
    throw error;
  }

  return finishAgentTurn(assistantText, pendingToolCalls, stop);
}

interface CompactionConfig {
  readonly provider: LLMProvider;
  readonly systemPrompt: string;
  readonly signal: AbortSignal;
  readonly contextCompaction: ContextCompactionOptions | undefined;
  readonly costTracking: CostTrackingOptions | undefined;
  readonly onContextCompacted?: (messages: Message[]) => Promise<void>;
}

type CompactionState = {
  contextAccounting: ContextCompactionAccountingSnapshot | undefined;
  accounting: RunAccounting;
};

async function attemptContextCompaction(
  config: CompactionConfig,
  state: CompactionState,
  streamOptions: LedgerTurnOptions,
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

function fitPostCompactionReadContent(
  content: string,
  maxChars: number,
): { readonly content: string; readonly complete: boolean } {
  if (content.length <= maxChars) {
    return { content, complete: true };
  }
  let omittedChars = content.length - maxChars;
  for (;;) {
    const marker = `\n\n[Post-compaction read snapshot truncated: omitted ${omittedChars} chars]`;
    if (marker.length >= maxChars) {
      return { content: marker.slice(0, maxChars), complete: false };
    }
    const prefixLength = maxChars - marker.length;
    const nextOmittedChars = content.length - prefixLength;
    if (nextOmittedChars === omittedChars) {
      return {
        content: `${content.slice(0, prefixLength)}${marker}`,
        complete: false,
      };
    }
    // Marker digit width depends on omittedChars, so settle to the exact count.
    omittedChars = nextOmittedChars;
  }
}

interface RestoredPostCompactionRead {
  readonly toolCall: ToolCall;
  readonly execution: ToolExecution;
  readonly content: string;
  readonly complete: boolean;
}

export async function restorePostCompactionReads(options: {
  readonly workspace: string;
  readonly signal: AbortSignal;
  readonly readVisibility: ReadVisibilityState;
  readonly messages: Message[];
  readonly nextToolCallId: () => string;
}): Promise<void> {
  const targetPaths = options.readVisibility
    .visibleReadsMostRecentFirst()
    .slice(0, POST_COMPACTION_MAX_RESTORED_FILES);
  clearReadVisibilityState(options.readVisibility);
  const restored: RestoredPostCompactionRead[] = [];
  let totalChars = 0;

  for (const read of targetPaths) {
    const remainingTotalChars = POST_COMPACTION_MAX_TOTAL_CHARS - totalChars;
    if (remainingTotalChars <= 0) {
      break;
    }
    const toolCall: ToolCall = {
      id: options.nextToolCallId(),
      tool: "read",
      path: read.targetPath,
      ...(read.offset !== undefined ? { offset: read.offset } : {}),
      ...(read.limit !== undefined ? { limit: read.limit } : {}),
    };
    const execution = await executeToolCall({
      workspace: options.workspace,
      toolCall,
      signal: options.signal,
      allowBash: false,
    });
    if (!execution.ok || execution.readTargetPath === undefined) {
      continue;
    }
    const fittedContent = fitPostCompactionReadContent(
      execution.content,
      Math.min(POST_COMPACTION_MAX_FILE_CHARS, remainingTotalChars),
    );
    totalChars += fittedContent.content.length;
    restored.push({
      toolCall,
      execution,
      content: fittedContent.content,
      complete: fittedContent.complete,
    });
  }

  if (restored.length === 0) {
    return;
  }

  options.messages.push({
    role: "assistant",
    content: "",
    toolCalls: restored.map((read) => read.toolCall),
  });
  for (const read of restored) {
    options.messages.push({
      role: "tool",
      toolCallId: read.toolCall.id,
      content: read.content,
    });
  }
  options.readVisibility.applyVisibleToolExecutions(
    restored.filter((read) => read.complete).map((read) => read.execution),
  );
}

async function* streamTurnWithOverflowRecovery(
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
      if (compaction.stats !== undefined) {
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
          );
          if (compaction.compacted) {
            if (compaction.stats !== undefined) {
              yield {
                type: "context_compacted",
                reason: "overflow_recovery",
                ...compaction.stats,
              };
            }
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

interface WrapUpSummarizeOptions {
  readonly config: CompactionConfig;
  readonly state: CompactionState;
  readonly streamOptions: Omit<LedgerTurnOptions, "getLedger" | "setLedger">;
  readonly turnText: string;
  readonly sessionLedger: SessionLedger;
}

async function* streamWrapUpSummary(
  options: WrapUpSummarizeOptions,
): AsyncGenerator<AgentEvent, AgentTurn> {
  const { config, state, streamOptions, turnText, sessionLedger } = options;
  const interimReply = finalReplyMessage(turnText);
  let wrapUpLedger =
    interimReply !== null
      ? appendSessionLedgerMessage(sessionLedger, interimReply)
      : sessionLedger;
  wrapUpLedger = appendSessionLedgerMessage(wrapUpLedger, {
    role: "user",
    content: WRAP_UP_INSTRUCTION,
  });
  const setWrapUpLedger = (next: SessionLedger) => {
    wrapUpLedger = next;
  };
  return yield* streamTurnWithOverflowRecovery(config, state, {
    ...streamOptions,
    getLedger: () => wrapUpLedger,
    setLedger: setWrapUpLedger,
    toolChoice: "none",
    textPrefix: turnText === "" || turnText.endsWith("\n") ? "" : "\n",
  });
}

export async function* runAgentTurn(
  options: RunAgentTurnOptions,
): AsyncGenerator<AgentEvent> {
  const {
    workspace,
    provider,
    messages,
    systemPrompt,
    signal,
    costTracking,
    allowBash,
    bashPermission,
    stopPolicy,
    drainInjectedUserMessages,
  } = options;
  let sessionLedger = sessionLedgerFromMessages(messages);
  const applySessionLedger = (next: SessionLedger) => {
    sessionLedger = next;
    syncMessagesFromSessionLedger(messages, sessionLedger);
  };
  const providerMessages =
    projectSessionLedgerToProviderMessages(sessionLedger);
  const priorToolCalls = priorToolCallsFromMessages(providerMessages);
  const readVisibility = options.readVisibility ?? createReadVisibilityState();
  let postCompactionReadSequence = 0;
  const config: CompactionConfig = {
    provider,
    systemPrompt,
    signal,
    contextCompaction: options.contextCompaction,
    costTracking,
    onContextCompacted: async (targetMessages) => {
      await restorePostCompactionReads({
        workspace,
        signal,
        readVisibility,
        messages: targetMessages,
        nextToolCallId: () =>
          `post_compaction_read_${postCompactionReadSequence++}`,
      });
    },
  };
  const state: CompactionState = {
    contextAccounting: undefined,
    accounting: emptyRunAccounting(),
  };

  for (let completedTurns = 1; ; completedTurns++) {
    const turnResult = yield* streamTurnWithOverflowRecovery(config, state, {
      provider,
      systemPrompt,
      getLedger: () => sessionLedger,
      setLedger: applySessionLedger,
      signal,
      allowBash,
    });
    state.accounting = addRequestAccounting(
      state.accounting,
      turnResult.usage,
      costTracking,
    );
    const cost = buildCostReport(state.accounting.totalCostUsd, costTracking);

    const decision = stopPolicy.shouldStopAfterTurn({
      completedTurns,
      toolCalls: turnResult.toolCalls,
      priorToolCalls,
      ...(cost !== undefined ? { cost } : {}),
    });

    if (decision.type === "stop") {
      const reply = finalReplyMessage(turnResult.text);
      if (reply !== null) {
        applySessionLedger(appendSessionLedgerMessage(sessionLedger, reply));
      }
      yield {
        type: "end",
        usage: state.accounting.totalUsage,
        turns: completedTurns,
        stopReason: decision.reason,
        ...(cost !== undefined ? { cost } : {}),
      };
      return;
    }

    if (decision.type === "summarize") {
      const wrapUpTurn = yield* streamWrapUpSummary({
        config,
        state,
        streamOptions: { provider, systemPrompt, signal, allowBash },
        turnText: turnResult.text,
        sessionLedger,
      });
      const summary =
        wrapUpTurn.text === "" ? MISSING_SUMMARY_NOTICE : wrapUpTurn.text;
      if (wrapUpTurn.text === "") {
        yield { type: "text", text: MISSING_SUMMARY_NOTICE };
      }
      const combinedReply = finalReplyMessage(`${turnResult.text}${summary}`);
      if (combinedReply !== null) {
        applySessionLedger(
          appendSessionLedgerMessage(sessionLedger, combinedReply),
        );
      }
      state.accounting = addRequestAccounting(
        state.accounting,
        wrapUpTurn.usage,
        costTracking,
      );
      const finalCost = buildCostReport(
        state.accounting.totalCostUsd,
        costTracking,
      );
      yield {
        type: "end",
        usage: state.accounting.totalUsage,
        turns: completedTurns + 1,
        stopReason: decision.reason,
        ...(finalCost !== undefined ? { cost: finalCost } : {}),
      };
      return;
    }

    if (turnResult.toolCalls.length === 0) {
      const reply = finalReplyMessage(turnResult.text);
      if (reply !== null) {
        applySessionLedger(appendSessionLedgerMessage(sessionLedger, reply));
      }
      yield {
        type: "end",
        usage: state.accounting.totalUsage,
        turns: completedTurns,
        stopReason: agentStopReasonFromProvider(turnResult.stopReason),
        ...(cost !== undefined ? { cost } : {}),
      };
      return;
    }

    applySessionLedger(
      appendSessionLedgerMessage(sessionLedger, toolRequestMessage(turnResult)),
    );
    priorToolCalls.push(...turnResult.toolCalls);

    const executeTurnToolCall = async (
      toolCall: ToolCall,
    ): Promise<ToolExecution> =>
      await executeToolCall({
        workspace,
        toolCall,
        signal,
        allowBash,
        readBeforeEdit: {
          hasRead: readVisibility.hasRead,
        },
        ...(bashPermission !== undefined ? { bashPermission } : {}),
      });

    const recordToolExecution = (
      toolCall: ToolCall,
      execution: ToolExecution,
    ): void => {
      if (
        execution.ok &&
        execution.checkpointOperations !== undefined &&
        execution.checkpointOperations.length > 0
      ) {
        options.recordCheckpointOperations?.(execution.checkpointOperations);
      }
      applySessionLedger(
        appendSessionLedgerMessage(sessionLedger, {
          role: "tool",
          toolCallId: toolCall.id,
          content: execution.content,
        }),
      );
    };

    const scheduled = scheduledToolCalls(turnResult.toolCalls);
    const completedToolExecutions: ToolExecution[] = [];
    for (const segment of planToolCallExecutionSegments(scheduled)) {
      if (segment.kind === "parallel") {
        for (const { toolCall } of segment.toolCalls) {
          yield { type: "tool_start", toolCall };
        }
        const results = await executeParallelToolCallsInSourceOrder({
          toolCalls: segment.toolCalls,
          execute: executeTurnToolCall,
        });
        for (const result of results) {
          if (result.status === "rejected") {
            throw result.reason;
          }
          const { toolCall, result: execution } = result;
          yield { type: "tool_end", toolCall, ok: execution.ok };
          recordToolExecution(toolCall, execution);
          readVisibility.applyImmediateMutation(execution);
          completedToolExecutions.push(execution);
        }
      } else {
        const { toolCall } = segment.toolCall;
        yield { type: "tool_start", toolCall };
        const execution = await executeTurnToolCall(toolCall);
        yield { type: "tool_end", toolCall, ok: execution.ok };
        recordToolExecution(toolCall, execution);
        readVisibility.applyImmediateMutation(execution);
        completedToolExecutions.push(execution);
      }
    }
    readVisibility.applyVisibleToolExecutions(completedToolExecutions);

    if (drainInjectedUserMessages !== undefined && !signal.aborted) {
      applySessionLedger(
        appendSessionLedgerMessages(
          sessionLedger,
          await drainInjectedUserMessages(),
        ),
      );
    }
  }
}

export async function* runAgent(
  options: RunAgentOptions,
): AsyncGenerator<AgentEvent> {
  const messages: Message[] = [{ role: "user", content: options.userMessage }];
  const readVisibility = createReadVisibilityState();
  const checkpointOperations: RecordLastBatchCheckpointOperation[] = [];
  try {
    yield* runAgentTurn({
      workspace: options.workspace,
      provider: options.provider,
      messages,
      systemPrompt: options.systemPrompt,
      signal: options.signal,
      allowBash: options.allowBash,
      stopPolicy: options.stopPolicy,
      readVisibility,
      recordCheckpointOperations: (operations) => {
        checkpointOperations.push(...operations);
      },
      ...(options.costTracking !== undefined
        ? { costTracking: options.costTracking }
        : {}),
      ...(options.bashPermission !== undefined
        ? { bashPermission: options.bashPermission }
        : {}),
      ...(options.contextCompaction !== undefined
        ? { contextCompaction: options.contextCompaction }
        : {}),
    });
    options.onTranscriptReady?.(messages);
  } finally {
    if (checkpointOperations.length > 1) {
      recordLastTaskCheckpoint({
        workspace: options.workspace,
        operations: checkpointOperations,
      });
    }
  }
}
