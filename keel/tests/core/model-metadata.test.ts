import { describe, expect, test } from "vitest";
import { ZERO_COST_MODEL } from "../../src/core/cost.ts";
import {
  modelCostModel,
  modelMetadata,
} from "../../src/core/model-metadata.ts";

describe("Model Metadata", () => {
  test(`Given Qwen cost tracking is requested,
    When the configured model is selected,
    Then known fixed and tiered models return registry cost models`, () => {
    // Given / When / Then
    expect(modelCostModel("qwen", "qwen3.7-max")).toMatchObject({
      type: "fixed",
      uncachedInputPerMillionTokens: 2.5,
      cachedInputPerMillionTokens: 0.25,
      outputPerMillionTokens: 7.5,
    });
    expect(modelCostModel("qwen", "qwen3.7-plus")).toEqual({
      type: "input-token-tiers",
      tiers: [
        {
          startsAboveInputTokens: 0,
          uncachedInputPerMillionTokens: 0.4,
          cachedInputPerMillionTokens: 0.08,
          outputPerMillionTokens: 1.6,
        },
        {
          startsAboveInputTokens: 256_000,
          uncachedInputPerMillionTokens: 1.2,
          cachedInputPerMillionTokens: 0.24,
          outputPerMillionTokens: 4.8,
        },
      ],
    });
    expect(modelCostModel("qwen", "qwen3.6-flash")).toEqual({
      type: "input-token-tiers",
      tiers: [
        {
          startsAboveInputTokens: 0,
          uncachedInputPerMillionTokens: 0.25,
          cachedInputPerMillionTokens: 0.05,
          outputPerMillionTokens: 1.5,
        },
        {
          startsAboveInputTokens: 256_000,
          uncachedInputPerMillionTokens: 1,
          cachedInputPerMillionTokens: 0.2,
          outputPerMillionTokens: 4,
        },
      ],
    });
    expect(modelCostModel("qwen", "qwen3.6-flash-2026-04-16")).toEqual(
      modelCostModel("qwen", "qwen3.6-flash"),
    );
    expect(modelCostModel("qwen", "qwen-unknown")).toBeNull();
  });

  test(`Given fake provider metadata is requested,
    When the registry entry is returned,
    Then it uses the shared zero cost model`, () => {
    // Given / When
    const metadata = modelMetadata("fake", "fake");

    // Then
    expect(metadata).toMatchObject({
      status: "known",
      costModel: ZERO_COST_MODEL,
    });
  });
});
