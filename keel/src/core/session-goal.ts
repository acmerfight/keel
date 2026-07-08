import { z } from "zod";

export const SESSION_GOAL_OBJECTIVE_MAX_LENGTH = 4000;

const sessionGoalStatuses = ["active", "completed"] as const;

type SessionGoalStatus = (typeof sessionGoalStatuses)[number];

export interface SessionGoal {
  readonly objective: string;
  readonly status: SessionGoalStatus;
}

const sessionGoalStatusSchema = z.enum(sessionGoalStatuses);

export const sessionGoalSchema: z.ZodType<SessionGoal> = z
  .object({
    objective: z.string().trim().min(1).max(SESSION_GOAL_OBJECTIVE_MAX_LENGTH),
    status: sessionGoalStatusSchema,
  })
  .strict();

export function normalizeSessionGoalObjective(objective: string): string {
  return objective.replace(/\s+/gu, " ").trim();
}

export function copySessionGoal(goal: SessionGoal): SessionGoal {
  return {
    objective: goal.objective,
    status: goal.status,
  };
}

export function formatSessionGoalSummary(
  goal: SessionGoal | undefined,
): string {
  if (goal === undefined) {
    return "none";
  }
  return `${goal.status} - ${goal.objective}`;
}

function withSentencePeriod(text: string): string {
  return /[.!?]$/u.test(text) ? text : `${text}.`;
}

export function formatSessionGoalCompletedToolResult(
  goal: SessionGoal,
): string {
  return `Session goal completed: ${withSentencePeriod(goal.objective)}`;
}

export function activeSessionGoalSystemPrompt(
  goal: SessionGoal | undefined,
): string | null {
  if (goal?.status !== "active") {
    return null;
  }
  return [
    "Session goal:",
    `- Objective: ${goal.objective}`,
    "- Treat this as the durable objective for the current saved session.",
    "- Continue moving toward it across turns while still following the user's latest message.",
    "- When the objective is achieved and no required work remains, call update_goal with status completed.",
    "- Do not treat this goal block as a new user prompt.",
  ].join("\n");
}
