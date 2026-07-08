import {
  type RecordLastBatchCheckpointOperation,
  recordLastTaskCheckpoint,
} from "../core/git.ts";
import {
  copySessionGoal,
  normalizeSessionGoalCompletionCommand,
  type SessionGoal,
} from "../core/session-goal.ts";
import {
  copySessionTaskProgress,
  emptySessionTaskProgress,
  type SessionTaskProgress,
} from "../core/task-progress.ts";
import type {
  AssistantProviderMetadata,
  LLMProvider,
  Message,
  ToolCall,
} from "../llm/types.ts";
import type { BashPermissionPolicy } from "../permissions/bash.ts";
import {
  executeToolCall,
  type GoalCompletionCommandEvidence,
  type ToolExecution,
} from "../tools/execution.ts";
import {
  createProjectInstructionVisibilityState,
  type ProjectInstructionVisibilityState,
} from "../tools/scoped-project-instructions.ts";
import { toolCallAccesses } from "../tools/tool-access.ts";
import {
  addRequestAccounting,
  buildCostReport,
  type CostTrackingOptions,
  emptyRunAccounting,
} from "./accounting.ts";
import {
  type ContextCompactionOptions,
  projectCompactedToolOutput,
} from "./context-compaction.ts";
import type { AgentEvent } from "./events.ts";
import { postCompactionReadToolCallId } from "./post-compaction-read-id.ts";
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
  DEFAULT_TOOL_OUTPUT_ARTIFACT_AGGREGATE_PREVIEW_CHARS,
  DEFAULT_TOOL_OUTPUT_ARTIFACT_MAX_AGGREGATE_INLINE_CHARS,
  DEFAULT_TOOL_OUTPUT_ARTIFACT_MAX_INLINE_CHARS,
  settleOversizedToolOutput,
  settleProjectedToolOutput,
  type ToolOutputArtifactNotice,
  type ToolOutputArtifactSourceStatus,
  type ToolOutputArtifactsOptions,
  toolMessageSourceTruncationMetadata,
} from "./tool-output-artifacts.ts";
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

const MIN_TOOL_OUTPUT_ARTIFACT_OMITTED_CHARS = 512;

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
  readonly toolOutputArtifacts?: ToolOutputArtifactsOptions;
  readonly taskProgress?: SessionTaskProgress;
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
  readonly toolOutputArtifacts?: ToolOutputArtifactsOptions;
  readonly taskProgress?: SessionTaskProgress;
  readonly sessionGoal?: SessionGoal;
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

function bashCommandEvidenceMatchesGoal(
  goal: SessionGoal | undefined,
  execution: ToolExecution,
): boolean {
  if (
    goal?.completionCommand === undefined ||
    execution.bashCommandEvidence === undefined
  ) {
    return false;
  }
  return (
    normalizeSessionGoalCompletionCommand(
      execution.bashCommandEvidence.command,
    ) === normalizeSessionGoalCompletionCommand(goal.completionCommand)
  );
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

function providerMetadataFromReasoningContent(
  reasoningContent: string | null,
): AssistantProviderMetadata | undefined {
  if (reasoningContent === null) {
    return undefined;
  }
  return {
    openaiCompatible: {
      reasoningContent,
    },
  };
}

function combinedReasoningContent(
  left: string | null,
  right: string | null,
): string | null {
  if (left === null && right === null) {
    return null;
  }
  return `${left ?? ""}${right ?? ""}`;
}

function toolRequestMessage(turn: AgentTurn): Message {
  const providerMetadata = providerMetadataFromReasoningContent(
    turn.reasoningContent,
  );
  return {
    role: "assistant",
    content: turn.text,
    toolCalls: turn.toolCalls,
    ...(providerMetadata !== undefined ? { providerMetadata } : {}),
  };
}

interface CompletedTurnToolExecution {
  readonly toolCall: ToolCall;
  readonly execution: ToolExecution;
}

interface SettledTurnToolExecution extends CompletedTurnToolExecution {
  readonly content: string;
  readonly notice: ToolOutputArtifactNotice | undefined;
  readonly sourceTruncated: boolean;
}

function scheduledToolCalls(
  workspace: string,
  toolCalls: readonly ToolCall[],
): readonly ScheduledToolCall[] {
  return toolCalls.map((toolCall) => ({
    toolCall,
    accesses: toolCallAccesses(workspace, toolCall),
  }));
}

function finalReplyMessage(
  text: string,
  reasoningContent: string | null,
): Message | null {
  const providerMetadata =
    providerMetadataFromReasoningContent(reasoningContent);
  return text === "" && reasoningContent === null
    ? null
    : {
        role: "assistant",
        content: text,
        toolCalls: [],
        ...(providerMetadata !== undefined ? { providerMetadata } : {}),
      };
}

function resolvedMaxInlineChars(options: ToolOutputArtifactsOptions): number {
  return (
    options.maxInlineChars ?? DEFAULT_TOOL_OUTPUT_ARTIFACT_MAX_INLINE_CHARS
  );
}

function resolvedMaxAggregateInlineChars(
  options: ToolOutputArtifactsOptions,
): number {
  return (
    options.maxAggregateInlineChars ??
    DEFAULT_TOOL_OUTPUT_ARTIFACT_MAX_AGGREGATE_INLINE_CHARS
  );
}

function resolvedAggregatePreviewChars(
  options: ToolOutputArtifactsOptions,
  maxInlineChars: number,
): number {
  return Math.min(
    maxInlineChars,
    options.aggregatePreviewChars ??
      DEFAULT_TOOL_OUTPUT_ARTIFACT_AGGREGATE_PREVIEW_CHARS,
  );
}

function settlementPlanByExecutionIndex(
  executions: readonly CompletedTurnToolExecution[],
  artifacts: ToolOutputArtifactsOptions,
): ReadonlyMap<number, number> {
  const maxInlineChars = resolvedMaxInlineChars(artifacts);
  const maxAggregateInlineChars = resolvedMaxAggregateInlineChars(artifacts);
  const aggregatePreviewChars = resolvedAggregatePreviewChars(
    artifacts,
    maxInlineChars,
  );
  const plan = new Map<number, number>();
  let estimatedInlineChars = 0;

  executions.forEach(({ execution }, index) => {
    const inlineLength =
      execution.artifactContent?.length ?? execution.content.length;
    if (
      inlineLength - maxInlineChars >=
      MIN_TOOL_OUTPUT_ARTIFACT_OMITTED_CHARS
    ) {
      plan.set(index, maxInlineChars);
      estimatedInlineChars += maxInlineChars;
      return;
    }
    estimatedInlineChars += inlineLength;
  });

  if (estimatedInlineChars <= maxAggregateInlineChars) {
    return plan;
  }

  const candidates = executions
    .map(({ execution }, index) => ({
      index,
      length: execution.artifactContent?.length ?? execution.content.length,
    }))
    .filter(
      ({ length }) =>
        length - aggregatePreviewChars >=
        MIN_TOOL_OUTPUT_ARTIFACT_OMITTED_CHARS,
    )
    .sort((left, right) =>
      right.length === left.length
        ? left.index - right.index
        : right.length - left.length,
    );

  for (const candidate of candidates) {
    const currentInlineChars = plan.get(candidate.index) ?? candidate.length;
    plan.set(candidate.index, aggregatePreviewChars);
    estimatedInlineChars -= currentInlineChars - aggregatePreviewChars;
    if (estimatedInlineChars <= maxAggregateInlineChars) {
      break;
    }
  }

  return plan;
}

function artifactSourceStatus(
  execution: ToolExecution,
): ToolOutputArtifactSourceStatus {
  return execution.artifactSourceTruncated === true
    ? "source-truncated"
    : "complete";
}

function inlineSettledContent(execution: ToolExecution): string {
  return execution.artifactContent ?? execution.content;
}

function inlineSourceTruncated(execution: ToolExecution): boolean {
  return execution.artifactContent === undefined
    ? execution.sourceTruncated === true
    : execution.artifactSourceTruncated === true;
}

async function settleToolExecutionContents(options: {
  readonly executions: readonly CompletedTurnToolExecution[];
  readonly artifacts: ToolOutputArtifactsOptions | undefined;
}): Promise<readonly SettledTurnToolExecution[]> {
  if (options.artifacts === undefined) {
    return options.executions.map(({ toolCall, execution }) => ({
      toolCall,
      execution,
      content: execution.content,
      notice: undefined,
      sourceTruncated: execution.sourceTruncated === true,
    }));
  }
  const plan = settlementPlanByExecutionIndex(
    options.executions,
    options.artifacts,
  );
  const settledExecutions: SettledTurnToolExecution[] = [];
  for (const [index, { toolCall, execution }] of options.executions.entries()) {
    const maxInlineChars = plan.get(index);
    if (maxInlineChars === undefined) {
      settledExecutions.push({
        toolCall,
        execution,
        content: inlineSettledContent(execution),
        notice: undefined,
        sourceTruncated: inlineSourceTruncated(execution),
      });
      continue;
    }
    if (execution.artifactContent !== undefined) {
      const projection = projectCompactedToolOutput({
        text: execution.artifactContent,
        maxChars: maxInlineChars,
        context: { toolName: toolCall.tool, toolCall },
      });
      const settled = await settleProjectedToolOutput({
        store: options.artifacts.store,
        toolCallId: toolCall.id,
        toolName: toolCall.tool,
        previewContent: projection.preview,
        artifactContent: execution.artifactContent,
        sourceStatus: artifactSourceStatus(execution),
        purpose: "settlement",
      });
      settledExecutions.push({
        toolCall,
        execution,
        content: settled.content,
        notice: settled.notice,
        sourceTruncated: settled.sourceTruncated,
      });
      continue;
    }
    const settled = await settleOversizedToolOutput({
      store: options.artifacts.store,
      maxInlineChars,
      toolCallId: toolCall.id,
      toolName: toolCall.tool,
      content: execution.content,
      sourceStatus:
        execution.sourceTruncated === true ? "source-truncated" : "complete",
      purpose: "settlement",
    });
    settledExecutions.push({
      toolCall,
      execution,
      content: settled.content,
      notice: settled.notice,
      sourceTruncated: settled.sourceTruncated,
    });
  }
  return settledExecutions;
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
  readonly turnReasoningContent: string | null;
  readonly sessionLedger: SessionLedger;
}

async function* streamWrapUpSummary(
  options: WrapUpSummarizeOptions,
): AsyncGenerator<AgentEvent, AgentTurn> {
  const { config, state, streamOptions, turnText, sessionLedger } = options;
  const interimReply = finalReplyMessage(
    turnText,
    options.turnReasoningContent,
  );
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
  let taskProgress = copySessionTaskProgress(
    options.taskProgress ?? emptySessionTaskProgress(),
  );
  let sessionGoal =
    options.sessionGoal === undefined
      ? undefined
      : copySessionGoal(options.sessionGoal);
  let workspaceMutationSequence = 0;
  let goalCompletionCommandEvidence: GoalCompletionCommandEvidence | undefined;
  let postCompactionReadSequence = 0;
  const config: CompactionConfig = {
    provider,
    systemPrompt,
    signal,
    contextCompaction: options.contextCompaction,
    ...(options.toolOutputArtifacts !== undefined
      ? { toolOutputArtifacts: options.toolOutputArtifacts }
      : {}),
    taskProgress: () => taskProgress,
    costTracking,
    onContextCompacted: async (targetMessages) => {
      const postCompactionReadSequenceSnapshot = postCompactionReadSequence;
      const readVisibilitySnapshot = readVisibility.snapshot();
      const projectInstructionVisibilitySnapshot =
        projectInstructionVisibility.snapshot();
      try {
        await restorePostCompactionReads({
          workspace,
          signal,
          readVisibility,
          projectInstructionVisibility,
          messages: targetMessages,
          nextToolCallId: () =>
            postCompactionReadToolCallId(postCompactionReadSequence++),
        });
      } catch (error) {
        postCompactionReadSequence = postCompactionReadSequenceSnapshot;
        readVisibility.restoreSnapshot(readVisibilitySnapshot);
        projectInstructionVisibility.restoreSnapshot(
          projectInstructionVisibilitySnapshot,
        );
        throw error;
      }
      return {
        rollback: () => {
          postCompactionReadSequence = postCompactionReadSequenceSnapshot;
          readVisibility.restoreSnapshot(readVisibilitySnapshot);
          projectInstructionVisibility.restoreSnapshot(
            projectInstructionVisibilitySnapshot,
          );
        },
      };
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
      const reply = finalReplyMessage(
        turnResult.text,
        turnResult.reasoningContent,
      );
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
        turnReasoningContent: turnResult.reasoningContent,
        sessionLedger,
      });
      const summary =
        wrapUpTurn.text === "" ? MISSING_SUMMARY_NOTICE : wrapUpTurn.text;
      if (wrapUpTurn.text === "") {
        yield { type: "text", text: MISSING_SUMMARY_NOTICE };
      }
      const combinedReply = finalReplyMessage(
        `${turnResult.text}${summary}`,
        combinedReasoningContent(
          turnResult.reasoningContent,
          wrapUpTurn.reasoningContent,
        ),
      );
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
      const reply = finalReplyMessage(
        turnResult.text,
        turnResult.reasoningContent,
      );
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
        recordCheckpoints: options.recordCheckpointOperations === undefined,
        readBeforeEdit: {
          hasRead: readVisibility.hasRead,
        },
        projectInstructions: projectInstructionVisibility,
        workspaceMutationSequence,
        ...(sessionGoal !== undefined ? { sessionGoal } : {}),
        ...(goalCompletionCommandEvidence !== undefined
          ? { goalCompletionCommandEvidence }
          : {}),
        ...(bashPermission !== undefined ? { bashPermission } : {}),
      });

    const recordCheckpointOperations = (execution: ToolExecution): void => {
      if (
        execution.ok &&
        execution.checkpointOperations !== undefined &&
        execution.checkpointOperations.length > 0
      ) {
        options.recordCheckpointOperations?.(execution.checkpointOperations);
      }
    };

    const scheduled = scheduledToolCalls(workspace, turnResult.toolCalls);
    const completedToolExecutions: CompletedTurnToolExecution[] = [];
    let pendingToolExecutions: CompletedTurnToolExecution[] = [];
    const settlePendingToolExecutions = async (): Promise<
      readonly ToolOutputArtifactNotice[]
    > => {
      if (pendingToolExecutions.length === 0) {
        return [];
      }
      const pending = pendingToolExecutions;
      pendingToolExecutions = [];
      const settledToolExecutions = await settleToolExecutionContents({
        executions: pending,
        artifacts: options.toolOutputArtifacts,
      });
      const artifactNotices: ToolOutputArtifactNotice[] = [];
      for (const settled of settledToolExecutions) {
        applySessionLedger(
          appendSessionLedgerMessage(sessionLedger, {
            role: "tool",
            toolCallId: settled.toolCall.id,
            content: settled.content,
            ...toolMessageSourceTruncationMetadata({
              content: settled.content,
              sourceTruncated: settled.sourceTruncated,
            }),
          }),
        );
        if (settled.notice !== undefined) {
          artifactNotices.push(settled.notice);
        }
      }
      return artifactNotices;
    };
    const recordCompletedToolExecution = (
      completed: CompletedTurnToolExecution,
    ): void => {
      recordCheckpointOperations(completed.execution);
      readVisibility.applyImmediateMutation(completed.execution);
      projectInstructionVisibility.applyMutationTargetPaths(
        mutatedTargetPathsFromExecution(completed.execution),
      );
      if (completed.execution.ok) {
        if (completed.execution.bashCommandEvidence !== undefined) {
          if (
            bashCommandEvidenceMatchesGoal(sessionGoal, completed.execution)
          ) {
            goalCompletionCommandEvidence = {
              ...completed.execution.bashCommandEvidence,
              observedMutationSequence: workspaceMutationSequence,
            };
          } else {
            workspaceMutationSequence++;
          }
        } else if (
          mutatedTargetPathsFromExecution(completed.execution).length > 0
        ) {
          workspaceMutationSequence++;
        }
      }
      completedToolExecutions.push(completed);
      pendingToolExecutions.push(completed);
    };
    const taskProgressEventFromExecution = (
      execution: ToolExecution,
    ): Extract<
      AgentEvent,
      { readonly type: "task_progress_updated" }
    > | null => {
      if (execution.taskProgressUpdate === undefined) {
        return null;
      }
      taskProgress = copySessionTaskProgress(execution.taskProgressUpdate);
      return {
        type: "task_progress_updated",
        taskProgress,
        messageOrdinal:
          sessionLedger.entries.length + pendingToolExecutions.length + 1,
      };
    };
    const sessionGoalEventFromExecution = (
      execution: ToolExecution,
    ): Extract<
      AgentEvent,
      { readonly type: "session_goal_updated" }
    > | null => {
      if (execution.sessionGoalUpdate === undefined) {
        return null;
      }
      sessionGoal = copySessionGoal(execution.sessionGoalUpdate);
      return {
        type: "session_goal_updated",
        goal: sessionGoal,
        messageOrdinal:
          sessionLedger.entries.length + pendingToolExecutions.length + 1,
      };
    };

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
            for (const notice of await settlePendingToolExecutions()) {
              yield { type: "tool_output_artifact", ...notice };
            }
            throw result.reason;
          }
          const { toolCall, result: execution } = result;
          yield { type: "tool_end", toolCall, ok: execution.ok };
          const taskProgressEvent = taskProgressEventFromExecution(execution);
          /* v8 ignore next 3: update_plan uses global tool access and is never scheduled in a parallel batch. */
          if (taskProgressEvent !== null) {
            yield taskProgressEvent;
          }
          const sessionGoalEvent = sessionGoalEventFromExecution(execution);
          /* v8 ignore next 3: update_goal uses global tool access and is never scheduled in a parallel batch. */
          if (sessionGoalEvent !== null) {
            yield sessionGoalEvent;
          }
          recordCompletedToolExecution({ toolCall, execution });
        }
      } else {
        const { toolCall } = segment.toolCall;
        yield { type: "tool_start", toolCall };
        let execution: ToolExecution;
        try {
          execution = await executeTurnToolCall(toolCall);
        } catch (error) {
          for (const notice of await settlePendingToolExecutions()) {
            yield { type: "tool_output_artifact", ...notice };
          }
          throw error;
        }
        yield { type: "tool_end", toolCall, ok: execution.ok };
        const taskProgressEvent = taskProgressEventFromExecution(execution);
        if (taskProgressEvent !== null) {
          yield taskProgressEvent;
        }
        const sessionGoalEvent = sessionGoalEventFromExecution(execution);
        if (sessionGoalEvent !== null) {
          yield sessionGoalEvent;
        }
        recordCompletedToolExecution({ toolCall, execution });
      }
    }
    for (const notice of await settlePendingToolExecutions()) {
      yield { type: "tool_output_artifact", ...notice };
    }
    readVisibility.applyVisibleToolExecutions(
      completedToolExecutions.map(({ execution }) => execution),
    );
    publishVisibleProjectInstructions(
      projectInstructionVisibility,
      completedToolExecutions.map(({ execution }) => execution),
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
      ...(options.toolOutputArtifacts !== undefined
        ? { toolOutputArtifacts: options.toolOutputArtifacts }
        : {}),
    });
    options.onTranscriptReady?.(messages);
  } finally {
    if (checkpointOperations.length > 0) {
      recordLastTaskCheckpoint({
        workspace: options.workspace,
        operations: checkpointOperations,
      });
    }
  }
}
