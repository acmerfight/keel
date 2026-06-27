import {
  type RecordLastBatchCheckpointOperation,
  recordLastTaskCheckpoint,
} from "../core/git.ts";
import type { LLMProvider, Message, ToolCall } from "../llm/types.ts";
import type { BashPermissionPolicy } from "../permissions/bash.ts";
import { executeToolCall, type ToolExecution } from "../tools/execution.ts";
import { toolCallConcurrency } from "../tools/registry.ts";
import {
  createProjectInstructionVisibilityState,
  type ProjectInstructionVisibilityState,
} from "../tools/scoped-project-instructions.ts";
import {
  addRequestAccounting,
  buildCostReport,
  type CostTrackingOptions,
  emptyRunAccounting,
} from "./accounting.ts";
import type { ContextCompactionOptions } from "./context-compaction.ts";
import type { AgentEvent } from "./events.ts";
import { restorePostCompactionReads } from "./post-compaction-restore.ts";
import type { AgentTurn } from "./provider-turn.ts";
import {
  createReadVisibilityState,
  type ReadVisibilityState,
} from "./read-visibility.ts";
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
import {
  type CompactionConfig,
  type CompactionState,
  type LedgerTurnOptions,
  streamTurnWithOverflowRecovery,
} from "./turn-compaction.ts";

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
  readonly projectInstructionVisibility?: ProjectInstructionVisibilityState;
  readonly recordCheckpointOperations?: (
    operations: readonly RecordLastBatchCheckpointOperation[],
  ) => void;
  readonly drainInjectedUserMessages?: () =>
    | readonly InjectedUserMessage[]
    | Promise<readonly InjectedUserMessage[]>;
}

function mutatedTargetPathsFromExecution(
  execution: ToolExecution,
): readonly string[] {
  if (!execution.ok) {
    return [];
  }
  const targetPaths: string[] = [];
  if (execution.mutatedTargetPath !== undefined) {
    targetPaths.push(execution.mutatedTargetPath);
  }
  if (execution.mutatedTargetPaths !== undefined) {
    targetPaths.push(...execution.mutatedTargetPaths);
  }
  return targetPaths;
}

function publishVisibleProjectInstructions(
  state: ProjectInstructionVisibilityState,
  executions: readonly ToolExecution[],
): void {
  for (const execution of executions) {
    if (execution.visibleProjectInstructionPaths === undefined) {
      continue;
    }
    state.markInstructionPathsVisible(execution.visibleProjectInstructionPaths);
  }
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

function agentStopReasonFromProvider(reason: AgentTurn["stopReason"]): string {
  return reason === "length" ? "provider_length" : "completed";
}

const WRAP_UP_INSTRUCTION =
  "You have used all available tool rounds for this task. Do not request any more tools. Briefly summarize what you completed and what remains to be done.";

const MISSING_SUMMARY_NOTICE =
  "\nReached the tool round limit before the task finished; the model did not provide a summary of the remaining work.";

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
  const projectInstructionVisibility =
    options.projectInstructionVisibility ??
    createProjectInstructionVisibilityState(workspace);
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
        projectInstructionVisibility,
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
        projectInstructions: projectInstructionVisibility,
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
          projectInstructionVisibility.applyMutationTargetPaths(
            mutatedTargetPathsFromExecution(execution),
          );
          completedToolExecutions.push(execution);
        }
      } else {
        const { toolCall } = segment.toolCall;
        yield { type: "tool_start", toolCall };
        const execution = await executeTurnToolCall(toolCall);
        yield { type: "tool_end", toolCall, ok: execution.ok };
        recordToolExecution(toolCall, execution);
        readVisibility.applyImmediateMutation(execution);
        projectInstructionVisibility.applyMutationTargetPaths(
          mutatedTargetPathsFromExecution(execution),
        );
        completedToolExecutions.push(execution);
      }
    }
    readVisibility.applyVisibleToolExecutions(completedToolExecutions);
    publishVisibleProjectInstructions(
      projectInstructionVisibility,
      completedToolExecutions,
    );

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
  const projectInstructionVisibility = createProjectInstructionVisibilityState(
    options.workspace,
  );
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
      projectInstructionVisibility,
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
