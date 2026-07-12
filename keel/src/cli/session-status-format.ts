import { conversationCheckpointSummaryFromMessage } from "../agent/context-compaction.ts";
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
import type { Message } from "../llm/types.ts";
import { sanitizeStatusLineText } from "./output.ts";
import { redactTextForPersistence } from "./persistence-redaction.ts";

interface SessionStatusWorkflowSkill {
  readonly qualifiedName: string;
  readonly relativePath: string;
}

interface SessionStatusRecoveryAction {
  readonly label: string;
  readonly command: string;
}

export interface SessionStatusSnapshotOptions {
  readonly session: string;
  readonly title?: string;
  readonly workspace: string;
  readonly activeModel: string;
  readonly goal?: SessionGoal;
  readonly workflowSkill?: SessionStatusWorkflowSkill;
  readonly skillCatalog?: {
    readonly exposed: number;
    readonly omitted: number;
    readonly total: number;
    readonly budgetChars: number;
  };
  readonly messages: readonly Message[];
  readonly messageCount: number;
  readonly pendingInputCount: number;
  readonly bashApprovalCount: number;
  readonly taskProgress: SessionTaskProgress;
  readonly modelSwitchCount: number;
  readonly undoCheckpoints: readonly { readonly restoredLabel: string }[];
  readonly recoveryActions: readonly SessionStatusRecoveryAction[];
}

function formatStatusText(text: string): string {
  const normalized = redactTextForPersistence(text)
    .replace(/\s+/gu, " ")
    .trim();
  return sanitizeStatusLineText(normalized);
}

function formatStatusGoalText(text: string): string {
  return sanitizeStatusLineText(redactTextForPersistence(text).trim());
}

function formatStatusGoalLines(
  goal: SessionGoal | undefined,
): readonly string[] {
  const summary = formatSessionGoalSummary(goal, {
    includeCompletionEvidence: false,
  });
  const evidence = formatSessionGoalCompletionEvidenceSummary(goal);
  const outcome = formatSessionGoalRuntimeOutcomeSummary(goal);
  return [
    `  goal: ${formatStatusGoalText(summary)}`,
    ...(outcome === null
      ? []
      : [`  goal outcome: ${formatStatusGoalText(outcome)}`]),
    ...(evidence === null
      ? []
      : [`  goal evidence: ${formatStatusGoalText(evidence)}`]),
  ];
}

function escapeStatusTextWithoutLimit(text: string): string {
  return text.replace(
    // biome-ignore lint/suspicious/noControlCharactersInRegex: recovery commands must render untrusted bytes visibly.
    /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2060\u202a-\u202e\u2066-\u2069\ufeff]/g,
    (char) => {
      const code = char.charCodeAt(0);
      return code <= 0x9f
        ? `\\x${code.toString(16).padStart(2, "0")}`
        : `\\u{${code.toString(16)}}`;
    },
  );
}

function formatRecoveryCommand(command: string): string {
  const normalized = redactTextForPersistence(command)
    .replace(/\s+/gu, " ")
    .trim();
  return escapeStatusTextWithoutLimit(normalized);
}

function latestCheckpointSummary(messages: readonly Message[]): string | null {
  for (const message of messages.toReversed()) {
    if (message.role !== "user") {
      continue;
    }
    const summary = conversationCheckpointSummaryFromMessage(message);
    if (summary !== null) {
      return formatStatusText(summary);
    }
  }
  return null;
}

function formatWorkflowSkill(
  workflowSkill: SessionStatusWorkflowSkill | undefined,
): string {
  if (workflowSkill === undefined) {
    return "none";
  }
  return `${formatStatusText(workflowSkill.qualifiedName)} (${formatStatusText(workflowSkill.relativePath)})`;
}

function formatUndoCheckpointStatus(
  checkpoints: readonly { readonly restoredLabel: string }[],
): string {
  const latest = checkpoints[0];
  if (latest === undefined) {
    return "0";
  }
  return `${checkpoints.length} (latest: ${formatStatusText(latest.restoredLabel)})`;
}

export function formatSessionStatusSnapshot(
  options: SessionStatusSnapshotOptions,
): string {
  const lines = [
    "status:",
    `  session: ${formatStatusText(options.session)}`,
    `  title: ${
      options.title === undefined
        ? "(not set)"
        : formatStatusText(options.title)
    }`,
    "  continue: send follow-ups or corrections here until the task is done",
    ...formatStatusGoalLines(options.goal),
    `  workspace: ${formatStatusText(options.workspace)}`,
    `  active model: ${formatStatusText(options.activeModel)}`,
    `  workflow skill: ${formatWorkflowSkill(options.workflowSkill)}`,
    `  skill catalog: ${
      options.skillCatalog === undefined
        ? "not available"
        : `${options.skillCatalog.exposed}/${options.skillCatalog.total} exposed, ${options.skillCatalog.omitted} omitted (budget ${options.skillCatalog.budgetChars} chars)`
    }`,
    `  messages: ${options.messageCount}`,
    `  pending inputs: ${options.pendingInputCount}`,
    `  bash approvals: ${options.bashApprovalCount}`,
    `  tasks: ${formatStatusText(formatSessionTaskProgressSummary(options.taskProgress))}`,
    `  model switches: ${options.modelSwitchCount}`,
    `  latest checkpoint: ${latestCheckpointSummary(options.messages) ?? "none"}`,
    `  undo checkpoints: ${formatUndoCheckpointStatus(options.undoCheckpoints)}`,
    ...formatRecoveryActions(options.recoveryActions),
    "",
  ];
  return lines.join("\n");
}

export function formatSessionTasks(taskProgress: SessionTaskProgress): string {
  if (taskProgress.tasks.length === 0) {
    return "No session tasks.\n";
  }
  return [
    "Session tasks:",
    ...taskProgress.tasks.map(
      (task, index) =>
        `  ${index + 1}. [${task.status}] ${formatStatusText(task.step)}`,
    ),
    "",
  ].join("\n");
}

function formatRecoveryActions(
  actions: readonly SessionStatusRecoveryAction[],
): readonly string[] {
  if (actions.length === 0) {
    return [];
  }
  return [
    "recovery:",
    ...actions.map(
      (action) =>
        `  ${formatStatusText(action.label)}: ${formatRecoveryCommand(action.command)}`,
    ),
  ];
}
