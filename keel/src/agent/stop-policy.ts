import { KeelError } from "../core/error.ts";
import type { CostReport } from "./loop.ts";

const DEFAULT_MAX_AGENT_TURNS = 16;

interface StopContext {
  readonly completedTurns: number;
  readonly hasPendingToolCalls: boolean;
  readonly cost?: CostReport;
}

type StopDecision =
  | { readonly type: "continue" }
  | { readonly type: "stop" }
  | { readonly type: "fail"; readonly error: KeelError };

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

export function maxTurnFallbackPolicy(maxTurns: number): AgentStopPolicy {
  return {
    shouldStopAfterTurn: (context) =>
      context.hasPendingToolCalls && context.completedTurns >= maxTurns
        ? {
            type: "fail",
            error: new KeelError(
              "agent_tool_call_limit_exceeded",
              "Agent exceeded tool call limit",
            ),
          }
        : { type: "continue" },
  };
}

export function defaultStopPolicy(): AgentStopPolicy {
  return composeStopPolicies([
    costBudgetStopPolicy(),
    maxTurnFallbackPolicy(DEFAULT_MAX_AGENT_TURNS),
  ]);
}
