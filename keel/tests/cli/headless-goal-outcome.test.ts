import { describe, expect, test } from "vitest";
import {
  assessHeadlessGoalOutcome,
  headlessGoalRunReportOutcome,
  headlessGoalRunReportStopReason,
} from "../../src/cli/headless-goal-outcome.ts";
import type { SessionGoal } from "../../src/core/session-goal.ts";

const accounting = {
  budget: {},
  usage: { turns: 0, tokens: 0, activeTimeMs: 0 },
};

function unfinishedGoal(status: "active" | "paused"): SessionGoal {
  return {
    objective: "Keep working",
    status,
    ...accounting,
  };
}

describe("CLI Headless Goal Outcome", () => {
  test(`Given headless execution ends before a saved session exists,
    When the completion boundary is assessed,
    Then the internal failure is explicit`, () => {
    // Given / When
    const assessment = assessHeadlessGoalOutcome(undefined, undefined);

    // Then
    expect(assessment).toEqual({
      kind: "rejected",
      error: "Error: headless Goal ended without an active saved session.",
    });
  });

  test(`Given a saved headless session ends without durable Goal state,
    When the completion boundary is assessed,
    Then the session-specific failure is terminal-safe`, () => {
    // Given / When
    const assessment = assessHeadlessGoalOutcome(
      "unsafe\u001b-session",
      undefined,
    );

    // Then
    expect(assessment).toEqual({
      kind: "rejected",
      error:
        "Error: headless Goal session unsafe\\x1b-session ended without durable Goal state.",
    });
  });

  test.each(["active", "paused"] as const)(
    `Given a saved headless Goal ends while %s,
    When the completion boundary is assessed,
    Then the nonterminal state is rejected`,
    (status) => {
      // Given / When
      const assessment = assessHeadlessGoalOutcome(
        "unfinished",
        unfinishedGoal(status),
      );

      // Then
      expect(assessment).toEqual({
        kind: "rejected",
        error: `Error: headless Goal ended while session unfinished was still ${status}.`,
      });
    },
  );

  test(`Given a completed Goal lacks its durable completion outcome,
    When the headless completion boundary is assessed,
    Then the invalid current state is rejected`, () => {
    // Given / When
    const assessment = assessHeadlessGoalOutcome("goal-1", {
      objective: "Finish",
      status: "completed",
      ...accounting,
      completionEvidence: { kind: "user_override" },
    });

    // Then
    expect(assessment).toEqual({
      kind: "rejected",
      error:
        "Error: headless Goal session goal-1 completed without a durable completion outcome.",
    });
  });

  test(`Given a completed Goal carries a non-completion runtime outcome,
    When the headless completion boundary is assessed,
    Then the mismatched current state is rejected`, () => {
    // Given / When
    const assessment = assessHeadlessGoalOutcome("goal-2", {
      objective: "Finish",
      status: "completed",
      ...accounting,
      completionEvidence: { kind: "user_override" },
      latestRuntimeOutcome: {
        kind: "progress_observed",
        reason: "Progress was observed before completion.",
      },
    });

    // Then
    expect(assessment).toEqual({
      kind: "rejected",
      error:
        "Error: headless Goal session goal-2 completed without a durable completion outcome.",
    });
  });

  test(`Given a completed Goal carries its durable completion outcome,
    When its headless report outcome is projected,
    Then the authoritative completion reason is preserved`, () => {
    // Given
    const assessment = assessHeadlessGoalOutcome("completed", {
      objective: "Finish",
      status: "completed",
      ...accounting,
      completionEvidence: { kind: "user_override" },
      latestRuntimeOutcome: {
        kind: "completed",
        reason: "The runtime verified completion.",
      },
    });
    if (assessment.kind === "rejected") {
      throw new Error(assessment.error);
    }

    // When
    const reportOutcome = headlessGoalRunReportOutcome(assessment.outcome);
    const stopReason = headlessGoalRunReportStopReason(assessment.outcome);

    // Then
    expect(reportOutcome).toEqual({
      sessionId: "completed",
      status: "completed",
      reason: "The runtime verified completion.",
      evidenceKind: "user_override",
    });
    expect(stopReason).toBeUndefined();
  });
});
