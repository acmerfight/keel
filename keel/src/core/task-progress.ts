import { z } from "zod";

const sessionTaskStatuses = ["pending", "in_progress", "completed"] as const;

type SessionTaskStatus = (typeof sessionTaskStatuses)[number];

export interface SessionTask {
  readonly step: string;
  readonly status: SessionTaskStatus;
}

export interface SessionTaskProgress {
  readonly tasks: readonly SessionTask[];
}

const sessionTaskStatusSchema = z.enum(sessionTaskStatuses);

const sessionTaskSchema: z.ZodType<SessionTask> = z
  .object({
    step: z.string().trim().min(1).max(200).describe("Task step text."),
    status: sessionTaskStatusSchema.describe("Step status."),
  })
  .strict();

export const sessionTaskPlanSchema: z.ZodType<readonly SessionTask[]> = z
  .array(sessionTaskSchema)
  .max(20)
  .refine(
    (tasks) =>
      tasks.filter((task) => task.status === "in_progress").length <= 1,
    "At most one task can be in_progress.",
  )
  .describe("The full replacement list of current task steps.");

export const sessionTaskProgressSchema: z.ZodType<SessionTaskProgress> = z
  .object({
    tasks: sessionTaskPlanSchema,
  })
  .strict();

export function emptySessionTaskProgress(): SessionTaskProgress {
  return { tasks: [] };
}

function copySessionTask(task: SessionTask): SessionTask {
  return {
    step: task.step,
    status: task.status,
  };
}

export function copySessionTaskProgress(
  taskProgress: SessionTaskProgress,
): SessionTaskProgress {
  return {
    tasks: taskProgress.tasks.map(copySessionTask),
  };
}

export function sessionTaskProgressFromPlan(
  plan: readonly SessionTask[],
): SessionTaskProgress {
  return { tasks: plan.map(copySessionTask) };
}

export function sessionTaskProgressesEqual(
  left: SessionTaskProgress,
  right: SessionTaskProgress,
): boolean {
  const taskSignature = (taskProgress: SessionTaskProgress): string =>
    JSON.stringify(taskProgress.tasks.map((task) => [task.step, task.status]));
  return taskSignature(left) === taskSignature(right);
}

function completedTaskCount(taskProgress: SessionTaskProgress): number {
  return taskProgress.tasks.filter((task) => task.status === "completed")
    .length;
}

function currentTask(taskProgress: SessionTaskProgress): SessionTask | null {
  return (
    taskProgress.tasks.find((task) => task.status === "in_progress") ??
    taskProgress.tasks.find((task) => task.status === "pending") ??
    null
  );
}

function withSentencePeriod(text: string): string {
  return /[.!?]$/u.test(text) ? text : `${text}.`;
}

export function formatSessionTaskProgressSummary(
  taskProgress: SessionTaskProgress,
): string {
  if (taskProgress.tasks.length === 0) {
    return "none";
  }
  const completed = completedTaskCount(taskProgress);
  const current = currentTask(taskProgress);
  if (current === null) {
    return `${completed}/${taskProgress.tasks.length} completed`;
  }
  return `${completed}/${taskProgress.tasks.length} completed; current: ${current.step}`;
}

export function formatSessionTaskProgressToolResult(
  taskProgress: SessionTaskProgress,
): string {
  if (taskProgress.tasks.length === 0) {
    return "Task progress cleared.";
  }
  return `Task progress updated: ${withSentencePeriod(formatSessionTaskProgressSummary(taskProgress))}`;
}

function renderSessionTaskProgressMarkdown(
  taskProgress: SessionTaskProgress,
  title = "## Session Task Progress",
): string {
  return [
    title,
    ...taskProgress.tasks.map(
      (task, index) => `${index + 1}. [${task.status}] ${task.step}`,
    ),
  ].join("\n");
}

export function appendSessionTaskProgressToSummary(
  summary: string,
  taskProgress: SessionTaskProgress | undefined,
): string {
  if (taskProgress === undefined || taskProgress.tasks.length === 0) {
    return summary;
  }
  return `${summary.trim()}\n\n${renderSessionTaskProgressMarkdown(taskProgress)}`;
}
