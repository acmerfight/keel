import { randomUUID } from "node:crypto";
import type { Message, ToolCall } from "../../llm/types.ts";
import type { BashApprovalGrant } from "../../permissions/bash.ts";
import { toolCallCanonicalArguments } from "../../tools/registry.ts";
import { redactMessageForPersistence } from "../persistence-redaction.ts";
import { appendJsonLine, sessionLedgerSize } from "./ledger.ts";
import {
  type AppendSessionRecord,
  type ObjectValue,
  type ReplaceSessionRecord,
  SESSION_LEDGER_SNAPSHOT_THRESHOLD_BYTES,
  SESSION_SCHEMA_VERSION,
  type SessionGraphRecord,
  type SessionQueuedInput,
  type SessionReplayState,
  type SessionState,
  type SessionStoreRuntime,
  type StoredMessage,
  sessionReplayStateKey,
} from "./model.ts";
import {
  copyBashApprovalGrant,
  copyMessage,
  copySessionGraphRecord,
  copyStoredMessage,
  messagesFromStoredMessages,
  redactBashApprovalGrantForPersistence,
  redactSessionQueuedInputForPersistence,
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
        left.content === right.content
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

function sessionStateFromReplay(options: {
  readonly id: string;
  readonly filePath: string;
  readonly workspace: string;
  readonly graph: SessionGraphRecord;
  readonly storedMessages: readonly StoredMessage[];
  readonly pendingInputsById: ReadonlyMap<string, SessionQueuedInput>;
  readonly bashApprovalGrants: readonly BashApprovalGrant[];
}): SessionState {
  const graph = copySessionGraphRecord(options.graph);
  const storedMessages = options.storedMessages.map(copyStoredMessage);
  const messages = messagesFromStoredMessages(storedMessages);
  const pendingInputsById = new Map(options.pendingInputsById);
  const bashApprovalGrants = options.bashApprovalGrants.map(
    copyBashApprovalGrant,
  );
  const replayState = {
    storedMessages: storedMessages.map(copyStoredMessage),
    pendingInputsById,
    bashApprovalGrants,
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

function sessionRecordWithConsumedInputIds(
  record: AppendSessionRecord,
  consumedInputIds: readonly string[],
): AppendSessionRecord;
function sessionRecordWithConsumedInputIds(
  record: ReplaceSessionRecord,
  consumedInputIds: readonly string[],
): ReplaceSessionRecord;
function sessionRecordWithConsumedInputIds(
  record: AppendSessionRecord | ReplaceSessionRecord,
  consumedInputIds: readonly string[],
): AppendSessionRecord | ReplaceSessionRecord {
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
    messages: replayState.storedMessages.map(copyStoredMessage),
    pendingInputs: pendingInputsInReplayOrder(
      replayState.pendingInputsById,
    ).map(redactSessionQueuedInputForPersistence),
    ...(bashApprovalGrants.length > 0 ? { bashApprovalGrants } : {}),
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
  appendSessionSnapshotIfNeeded,
  consumeReplayInputs,
  hasMessagePrefix,
  messageArraysEqual,
  replaceReplayMessages,
  replayStateForSession,
  sessionRecordWithConsumedInputIds,
  sessionStateFromReplay,
  storedMessagesForProviderMessages,
  uniqueInputIds,
};
