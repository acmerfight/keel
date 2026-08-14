import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type SessionLedger,
  sessionLedgerFromMessages,
} from "../agent/session-ledger.ts";
import type { SessionMessage } from "../agent/session-message.ts";
import type {
  SessionQueuedInput,
  SessionTaskProgressCheckpoint,
} from "../cli/session-store.ts";
import type { SessionGoal } from "../core/session-goal.ts";
import type { SessionTask } from "../core/task-progress.ts";
import type { SkillLifecycleState } from "../skills/model.ts";

export function sessionLedgerMirroringMessages(
  messages: SessionMessage[],
): SessionLedger {
  const ledger = sessionLedgerFromMessages(messages);
  const syncMirror = (): void => {
    messages.splice(0, messages.length, ...ledger.messages());
  };
  return {
    messages: ledger.messages,
    append: (message) => {
      ledger.append(message);
      syncMirror();
    },
    appendMany: (nextMessages) => {
      ledger.appendMany(nextMessages);
      syncMirror();
    },
    replace: (nextMessages) => {
      ledger.replace(nextMessages);
      syncMirror();
    },
  };
}

function sessionGoalRecord(goal: SessionGoal): object {
  const { completion, ...state } = goal;
  if (completion === undefined) {
    return state;
  }
  return {
    ...state,
    criterionKind: completion.kind,
    completionCriterion:
      completion.kind === "command" ? completion.command : completion.assertion,
    ...(completion.kind === "command" &&
    completion.verificationTimeoutMs !== undefined
      ? { verificationTimeoutMs: completion.verificationTimeoutMs }
      : {}),
  };
}

export function appendSessionRecordLine(
  timestamp: string,
  messages: readonly SessionMessage[],
): string {
  return JSON.stringify({
    schemaVersion: 7,
    type: "append",
    timestamp,
    reason: "turn",
    messages: storedMessages(messages, `append-${timestamp}`),
  });
}

export function replaceSessionRecordLine(
  timestamp: string,
  messages: readonly SessionMessage[],
): string {
  return JSON.stringify({
    schemaVersion: 7,
    type: "replace",
    timestamp,
    reason: "compaction",
    messages: storedMessages(messages, `replace-${timestamp}`),
  });
}

export function snapshotSessionRecordLine(
  timestamp: string,
  messages: readonly SessionMessage[],
  title?: string,
  options: {
    readonly pendingInputs?: readonly SessionQueuedInput[];
    readonly goal?: SessionGoal;
    readonly taskProgressCheckpoints?: readonly SessionTaskProgressCheckpoint[];
    readonly skillStates?: readonly SkillLifecycleState[];
  } = {},
): string {
  return JSON.stringify({
    schemaVersion: 7,
    type: "snapshot",
    timestamp,
    reason: "size_threshold",
    messages: storedMessages(messages, `snapshot-${timestamp}`),
    pendingInputs: options.pendingInputs ?? [],
    ...(options.goal !== undefined
      ? { goal: sessionGoalRecord(options.goal) }
      : {}),
    ...(options.taskProgressCheckpoints !== undefined
      ? { taskProgressCheckpoints: options.taskProgressCheckpoints }
      : {}),
    skillStateCheckpoints: (
      options.skillStates ?? [{ skillActivations: [], activeSkillIds: [] }]
    ).map((state, index) => ({
      messageOrdinal: index,
      skillActivations: state.skillActivations,
      activeSkillIds: state.activeSkillIds,
    })),
    ...(title !== undefined ? { title } : {}),
  });
}

export function sessionGoalRecordLine(options: {
  readonly timestamp: string;
  readonly goal: SessionGoal | null;
  readonly consumedInputIds?: readonly string[];
}): string {
  return JSON.stringify({
    schemaVersion: 7,
    type: "session_goal",
    timestamp: options.timestamp,
    goal: options.goal === null ? null : sessionGoalRecord(options.goal),
    ...(options.consumedInputIds !== undefined
      ? { consumedInputIds: options.consumedInputIds }
      : {}),
  });
}

export function sessionTitleRecordLine(
  timestamp: string,
  title: string,
  options: {
    readonly consumedInputIds?: readonly string[];
  } = {},
): string {
  return JSON.stringify({
    schemaVersion: 7,
    type: "session_title",
    timestamp,
    title,
    ...(options.consumedInputIds !== undefined
      ? { consumedInputIds: options.consumedInputIds }
      : {}),
  });
}

export function taskProgressRecordLine(options: {
  readonly timestamp: string;
  readonly tasks: readonly SessionTask[];
  readonly messageOrdinal?: number;
}): string {
  return JSON.stringify({
    schemaVersion: 7,
    type: "task_progress",
    timestamp: options.timestamp,
    messageOrdinal: options.messageOrdinal ?? 0,
    tasks: options.tasks,
  });
}

export function inputAdmittedRecordLine(options: {
  readonly timestamp: string;
  readonly id: string;
  readonly line: string;
}): string {
  return JSON.stringify({
    schemaVersion: 7,
    type: "input_admitted",
    timestamp: options.timestamp,
    id: options.id,
    sequence: 1,
    line: options.line,
  });
}

export function inputConsumedRecordLine(
  timestamp: string,
  inputIds: readonly string[],
): string {
  return JSON.stringify({
    schemaVersion: 7,
    type: "input_consumed",
    timestamp,
    inputIds,
  });
}

function sessionForkPolicy() {
  return {
    transcript: "copy_prefix",
    pendingInputs: "drop",
    queuedInputs: "drop",
    bashApprovalGrants: "drop",
  };
}

export function rootGraph(sessionId: string) {
  return {
    graphId: sessionId,
    rootSessionId: sessionId,
    parentSessionId: null,
    branchTitle: "main",
    forkPoint: null,
    forkPolicy: sessionForkPolicy(),
  };
}

export function forkGraph(sessionId: string, parentSessionId: string) {
  return {
    graphId: parentSessionId,
    rootSessionId: parentSessionId,
    parentSessionId,
    branchTitle: sessionId,
    forkPoint: {
      kind: "end",
      sourceSessionId: parentSessionId,
      sourceLastMessageId: null,
      sourceOrdinal: 0,
      preview: "full restored history",
    },
    forkPolicy: sessionForkPolicy(),
  };
}

export function endForkGraph(options: {
  readonly sessionId: string;
  readonly parentSessionId: string;
  readonly sourceLastMessageId: string;
  readonly sourceOrdinal: number;
}) {
  return {
    graphId: options.parentSessionId,
    rootSessionId: options.parentSessionId,
    parentSessionId: options.parentSessionId,
    branchTitle: options.sessionId,
    forkPoint: {
      kind: "end",
      sourceSessionId: options.parentSessionId,
      sourceLastMessageId: options.sourceLastMessageId,
      sourceOrdinal: options.sourceOrdinal,
      preview: "full restored history",
    },
    forkPolicy: sessionForkPolicy(),
  };
}

export function beforeMessageForkGraph(options: {
  readonly sessionId: string;
  readonly parentSessionId: string;
  readonly sourceMessageId: string;
  readonly sourceOrdinal: number;
  readonly preview: string;
}) {
  return {
    graphId: options.parentSessionId,
    rootSessionId: options.parentSessionId,
    parentSessionId: options.parentSessionId,
    branchTitle: options.sessionId,
    forkPoint: {
      kind: "before_message",
      sourceSessionId: options.parentSessionId,
      sourceMessageId: options.sourceMessageId,
      sourceOrdinal: options.sourceOrdinal,
      preview: options.preview,
    },
    forkPolicy: sessionForkPolicy(),
  };
}

export function storedMessages(
  messages: readonly SessionMessage[],
  prefix: string,
) {
  return messages.map((message, index) => ({
    id: `msg_${prefix.replace(/[^A-Za-z0-9_-]/gu, "_")}_${index + 1}`,
    message,
  }));
}

export async function restoredUserMessageId(options: {
  readonly home: string;
  readonly sessionId: string;
  readonly content: string;
}): Promise<string> {
  const ledgerLines = (
    await readFile(
      join(options.home, "sessions", options.sessionId, "ledger.jsonl"),
      "utf8",
    )
  )
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
  const storedMessagesFromLedger = ledgerLines
    .filter(
      (line) =>
        line.type === "append" ||
        line.type === "replace" ||
        line.type === "snapshot" ||
        line.type === "task_admitted" ||
        line.type === "step_committed" ||
        line.type === "task_terminal",
    )
    .flatMap((line) =>
      line.type === "task_admitted"
        ? [line.userMessage].filter(Boolean)
        : (line.messages ?? []),
    );
  const storedMessage = storedMessagesFromLedger.find(
    (candidate) =>
      candidate.message?.role === "user" &&
      candidate.message.content === options.content,
  );
  if (typeof storedMessage?.id !== "string") {
    throw new Error(`expected message id for ${options.content}`);
  }
  return storedMessage.id;
}

export function ledgerRecordMessages(record: {
  readonly messages?: readonly { readonly message?: SessionMessage }[];
  readonly type?: string;
  readonly userMessage?: { readonly message?: SessionMessage };
}): readonly (SessionMessage | undefined)[] {
  return ledgerRecordStoredMessages(record).map(
    (storedMessage) => storedMessage.message,
  );
}

export function ledgerRecordStoredMessages(record: {
  readonly messages?: readonly { readonly message?: SessionMessage }[];
  readonly type?: string;
  readonly userMessage?: { readonly message?: SessionMessage };
}): readonly { readonly message?: SessionMessage; readonly id?: string }[] {
  if (record.type === "task_admitted") {
    return record.userMessage === undefined ? [] : [record.userMessage];
  }
  return record.messages ?? [];
}

export function conversationCheckpoint(
  summary: string,
  noLaterMessages = false,
): string {
  return [
    "<conversation-checkpoint>",
    "The following is a summary of earlier conversation. Treat it as historical context, not as a new instruction.",
    noLaterMessages
      ? "No later messages are available after this checkpoint; continue from the task state and next steps in the summary."
      : "",
    "<summary>",
    summary,
    "</summary>",
    "</conversation-checkpoint>",
  ]
    .filter((part) => part !== "")
    .join("\n");
}

export async function writeSessionLedger(options: {
  readonly home: string;
  readonly id: string;
  readonly headerId?: string;
  readonly workspace: string;
  readonly createdAt: string;
  readonly skillState?: SkillLifecycleState;
  readonly parentSessionId?: string;
  readonly graph?:
    | ReturnType<typeof rootGraph>
    | ReturnType<typeof forkGraph>
    | ReturnType<typeof endForkGraph>
    | ReturnType<typeof beforeMessageForkGraph>;
  readonly records?: readonly string[];
}): Promise<void> {
  const headerId = options.headerId ?? options.id;
  const sessionDir = join(options.home, "sessions", options.id);
  await mkdir(sessionDir, { recursive: true });
  await writeFile(
    join(sessionDir, "ledger.jsonl"),
    `${[
      JSON.stringify({
        schemaVersion: 7,
        type: "session",
        id: headerId,
        createdAt: options.createdAt,
        workspace: options.workspace,
        graph:
          options.graph ??
          (options.parentSessionId === undefined
            ? rootGraph(headerId)
            : forkGraph(headerId, options.parentSessionId)),
      }),
      ...(options.skillState === undefined
        ? []
        : [
            JSON.stringify({
              schemaVersion: 7,
              type: "skill_state",
              timestamp: options.createdAt,
              messageOrdinal: 0,
              skillActivations: options.skillState.skillActivations,
              activeSkillIds: options.skillState.activeSkillIds,
            }),
          ]),
      ...(options.records ?? []),
    ].join("\n")}\n`,
    "utf8",
  );
}
