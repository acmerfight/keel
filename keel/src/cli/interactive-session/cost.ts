import type { CostReport } from "../../agent/events.ts";
import type { Usage } from "../../llm/types.ts";
import type { InteractiveSessionArgs } from "./types.ts";

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
  return {
    spentUsd,
    ...(maxCostUsd !== undefined ? { maxUsd: maxCostUsd } : {}),
    budgetLimited: maxCostUsd !== undefined && spentUsd >= maxCostUsd,
    overshootUsd:
      maxCostUsd === undefined ? 0 : Math.max(0, spentUsd - maxCostUsd),
  };
}

export function buildSessionCostBudgetLimitedReport(
  spentUsd: number,
  maxCostUsd: number,
): CostReport {
  return {
    spentUsd,
    maxUsd: maxCostUsd,
    budgetLimited: true,
    overshootUsd: Math.max(0, spentUsd - maxCostUsd),
  };
}
