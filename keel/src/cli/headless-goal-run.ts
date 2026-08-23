import {
  assessSessionGoalResume,
  copySessionGoal,
  pauseActiveSessionGoal,
  type ResumableSessionGoal,
  type SessionGoal,
  type SessionGoalBudget,
  type SessionGoalResumeAssessment,
} from "../core/session-goal.ts";
import type { CliArgs } from "./args.ts";
import { writeHeadlessGoalOutcome } from "./headless-goal-outcome.ts";
import {
  type HeadlessSessionCliArgs,
  type HeadlessSessionCliResult,
  runHeadlessSessionCli,
} from "./interactive-run.ts";
import { sanitizeStatusLineText } from "./output.ts";
import type { CliRuntime } from "./runtime.ts";
import { createAutomaticSessionId } from "./session-id.ts";

type GoalCliArgs = Extract<CliArgs, { readonly command: "goal" }>;
type GoalLaunchCliArgs = Extract<GoalCliArgs, { readonly mode: "launch" }>;
type GoalResumeCliArgs = Extract<GoalCliArgs, { readonly mode: "resume" }>;

function headlessGoalActivationCommand(cliArgs: GoalLaunchCliArgs): string {
  return [
    "/goal",
    "--objective",
    JSON.stringify(cliArgs.objective),
    ...(cliArgs.criterion.kind === "command"
      ? ["--verify", JSON.stringify(cliArgs.criterion.command)]
      : ["--done-when", JSON.stringify(cliArgs.criterion.assertion)]),
    ...(cliArgs.criterion.kind !== "command" ||
    cliArgs.criterion.verificationTimeoutMs === undefined
      ? []
      : ["--timeout", `${cliArgs.criterion.verificationTimeoutMs}ms`]),
    ...(cliArgs.budget.turns === undefined
      ? []
      : ["--turns", String(cliArgs.budget.turns)]),
    ...(cliArgs.budget.tokens === undefined
      ? []
      : ["--tokens", String(cliArgs.budget.tokens)]),
    ...(cliArgs.budget.activeTimeMs === undefined
      ? []
      : ["--time", `${cliArgs.budget.activeTimeMs}ms`]),
  ].join(" ");
}

async function prepareHeadlessGoalResume(
  cliArgs: GoalResumeCliArgs,
  runtime: CliRuntime,
  goal: SessionGoal | undefined,
): Promise<
  | {
      readonly kind: "ready";
      readonly goal: ResumableSessionGoal;
    }
  | { readonly kind: "rejected" }
> {
  const preparedGoal = headlessGoalForResume(goal, cliArgs.budget);
  const assessment = assessSessionGoalResume(preparedGoal);
  if (assessment.kind !== "ready") {
    runtime.writeStderr(`${assessment.rejection}\n`);
    return { kind: "rejected" };
  }
  const resumableGoal = assessment.goal;
  return { kind: "ready", goal: resumableGoal };
}

function headlessGoalForResume(
  goal: SessionGoal | undefined,
  budget: SessionGoalBudget,
): SessionGoal | undefined {
  if (goal === undefined) return undefined;
  const resumableGoal =
    goal.status === "active" ? pauseActiveSessionGoal(goal) : goal;
  return {
    ...copySessionGoal(resumableGoal),
    budget: {
      ...resumableGoal.budget,
      ...budget,
    },
  };
}

function headlessGoalResumeAssessment(
  cliArgs: GoalResumeCliArgs,
  goal: SessionGoal | undefined,
): SessionGoalResumeAssessment {
  return assessSessionGoalResume(headlessGoalForResume(goal, cliArgs.budget));
}

function headlessGoalRunArgs(cliArgs: GoalCliArgs): HeadlessSessionCliArgs {
  return {
    command: "run",
    mode: "interactive",
    agentPolicy: "off",
    executionPosture: cliArgs.executionPosture,
    skillsEnabled: cliArgs.skillsEnabled,
    memoryEnabled: cliArgs.memoryEnabled,
    recoveryPolicy: "block",
    session:
      cliArgs.mode === "launch"
        ? {
            kind: "create",
            sessionId: cliArgs.sessionId ?? createAutomaticSessionId(),
          }
        : cliArgs.resumeSession.kind === "id"
          ? {
              kind: "resume",
              sessionId: cliArgs.resumeSession.sessionId,
            }
          : { kind: "resume-latest" },
    ...(cliArgs.maxCostUsd !== undefined
      ? { maxCostUsd: cliArgs.maxCostUsd }
      : {}),
    ...(cliArgs.reportFile !== undefined
      ? { reportFile: cliArgs.reportFile }
      : {}),
    ...(cliArgs.providerId !== undefined
      ? { providerId: cliArgs.providerId }
      : {}),
    ...(cliArgs.model !== undefined ? { model: cliArgs.model } : {}),
    ...(cliArgs.skillNames !== undefined
      ? { skillNames: cliArgs.skillNames }
      : {}),
  };
}

export async function runHeadlessGoalCli(
  cliArgs: GoalCliArgs,
  runtime: CliRuntime,
): Promise<number> {
  if (cliArgs.executionPosture === "reviewed") {
    runtime.writeStderr(
      "Error: --approval-policy ask requires a real TTY and is unavailable to Goal runs.\n",
    );
    return 1;
  }
  const result: HeadlessSessionCliResult = await runHeadlessSessionCli(
    headlessGoalRunArgs(cliArgs),
    runtime,
    cliArgs.mode === "launch"
      ? headlessGoalActivationCommand(cliArgs)
      : "/goal resume",
    undefined,
    (activatedSessionId) => {
      runtime.writeStdout(
        `Headless goal session: ${sanitizeStatusLineText(activatedSessionId)}\n`,
      );
    },
    cliArgs.mode === "resume"
      ? async (goal) => await prepareHeadlessGoalResume(cliArgs, runtime, goal)
      : undefined,
    cliArgs.mode === "resume"
      ? (goal) => headlessGoalResumeAssessment(cliArgs, goal)
      : undefined,
  );
  if (result.kind === "failed") {
    return result.exitCode;
  }
  return writeHeadlessGoalOutcome(runtime, result.outcome);
}
