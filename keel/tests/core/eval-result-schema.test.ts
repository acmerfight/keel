import { describe, expect, test } from "vitest";
import { evalResultLineSchema } from "../../src/eval/result-schema.ts";

const resultBase = {
  schemaVersion: 4,
  timestamp: "2026-08-09T00:00:00.000Z",
  keelVersion: "0.0.1",
  taskId: "delegation-boundary",
  trial: 1,
  condition: "delegation_treatment",
  requiredToPass: true,
  harnessOutcome: "completed",
  taskOutcome: "verified",
  pass: true,
  wallMs: 1,
} as const;

describe("eval result schema delegation boundary", () => {
  test(`Given observed, unavailable, and contradictory external selections,
    When the result schema validates them,
    Then it accepts canonical states and rejects a derived judgment mismatch`, () => {
    // Given
    const observed = {
      ...resultBase,
      delegationSelection: {
        status: "observed",
        policy: "forbid",
        childRuns: 0,
        satisfied: true,
      },
    };
    const unavailable = {
      ...resultBase,
      delegationSelection: { status: "unavailable", policy: "require_one" },
    };
    const contradictory = {
      ...resultBase,
      delegationSelection: {
        status: "observed",
        policy: "require_one",
        childRuns: 0,
        satisfied: true,
      },
    };

    // When
    const observedResult = evalResultLineSchema.safeParse(observed);
    const unavailableResult = evalResultLineSchema.safeParse(unavailable);
    const contradictoryResult = evalResultLineSchema.safeParse(contradictory);

    // Then
    expect(observedResult.success).toBe(true);
    expect(unavailableResult.success).toBe(true);
    expect(contradictoryResult.success).toBe(false);
    if (!contradictoryResult.success) {
      expect(contradictoryResult.error.issues).toContainEqual(
        expect.objectContaining({
          path: ["delegationSelection", "satisfied"],
          message:
            "must match policy, distinct child count, and expected execution",
        }),
      );
    }
  });
});
