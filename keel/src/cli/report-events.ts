import type { ContextCompactionStats } from "../agent/context-compaction.ts";
import type { AgentEvent } from "../agent/events.ts";
import type { ToolOutputArtifactCompactionArtifact } from "../agent/tool-output-artifacts.ts";
import {
  createUndoProtectionTracker,
  type UndoProtectionSummary,
} from "../core/undo-protection.ts";
import type { SkillActivationRecord } from "../skills/model.ts";

type ContextCompactionEvent = Extract<
  AgentEvent,
  { readonly type: "context_compacted" }
>;

type ProviderRetryEvent = Extract<
  AgentEvent,
  { readonly type: "provider_retry" }
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

interface RunReportProviderRetry {
  readonly provider: string;
  readonly reason: string;
  readonly attempt: number;
  readonly maxRetries: number;
  readonly delayMs: number;
}

export type RunReportTaskTrigger =
  | "user_prompt"
  | "goal_activation"
  | "goal_resume";

export type RunReportAgentRunTrigger =
  | RunReportTaskTrigger
  | "goal_continuation";

interface RunReportAgentRun {
  readonly ordinal: number;
  readonly trigger: RunReportAgentRunTrigger;
  readonly agentLoopTurns: number;
  readonly providerRetries: readonly RunReportProviderRetry[];
  readonly contextCompactions: readonly RunReportContextCompaction[];
  readonly stopReason: string;
}

export interface RunReportTask {
  readonly ordinal: number;
  readonly trigger: RunReportTaskTrigger;
  readonly agentRuns: readonly RunReportAgentRun[];
  readonly outcome: string;
}

export interface AgentEventReportRecorder {
  readonly beginTask: (trigger: RunReportTaskTrigger) => void;
  readonly beginAgentRun: (trigger: RunReportAgentRunTrigger) => void;
  readonly record: (event: AgentEvent) => void;
  readonly completeAgentRun: (
    agentLoopTurns: number,
    stopReason: string,
  ) => void;
  readonly abortAgentRun: (agentLoopTurns: number) => void;
  readonly endTask: (outcome?: string) => void;
  readonly tasks: () => readonly RunReportTask[];
  readonly contextCompactions: () => readonly RunReportContextCompaction[];
  readonly skillActivations: () => readonly SkillActivationRecord[];
  readonly undoProtection: () => UndoProtectionSummary;
}

interface ActiveRunReportTask {
  readonly ordinal: number;
  readonly trigger: RunReportTaskTrigger;
  readonly agentRuns: RunReportAgentRun[];
}

interface ActiveRunReportAgentRun {
  readonly ordinal: number;
  readonly trigger: RunReportAgentRunTrigger;
  readonly providerRetries: RunReportProviderRetry[];
  readonly contextCompactions: RunReportContextCompaction[];
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

function runReportProviderRetry(
  event: ProviderRetryEvent,
): RunReportProviderRetry {
  const { type: _type, ...retry } = event;
  return retry;
}

export function createAgentEventReportRecorder(): AgentEventReportRecorder {
  const contextCompactions: RunReportContextCompaction[] = [];
  const skillActivations: SkillActivationRecord[] = [];
  const tasks: RunReportTask[] = [];
  const undoProtection = createUndoProtectionTracker();
  let activeTask: ActiveRunReportTask | null = null;
  let activeAgentRun: ActiveRunReportAgentRun | null = null;
  const finishAgentRun = (agentLoopTurns: number, stopReason: string): void => {
    if (activeTask === null) {
      throw new Error("internal: report Agent Run requires an active Task");
    }
    if (activeAgentRun === null) {
      throw new Error("internal: no report Agent Run is active");
    }
    activeTask.agentRuns.push({
      ordinal: activeAgentRun.ordinal,
      trigger: activeAgentRun.trigger,
      agentLoopTurns,
      providerRetries: [...activeAgentRun.providerRetries],
      contextCompactions: [...activeAgentRun.contextCompactions],
      stopReason,
    });
    activeAgentRun = null;
  };
  return {
    beginTask: (trigger) => {
      if (activeTask !== null) {
        throw new Error("internal: report Task already active");
      }
      activeTask = {
        ordinal: tasks.length + 1,
        trigger,
        agentRuns: [],
      };
    },
    beginAgentRun: (trigger) => {
      if (activeTask === null) {
        throw new Error("internal: report Agent Run requires an active Task");
      }
      if (activeAgentRun !== null) {
        throw new Error("internal: report Agent Run already active");
      }
      activeAgentRun = {
        ordinal: activeTask.agentRuns.length + 1,
        trigger,
        providerRetries: [],
        contextCompactions: [],
      };
    },
    record: (event) => {
      if (event.type === "context_compacted") {
        const compaction = runReportContextCompaction(event);
        contextCompactions.push(compaction);
        activeAgentRun?.contextCompactions.push(compaction);
      }
      if (event.type === "provider_retry") {
        activeAgentRun?.providerRetries.push(runReportProviderRetry(event));
      }
      if (event.type === "skill_activated") {
        const { type: _type, ...activation } = event;
        skillActivations.push(activation);
      }
      if (event.type === "undo_checkpoint") {
        undoProtection.record(event);
      }
    },
    completeAgentRun: (agentLoopTurns, stopReason) => {
      finishAgentRun(agentLoopTurns, stopReason);
    },
    abortAgentRun: (agentLoopTurns) => {
      finishAgentRun(agentLoopTurns, "aborted");
    },
    endTask: (outcome) => {
      if (activeTask === null) {
        throw new Error("internal: no report Task is active");
      }
      if (activeAgentRun !== null) {
        throw new Error("internal: cannot end Task with an active Agent Run");
      }
      const finalRun = activeTask.agentRuns.at(-1);
      if (finalRun === undefined) {
        throw new Error("internal: report Task requires an Agent Run");
      }
      tasks.push({
        ordinal: activeTask.ordinal,
        trigger: activeTask.trigger,
        agentRuns: [...activeTask.agentRuns],
        outcome: outcome ?? finalRun.stopReason,
      });
      activeTask = null;
    },
    tasks: () =>
      tasks.map((task) => ({
        ...task,
        agentRuns: task.agentRuns.map((agentRun) => ({
          ...agentRun,
          providerRetries: [...agentRun.providerRetries],
          contextCompactions: [...agentRun.contextCompactions],
        })),
      })),
    contextCompactions: () => [...contextCompactions],
    skillActivations: () => [...skillActivations],
    undoProtection: undoProtection.summary,
  };
}

export async function* recordAgentEventStream(
  stream: AsyncIterable<AgentEvent>,
  recorder: AgentEventReportRecorder,
): AsyncGenerator<AgentEvent> {
  for await (const event of stream) {
    recorder.record(event);
    yield event;
  }
}
