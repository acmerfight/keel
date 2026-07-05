import {
  listUndoCheckpoints,
  restoreLastEditCheckpoint,
  restoreUndoCheckpointsThrough,
} from "../core/git.ts";
import type { CliArgs } from "./args.ts";
import { formatUndoCheckpointList } from "./output.ts";
import type { CliRuntime } from "./runtime.ts";
import { showToolOutputArtifact } from "./tool-output-artifacts.ts";
import {
  formatWorkflowSkillList,
  formatWorkflowSkillListWarnings,
  listWorkflowSkills,
  WorkflowSkillError,
} from "./workflow-skills.ts";

type DoctorCliArgs = Extract<CliArgs, { readonly command: "doctor" }>;
type EvalCliArgs = Extract<CliArgs, { readonly command: "eval" }>;
type UndoCliArgs = Extract<CliArgs, { readonly command: "undo" }>;
type ArtifactsCliArgs = Extract<CliArgs, { readonly command: "artifacts" }>;

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

export function runSkillsCommand(runtime: CliRuntime): number {
  try {
    const result = listWorkflowSkills(runtime.cwd());
    runtime.writeStdout(formatWorkflowSkillList(result.skills));
    const warningText = formatWorkflowSkillListWarnings(result.warnings);
    if (warningText !== "") {
      runtime.writeStderr(warningText);
    }
    return 0;
  } catch (error) {
    /* v8 ignore next 3: unexpected workflow skill listing failures are allowed to escape. */
    if (!(error instanceof WorkflowSkillError)) {
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
