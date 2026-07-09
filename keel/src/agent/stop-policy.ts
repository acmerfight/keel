import type { ToolCall } from "../llm/types.ts";
import type { CostReport } from "./events.ts";

const DEFAULT_MAX_AGENT_TURNS = 64;
const DEFAULT_REPEATED_TOOL_CALL_STOP_THRESHOLD = 3;

interface StopContext {
  readonly completedTurns: number;
  readonly toolCalls: readonly ToolCall[];
  readonly priorToolCalls: readonly ToolCall[];
  readonly cost?: CostReport;
}

// reason is a stable label surfaced as the run's stopReason in reports.
// Built-in policies use "cost_budget", "repeated_tool_call", "turn_limit".
type StopDecision =
  | { readonly type: "continue" }
  | { readonly type: "stop"; readonly reason: string }
  | { readonly type: "summarize"; readonly reason: string };

export interface AgentStopPolicy {
  readonly shouldStopAfterTurn: (context: StopContext) => StopDecision;
}

export function composeStopPolicies(
  policies: readonly AgentStopPolicy[],
): AgentStopPolicy {
  return {
    shouldStopAfterTurn: (context) => {
      for (const policy of policies) {
        const decision = policy.shouldStopAfterTurn(context);
        if (decision.type !== "continue") {
          return decision;
        }
      }
      return { type: "continue" };
    },
  };
}

export function costBudgetStopPolicy(): AgentStopPolicy {
  return {
    shouldStopAfterTurn: (context) =>
      context.cost?.budgetExceeded === true
        ? { type: "stop", reason: "cost_budget" }
        : { type: "continue" },
  };
}

function toolCallKey(toolCall: ToolCall): string {
  const { id: _id, ...args } = toolCall;
  return JSON.stringify(args, Object.keys(args).sort());
}

function isBlockedGoalProposal(toolCall: ToolCall): boolean {
  return (
    toolCall.tool === "update_goal" &&
    "status" in toolCall &&
    toolCall.status === "blocked"
  );
}

export function repeatedToolCallPolicy(
  stopThreshold = DEFAULT_REPEATED_TOOL_CALL_STOP_THRESHOLD,
): AgentStopPolicy {
  return {
    shouldStopAfterTurn: (context) => {
      const calls = [...context.priorToolCalls, ...context.toolCalls];
      const latest = calls.at(-1);
      if (latest === undefined) {
        return { type: "continue" };
      }

      const latestKey = toolCallKey(latest);
      const effectiveStopThreshold = isBlockedGoalProposal(latest)
        ? stopThreshold + 1
        : stopThreshold;
      let streak = 0;
      for (let index = calls.length - 1; index >= 0; index--) {
        const call = calls.at(index);
        if (call === undefined || toolCallKey(call) !== latestKey) {
          break;
        }
        streak++;
        if (streak >= effectiveStopThreshold) {
          return { type: "stop", reason: "repeated_tool_call" };
        }
      }
      return { type: "continue" };
    },
  };
}

// maxTurns counts model turns, not executed tool rounds: the turn at the cap
// may still answer in plain text, but if it requests tools those are not
// executed — the run is converted into a wrap-up summary instead. So at most
// maxTurns - 1 tool rounds execute, plus one final summary turn.
export function maxTurnFallbackPolicy(maxTurns: number): AgentStopPolicy {
  return {
    shouldStopAfterTurn: (context) =>
      context.toolCalls.length > 0 && context.completedTurns >= maxTurns
        ? { type: "summarize", reason: "turn_limit" }
        : { type: "continue" },
  };
}

export function defaultStopPolicy(): AgentStopPolicy {
  return composeStopPolicies([
    costBudgetStopPolicy(),
    repeatedToolCallPolicy(),
    maxTurnFallbackPolicy(DEFAULT_MAX_AGENT_TURNS),
  ]);
}
