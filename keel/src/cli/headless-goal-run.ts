import {
  assessSessionGoalResume,
  copySessionGoal,
  pauseActiveSessionGoal,
  type ResumableSessionGoal,
  type SessionGoal,
  type SessionGoalBudget,
  type SessionGoalCompletion,
  type SessionGoalResumeAssessment,
} from "../core/session-goal.ts";
import {
  createSessionBashPermissionPolicy,
  type SessionBashPermissionPolicy,
} from "../permissions/bash.ts";
import type { CliArgs } from "./args.ts";
import {
  BashProjectApprovalsError,
  bashApprovalProjectRoot,
  listBashProjectApprovalGrants,
} from "./bash-project-approvals.ts";
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

async function headlessGoalBashPermission(
  contract: {
    readonly bashMode: GoalCliArgs["bashMode"];
    readonly completion: SessionGoalCompletion;
  },
  runtime: CliRuntime,
): Promise<SessionBashPermissionPolicy | null | undefined> {
  if (contract.bashMode === "trusted") {
    return undefined;
  }
  if (contract.completion.kind === "assertion") {
    if (contract.bashMode === "disabled") {
      return undefined;
    }
    const workspace = runtime.cwd();
    const projectRoot = bashApprovalProjectRoot(workspace);
    return createSessionBashPermissionPolicy({
      projectRoot,
      initialProjectGrants: listBashProjectApprovalGrants(runtime, projectRoot),
      prompt: () => ({
        type: "deny",
        message:
          "Headless command approval is unavailable and no saved project approval matched.",
      }),
    });
  }
  if (contract.bashMode === "disabled") {
    runtime.writeStderr(
      "Error: headless command Goals require --bash-policy trusted or a matching saved project approval with --bash-policy ask.\n",
    );
    return null;
  }
  const workspace = runtime.cwd();
  const projectRoot = bashApprovalProjectRoot(workspace);
  const policy = createSessionBashPermissionPolicy({
    projectRoot,
    initialProjectGrants: listBashProjectApprovalGrants(runtime, projectRoot),
    prompt: () => ({
      type: "deny",
      message:
        "Headless command approval is unavailable and no saved project approval matched.",
    }),
  });
  const decision = await policy.review({
    command: contract.completion.command,
    cwd: workspace,
    signal: new AbortController().signal,
  });
  if (decision.type === "allow") {
    return policy;
  }
  runtime.writeStderr(`Error: ${decision.message}\n`);
  return null;
}

async function prepareHeadlessGoalResume(
  cliArgs: GoalResumeCliArgs,
  runtime: CliRuntime,
  goal: SessionGoal | undefined,
): Promise<
  | {
      readonly kind: "ready";
      readonly goal: ResumableSessionGoal;
      readonly bashPermission?: SessionBashPermissionPolicy;
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
  const bashPermission = await headlessGoalBashPermission(
    {
      bashMode: cliArgs.bashMode,
      completion: resumableGoal.completion,
    },
    runtime,
  );
  return bashPermission === null
    ? { kind: "rejected" }
    : {
        kind: "ready",
        goal: resumableGoal,
        ...(bashPermission !== undefined ? { bashPermission } : {}),
      };
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
    bashMode: cliArgs.bashMode,
    skillsEnabled: cliArgs.skillsEnabled,
    memoryEnabled: cliArgs.memoryEnabled,
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
  let result: HeadlessSessionCliResult;
  try {
    let bashPermission: SessionBashPermissionPolicy | undefined;
    if (cliArgs.mode === "launch") {
      const preparedBashPermission = await headlessGoalBashPermission(
        {
          bashMode: cliArgs.bashMode,
          completion:
            cliArgs.criterion.kind === "command"
              ? {
                  kind: "command",
                  command: cliArgs.criterion.command,
                  ...(cliArgs.criterion.verificationTimeoutMs === undefined
                    ? {}
                    : {
                        verificationTimeoutMs:
                          cliArgs.criterion.verificationTimeoutMs,
                      }),
                }
              : {
                  kind: "assertion",
                  assertion: cliArgs.criterion.assertion,
                },
        },
        runtime,
      );
      if (preparedBashPermission === null) return 1;
      bashPermission = preparedBashPermission;
    }
    result = await runHeadlessSessionCli(
      headlessGoalRunArgs(cliArgs),
      runtime,
      cliArgs.mode === "launch"
        ? headlessGoalActivationCommand(cliArgs)
        : "/goal resume",
      bashPermission,
      (activatedSessionId) => {
        runtime.writeStdout(
          `Headless goal session: ${sanitizeStatusLineText(activatedSessionId)}\n`,
        );
      },
      cliArgs.mode === "resume"
        ? async (goal) =>
            await prepareHeadlessGoalResume(cliArgs, runtime, goal)
        : undefined,
      cliArgs.mode === "resume"
        ? (goal) => headlessGoalResumeAssessment(cliArgs, goal)
        : undefined,
    );
  } catch (error) {
    if (!(error instanceof BashProjectApprovalsError)) throw error;
    runtime.writeStderr(`${error.message}\n`);
    return 1;
  }
  if (result.kind === "failed") {
    return result.exitCode;
  }
  return writeHeadlessGoalOutcome(runtime, result.outcome);
}
