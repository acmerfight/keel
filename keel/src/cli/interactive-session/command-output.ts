import type { ActiveSkillStatus } from "../../skills/model.ts";
import type { AgentControlResult } from "../../tools/agent-control.ts";
import {
  formatAgentHistoryDetail,
  formatAgentHistoryList,
  formatAgentTranscript,
} from "../agent-history-format.ts";
import {
  formatInteractiveForkPicker,
  formatInteractiveSessionForkPoints,
} from "../fork-points.ts";
import { formatUndoCheckpointList } from "../output.ts";
import type { ProviderSelection } from "../provider-config.ts";
import {
  formatSessionStatusSnapshot,
  formatSessionTasks,
} from "../session-status-format.ts";
import type { SessionModelSelection } from "../session-store.ts";
import {
  formatForkRequiresNamedSession,
  formatInteractiveCommandFailure,
  formatInteractiveGoalCommandOutput,
  formatInteractiveHelp,
  formatInteractiveTitle,
  formatInteractiveTitleSet,
  formatTitleRequiresSavedSession,
} from "./commands.ts";
import {
  formatInteractiveDiffOutput,
  type InteractiveDiffInspection,
} from "./diff-inspection.ts";
import type { InteractiveCommandOutputEvent } from "./display.ts";

interface InteractiveCommandStreamOutput {
  readonly stream: "stdout" | "stderr";
  readonly text: string;
}

interface ModelIdentity {
  readonly providerId: string;
  readonly model: string;
}

export interface InteractiveActiveModelStatusState {
  readonly resolved: ModelIdentity | null;
  readonly initialModelSelection?: SessionModelSelection;
  readonly configuredModelSelection?: ProviderSelection;
}

function stdout(text: string): readonly InteractiveCommandOutputEvent[] {
  return [{ type: "stdout", text }];
}

function stderr(text: string): readonly InteractiveCommandOutputEvent[] {
  return [{ type: "stderr", text }];
}

function formatModelIdentity(selection: ModelIdentity): string {
  return `${selection.providerId}/${selection.model}`;
}

function formatConfiguredModelSelection(selection: ProviderSelection): string {
  const provider = selection.providerId ?? "(default provider)";
  const model = selection.model ?? "(default model)";
  return `${provider}/${model}`;
}

function formatActiveWorkflowSkills(
  statuses: readonly ActiveSkillStatus[],
): string {
  if (statuses.length === 0) {
    return "No active workflow skills.\n";
  }
  return [
    "Active workflow skills:",
    ...statuses.map(
      ({ activation, diskStatus }) =>
        `- ${activation.qualifiedName} (${activation.relativePath}) [${activation.trigger}, ${diskStatus}]`,
    ),
    "",
  ].join("\n");
}

export function projectInteractiveCommandOutput(
  outputs: readonly InteractiveCommandStreamOutput[],
): readonly InteractiveCommandOutputEvent[] {
  return outputs.map((output) => ({
    type: output.stream,
    text: output.text,
  }));
}

export function projectInteractiveCommandFailure(
  error: unknown,
): readonly InteractiveCommandOutputEvent[] {
  return stderr(formatInteractiveCommandFailure(error));
}

export function projectInteractiveHelpCommandOutput(): readonly InteractiveCommandOutputEvent[] {
  return stdout(formatInteractiveHelp());
}

export function projectInteractiveStatusCommandOutput(
  options: Parameters<typeof formatSessionStatusSnapshot>[0],
): readonly InteractiveCommandOutputEvent[] {
  return stdout(formatSessionStatusSnapshot(options));
}

export function projectInteractiveAgentHistoryListCommandOutput(
  history: Parameters<typeof formatAgentHistoryList>[0],
): readonly InteractiveCommandOutputEvent[] {
  return stdout(formatAgentHistoryList(history));
}

export function projectInteractiveAgentHistoryDetailCommandOutput(
  entry: Parameters<typeof formatAgentHistoryDetail>[0],
): readonly InteractiveCommandOutputEvent[] {
  return stdout(formatAgentHistoryDetail(entry));
}

export function projectInteractiveAgentTranscriptCommandOutput(
  history: Parameters<typeof formatAgentTranscript>[0],
  entry: Parameters<typeof formatAgentTranscript>[1],
): readonly InteractiveCommandOutputEvent[] {
  return stdout(formatAgentTranscript(history, entry));
}

export function projectInteractiveAgentsRequiresSavedSessionCommandOutput(): readonly InteractiveCommandOutputEvent[] {
  return stderr("Error: /agents requires a saved interactive session.\n");
}

export function projectInteractiveAgentNotFoundCommandOutput(
  selector: string,
): readonly InteractiveCommandOutputEvent[] {
  return stderr(`Error: no subagent matches "${selector}".\n`);
}

export function projectInteractiveAgentLiveControlRequiredCommandOutput(): readonly InteractiveCommandOutputEvent[] {
  return stderr(
    "Error: live agent control requires an attached saved-session owner.\n",
  );
}

export function projectInteractiveAgentControlResultCommandOutput(
  result: AgentControlResult,
): readonly InteractiveCommandOutputEvent[] {
  return result.ok
    ? stdout(`${result.content.trimEnd()}\n`)
    : stderr(`${result.content.trimEnd()}\n`);
}

export function projectInteractiveSessionsRequiresSavedSessionCommandOutput(): readonly InteractiveCommandOutputEvent[] {
  return stderr("Error: /sessions requires a saved interactive session.\n");
}

export function projectInteractiveSessionPickerPromptCommandOutput(
  prompt: string,
): readonly InteractiveCommandOutputEvent[] {
  return stdout(prompt);
}

export function projectInteractiveSessionSwitchCancelledCommandOutput(): readonly InteractiveCommandOutputEvent[] {
  return stdout("Session switch cancelled.\n");
}

export function projectInteractiveSessionAlreadyActiveCommandOutput(
  sessionId: string,
): readonly InteractiveCommandOutputEvent[] {
  return stdout(`Session already active: ${sessionId}\n`);
}

export function projectInteractiveTitleCommandOutput(
  title: string | undefined,
): readonly InteractiveCommandOutputEvent[] {
  return stdout(formatInteractiveTitle(title));
}

export function projectInteractiveTitleRequiresSavedSessionCommandOutput(): readonly InteractiveCommandOutputEvent[] {
  return stderr(formatTitleRequiresSavedSession());
}

export function projectInteractiveTitleSetCommandOutput(
  title: string,
): readonly InteractiveCommandOutputEvent[] {
  return stdout(formatInteractiveTitleSet(title));
}

export function projectInteractiveGoalCommandOutputs(
  outputs: readonly Parameters<typeof formatInteractiveGoalCommandOutput>[0][],
  options: Parameters<typeof formatInteractiveGoalCommandOutput>[1],
): readonly InteractiveCommandOutputEvent[] {
  return projectInteractiveCommandOutput(
    outputs.map((output) =>
      formatInteractiveGoalCommandOutput(output, options),
    ),
  );
}

export function projectInteractiveTasksCommandOutput(
  taskProgress: Parameters<typeof formatSessionTasks>[0],
): readonly InteractiveCommandOutputEvent[] {
  return stdout(formatSessionTasks(taskProgress));
}

export function projectInteractiveDiffCommandOutput(
  inspection: InteractiveDiffInspection,
): readonly InteractiveCommandOutputEvent[] {
  return inspection.kind === "failed"
    ? stderr(formatInteractiveDiffOutput(inspection))
    : stdout(formatInteractiveDiffOutput(inspection));
}

export function projectInteractiveInvalidCommandOutput(
  message: string,
): readonly InteractiveCommandOutputEvent[] {
  return stderr(`${message}\n`);
}

export function projectInteractiveUndoCheckpointListCommandOutput(
  checkpoints: Parameters<typeof formatUndoCheckpointList>[0],
): readonly InteractiveCommandOutputEvent[] {
  return stdout(formatUndoCheckpointList(checkpoints));
}

export function projectInteractiveUndoRestoredCommandOutput(
  restoredLabel: string,
): readonly InteractiveCommandOutputEvent[] {
  return stdout(`Restored ${restoredLabel}\n`);
}

export function projectInteractiveUndoBlockedCommandOutput(
  message: string,
): readonly InteractiveCommandOutputEvent[] {
  return stderr(`${message}\n`);
}

export function projectInteractiveActiveModelStatus(
  state: InteractiveActiveModelStatusState,
): string {
  if (state.resolved !== null) {
    return formatModelIdentity(state.resolved);
  }
  if (state.initialModelSelection !== undefined) {
    return formatModelIdentity(state.initialModelSelection);
  }
  if (state.configuredModelSelection !== undefined) {
    return formatConfiguredModelSelection(state.configuredModelSelection);
  }
  return "(default for next prompt)";
}

export function projectInteractiveCurrentModelCommandOutput(
  resolved: ModelIdentity,
): readonly InteractiveCommandOutputEvent[] {
  return stdout(
    `Current model: ${formatModelIdentity(resolved)}\nUsage: /model <provider>/<model>\n`,
  );
}

export function projectInteractiveModelAlreadySetCommandOutput(
  resolved: ModelIdentity,
): readonly InteractiveCommandOutputEvent[] {
  return stdout(`Model already set to ${formatModelIdentity(resolved)}\n`);
}

export function projectInteractiveModelUnknownContextCommandOutput(
  target: ModelIdentity,
): readonly InteractiveCommandOutputEvent[] {
  return stderr(
    `Error: cannot switch to ${formatModelIdentity(target)} because model metadata is unavailable; set KEEL_CONTEXT_WINDOW_TOKENS to configure the target context window.\n`,
  );
}

export function projectInteractiveModelSwitchedCommandOutput(
  resolved: ModelIdentity,
): readonly InteractiveCommandOutputEvent[] {
  return stdout(`Model switched to ${formatModelIdentity(resolved)}\n`);
}

export function projectInteractiveActiveSkillsCommandOutput(
  statuses: readonly ActiveSkillStatus[],
): readonly InteractiveCommandOutputEvent[] {
  return stdout(formatActiveWorkflowSkills(statuses));
}

export function projectInteractiveSkillActivatedCommandOutput(
  qualifiedName: string,
): readonly InteractiveCommandOutputEvent[] {
  return stdout(`Activated workflow skill ${qualifiedName}.\n`);
}

export function projectInteractiveSkillDeactivatedCommandOutput(
  qualifiedName: string,
): readonly InteractiveCommandOutputEvent[] {
  return stdout(`Deactivated workflow skill ${qualifiedName}.\n`);
}

export function projectInteractiveSkillReloadedCommandOutput(
  qualifiedName: string,
): readonly InteractiveCommandOutputEvent[] {
  return stdout(`Reloaded workflow skill ${qualifiedName}.\n`);
}

export function projectInteractiveForkRequiresNamedSessionCommandOutput(
  command: "/fork" | "/fork-points",
): readonly InteractiveCommandOutputEvent[] {
  return stderr(formatForkRequiresNamedSession(command));
}

export function projectInteractiveForkPointsCommandOutput(
  forkPoints: Parameters<typeof formatInteractiveSessionForkPoints>[0],
): readonly InteractiveCommandOutputEvent[] {
  return stdout(formatInteractiveSessionForkPoints(forkPoints));
}

export function projectInteractiveForkPickerCommandOutput(
  forkPoints: Parameters<typeof formatInteractiveForkPicker>[0],
): readonly InteractiveCommandOutputEvent[] {
  return stdout(formatInteractiveForkPicker(forkPoints));
}

export function projectInteractiveForkCancelledCommandOutput(): readonly InteractiveCommandOutputEvent[] {
  return stdout("Fork cancelled.\n");
}

export function projectInteractiveForkCreatedCommandOutput(
  message: string,
): readonly InteractiveCommandOutputEvent[] {
  return stdout(message);
}

export function projectInteractiveCompactSkippedCommandOutput(): readonly InteractiveCommandOutputEvent[] {
  return stderr(
    "Context compaction skipped: no conversation history to compact.\n",
  );
}

export function projectInteractiveRecoveryBlockedCommandOutput(
  taskId: string,
): readonly InteractiveCommandOutputEvent[] {
  return stderr(
    `Error: recovery_blocked for durable Task ${taskId}; input remains queued.\n`,
  );
}
