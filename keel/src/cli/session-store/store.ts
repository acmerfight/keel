import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import type { Message } from "../../llm/types.ts";
import type { BashApprovalGrant } from "../../permissions/bash.ts";
import { sessionStoreError } from "./errors.ts";
import {
  endForkPoint,
  forkSessionGraph,
  rootSessionGraph,
  storedMessagesBeforeMessage,
} from "./forks.ts";
import {
  appendJsonLine,
  formatResumeSessionLoadError,
  readSessionRecords,
  writeInitialHeader,
} from "./ledger.ts";
import {
  SESSION_SCHEMA_VERSION,
  type SessionGraphRecord,
  type SessionModelSelection,
  type SessionModelSwitch,
  type SessionPersistenceReason,
  type SessionQueuedInput,
  type SessionRecords,
  type SessionState,
  type SessionStoreRuntime,
  type StoredMessage,
} from "./model.ts";
import { sessionFilePath } from "./paths.ts";
import {
  bashApprovalGrantHasRedactionMarker,
  copyBashApprovalGrant,
  copyStoredMessage,
  messagesFromStoredMessages,
  parseProviderVisibleMessages,
  redactBashApprovalGrantForPersistence,
  redactSessionQueuedInputForPersistence,
  redactStoredMessageForPersistence,
  validateCompletedTranscript,
} from "./records.ts";
import { isoTimestamp } from "./runtime.ts";
import {
  appendReplayModelSwitch,
  appendSessionSnapshotIfNeeded,
  consumeReplayInputs,
  copySessionModelSelection,
  hasMessagePrefix,
  messageArraysEqual,
  rebaseReplayModelSwitchesAfterReplace,
  replaceReplayMessages,
  replayStateForSession,
  sessionRecordWithConsumedInputIds,
  sessionStateFromReplay,
  storedMessagesForProviderMessages,
  uniqueInputIds,
} from "./state.ts";

export function createSessionStore(options: {
  readonly sessionId: string;
  readonly workspace: string;
  readonly runtime: SessionStoreRuntime;
}): SessionState {
  return createEmptySessionStore(options);
}

function createEmptySessionStore(options: {
  readonly sessionId: string;
  readonly workspace: string;
  readonly runtime: SessionStoreRuntime;
  readonly graph?: SessionGraphRecord;
}): SessionState {
  const workspace = realpathSync(options.workspace);
  const filePath = sessionFilePath(options.runtime, options.sessionId);
  const graph = options.graph ?? rootSessionGraph(options.sessionId);
  writeInitialHeader(filePath, {
    schemaVersion: SESSION_SCHEMA_VERSION,
    type: "session",
    id: options.sessionId,
    createdAt: isoTimestamp(options.runtime),
    workspace,
    graph,
  });
  return sessionStateFromReplay({
    id: options.sessionId,
    filePath,
    workspace,
    graph,
    storedMessages: [],
    pendingInputsById: new Map(),
    bashApprovalGrants: [],
  });
}

function sessionModelSelectionsEqual(
  left: SessionModelSelection,
  right: SessionModelSelection,
): boolean {
  return left.providerId === right.providerId && left.model === right.model;
}

function modelSwitchesForForkPoint(options: {
  readonly source: SessionState;
  readonly forkedMessageCount: number;
  readonly timestamp: string;
}): readonly SessionModelSwitch[] {
  let activeModel: SessionModelSelection | undefined;
  for (const modelSwitch of replayStateForSession(options.source)
    .modelSwitches) {
    if (modelSwitch.messageOrdinal <= options.forkedMessageCount) {
      activeModel = modelSwitch.to;
    }
  }
  if (activeModel === undefined) {
    return [];
  }
  return [
    {
      timestamp: options.timestamp,
      from: null,
      to: copySessionModelSelection(activeModel),
      messageOrdinal: 0,
    },
  ];
}

export function forkSessionStore(options: {
  readonly source: SessionState;
  readonly targetSessionId: string;
  readonly forkPoint?: {
    readonly beforeMessageId: string;
    readonly optionName: string;
  };
  readonly runtime: SessionStoreRuntime;
}): SessionState {
  parseProviderVisibleMessages(
    options.targetSessionId,
    options.source.messages,
    "fork",
  );
  const forkSelection =
    options.forkPoint === undefined
      ? {
          storedMessages: options.source.storedMessages.map(copyStoredMessage),
          forkPoint: endForkPoint(options.source),
        }
      : storedMessagesBeforeMessage({
          targetSessionId: options.targetSessionId,
          source: options.source,
          beforeMessageId: options.forkPoint.beforeMessageId,
          optionName: options.forkPoint.optionName,
        });
  const storedMessages = forkSelection.storedMessages.map(
    redactStoredMessageForPersistence,
  );
  const messages = messagesFromStoredMessages(storedMessages);
  validateCompletedTranscript(options.targetSessionId, messages, "fork");
  const graph = forkSessionGraph({
    source: options.source,
    targetSessionId: options.targetSessionId,
    forkPoint: forkSelection.forkPoint,
  });
  const timestamp = isoTimestamp(options.runtime);
  const modelSwitches = modelSwitchesForForkPoint({
    source: options.source,
    forkedMessageCount: storedMessages.length,
    timestamp,
  });
  const activeModel = modelSwitches.at(-1)?.to;
  const session = createEmptySessionStore({
    sessionId: options.targetSessionId,
    workspace: options.source.workspace,
    runtime: options.runtime,
    graph,
  });
  const forkedSession = sessionStateFromReplay({
    id: options.targetSessionId,
    filePath: session.filePath,
    workspace: session.workspace,
    graph,
    storedMessages,
    pendingInputsById: new Map(),
    bashApprovalGrants: [],
    ...(activeModel !== undefined
      ? { activeModel: copySessionModelSelection(activeModel) }
      : {}),
    modelSwitches,
  });
  if (activeModel !== undefined) {
    appendJsonLine(session.filePath, {
      schemaVersion: SESSION_SCHEMA_VERSION,
      type: "model_switch",
      timestamp,
      from: null,
      to: copySessionModelSelection(activeModel),
    });
  }
  if (storedMessages.length > 0) {
    appendJsonLine(session.filePath, {
      schemaVersion: SESSION_SCHEMA_VERSION,
      type: "append",
      timestamp,
      reason: "turn",
      messages: storedMessages.map(copyStoredMessage),
    });
  }
  appendSessionSnapshotIfNeeded({
    session: forkedSession,
    runtime: options.runtime,
  });
  return forkedSession;
}

export function resumeSessionStore(options: {
  readonly sessionId: string;
  readonly workspace: string;
  readonly runtime: SessionStoreRuntime;
}): SessionState {
  const expectedWorkspace = realpathSync(options.workspace);
  const filePath = sessionFilePath(options.runtime, options.sessionId);
  let records: SessionRecords;
  try {
    records = readSessionRecords(filePath);
  } catch (error) {
    const message = formatResumeSessionLoadError(error);
    sessionStoreError(
      `Error: cannot resume session "${options.sessionId}": ${message}`,
    );
  }
  const { header } = records;
  if (header.id !== options.sessionId) {
    sessionStoreError(
      `Error: cannot resume session "${options.sessionId}": ledger belongs to session "${header.id}".`,
    );
  }
  if (header.workspace !== expectedWorkspace) {
    sessionStoreError(
      `Error: cannot resume session "${options.sessionId}": session workspace is ${header.workspace}, not ${expectedWorkspace}.`,
    );
  }

  let storedMessages: StoredMessage[] = [];
  const pendingInputsById = new Map<string, SessionQueuedInput>();
  let bashApprovalGrants: BashApprovalGrant[] = [];
  let activeModel: SessionModelSelection | undefined;
  let modelSwitches: SessionModelSwitch[] = [];
  for (const record of records.mutations) {
    switch (record.type) {
      case "append":
        storedMessages = [
          ...storedMessages,
          ...record.messages.map(copyStoredMessage),
        ];
        consumeReplayInputs(pendingInputsById, record.consumedInputIds);
        break;
      case "replace":
        storedMessages = record.messages.map(copyStoredMessage);
        consumeReplayInputs(pendingInputsById, record.consumedInputIds);
        modelSwitches =
          activeModel === undefined
            ? []
            : [
                {
                  timestamp: record.timestamp,
                  from: null,
                  to: copySessionModelSelection(activeModel),
                  messageOrdinal: 0,
                },
              ];
        break;
      case "model_switch":
        activeModel = copySessionModelSelection(record.to);
        modelSwitches = [
          ...modelSwitches,
          {
            timestamp: record.timestamp,
            from:
              record.from === null
                ? null
                : copySessionModelSelection(record.from),
            to: copySessionModelSelection(record.to),
            messageOrdinal: storedMessages.length,
          },
        ];
        consumeReplayInputs(pendingInputsById, record.consumedInputIds);
        break;
      case "input_admitted":
        pendingInputsById.set(record.id, {
          id: record.id,
          timestamp: record.timestamp,
          sequence: record.sequence,
          line: record.line,
        });
        break;
      case "input_consumed":
        consumeReplayInputs(pendingInputsById, record.inputIds);
        break;
      case "bash_approval_granted":
        if (!bashApprovalGrantHasRedactionMarker(record.grant)) {
          bashApprovalGrants = [
            ...bashApprovalGrants,
            copyBashApprovalGrant(record.grant),
          ];
        }
        break;
      case "snapshot": {
        storedMessages = record.messages.map(copyStoredMessage);
        pendingInputsById.clear();
        for (const input of record.pendingInputs) {
          pendingInputsById.set(input.id, input);
        }
        bashApprovalGrants = (record.bashApprovalGrants ?? []).filter(
          (grant) => !bashApprovalGrantHasRedactionMarker(grant),
        );
        const snapshotModelSwitches = record.modelSwitches ?? [];
        const snapshotActiveSwitch = snapshotModelSwitches.at(-1);
        if (
          record.activeModel !== undefined &&
          (snapshotActiveSwitch === undefined ||
            !sessionModelSelectionsEqual(
              snapshotActiveSwitch.to,
              record.activeModel,
            ))
        ) {
          sessionStoreError(
            `Error: cannot resume session "${options.sessionId}": snapshot active model is missing matching model switch history.`,
          );
        }
        if (
          record.activeModel === undefined &&
          snapshotModelSwitches.length > 0
        ) {
          sessionStoreError(
            `Error: cannot resume session "${options.sessionId}": snapshot model switch history is missing active model.`,
          );
        }
        modelSwitches = snapshotModelSwitches.map((modelSwitch) => ({
          timestamp: modelSwitch.timestamp,
          from:
            modelSwitch.from === null
              ? null
              : copySessionModelSelection(modelSwitch.from),
          to: copySessionModelSelection(modelSwitch.to),
          messageOrdinal: modelSwitch.messageOrdinal,
        }));
        activeModel = modelSwitches.at(-1)?.to;
        break;
      }
    }
  }
  const messages = messagesFromStoredMessages(storedMessages);
  validateCompletedTranscript(options.sessionId, messages, "resume");

  return sessionStateFromReplay({
    id: options.sessionId,
    filePath,
    workspace: expectedWorkspace,
    graph: records.header.graph,
    storedMessages,
    pendingInputsById,
    bashApprovalGrants,
    ...(activeModel !== undefined
      ? { activeModel: copySessionModelSelection(activeModel) }
      : {}),
    modelSwitches,
  });
}

export function persistSessionMessages(options: {
  readonly session: SessionState;
  readonly previousMessages: readonly Message[];
  readonly currentMessages: readonly Message[];
  readonly runtime: SessionStoreRuntime;
  readonly reason: SessionPersistenceReason;
  readonly consumedInputIds?: readonly string[];
}): readonly Message[] {
  const currentMessages = parseProviderVisibleMessages(
    options.session.id,
    options.currentMessages,
    "persist",
  );
  validateCompletedTranscript(options.session.id, currentMessages, "persist");
  const consumedInputIds = uniqueInputIds(options.consumedInputIds ?? []);
  const replayState = replayStateForSession(options.session);
  const currentStoredMessages = storedMessagesForProviderMessages({
    messages: currentMessages,
    previousStoredMessages: replayState.storedMessages,
  });

  if (messageArraysEqual(currentMessages, options.previousMessages)) {
    replaceReplayMessages(replayState, currentStoredMessages);
    if (consumedInputIds.length > 0) {
      consumeSessionQueuedInputs({
        session: options.session,
        inputIds: consumedInputIds,
        runtime: options.runtime,
      });
      appendSessionSnapshotIfNeeded({
        session: options.session,
        runtime: options.runtime,
      });
    }
    return [...options.previousMessages];
  }

  if (hasMessagePrefix(currentMessages, options.previousMessages)) {
    const messages = currentStoredMessages.slice(
      options.previousMessages.length,
    );
    appendJsonLine(
      options.session.filePath,
      sessionRecordWithConsumedInputIds(
        {
          schemaVersion: SESSION_SCHEMA_VERSION,
          type: "append",
          timestamp: isoTimestamp(options.runtime),
          reason: "turn",
          messages,
        },
        consumedInputIds,
      ),
    );
    replaceReplayMessages(replayState, currentStoredMessages);
    consumeReplayInputs(replayState.pendingInputsById, consumedInputIds);
    appendSessionSnapshotIfNeeded({
      session: options.session,
      runtime: options.runtime,
    });
    return [...currentMessages];
  }

  const timestamp = isoTimestamp(options.runtime);
  appendJsonLine(
    options.session.filePath,
    sessionRecordWithConsumedInputIds(
      {
        schemaVersion: SESSION_SCHEMA_VERSION,
        type: "replace",
        timestamp,
        reason: options.reason,
        messages: currentStoredMessages.map(copyStoredMessage),
      },
      consumedInputIds,
    ),
  );
  replaceReplayMessages(replayState, currentStoredMessages);
  rebaseReplayModelSwitchesAfterReplace(replayState, timestamp);
  consumeReplayInputs(replayState.pendingInputsById, consumedInputIds);
  appendSessionSnapshotIfNeeded({
    session: options.session,
    runtime: options.runtime,
  });
  return [...currentMessages];
}

export function persistSessionModelSwitch(options: {
  readonly session: SessionState;
  readonly from: SessionModelSelection | null;
  readonly to: SessionModelSelection;
  readonly runtime: SessionStoreRuntime;
  readonly consumedInputIds?: readonly string[];
}): void {
  const consumedInputIds = uniqueInputIds(options.consumedInputIds ?? []);
  const timestamp = isoTimestamp(options.runtime);
  appendJsonLine(
    options.session.filePath,
    sessionRecordWithConsumedInputIds(
      {
        schemaVersion: SESSION_SCHEMA_VERSION,
        type: "model_switch",
        timestamp,
        from:
          options.from === null
            ? null
            : copySessionModelSelection(options.from),
        to: copySessionModelSelection(options.to),
      },
      consumedInputIds,
    ),
  );
  const replayState = replayStateForSession(options.session);
  appendReplayModelSwitch(replayState, {
    timestamp,
    from: options.from,
    to: options.to,
  });
  consumeReplayInputs(replayState.pendingInputsById, consumedInputIds);
  appendSessionSnapshotIfNeeded({
    session: options.session,
    runtime: options.runtime,
  });
}

export function persistSessionBashApprovalGrant(options: {
  readonly session: SessionState;
  readonly grant: BashApprovalGrant;
  readonly runtime: SessionStoreRuntime;
}): void {
  const grant = redactBashApprovalGrantForPersistence(options.grant);
  appendJsonLine(options.session.filePath, {
    schemaVersion: SESSION_SCHEMA_VERSION,
    type: "bash_approval_granted",
    timestamp: isoTimestamp(options.runtime),
    grant,
  });
  if (!bashApprovalGrantHasRedactionMarker(grant)) {
    replayStateForSession(options.session).bashApprovalGrants.push(grant);
  }
  appendSessionSnapshotIfNeeded({
    session: options.session,
    runtime: options.runtime,
  });
}

export function persistSessionQueuedInput(options: {
  readonly session: SessionState;
  readonly sequence: number;
  readonly line: string;
  readonly runtime: SessionStoreRuntime;
}): SessionQueuedInput {
  const queuedInput = {
    id: randomUUID(),
    timestamp: isoTimestamp(options.runtime),
    sequence: options.sequence,
    line: options.line,
  };
  const persistedQueuedInput =
    redactSessionQueuedInputForPersistence(queuedInput);
  appendJsonLine(options.session.filePath, {
    schemaVersion: SESSION_SCHEMA_VERSION,
    type: "input_admitted",
    timestamp: queuedInput.timestamp,
    id: queuedInput.id,
    sequence: queuedInput.sequence,
    line: persistedQueuedInput.line,
  });
  replayStateForSession(options.session).pendingInputsById.set(
    persistedQueuedInput.id,
    persistedQueuedInput,
  );
  return queuedInput;
}

export function consumeSessionQueuedInputs(options: {
  readonly session: SessionState;
  readonly inputIds: readonly string[];
  readonly runtime: SessionStoreRuntime;
}): void {
  const inputIds = uniqueInputIds(options.inputIds);
  if (inputIds.length === 0) {
    return;
  }
  appendJsonLine(options.session.filePath, {
    schemaVersion: SESSION_SCHEMA_VERSION,
    type: "input_consumed",
    timestamp: isoTimestamp(options.runtime),
    inputIds,
  });
  consumeReplayInputs(
    replayStateForSession(options.session).pendingInputsById,
    inputIds,
  );
}
