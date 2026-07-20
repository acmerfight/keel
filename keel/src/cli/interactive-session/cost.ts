import type { CostReport } from "../../agent/events.ts";
import type { CostModel } from "../../core/cost.ts";
import type { Usage } from "../../llm/types.ts";
import type { InteractiveSessionArgs } from "./types.ts";

export type InteractiveCompactionCost =
  | {
      readonly kind: "untracked";
    }
  | {
      readonly kind: "tracked";
      readonly model: CostModel;
    }
  | {
      readonly kind: "budgeted";
      readonly model: CostModel;
      readonly maxCostUsd: number;
      readonly remainingCostUsd: number;
      readonly budgetLimitedReport: () => CostReport;
    };

export const EMPTY_USAGE: Usage = {
  inputTokens: 0,
  cachedInputTokens: 0,
  uncachedInputTokens: 0,
  outputTokens: 0,
};

export function addUsage(left: Usage, right: Usage): Usage {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
    uncachedInputTokens: left.uncachedInputTokens + right.uncachedInputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
  };
}

export function shouldTrackInteractiveCost(
  args: InteractiveSessionArgs,
): boolean {
  return args.maxCostUsd !== undefined || args.reportFile !== undefined;
}

export function buildSessionCostReport(
  spentUsd: number,
  maxCostUsd: number | undefined,
): CostReport {
  if (maxCostUsd === undefined) {
    return {
      spentUsd,
      budget: { kind: "unbounded" },
    };
  }
  if (spentUsd >= maxCostUsd) {
    return {
      spentUsd,
      budget: {
        kind: "budget_limited",
        maxUsd: maxCostUsd,
        overshootUsd: Math.max(0, spentUsd - maxCostUsd),
      },
    };
  }
  return {
    spentUsd,
    budget: { kind: "within_budget", maxUsd: maxCostUsd },
  };
}

export function buildSessionCostBudgetLimitedReport(
  spentUsd: number,
  maxCostUsd: number,
): CostReport {
  return {
    spentUsd,
    budget: {
      kind: "budget_limited",
      maxUsd: maxCostUsd,
      overshootUsd: Math.max(0, spentUsd - maxCostUsd),
    },
  };
}
