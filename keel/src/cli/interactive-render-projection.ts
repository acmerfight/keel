import type { AgentEvent } from "../agent/events.ts";
import {
  formatSessionGoalCompletionEvidenceSummary,
  formatSessionGoalRuntimeOutcomeSummary,
  formatSessionGoalSummary,
  type SessionGoal,
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
import type { InteractiveTranscriptEvent } from "./interactive-render-events.ts";
import type { AgentEventReportRecorder } from "./report-events.ts";
import {
  sanitizeAssistantText,
  sanitizeStatusLineText,
  sanitizeToolLabel,
} from "./terminal-text.ts";

interface StableInteractiveOutputRuntime {
  readonly writeStdout: (text: string) => void;
  readonly writeAssistantHeader: () => void;
  readonly writeStatusLine: (text: string) => void;
  readonly setActivityStatus?: (text: string | null) => void;
}

interface InteractiveTerminalOutputRuntime {
  readonly renderAgentEvent: (event: InteractiveTranscriptEvent) => void;
  readonly setActivityStatus: (text: string | null) => void;
}

type EndEvent = Extract<AgentEvent, { readonly type: "end" }>;

type StableInteractiveRenderCommand =
  | { readonly type: "activity_status"; readonly text: string | null }
  | { readonly type: "assistant_header" }
  | { readonly type: "stdout"; readonly text: string }
  | { readonly type: "status_line"; readonly text: string }
  | { readonly type: "end"; readonly event: EndEvent };

type TerminalInteractiveRenderCommand =
  | { readonly type: "activity_status"; readonly text: string | null }
  | { readonly type: "transcript"; readonly event: InteractiveTranscriptEvent }
  | { readonly type: "end"; readonly event: EndEvent };

function stableActivityStatus(
  text: string | null,
): StableInteractiveRenderCommand {
  return { type: "activity_status", text };
}

function stableStatusLine(text: string): StableInteractiveRenderCommand {
  return { type: "status_line", text };
}

function stableAssistantHeader(): StableInteractiveRenderCommand {
  return { type: "assistant_header" };
}

function stableStdout(text: string): StableInteractiveRenderCommand {
  return { type: "stdout", text };
}

function terminalActivityStatus(
  text: string | null,
): TerminalInteractiveRenderCommand {
  return { type: "activity_status", text };
}

function terminalTranscript(
  event: InteractiveTranscriptEvent,
): TerminalInteractiveRenderCommand {
  return { type: "transcript", event };
}

export function formatLiveSessionGoalStatus(
  goal: SessionGoal | undefined,
): string | null {
  if (goal === undefined) return null;
  const summary = formatSessionGoalSummary(goal, {
    includeCompletionEvidence: false,
  });
  const outcome = formatSessionGoalRuntimeOutcomeSummary(goal);
  if (outcome === null) return sanitizeStatusLineText(summary);
  return sanitizeStatusLineText(`${summary}; outcome: ${outcome}`);
}

function projectSessionGoalNotices(goal: SessionGoal): readonly string[] {
  const evidence = formatSessionGoalCompletionEvidenceSummary(goal);
  const outcome = formatSessionGoalRuntimeOutcomeSummary(goal);
  return [
    `Session goal: ${sanitizeStatusLineText(
      formatSessionGoalSummary(goal, { includeCompletionEvidence: false }),
    )}`,
    ...(outcome === null
      ? []
      : [`Session goal outcome: ${sanitizeStatusLineText(outcome)}`]),
    ...(evidence === null
      ? []
      : [`Session goal evidence: ${sanitizeStatusLineText(evidence)}`]),
  ];
}

function projectStableEvent(
  event: AgentEvent,
  state: {
    readonly assistantHeaderWritten: boolean;
  },
): readonly StableInteractiveRenderCommand[] {
  switch (event.type) {
    case "text":
      return [
        stableActivityStatus("Responding"),
        ...(state.assistantHeaderWritten ? [] : [stableAssistantHeader()]),
        stableStdout(sanitizeAssistantText(event.text)),
      ];
    case "context_compacted":
      return [
        stableActivityStatus("Context compacted"),
        stableStatusLine(
          formatContextCompactionReport({
            ...event,
            reasonLabel: contextCompactionReasonLabel(event.reason),
          }).trimEnd(),
        ),
      ];
    case "provider_retry":
      return [
        stableActivityStatus("Waiting to retry provider"),
        stableStatusLine(
          `Provider retry: ${sanitizeToolLabel(event.provider)} ${providerRetryReasonLabel(event.reason)} (attempt ${event.attempt}/${event.maxRetries} in ${Math.round(event.delayMs)}ms)`,
        ),
      ];
    case "tool_start": {
      const label = sanitizeToolLabel(toolCallLabel(event.toolCall));
      return [
        stableActivityStatus(`Tool: ${label}`),
        stableStatusLine(`Tool: ${label}`),
      ];
    }
    case "tool_end": {
      const label = sanitizeToolLabel(toolCallLabel(event.toolCall));
      return [
        stableActivityStatus(event.ok ? "Thinking" : `Tool failed: ${label}`),
        ...(!event.ok
          ? [stableStatusLine(`Tool failed: ${label}`)]
          : event.memoryOperation === undefined
            ? []
            : [stableStatusLine(formatMemoryOperation(event.memoryOperation))]),
      ];
    }
    case "task_progress_updated":
      return [
        stableActivityStatus("Task progress updated"),
        stableStatusLine(
          `Task progress: ${sanitizeStatusLineText(
            formatSessionTaskProgressSummary(event.taskProgress),
          )}`,
        ),
      ];
    case "session_goal_updated":
      return projectSessionGoalNotices(event.goal).map(stableStatusLine);
    case "tool_output_artifact":
      return [
        stableActivityStatus("Stored tool output artifact"),
        stableStatusLine(formatToolOutputArtifactNotice(event)),
      ];
    case "end":
      return [{ type: "end", event }];
    case "skill_activated":
    case "undo_checkpoint":
      return [];
  }
}

function projectTerminalEvent(
  event: AgentEvent,
  activeTools: Map<string, string>,
): readonly TerminalInteractiveRenderCommand[] {
  switch (event.type) {
    case "text":
      return [
        terminalActivityStatus("Responding"),
        terminalTranscript({
          type: "assistant_delta",
          text: sanitizeAssistantText(event.text),
        }),
      ];
    case "context_compacted":
      return [
        terminalActivityStatus("Context compacted"),
        terminalTranscript({
          type: "notice",
          tone: "info",
          text: formatContextCompactionReport({
            ...event,
            reasonLabel: contextCompactionReasonLabel(event.reason),
          }).trimEnd(),
        }),
      ];
    case "provider_retry":
      return [
        terminalActivityStatus("Waiting to retry provider"),
        terminalTranscript({
          type: "notice",
          tone: "warning",
          text: `Provider retry: ${sanitizeToolLabel(event.provider)} ${providerRetryReasonLabel(event.reason)} (attempt ${event.attempt}/${event.maxRetries} in ${Math.round(event.delayMs)}ms)`,
        }),
      ];
    case "tool_start": {
      const label = sanitizeToolLabel(toolCallLabel(event.toolCall));
      activeTools.set(event.toolCall.id, label);
      return [
        terminalActivityStatus(`Running ${label}`),
        terminalTranscript({
          type: "tool_started",
          toolCallId: event.toolCall.id,
          label,
        }),
      ];
    }
    case "tool_end": {
      const label = sanitizeToolLabel(toolCallLabel(event.toolCall));
      activeTools.delete(event.toolCall.id);
      return [
        terminalActivityStatus(event.ok ? "Thinking" : `Tool failed: ${label}`),
        terminalTranscript({
          type: event.ok ? "tool_succeeded" : "tool_failed",
          toolCallId: event.toolCall.id,
          label,
        }),
        ...(event.ok && event.memoryOperation !== undefined
          ? [
              terminalTranscript({
                type: "notice",
                tone: "info",
                text: formatMemoryOperation(event.memoryOperation),
              }),
            ]
          : []),
      ];
    }
    case "task_progress_updated":
      return [
        terminalActivityStatus("Task progress updated"),
        terminalTranscript({
          type: "notice",
          tone: "info",
          text: `Task progress: ${sanitizeStatusLineText(
            formatSessionTaskProgressSummary(event.taskProgress),
          )}`,
        }),
      ];
    case "session_goal_updated":
      return projectSessionGoalNotices(event.goal).map((text) =>
        terminalTranscript({
          type: "notice",
          tone: "info",
          text,
        }),
      );
    case "tool_output_artifact":
      return [
        terminalActivityStatus(
          event.status === "stored"
            ? "Stored tool output artifact"
            : "Tool output artifact failed",
        ),
        terminalTranscript({
          type: "notice",
          tone: event.status === "stored" ? "info" : "error",
          text: formatToolOutputArtifactNotice(event),
        }),
      ];
    case "end":
      return [{ type: "end", event }];
    case "skill_activated":
    case "undo_checkpoint":
      return [];
  }
}

function renderStableCommand(
  command: StableInteractiveRenderCommand,
  runtime: StableInteractiveOutputRuntime,
): EndEvent | undefined {
  switch (command.type) {
    case "activity_status":
      runtime.setActivityStatus?.(command.text);
      return undefined;
    case "assistant_header":
      runtime.writeAssistantHeader();
      return undefined;
    case "stdout":
      runtime.writeStdout(command.text);
      return undefined;
    case "status_line":
      runtime.writeStatusLine(command.text);
      return undefined;
    case "end":
      return command.event;
  }
}

function renderTerminalCommand(
  command: TerminalInteractiveRenderCommand,
  runtime: InteractiveTerminalOutputRuntime,
): EndEvent | undefined {
  switch (command.type) {
    case "activity_status":
      runtime.setActivityStatus(command.text);
      return undefined;
    case "transcript":
      runtime.renderAgentEvent(command.event);
      return undefined;
    case "end":
      return command.event;
  }
}

export async function printStableInteractiveAgentEvents(
  stream: AsyncIterable<AgentEvent>,
  runtime: StableInteractiveOutputRuntime,
  reportRecorder?: AgentEventReportRecorder,
): Promise<EndEvent | undefined> {
  let finalEnd: EndEvent | undefined;
  let assistantHeaderWritten = false;
  runtime.setActivityStatus?.("Thinking");
  try {
    for await (const event of stream) {
      reportRecorder?.record(event);
      for (const command of projectStableEvent(event, {
        assistantHeaderWritten,
      })) {
        const renderedEnd = renderStableCommand(command, runtime);
        if (renderedEnd !== undefined) {
          finalEnd = renderedEnd;
        }
        if (command.type === "assistant_header") {
          assistantHeaderWritten = true;
        }
      }
    }
  } finally {
    runtime.setActivityStatus?.(null);
  }
  return finalEnd;
}

export async function printInteractiveTerminalAgentEvents(
  stream: AsyncIterable<AgentEvent>,
  runtime: InteractiveTerminalOutputRuntime,
): Promise<EndEvent | undefined> {
  let finalEnd: EndEvent | undefined;
  const activeTools = new Map<string, string>();
  runtime.setActivityStatus("Thinking");
  try {
    for await (const event of stream) {
      for (const command of projectTerminalEvent(event, activeTools)) {
        const renderedEnd = renderTerminalCommand(command, runtime);
        if (renderedEnd !== undefined) {
          finalEnd = renderedEnd;
        }
      }
    }
  } finally {
    for (const [toolCallId, label] of activeTools) {
      runtime.renderAgentEvent({
        type: "tool_interrupted",
        toolCallId,
        label,
      });
    }
    runtime.setActivityStatus(null);
  }
  return finalEnd;
}
