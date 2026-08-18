import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type {
  PersistedSessionMessage,
  SessionMessage,
} from "../../agent/session-message.ts";
import { copySessionGoal, type SessionGoal } from "../../core/session-goal.ts";
import {
  copySessionTaskProgress,
  emptySessionTaskProgress,
  type SessionTaskProgress,
  sessionTaskProgressesEqual,
} from "../../core/task-progress.ts";
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
import {
  type ToolJsonValue,
  toolCallCanonicalArguments,
  toolCallRecoveryCapability,
} from "../../tools/registry.ts";
import { redactMessageForPersistence } from "../persistence-redaction.ts";
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
  inspectSessionLedgerTail,
  readSessionRecords,
  readSessionRecordsAtSize,
  writeInitialHeader,
} from "./ledger.ts";
import {
  type ActiveSessionProviderAttempt,
  type ActiveSessionTask,
  type ActiveSessionToolInvocation,
  SESSION_SCHEMA_VERSION,
  type SessionGraphRecord,
  type SessionLastTaskOutcome,
  type SessionModelSelection,
  type SessionModelSwitch,
  type SessionPersistenceReason,
  type SessionProviderAttemptSettlement,
  type SessionQueuedInput,
  type SessionRecords,
  type SessionReplayState,
  type SessionSkillStateCheckpoint,
  type SessionState,
  type SessionStoreRuntime,
  type SessionTaskProgressCheckpoint,
  type SessionTaskRecoveryDisposition,
  type SessionToolContinuationEffects,
  type SessionToolEffectReconciliation,
  type SessionToolEffectRecoveryPolicy,
  type SkillStateSessionRecord,
  type StoredMessage,
} from "./model.ts";
import { sessionFilePath } from "./paths.ts";
import {
  bashApprovalGrantHasRedactionMarker,
  copyActiveSessionTask,
  copyBashApprovalGrant,
  copySessionLastTaskOutcome,
  copyStoredMessage,
  messagesFromStoredMessages,
  normalizeSessionTitleForPersistence,
  parseSessionMessages,
  redactBashApprovalGrantForPersistence,
  redactSessionGoalForPersistence,
  redactSessionQueuedInputForPersistence,
  redactSessionTaskProgressForPersistence,
  redactSessionToolContinuationEffectsForPersistence,
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
  createSessionMessageId,
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
  storedMessagesForSessionMessages,
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

function providerSettlementAllowsAnotherRequest(
  settlement: SessionProviderAttemptSettlement | undefined,
): boolean {
  return (
    settlement?.outcome === "completed" ||
    settlement?.outcome === "retryable_error" ||
    settlement?.outcome === "context_overflow"
  );
}

const canonicalToolArgumentsSchema = z.record(z.string(), z.json());

function canonicalToolArguments(
  toolCall: Parameters<typeof toolCallCanonicalArguments>[0],
): Readonly<Record<string, ToolJsonValue>> {
  const result = canonicalToolArgumentsSchema.safeParse(
    toolCallCanonicalArguments(toolCall),
  );
  /* v8 ignore next 3 -- parsed ToolCall variants contain only schema-validated JSON values; retain a fail-closed guard for future variants. */
  if (!result.success) {
    sessionStoreError("Error: canonical tool arguments are not JSON values.");
  }
  return result.data;
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

function replaySessionStore(options: {
  readonly sessionId: string;
  readonly expectedWorkspace: string;
  readonly filePath: string;
  readonly records: SessionRecords;
}): SessionState {
  const { expectedWorkspace, filePath, records } = options;
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
  let activeTask: ActiveSessionTask | undefined;
  let lastTaskOutcome: SessionLastTaskOutcome | undefined;
  let skillActivations: SkillActivation[] = [];
  let activeSkillIds: string[] = [];
  let skillStateCheckpoints: SessionSkillStateCheckpoint[] = [
    {
      messageOrdinal: 0,
      skillActivations: [],
      activeSkillIds: [],
    },
  ];

  const taskIdentityMatches = (
    current: ActiveSessionTask,
    next: ActiveSessionTask,
    allowNewRun = false,
  ): boolean =>
    current.taskId === next.taskId &&
    (allowNewRun || current.runId === next.runId) &&
    current.trigger === next.trigger &&
    current.admittedAt === next.admittedAt &&
    current.userMessageId === next.userMessageId &&
    sessionModelSelectionsEqual(current.provider, next.provider) &&
    current.maxProviderReplacements === next.maxProviderReplacements &&
    current.toolEffectRecoveryPolicy === next.toolEffectRecoveryPolicy;

  const unknownEffectOperationIsGrounded = (
    taskId: string,
    operationId: string,
    task?: ActiveSessionTask,
  ): boolean =>
    storedMessages.some(
      ({ message }) =>
        message.role === "tool" &&
        message.recovery?.kind === "interrupted_effect_unknown" &&
        message.recovery.taskId === taskId &&
        message.recovery.operationId === operationId,
    ) ||
    (task !== undefined &&
      "toolInvocations" in task &&
      task.toolInvocations.some(
        (invocation) =>
          invocation.phase === "settled" &&
          invocation.kind === "interrupted_effect_unknown" &&
          invocation.operationId === operationId,
      ));

  const validTaskRecoveryTransition = (
    current: ActiveSessionTask,
    next: Extract<
      ActiveSessionTask,
      { readonly phase: "provider_ready" | "recovery_blocked" }
    >,
  ): boolean => {
    if (!taskIdentityMatches(current, next, true)) {
      return false;
    }
    if (
      current.phase !== "recovery_blocked" &&
      isDeepStrictEqual(next, {
        ...current,
        phase: "recovery_blocked",
        reason: "provider_budget",
      })
    ) {
      return true;
    }
    if (!next.recovered) return false;
    if (
      current.phase === "provider_settled" ||
      current.phase === "tool_execution"
    ) {
      return false;
    }
    if (current.phase === "recovery_blocked") return false;
    if (
      current.phase === "provider_pending" &&
      (current.providerAttempt.settlement?.outcome === "terminal_error" ||
        current.providerAttempt.settlement?.outcome === "aborted")
    ) {
      return false;
    }

    const unknownAttemptId =
      current.phase === "provider_pending" &&
      (current.providerAttempt.settlement === undefined ||
        current.providerAttempt.settlement.outcome === "completed")
        ? current.providerAttempt.attemptId
        : null;
    const unknownProviderAttemptIds =
      unknownAttemptId === null ||
      current.unknownProviderAttemptIds.includes(unknownAttemptId)
        ? [...current.unknownProviderAttemptIds]
        : [...current.unknownProviderAttemptIds, unknownAttemptId];
    const replacements =
      current.providerReplacementsUsed +
      (current.phase === "provider_pending" ? 1 : 0);
    if (
      current.phase === "provider_pending" &&
      replacements > current.maxProviderReplacements
    ) {
      return isDeepStrictEqual(next, {
        ...current,
        phase: "recovery_blocked",
        providerReplacementsUsed: current.providerReplacementsUsed,
        unknownProviderAttemptIds,
        recovered: true,
        reason: "provider_replacement_limit",
      });
    }
    if (next.phase !== "provider_ready" || next.runId === current.runId) {
      return false;
    }
    return isDeepStrictEqual(next, {
      taskId: current.taskId,
      runId: next.runId,
      trigger: current.trigger,
      admittedAt: current.admittedAt,
      userMessageId: current.userMessageId,
      provider: current.provider,
      maxProviderReplacements: current.maxProviderReplacements,
      providerReplacementsUsed: replacements,
      recovered: true,
      providerRequestIds: current.providerRequestIds,
      unknownProviderAttemptIds,
      toolEffectRecoveryPolicy: current.toolEffectRecoveryPolicy,
      acceptedUnknownEffectOperationIds:
        current.acceptedUnknownEffectOperationIds,
      phase: "provider_ready",
    });
  };

  const validPersistedToolMetadata = (task: {
    readonly assistantMessage: StoredMessage;
    readonly toolInvocations: readonly ActiveSessionToolInvocation[];
    readonly expectedRunId?: string;
  }): boolean => {
    const assistantMessage = task.assistantMessage.message;
    if (
      assistantMessage.role !== "assistant" ||
      assistantMessage.toolCalls.length !== task.toolInvocations.length ||
      new Set(task.toolInvocations.map((item) => item.operationId)).size !==
        task.toolInvocations.length ||
      new Set(task.toolInvocations.map((item) => item.resultMessageId)).size !==
        task.toolInvocations.length ||
      new Set(task.toolInvocations.map((item) => item.toolCallId)).size !==
        task.toolInvocations.length
    ) {
      return false;
    }
    return task.toolInvocations.every((invocation, sourceIndex) => {
      const toolCall = assistantMessage.toolCalls[sourceIndex];
      /* v8 ignore next -- the length equality above guarantees one provider tool call for every source index. */
      if (toolCall === undefined) return false;
      const canonicalArguments = canonicalToolArguments(toolCall);
      return (
        invocation.sourceIndex === sourceIndex &&
        (task.expectedRunId === undefined ||
          invocation.runId === task.expectedRunId) &&
        invocation.toolCallId === toolCall.id &&
        invocation.toolName === toolCall.tool &&
        isDeepStrictEqual(
          invocation.recovery,
          toolCallRecoveryCapability(toolCall),
        ) &&
        isDeepStrictEqual(invocation.canonicalArguments, canonicalArguments) &&
        invocation.argumentsSha256 ===
          createHash("sha256")
            .update(canonicalToolJson(canonicalArguments))
            .digest("hex")
      );
    });
  };
  const validPersistedToolPlan = (
    task: Extract<ActiveSessionTask, { readonly phase: "tool_execution" }>,
  ): boolean =>
    validPersistedToolMetadata({ ...task, expectedRunId: task.runId }) &&
    task.toolInvocations.every((invocation) => invocation.phase === "planned");

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
      case "task_admitted":
        if (activeTask !== undefined) {
          sessionStoreError(
            `Error: cannot resume session "${options.sessionId}": task ${JSON.stringify(record.task.taskId)} was admitted while another Task was active.`,
          );
        }
        if (
          storedMessages.some((message) => message.id === record.userMessage.id)
        ) {
          sessionStoreError(
            `Error: cannot resume session "${options.sessionId}": task user message id ${JSON.stringify(record.userMessage.id)} is not unique.`,
          );
        }
        if (
          record.userMessage.id !== record.task.userMessageId ||
          record.userMessage.message.role !== "user"
        ) {
          sessionStoreError(
            `Error: cannot resume session "${options.sessionId}": task admission does not match its user message.`,
          );
        }
        if (
          record.task.providerReplacementsUsed !== 0 ||
          record.task.recovered ||
          record.task.providerRequestIds.length !== 0 ||
          record.task.unknownProviderAttemptIds.length !== 0 ||
          record.task.acceptedUnknownEffectOperationIds.length !== 0
        ) {
          sessionStoreError(
            `Error: cannot resume session "${options.sessionId}": task admission is not a canonical initial Task.`,
          );
        }
        storedMessages = [
          ...storedMessages,
          copyStoredMessage(record.userMessage),
        ];
        consumeReplayInputs(pendingInputsById, record.consumedInputIds);
        activeTask = copyActiveSessionTask(record.task);
        break;
      case "provider_intent": {
        if (
          activeTask === undefined ||
          !taskIdentityMatches(activeTask, record.task) ||
          record.task.providerAttempt.settlement !== undefined ||
          (activeTask.phase !== "provider_ready" &&
            (activeTask.phase !== "provider_pending" ||
              !providerSettlementAllowsAnotherRequest(
                activeTask.providerAttempt.settlement,
              ))) ||
          (activeTask.phase === "provider_pending" &&
            (activeTask.providerAttempt.attemptId ===
              record.task.providerAttempt.attemptId ||
              activeTask.providerAttempt.responseMessageId ===
                record.task.providerAttempt.responseMessageId)) ||
          !isDeepStrictEqual(record.task.providerRequestIds, [
            ...activeTask.providerRequestIds,
            {
              attemptId: record.task.providerAttempt.attemptId,
              responseMessageId: record.task.providerAttempt.responseMessageId,
            },
          ]) ||
          new Set(
            record.task.providerRequestIds.map((request) => request.attemptId),
          ).size !== record.task.providerRequestIds.length ||
          new Set(
            record.task.providerRequestIds.map(
              (request) => request.responseMessageId,
            ),
          ).size !== record.task.providerRequestIds.length ||
          !isDeepStrictEqual(record.task, {
            ...activeTask,
            phase: "provider_pending",
            providerRequestIds: record.task.providerRequestIds,
            providerAttempt: record.task.providerAttempt,
          })
        ) {
          sessionStoreError(
            `Error: cannot resume session "${options.sessionId}": provider_intent is not a valid transition for the active Task.`,
          );
        }
        activeTask = copyActiveSessionTask(record.task);
        break;
      }
      case "provider_attempt_settled": {
        if (
          activeTask === undefined ||
          activeTask.phase !== "provider_pending" ||
          activeTask.providerAttempt.settlement !== undefined ||
          !taskIdentityMatches(activeTask, record.task) ||
          !isDeepStrictEqual(record.task, {
            ...activeTask,
            providerAttempt: {
              ...activeTask.providerAttempt,
              settlement: record.task.providerAttempt.settlement,
            },
          })
        ) {
          sessionStoreError(
            `Error: cannot resume session "${options.sessionId}": provider_attempt_settled does not match the active provider attempt.`,
          );
        }
        activeTask = copyActiveSessionTask(record.task);
        break;
      }
      case "provider_settled": {
        const expectedPhase =
          record.task.assistantMessage.message.role === "assistant" &&
          record.task.assistantMessage.message.toolCalls.length > 0
            ? "tool_execution"
            : "provider_settled";
        if (
          activeTask === undefined ||
          activeTask.phase !== "provider_pending" ||
          activeTask.providerAttempt.settlement?.outcome !== "completed" ||
          record.task.assistantMessage.message.role !== "assistant" ||
          record.task.assistantMessage.id !==
            activeTask.providerAttempt.responseMessageId ||
          !taskIdentityMatches(activeTask, record.task) ||
          record.task.phase !== expectedPhase ||
          (record.task.phase === "tool_execution" &&
            !validPersistedToolPlan(record.task)) ||
          !isDeepStrictEqual(record.task, {
            ...activeTask,
            phase: expectedPhase,
            assistantMessage: record.task.assistantMessage,
            stopReason: record.task.stopReason,
            ...(record.task.phase === "tool_execution"
              ? { toolInvocations: record.task.toolInvocations }
              : {}),
          })
        ) {
          sessionStoreError(
            `Error: cannot resume session "${options.sessionId}": provider_settled does not match the active provider attempt.`,
          );
        }
        activeTask = copyActiveSessionTask(record.task);
        break;
      }
      case "tool_intent": {
        if (
          activeTask === undefined ||
          activeTask.phase !== "tool_execution" ||
          !taskIdentityMatches(activeTask, record.task) ||
          new Set(record.operationIds).size !== record.operationIds.length
        ) {
          sessionStoreError(
            `Error: cannot resume session "${options.sessionId}": tool_intent does not match the active tool plan.`,
          );
        }
        const operationIds = new Set(record.operationIds);
        const expectedInvocations = activeTask.toolInvocations.map(
          (invocation) => {
            if (!operationIds.has(invocation.operationId)) return invocation;
            if (invocation.phase !== "planned") return null;
            operationIds.delete(invocation.operationId);
            return {
              ...invocation,
              phase: "effect_pending" as const,
              startedAt: record.timestamp,
            };
          },
        );
        if (
          operationIds.size > 0 ||
          expectedInvocations.some((invocation) => invocation === null) ||
          !isDeepStrictEqual(record.task, {
            ...activeTask,
            toolInvocations: expectedInvocations,
          })
        ) {
          sessionStoreError(
            `Error: cannot resume session "${options.sessionId}": tool_intent is not a canonical transition.`,
          );
        }
        activeTask = copyActiveSessionTask(record.task);
        break;
      }
      case "effect_reconciled": {
        if (
          activeTask === undefined ||
          activeTask.phase !== "tool_execution" ||
          !taskIdentityMatches(activeTask, record.task)
        ) {
          sessionStoreError(
            `Error: cannot resume session "${options.sessionId}": effect_reconciled does not match the active tool plan.`,
          );
        }
        const prior = activeTask.toolInvocations.find(
          (invocation) => invocation.operationId === record.operationId,
        );
        const reconciled = record.task.toolInvocations.find(
          (invocation) => invocation.operationId === record.operationId,
        );
        const expectedInvocations = activeTask.toolInvocations.map(
          (invocation) =>
            invocation.operationId === record.operationId
              ? reconciled
              : invocation,
        );
        if (
          prior?.phase !== "effect_pending" ||
          prior.reconciliation !== undefined ||
          reconciled?.phase !== "effect_pending" ||
          !toolEffectReconciliationIsCanonical(
            options.sessionId,
            reconciled,
            record.reconciliation,
          ) ||
          !isDeepStrictEqual(
            reconciled.reconciliation,
            record.reconciliation,
          ) ||
          !isDeepStrictEqual(record.task, {
            ...activeTask,
            toolInvocations: expectedInvocations,
          })
        ) {
          sessionStoreError(
            `Error: cannot resume session "${options.sessionId}": effect_reconciled is not a canonical transition.`,
          );
        }
        activeTask = copyActiveSessionTask(record.task);
        break;
      }
      case "tool_settled": {
        if (
          activeTask === undefined ||
          activeTask.phase !== "tool_execution" ||
          !taskIdentityMatches(activeTask, record.task)
        ) {
          sessionStoreError(
            `Error: cannot resume session "${options.sessionId}": tool_settled does not match the active tool plan.`,
          );
        }
        const prior = activeTask.toolInvocations.find(
          (invocation) => invocation.operationId === record.operationId,
        );
        const settled = record.task.toolInvocations.find(
          (invocation) => invocation.operationId === record.operationId,
        );
        const validKind =
          prior !== undefined &&
          settled?.phase === "settled" &&
          persistedToolSettlementIsCanonical(
            options.sessionId,
            activeTask.taskId,
            settled,
          ) &&
          validPersistedToolMetadata({
            assistantMessage: record.task.assistantMessage,
            toolInvocations: record.task.toolInvocations,
            expectedRunId: record.task.runId,
          }) &&
          !storedMessages.some(
            (message) => message.id === settled.toolMessage.id,
          ) &&
          !activeTask.toolInvocations.some(
            (invocation) =>
              invocation.phase === "settled" &&
              invocation.toolMessage.id === settled.toolMessage.id,
          ) &&
          ((settled.kind === "completed" &&
            prior.phase === "effect_pending" &&
            settled.startedAt === prior.startedAt) ||
            (settled.kind === "not_executed_after_restart" &&
              prior.phase === "planned" &&
              settled.startedAt === undefined) ||
            (settled.kind === "interrupted_no_effect" &&
              prior.phase === "effect_pending" &&
              prior.recovery.kind === "no_effect" &&
              settled.startedAt === prior.startedAt) ||
            (settled.kind === "interrupted_effect_unknown" &&
              prior.phase === "effect_pending" &&
              (prior.recovery.kind === "opaque" ||
                prior.recovery.kind === "owner_reconciled") &&
              isDeepStrictEqual(settled.reconciliation, prior.reconciliation) &&
              settled.startedAt === prior.startedAt));
        const expectedInvocations = activeTask.toolInvocations.map(
          (invocation) =>
            invocation.operationId === record.operationId
              ? settled
              : invocation,
        );
        if (
          !validKind ||
          settled === undefined ||
          record.task.toolInvocations.length !==
            activeTask.toolInvocations.length ||
          !isDeepStrictEqual(record.task, {
            ...activeTask,
            toolInvocations: expectedInvocations,
          })
        ) {
          sessionStoreError(
            `Error: cannot resume session "${options.sessionId}": tool_settled is not a canonical transition.`,
          );
        }
        const settlementOrdinal =
          storedMessages.length + settled.sourceIndex + 2;
        if (settled.effects.taskProgress !== undefined) {
          taskProgress = copySessionTaskProgress(settled.effects.taskProgress);
          taskProgressCheckpoints = [
            ...taskProgressCheckpoints,
            { messageOrdinal: settlementOrdinal, taskProgress },
          ];
        }
        if (settled.effects.goal !== undefined) {
          goal = copySessionGoal(settled.effects.goal);
        }
        if (settled.effects.skillState !== undefined) {
          skillActivations =
            settled.effects.skillState.skillActivations.map(
              copySkillActivation,
            );
          activeSkillIds = [...settled.effects.skillState.activeSkillIds];
          skillStateCheckpoints = [
            ...skillStateCheckpoints,
            {
              messageOrdinal: settlementOrdinal,
              skillActivations: skillActivations.map(copySkillActivation),
              activeSkillIds: [...activeSkillIds],
            },
          ];
        }
        activeTask = copyActiveSessionTask(record.task);
        break;
      }
      case "task_recovery_disposition": {
        if (
          activeTask === undefined ||
          activeTask.phase !== "tool_execution" ||
          activeTask.toolEffectRecoveryPolicy !== "accept_unknown" ||
          !taskIdentityMatches(activeTask, record.task) ||
          record.disposition.kind !== "accept_unknown" ||
          new Set(record.disposition.operationIds).size !==
            record.disposition.operationIds.length
        ) {
          sessionStoreError(
            `Error: cannot resume session "${options.sessionId}": task_recovery_disposition does not match the active Task.`,
          );
        }
        const accepted = new Set(activeTask.acceptedUnknownEffectOperationIds);
        const expectedOperationIds = activeTask.toolInvocations
          .filter(
            (invocation) =>
              invocation.phase === "settled" &&
              invocation.kind === "interrupted_effect_unknown" &&
              invocation.reconciliation === undefined &&
              !accepted.has(invocation.operationId),
          )
          .sort((left, right) => left.sourceIndex - right.sourceIndex)
          .map((invocation) => invocation.operationId);
        if (
          expectedOperationIds.length === 0 ||
          !isDeepStrictEqual(
            record.disposition.operationIds,
            expectedOperationIds,
          ) ||
          !isDeepStrictEqual(record.task, {
            ...activeTask,
            acceptedUnknownEffectOperationIds: [
              ...activeTask.acceptedUnknownEffectOperationIds,
              ...expectedOperationIds,
            ],
          })
        ) {
          sessionStoreError(
            `Error: cannot resume session "${options.sessionId}": task_recovery_disposition is not a canonical transition.`,
          );
        }
        activeTask = copyActiveSessionTask(record.task);
        break;
      }
      case "task_recovery_started":
        if (
          activeTask === undefined ||
          !validTaskRecoveryTransition(activeTask, record.task)
        ) {
          sessionStoreError(
            `Error: cannot resume session "${options.sessionId}": task_recovery_started does not match the active Task.`,
          );
        }
        activeTask = copyActiveSessionTask(record.task);
        break;
      case "step_committed": {
        if (
          activeTask === undefined ||
          (activeTask.phase !== "provider_settled" &&
            activeTask.phase !== "tool_execution")
        ) {
          sessionStoreError(
            `Error: cannot resume session "${options.sessionId}": step_committed does not match the active Task.`,
          );
        }
        const settledTask = activeTask;
        const toolRecovery =
          settledTask.phase === "tool_execution" &&
          record.task.runId !== settledTask.runId;
        const acceptedUnknownEffects = new Set(
          settledTask.acceptedUnknownEffectOperationIds,
        );
        const hasUnacceptedUnknownEffect =
          settledTask.phase === "tool_execution" &&
          settledTask.toolInvocations.some(
            (invocation) =>
              invocation.phase === "settled" &&
              invocation.kind === "interrupted_effect_unknown" &&
              invocation.reconciliation === undefined &&
              !acceptedUnknownEffects.has(invocation.operationId),
          );
        if (
          settledTask.taskId !== record.task.taskId ||
          !taskIdentityMatches(settledTask, record.task, toolRecovery) ||
          (toolRecovery
            ? record.task.runId === settledTask.runId || !record.task.recovered
            : record.task.runId !== settledTask.runId ||
              record.task.recovered !== settledTask.recovered) ||
          (hasUnacceptedUnknownEffect
            ? record.task.phase !== "recovery_blocked" ||
              record.task.reason !== "tool_effect" ||
              !isDeepStrictEqual(
                record.task.toolInvocations,
                settledTask.toolInvocations,
              )
            : record.task.phase !== "provider_ready") ||
          record.task.providerReplacementsUsed !==
            settledTask.providerReplacementsUsed ||
          !isDeepStrictEqual(
            record.task.providerRequestIds,
            settledTask.providerRequestIds,
          ) ||
          !isDeepStrictEqual(
            record.task.unknownProviderAttemptIds,
            settledTask.unknownProviderAttemptIds,
          ) ||
          !isDeepStrictEqual(
            record.task.acceptedUnknownEffectOperationIds,
            settledTask.acceptedUnknownEffectOperationIds,
          )
        ) {
          sessionStoreError(
            `Error: cannot resume session "${options.sessionId}": step_committed does not match the active Task.`,
          );
        }
        const responseIndex = record.messages.findLastIndex((message) =>
          isDeepStrictEqual(message, settledTask.assistantMessage),
        );
        const expectedToolMessages =
          settledTask.phase === "tool_execution"
            ? [...settledTask.toolInvocations]
                .sort((left, right) => left.sourceIndex - right.sourceIndex)
                .map((invocation) =>
                  invocation.phase === "settled"
                    ? invocation.toolMessage
                    : undefined,
                )
            : [];
        if (
          responseIndex < 0 ||
          expectedToolMessages.some(
            (message, index) =>
              message === undefined ||
              !isDeepStrictEqual(
                record.messages[responseIndex + index + 1],
                message,
              ),
          )
        ) {
          sessionStoreError(
            `Error: cannot resume session "${options.sessionId}": step_committed is missing the settled provider response.`,
          );
        }
        if (record.replaceTranscript === true) {
          const messageIds = new Set<string>();
          for (const message of record.messages) {
            /* v8 ignore next 5 -- persisted message ids are produced uniquely; duplicate-id corruption is rejected equivalently for append and replacement records. */
            if (messageIds.has(message.id)) {
              sessionStoreError(
                `Error: cannot resume session "${options.sessionId}": committed step message id ${JSON.stringify(message.id)} is not unique.`,
              );
            }
            messageIds.add(message.id);
          }
          storedMessages = record.messages.map(copyStoredMessage);
        } else {
          for (const message of record.messages) {
            /* v8 ignore next 5 -- persisted message ids are produced uniquely; duplicate-id corruption is rejected equivalently for append and replacement records. */
            if (storedMessages.some((stored) => stored.id === message.id)) {
              sessionStoreError(
                `Error: cannot resume session "${options.sessionId}": committed step message id ${JSON.stringify(message.id)} is not unique.`,
              );
            }
            storedMessages = [...storedMessages, copyStoredMessage(message)];
          }
        }
        consumeReplayInputs(pendingInputsById, record.consumedInputIds);
        activeTask = copyActiveSessionTask(record.task);
        break;
      }
      case "task_terminal": {
        const terminalResponse = record.messages.at(-1);
        const expectedResponseMessageId =
          terminalResponse?.message.role === "assistant"
            ? terminalResponse.id
            : undefined;
        if (
          activeTask === undefined ||
          activeTask.taskId !== record.taskId ||
          activeTask.runId !== record.runId ||
          record.lastTaskOutcome.taskId !== record.taskId ||
          record.lastTaskOutcome.runId !== record.runId ||
          record.lastTaskOutcome.timestamp !== record.timestamp ||
          record.lastTaskOutcome.recovered !== activeTask.recovered ||
          !isDeepStrictEqual(
            record.lastTaskOutcome.unknownProviderAttemptIds,
            activeTask.unknownProviderAttemptIds,
          ) ||
          !isDeepStrictEqual(
            record.lastTaskOutcome.unknownToolEffectOperationIds,
            activeTask.acceptedUnknownEffectOperationIds,
          ) ||
          record.lastTaskOutcome.responseMessageId !==
            expectedResponseMessageId ||
          (record.lastTaskOutcome.outcome === "completed" &&
            activeTask.acceptedUnknownEffectOperationIds.length > 0) ||
          (record.lastTaskOutcome.outcome ===
            "completed_with_unknown_effects" &&
            activeTask.acceptedUnknownEffectOperationIds.length === 0) ||
          ((record.lastTaskOutcome.outcome === "completed" ||
            record.lastTaskOutcome.outcome ===
              "completed_with_unknown_effects") &&
            (activeTask.phase !== "provider_settled" ||
              !isDeepStrictEqual(
                terminalResponse,
                activeTask.assistantMessage,
              )))
        ) {
          sessionStoreError(
            `Error: cannot resume session "${options.sessionId}": task_terminal does not match the active Task.`,
          );
        }
        if (record.replaceTranscript === true) {
          const messageIds = new Set<string>();
          for (const message of record.messages) {
            /* v8 ignore next 5 -- the writer assigns unique ids; this keeps replay fail-closed for externally corrupted replacement records. */
            if (messageIds.has(message.id)) {
              sessionStoreError(
                `Error: cannot resume session "${options.sessionId}": terminal message id ${JSON.stringify(message.id)} is not unique.`,
              );
            }
            messageIds.add(message.id);
          }
          storedMessages = record.messages.map(copyStoredMessage);
        } else {
          for (const message of record.messages) {
            /* v8 ignore next 5 -- the writer assigns unique ids; this keeps replay fail-closed for externally corrupted append records. */
            if (storedMessages.some((stored) => stored.id === message.id)) {
              sessionStoreError(
                `Error: cannot resume session "${options.sessionId}": terminal message id ${JSON.stringify(message.id)} is not unique.`,
              );
            }
            storedMessages = [...storedMessages, copyStoredMessage(message)];
          }
        }
        lastTaskOutcome = copySessionLastTaskOutcome(record.lastTaskOutcome);
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
        activeTask = undefined;
        break;
      }
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
        const snapshotSkillState = skillStateCheckpoints.reduce(
          (_previous, checkpoint) => checkpoint,
        );
        skillActivations =
          snapshotSkillState.skillActivations.map(copySkillActivation);
        activeSkillIds = [...snapshotSkillState.activeSkillIds];
        activeTask =
          record.activeTask === undefined
            ? undefined
            : copyActiveSessionTask(record.activeTask);
        if (activeTask !== undefined) {
          const snapshotActiveTask = activeTask;
          const providerRequestIds = activeTask.providerRequestIds;
          const providerAttempt = activeTask.providerAttempt;
          const assistantMessage = activeTask.assistantMessage;
          const isReplacementLimitBlocked =
            activeTask.phase === "recovery_blocked" &&
            activeTask.reason === "provider_replacement_limit";
          const isToolEffectBlocked =
            activeTask.phase === "recovery_blocked" &&
            activeTask.reason === "tool_effect";
          const currentProviderAttemptIsUnknown =
            providerAttempt !== undefined &&
            activeTask.unknownProviderAttemptIds.includes(
              providerAttempt.attemptId,
            );
          const currentProviderAttemptShouldBeUnknown =
            providerAttempt !== undefined &&
            (providerAttempt.settlement === undefined ||
              providerAttempt.settlement.outcome === "completed");
          const currentProviderAttemptEvidenceIsCanonical =
            currentProviderAttemptShouldBeUnknown
              ? currentProviderAttemptIsUnknown &&
                activeTask.unknownProviderAttemptIds.at(-1) ===
                  providerAttempt?.attemptId
              : !currentProviderAttemptIsUnknown;
          const replacementLimitStateIsCanonical =
            providerAttempt !== undefined &&
            activeTask.recovered &&
            activeTask.providerReplacementsUsed ===
              activeTask.maxProviderReplacements &&
            assistantMessage === undefined &&
            activeTask.stopReason === undefined &&
            providerAttempt.settlement?.outcome !== "terminal_error" &&
            providerAttempt.settlement?.outcome !== "aborted" &&
            currentProviderAttemptEvidenceIsCanonical;
          const admittedUserMessages = storedMessages.filter(
            (message) => message.id === activeTask?.userMessageId,
          );
          if (
            admittedUserMessages.length !== 1 ||
            admittedUserMessages[0]?.message.role !== "user"
          ) {
            sessionStoreError(
              `Error: cannot resume session "${options.sessionId}": snapshot active Task is missing its admitted user message.`,
            );
          }
          if (
            activeTask.providerReplacementsUsed >
              activeTask.maxProviderReplacements ||
            new Set(providerRequestIds.map((request) => request.attemptId))
              .size !== providerRequestIds.length ||
            new Set(
              providerRequestIds.map((request) => request.responseMessageId),
            ).size !== providerRequestIds.length ||
            new Set(activeTask.unknownProviderAttemptIds).size !==
              activeTask.unknownProviderAttemptIds.length ||
            new Set(activeTask.acceptedUnknownEffectOperationIds).size !==
              activeTask.acceptedUnknownEffectOperationIds.length ||
            (activeTask.acceptedUnknownEffectOperationIds.length > 0 &&
              (activeTask.toolEffectRecoveryPolicy !== "accept_unknown" ||
                (!activeTask.recovered &&
                  activeTask.phase !== "tool_execution"))) ||
            activeTask.acceptedUnknownEffectOperationIds.some(
              (operationId) =>
                !unknownEffectOperationIsGrounded(
                  snapshotActiveTask.taskId,
                  operationId,
                  snapshotActiveTask,
                ),
            ) ||
            activeTask.unknownProviderAttemptIds.some(
              (attemptId) =>
                !providerRequestIds.some(
                  (request) => request.attemptId === attemptId,
                ),
            ) ||
            (currentProviderAttemptIsUnknown && !isReplacementLimitBlocked) ||
            (!activeTask.recovered &&
              (activeTask.providerReplacementsUsed !== 0 ||
                activeTask.unknownProviderAttemptIds.length !== 0))
          ) {
            sessionStoreError(
              `Error: cannot resume session "${options.sessionId}": snapshot active Task has invalid recovery evidence.`,
            );
          }
          if (providerAttempt !== undefined) {
            const responseMessageId = providerAttempt.responseMessageId;
            if (
              !isDeepStrictEqual(providerRequestIds.at(-1), {
                attemptId: providerAttempt.attemptId,
                responseMessageId,
              }) ||
              (storedMessages.some(
                (message) => message.id === responseMessageId,
              ) &&
                !isToolEffectBlocked)
            ) {
              sessionStoreError(
                `Error: cannot resume session "${options.sessionId}": snapshot active Task reuses its provider response message id.`,
              );
            }
          }
          if (assistantMessage !== undefined) {
            if (
              providerAttempt?.settlement?.outcome !== "completed" ||
              assistantMessage.message.role !== "assistant" ||
              assistantMessage.id !== providerAttempt.responseMessageId ||
              activeTask.stopReason === undefined
            ) {
              sessionStoreError(
                `Error: cannot resume session "${options.sessionId}": snapshot settled provider response is invalid.`,
              );
            }
          }
          const toolInvocations =
            "toolInvocations" in activeTask
              ? activeTask.toolInvocations
              : undefined;
          if (toolInvocations !== undefined) {
            const activeTaskId = activeTask.taskId;
            const acceptedUnknownEffectOperationIds = new Set(
              activeTask.acceptedUnknownEffectOperationIds,
            );
            /* v8 ignore next 3 -- tool-execution and tool-effect-blocked schemas require the settled assistant message validated immediately above. */
            const assistantToolCalls =
              assistantMessage?.message.role === "assistant"
                ? assistantMessage.message.toolCalls
                : [];
            const toolStateIsCanonical =
              assistantMessage !== undefined &&
              validPersistedToolMetadata({
                assistantMessage,
                toolInvocations,
                ...(activeTask.phase === "tool_execution"
                  ? { expectedRunId: activeTask.runId }
                  : {}),
              }) &&
              toolInvocations.length === assistantToolCalls.length &&
              toolInvocations.every((invocation, sourceIndex) => {
                const toolCall = assistantToolCalls[sourceIndex];
                return (
                  toolCall !== undefined &&
                  invocation.sourceIndex === sourceIndex &&
                  invocation.toolCallId === toolCall.id &&
                  invocation.toolName === toolCall.tool &&
                  (invocation.phase !== "effect_pending" ||
                    invocation.reconciliation === undefined ||
                    toolEffectReconciliationIsCanonical(
                      options.sessionId,
                      invocation,
                      invocation.reconciliation,
                    )) &&
                  (invocation.phase !== "settled" ||
                    persistedToolSettlementIsCanonical(
                      options.sessionId,
                      activeTaskId,
                      invocation,
                    ))
                );
              });
            const blockedToolStateIsCanonical =
              !isToolEffectBlocked ||
              (toolInvocations.every(
                (invocation) => invocation.phase === "settled",
              ) &&
                toolInvocations.some(
                  (invocation) =>
                    invocation.phase === "settled" &&
                    invocation.kind === "interrupted_effect_unknown" &&
                    invocation.reconciliation === undefined &&
                    !acceptedUnknownEffectOperationIds.has(
                      invocation.operationId,
                    ),
                ));
            if (!toolStateIsCanonical || !blockedToolStateIsCanonical) {
              sessionStoreError(
                `Error: cannot resume session "${options.sessionId}": snapshot active Task has invalid tool recovery state.`,
              );
            }
          }
          if (
            (assistantMessage === undefined &&
              activeTask.stopReason !== undefined) ||
            (activeTask.phase === "recovery_blocked" &&
              activeTask.reason === "tool_effect" &&
              toolInvocations === undefined) ||
            (isReplacementLimitBlocked && !replacementLimitStateIsCanonical)
          ) {
            sessionStoreError(
              `Error: cannot resume session "${options.sessionId}": snapshot active Task has invalid provider state.`,
            );
          }
        }
        const snapshotLastTaskOutcome =
          record.lastTaskOutcome === undefined
            ? undefined
            : copySessionLastTaskOutcome(record.lastTaskOutcome);
        lastTaskOutcome = snapshotLastTaskOutcome;
        if (
          snapshotLastTaskOutcome !== undefined &&
          (new Set(snapshotLastTaskOutcome.unknownProviderAttemptIds).size !==
            snapshotLastTaskOutcome.unknownProviderAttemptIds.length ||
            new Set(snapshotLastTaskOutcome.unknownToolEffectOperationIds)
              .size !==
              snapshotLastTaskOutcome.unknownToolEffectOperationIds.length ||
            (!snapshotLastTaskOutcome.recovered &&
              (snapshotLastTaskOutcome.unknownProviderAttemptIds.length !== 0 ||
                snapshotLastTaskOutcome.unknownToolEffectOperationIds.length !==
                  0)) ||
            (snapshotLastTaskOutcome.outcome === "completed" &&
              snapshotLastTaskOutcome.unknownToolEffectOperationIds.length >
                0) ||
            (snapshotLastTaskOutcome.outcome ===
              "completed_with_unknown_effects" &&
              snapshotLastTaskOutcome.unknownToolEffectOperationIds.length ===
                0) ||
            snapshotLastTaskOutcome.unknownToolEffectOperationIds.some(
              (operationId) =>
                !unknownEffectOperationIsGrounded(
                  snapshotLastTaskOutcome.taskId,
                  operationId,
                ),
            ) ||
            (snapshotLastTaskOutcome.responseMessageId !== undefined &&
              storedMessages.filter(
                (message) =>
                  message.id === snapshotLastTaskOutcome.responseMessageId &&
                  message.message.role === "assistant",
              ).length !== 1))
        ) {
          sessionStoreError(
            `Error: cannot resume session "${options.sessionId}": snapshot last Task outcome is invalid.`,
          );
        }
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
    ...(activeTask !== undefined ? { activeTask } : {}),
    ...(lastTaskOutcome !== undefined ? { lastTaskOutcome } : {}),
  });
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
    let repairGuidance = "";
    try {
      const tail = inspectSessionLedgerTail(filePath);
      if (tail.kind === "invalid_unterminated_fragment") {
        repairGuidance = ` The ledger appears to end with an incomplete JSONL fragment. Run keel sessions repair ${options.sessionId} --truncate-incomplete-tail to validate and repair it explicitly.`;
      }
    } catch {
      repairGuidance = "";
    }
    sessionStoreError(
      `Error: cannot resume session "${options.sessionId}": ${message}${repairGuidance}`,
    );
  }
  return replaySessionStore({
    sessionId: options.sessionId,
    expectedWorkspace,
    filePath,
    records,
  });
}

export function validateSessionLedgerPrefix(options: {
  readonly sessionId: string;
  readonly workspace: string;
  readonly runtime: SessionStoreRuntime;
  readonly retainedBytes: number;
}): SessionState {
  const expectedWorkspace = realpathSync(options.workspace);
  const filePath = sessionFilePath(options.runtime, options.sessionId);
  let records: SessionRecords;
  try {
    records = readSessionRecordsAtSize(filePath, options.retainedBytes);
    return replaySessionStore({
      sessionId: options.sessionId,
      expectedWorkspace,
      filePath,
      records,
    });
  } catch (error) {
    const message = formatResumeSessionLoadError(error);
    sessionStoreError(
      `Error: cannot repair session "${options.sessionId}": the retained ledger prefix is invalid: ${message}`,
    );
  }
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
    return redactSessionGoalForPersistence(options.goal);
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
  readonly forceRecord?: boolean;
  readonly runtime: SessionStoreRuntime;
}): void {
  const replayState = replayStateForSession(options.session);
  if (
    options.forceRecord !== true &&
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

function activeTaskForSession(session: SessionState): ActiveSessionTask {
  const activeTask = replayStateForSession(session).activeTask;
  if (activeTask === undefined) {
    sessionStoreError(
      `Error: session ${JSON.stringify(session.id)} has no active durable Task.`,
    );
  }
  return activeTask;
}

export function activeSessionTask(
  session: SessionState,
): ActiveSessionTask | undefined {
  const activeTask = replayStateForSession(session).activeTask;
  return activeTask === undefined
    ? undefined
    : copyActiveSessionTask(activeTask);
}

export function persistSessionTaskAdmission(options: {
  readonly session: SessionState;
  readonly userMessage: Extract<SessionMessage, { readonly role: "user" }>;
  readonly provider: SessionModelSelection;
  readonly consumedInputIds: readonly string[];
  readonly userMessageId?: string;
  readonly runtime: SessionStoreRuntime;
  readonly maxProviderReplacements?: number;
  readonly toolEffectRecoveryPolicy: SessionToolEffectRecoveryPolicy;
}): Extract<ActiveSessionTask, { readonly phase: "provider_ready" }> {
  const replayState = replayStateForSession(options.session);
  if (replayState.activeTask !== undefined) {
    sessionStoreError(
      `Error: session ${JSON.stringify(options.session.id)} already has active Task ${JSON.stringify(replayState.activeTask.taskId)}.`,
    );
  }
  const [persistedUserMessage] = parseSessionMessages(
    options.session.id,
    [options.userMessage],
    "persist",
  );
  /* v8 ignore next 6 -- the public parameter is an extracted user-message type and parsing preserves the discriminant. */
  if (
    persistedUserMessage === undefined ||
    persistedUserMessage.role !== "user"
  ) {
    sessionStoreError(
      `Error: cannot admit durable Task for session ${JSON.stringify(options.session.id)}: user message is invalid.`,
    );
  }
  const timestamp = isoTimestamp(options.runtime);
  const userMessage = redactStoredMessageForPersistence({
    id: options.userMessageId ?? createSessionMessageId(),
    message: persistedUserMessage,
  });
  const task: Extract<ActiveSessionTask, { readonly phase: "provider_ready" }> =
    {
      taskId: `task_${randomUUID()}`,
      runId: `run_${randomUUID()}`,
      trigger: "user_prompt",
      admittedAt: timestamp,
      userMessageId: userMessage.id,
      provider: copySessionModelSelection(options.provider),
      maxProviderReplacements: options.maxProviderReplacements ?? 1,
      providerReplacementsUsed: 0,
      recovered: false,
      providerRequestIds: [],
      unknownProviderAttemptIds: [],
      toolEffectRecoveryPolicy: options.toolEffectRecoveryPolicy,
      acceptedUnknownEffectOperationIds: [],
      phase: "provider_ready",
    };
  const consumedInputIds = uniqueInputIds(options.consumedInputIds);
  appendJsonLine(options.session.filePath, {
    schemaVersion: SESSION_SCHEMA_VERSION,
    type: "task_admitted",
    timestamp,
    task,
    userMessage,
    ...(consumedInputIds.length === 0 ? {} : { consumedInputIds }),
  });
  replayState.storedMessages.push(copyStoredMessage(userMessage));
  consumeReplayInputs(replayState.pendingInputsById, consumedInputIds);
  replayState.activeTask = copyActiveSessionTask(task);
  appendSessionSnapshotIfNeeded({
    session: options.session,
    runtime: options.runtime,
  });
  const result = copyActiveSessionTask(task);
  /* v8 ignore next 3 -- copyActiveSessionTask preserves the discriminated phase of this freshly constructed value. */
  if (result.phase !== "provider_ready") {
    sessionStoreError("Error: admitted Task changed phase while copying.");
  }
  return result;
}

export function persistSessionProviderIntent(options: {
  readonly session: SessionState;
  readonly provider: SessionModelSelection;
  readonly runtime: SessionStoreRuntime;
}): Extract<ActiveSessionTask, { readonly phase: "provider_pending" }> {
  const activeTask = activeTaskForSession(options.session);
  const mayStart =
    activeTask.phase === "provider_ready" ||
    (activeTask.phase === "provider_pending" &&
      providerSettlementAllowsAnotherRequest(
        activeTask.providerAttempt.settlement,
      ));
  if (!mayStart) {
    sessionStoreError(
      `Error: durable Task ${JSON.stringify(activeTask.taskId)} is not ready for a provider request.`,
    );
  }
  if (
    activeTask.provider.providerId !== options.provider.providerId ||
    activeTask.provider.model !== options.provider.model
  ) {
    sessionStoreError(
      `Error: durable Task ${JSON.stringify(activeTask.taskId)} captured provider ${activeTask.provider.providerId}/${activeTask.provider.model}, not ${options.provider.providerId}/${options.provider.model}.`,
    );
  }
  const timestamp = isoTimestamp(options.runtime);
  const attemptId = `provider_attempt_${randomUUID()}`;
  const responseMessageId = createSessionMessageId();
  const task: Extract<
    ActiveSessionTask,
    { readonly phase: "provider_pending" }
  > = {
    ...activeTask,
    phase: "provider_pending",
    providerRequestIds: [
      ...activeTask.providerRequestIds,
      { attemptId, responseMessageId },
    ],
    providerAttempt: {
      attemptId,
      responseMessageId,
      startedAt: timestamp,
    },
  };
  appendJsonLine(options.session.filePath, {
    schemaVersion: SESSION_SCHEMA_VERSION,
    type: "provider_intent",
    timestamp,
    task,
  });
  replayStateForSession(options.session).activeTask =
    copyActiveSessionTask(task);
  appendSessionSnapshotIfNeeded({
    session: options.session,
    runtime: options.runtime,
  });
  const result = copyActiveSessionTask(task);
  /* v8 ignore next 3 -- copyActiveSessionTask preserves the discriminated phase of this freshly constructed value. */
  if (result.phase !== "provider_pending") {
    sessionStoreError("Error: provider intent changed phase while copying.");
  }
  return result;
}

export function persistSessionProviderAttemptSettlement(options: {
  readonly session: SessionState;
  readonly attemptId: string;
  readonly settlement: SessionProviderAttemptSettlement;
  readonly runtime: SessionStoreRuntime;
}): void {
  const activeTask = activeTaskForSession(options.session);
  if (
    activeTask.phase !== "provider_pending" ||
    activeTask.providerAttempt.attemptId !== options.attemptId ||
    activeTask.providerAttempt.settlement !== undefined
  ) {
    sessionStoreError(
      `Error: provider attempt ${JSON.stringify(options.attemptId)} cannot be settled for durable Task ${JSON.stringify(activeTask.taskId)}.`,
    );
  }
  const task: Extract<
    ActiveSessionTask,
    { readonly phase: "provider_pending" }
  > & {
    readonly providerAttempt: ActiveSessionProviderAttempt & {
      readonly settlement: SessionProviderAttemptSettlement;
    };
  } = {
    ...activeTask,
    providerAttempt: {
      ...activeTask.providerAttempt,
      settlement: options.settlement,
    },
  };
  appendJsonLine(options.session.filePath, {
    schemaVersion: SESSION_SCHEMA_VERSION,
    type: "provider_attempt_settled",
    timestamp: isoTimestamp(options.runtime),
    task,
  });
  replayStateForSession(options.session).activeTask =
    copyActiveSessionTask(task);
}

function canonicalToolJson(value: ToolJsonValue): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalToolJson).join(",")}]`;
  }
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([key, nested]) => `${JSON.stringify(key)}:${canonicalToolJson(nested)}`,
    )
    .join(",")}}`;
}

function toolContinuationEffectsAreEmpty(
  effects: SessionToolContinuationEffects,
): boolean {
  return (
    effects.checkpointOperations.length === 0 &&
    effects.taskProgress === undefined &&
    effects.goal === undefined &&
    effects.skillState === undefined &&
    effects.delegation === undefined
  );
}

function persistedToolSettlementIsCanonical(
  sessionId: string,
  taskId: string,
  invocation: Extract<
    ActiveSessionToolInvocation,
    { readonly phase: "settled" }
  >,
): boolean {
  const message = invocation.toolMessage.message;
  if (
    message.role !== "tool" ||
    invocation.toolMessage.id !== invocation.resultMessageId ||
    message.toolCallId !== invocation.toolCallId
  ) {
    return false;
  }
  if (invocation.kind === "completed") {
    return (
      invocation.startedAt !== undefined &&
      invocation.reconciliation === undefined &&
      message.recovery === undefined
    );
  }
  if (
    !toolContinuationEffectsAreEmpty(invocation.effects) ||
    !isDeepStrictEqual(message.recovery, {
      kind: invocation.kind,
      taskId,
      runId: invocation.runId,
      operationId: invocation.operationId,
    })
  ) {
    return false;
  }
  switch (invocation.kind) {
    case "not_executed_after_restart":
      return (
        invocation.startedAt === undefined &&
        invocation.reconciliation === undefined
      );
    case "interrupted_no_effect":
      return (
        invocation.startedAt !== undefined &&
        invocation.reconciliation === undefined &&
        invocation.recovery.kind === "no_effect"
      );
    case "interrupted_effect_unknown":
      return (
        invocation.startedAt !== undefined &&
        (invocation.recovery.kind === "opaque"
          ? invocation.reconciliation === undefined
          : invocation.recovery.kind === "owner_reconciled" &&
            (invocation.reconciliation === undefined ||
              toolEffectReconciliationIsCanonical(
                sessionId,
                invocation,
                invocation.reconciliation,
              )))
      );
  }
}

function toolEffectReconciliationIsCanonical(
  sessionId: string,
  invocation: Extract<
    ActiveSessionToolInvocation,
    { readonly phase: "effect_pending" | "settled" }
  >,
  reconciliation: SessionToolEffectReconciliation,
): boolean {
  if (
    invocation.recovery.kind !== "owner_reconciled" ||
    invocation.recovery.ownerKey !== reconciliation.ownerKey
  ) {
    return false;
  }
  if (reconciliation.effect === "not_applied") {
    const { mode, profile } = invocation.canonicalArguments;
    return isDeepStrictEqual(reconciliation, {
      ownerKey: invocation.recovery.ownerKey,
      effect: "not_applied",
      evidence: {
        kind: "agent_tree_delegate_not_accepted",
        sessionId,
        delegationId: `${invocation.runId}:${invocation.toolCallId}`,
        parentRunId: invocation.runId,
        parentToolCallId: invocation.toolCallId,
        profile,
        mode,
        argumentsSha256: invocation.argumentsSha256,
      },
    });
  }
  const evidence = reconciliation.evidence;
  const resultMatchesStatus =
    evidence.status === "queued" || evidence.status === "running"
      ? evidence.result === null
      : evidence.result !== null && evidence.result.status === evidence.status;
  return (
    evidence.kind === "agent_tree_delegate" &&
    evidence.sessionId === sessionId &&
    evidence.delegationId === `${invocation.runId}:${invocation.toolCallId}` &&
    evidence.parentRunId === invocation.runId &&
    evidence.parentToolCallId === invocation.toolCallId &&
    resultMatchesStatus
  );
}

function persistedToolPlan(
  runId: string,
  assistantMessage: Extract<
    PersistedSessionMessage,
    { readonly role: "assistant" }
  >,
): readonly ActiveSessionToolInvocation[] {
  if (
    new Set(assistantMessage.toolCalls.map((toolCall) => toolCall.id)).size !==
    assistantMessage.toolCalls.length
  ) {
    sessionStoreError("Error: provider tool plan contains duplicate call ids.");
  }
  return assistantMessage.toolCalls.map((toolCall, sourceIndex) => {
    const canonicalArguments = canonicalToolArguments(toolCall);
    return {
      operationId: `tool_operation_${randomUUID()}`,
      runId,
      resultMessageId: createSessionMessageId(),
      toolCallId: toolCall.id,
      sourceIndex,
      toolName: toolCall.tool,
      recovery: toolCallRecoveryCapability(toolCall),
      canonicalArguments,
      argumentsSha256: createHash("sha256")
        .update(canonicalToolJson(canonicalArguments))
        .digest("hex"),
      phase: "planned",
    };
  });
}

export function persistSessionProviderResponse(options: {
  readonly session: SessionState;
  readonly assistantMessage: Extract<
    SessionMessage,
    { readonly role: "assistant" }
  >;
  readonly usage: Extract<
    SessionProviderAttemptSettlement,
    { readonly outcome: "completed" }
  >;
  readonly stopReason: "stop" | "length";
  readonly runtime: SessionStoreRuntime;
}): Extract<
  ActiveSessionTask,
  { readonly phase: "provider_settled" | "tool_execution" }
> {
  const activeTask = activeTaskForSession(options.session);
  if (activeTask.phase !== "provider_pending") {
    sessionStoreError(
      `Error: durable Task ${JSON.stringify(activeTask.taskId)} has no pending provider attempt to checkpoint.`,
    );
  }
  const [persistedAssistantMessage] = parseSessionMessages(
    options.session.id,
    [options.assistantMessage],
    "persist",
  );
  /* v8 ignore next 6 -- the public parameter is an extracted assistant-message type and parsing preserves the discriminant. */
  if (
    persistedAssistantMessage === undefined ||
    persistedAssistantMessage.role !== "assistant"
  ) {
    sessionStoreError(
      `Error: cannot checkpoint provider response for durable Task ${JSON.stringify(activeTask.taskId)}.`,
    );
  }
  const settlement = activeTask.providerAttempt.settlement;
  if (
    settlement !== undefined &&
    (settlement.outcome !== "completed" ||
      !isDeepStrictEqual(settlement.usage, options.usage.usage))
  ) {
    sessionStoreError(
      `Error: provider response does not match attempt ${JSON.stringify(activeTask.providerAttempt.attemptId)}.`,
    );
  }
  const assistantMessage = redactStoredMessageForPersistence({
    id: activeTask.providerAttempt.responseMessageId,
    message: persistedAssistantMessage,
  });
  /* v8 ignore next 5 -- parsing and the public input type preserve this role. */
  if (assistantMessage.message.role !== "assistant") {
    sessionStoreError(
      "Error: persisted provider response changed message role.",
    );
  }
  const assistantToolCalls = assistantMessage.message.toolCalls;
  const base = {
    ...activeTask,
    providerAttempt: {
      ...activeTask.providerAttempt,
      settlement: options.usage,
    },
    assistantMessage,
    stopReason: options.stopReason,
  };
  const task: Extract<
    ActiveSessionTask,
    { readonly phase: "provider_settled" | "tool_execution" }
  > =
    assistantToolCalls.length === 0
      ? { ...base, phase: "provider_settled" }
      : {
          ...base,
          phase: "tool_execution",
          toolInvocations: persistedToolPlan(
            activeTask.runId,
            assistantMessage.message,
          ),
        };
  appendJsonLine(options.session.filePath, {
    schemaVersion: SESSION_SCHEMA_VERSION,
    type: "provider_settled",
    timestamp: isoTimestamp(options.runtime),
    task,
  });
  replayStateForSession(options.session).activeTask =
    copyActiveSessionTask(task);
  appendSessionSnapshotIfNeeded({
    session: options.session,
    runtime: options.runtime,
  });
  const result = copyActiveSessionTask(task);
  /* v8 ignore next 3 -- copyActiveSessionTask preserves the discriminated phase of this freshly constructed value. */
  if (
    result.phase !== "provider_settled" &&
    result.phase !== "tool_execution"
  ) {
    sessionStoreError("Error: provider response changed phase while copying.");
  }
  return result;
}

function applySettledToolEffectsToReplay(options: {
  readonly replayState: SessionReplayState;
  readonly invocation: Extract<
    ActiveSessionToolInvocation,
    { readonly phase: "settled" }
  >;
}): void {
  const { effects } = options.invocation;
  const messageOrdinal =
    options.replayState.storedMessages.length +
    options.invocation.sourceIndex +
    2;
  if (effects.taskProgress !== undefined) {
    replaceReplayTaskProgress(
      options.replayState,
      effects.taskProgress,
      messageOrdinal,
    );
  }
  if (effects.goal !== undefined) {
    options.replayState.goal = copySessionGoal(effects.goal);
  }
  if (effects.skillState !== undefined) {
    options.replayState.skillStateCheckpoints.push({
      messageOrdinal,
      ...copySkillLifecycleState(effects.skillState),
    });
  }
}

export function persistSessionToolIntents(options: {
  readonly session: SessionState;
  readonly toolCallIds: readonly string[];
  readonly runtime: SessionStoreRuntime;
}): void {
  const activeTask = activeTaskForSession(options.session);
  if (activeTask.phase !== "tool_execution") {
    sessionStoreError(
      `Error: durable Task ${JSON.stringify(activeTask.taskId)} has no tool plan to start.`,
    );
  }
  const ids = new Set(options.toolCallIds);
  if (ids.size !== options.toolCallIds.length || ids.size === 0) {
    sessionStoreError("Error: tool intent batch must contain unique calls.");
  }
  const timestamp = isoTimestamp(options.runtime);
  const operationIds: string[] = [];
  const toolInvocations = activeTask.toolInvocations.map((invocation) => {
    if (!ids.has(invocation.toolCallId)) return invocation;
    if (invocation.phase !== "planned") {
      sessionStoreError(
        `Error: tool call ${JSON.stringify(invocation.toolCallId)} is not planned.`,
      );
    }
    ids.delete(invocation.toolCallId);
    operationIds.push(invocation.operationId);
    return {
      ...invocation,
      phase: "effect_pending" as const,
      startedAt: timestamp,
    };
  });
  if (ids.size > 0) {
    sessionStoreError(
      "Error: tool intent does not match the durable tool plan.",
    );
  }
  const task: Extract<ActiveSessionTask, { readonly phase: "tool_execution" }> =
    { ...activeTask, toolInvocations };
  appendJsonLine(options.session.filePath, {
    schemaVersion: SESSION_SCHEMA_VERSION,
    type: "tool_intent",
    timestamp,
    task,
    operationIds,
  });
  replayStateForSession(options.session).activeTask =
    copyActiveSessionTask(task);
  appendSessionSnapshotIfNeeded({
    session: options.session,
    runtime: options.runtime,
  });
}

export function persistSessionToolEffectReconciliation(options: {
  readonly session: SessionState;
  readonly toolCallId: string;
  readonly reconciliation: SessionToolEffectReconciliation;
  readonly runtime: SessionStoreRuntime;
}): void {
  const activeTask = activeTaskForSession(options.session);
  if (activeTask.phase !== "tool_execution") {
    sessionStoreError(
      `Error: durable Task ${JSON.stringify(activeTask.taskId)} has no active tool execution.`,
    );
  }
  const invocationIndex = activeTask.toolInvocations.findIndex(
    (invocation) => invocation.toolCallId === options.toolCallId,
  );
  const invocation = activeTask.toolInvocations[invocationIndex];
  if (
    invocation === undefined ||
    invocation.phase !== "effect_pending" ||
    invocation.reconciliation !== undefined ||
    !toolEffectReconciliationIsCanonical(
      options.session.id,
      invocation,
      options.reconciliation,
    )
  ) {
    sessionStoreError(
      `Error: tool call ${JSON.stringify(options.toolCallId)} cannot accept this effect reconciliation.`,
    );
  }
  const reconciliation = structuredClone(options.reconciliation);
  const reconciledInvocation: Extract<
    ActiveSessionToolInvocation,
    { readonly phase: "effect_pending" }
  > = { ...invocation, reconciliation };
  const toolInvocations = [...activeTask.toolInvocations];
  toolInvocations[invocationIndex] = reconciledInvocation;
  const task: Extract<ActiveSessionTask, { readonly phase: "tool_execution" }> =
    { ...activeTask, toolInvocations };
  const timestamp = isoTimestamp(options.runtime);
  appendJsonLine(options.session.filePath, {
    schemaVersion: SESSION_SCHEMA_VERSION,
    type: "effect_reconciled",
    timestamp,
    task,
    operationId: invocation.operationId,
    reconciliation,
  });
  replayStateForSession(options.session).activeTask =
    copyActiveSessionTask(task);
  appendSessionSnapshotIfNeeded({
    session: options.session,
    runtime: options.runtime,
  });
}

export function persistSessionToolSettlement(options: {
  readonly session: SessionState;
  readonly toolCallId: string;
  readonly settlementKind:
    | "completed"
    | "not_executed_after_restart"
    | "interrupted_no_effect"
    | "interrupted_effect_unknown";
  readonly toolMessage: Extract<SessionMessage, { readonly role: "tool" }>;
  readonly effects: SessionToolContinuationEffects;
  readonly runtime: SessionStoreRuntime;
}): void {
  const activeTask = activeTaskForSession(options.session);
  if (activeTask.phase !== "tool_execution") {
    sessionStoreError(
      `Error: durable Task ${JSON.stringify(activeTask.taskId)} has no active tool execution.`,
    );
  }
  const invocationIndex = activeTask.toolInvocations.findIndex(
    (invocation) => invocation.toolCallId === options.toolCallId,
  );
  const invocation = activeTask.toolInvocations[invocationIndex];
  if (invocation === undefined) {
    sessionStoreError(
      `Error: tool call ${JSON.stringify(options.toolCallId)} is not in the durable tool plan.`,
    );
  }
  const actualSettlement = options.settlementKind === "completed";
  if (
    (actualSettlement && invocation.phase !== "effect_pending") ||
    (!actualSettlement && invocation.phase === "settled")
  ) {
    sessionStoreError(
      `Error: tool call ${JSON.stringify(options.toolCallId)} cannot be settled from phase ${invocation.phase}.`,
    );
  }
  const [parsedToolMessage] = parseSessionMessages(
    options.session.id,
    [options.toolMessage],
    "persist",
  );
  if (
    parsedToolMessage === undefined ||
    parsedToolMessage.role !== "tool" ||
    parsedToolMessage.toolCallId !== invocation.toolCallId
  ) {
    sessionStoreError("Error: tool settlement does not match its invocation.");
  }
  const storedToolMessage = redactStoredMessageForPersistence({
    id: invocation.resultMessageId,
    message: parsedToolMessage,
  });
  const settledAt = isoTimestamp(options.runtime);
  const settledInvocation: Extract<
    ActiveSessionToolInvocation,
    { readonly phase: "settled" }
  > = {
    ...invocation,
    phase: "settled",
    ...(invocation.phase === "effect_pending"
      ? { startedAt: invocation.startedAt }
      : {}),
    settledAt,
    kind: options.settlementKind,
    toolMessage: storedToolMessage,
    effects: redactSessionToolContinuationEffectsForPersistence(
      options.effects,
    ),
  };
  if (
    !persistedToolSettlementIsCanonical(
      options.session.id,
      activeTask.taskId,
      settledInvocation,
    )
  ) {
    sessionStoreError("Error: tool settlement evidence is not canonical.");
  }
  const toolInvocations = [...activeTask.toolInvocations];
  toolInvocations[invocationIndex] = settledInvocation;
  const task: Extract<ActiveSessionTask, { readonly phase: "tool_execution" }> =
    { ...activeTask, toolInvocations };
  appendJsonLine(options.session.filePath, {
    schemaVersion: SESSION_SCHEMA_VERSION,
    type: "tool_settled",
    timestamp: settledAt,
    task,
    operationId: settledInvocation.operationId,
  });
  const replayState = replayStateForSession(options.session);
  replayState.activeTask = copyActiveSessionTask(task);
  applySettledToolEffectsToReplay({
    replayState,
    invocation: settledInvocation,
  });
  appendSessionSnapshotIfNeeded({
    session: options.session,
    runtime: options.runtime,
  });
}

export function persistSessionTaskRecoveryDisposition(options: {
  readonly session: SessionState;
  readonly disposition: SessionTaskRecoveryDisposition;
  readonly runtime: SessionStoreRuntime;
}): void {
  const activeTask = activeTaskForSession(options.session);
  if (
    activeTask.phase !== "tool_execution" ||
    activeTask.toolEffectRecoveryPolicy !== "accept_unknown"
  ) {
    sessionStoreError(
      `Error: durable Task ${JSON.stringify(activeTask.taskId)} cannot accept unknown tool effects.`,
    );
  }
  const accepted = new Set(activeTask.acceptedUnknownEffectOperationIds);
  const operationIds = activeTask.toolInvocations
    .filter(
      (invocation) =>
        invocation.phase === "settled" &&
        invocation.kind === "interrupted_effect_unknown" &&
        invocation.reconciliation === undefined &&
        !accepted.has(invocation.operationId),
    )
    .sort((left, right) => left.sourceIndex - right.sourceIndex)
    .map((invocation) => invocation.operationId);
  if (
    operationIds.length === 0 ||
    options.disposition.kind !== "accept_unknown" ||
    !isDeepStrictEqual(options.disposition.operationIds, operationIds)
  ) {
    sessionStoreError(
      `Error: recovery disposition does not match unknown effects for durable Task ${JSON.stringify(activeTask.taskId)}.`,
    );
  }
  const task: Extract<ActiveSessionTask, { readonly phase: "tool_execution" }> =
    {
      ...activeTask,
      acceptedUnknownEffectOperationIds: [
        ...activeTask.acceptedUnknownEffectOperationIds,
        ...operationIds,
      ],
    };
  const timestamp = isoTimestamp(options.runtime);
  appendJsonLine(options.session.filePath, {
    schemaVersion: SESSION_SCHEMA_VERSION,
    type: "task_recovery_disposition",
    timestamp,
    task,
    disposition: {
      kind: "accept_unknown",
      operationIds,
    },
  });
  replayStateForSession(options.session).activeTask =
    copyActiveSessionTask(task);
  appendSessionSnapshotIfNeeded({
    session: options.session,
    runtime: options.runtime,
  });
}

export function persistSessionTaskRecoveryState(options: {
  readonly session: SessionState;
  readonly task: Extract<
    ActiveSessionTask,
    { readonly phase: "provider_ready" | "recovery_blocked" }
  >;
  readonly runtime: SessionStoreRuntime;
}): void {
  const activeTask = activeTaskForSession(options.session);
  if (activeTask.taskId !== options.task.taskId) {
    sessionStoreError(
      `Error: recovery state does not match durable Task ${JSON.stringify(activeTask.taskId)}.`,
    );
  }
  appendJsonLine(options.session.filePath, {
    schemaVersion: SESSION_SCHEMA_VERSION,
    type: "task_recovery_started",
    timestamp: isoTimestamp(options.runtime),
    task: options.task,
  });
  replayStateForSession(options.session).activeTask = copyActiveSessionTask(
    options.task,
  );
  appendSessionSnapshotIfNeeded({
    session: options.session,
    runtime: options.runtime,
  });
}

export function persistSessionTaskStep(options: {
  readonly session: SessionState;
  readonly currentMessages: readonly SessionMessage[];
  readonly consumedInputIds?: readonly string[];
  readonly recoveryRunId?: string;
  readonly runtime: SessionStoreRuntime;
}): boolean {
  const activeTask = activeTaskForSession(options.session);
  if (
    activeTask.phase !== "provider_settled" &&
    activeTask.phase !== "tool_execution"
  ) {
    return false;
  }
  if (
    activeTask.phase === "tool_execution" &&
    activeTask.toolInvocations.some(
      (invocation) => invocation.phase !== "settled",
    )
  ) {
    sessionStoreError(
      `Error: durable Task ${JSON.stringify(activeTask.taskId)} cannot commit an incomplete tool group.`,
    );
  }
  const currentMessages = parseSessionMessages(
    options.session.id,
    options.currentMessages,
    "persist",
  );
  const comparableMessages = currentMessages.map(redactMessageForPersistence);
  validateCompletedTranscript(options.session.id, currentMessages, "persist");
  const replayState = replayStateForSession(options.session);
  const previousMessages = messagesFromStoredMessages(
    replayState.storedMessages,
  );
  const extendsTranscript = hasMessagePrefix(
    comparableMessages,
    previousMessages,
  );
  const responseIndex = extendsTranscript
    ? previousMessages.length
    : comparableMessages.findLastIndex((message) =>
        messageArraysEqual([message], [activeTask.assistantMessage.message]),
      );
  const response = comparableMessages[responseIndex];
  if (
    response === undefined ||
    !messageArraysEqual([response], [activeTask.assistantMessage.message])
  ) {
    sessionStoreError(
      `Error: completed provider step does not contain response ${JSON.stringify(activeTask.assistantMessage.id)}.`,
    );
  }
  const admittedUserMessage = replayState.storedMessages.find(
    (message) => message.id === activeTask.userMessageId,
  );
  const admittedUserMessageIndex = comparableMessages.findLastIndex(
    (message) =>
      admittedUserMessage !== undefined &&
      messageArraysEqual([message], [admittedUserMessage.message]),
  );
  if (
    admittedUserMessage === undefined ||
    admittedUserMessage.message.role !== "user" ||
    admittedUserMessageIndex < 0
  ) {
    sessionStoreError(
      `Error: committed durable Task step is missing admitted user message ${JSON.stringify(activeTask.userMessageId)}.`,
    );
  }
  const reservedMessageIds = new Map([
    [admittedUserMessageIndex, activeTask.userMessageId],
    [responseIndex, activeTask.assistantMessage.id],
  ]);
  if (activeTask.phase === "tool_execution") {
    for (const invocation of activeTask.toolInvocations) {
      /* v8 ignore next -- the incomplete-group guard above proves every invocation is settled before transcript promotion. */
      if (invocation.phase !== "settled") continue;
      const messageIndex = responseIndex + invocation.sourceIndex + 1;
      const message = comparableMessages[messageIndex];
      if (
        message === undefined ||
        !messageArraysEqual([message], [invocation.toolMessage.message])
      ) {
        sessionStoreError(
          `Error: completed durable tool group is missing result ${JSON.stringify(invocation.toolCallId)} in source order.`,
        );
      }
      reservedMessageIds.set(messageIndex, invocation.toolMessage.id);
    }
  }
  const storedMessages = storedMessagesForSessionMessages({
    messages: currentMessages,
    previousStoredMessages: replayState.storedMessages,
    reservedMessageIds,
  });
  const messages = extendsTranscript
    ? storedMessages.slice(replayState.storedMessages.length)
    : storedMessages;
  const consumedInputIds = uniqueInputIds(options.consumedInputIds ?? []);
  const recovered = options.recoveryRunId !== undefined;
  const acceptedUnknownEffects = new Set(
    activeTask.acceptedUnknownEffectOperationIds,
  );
  const hasUnacceptedUnknownEffect =
    activeTask.phase === "tool_execution" &&
    activeTask.toolInvocations.some(
      (invocation) =>
        invocation.phase === "settled" &&
        invocation.kind === "interrupted_effect_unknown" &&
        invocation.reconciliation === undefined &&
        !acceptedUnknownEffects.has(invocation.operationId),
    );
  const readyTask = {
    taskId: activeTask.taskId,
    runId: options.recoveryRunId ?? activeTask.runId,
    trigger: activeTask.trigger,
    admittedAt: activeTask.admittedAt,
    userMessageId: activeTask.userMessageId,
    provider: activeTask.provider,
    maxProviderReplacements: activeTask.maxProviderReplacements,
    providerReplacementsUsed: activeTask.providerReplacementsUsed,
    recovered: recovered || activeTask.recovered,
    providerRequestIds: activeTask.providerRequestIds,
    unknownProviderAttemptIds: activeTask.unknownProviderAttemptIds,
    toolEffectRecoveryPolicy: activeTask.toolEffectRecoveryPolicy,
    acceptedUnknownEffectOperationIds:
      activeTask.acceptedUnknownEffectOperationIds,
  } as const;
  const task: Extract<
    ActiveSessionTask,
    { readonly phase: "provider_ready" | "recovery_blocked" }
  > =
    recovered &&
    hasUnacceptedUnknownEffect &&
    activeTask.phase === "tool_execution"
      ? {
          ...readyTask,
          phase: "recovery_blocked",
          providerAttempt: activeTask.providerAttempt,
          assistantMessage: activeTask.assistantMessage,
          stopReason: activeTask.stopReason,
          toolInvocations: activeTask.toolInvocations,
          reason: "tool_effect",
        }
      : {
          ...readyTask,
          phase: "provider_ready",
        };
  appendJsonLine(options.session.filePath, {
    schemaVersion: SESSION_SCHEMA_VERSION,
    type: "step_committed",
    timestamp: isoTimestamp(options.runtime),
    task,
    messages,
    ...(extendsTranscript ? {} : { replaceTranscript: true as const }),
    ...(consumedInputIds.length === 0 ? {} : { consumedInputIds }),
  });
  replaceReplayMessages(replayState, storedMessages);
  consumeReplayInputs(replayState.pendingInputsById, consumedInputIds);
  replayState.activeTask = copyActiveSessionTask(task);
  appendSessionSnapshotIfNeeded({
    session: options.session,
    runtime: options.runtime,
  });
  return true;
}

export function persistSessionTaskTerminal(options: {
  readonly session: SessionState;
  readonly currentMessages: readonly SessionMessage[];
  readonly outcome: "completed" | "failed" | "aborted";
  readonly skillState?: SkillLifecycleState;
  readonly consumedInputIds?: readonly string[];
  readonly runtime: SessionStoreRuntime;
}): SessionLastTaskOutcome {
  const activeTask = activeTaskForSession(options.session);
  const currentMessages = parseSessionMessages(
    options.session.id,
    options.currentMessages,
    "persist",
  );
  const comparableMessages = currentMessages.map(redactMessageForPersistence);
  validateCompletedTranscript(options.session.id, currentMessages, "persist");
  const replayState = replayStateForSession(options.session);
  const previousMessages = messagesFromStoredMessages(
    replayState.storedMessages,
  );
  const extendsTranscript = hasMessagePrefix(
    comparableMessages,
    previousMessages,
  );
  const reservedMessageIds = new Map<number, string>();
  if (activeTask.phase === "provider_settled") {
    const responseIndex = comparableMessages.findLastIndex((message) =>
      messageArraysEqual([message], [activeTask.assistantMessage.message]),
    );
    const response = comparableMessages[responseIndex];
    if (
      response !== undefined &&
      messageArraysEqual([response], [activeTask.assistantMessage.message])
    ) {
      reservedMessageIds.set(responseIndex, activeTask.assistantMessage.id);
    }
  }
  if (
    options.outcome === "completed" &&
    (activeTask.phase !== "provider_settled" ||
      reservedMessageIds.get(currentMessages.length - 1) !==
        activeTask.assistantMessage.id)
  ) {
    sessionStoreError(
      `Error: completed durable Task ${JSON.stringify(activeTask.taskId)} is missing its settled final response.`,
    );
  }
  const storedMessages = storedMessagesForSessionMessages({
    messages: currentMessages,
    previousStoredMessages: replayState.storedMessages,
    reservedMessageIds,
  });
  const terminalMessages = extendsTranscript
    ? storedMessages.slice(replayState.storedMessages.length)
    : storedMessages;
  const timestamp = isoTimestamp(options.runtime);
  const responseMessageId =
    terminalMessages.length === 0 ? undefined : terminalMessages.at(-1)?.id;
  const terminalOutcome =
    options.outcome === "completed" &&
    activeTask.acceptedUnknownEffectOperationIds.length > 0
      ? "completed_with_unknown_effects"
      : options.outcome;
  const lastTaskOutcome: SessionLastTaskOutcome = {
    taskId: activeTask.taskId,
    runId: activeTask.runId,
    outcome: terminalOutcome,
    timestamp,
    recovered: activeTask.recovered,
    unknownProviderAttemptIds: [...activeTask.unknownProviderAttemptIds],
    unknownToolEffectOperationIds: [
      ...activeTask.acceptedUnknownEffectOperationIds,
    ],
    ...(responseMessageId === undefined ? {} : { responseMessageId }),
  };
  const persistedSkillState =
    options.skillState === undefined
      ? undefined
      : {
          skillActivations: options.skillState.skillActivations.map(
            redactSkillActivationForPersistence,
          ),
          activeSkillIds: [...options.skillState.activeSkillIds],
        };
  const consumedInputIds = uniqueInputIds(options.consumedInputIds ?? []);
  appendJsonLine(options.session.filePath, {
    schemaVersion: SESSION_SCHEMA_VERSION,
    type: "task_terminal",
    timestamp,
    taskId: activeTask.taskId,
    runId: activeTask.runId,
    messages: terminalMessages,
    ...(extendsTranscript ? {} : { replaceTranscript: true as const }),
    lastTaskOutcome,
    ...(persistedSkillState === undefined
      ? {}
      : { skillState: persistedSkillState }),
    ...(consumedInputIds.length === 0 ? {} : { consumedInputIds }),
  });
  replaceReplayMessages(replayState, storedMessages);
  consumeReplayInputs(replayState.pendingInputsById, consumedInputIds);
  replayState.lastTaskOutcome = copySessionLastTaskOutcome(lastTaskOutcome);
  if (persistedSkillState !== undefined) {
    appendReplaySkillState(replayState, persistedSkillState);
  }
  delete replayState.activeTask;
  appendSessionSnapshotIfNeeded({
    session: options.session,
    runtime: options.runtime,
  });
  return copySessionLastTaskOutcome(lastTaskOutcome);
}

export function persistSessionMessages(options: {
  readonly session: SessionState;
  readonly previousMessages: readonly SessionMessage[];
  readonly currentMessages: readonly SessionMessage[];
  readonly runtime: SessionStoreRuntime;
  readonly reason: SessionPersistenceReason;
  readonly skillState?: SkillLifecycleState;
  readonly consumedInputIds?: readonly string[];
  readonly reservedMessageIds?: readonly {
    readonly message: SessionMessage;
    readonly id: string;
  }[];
}): readonly PersistedSessionMessage[] {
  const reservedMessageIds = new Map<number, string>();
  const existingMessageIds = new Set(
    replayStateForSession(options.session).storedMessages.map(
      (stored) => stored.id,
    ),
  );
  for (const reservation of options.reservedMessageIds ?? []) {
    const index = options.currentMessages.indexOf(reservation.message);
    if (index < 0) {
      sessionStoreError(
        `Error: cannot persist session "${options.session.id}": reserved message is no longer present.`,
      );
    }
    if (
      reservedMessageIds.has(index) ||
      existingMessageIds.has(reservation.id) ||
      [...reservedMessageIds.values()].includes(reservation.id)
    ) {
      sessionStoreError(
        `Error: cannot persist session "${options.session.id}": reserved message id is not unique.`,
      );
    }
    reservedMessageIds.set(index, reservation.id);
  }
  const currentMessages = parseSessionMessages(
    options.session.id,
    options.currentMessages,
    "persist",
  );
  validateCompletedTranscript(options.session.id, currentMessages, "persist");
  const consumedInputIds = uniqueInputIds(options.consumedInputIds ?? []);
  const replayState = replayStateForSession(options.session);
  const currentStoredMessages = storedMessagesForSessionMessages({
    messages: currentMessages,
    previousStoredMessages: replayState.storedMessages,
    reservedMessageIds,
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
