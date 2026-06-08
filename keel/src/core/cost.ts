import type { Usage } from "../llm/types.ts";

export interface CostModel {
  readonly uncachedInputPerMillionTokens: number;
  readonly cachedInputPerMillionTokens: number;
  readonly outputPerMillionTokens: number;
}

export function calculateCostUsd(usage: Usage, model: CostModel): number {
  return (
    (usage.uncachedInputTokens / 1_000_000) *
      model.uncachedInputPerMillionTokens +
    (usage.cachedInputTokens / 1_000_000) * model.cachedInputPerMillionTokens +
    (usage.outputTokens / 1_000_000) * model.outputPerMillionTokens
  );
}
