import { conversationCheckpointSummaryFromMessage } from "../agent/context-compaction.ts";
import type { SessionMessage } from "../agent/session-message.ts";
import type { ExecutionPosture } from "../core/execution-posture.ts";
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
import type { UndoProtectionSummary } from "../core/undo-protection.ts";
import { sanitizeStatusLineText } from "./output.ts";
import { redactTextForPersistence } from "./persistence-redaction.ts";
import type { RunReportMemory } from "./report.ts";

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
  readonly executionPosture: ExecutionPosture | null;
  readonly goal?: SessionGoal;
  readonly workflowSkills?: readonly SessionStatusWorkflowSkill[];
  readonly skillCatalog?: {
    readonly exposed: number;
    readonly omitted: number;
    readonly total: number;
    readonly budgetChars: number;
  };
  readonly messages: readonly SessionMessage[];
  readonly messageCount: number;
  readonly pendingInputCount: number;
  readonly taskProgress: SessionTaskProgress;
  readonly modelSwitchCount: number;
  readonly undoCheckpoints: readonly { readonly restoredLabel: string }[];
  readonly undoProtection?: UndoProtectionSummary;
  readonly memory?: RunReportMemory;
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

function latestCheckpointSummary(
  messages: readonly SessionMessage[],
): string | null {
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

function formatWorkflowSkills(
  workflowSkills: readonly SessionStatusWorkflowSkill[] | undefined,
): string {
  if (workflowSkills === undefined || workflowSkills.length === 0) {
    return "none";
  }
  return workflowSkills
    .map(
      (skill) =>
        `${formatStatusText(skill.qualifiedName)} (${formatStatusText(skill.relativePath)})`,
    )
    .join(", ");
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

function formatUndoProtectionStatus(summary: UndoProtectionSummary): string {
  if (summary.latestCheckpoint === null) return "not applicable";
  const failed = summary.failures.reduce(
    (total, failure) => total + failure.count,
    0,
  );
  const latestStatus = summary.latestCheckpoint.written
    ? "available"
    : `unavailable - ${summary.latestCheckpoint.reason.replaceAll("_", " ")}`;
  return `${summary.status} overall (latest: ${latestStatus}; ${failed} failed, ${summary.checkpointsWritten} written)`;
}

function formatMemoryStatus(memory: RunReportMemory | undefined): string {
  if (memory === undefined) return "not available";
  switch (memory.status) {
    case "disabled":
      return "disabled (--no-memory)";
    case "error":
      return `error - ${formatStatusText(memory.error)}`;
    case "available": {
      const loadedIds =
        memory.loadedIds.length === 0
          ? "none"
          : memory.loadedIds.map(formatStatusText).join(", ");
      const lifecycle =
        memory.loadedEntries.length === 0
          ? "none"
          : memory.loadedEntries
              .map(
                (entry) =>
                  `${formatStatusText(entry.id)}=${formatStatusText(entry.status)}`,
              )
              .join(", ");
      return `${memory.loadedIds.length} loaded for project ${formatStatusText(memory.scope.id)}; IDs: ${loadedIds}; lifecycle: ${lifecycle} (${memory.renderedBytes} bytes, ~${memory.estimatedTokens} tokens)`;
    }
  }
}

function formatExecutionStatus(posture: ExecutionPosture | null): string {
  if (posture === null) {
    return "not active; posture is recomputed from the next CLI invocation; enabled MCP integrations may perform external effects";
  }
  if (posture === "trusted") {
    return "trusted; Bash runs with current OS user authority and enabled MCP integrations may perform external effects; children may use exact current MCP task leases";
  }
  return "reviewed; each Bash command and main-agent MCP call requires allow-once approval; children cannot receive MCP task leases";
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
    `  execution: ${formatExecutionStatus(options.executionPosture)}`,
    `  workflow skills: ${formatWorkflowSkills(options.workflowSkills)}`,
    `  skill catalog: ${
      options.skillCatalog === undefined
        ? "not available"
        : `${options.skillCatalog.exposed}/${options.skillCatalog.total} exposed, ${options.skillCatalog.omitted} omitted (budget ${options.skillCatalog.budgetChars} chars)`
    }`,
    `  messages: ${options.messageCount}`,
    `  pending inputs: ${options.pendingInputCount}`,
    `  memory: ${formatMemoryStatus(options.memory)}`,
    `  tasks: ${formatStatusText(formatSessionTaskProgressSummary(options.taskProgress))}`,
    `  model switches: ${options.modelSwitchCount}`,
    `  latest checkpoint: ${latestCheckpointSummary(options.messages) ?? "none"}`,
    `  undo checkpoints: ${formatUndoCheckpointStatus(options.undoCheckpoints)}`,
    ...(options.undoProtection === undefined
      ? []
      : [
          `  undo protection: ${formatUndoProtectionStatus(options.undoProtection)}`,
        ]),
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
