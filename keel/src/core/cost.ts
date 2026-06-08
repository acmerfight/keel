import type { Usage } from "../llm/types.ts";

export interface CostModel {
  readonly uncachedInputPerMillionTokens: number;
  readonly cachedInputPerMillionTokens: number;
  readonly outputPerMillionTokens: number;
}

// DeepSeek V4 Flash prices are per 1M tokens.
export const DEEPSEEK_V4_FLASH_USD: CostModel = {
  uncachedInputPerMillionTokens: 0.14,
  cachedInputPerMillionTokens: 0.028,
  outputPerMillionTokens: 0.28,
};

export function calculateCostUsd(usage: Usage, model: CostModel): number {
  return (
    (usage.uncachedInputTokens / 1_000_000) *
      model.uncachedInputPerMillionTokens +
    (usage.cachedInputTokens / 1_000_000) * model.cachedInputPerMillionTokens +
    (usage.outputTokens / 1_000_000) * model.outputPerMillionTokens
  );
}
