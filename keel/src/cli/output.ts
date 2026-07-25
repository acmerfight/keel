import type { ContextCompactionStats } from "../agent/context-compaction.ts";
import type { AgentEvent, CostReport } from "../agent/events.ts";
import type { ToolOutputArtifactNotice } from "../agent/tool-output-artifacts.ts";
import {
  formatSessionGoalCompletionEvidenceSummary,
  formatSessionGoalRuntimeOutcomeSummary,
  formatSessionGoalSummary,
  type SessionGoal,
} from "../core/session-goal.ts";
import { formatSessionTaskProgressSummary } from "../core/task-progress.ts";
import type { AgentMemoryOperation } from "../tools/memory.ts";
import { toolCallLabel } from "../tools/registry.ts";
import type { AgentEventReportRecorder } from "./report-events.ts";

interface CliOutputRuntime {
  readonly writeStdout: (text: string) => void;
  readonly writeStderr: (text: string) => void;
}

interface StableInteractiveOutputRuntime {
  readonly writeStdout: (text: string) => void;
  readonly writeAssistantHeader: () => void;
  readonly writeStatusLine: (text: string) => void;
  readonly setActivityStatus?: (text: string | null) => void;
}

export type EndEvent = Extract<AgentEvent, { readonly type: "end" }>;

function formatMemoryOperation(operation: AgentMemoryOperation): string {
  if (operation.operation === "add") {
    return `Saved project memory ${operation.id} for ${operation.scope.id}.`;
  }
  if (operation.operation === "forget") {
    return `Forgot project memory ${operation.id} for ${operation.scope.id}.`;
  }
  if (operation.outcome === "approved") {
    return `Approved project-memory candidate ${operation.candidateId} as ${operation.memoryId} for ${operation.scope.id}.`;
  }
  if (operation.outcome === "rejected") {
    return `Rejected project-memory candidate ${operation.candidateId} for ${operation.scope.id}.`;
  }
  return `Project-memory candidate ${operation.candidateId} remains pending for ${operation.scope.id}. Review it with: keel memory candidates show ${operation.candidateId}; approve with: keel memory candidates approve ${operation.candidateId} (add --keep or --supersede <memory-id> when required).`;
}

function formatUsd(value: number): string {
  return value < 0.0001 ? value.toFixed(6) : value.toFixed(4);
}

const TOOL_LABEL_MAX_LENGTH = 160;
const STATUS_LINE_TEXT_MAX_LENGTH = 240;

// Shared escape style for model-controlled bytes: control characters become
// visible \xNN (or \n-style) escapes so the terminal never interprets them.
function escapeControlChar(char: string): string {
  switch (char) {
    case "\n":
      return "\\n";
    case "\r":
      return "\\r";
    case "\t":
      return "\\t";
    default:
      return `\\x${char.charCodeAt(0).toString(16).padStart(2, "0")}`;
  }
}

function firstCodePoint(character: string): number {
  // RegExp replacement callbacks receive the matched, non-empty character.
  return character.codePointAt(0) as number;
}

// Assistant text is model-controlled. Newlines and tabs are legitimate prose
// formatting, but every other C0/C1 control character (ESC, BEL, raw CSI/OSC
// bytes) could drive the terminal: clear the screen, move the cursor over
// earlier output, retitle the window, or write the clipboard via OSC 52.
// Escaping per code unit keeps streamed chunks safe: no sequence can
// straddle a chunk boundary once ESC and C1 bytes are neutralized.
function sanitizeAssistantText(text: string): string {
  return text.replace(
    // biome-ignore lint/suspicious/noControlCharactersInRegex: escaping control characters is the point
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g,
    escapeControlChar,
  );
}

// Labels are paths/patterns/commands, not prose, so beyond C0/C1 controls we
// also escape bidi controls and invisible directional marks (visual
// reordering, Trojan Source class; UAX #9 marks ALM/LRM/RLM included) and
// zero-width characters (invisible path segments). The length cap keeps one
// tool call to exactly one readable stderr line.
function sanitizeToolLabel(label: string): string {
  const escaped = label.replace(
    // biome-ignore lint/suspicious/noControlCharactersInRegex lint/suspicious/noMisleadingCharacterClass: escaping invisible and control characters is the point
    /[\u0000-\u001f\u007f-\u009f\u00ad\u034f\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\u3164\ufeff\uffa0\u{e0001}\u{e0020}-\u{e007f}]/gu,
    (char) => {
      const code = firstCodePoint(char);
      return code <= 0x9f
        ? escapeControlChar(char)
        : `\\u{${code.toString(16)}}`;
    },
  );
  return escaped.length <= TOOL_LABEL_MAX_LENGTH
    ? escaped
    : `${escaped.slice(0, TOOL_LABEL_MAX_LENGTH)}...`;
}

export function escapeTerminalText(text: string): string {
  return text.replace(
    // biome-ignore lint/suspicious/noControlCharactersInRegex lint/suspicious/noMisleadingCharacterClass: status lines must render untrusted invisible and control bytes visibly.
    /[\u0000-\u001f\u007f-\u009f\u00ad\u034f\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\u3164\ufeff\uffa0\u{e0001}\u{e0020}-\u{e007f}]/gu,
    (char) => {
      const code = firstCodePoint(char);
      return code <= 0x9f
        ? escapeControlChar(char)
        : `\\u{${code.toString(16)}}`;
    },
  );
}

export function sanitizeStatusLineText(text: string): string {
  const escaped = escapeTerminalText(text);
  return escaped.length <= STATUS_LINE_TEXT_MAX_LENGTH
    ? escaped
    : `${escaped.slice(0, STATUS_LINE_TEXT_MAX_LENGTH)}...`;
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

const providerRetryReasonLabels: Readonly<Record<string, string>> = {
  provider_rate_limited: "rate limited",
  provider_server_error: "server error",
  provider_network_error: "network error",
  provider_protocol_error: "stream interrupted",
  provider_http_error: "HTTP error",
  first_response_timeout: "response timeout",
  stream_inactivity_timeout: "stream inactivity timeout",
};

function providerRetryReasonLabel(reason: string): string {
  return providerRetryReasonLabels[reason] ?? "provider error";
}

function contextCompactionReasonLabel(
  reason: Extract<AgentEvent, { readonly type: "context_compacted" }>["reason"],
): string {
  switch (reason) {
    case "proactive":
      return "proactive";
    case "preflight":
      return "preflight";
    case "overflow_recovery":
      return "overflow recovery";
  }
}

function formatToolOutputCompactionCount(
  scope: "current" | "stale",
  count: number,
): string {
  const outputLabel = count === 1 ? "tool output" : "tool outputs";
  return `${scope} ${outputLabel} ${count}`;
}

function formatToolOutputCompactionDetails(
  event: ContextCompactionStats,
): string {
  if (event.toolOutputsCompacted === 0) {
    return "";
  }
  const scopeDetails = [
    ...(event.staleToolOutputsCompacted === 0
      ? []
      : [
          formatToolOutputCompactionCount(
            "stale",
            event.staleToolOutputsCompacted,
          ),
        ]),
    ...(event.currentToolOutputsCompacted === 0
      ? []
      : [
          formatToolOutputCompactionCount(
            "current",
            event.currentToolOutputsCompacted,
          ),
        ]),
  ].join(", ");
  return `, ${scopeDetails} (${event.toolOutputCharsBefore} -> ${event.toolOutputCharsAfter} chars, ~${event.toolOutputEstimatedTokensBefore} -> ~${event.toolOutputEstimatedTokensAfter} tokens)`;
}

export function formatContextCompactionReport(
  report: ContextCompactionStats & {
    readonly reasonLabel: string;
  },
): string {
  return `Context compacted: ${report.reasonLabel} (${report.beforeMessageCount} -> ${report.afterMessageCount} messages, ~${report.beforeEstimatedTokens} -> ~${report.afterEstimatedTokens} tokens${formatToolOutputCompactionDetails(report)})\n`;
}

export function formatToolOutputArtifactNotice(
  notice: ToolOutputArtifactNotice,
): string {
  if (notice.status === "stored") {
    return `Tool output artifact: ${sanitizeToolLabel(
      notice.ref,
    )} (keel artifacts show ${sanitizeToolLabel(notice.ref)})`;
  }
  return `Tool output artifact failed: ${sanitizeToolLabel(
    notice.reason,
  )}; output is lossy; rerun with narrower parameters if needed`;
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
      switch (event.type) {
        case "text":
          runtime.setActivityStatus?.("Responding");
          if (!assistantHeaderWritten) {
            runtime.writeAssistantHeader();
            assistantHeaderWritten = true;
          }
          runtime.writeStdout(sanitizeAssistantText(event.text));
          break;
        case "context_compacted":
          runtime.setActivityStatus?.("Context compacted");
          runtime.writeStatusLine(
            formatContextCompactionReport({
              ...event,
              reasonLabel: contextCompactionReasonLabel(event.reason),
            }).trimEnd(),
          );
          break;
        case "provider_retry":
          runtime.setActivityStatus?.("Waiting to retry provider");
          runtime.writeStatusLine(
            `Provider retry: ${sanitizeToolLabel(event.provider)} ${providerRetryReasonLabel(event.reason)} (attempt ${event.attempt}/${event.maxRetries} in ${Math.round(event.delayMs)}ms)`,
          );
          break;
        case "tool_start":
          runtime.setActivityStatus?.(
            `Tool: ${sanitizeToolLabel(toolCallLabel(event.toolCall))}`,
          );
          runtime.writeStatusLine(
            `Tool: ${sanitizeToolLabel(toolCallLabel(event.toolCall))}`,
          );
          break;
        case "tool_end":
          runtime.setActivityStatus?.(
            event.ok
              ? "Thinking"
              : `Tool failed: ${sanitizeToolLabel(toolCallLabel(event.toolCall))}`,
          );
          if (!event.ok) {
            runtime.writeStatusLine(
              `Tool failed: ${sanitizeToolLabel(toolCallLabel(event.toolCall))}`,
            );
          } else if (event.memoryOperation !== undefined) {
            runtime.writeStatusLine(
              formatMemoryOperation(event.memoryOperation),
            );
          }
          break;
        case "task_progress_updated":
          runtime.setActivityStatus?.("Task progress updated");
          runtime.writeStatusLine(
            `Task progress: ${sanitizeStatusLineText(formatSessionTaskProgressSummary(event.taskProgress))}`,
          );
          break;
        case "session_goal_updated": {
          const evidence = formatSessionGoalCompletionEvidenceSummary(
            event.goal,
          );
          const outcome = formatSessionGoalRuntimeOutcomeSummary(event.goal);
          runtime.writeStatusLine(
            `Session goal: ${sanitizeStatusLineText(formatSessionGoalSummary(event.goal, { includeCompletionEvidence: false }))}`,
          );
          if (outcome !== null) {
            runtime.writeStatusLine(
              `Session goal outcome: ${sanitizeStatusLineText(outcome)}`,
            );
          }
          if (evidence !== null) {
            runtime.writeStatusLine(
              `Session goal evidence: ${sanitizeStatusLineText(evidence)}`,
            );
          }
          break;
        }
        case "tool_output_artifact":
          runtime.setActivityStatus?.("Stored tool output artifact");
          runtime.writeStatusLine(formatToolOutputArtifactNotice(event));
          break;
        case "end":
          finalEnd = event;
          break;
      }
    }
  } finally {
    runtime.setActivityStatus?.(null);
  }
  return finalEnd;
}
