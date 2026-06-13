import type { ToolCall } from "../llm/types.ts";
import type { CostReport } from "./loop.ts";

const DEFAULT_MAX_AGENT_TURNS = 64;
const DEFAULT_REPEATED_TOOL_CALL_STOP_THRESHOLD = 3;

interface StopContext {
  readonly completedTurns: number;
  readonly toolCalls: readonly ToolCall[];
  readonly priorToolCalls: readonly ToolCall[];
  readonly cost?: CostReport;
}

type StopDecision =
  | { readonly type: "continue" }
  | { readonly type: "stop" }
  | { readonly type: "summarize" };

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
        ? { type: "stop" }
        : { type: "continue" },
  };
}

function toolCallKey(toolCall: ToolCall): string {
  const { id: _id, ...args } = toolCall;
  return JSON.stringify(args, Object.keys(args).sort());
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
      let streak = 0;
      for (let index = calls.length - 1; index >= 0; index--) {
        const call = calls.at(index);
        if (call === undefined || toolCallKey(call) !== latestKey) {
          break;
        }
        streak++;
        if (streak >= stopThreshold) {
          return { type: "stop" };
        }
      }
      return { type: "continue" };
    },
  };
}

export function maxTurnFallbackPolicy(maxTurns: number): AgentStopPolicy {
  return {
    shouldStopAfterTurn: (context) =>
      context.toolCalls.length > 0 && context.completedTurns >= maxTurns
        ? { type: "summarize" }
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
