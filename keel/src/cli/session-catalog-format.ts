import {
  formatSessionGoalCompletionEvidenceSummary,
  formatSessionGoalRuntimeOutcomeSummary,
  formatSessionGoalSummary,
  type SessionGoal,
} from "../core/session-goal.ts";
import {
  formatSessionTaskProgressSummary,
  type SessionTaskProgress,
} from "../core/task-progress.ts";
import { type ToolCall, toolCallLabel } from "../tools/registry.ts";
import { sanitizeStatusLineText } from "./output.ts";
import { redactTextForPersistence } from "./persistence-redaction.ts";
import {
  formatSessionStatusSnapshot,
  formatSessionTasks,
} from "./session-status-format.ts";
import type {
  SessionCatalog,
  SessionCatalogEntry,
  SessionCatalogWarning,
  SessionForkPointRecord,
  SessionForkPolicyRecord,
  SessionState,
  StoredMessage,
} from "./session-store.ts";

function sessionCatalogEntryLines(
  entry: SessionCatalogEntry,
  depth: number,
): readonly string[] {
  const indent = "  ".repeat(depth);
  const detailIndent = `${indent}   `;
  return [
    `${indent}${entry.id}  updated ${entry.updatedAt}`,
    `${detailIndent}branch: ${entry.graph.branchTitle}`,
    ...(entry.title !== undefined
      ? [`${detailIndent}title: ${formatSessionDetailText(entry.title)}`]
      : []),
    ...(entry.graph.parentSessionId !== null
      ? [`${detailIndent}parent: ${entry.graph.parentSessionId}`]
      : []),
    ...(entry.workflowSkill !== undefined
      ? [
          `${detailIndent}workflow skill: ${entry.workflowSkill.qualifiedName} (${entry.workflowSkill.relativePath})`,
        ]
      : []),
    ...(entry.graph.forkPoint !== null
      ? [
          `${detailIndent}fork point: ${formatSessionForkPoint(entry.graph.forkPoint)}`,
        ]
      : []),
    ...(entry.graph.parentSessionId !== null
      ? [
          `${detailIndent}fork policy: ${formatSessionForkPolicy(entry.graph.forkPolicy)}`,
        ]
      : []),
    `${detailIndent}preview: ${formatSessionDetailText(entry.preview)}`,
    ...sessionRecoveryStateLines(entry, detailIndent),
    `${detailIndent}show: keel sessions show ${entry.id}`,
    `${detailIndent}resume: keel --resume ${entry.id}`,
    `${detailIndent}fork-points: keel --resume ${entry.id} --fork-points`,
    `${detailIndent}fork: keel sessions fork ${entry.id} <new-id>`,
  ];
}

function hasActiveSessionTasks(taskProgress: SessionTaskProgress): boolean {
  return taskProgress.tasks.some((task) => task.status !== "completed");
}

function sessionGoalRecoveryStateLines(
  goal: SessionGoal,
  indent: string,
): readonly string[] {
  const summary = formatSessionGoalSummary(goal, {
    includeCompletionEvidence: false,
  });
  const evidence = formatSessionGoalCompletionEvidenceSummary(goal);
  const outcome = formatSessionGoalRuntimeOutcomeSummary(goal);
  return [
    `${indent}goal: ${formatSessionGoalDetailText(summary)}`,
    ...(outcome === null
      ? []
      : [`${indent}goal outcome: ${formatSessionGoalDetailText(outcome)}`]),
    ...(evidence === null
      ? []
      : [`${indent}goal evidence: ${formatSessionGoalDetailText(evidence)}`]),
  ];
}

function sessionRecoveryStateLines(
  entry: SessionCatalogEntry,
  indent: string,
): readonly string[] {
  return [
    ...(entry.goal !== undefined
      ? sessionGoalRecoveryStateLines(entry.goal, indent)
      : []),
    ...(hasActiveSessionTasks(entry.taskProgress)
      ? [
          `${indent}tasks: ${formatSessionDetailText(formatSessionTaskProgressSummary(entry.taskProgress))}`,
        ]
      : []),
    ...(entry.pendingInputCount > 0
      ? [`${indent}pending inputs: ${entry.pendingInputCount}`]
      : []),
  ];
}

function formatSessionForkPoint(forkPoint: SessionForkPointRecord): string {
  const sourceSessionId = formatSessionDetailText(forkPoint.sourceSessionId);
  switch (forkPoint.kind) {
    case "before_message":
      return `before message ${formatSessionDetailText(forkPoint.sourceMessageId)} (message ${forkPoint.sourceOrdinal}): ${formatSessionDetailText(forkPoint.preview)}`;
    case "end":
      return forkPoint.sourceLastMessageId === null
        ? `full restored history from ${sourceSessionId} (0 messages)`
        : `full restored history from ${sourceSessionId} through message ${formatSessionDetailText(forkPoint.sourceLastMessageId)} (message ${forkPoint.sourceOrdinal})`;
  }
}

function formatSessionForkPolicy(policy: SessionForkPolicyRecord): string {
  return `transcript=${policy.transcript}, pendingInputs=${policy.pendingInputs}, queuedInputs=${policy.queuedInputs}, bashApprovalGrants=${policy.bashApprovalGrants}`;
}

interface SessionCatalogGraphGroup {
  readonly graphId: string;
  readonly rootSessionId: string;
  readonly updatedAt: string;
  readonly entries: readonly SessionCatalogEntry[];
}

function compareSessionCatalogGraphGroups(
  left: SessionCatalogGraphGroup,
  right: SessionCatalogGraphGroup,
): number {
  const timestampDelta = right.updatedAt.localeCompare(left.updatedAt);
  if (timestampDelta !== 0) {
    return timestampDelta;
  }
  return left.graphId.localeCompare(right.graphId);
}

function sessionCatalogGraphGroups(
  entries: readonly SessionCatalogEntry[],
): readonly SessionCatalogGraphGroup[] {
  const groupsById = new Map<string, SessionCatalogGraphGroup>();
  for (const entry of [...entries].sort(
    compareSessionCatalogEntriesForFormat,
  )) {
    const group = groupsById.get(entry.graph.graphId);
    if (group === undefined) {
      groupsById.set(entry.graph.graphId, {
        graphId: entry.graph.graphId,
        rootSessionId: entry.graph.rootSessionId,
        updatedAt: entry.updatedAt,
        entries: [entry],
      });
      continue;
    }
    groupsById.set(entry.graph.graphId, {
      graphId: group.graphId,
      rootSessionId: group.rootSessionId,
      updatedAt: group.updatedAt,
      entries: [...group.entries, entry],
    });
  }

  return [...groupsById.values()].sort(compareSessionCatalogGraphGroups);
}

function sessionCatalogTreeLines(
  entries: readonly SessionCatalogEntry[],
): readonly string[] {
  const entryIds = new Set(entries.map((entry) => entry.id));
  const childrenByParent = new Map<string, SessionCatalogEntry[]>();
  const roots: SessionCatalogEntry[] = [];
  for (const entry of entries) {
    const parentSessionId = entry.graph.parentSessionId;
    if (parentSessionId === null || !entryIds.has(parentSessionId)) {
      roots.push(entry);
      continue;
    }
    const children = childrenByParent.get(parentSessionId) ?? [];
    children.push(entry);
    childrenByParent.set(parentSessionId, children);
  }

  const lines: string[] = [];
  const appendEntry = (entry: SessionCatalogEntry, depth: number): void => {
    lines.push(...sessionCatalogEntryLines(entry, depth));
    for (const child of (childrenByParent.get(entry.id) ?? []).sort(
      compareSessionCatalogEntriesForFormat,
    )) {
      appendEntry(child, depth + 1);
    }
  };
  for (const root of roots.sort(compareSessionCatalogEntriesForFormat)) {
    appendEntry(root, 0);
  }
  return lines;
}

function compareSessionCatalogEntriesForFormat(
  left: SessionCatalogEntry,
  right: SessionCatalogEntry,
): number {
  const timestampDelta = right.updatedAt.localeCompare(left.updatedAt);
  if (timestampDelta !== 0) {
    return timestampDelta;
  }
  return left.id.localeCompare(right.id);
}

export function formatSessionCatalog(catalog: SessionCatalog): string {
  if (catalog.sessions.length === 0) {
    return `No sessions for workspace ${catalog.workspace}.\n`;
  }
  const lines = [
    `Sessions for workspace ${catalog.workspace}:`,
    "resume latest: keel --resume",
  ];
  for (const group of sessionCatalogGraphGroups(catalog.sessions)) {
    lines.push(
      `graph ${group.graphId} root ${group.rootSessionId}  updated ${group.updatedAt}`,
    );
    lines.push(...sessionCatalogTreeLines(group.entries));
  }
  return `${lines.join("\n")}\n`;
}

function sessionPickerEntryLines(
  entry: SessionCatalogEntry,
  index: number,
): readonly string[] {
  const detailIndent = "   ";
  return [
    `${index + 1}. ${formatSessionDetailText(entry.id)}  updated ${formatSessionDetailText(entry.updatedAt)}`,
    `${detailIndent}branch: ${formatSessionDetailText(entry.graph.branchTitle)}`,
    ...(entry.title !== undefined
      ? [`${detailIndent}title: ${formatSessionDetailText(entry.title)}`]
      : []),
    `${detailIndent}preview: ${formatSessionDetailText(entry.preview)}`,
    ...sessionRecoveryStateLines(entry, detailIndent),
  ];
}

export function formatSessionPicker(catalog: SessionCatalog): string {
  const lines = [
    `Sessions for workspace ${formatSessionDetailText(catalog.workspace)}:`,
    "Keep one saved session open per task; resume it for follow-ups until the task is done.",
  ];
  for (const [index, entry] of catalog.sessions.entries()) {
    lines.push(...sessionPickerEntryLines(entry, index));
  }
  lines.push(`Select session [1-${catalog.sessions.length}], or q to cancel:`);
  return `${lines.join("\n")}\n`;
}

export function formatSessionStartupPrompt(options: {
  readonly workspace: string;
  readonly latestSession: SessionCatalogEntry;
}): string {
  const { latestSession } = options;
  const latestSessionId = formatSessionDetailText(latestSession.id);
  return `${[
    `Saved sessions for workspace ${formatSessionDetailText(options.workspace)}:`,
    "Keep one saved session open per task; resume it for follow-ups until the task is done.",
    `latest: ${latestSessionId}  updated ${formatSessionDetailText(latestSession.updatedAt)}`,
    ...(latestSession.title !== undefined
      ? [`title: ${formatSessionDetailText(latestSession.title)}`]
      : []),
    `preview: ${formatSessionDetailText(latestSession.preview)}`,
    ...sessionRecoveryStateLines(latestSession, ""),
    "Resume latest saved session?",
    `  Enter/y  resume latest: ${latestSessionId}`,
    "  p        pick another session",
    "  n        start a new session",
    "  q        quit",
  ].join("\n")}\n`;
}

function formatSessionDetailText(text: string): string {
  const normalized = redactTextForPersistence(text)
    .replace(/\s+/gu, " ")
    .trim();
  return sanitizeStatusLineText(normalized);
}

function formatSessionGoalDetailText(text: string): string {
  return sanitizeStatusLineText(redactTextForPersistence(text).trim());
}

function formatSessionDetailToolCall(toolCall: ToolCall): string {
  return `${formatSessionDetailText(toolCall.id)} ${formatSessionDetailText(toolCallLabel(toolCall))}`;
}

function formatSessionTimelineMessage(
  storedMessage: StoredMessage,
  ordinal: number,
): string {
  const message = storedMessage.message;
  const prefix = `${ordinal}. ${message.role} ${formatSessionDetailText(storedMessage.id)}:`;
  switch (message.role) {
    case "user":
      return `${prefix} ${formatSessionDetailText(message.content)}`;
    case "assistant": {
      const content = formatSessionDetailText(message.content);
      if (message.toolCalls.length === 0) {
        return `${prefix} ${content}`;
      }
      return `${prefix} ${content} | tool calls: ${message.toolCalls.map(formatSessionDetailToolCall).join(", ")}`;
    }
    case "tool":
      return `${prefix} ${formatSessionDetailText(message.toolCallId)}: ${formatSessionDetailText(message.content)}`;
  }
}

function formatSessionDetailActiveModel(session: SessionState): string {
  return session.activeModel === undefined
    ? "(default for next run)"
    : `${formatSessionDetailText(session.activeModel.providerId)}/${formatSessionDetailText(session.activeModel.model)}`;
}

function formatSessionDetailTimeline(options: {
  readonly session: SessionState;
  readonly timelineLimit: number | null;
}): readonly string[] {
  const totalMessages = options.session.storedMessages.length;
  if (totalMessages === 0) {
    return ["timeline (0 messages):", "(no restored messages)"];
  }
  const omittedMessages =
    options.timelineLimit === null
      ? 0
      : Math.max(0, totalMessages - options.timelineLimit);
  const visibleMessages =
    omittedMessages === 0
      ? options.session.storedMessages
      : options.session.storedMessages.slice(omittedMessages);
  const timelineHeader =
    omittedMessages === 0
      ? `timeline (all ${totalMessages} messages):`
      : `timeline (last ${visibleMessages.length} of ${totalMessages} messages):`;
  const lines = [timelineHeader];
  if (omittedMessages > 0) {
    lines.push(
      `${omittedMessages} earlier messages omitted; use --limit <n> or --all to show more.`,
    );
  }
  for (const [index, storedMessage] of visibleMessages.entries()) {
    lines.push(
      formatSessionTimelineMessage(storedMessage, omittedMessages + index + 1),
    );
  }
  return lines;
}

export function formatSessionDetail(options: {
  readonly entry: SessionCatalogEntry;
  readonly session: SessionState;
  readonly timelineLimit: number | null;
  readonly undoCheckpoints: readonly { readonly restoredLabel: string }[];
}): string {
  const lines = [
    `Session "${options.entry.id}":`,
    `workspace: ${options.entry.workspace}`,
    `created: ${options.entry.createdAt}`,
    `updated: ${options.entry.updatedAt}`,
    `branch: ${options.entry.graph.branchTitle}`,
    ...(options.entry.title !== undefined
      ? [`title: ${formatSessionDetailText(options.entry.title)}`]
      : []),
    ...(options.entry.graph.parentSessionId !== null
      ? [`parent: ${options.entry.graph.parentSessionId}`]
      : []),
    ...(options.entry.workflowSkill !== undefined
      ? [
          `workflow skill: ${options.entry.workflowSkill.qualifiedName} (${options.entry.workflowSkill.relativePath})`,
        ]
      : []),
    ...(options.entry.graph.forkPoint !== null
      ? [`fork point: ${formatSessionForkPoint(options.entry.graph.forkPoint)}`]
      : []),
    ...(options.entry.graph.parentSessionId !== null
      ? [
          `fork policy: ${formatSessionForkPolicy(options.entry.graph.forkPolicy)}`,
        ]
      : []),
    `preview: ${formatSessionDetailText(options.entry.preview)}`,
    formatSessionStatusSnapshot({
      session: options.entry.id,
      ...(options.entry.title !== undefined
        ? { title: options.entry.title }
        : {}),
      workspace: options.entry.workspace,
      activeModel: formatSessionDetailActiveModel(options.session),
      ...(options.session.goal !== undefined
        ? { goal: options.session.goal }
        : {}),
      ...(options.entry.workflowSkill !== undefined
        ? { workflowSkill: options.entry.workflowSkill }
        : {}),
      messages: options.session.messages,
      messageCount: options.session.storedMessages.length,
      pendingInputCount: options.session.pendingInputs.length,
      bashApprovalCount: options.session.bashApprovalGrants.length,
      taskProgress: options.session.taskProgress,
      modelSwitchCount: options.session.modelSwitches.length,
      undoCheckpoints: options.undoCheckpoints,
      recoveryActions: [
        {
          label: "resume",
          command: `keel --resume ${options.entry.id}`,
        },
        {
          label: "fork-points",
          command: `keel --resume ${options.entry.id} --fork-points`,
        },
        {
          label: "fork",
          command: `keel sessions fork ${options.entry.id} <new-id>`,
        },
        {
          label: "undo-list",
          command: "keel /undo --list",
        },
      ],
    }).trimEnd(),
    ...(options.session.taskProgress.tasks.length === 0
      ? []
      : [formatSessionTasks(options.session.taskProgress).trimEnd()]),
    "state:",
    `  messages: ${options.session.storedMessages.length}`,
    `  pending inputs: ${options.session.pendingInputs.length}`,
    `  active model: ${formatSessionDetailActiveModel(options.session)}`,
    `  model switches: ${options.session.modelSwitches.length}`,
    `  bash approvals: ${options.session.bashApprovalGrants.length}`,
    "actions:",
    `  resume: keel --resume ${options.entry.id}`,
    `  fork-points: keel --resume ${options.entry.id} --fork-points`,
    `  fork: keel sessions fork ${options.entry.id} <new-id>`,
    ...formatSessionDetailTimeline({
      session: options.session,
      timelineLimit: options.timelineLimit,
    }),
  ];
  return `${lines.join("\n")}\n`;
}

export function formatSessionCatalogWarnings(
  warnings: readonly SessionCatalogWarning[],
): string {
  return warnings
    .map(
      (warning) =>
        `Warning: skipped session "${warning.sessionId}": ${warning.message}\n`,
    )
    .join("");
}

export function formatSessionForkCreated(options: {
  readonly sourceSessionId: string;
  readonly targetSessionId: string;
  readonly forkBeforeMessage?: string;
}): string {
  const forkLine =
    options.forkBeforeMessage === undefined
      ? `Forked session "${options.sourceSessionId}" to "${options.targetSessionId}".`
      : `Forked session "${options.sourceSessionId}" to "${options.targetSessionId}" before message ${options.forkBeforeMessage}.`;
  return `${forkLine}\nresume: keel --resume ${options.targetSessionId}\n`;
}
