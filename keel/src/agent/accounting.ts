import { type CostModel, calculateRequestCostBatchUsd } from "../core/cost.ts";
import type { Usage } from "../llm/types.ts";
import type { CostReport } from "./events.ts";

export interface CostTrackingOptions {
  readonly model: CostModel;
  readonly maxCostUsd?: number;
  readonly modelMaxOutputTokens?: number;
}

export interface RunAccounting {
  readonly totalUsage: Usage;
  readonly totalCostUsd: number;
}

function addUsage(left: Usage, right: Usage): Usage {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
    uncachedInputTokens: left.uncachedInputTokens + right.uncachedInputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
  };
}

export function emptyRunAccounting(): RunAccounting {
  return {
    totalUsage: {
      inputTokens: 0,
      cachedInputTokens: 0,
      uncachedInputTokens: 0,
      outputTokens: 0,
    },
    totalCostUsd: 0,
  };
}

export function addRequestAccounting(
  accounting: RunAccounting,
  requestUsage: Usage,
  costTracking: CostTrackingOptions | undefined,
): RunAccounting {
  return {
    totalUsage: addUsage(accounting.totalUsage, requestUsage),
    totalCostUsd:
      costTracking === undefined
        ? accounting.totalCostUsd
        : accounting.totalCostUsd +
          calculateRequestCostBatchUsd(
            { requests: [{ usage: requestUsage }] },
            costTracking.model,
          ),
  };
}

export function buildCostReport(
  spentUsd: number,
  costTracking: CostTrackingOptions | undefined,
): CostReport | undefined {
  if (costTracking === undefined) {
    return undefined;
  }
  const budgetLimited =
    costTracking.maxCostUsd !== undefined &&
    spentUsd >= costTracking.maxCostUsd;
  return {
    spentUsd,
    ...(costTracking.maxCostUsd !== undefined
      ? { maxUsd: costTracking.maxCostUsd }
      : {}),
    budgetLimited,
    overshootUsd:
      costTracking.maxCostUsd === undefined
        ? 0
        : Math.max(0, spentUsd - costTracking.maxCostUsd),
  };
}

export function buildCostBudgetLimitedReport(
  spentUsd: number,
  costTracking: CostTrackingOptions & { readonly maxCostUsd: number },
): CostReport {
  return {
    spentUsd,
    maxUsd: costTracking.maxCostUsd,
    budgetLimited: true,
    overshootUsd: Math.max(0, spentUsd - costTracking.maxCostUsd),
  };
}
