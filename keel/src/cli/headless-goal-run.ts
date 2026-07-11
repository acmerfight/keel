import type { SessionGoal } from "../core/session-goal.ts";
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
import { runHeadlessSessionCli } from "./interactive-run.ts";
import { sanitizeStatusLineText } from "./output.ts";
import type { CliRuntime } from "./runtime.ts";
import { createAutomaticSessionId } from "./session-id.ts";

type GoalCliArgs = Extract<CliArgs, { readonly command: "goal" }>;

function headlessGoalActivationCommand(cliArgs: GoalCliArgs): string {
  return [
    "/goal",
    "--objective",
    JSON.stringify(cliArgs.objective),
    "--verify",
    JSON.stringify(cliArgs.verificationCommand),
    ...(cliArgs.verificationTimeoutMs === undefined
      ? []
      : ["--timeout", `${cliArgs.verificationTimeoutMs}ms`]),
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
  cliArgs: GoalCliArgs,
  runtime: CliRuntime,
): Promise<SessionBashPermissionPolicy | null | undefined> {
  if (cliArgs.bashMode === "trusted") {
    return undefined;
  }
  if (cliArgs.bashMode === "disabled") {
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
    command: cliArgs.verificationCommand,
    cwd: workspace,
    signal: new AbortController().signal,
  });
  if (decision.type === "allow") {
    return policy;
  }
  runtime.writeStderr(`Error: ${decision.message}\n`);
  return null;
}

function writeHeadlessGoalOutcome(
  runtime: CliRuntime,
  sessionId: string,
  goal: Extract<
    SessionGoal,
    {
      readonly status:
        | "blocked"
        | "budget_limited"
        | "usage_limited"
        | "completed";
    }
  >,
): number {
  const safeSessionId = sanitizeStatusLineText(sessionId);
  runtime.writeStdout(
    `Headless goal outcome: ${goal.status}; session: ${safeSessionId}\n`,
  );
  switch (goal.status) {
    case "completed":
      return 0;
    case "blocked":
      runtime.writeStdout(`Resume with: keel --resume ${safeSessionId}\n`);
      return 3;
    case "budget_limited":
    case "usage_limited":
      runtime.writeStdout(`Resume with: keel --resume ${safeSessionId}\n`);
      return 4;
  }
}

export async function runHeadlessGoalCli(
  cliArgs: GoalCliArgs,
  runtime: CliRuntime,
): Promise<number> {
  let bashPermission: SessionBashPermissionPolicy | null | undefined;
  try {
    bashPermission = await headlessGoalBashPermission(cliArgs, runtime);
  } catch (error) {
    /* v8 ignore start: approval loading is the only expected preflight throw; unexpected faults must reach the CLI boundary. */
    if (!(error instanceof BashProjectApprovalsError)) throw error;
    /* v8 ignore stop */
    runtime.writeStderr(`${error.message}\n`);
    return 1;
  }
  if (bashPermission === null) {
    return 1;
  }
  const sessionId = cliArgs.sessionId ?? createAutomaticSessionId();
  const result = await runHeadlessSessionCli(
    {
      command: "run",
      bashMode: cliArgs.bashMode,
      ephemeral: false,
      sessionId,
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
      ...(cliArgs.skillName !== undefined
        ? { skillName: cliArgs.skillName }
        : {}),
    },
    runtime,
    headlessGoalActivationCommand(cliArgs),
    bashPermission,
    (activatedSessionId) => {
      runtime.writeStdout(
        `Headless goal session: ${sanitizeStatusLineText(activatedSessionId)}\n`,
      );
    },
  );
  if (result.exitCode !== 0) {
    return result.exitCode;
  }
  /* v8 ignore start: exit 0 is produced only after the generated activation command reaches a terminal durable Goal. */
  if (result.goal === undefined) {
    runtime.writeStderr(
      `Error: headless Goal session ${sanitizeStatusLineText(sessionId)} ended without durable Goal state.\n`,
    );
    return 1;
  }
  if (result.goal.status === "active" || result.goal.status === "paused") {
    runtime.writeStderr(
      `Error: headless Goal ended while session ${sanitizeStatusLineText(sessionId)} was still ${result.goal.status}.\n`,
    );
    return 1;
  }
  /* v8 ignore stop */
  return writeHeadlessGoalOutcome(runtime, sessionId, result.goal);
}
