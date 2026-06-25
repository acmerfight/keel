import type { Usage } from "../llm/types.ts";

interface CostRates {
  readonly uncachedInputPerMillionTokens: number;
  readonly cachedInputPerMillionTokens: number;
  readonly outputPerMillionTokens: number;
}

interface FixedCostModel extends CostRates {
  readonly type: "fixed";
}

interface InputTokenCostTier extends CostRates {
  readonly startsAboveInputTokens: number;
}

interface InputTokenTieredCostModel {
  readonly type: "input-token-tiers";
  readonly tiers: readonly [InputTokenCostTier, ...InputTokenCostTier[]];
}

export type CostModel = FixedCostModel | InputTokenTieredCostModel;

export const ZERO_COST_MODEL: CostModel = {
  type: "fixed",
  uncachedInputPerMillionTokens: 0,
  cachedInputPerMillionTokens: 0,
  outputPerMillionTokens: 0,
};

interface RequestCostInput {
  readonly usage: Usage;
}

export interface RequestCostBatch {
  readonly requests: readonly [RequestCostInput, ...RequestCostInput[]];
}

function costRatesForRequest(
  request: RequestCostInput,
  model: CostModel,
): CostRates {
  if (model.type === "fixed") {
    return model;
  }

  let selectedTier = model.tiers.reduce((lowestTier, tier) =>
    tier.startsAboveInputTokens < lowestTier.startsAboveInputTokens
      ? tier
      : lowestTier,
  );
  for (const tier of model.tiers) {
    if (
      request.usage.inputTokens > tier.startsAboveInputTokens &&
      tier.startsAboveInputTokens > selectedTier.startsAboveInputTokens
    ) {
      selectedTier = tier;
    }
  }
  return selectedTier;
}

function calculateRequestCostUsd(
  request: RequestCostInput,
  model: CostModel,
): number {
  const rates = costRatesForRequest(request, model);
  const { usage } = request;
  return (
    (usage.uncachedInputTokens / 1_000_000) *
      rates.uncachedInputPerMillionTokens +
    (usage.cachedInputTokens / 1_000_000) * rates.cachedInputPerMillionTokens +
    (usage.outputTokens / 1_000_000) * rates.outputPerMillionTokens
  );
}

export function calculateRequestCostBatchUsd(
  batch: RequestCostBatch,
  model: CostModel,
): number {
  return batch.requests.reduce(
    (total, request) => total + calculateRequestCostUsd(request, model),
    0,
  );
}
