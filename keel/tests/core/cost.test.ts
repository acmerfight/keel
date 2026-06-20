import { describe, expect, test } from "vitest";
import {
  type CostModel,
  calculateRequestCostBatchUsd,
} from "../../src/core/cost.ts";

describe("Cost Tracking", () => {
  test(`Given usage includes cached input, uncached input, and output tokens,
    When the cost model prices that usage,
    Then it returns the exact dollar cost`, () => {
    // Given
    const model: CostModel = {
      type: "fixed",
      uncachedInputPerMillionTokens: 0.14,
      cachedInputPerMillionTokens: 0.0028,
      outputPerMillionTokens: 0.28,
    };

    // When
    const cost = calculateRequestCostBatchUsd(
      {
        requests: [
          {
            usage: {
              inputTokens: 3_000_000,
              cachedInputTokens: 2_000_000,
              uncachedInputTokens: 1_000_000,
              outputTokens: 4_000_000,
            },
          },
        ],
      },
      model,
    );

    // Then
    expect(cost).toBeCloseTo(1.2656);
  });

  test(`Given per-request input-token tiers are declared out of order,
    When usage stays below the higher request tier,
    Then it prices the request with the lowest matching tier`, () => {
    // Given
    const model: CostModel = {
      type: "input-token-tiers",
      tiers: [
        {
          startsAboveInputTokens: 256_000,
          uncachedInputPerMillionTokens: 1.2,
          cachedInputPerMillionTokens: 0.12,
          outputPerMillionTokens: 4.8,
        },
        {
          startsAboveInputTokens: 0,
          uncachedInputPerMillionTokens: 0.4,
          cachedInputPerMillionTokens: 0.04,
          outputPerMillionTokens: 1.6,
        },
      ],
    };

    // When
    const cost = calculateRequestCostBatchUsd(
      {
        requests: [
          {
            usage: {
              inputTokens: 100_000,
              cachedInputTokens: 0,
              uncachedInputTokens: 100_000,
              outputTokens: 0,
            },
          },
        ],
      },
      model,
    );

    // Then
    expect(cost).toBeCloseTo(0.04);
  });

  test(`Given per-request input-token tiers are declared out of order,
    When usage crosses the higher request tier,
    Then it prices the request with the highest matching tier`, () => {
    // Given
    const model: CostModel = {
      type: "input-token-tiers",
      tiers: [
        {
          startsAboveInputTokens: 256_000,
          uncachedInputPerMillionTokens: 1.2,
          cachedInputPerMillionTokens: 0.12,
          outputPerMillionTokens: 4.8,
        },
        {
          startsAboveInputTokens: 0,
          uncachedInputPerMillionTokens: 0.4,
          cachedInputPerMillionTokens: 0.04,
          outputPerMillionTokens: 1.6,
        },
      ],
    };

    // When
    const cost = calculateRequestCostBatchUsd(
      {
        requests: [
          {
            usage: {
              inputTokens: 300_000,
              cachedInputTokens: 0,
              uncachedInputTokens: 300_000,
              outputTokens: 0,
            },
          },
        ],
      },
      model,
    );

    // Then
    expect(cost).toBeCloseTo(0.36);
  });

  test(`Given a model with per-request input-token tiers,
    When usage crosses a higher request tier,
    Then it prices cached input, uncached input, and output with that tier`, () => {
    // Given
    const model: CostModel = {
      type: "input-token-tiers",
      tiers: [
        {
          startsAboveInputTokens: 0,
          uncachedInputPerMillionTokens: 0.4,
          cachedInputPerMillionTokens: 0.04,
          outputPerMillionTokens: 1.6,
        },
        {
          startsAboveInputTokens: 256_000,
          uncachedInputPerMillionTokens: 1.2,
          cachedInputPerMillionTokens: 0.12,
          outputPerMillionTokens: 4.8,
        },
      ],
    };

    // When
    const cost = calculateRequestCostBatchUsd(
      {
        requests: [
          {
            usage: {
              inputTokens: 300_000,
              cachedInputTokens: 100_000,
              uncachedInputTokens: 200_000,
              outputTokens: 100_000,
            },
          },
        ],
      },
      model,
    );

    // Then
    expect(cost).toBeCloseTo(0.732);
  });
});
