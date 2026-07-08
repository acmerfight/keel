import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { WorkflowSkill } from "../agent/prompt.ts";
import type {
  SessionQueuedInput,
  SessionTaskProgressCheckpoint,
} from "../cli/session-store.ts";
import type { SessionGoal } from "../core/session-goal.ts";
import type { SessionTask } from "../core/task-progress.ts";
import type { Message } from "../llm/types.ts";

export function appendSessionRecordLine(
  timestamp: string,
  messages: readonly Message[],
): string {
  return JSON.stringify({
    schemaVersion: 2,
    type: "append",
    timestamp,
    reason: "turn",
    messages: storedMessages(messages, `append-${timestamp}`),
  });
}

export function replaceSessionRecordLine(
  timestamp: string,
  messages: readonly Message[],
): string {
  return JSON.stringify({
    schemaVersion: 2,
    type: "replace",
    timestamp,
    reason: "compaction",
    messages: storedMessages(messages, `replace-${timestamp}`),
  });
}

export function snapshotSessionRecordLine(
  timestamp: string,
  messages: readonly Message[],
  title?: string,
  options: {
    readonly pendingInputs?: readonly SessionQueuedInput[];
    readonly goal?: SessionGoal;
    readonly taskProgressCheckpoints?: readonly SessionTaskProgressCheckpoint[];
  } = {},
): string {
  return JSON.stringify({
    schemaVersion: 2,
    type: "snapshot",
    timestamp,
    reason: "size_threshold",
    messages: storedMessages(messages, `snapshot-${timestamp}`),
    pendingInputs: options.pendingInputs ?? [],
    ...(options.goal !== undefined ? { goal: options.goal } : {}),
    ...(options.taskProgressCheckpoints !== undefined
      ? { taskProgressCheckpoints: options.taskProgressCheckpoints }
      : {}),
    ...(title !== undefined ? { title } : {}),
  });
}

export function sessionGoalRecordLine(options: {
  readonly timestamp: string;
  readonly goal: SessionGoal | null;
  readonly consumedInputIds?: readonly string[];
}): string {
  return JSON.stringify({
    schemaVersion: 2,
    type: "session_goal",
    timestamp: options.timestamp,
    goal: options.goal,
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
    schemaVersion: 2,
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
    schemaVersion: 2,
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
    schemaVersion: 2,
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
    schemaVersion: 2,
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

export function storedMessages(messages: readonly Message[], prefix: string) {
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
        line.type === "snapshot",
    )
    .flatMap((line) => line.messages ?? []);
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
  readonly messages?: readonly { readonly message?: Message }[];
}): readonly (Message | undefined)[] {
  return (record.messages ?? []).map((storedMessage) => storedMessage.message);
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
  readonly workflowSkill?: WorkflowSkill;
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
        schemaVersion: 2,
        type: "session",
        id: headerId,
        createdAt: options.createdAt,
        workspace: options.workspace,
        graph:
          options.graph ??
          (options.parentSessionId === undefined
            ? rootGraph(headerId)
            : forkGraph(headerId, options.parentSessionId)),
        ...(options.workflowSkill !== undefined
          ? { workflowSkill: options.workflowSkill }
          : {}),
      }),
      ...(options.records ?? []),
    ].join("\n")}\n`,
    "utf8",
  );
}
