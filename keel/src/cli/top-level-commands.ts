import {
  listUndoCheckpoints,
  restoreLastEditCheckpoint,
  restoreUndoCheckpointsThrough,
} from "../core/git.ts";
import { formatSkillCatalogDegradation } from "../skills/catalog.ts";
import type { CliArgs } from "./args.ts";
import { formatUndoCheckpointList } from "./output.ts";
import {
  runAuthCommand as runProviderAuthCommand,
  runConfigCommand as runProviderConfigCommand,
  runSetupCommand as runProviderSetupCommand,
} from "./provider-setup-command.ts";
import type { CliRuntime } from "./runtime.ts";
import {
  SkillUserConfigError,
  setAllWorkflowSkillsEnabled,
  setWorkflowSkillEnabled,
} from "./skill-user-config.ts";
import { showToolOutputArtifact } from "./tool-output-artifacts.ts";
import {
  discoverWorkflowSkillCatalog,
  formatWorkflowSkillDiagnostics,
  formatWorkflowSkillList,
  formatWorkflowSkillListWarnings,
  listWorkflowSkills,
  WorkflowSkillError,
} from "./workflow-skills.ts";

type DoctorCliArgs = Extract<CliArgs, { readonly command: "doctor" }>;
type EvalCliArgs = Extract<CliArgs, { readonly command: "eval" }>;
type UndoCliArgs = Extract<CliArgs, { readonly command: "undo" }>;
type ArtifactsCliArgs = Extract<CliArgs, { readonly command: "artifacts" }>;
type AuthCliArgs = Extract<CliArgs, { readonly command: "auth" }>;
type ConfigCliArgs = Extract<CliArgs, { readonly command: "config" }>;
type SetupCliArgs = Extract<CliArgs, { readonly command: "setup" }>;

export async function runAuthCommand(
  cliArgs: AuthCliArgs,
  runtime: CliRuntime,
): Promise<number> {
  return await runProviderAuthCommand(cliArgs, runtime);
}

export function runConfigCommand(
  cliArgs: ConfigCliArgs,
  runtime: CliRuntime,
): number {
  return runProviderConfigCommand(cliArgs, runtime);
}

export async function runSetupCommand(
  cliArgs: SetupCliArgs,
  runtime: CliRuntime,
): Promise<number> {
  return await runProviderSetupCommand(cliArgs, runtime);
}

export async function runDoctorCommand(
  cliArgs: DoctorCliArgs,
  runtime: CliRuntime,
): Promise<number> {
  const {
    readBundledRipgrepDiagnostic,
    readProviderModelsDiagnostic,
    runDoctor,
  } = await import("./doctor.ts");
  const result = await runDoctor({
    runtime,
    readRipgrepDiagnostic: readBundledRipgrepDiagnostic,
    readProviderOnlineDiagnostic: readProviderModelsDiagnostic,
    onlineMode: cliArgs.offline ? "offline" : "online",
    selection: {
      ...(cliArgs.providerId !== undefined
        ? { providerId: cliArgs.providerId }
        : {}),
      ...(cliArgs.model !== undefined ? { model: cliArgs.model } : {}),
    },
  });
  runtime.writeStdout(result.stdout);
  runtime.writeStderr(result.stderr);
  return result.exitCode;
}

export async function runEvalCommand(
  cliArgs: EvalCliArgs,
  runtime: CliRuntime,
): Promise<number> {
  if (cliArgs.mode === "compare") {
    const { runEvalCompareCommand } = await import("../eval/compare.ts");
    return runEvalCompareCommand({
      baseFile: cliArgs.baseFile,
      headFile: cliArgs.headFile,
    });
  }

  const { runEvalCommand: runEval } = await import("../eval/run.ts");
  return await runEval({
    suiteDir: cliArgs.suiteDir,
    outFile: cliArgs.outFile,
    ...(cliArgs.transcriptDir !== undefined
      ? { transcriptDir: cliArgs.transcriptDir }
      : {}),
    trials: cliArgs.trials,
    ...(cliArgs.taskId !== undefined ? { taskId: cliArgs.taskId } : {}),
    ...(cliArgs.providerId !== undefined
      ? { providerId: cliArgs.providerId }
      : {}),
    ...(cliArgs.model !== undefined ? { model: cliArgs.model } : {}),
    check: cliArgs.check,
    cliEntry: runtime.cliEntry,
  });
}

export function runUndoCommand(
  cliArgs: UndoCliArgs,
  runtime: CliRuntime,
): number {
  if (cliArgs.mode === "list") {
    runtime.writeStdout(
      formatUndoCheckpointList(listUndoCheckpoints(runtime.cwd())),
    );
    return 0;
  }

  const result =
    cliArgs.mode === "restore-through"
      ? restoreUndoCheckpointsThrough(runtime.cwd(), cliArgs.checkpointIndex)
      : restoreLastEditCheckpoint(runtime.cwd());
  switch (result.status) {
    case "restored":
      runtime.writeStdout(`Restored ${result.restoredLabel}\n`);
      return 0;
    case "none":
      runtime.writeStderr(`${result.message}\n`);
      return 1;
    case "blocked":
      runtime.writeStderr(`${result.message}\n`);
      return 1;
  }
}

export function runSkillsCommand(
  cliArgs: Extract<CliArgs, { readonly command: "skills" }>,
  runtime: CliRuntime,
): number {
  try {
    if (cliArgs.mode === "configure") {
      if (cliArgs.target.kind === "all") {
        setAllWorkflowSkillsEnabled(runtime, cliArgs.action === "enable");
        runtime.writeStdout(
          cliArgs.action === "enable"
            ? "Enabled all workflow skills.\n"
            : "Disabled all workflow skills globally.\n",
        );
        return 0;
      }
      const skill = discoverWorkflowSkillCatalog(runtime, runtime.cwd()).load(
        cliArgs.target.lookup,
      );
      const result = setWorkflowSkillEnabled(
        runtime,
        skill.packageId,
        cliArgs.action === "enable",
      );
      const action = cliArgs.action === "enable" ? "Enabled" : "Disabled";
      runtime.writeStdout(
        result.changed
          ? `${action} workflow skill ${skill.qualifiedName}.\n`
          : `Workflow skill ${skill.qualifiedName} is already ${cliArgs.action === "enable" ? "enabled" : "disabled"}.\n`,
      );
      return 0;
    }
    const result = listWorkflowSkills(runtime, runtime.cwd(), {
      includeUserControls: cliArgs.mode === "list",
    });
    if (cliArgs.mode === "doctor") {
      runtime.writeStdout(formatWorkflowSkillDiagnostics(result.audits));
      return result.audits.some((audit) =>
        audit.findings.some((finding) => finding.severity === "blocker"),
      )
        ? 1
        : 0;
    }
    runtime.writeStdout(
      formatWorkflowSkillList(result.skills, {
        globallyEnabled: result.globallyEnabled,
      }),
    );
    const warningText = formatWorkflowSkillListWarnings(result.warnings);
    runtime.writeStderr(
      `${warningText}${formatSkillCatalogDegradation(result.exposure)}`,
    );
    return 0;
  } catch (error) {
    if (
      !(error instanceof WorkflowSkillError) &&
      !(error instanceof SkillUserConfigError)
    ) {
      throw error;
    }
    runtime.writeStderr(`${error.message}\n`);
    return 1;
  }
}

export async function runArtifactsCommand(
  cliArgs: ArtifactsCliArgs,
  runtime: CliRuntime,
): Promise<number> {
  const result = await showToolOutputArtifact({
    runtime,
    ref: cliArgs.ref,
  });
  if (!result.ok) {
    runtime.writeStderr(`${result.message}\n`);
    return 1;
  }
  runtime.writeStdout(
    result.content.endsWith("\n") ? result.content : `${result.content}\n`,
  );
  return 0;
}
