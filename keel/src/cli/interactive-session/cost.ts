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
    budgetExceeded: maxCostUsd !== undefined && spentUsd > maxCostUsd,
  };
}
