import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import {
  copySessionGoal,
  type SessionGoal,
  sessionGoalSchema,
} from "../../core/session-goal.ts";
import {
  copySessionTaskProgress,
  emptySessionTaskProgress,
  type SessionTaskProgress,
  sessionTaskProgressesEqual,
} from "../../core/task-progress.ts";
import type { Message, SessionMessage } from "../../llm/types.ts";
import {
  type BashApprovalGrant,
  bashApprovalGrantKey,
} from "../../permissions/bash.ts";
import {
  copySkillActivation,
  copySkillLifecycleState,
} from "../../skills/lifecycle.ts";
import type {
  SkillActivation,
  SkillLifecycleState,
} from "../../skills/model.ts";
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
  type SessionSkillStateCheckpoint,
  type SessionState,
  type SessionStoreRuntime,
  type SessionTaskProgressCheckpoint,
  type SkillStateSessionRecord,
  type StoredMessage,
} from "./model.ts";
import { sessionFilePath } from "./paths.ts";
import {
  bashApprovalGrantHasRedactionMarker,
  copyBashApprovalGrant,
  copyStoredMessage,
  messagesFromStoredMessages,
  normalizeSessionTitleForPersistence,
  parseSessionMessages,
  redactBashApprovalGrantForPersistence,
  redactSessionGoalForPersistence,
  redactSessionQueuedInputForPersistence,
  redactSessionTaskProgressForPersistence,
  redactSkillActivationForPersistence,
  redactStoredMessageForPersistence,
  validateCompletedTranscript,
} from "./records.ts";
import { isoTimestamp } from "./runtime.ts";
import {
  appendReplayModelSwitch,
  appendReplaySkillState,
  appendSessionSnapshotIfNeeded,
  consumeReplayInputs,
  copySessionModelSelection,
  hasMessagePrefix,
  messageArraysEqual,
  rebaseReplayModelSwitchesAfterReplace,
  rebaseReplaySkillStateAfterReplace,
  rebaseReplayTaskProgressAfterReplace,
  replaceReplayMessages,
  replaceReplayTaskProgress,
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
  readonly skillState?: SkillLifecycleState;
}): SessionState {
  return createEmptySessionStore(options);
}

function createEmptySessionStore(options: {
  readonly sessionId: string;
  readonly workspace: string;
  readonly runtime: SessionStoreRuntime;
  readonly graph?: SessionGraphRecord;
  readonly skillState?: SkillLifecycleState;
}): SessionState {
  const workspace = realpathSync(options.workspace);
  const filePath = sessionFilePath(options.runtime, options.sessionId);
  const graph = options.graph ?? rootSessionGraph(options.sessionId);
  const skillState = copySkillLifecycleState(
    options.skillState ?? { skillActivations: [], activeSkillIds: [] },
  );
  const persistedSkillState = {
    skillActivations: skillState.skillActivations.map(
      redactSkillActivationForPersistence,
    ),
    activeSkillIds: [...skillState.activeSkillIds],
  };
  const createdAt = isoTimestamp(options.runtime);
  const initialSkillRecord: SkillStateSessionRecord | undefined =
    skillState.skillActivations.length > 0 ||
    skillState.activeSkillIds.length > 0
      ? {
          schemaVersion: SESSION_SCHEMA_VERSION,
          type: "skill_state" as const,
          timestamp: isoTimestamp(options.runtime),
          messageOrdinal: 0,
          skillActivations: persistedSkillState.skillActivations,
          activeSkillIds: persistedSkillState.activeSkillIds,
        }
      : undefined;
  writeInitialHeader(
    filePath,
    {
      schemaVersion: SESSION_SCHEMA_VERSION,
      type: "session",
      id: options.sessionId,
      createdAt,
      workspace,
      graph,
    },
    initialSkillRecord === undefined ? [] : [initialSkillRecord],
  );
  return sessionStateFromReplay({
    id: options.sessionId,
    filePath,
    workspace,
    graph,
    storedMessages: [],
    pendingInputsById: new Map(),
    bashApprovalGrants: [],
    taskProgress: emptySessionTaskProgress(),
    skillActivations: skillState.skillActivations,
    activeSkillIds: skillState.activeSkillIds,
    skillStateCheckpoints: [
      {
        messageOrdinal: 0,
        skillActivations: skillState.skillActivations,
        activeSkillIds: skillState.activeSkillIds,
      },
    ],
  });
}

function sessionModelSelectionsEqual(
  left: SessionModelSelection,
  right: SessionModelSelection,
): boolean {
  return left.providerId === right.providerId && left.model === right.model;
}

function appendBashApprovalGrant(
  grants: readonly BashApprovalGrant[],
  grant: BashApprovalGrant,
): BashApprovalGrant[] {
  const key = bashApprovalGrantKey(grant);
  if (
    grants.some((existingGrant) => bashApprovalGrantKey(existingGrant) === key)
  ) {
    return [...grants];
  }
  return [...grants, copyBashApprovalGrant(grant)];
}

function removeBashApprovalGrant(
  grants: readonly BashApprovalGrant[],
  grant: BashApprovalGrant,
): BashApprovalGrant[] {
  const key = bashApprovalGrantKey(grant);
  return grants.filter(
    (existingGrant) => bashApprovalGrantKey(existingGrant) !== key,
  );
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

function taskProgressForForkPoint(options: {
  readonly source: SessionState;
  readonly forkedMessageCount: number;
}): SessionTaskProgress {
  let taskProgress = emptySessionTaskProgress();
  for (const checkpoint of replayStateForSession(options.source)
    .taskProgressCheckpoints) {
    if (checkpoint.messageOrdinal <= options.forkedMessageCount) {
      taskProgress = checkpoint.taskProgress;
    }
  }
  return copySessionTaskProgress(taskProgress);
}

function skillStateForForkPoint(options: {
  readonly source: SessionState;
  readonly forkedMessageCount: number;
}): SkillLifecycleState {
  let state: SkillLifecycleState = {
    skillActivations: [],
    activeSkillIds: [],
  };
  for (const checkpoint of replayStateForSession(options.source)
    .skillStateCheckpoints) {
    if (checkpoint.messageOrdinal <= options.forkedMessageCount) {
      state = checkpoint;
    }
  }
  return copySkillLifecycleState(state);
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
  parseSessionMessages(
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
  const taskProgress = taskProgressForForkPoint({
    source: options.source,
    forkedMessageCount: storedMessages.length,
  });
  const taskProgressCheckpoints = sessionTaskProgressesEqual(
    taskProgress,
    emptySessionTaskProgress(),
  )
    ? []
    : [{ messageOrdinal: 0, taskProgress }];
  const skillState = skillStateForForkPoint({
    source: options.source,
    forkedMessageCount: storedMessages.length,
  });
  const session = createEmptySessionStore({
    sessionId: options.targetSessionId,
    workspace: options.source.workspace,
    runtime: options.runtime,
    graph,
    skillState,
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
    taskProgress,
    taskProgressCheckpoints,
    skillActivations: skillState.skillActivations,
    activeSkillIds: skillState.activeSkillIds,
    skillStateCheckpoints: [
      {
        messageOrdinal: 0,
        skillActivations: skillState.skillActivations,
        activeSkillIds: skillState.activeSkillIds,
      },
    ],
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
  if (!sessionTaskProgressesEqual(taskProgress, emptySessionTaskProgress())) {
    appendJsonLine(session.filePath, {
      schemaVersion: SESSION_SCHEMA_VERSION,
      type: "task_progress",
      timestamp,
      messageOrdinal: 0,
      tasks: redactSessionTaskProgressForPersistence(taskProgress).tasks,
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
  let taskProgress = emptySessionTaskProgress();
  let taskProgressCheckpoints: SessionTaskProgressCheckpoint[] = [];
  let title: string | undefined;
  let goal: SessionGoal | undefined;
  let skillActivations: SkillActivation[] = [];
  let activeSkillIds: string[] = [];
  let skillStateCheckpoints: SessionSkillStateCheckpoint[] = [
    {
      messageOrdinal: 0,
      skillActivations: [],
      activeSkillIds: [],
    },
  ];
  for (const record of records.mutations) {
    switch (record.type) {
      case "append":
        storedMessages = [
          ...storedMessages,
          ...record.messages.map(copyStoredMessage),
        ];
        if (record.skillState !== undefined) {
          skillActivations =
            record.skillState.skillActivations.map(copySkillActivation);
          activeSkillIds = [...record.skillState.activeSkillIds];
          skillStateCheckpoints = [
            ...skillStateCheckpoints,
            {
              messageOrdinal: storedMessages.length,
              skillActivations: skillActivations.map(copySkillActivation),
              activeSkillIds: [...activeSkillIds],
            },
          ];
        }
        consumeReplayInputs(pendingInputsById, record.consumedInputIds);
        break;
      case "replace":
        storedMessages = record.messages.map(copyStoredMessage);
        if (record.skillState !== undefined) {
          skillActivations =
            record.skillState.skillActivations.map(copySkillActivation);
          activeSkillIds = [...record.skillState.activeSkillIds];
        }
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
        taskProgressCheckpoints = sessionTaskProgressesEqual(
          taskProgress,
          emptySessionTaskProgress(),
        )
          ? []
          : [{ messageOrdinal: 0, taskProgress }];
        skillStateCheckpoints = [
          {
            messageOrdinal: 0,
            skillActivations: skillActivations.map(copySkillActivation),
            activeSkillIds: [...activeSkillIds],
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
      case "session_title":
        title = record.title;
        consumeReplayInputs(pendingInputsById, record.consumedInputIds);
        break;
      case "session_goal":
        goal = record.goal === null ? undefined : copySessionGoal(record.goal);
        consumeReplayInputs(pendingInputsById, record.consumedInputIds);
        break;
      case "task_progress":
        taskProgress = {
          tasks: record.tasks.map((task) => ({
            step: task.step,
            status: task.status,
          })),
        };
        taskProgressCheckpoints = [
          ...taskProgressCheckpoints,
          {
            messageOrdinal: record.messageOrdinal,
            taskProgress: copySessionTaskProgress(taskProgress),
          },
        ];
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
          bashApprovalGrants = appendBashApprovalGrant(
            bashApprovalGrants,
            record.grant,
          );
        }
        break;
      case "bash_approval_revoked":
        if (!bashApprovalGrantHasRedactionMarker(record.grant)) {
          bashApprovalGrants = removeBashApprovalGrant(
            bashApprovalGrants,
            record.grant,
          );
        }
        consumeReplayInputs(pendingInputsById, record.consumedInputIds);
        break;
      case "bash_approvals_cleared":
        bashApprovalGrants = [];
        consumeReplayInputs(pendingInputsById, record.consumedInputIds);
        break;
      case "skill_state":
        skillActivations = record.skillActivations.map(copySkillActivation);
        activeSkillIds = [...record.activeSkillIds];
        skillStateCheckpoints = [
          ...skillStateCheckpoints,
          {
            messageOrdinal: record.messageOrdinal,
            skillActivations: skillActivations.map(copySkillActivation),
            activeSkillIds: [...activeSkillIds],
          },
        ];
        consumeReplayInputs(pendingInputsById, record.consumedInputIds);
        break;
      case "snapshot": {
        title = record.title;
        goal =
          record.goal === undefined ? undefined : copySessionGoal(record.goal);
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
        taskProgressCheckpoints = (record.taskProgressCheckpoints ?? []).map(
          (checkpoint) => ({
            messageOrdinal: checkpoint.messageOrdinal,
            taskProgress: copySessionTaskProgress(checkpoint.taskProgress),
          }),
        );
        taskProgress =
          taskProgressCheckpoints.at(-1)?.taskProgress ??
          emptySessionTaskProgress();
        skillStateCheckpoints = record.skillStateCheckpoints.map(
          (checkpoint) => ({
            messageOrdinal: checkpoint.messageOrdinal,
            skillActivations:
              checkpoint.skillActivations.map(copySkillActivation),
            activeSkillIds: [...checkpoint.activeSkillIds],
          }),
        );
        const snapshotSkillState = skillStateCheckpoints.at(-1);
        /* v8 ignore next 3 -- the snapshot schema requires at least one lifecycle checkpoint. */
        if (snapshotSkillState === undefined) {
          sessionStoreError(
            "Error: session snapshot has no skill lifecycle state.",
          );
        }
        skillActivations =
          snapshotSkillState.skillActivations.map(copySkillActivation);
        activeSkillIds = [...snapshotSkillState.activeSkillIds];
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
    taskProgress,
    taskProgressCheckpoints,
    ...(title !== undefined ? { title } : {}),
    ...(goal !== undefined ? { goal } : {}),
    ...(activeModel !== undefined
      ? { activeModel: copySessionModelSelection(activeModel) }
      : {}),
    modelSwitches,
    skillActivations,
    activeSkillIds,
    skillStateCheckpoints,
  });
}

export function persistSessionTitle(options: {
  readonly session: SessionState;
  readonly title: string;
  readonly runtime: SessionStoreRuntime;
  readonly consumedInputIds?: readonly string[];
}): string {
  const title = normalizeSessionTitleForPersistence(options.title);
  if (title === "") {
    sessionStoreError("Error: /title requires non-empty text.");
  }
  const consumedInputIds = uniqueInputIds(options.consumedInputIds ?? []);
  const timestamp = isoTimestamp(options.runtime);
  appendJsonLine(
    options.session.filePath,
    sessionRecordWithConsumedInputIds(
      {
        schemaVersion: SESSION_SCHEMA_VERSION,
        type: "session_title",
        timestamp,
        title,
      },
      consumedInputIds,
    ),
  );
  const replayState = replayStateForSession(options.session);
  replayState.title = title;
  consumeReplayInputs(replayState.pendingInputsById, consumedInputIds);
  appendSessionSnapshotIfNeeded({
    session: options.session,
    runtime: options.runtime,
  });
  return title;
}

export function persistSessionGoal(options: {
  readonly session: SessionState;
  readonly goal: SessionGoal | null;
  readonly runtime: SessionStoreRuntime;
  readonly consumedInputIds?: readonly string[];
}): SessionGoal | undefined {
  const goal = (() => {
    if (options.goal === null) {
      return null;
    }
    const redactedGoal = redactSessionGoalForPersistence(options.goal);
    const validatedGoal = sessionGoalSchema.safeParse(redactedGoal);
    if (!validatedGoal.success) {
      sessionStoreError(
        "Error: session goal is invalid after persistence redaction.",
      );
    }
    return validatedGoal.data;
  })();
  const consumedInputIds = uniqueInputIds(options.consumedInputIds ?? []);
  const timestamp = isoTimestamp(options.runtime);
  appendJsonLine(
    options.session.filePath,
    sessionRecordWithConsumedInputIds(
      {
        schemaVersion: SESSION_SCHEMA_VERSION,
        type: "session_goal",
        timestamp,
        goal,
      },
      consumedInputIds,
    ),
  );
  const replayState = replayStateForSession(options.session);
  if (goal === null) {
    delete replayState.goal;
  } else {
    replayState.goal = copySessionGoal(goal);
  }
  consumeReplayInputs(replayState.pendingInputsById, consumedInputIds);
  appendSessionSnapshotIfNeeded({
    session: options.session,
    runtime: options.runtime,
  });
  return replayState.goal === undefined
    ? undefined
    : copySessionGoal(replayState.goal);
}

export function persistSessionTaskProgress(options: {
  readonly session: SessionState;
  readonly taskProgress: SessionTaskProgress;
  readonly messageOrdinal?: number;
  readonly runtime: SessionStoreRuntime;
}): void {
  const replayState = replayStateForSession(options.session);
  if (
    sessionTaskProgressesEqual(replayState.taskProgress, options.taskProgress)
  ) {
    return;
  }
  const taskProgress = redactSessionTaskProgressForPersistence(
    options.taskProgress,
  );
  appendJsonLine(options.session.filePath, {
    schemaVersion: SESSION_SCHEMA_VERSION,
    type: "task_progress",
    timestamp: isoTimestamp(options.runtime),
    messageOrdinal: options.messageOrdinal ?? replayState.storedMessages.length,
    tasks: taskProgress.tasks,
  });
  replaceReplayTaskProgress(
    replayState,
    taskProgress,
    options.messageOrdinal ?? replayState.storedMessages.length,
  );
  appendSessionSnapshotIfNeeded({
    session: options.session,
    runtime: options.runtime,
  });
}

export function persistSessionMessages(options: {
  readonly session: SessionState;
  readonly previousMessages: readonly Message[];
  readonly currentMessages: readonly Message[];
  readonly runtime: SessionStoreRuntime;
  readonly reason: SessionPersistenceReason;
  readonly skillState?: SkillLifecycleState;
  readonly consumedInputIds?: readonly string[];
}): readonly SessionMessage[] {
  const currentMessages = parseSessionMessages(
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
  const persistedSkillState =
    options.skillState === undefined
      ? undefined
      : {
          skillActivations: options.skillState.skillActivations.map(
            redactSkillActivationForPersistence,
          ),
          activeSkillIds: [...options.skillState.activeSkillIds],
        };

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
    return [...currentMessages];
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
          ...(persistedSkillState !== undefined
            ? { skillState: persistedSkillState }
            : {}),
        },
        consumedInputIds,
      ),
    );
    replaceReplayMessages(replayState, currentStoredMessages);
    if (persistedSkillState !== undefined) {
      appendReplaySkillState(replayState, persistedSkillState);
    }
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
        ...(persistedSkillState !== undefined
          ? { skillState: persistedSkillState }
          : {}),
      },
      consumedInputIds,
    ),
  );
  replaceReplayMessages(replayState, currentStoredMessages);
  rebaseReplayModelSwitchesAfterReplace(replayState, timestamp);
  rebaseReplaySkillStateAfterReplace(replayState, persistedSkillState);
  rebaseReplayTaskProgressAfterReplace(replayState);
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

export function persistSessionSkillState(options: {
  readonly session: SessionState;
  readonly state: SkillLifecycleState;
  readonly runtime: SessionStoreRuntime;
  readonly consumedInputIds?: readonly string[];
}): void {
  const replayState = replayStateForSession(options.session);
  const checkpoint: SessionSkillStateCheckpoint = {
    messageOrdinal: replayState.storedMessages.length,
    skillActivations: options.state.skillActivations.map(copySkillActivation),
    activeSkillIds: [...options.state.activeSkillIds],
  };
  appendJsonLine(options.session.filePath, {
    schemaVersion: SESSION_SCHEMA_VERSION,
    type: "skill_state",
    timestamp: isoTimestamp(options.runtime),
    messageOrdinal: checkpoint.messageOrdinal,
    skillActivations: checkpoint.skillActivations.map(
      redactSkillActivationForPersistence,
    ),
    activeSkillIds: [...checkpoint.activeSkillIds],
    ...(options.consumedInputIds === undefined
      ? {}
      : { consumedInputIds: uniqueInputIds(options.consumedInputIds) }),
  });
  replayState.skillStateCheckpoints.push(checkpoint);
  consumeReplayInputs(replayState.pendingInputsById, options.consumedInputIds);
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
    const replayState = replayStateForSession(options.session);
    replayState.bashApprovalGrants.splice(
      0,
      replayState.bashApprovalGrants.length,
      ...appendBashApprovalGrant(replayState.bashApprovalGrants, grant),
    );
  }
  appendSessionSnapshotIfNeeded({
    session: options.session,
    runtime: options.runtime,
  });
}

export function persistSessionBashApprovalRevoked(options: {
  readonly session: SessionState;
  readonly grant: BashApprovalGrant;
  readonly runtime: SessionStoreRuntime;
  readonly consumedInputIds?: readonly string[];
}): void {
  const grant = redactBashApprovalGrantForPersistence(options.grant);
  const consumedInputIds = uniqueInputIds(options.consumedInputIds ?? []);
  appendJsonLine(options.session.filePath, {
    schemaVersion: SESSION_SCHEMA_VERSION,
    type: "bash_approval_revoked",
    timestamp: isoTimestamp(options.runtime),
    grant,
    ...(consumedInputIds.length > 0 ? { consumedInputIds } : {}),
  });
  const replayState = replayStateForSession(options.session);
  if (!bashApprovalGrantHasRedactionMarker(grant)) {
    replayState.bashApprovalGrants.splice(
      0,
      replayState.bashApprovalGrants.length,
      ...removeBashApprovalGrant(replayState.bashApprovalGrants, grant),
    );
  }
  consumeReplayInputs(replayState.pendingInputsById, consumedInputIds);
  appendSessionSnapshotIfNeeded({
    session: options.session,
    runtime: options.runtime,
  });
}

export function persistSessionBashApprovalsCleared(options: {
  readonly session: SessionState;
  readonly runtime: SessionStoreRuntime;
  readonly consumedInputIds?: readonly string[];
}): void {
  const consumedInputIds = uniqueInputIds(options.consumedInputIds ?? []);
  appendJsonLine(options.session.filePath, {
    schemaVersion: SESSION_SCHEMA_VERSION,
    type: "bash_approvals_cleared",
    timestamp: isoTimestamp(options.runtime),
    ...(consumedInputIds.length > 0 ? { consumedInputIds } : {}),
  });
  const replayState = replayStateForSession(options.session);
  replayState.bashApprovalGrants.splice(0);
  consumeReplayInputs(replayState.pendingInputsById, consumedInputIds);
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
