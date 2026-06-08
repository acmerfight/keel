import { describe, expect, test } from "vitest";
import { type CostModel, calculateCostUsd } from "../../src/core/cost.ts";

describe("Cost Tracking", () => {
  test(`Given usage includes cached input, uncached input, and output tokens,
    When the cost model prices that usage,
    Then it returns the exact dollar cost`, () => {
    // Given
    const model: CostModel = {
      uncachedInputPerMillionTokens: 0.14,
      cachedInputPerMillionTokens: 0.0028,
      outputPerMillionTokens: 0.28,
    };

    // When
    const cost = calculateCostUsd(
      {
        inputTokens: 3_000_000,
        cachedInputTokens: 2_000_000,
        uncachedInputTokens: 1_000_000,
        outputTokens: 4_000_000,
      },
      model,
    );

    // Then
    expect(cost).toBeCloseTo(1.2656);
  });
});
