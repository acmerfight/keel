import { readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { SessionMessage } from "../../agent/session-message.ts";
import { errorMessage } from "../../core/error.ts";
import { copySessionGoal } from "../../core/session-goal.ts";
import {
  copySessionTaskProgress,
  emptySessionTaskProgress,
} from "../../core/task-progress.ts";
import {
  activeSkillActivations,
  copySkillActivation,
} from "../../skills/lifecycle.ts";
import { redactTextForPersistence } from "../persistence-redaction.ts";
import {
  formatNestedSessionStoreError,
  hasNodeErrorCode,
  SessionStoreError,
  sessionStoreError,
} from "./errors.ts";
import {
  readSessionHeaderLine,
  readSessionRecords,
  sessionLedgerSize,
} from "./ledger.ts";
import {
  type CatalogPreviewState,
  CONVERSATION_CHECKPOINT_CLOSE,
  CONVERSATION_CHECKPOINT_INSTRUCTION,
  CONVERSATION_CHECKPOINT_NO_LATER_MESSAGES,
  CONVERSATION_CHECKPOINT_OPEN,
  EMPTY_SESSION_CATALOG_PREVIEW,
  SESSION_CATALOG_PREVIEW_MAX_LENGTH,
  type SessionCatalog,
  type SessionCatalogEntry,
  type SessionCatalogReplayState,
  type SessionCatalogWarning,
  type SessionCatalogWorkflowSkill,
  type SessionHeaderRecord,
  type SessionMutationRecord,
  type SessionQueuedInput,
  type SessionRecords,
  type SessionStoreRuntime,
  type StoredMessage,
  SUMMARY_CLOSE,
  SUMMARY_OPEN,
} from "./model.ts";
import { sessionFilePath, sessionHome } from "./paths.ts";
import {
  copySessionGraphRecord,
  copySessionLastTaskOutcome,
  parseSessionHeaderRecord,
} from "./records.ts";

export function normalizeSessionPreview(content: string): string {
  const normalized = redactTextForPersistence(content)
    .replace(/\s+/gu, " ")
    .trim();
  if (normalized.length <= SESSION_CATALOG_PREVIEW_MAX_LENGTH) {
    return normalized;
  }
  return `${normalized.slice(0, SESSION_CATALOG_PREVIEW_MAX_LENGTH - 3)}...`;
}

function catalogCheckpointSummary(content: string): string | null {
  const lines = content.split("\n");
  if (
    lines.length < 5 ||
    lines[0] !== CONVERSATION_CHECKPOINT_OPEN ||
    lines[1] !== CONVERSATION_CHECKPOINT_INSTRUCTION ||
    lines[lines.length - 2] !== SUMMARY_CLOSE ||
    lines[lines.length - 1] !== CONVERSATION_CHECKPOINT_CLOSE
  ) {
    return null;
  }

  const summaryOpenIndex =
    lines[2] === CONVERSATION_CHECKPOINT_NO_LATER_MESSAGES ? 3 : 2;
  if (lines[summaryOpenIndex] !== SUMMARY_OPEN) {
    return null;
  }
  return lines.slice(summaryOpenIndex + 1, -2).join("\n");
}

function catalogPreviewStateFromMessages(
  messages: readonly SessionMessage[],
): CatalogPreviewState {
  let checkpointPreview: string | undefined;
  for (const message of messages) {
    if (message.role === "user") {
      const checkpointSummary = catalogCheckpointSummary(message.content);
      if (checkpointSummary !== null) {
        checkpointPreview = normalizeSessionPreview(
          `checkpoint: ${checkpointSummary}`,
        );
        continue;
      }
      return {
        kind: "user",
        preview: normalizeSessionPreview(message.content),
      };
    }
  }
  if (checkpointPreview !== undefined) {
    return { kind: "checkpoint", preview: checkpointPreview };
  }
  return { kind: "empty" };
}

function catalogPreviewStateFromStoredMessages(
  storedMessages: readonly StoredMessage[],
): CatalogPreviewState {
  return catalogPreviewStateFromMessages(
    storedMessages.map((storedMessage) => storedMessage.message),
  );
}

function appendCatalogPreviewState(
  current: CatalogPreviewState,
  next: CatalogPreviewState,
): CatalogPreviewState {
  if (current.kind === "user" || next.kind === "empty") {
    return current;
  }
  return next;
}

function catalogPreviewValue(state: CatalogPreviewState): string {
  return state.kind === "empty" ? EMPTY_SESSION_CATALOG_PREVIEW : state.preview;
}

function initialSessionCatalogReplayState(
  header: SessionHeaderRecord,
): SessionCatalogReplayState {
  return {
    updatedAt: header.createdAt,
    preview: { kind: "empty" },
    pendingInputsById: new Map(),
    taskProgress: emptySessionTaskProgress(),
    skillActivations: [],
    activeSkillIds: [],
  };
}

function consumeSessionCatalogInputs(
  pendingInputsById: Map<string, SessionQueuedInput>,
  inputIds: readonly string[] | undefined,
): Map<string, SessionQueuedInput> {
  if (inputIds === undefined || inputIds.length === 0) {
    return pendingInputsById;
  }
  const nextPendingInputs = new Map(pendingInputsById);
  for (const inputId of inputIds) {
    nextPendingInputs.delete(inputId);
  }
  return nextPendingInputs;
}

function applySessionCatalogMutation(
  state: SessionCatalogReplayState,
  record: SessionMutationRecord,
): SessionCatalogReplayState {
  switch (record.type) {
    case "append":
      return {
        ...state,
        updatedAt: record.timestamp,
        preview: appendCatalogPreviewState(
          state.preview,
          catalogPreviewStateFromStoredMessages(record.messages),
        ),
        pendingInputsById: consumeSessionCatalogInputs(
          state.pendingInputsById,
          record.consumedInputIds,
        ),
        ...(record.skillState === undefined
          ? {}
          : {
              skillActivations:
                record.skillState.skillActivations.map(copySkillActivation),
              activeSkillIds: [...record.skillState.activeSkillIds],
            }),
      };
    case "replace":
      return {
        ...state,
        updatedAt: record.timestamp,
        preview: catalogPreviewStateFromStoredMessages(record.messages),
        pendingInputsById: consumeSessionCatalogInputs(
          state.pendingInputsById,
          record.consumedInputIds,
        ),
        ...(record.skillState === undefined
          ? {}
          : {
              skillActivations:
                record.skillState.skillActivations.map(copySkillActivation),
              activeSkillIds: [...record.skillState.activeSkillIds],
            }),
      };
    case "snapshot": {
      const snapshotSkillState = record.skillStateCheckpoints.reduce(
        (_previous, checkpoint) => checkpoint,
      );
      return {
        updatedAt: record.timestamp,
        ...(record.title !== undefined ? { title: record.title } : {}),
        ...(record.goal !== undefined
          ? { goal: copySessionGoal(record.goal) }
          : {}),
        preview: catalogPreviewStateFromStoredMessages(record.messages),
        pendingInputsById: new Map(
          record.pendingInputs.map((input) => [input.id, input]),
        ),
        taskProgress:
          record.taskProgressCheckpoints?.at(-1)?.taskProgress ??
          emptySessionTaskProgress(),
        skillActivations:
          snapshotSkillState.skillActivations.map(copySkillActivation),
        activeSkillIds: [...snapshotSkillState.activeSkillIds],
        ...(record.lastTaskOutcome === undefined
          ? {}
          : {
              lastTaskOutcome: copySessionLastTaskOutcome(
                record.lastTaskOutcome,
              ),
            }),
      };
    }
    case "session_title":
      return {
        ...state,
        updatedAt: record.timestamp,
        title: record.title,
        pendingInputsById: consumeSessionCatalogInputs(
          state.pendingInputsById,
          record.consumedInputIds,
        ),
      };
    case "session_goal": {
      const pendingInputsById = consumeSessionCatalogInputs(
        state.pendingInputsById,
        record.consumedInputIds,
      );
      const nextState = {
        updatedAt: record.timestamp,
        ...(state.title !== undefined ? { title: state.title } : {}),
        preview: state.preview,
        pendingInputsById,
        taskProgress: copySessionTaskProgress(state.taskProgress),
        skillActivations: state.skillActivations.map(copySkillActivation),
        activeSkillIds: [...state.activeSkillIds],
        ...(state.lastTaskOutcome === undefined
          ? {}
          : {
              lastTaskOutcome: copySessionLastTaskOutcome(
                state.lastTaskOutcome,
              ),
            }),
      };
      return record.goal === null
        ? nextState
        : { ...nextState, goal: copySessionGoal(record.goal) };
    }
    case "input_admitted":
      return {
        ...state,
        updatedAt: record.timestamp,
        pendingInputsById: new Map(state.pendingInputsById).set(record.id, {
          id: record.id,
          timestamp: record.timestamp,
          sequence: record.sequence,
          line: record.line,
        }),
      };
    case "input_consumed":
      return {
        ...state,
        updatedAt: record.timestamp,
        pendingInputsById: consumeSessionCatalogInputs(
          state.pendingInputsById,
          record.inputIds,
        ),
      };
    case "task_progress":
      return {
        ...state,
        updatedAt: record.timestamp,
        taskProgress: {
          tasks: record.tasks.map((task) => ({
            step: task.step,
            status: task.status,
          })),
        },
      };
    case "task_admitted":
      return {
        ...state,
        updatedAt: record.timestamp,
        preview: appendCatalogPreviewState(
          state.preview,
          catalogPreviewStateFromStoredMessages([record.userMessage]),
        ),
        pendingInputsById: consumeSessionCatalogInputs(
          state.pendingInputsById,
          record.consumedInputIds,
        ),
      };
    case "task_terminal":
      return {
        ...state,
        updatedAt: record.timestamp,
        preview:
          record.replaceTranscript === true
            ? catalogPreviewStateFromStoredMessages(record.messages)
            : appendCatalogPreviewState(
                state.preview,
                catalogPreviewStateFromStoredMessages(record.messages),
              ),
        pendingInputsById: consumeSessionCatalogInputs(
          state.pendingInputsById,
          record.consumedInputIds,
        ),
        ...(record.skillState === undefined
          ? {}
          : {
              skillActivations:
                record.skillState.skillActivations.map(copySkillActivation),
              activeSkillIds: [...record.skillState.activeSkillIds],
            }),
        lastTaskOutcome: copySessionLastTaskOutcome(record.lastTaskOutcome),
      };
    case "step_committed":
      return {
        ...state,
        updatedAt: record.timestamp,
        preview:
          record.replaceTranscript === true
            ? catalogPreviewStateFromStoredMessages(record.messages)
            : appendCatalogPreviewState(
                state.preview,
                catalogPreviewStateFromStoredMessages(record.messages),
              ),
        pendingInputsById: consumeSessionCatalogInputs(
          state.pendingInputsById,
          record.consumedInputIds,
        ),
      };
    case "provider_intent":
    case "provider_attempt_settled":
    case "provider_settled":
    case "tool_intent":
    case "effect_reconciled":
    case "tool_settled":
    case "task_recovery_disposition":
    case "task_recovery_started":
      return {
        ...state,
        updatedAt: record.timestamp,
      };
    case "bash_approval_granted":
      return {
        ...state,
        updatedAt: record.timestamp,
      };
    case "bash_approval_revoked":
    case "bash_approvals_cleared":
    case "model_switch":
      return {
        ...state,
        updatedAt: record.timestamp,
        pendingInputsById: consumeSessionCatalogInputs(
          state.pendingInputsById,
          record.consumedInputIds,
        ),
      };
    case "skill_state":
      return {
        ...state,
        updatedAt: record.timestamp,
        skillActivations: record.skillActivations.map(copySkillActivation),
        activeSkillIds: [...record.activeSkillIds],
        pendingInputsById: consumeSessionCatalogInputs(
          state.pendingInputsById,
          record.consumedInputIds,
        ),
      };
  }
}

function replaySessionCatalogState(
  records: SessionRecords,
): SessionCatalogReplayState {
  let state = initialSessionCatalogReplayState(records.header);
  for (const record of records.mutations) {
    state = applySessionCatalogMutation(state, record);
  }
  return state;
}

function sessionCatalogEntry(records: SessionRecords): SessionCatalogEntry {
  const state = replaySessionCatalogState(records);
  return {
    id: records.header.id,
    workspace: records.header.workspace,
    createdAt: records.header.createdAt,
    updatedAt: state.updatedAt,
    graph: copySessionGraphRecord(records.header.graph),
    workflowSkills: activeSkillActivations(state).map(
      sessionCatalogWorkflowSkill,
    ),
    ...(state.title !== undefined ? { title: state.title } : {}),
    ...(state.goal !== undefined ? { goal: copySessionGoal(state.goal) } : {}),
    preview: catalogPreviewValue(state.preview),
    pendingInputCount: state.pendingInputsById.size,
    taskProgress: copySessionTaskProgress(state.taskProgress),
    ...(state.lastTaskOutcome === undefined
      ? {}
      : {
          lastTaskOutcome: copySessionLastTaskOutcome(state.lastTaskOutcome),
        }),
  };
}

function sessionCatalogWorkflowSkill(skill: {
  readonly qualifiedName: string;
  readonly relativePath: string;
}): SessionCatalogWorkflowSkill {
  return {
    qualifiedName: skill.qualifiedName,
    relativePath: skill.relativePath,
  };
}

function compareSessionCatalogEntries(
  left: SessionCatalogEntry,
  right: SessionCatalogEntry,
): number {
  const timestampDelta = right.updatedAt.localeCompare(left.updatedAt);
  if (timestampDelta !== 0) {
    return timestampDelta;
  }
  return left.id.localeCompare(right.id);
}

function readCatalogHeader(options: {
  readonly sessionId: string;
  readonly runtime: SessionStoreRuntime;
}): SessionHeaderRecord {
  const filePath = sessionFilePath(options.runtime, options.sessionId);
  const ledgerSize = sessionLedgerSize(filePath);
  const header = parseSessionHeaderRecord(
    filePath,
    readSessionHeaderLine(filePath, ledgerSize),
    1,
  );
  if (header.id !== options.sessionId) {
    sessionStoreError(
      `Error: ledger belongs to session "${header.id}", not "${options.sessionId}".`,
    );
  }
  return header;
}

function readCatalogRecords(options: {
  readonly sessionId: string;
  readonly runtime: SessionStoreRuntime;
}): SessionRecords {
  const filePath = sessionFilePath(options.runtime, options.sessionId);
  // Use the resume reader so catalog previews follow append/replace/snapshot replay exactly.
  return readSessionRecords(filePath);
}

function listSessionDirectories(
  runtime: SessionStoreRuntime,
): readonly string[] {
  const sessionsPath = join(sessionHome(runtime), "sessions");
  try {
    return readdirSync(sessionsPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (error) {
    if (hasNodeErrorCode(error, "ENOENT")) {
      return [];
    }
    sessionStoreError(
      `Error: cannot list sessions at ${sessionsPath}: ${errorMessage(error)}`,
    );
  }
}

export function listSessionCatalog(options: {
  readonly workspace: string;
  readonly runtime: SessionStoreRuntime;
}): SessionCatalog {
  const workspace = realpathSync(options.workspace);
  const sessions: SessionCatalogEntry[] = [];
  const warnings: SessionCatalogWarning[] = [];

  for (const sessionId of listSessionDirectories(options.runtime)) {
    try {
      const header = readCatalogHeader({
        sessionId,
        runtime: options.runtime,
      });
      if (header.workspace !== workspace) {
        continue;
      }
      sessions.push(
        sessionCatalogEntry(
          readCatalogRecords({
            sessionId,
            runtime: options.runtime,
          }),
        ),
      );
    } catch (error) {
      /* v8 ignore next 3: catalog readers convert supported per-session failures to SessionStoreError. */
      if (!(error instanceof SessionStoreError)) {
        throw error;
      }
      warnings.push({
        sessionId,
        message: formatNestedSessionStoreError(error),
      });
    }
  }

  return {
    workspace,
    sessions: sessions.sort(compareSessionCatalogEntries),
    warnings,
  };
}

export function readSessionCatalogEntry(options: {
  readonly sessionId: string;
  readonly workspace: string;
  readonly runtime: SessionStoreRuntime;
}): SessionCatalogEntry {
  const workspace = realpathSync(options.workspace);
  let records: SessionRecords;
  try {
    records = readCatalogRecords({
      sessionId: options.sessionId,
      runtime: options.runtime,
    });
  } catch (error) {
    /* v8 ignore next 3: catalog detail readers convert supported load failures to SessionStoreError. */
    if (!(error instanceof SessionStoreError)) {
      throw error;
    }
    sessionStoreError(
      `Error: cannot show session "${options.sessionId}": ${formatNestedSessionStoreError(error)}`,
    );
  }
  if (records.header.id !== options.sessionId) {
    sessionStoreError(
      `Error: cannot show session "${options.sessionId}": ledger belongs to session "${records.header.id}".`,
    );
  }
  if (records.header.workspace !== workspace) {
    sessionStoreError(
      `Error: cannot show session "${options.sessionId}": session workspace is ${records.header.workspace}, not ${workspace}.`,
    );
  }
  return sessionCatalogEntry(records);
}
