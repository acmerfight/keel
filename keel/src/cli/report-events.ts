import type { ContextCompactionStats } from "../agent/context-compaction.ts";
import type { AgentEvent } from "../agent/events.ts";
import type { ToolOutputArtifactCompactionArtifact } from "../agent/tool-output-artifacts.ts";
import type { SkillActivationRecord } from "../skills/model.ts";

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
  readonly skillActivations: () => readonly SkillActivationRecord[];
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

function contextCompactionStats(
  event: ContextCompactionEvent,
): ContextCompactionStats {
  const {
    type: _type,
    reason: _reason,
    historyCompacted: _historyCompacted,
    artifacts: _artifacts,
    ...stats
  } = event;
  return stats;
}

function runReportContextCompaction(
  event: ContextCompactionEvent,
): RunReportContextCompaction {
  return {
    ...contextCompactionStats(event),
    reason: event.reason,
    providerRequestAction: providerRequestAction(event.reason),
    scopes: contextCompactionScopes(event),
    artifacts: event.artifacts,
  };
}

export function createAgentEventReportRecorder(): AgentEventReportRecorder {
  const contextCompactions: RunReportContextCompaction[] = [];
  const skillActivations: SkillActivationRecord[] = [];
  return {
    record: (event) => {
      if (event.type === "context_compacted") {
        contextCompactions.push(runReportContextCompaction(event));
      }
      if (event.type === "skill_activated") {
        const { type: _type, ...activation } = event;
        skillActivations.push(activation);
      }
    },
    contextCompactions: () => [...contextCompactions],
    skillActivations: () => [...skillActivations],
  };
}
