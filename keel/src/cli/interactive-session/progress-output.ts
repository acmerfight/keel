import type { ContextCompactionStats } from "../../agent/context-compaction.ts";
import type { CostReport } from "../../agent/events.ts";
import type { SubagentProgressEvent } from "../../agent/subagent-supervisor.ts";
import type { ToolOutputArtifactNotice } from "../../agent/tool-output-artifacts.ts";
import {
  formatSessionGoalSummary,
  type SessionGoal,
} from "../../core/session-goal.ts";
import {
  formatSkillCatalogDegradation,
  type SkillCatalogExposure,
} from "../../skills/catalog.ts";
import {
  formatContextCompactionReport,
  formatToolOutputArtifactNotice,
} from "../agent-event-format.ts";
import {
  formatCostReport,
  formatSubagentProgress,
  formatUndoCheckpointWarning,
  sanitizeStatusLineText,
} from "../output.ts";
import { formatManualCompactionFailure } from "./commands.ts";
import type { InteractiveProgressOutputEvent } from "./display.ts";

function stdout(text: string): readonly InteractiveProgressOutputEvent[] {
  return [{ type: "stdout", text }];
}

function stderr(text: string): readonly InteractiveProgressOutputEvent[] {
  return [{ type: "stderr", text }];
}

export function projectInteractiveCostReport(
  cost: CostReport,
): readonly InteractiveProgressOutputEvent[] {
  return [{ type: "cost_report", cost, text: formatCostReport(cost) }];
}

export function projectInteractiveCompactionAbortedNotice(): readonly InteractiveProgressOutputEvent[] {
  return stdout("\n");
}

export function projectInteractiveCompactionSuccessNotice(options: {
  readonly stats: ContextCompactionStats;
  readonly reasonLabel: string;
  readonly artifactNotices?: readonly ToolOutputArtifactNotice[];
}): readonly InteractiveProgressOutputEvent[] {
  return [
    ...stderr(
      formatContextCompactionReport({
        ...options.stats,
        reasonLabel: options.reasonLabel,
      }),
    ),
    ...(options.artifactNotices ?? []).flatMap((notice) =>
      stderr(`${formatToolOutputArtifactNotice(notice)}\n`),
    ),
  ];
}

export function projectInteractiveCompactionFailureNotice(
  error: unknown,
): readonly InteractiveProgressOutputEvent[] {
  return stderr(formatManualCompactionFailure(error));
}

export function projectInteractiveCompactionSkippedNotice(): readonly InteractiveProgressOutputEvent[] {
  return stderr("Context compaction skipped: no safe history to compact.\n");
}

export function projectInteractiveModelSwitchOverflowNotice(target: {
  readonly providerId: string;
  readonly model: string;
}): readonly InteractiveProgressOutputEvent[] {
  return stderr(
    `Error: switching to ${target.providerId}/${target.model} still exceeds the target context window after model-switch compaction.\n`,
  );
}

export function projectInteractiveGoalLimitNotice(
  goal: SessionGoal,
): readonly InteractiveProgressOutputEvent[] {
  return stderr(
    `Session goal: ${sanitizeStatusLineText(formatSessionGoalSummary(goal))}\n`,
  );
}

export function projectInteractiveSkillCatalogDegradationNotice(
  exposure: SkillCatalogExposure,
): readonly InteractiveProgressOutputEvent[] {
  const diagnostic = formatSkillCatalogDegradation(exposure);
  return diagnostic === "" ? [] : stderr(diagnostic);
}

export function projectInteractiveSubagentProgressNotice(
  event: SubagentProgressEvent,
): readonly InteractiveProgressOutputEvent[] {
  return stderr(formatSubagentProgress(event));
}

export function projectInteractiveUndoCheckpointWarningNotice(): readonly InteractiveProgressOutputEvent[] {
  return stderr(`${formatUndoCheckpointWarning()}\n`);
}
