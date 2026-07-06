import { conversationCheckpointSummaryFromMessage } from "../agent/context-compaction.ts";
import type { Message } from "../llm/types.ts";
import { sanitizeStatusLineText } from "./output.ts";
import { redactTextForPersistence } from "./persistence-redaction.ts";

interface SessionStatusWorkflowSkill {
  readonly name: string;
  readonly relativePath: string;
}

interface SessionStatusRecoveryAction {
  readonly label: string;
  readonly command: string;
}

export interface SessionStatusSnapshotOptions {
  readonly session: string;
  readonly workspace: string;
  readonly activeModel: string;
  readonly workflowSkill?: SessionStatusWorkflowSkill;
  readonly messages: readonly Message[];
  readonly messageCount: number;
  readonly pendingInputCount: number;
  readonly bashApprovalCount: number;
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
  return `${formatStatusText(workflowSkill.name)} (${formatStatusText(workflowSkill.relativePath)})`;
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
    `  workspace: ${formatStatusText(options.workspace)}`,
    `  active model: ${formatStatusText(options.activeModel)}`,
    `  workflow skill: ${formatWorkflowSkill(options.workflowSkill)}`,
    `  messages: ${options.messageCount}`,
    `  pending inputs: ${options.pendingInputCount}`,
    `  bash approvals: ${options.bashApprovalCount}`,
    `  model switches: ${options.modelSwitchCount}`,
    `  latest checkpoint: ${latestCheckpointSummary(options.messages) ?? "none"}`,
    `  undo checkpoints: ${formatUndoCheckpointStatus(options.undoCheckpoints)}`,
    ...formatRecoveryActions(options.recoveryActions),
    "",
  ];
  return lines.join("\n");
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
