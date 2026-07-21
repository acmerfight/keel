import { describe, expect, test } from "vitest";
import {
  headlessGoalRunReportOutcome,
  headlessGoalRunReportStopReason,
  requireHeadlessGoalOutcome,
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

function expectHeadlessGoalError(
  requireOutcome: () => unknown,
  message: string,
): void {
  let failure: unknown;
  try {
    requireOutcome();
  } catch (error) {
    failure = error;
  }
  expect(failure).toMatchObject({
    name: "KeelError",
    code: "goal_terminal_outcome_invalid",
    message,
  });
}

describe("CLI Headless Goal Outcome", () => {
  test(`Given headless execution ends before a saved session exists,
    When the completion boundary is assessed,
    Then the internal failure is explicit`, () => {
    // Given / When
    const requireOutcome = () =>
      requireHeadlessGoalOutcome(undefined, undefined);

    // Then
    expectHeadlessGoalError(
      requireOutcome,
      "Error: headless Goal ended without an active saved session.",
    );
  });

  test(`Given a saved headless session ends without durable Goal state,
    When the completion boundary is assessed,
    Then the session-specific failure is terminal-safe`, () => {
    // Given / When
    const requireOutcome = () =>
      requireHeadlessGoalOutcome("unsafe\u001b-session", undefined);

    // Then
    expectHeadlessGoalError(
      requireOutcome,
      "Error: headless Goal session unsafe\\x1b-session ended without durable Goal state.",
    );
  });

  test.each(["active", "paused"] as const)(
    `Given a saved headless Goal ends while %s,
    When the completion boundary is assessed,
    Then the nonterminal state is rejected`,
    (status) => {
      // Given / When
      const requireOutcome = () =>
        requireHeadlessGoalOutcome("unfinished", unfinishedGoal(status));

      // Then
      expectHeadlessGoalError(
        requireOutcome,
        `Error: headless Goal ended while session unfinished was still ${status}.`,
      );
    },
  );

  test(`Given a completed Goal lacks its durable completion outcome,
    When the headless completion boundary is assessed,
    Then the invalid current state is rejected`, () => {
    // Given / When
    const requireOutcome = () =>
      requireHeadlessGoalOutcome("goal-1", {
        objective: "Finish",
        status: "completed",
        ...accounting,
        completionEvidence: { kind: "user_override" },
      });

    // Then
    expectHeadlessGoalError(
      requireOutcome,
      "Error: headless Goal session goal-1 completed without a durable completion outcome.",
    );
  });

  test(`Given a completed Goal carries a non-completion runtime outcome,
    When the headless completion boundary is assessed,
    Then the mismatched current state is rejected`, () => {
    // Given / When
    const requireOutcome = () =>
      requireHeadlessGoalOutcome("goal-2", {
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
    expectHeadlessGoalError(
      requireOutcome,
      "Error: headless Goal session goal-2 completed without a durable completion outcome.",
    );
  });

  test(`Given a completed Goal carries its durable completion outcome,
    When its headless report outcome is projected,
    Then the authoritative completion reason is preserved`, () => {
    // Given
    const outcome = requireHeadlessGoalOutcome("completed", {
      objective: "Finish",
      status: "completed",
      ...accounting,
      completionEvidence: { kind: "user_override" },
      latestRuntimeOutcome: {
        kind: "completed",
        reason: "The runtime verified completion.",
      },
    });

    // When
    const reportOutcome = headlessGoalRunReportOutcome(outcome);
    const stopReason = headlessGoalRunReportStopReason(outcome);

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
