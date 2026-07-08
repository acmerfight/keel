import { randomUUID } from "node:crypto";
import { copySessionGoal, type SessionGoal } from "../../core/session-goal.ts";
import {
  copySessionTaskProgress,
  emptySessionTaskProgress,
  type SessionTaskProgress,
  sessionTaskProgressesEqual,
} from "../../core/task-progress.ts";
import type { Message, ToolCall } from "../../llm/types.ts";
import type { BashApprovalGrant } from "../../permissions/bash.ts";
import { toolCallCanonicalArguments } from "../../tools/registry.ts";
import { redactMessageForPersistence } from "../persistence-redaction.ts";
import { appendJsonLine, sessionLedgerSize } from "./ledger.ts";
import {
  type AppendSessionRecord,
  type ModelSwitchSessionRecord,
  type ObjectValue,
  type ReplaceSessionRecord,
  SESSION_LEDGER_SNAPSHOT_THRESHOLD_BYTES,
  SESSION_SCHEMA_VERSION,
  type SessionGoalSessionRecord,
  type SessionGraphRecord,
  type SessionModelSelection,
  type SessionModelSwitch,
  type SessionQueuedInput,
  type SessionReplayState,
  type SessionState,
  type SessionStoreRuntime,
  type SessionTaskProgressCheckpoint,
  type SessionTitleSessionRecord,
  type StoredMessage,
  sessionReplayStateKey,
  type WorkflowSkill,
} from "./model.ts";
import {
  copyBashApprovalGrant,
  copyMessage,
  copySessionGraphRecord,
  copyStoredMessage,
  copyWorkflowSkill,
  messagesFromStoredMessages,
  redactBashApprovalGrantForPersistence,
  redactSessionQueuedInputForPersistence,
  redactSessionTaskProgressCheckpointForPersistence,
} from "./records.ts";
import { isoTimestamp } from "./runtime.ts";

function objectValue(input: object, key: string): ObjectValue {
  for (const [name, value] of Object.entries(input)) {
    if (name === key) {
      return { exists: true, value };
    }
  }
  /* v8 ignore next: same-tool canonical args share field names; this guards future schema drift. */
  return { exists: false };
}

function stableValuesEqual(left: unknown, right: unknown): boolean {
  if (
    left === null ||
    right === null ||
    typeof left !== "object" ||
    typeof right !== "object"
  ) {
    return left === right;
  }

  if (Array.isArray(left) || Array.isArray(right)) {
    /* v8 ignore next 3: same-tool canonical args keep stable field types; this guards future schema drift. */
    if (!Array.isArray(left) || !Array.isArray(right)) {
      return false;
    }
    return (
      left.length === right.length &&
      left.every((item, index) => stableValuesEqual(item, right[index]))
    );
  }

  const leftEntries = Object.entries(left);
  if (leftEntries.length !== Object.keys(right).length) {
    return false;
  }
  return leftEntries.every(([key, value]) => {
    const rightValue = objectValue(right, key);
    return rightValue.exists && stableValuesEqual(value, rightValue.value);
  });
}

function toolCallArgumentsEqual(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): boolean {
  return stableValuesEqual(left, right);
}

function toolCallsEqual(left: ToolCall, right: ToolCall): boolean {
  return (
    left.id === right.id &&
    left.tool === right.tool &&
    toolCallArgumentsEqual(
      toolCallCanonicalArguments(left),
      toolCallCanonicalArguments(right),
    )
  );
}

function messagesEqual(left: Message, right: Message): boolean {
  switch (left.role) {
    case "user":
      return right.role === "user" && left.content === right.content;
    case "assistant":
      return (
        right.role === "assistant" &&
        left.content === right.content &&
        stableValuesEqual(
          left.providerMetadata ?? null,
          right.providerMetadata ?? null,
        ) &&
        left.toolCalls.length === right.toolCalls.length &&
        left.toolCalls.every((toolCall, index) => {
          const rightToolCall = right.toolCalls[index];
          return (
            rightToolCall !== undefined &&
            toolCallsEqual(toolCall, rightToolCall)
          );
        })
      );
    case "tool":
      return (
        right.role === "tool" &&
        left.toolCallId === right.toolCallId &&
        left.content === right.content &&
        left.sourceTruncated === right.sourceTruncated
      );
  }
}

function messageArraysEqual(
  left: readonly Message[],
  right: readonly Message[],
): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((message, index) => {
    const rightMessage = right[index];
    return rightMessage !== undefined && messagesEqual(message, rightMessage);
  });
}

function hasMessagePrefix(
  currentMessages: readonly Message[],
  previousMessages: readonly Message[],
): boolean {
  if (currentMessages.length < previousMessages.length) {
    return false;
  }
  return previousMessages.every((message, index) => {
    const currentMessage = currentMessages[index];
    return (
      currentMessage !== undefined && messagesEqual(message, currentMessage)
    );
  });
}

function uniqueInputIds(inputIds: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const inputId of inputIds) {
    if (seen.has(inputId)) {
      continue;
    }
    seen.add(inputId);
    unique.push(inputId);
  }
  return unique;
}

function pendingInputsInReplayOrder(
  pendingInputsById: ReadonlyMap<string, SessionQueuedInput>,
): readonly SessionQueuedInput[] {
  return [...pendingInputsById.values()].sort((left, right) => {
    const sequenceDelta = left.sequence - right.sequence;
    if (sequenceDelta !== 0) {
      return sequenceDelta;
    }
    const timestampDelta = left.timestamp.localeCompare(right.timestamp);
    if (timestampDelta !== 0) {
      return timestampDelta;
    }
    return left.id.localeCompare(right.id);
  });
}

export function copySessionModelSelection(
  selection: SessionModelSelection,
): SessionModelSelection {
  return {
    providerId: selection.providerId,
    model: selection.model,
  };
}

function copySessionModelSwitch(
  modelSwitch: SessionModelSwitch,
): SessionModelSwitch {
  return {
    timestamp: modelSwitch.timestamp,
    from:
      modelSwitch.from === null
        ? null
        : copySessionModelSelection(modelSwitch.from),
    to: copySessionModelSelection(modelSwitch.to),
    messageOrdinal: modelSwitch.messageOrdinal,
  };
}

function copySessionTaskProgressCheckpoint(
  checkpoint: SessionTaskProgressCheckpoint,
): SessionTaskProgressCheckpoint {
  return {
    messageOrdinal: checkpoint.messageOrdinal,
    taskProgress: copySessionTaskProgress(checkpoint.taskProgress),
  };
}

function sessionStateFromReplay(options: {
  readonly id: string;
  readonly filePath: string;
  readonly workspace: string;
  readonly graph: SessionGraphRecord;
  readonly storedMessages: readonly StoredMessage[];
  readonly pendingInputsById: ReadonlyMap<string, SessionQueuedInput>;
  readonly bashApprovalGrants: readonly BashApprovalGrant[];
  readonly taskProgress: SessionTaskProgress;
  readonly taskProgressCheckpoints?: readonly SessionTaskProgressCheckpoint[];
  readonly title?: string;
  readonly goal?: SessionGoal;
  readonly activeModel?: SessionModelSelection;
  readonly modelSwitches?: readonly SessionModelSwitch[];
  readonly workflowSkill?: WorkflowSkill;
}): SessionState {
  const graph = copySessionGraphRecord(options.graph);
  const storedMessages = options.storedMessages.map(copyStoredMessage);
  const messages = messagesFromStoredMessages(storedMessages);
  const pendingInputsById = new Map(options.pendingInputsById);
  const bashApprovalGrants = options.bashApprovalGrants.map(
    copyBashApprovalGrant,
  );
  const taskProgressCheckpoints = (options.taskProgressCheckpoints ?? []).map(
    copySessionTaskProgressCheckpoint,
  );
  const taskProgress = copySessionTaskProgress(options.taskProgress);
  const title = options.title;
  const goal =
    options.goal === undefined ? undefined : copySessionGoal(options.goal);
  const activeModel =
    options.activeModel === undefined
      ? undefined
      : copySessionModelSelection(options.activeModel);
  const modelSwitches = (options.modelSwitches ?? []).map(
    copySessionModelSwitch,
  );
  const workflowSkill =
    options.workflowSkill === undefined
      ? undefined
      : copyWorkflowSkill(options.workflowSkill);
  const replayState = {
    storedMessages: storedMessages.map(copyStoredMessage),
    pendingInputsById,
    bashApprovalGrants,
    taskProgress: copySessionTaskProgress(taskProgress),
    taskProgressCheckpoints: taskProgressCheckpoints.map(
      copySessionTaskProgressCheckpoint,
    ),
    ...(title !== undefined ? { title } : {}),
    ...(goal !== undefined ? { goal } : {}),
    ...(activeModel !== undefined ? { activeModel } : {}),
    modelSwitches: modelSwitches.map(copySessionModelSwitch),
  };
  const session = {
    [sessionReplayStateKey]: replayState,
    id: options.id,
    filePath: options.filePath,
    workspace: options.workspace,
    graph,
    messages,
    storedMessages,
    pendingInputs: pendingInputsInReplayOrder(pendingInputsById),
    bashApprovalGrants,
    taskProgress,
    ...(title !== undefined ? { title } : {}),
    ...(goal !== undefined ? { goal: copySessionGoal(goal) } : {}),
    ...(activeModel !== undefined ? { activeModel } : {}),
    modelSwitches,
    ...(workflowSkill !== undefined ? { workflowSkill } : {}),
  };
  return session;
}

function replayStateForSession(session: SessionState): SessionReplayState {
  return session[sessionReplayStateKey];
}

export function sessionStoredMessages(
  session: SessionState,
): readonly StoredMessage[] {
  return replayStateForSession(session).storedMessages.map(copyStoredMessage);
}

function replaceReplayMessages(
  state: SessionReplayState,
  storedMessages: readonly StoredMessage[],
): void {
  state.storedMessages.splice(
    0,
    state.storedMessages.length,
    ...storedMessages.map(copyStoredMessage),
  );
}

function consumeReplayInputs(
  pendingInputsById: Map<string, SessionQueuedInput>,
  consumedInputIds: readonly string[] | undefined,
): void {
  if (consumedInputIds === undefined) {
    return;
  }
  for (const inputId of consumedInputIds) {
    pendingInputsById.delete(inputId);
  }
}

function rebaseReplayModelSwitchesAfterReplace(
  state: SessionReplayState,
  timestamp: string,
): void {
  if (state.activeModel === undefined) {
    state.modelSwitches.splice(0, state.modelSwitches.length);
    return;
  }
  state.modelSwitches.splice(0, state.modelSwitches.length, {
    timestamp,
    from: null,
    to: copySessionModelSelection(state.activeModel),
    messageOrdinal: 0,
  });
}

function appendReplayModelSwitch(
  state: SessionReplayState,
  modelSwitch: {
    readonly timestamp: string;
    readonly from: SessionModelSelection | null;
    readonly to: SessionModelSelection;
  },
): void {
  const replaySwitch = {
    timestamp: modelSwitch.timestamp,
    from:
      modelSwitch.from === null
        ? null
        : copySessionModelSelection(modelSwitch.from),
    to: copySessionModelSelection(modelSwitch.to),
    messageOrdinal: state.storedMessages.length,
  };
  state.modelSwitches.push(replaySwitch);
  state.activeModel = copySessionModelSelection(replaySwitch.to);
}

function rebaseReplayTaskProgressAfterReplace(state: SessionReplayState): void {
  state.taskProgressCheckpoints.splice(0, state.taskProgressCheckpoints.length);
  if (
    sessionTaskProgressesEqual(state.taskProgress, emptySessionTaskProgress())
  ) {
    return;
  }
  state.taskProgressCheckpoints.push({
    messageOrdinal: 0,
    taskProgress: copySessionTaskProgress(state.taskProgress),
  });
}

function replaceReplayTaskProgress(
  state: SessionReplayState,
  taskProgress: SessionTaskProgress,
  messageOrdinal = state.storedMessages.length,
): void {
  state.taskProgress = copySessionTaskProgress(taskProgress);
  state.taskProgressCheckpoints.push({
    messageOrdinal,
    taskProgress: copySessionTaskProgress(taskProgress),
  });
}

function sessionRecordWithConsumedInputIds(
  record: AppendSessionRecord,
  consumedInputIds: readonly string[],
): AppendSessionRecord;
function sessionRecordWithConsumedInputIds(
  record: ReplaceSessionRecord,
  consumedInputIds: readonly string[],
): ReplaceSessionRecord;
function sessionRecordWithConsumedInputIds(
  record: ModelSwitchSessionRecord,
  consumedInputIds: readonly string[],
): ModelSwitchSessionRecord;
function sessionRecordWithConsumedInputIds(
  record: SessionTitleSessionRecord,
  consumedInputIds: readonly string[],
): SessionTitleSessionRecord;
function sessionRecordWithConsumedInputIds(
  record: SessionGoalSessionRecord,
  consumedInputIds: readonly string[],
): SessionGoalSessionRecord;
function sessionRecordWithConsumedInputIds(
  record:
    | AppendSessionRecord
    | ReplaceSessionRecord
    | ModelSwitchSessionRecord
    | SessionTitleSessionRecord
    | SessionGoalSessionRecord,
  consumedInputIds: readonly string[],
):
  | AppendSessionRecord
  | ReplaceSessionRecord
  | ModelSwitchSessionRecord
  | SessionTitleSessionRecord
  | SessionGoalSessionRecord {
  if (consumedInputIds.length === 0) {
    return record;
  }
  return { ...record, consumedInputIds: [...consumedInputIds] };
}

function appendSessionSnapshotIfNeeded(options: {
  readonly session: SessionState;
  readonly runtime: SessionStoreRuntime;
}): void {
  if (
    sessionLedgerSize(options.session.filePath) <=
    SESSION_LEDGER_SNAPSHOT_THRESHOLD_BYTES
  ) {
    return;
  }

  const replayState = replayStateForSession(options.session);
  const bashApprovalGrants = replayState.bashApprovalGrants.map(
    redactBashApprovalGrantForPersistence,
  );
  appendJsonLine(options.session.filePath, {
    schemaVersion: SESSION_SCHEMA_VERSION,
    type: "snapshot",
    timestamp: isoTimestamp(options.runtime),
    reason: "size_threshold",
    ...(replayState.title !== undefined ? { title: replayState.title } : {}),
    ...(replayState.goal !== undefined
      ? { goal: copySessionGoal(replayState.goal) }
      : {}),
    messages: replayState.storedMessages.map(copyStoredMessage),
    pendingInputs: pendingInputsInReplayOrder(
      replayState.pendingInputsById,
    ).map(redactSessionQueuedInputForPersistence),
    ...(bashApprovalGrants.length > 0 ? { bashApprovalGrants } : {}),
    ...(replayState.activeModel !== undefined
      ? { activeModel: copySessionModelSelection(replayState.activeModel) }
      : {}),
    ...(replayState.modelSwitches.length > 0
      ? { modelSwitches: replayState.modelSwitches.map(copySessionModelSwitch) }
      : {}),
    ...(replayState.taskProgressCheckpoints.length > 0
      ? {
          taskProgressCheckpoints: replayState.taskProgressCheckpoints.map(
            redactSessionTaskProgressCheckpointForPersistence,
          ),
        }
      : {}),
  });
}

function storedMessageId(): string {
  return `msg_${randomUUID()}`;
}

function storedMessagesForProviderMessages(options: {
  readonly messages: readonly Message[];
  readonly previousStoredMessages: readonly StoredMessage[];
}): readonly StoredMessage[] {
  const redactedMessages = options.messages.map(redactMessageForPersistence);
  return redactedMessages.map((message, index) => {
    const previous = options.previousStoredMessages[index];
    if (previous !== undefined && messagesEqual(previous.message, message)) {
      return copyStoredMessage(previous);
    }
    return {
      id: storedMessageId(),
      message: copyMessage(message),
    };
  });
}

export {
  appendReplayModelSwitch,
  appendSessionSnapshotIfNeeded,
  consumeReplayInputs,
  hasMessagePrefix,
  messageArraysEqual,
  rebaseReplayModelSwitchesAfterReplace,
  rebaseReplayTaskProgressAfterReplace,
  replaceReplayMessages,
  replaceReplayTaskProgress,
  replayStateForSession,
  sessionRecordWithConsumedInputIds,
  sessionStateFromReplay,
  storedMessagesForProviderMessages,
  uniqueInputIds,
};
