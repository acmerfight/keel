import type { ContextCompactionStats } from "../agent/context-compaction.ts";
import type { AgentEvent } from "../agent/events.ts";
import type { ToolOutputArtifactCompactionArtifact } from "../agent/tool-output-artifacts.ts";

type ContextCompactionEvent = Extract<
  AgentEvent,
  { readonly type: "context_compacted" }
>;

type RunReportContextCompactionReason = ContextCompactionEvent["reason"];

type RunReportContextCompactionScope =
  | "history"
  | "stale_tool_output"
  | "current_tool_output_round";

type RunReportProviderRequestAction =
  | "compacted_before_request"
  | "avoided_predictable_overflow_request"
  | "retried_after_context_overflow";

export interface RunReportContextCompaction extends ContextCompactionStats {
  readonly reason: RunReportContextCompactionReason;
  readonly providerRequestAction: RunReportProviderRequestAction;
  readonly scopes: readonly RunReportContextCompactionScope[];
  readonly artifacts: readonly ToolOutputArtifactCompactionArtifact[];
}

export interface AgentEventReportRecorder {
  readonly record: (event: AgentEvent) => void;
  readonly contextCompactions: () => readonly RunReportContextCompaction[];
}

function providerRequestAction(
  reason: RunReportContextCompactionReason,
): RunReportProviderRequestAction {
  switch (reason) {
    case "proactive":
      return "compacted_before_request";
    case "preflight":
      return "avoided_predictable_overflow_request";
    case "overflow_recovery":
      return "retried_after_context_overflow";
  }
}

function contextCompactionScopes(
  event: ContextCompactionEvent,
): readonly RunReportContextCompactionScope[] {
  const scopes: RunReportContextCompactionScope[] = [];
  if (event.historyCompacted) {
    scopes.push("history");
  }
  if (event.staleToolOutputsCompacted > 0) {
    scopes.push("stale_tool_output");
  }
  if (event.currentToolOutputsCompacted > 0) {
    scopes.push("current_tool_output_round");
  }
  return scopes;
}

function runReportContextCompaction(
  event: ContextCompactionEvent,
): RunReportContextCompaction {
  return {
    reason: event.reason,
    providerRequestAction: providerRequestAction(event.reason),
    scopes: contextCompactionScopes(event),
    artifacts: event.artifacts,
    beforeMessageCount: event.beforeMessageCount,
    afterMessageCount: event.afterMessageCount,
    beforeEstimatedTokens: event.beforeEstimatedTokens,
    afterEstimatedTokens: event.afterEstimatedTokens,
    toolOutputsCompacted: event.toolOutputsCompacted,
    staleToolOutputsCompacted: event.staleToolOutputsCompacted,
    currentToolOutputsCompacted: event.currentToolOutputsCompacted,
    toolOutputCharsBefore: event.toolOutputCharsBefore,
    toolOutputCharsAfter: event.toolOutputCharsAfter,
    toolOutputEstimatedTokensBefore: event.toolOutputEstimatedTokensBefore,
    toolOutputEstimatedTokensAfter: event.toolOutputEstimatedTokensAfter,
  };
}

export function createAgentEventReportRecorder(): AgentEventReportRecorder {
  const contextCompactions: RunReportContextCompaction[] = [];
  return {
    record: (event) => {
      if (event.type === "context_compacted") {
        contextCompactions.push(runReportContextCompaction(event));
      }
    },
    contextCompactions: () => [...contextCompactions],
  };
}
