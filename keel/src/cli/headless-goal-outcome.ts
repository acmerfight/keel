import type {
  SessionGoal,
  SessionGoalRuntimeOutcome,
} from "../core/session-goal.ts";
import { sanitizeStatusLineText } from "./output.ts";
import type { RunReportGoalOutcome } from "./report.ts";
import type { CliRuntime } from "./runtime.ts";

type LimitedOrBlockedSessionGoal = Extract<
  SessionGoal,
  {
    readonly status: "blocked" | "budget_limited" | "usage_limited";
  }
>;
type CompletedSessionGoal = Extract<
  SessionGoal,
  { readonly status: "completed" }
> & {
  readonly latestRuntimeOutcome: SessionGoalRuntimeOutcome & {
    readonly kind: "completed";
  };
};
type TerminalSessionGoal = LimitedOrBlockedSessionGoal | CompletedSessionGoal;

export interface HeadlessGoalOutcome {
  readonly sessionId: string;
  readonly goal: TerminalSessionGoal;
}

export type HeadlessGoalOutcomeAssessment =
  | {
      readonly kind: "ready";
      readonly outcome: HeadlessGoalOutcome;
    }
  | {
      readonly kind: "rejected";
      readonly error: string;
    };

export function assessHeadlessGoalOutcome(
  sessionId: string | undefined,
  goal: SessionGoal | undefined,
): HeadlessGoalOutcomeAssessment {
  if (sessionId === undefined) {
    return {
      kind: "rejected",
      error: "Error: headless Goal ended without an active saved session.",
    };
  }
  const safeSessionId = sanitizeStatusLineText(sessionId);
  if (goal === undefined) {
    return {
      kind: "rejected",
      error: `Error: headless Goal session ${safeSessionId} ended without durable Goal state.`,
    };
  }
  if (goal.status === "active" || goal.status === "paused") {
    return {
      kind: "rejected",
      error: `Error: headless Goal ended while session ${safeSessionId} was still ${goal.status}.`,
    };
  }
  if (goal.status === "completed") {
    const runtimeOutcome = goal.latestRuntimeOutcome;
    if (runtimeOutcome?.kind !== "completed") {
      return {
        kind: "rejected",
        error: `Error: headless Goal session ${safeSessionId} completed without a durable completion outcome.`,
      };
    }
    return {
      kind: "ready",
      outcome: {
        sessionId,
        goal: {
          ...goal,
          latestRuntimeOutcome: {
            ...runtimeOutcome,
            kind: "completed",
          },
        },
      },
    };
  }
  return {
    kind: "ready",
    outcome: { sessionId, goal },
  };
}

export function writeHeadlessGoalOutcome(
  runtime: CliRuntime,
  outcome: HeadlessGoalOutcome,
): number {
  const safeSessionId = sanitizeStatusLineText(outcome.sessionId);
  runtime.writeStdout(
    `Headless goal outcome: ${outcome.goal.status}; session: ${safeSessionId}\n`,
  );
  switch (outcome.goal.status) {
    case "completed":
      return 0;
    case "blocked":
      runtime.writeStdout(`Resume with: keel goal resume ${safeSessionId}\n`);
      return 3;
    case "budget_limited":
    case "usage_limited":
      runtime.writeStdout(`Resume with: keel goal resume ${safeSessionId}\n`);
      return 4;
  }
}

export function headlessGoalRunReportOutcome(
  outcome: HeadlessGoalOutcome,
): RunReportGoalOutcome {
  const goal = outcome.goal;
  if (goal.status === "completed") {
    return {
      sessionId: outcome.sessionId,
      status: "completed",
      reason: goal.latestRuntimeOutcome.reason,
      evidenceKind: goal.completionEvidence.kind,
    };
  }
  return {
    sessionId: outcome.sessionId,
    status: goal.status,
    reason: goal.statusReason,
  };
}

export function headlessGoalRunReportStopReason(
  outcome: HeadlessGoalOutcome,
): "goal_blocked" | "goal_budget" | "goal_usage_limit" | undefined {
  switch (outcome.goal.status) {
    case "blocked":
      return "goal_blocked";
    case "budget_limited":
      return "goal_budget";
    case "usage_limited":
      return "goal_usage_limit";
    case "completed":
      return undefined;
  }
}
