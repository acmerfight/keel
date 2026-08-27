import type { AgentEvent, CostReport } from "../agent/events.ts";
import type { SubagentProgressEvent } from "../agent/subagent-supervisor.ts";
import {
  formatSessionGoalCompletionEvidenceSummary,
  formatSessionGoalRuntimeOutcomeSummary,
  formatSessionGoalSummary,
} from "../core/session-goal.ts";
import { formatSessionTaskProgressSummary } from "../core/task-progress.ts";
import { toolCallLabel } from "../tools/registry.ts";
import {
  contextCompactionReasonLabel,
  formatContextCompactionReport,
  formatMemoryOperation,
  formatToolOutputArtifactNotice,
  providerRetryReasonLabel,
} from "./agent-event-format.ts";
import type { AgentEventReportRecorder } from "./report-events.ts";
import {
  sanitizeAssistantText,
  sanitizeStatusLineText,
  sanitizeToolLabel,
} from "./terminal-text.ts";

export { escapeTerminalText, sanitizeStatusLineText } from "./terminal-text.ts";

interface CliOutputRuntime {
  readonly writeStdout: (text: string) => void;
  readonly writeStderr: (text: string) => void;
}

export type EndEvent = Extract<AgentEvent, { readonly type: "end" }>;

function formatUsd(value: number): string {
  return value < 0.0001 ? value.toFixed(6) : value.toFixed(4);
}

export function formatSubagentProgress(event: SubagentProgressEvent): string {
  const identity = sanitizeToolLabel(event.delegationId);
  const task = sanitizeToolLabel(event.task);
  const timing = `elapsed ${Math.max(0, Math.round(event.elapsedMs))}ms; deadline ${Math.round(event.deadlineMs)}ms`;
  if (event.status === "tool") {
    return `${sanitizeStatusLineText(
      `Subagent ${identity}: tool ${sanitizeToolLabel(event.tool)} — ${task} (${timing})`,
    )}\n`;
  }
  if (event.status === "turn") {
    return `${sanitizeStatusLineText(
      `Subagent ${identity}: turn ${event.turn} — ${task} (${timing})`,
    )}\n`;
  }
  return `${sanitizeStatusLineText(
    `Subagent ${identity}: ${event.status} — ${task} (${timing})`,
  )}\n`;
}

export function formatUndoCheckpointList(
  checkpoints: readonly { readonly restoredLabel: string }[],
): string {
  if (checkpoints.length === 0) {
    return "No undo checkpoints.\n";
  }
  return [
    "Undo checkpoints:",
    ...checkpoints.map(
      (checkpoint, index) =>
        `${index + 1}. ${sanitizeStatusLineText(checkpoint.restoredLabel)}`,
    ),
    "",
  ].join("\n");
}

export function formatUndoCheckpointWarning(): string {
  return "Warning: change applied; undo checkpoint unavailable for this task.";
}

export function formatCostReport(cost: CostReport): string {
  const spent = `$${formatUsd(cost.spentUsd)}`;
  switch (cost.budget.kind) {
    case "unbounded":
      return `Cost: ${spent}\n`;
    case "within_budget": {
      const budget = `$${formatUsd(cost.budget.maxUsd)}`;
      return `Cost: ${spent} (budget ${budget})\n`;
    }
    case "budget_limited": {
      const budget = `$${formatUsd(cost.budget.maxUsd)}`;
      return cost.budget.overshootUsd > 0
        ? `Cost: ${spent} (best-effort budget ${budget} exceeded by $${formatUsd(cost.budget.overshootUsd)})\n`
        : `Cost: ${spent} (remaining best-effort budget cannot admit another provider request)\n`;
    }
  }
}

export async function printAgentEvents(
  stream: AsyncIterable<AgentEvent>,
  runtime: CliOutputRuntime,
  reportRecorder?: AgentEventReportRecorder,
): Promise<EndEvent | undefined> {
  let finalEnd: EndEvent | undefined;
  for await (const event of stream) {
    reportRecorder?.record(event);
    if (event.type === "text") {
      runtime.writeStdout(sanitizeAssistantText(event.text));
    } else if (event.type === "context_compacted") {
      runtime.writeStderr(
        formatContextCompactionReport({
          ...event,
          reasonLabel: contextCompactionReasonLabel(event.reason),
        }),
      );
    } else if (event.type === "provider_retry") {
      runtime.writeStderr(
        `Provider retry: ${sanitizeToolLabel(event.provider)} ${providerRetryReasonLabel(event.reason)} (attempt ${event.attempt}/${event.maxRetries} in ${Math.round(event.delayMs)}ms)\n`,
      );
    } else if (event.type === "tool_start") {
      runtime.writeStderr(
        `Tool: ${sanitizeToolLabel(toolCallLabel(event.toolCall))}\n`,
      );
    } else if (event.type === "tool_end") {
      // Status lives in the line prefix because the label is
      // model-controlled text and could end with a forged failure marker.
      if (!event.ok) {
        runtime.writeStderr(
          `Tool failed: ${sanitizeToolLabel(toolCallLabel(event.toolCall))}\n`,
        );
      } else if (event.memoryOperation !== undefined) {
        runtime.writeStderr(
          `${formatMemoryOperation(event.memoryOperation)}\n`,
        );
      }
    } else if (event.type === "task_progress_updated") {
      runtime.writeStderr(
        `Task progress: ${sanitizeStatusLineText(formatSessionTaskProgressSummary(event.taskProgress))}\n`,
      );
    } else if (event.type === "session_goal_updated") {
      const evidence = formatSessionGoalCompletionEvidenceSummary(event.goal);
      const outcome = formatSessionGoalRuntimeOutcomeSummary(event.goal);
      runtime.writeStderr(
        `Session goal: ${sanitizeStatusLineText(formatSessionGoalSummary(event.goal, { includeCompletionEvidence: false }))}\n`,
      );
      if (outcome !== null) {
        runtime.writeStderr(
          `Session goal outcome: ${sanitizeStatusLineText(outcome)}\n`,
        );
      }
      if (evidence !== null) {
        runtime.writeStderr(
          `Session goal evidence: ${sanitizeStatusLineText(evidence)}\n`,
        );
      }
    } else if (event.type === "tool_output_artifact") {
      runtime.writeStderr(`${formatToolOutputArtifactNotice(event)}\n`);
    } else if (event.type === "end") {
      finalEnd = event;
    }
  }
  return finalEnd;
}
