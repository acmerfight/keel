import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  closeSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { errorMessage } from "../core/error.ts";
import type { ProviderId } from "../core/provider-id.ts";
import { type RunReport, runReportSchema } from "./report-schema.ts";
import {
  type EvalDelegationSelection,
  type EvalResultCondition,
  type EvalResultLine,
  type EvalTrialCondition,
  type EvalTrialObservation,
  evalResultVerdict,
} from "./result-schema.ts";
import {
  type DelegationPairEvalTask,
  type EvalDelegationPolicy,
  type EvalTask,
  loadEvalTasks,
  type MemoryPairEvalTask,
  type StandardEvalTask,
} from "./task.ts";

const transcriptHeaderSchema = z.object({
  schemaVersion: z.literal(1),
  type: z.literal("transcript"),
  provider: z.string(),
  model: z.string(),
  systemPrompt: z.string(),
});

const packageJsonSchema = z.object({ version: z.string() });
const KEEL_HOME_ENV = "KEEL_HOME";

function keelVersion(): string {
  const raw = readFileSync(
    join(import.meta.dirname, "../../package.json"),
    "utf8",
  );
  return packageJsonSchema.parse(JSON.parse(raw)).version;
}

interface TrialResultMetadata {
  readonly wallMs: number;
  readonly report?: RunReport;
  readonly transcriptPath?: string;
}

type TrialResult = EvalTrialObservation & TrialResultMetadata;

interface TrialDelegationMode {
  readonly experimentalAgents: boolean;
}

interface ProcessResult {
  readonly exitCode: number | null;
  readonly spawnFailed: boolean;
  readonly timedOut: boolean;
  readonly stderrTail: string;
}

const STDERR_TAIL_CHARS = 400;

function killProcessGroup(child: ReturnType<typeof spawn>): void {
  const pid = child.pid;
  /* v8 ignore next 3: spawn can fail before assigning a pid. */
  if (pid === undefined) {
    child.kill("SIGKILL");
    return;
  }
  /* v8 ignore next 3: process groups are unavailable on Windows. */
  if (process.platform === "win32") {
    child.kill("SIGKILL");
    return;
  }

  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

function runProcess(
  command: string,
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly timeoutMs: number;
    readonly env: Readonly<NodeJS.ProcessEnv>;
  },
): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      detached: process.platform !== "win32",
      env: options.env,
      stdio: ["ignore", "ignore", "pipe"],
    });
    const stderrChunks: Buffer[] = [];
    child.stderr.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });

    let timedOut = false;
    let finished = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessGroup(child);
    }, options.timeoutMs);

    const finish = (exitCode: number | null) => {
      /* v8 ignore next 1: child_process can emit close/error races. */
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({
        exitCode,
        spawnFailed: false,
        timedOut,
        stderrTail: Buffer.concat(stderrChunks)
          .toString("utf8")
          .slice(-STDERR_TAIL_CHARS),
      });
    };
    child.on("error", (error) => {
      /* v8 ignore next 1: child_process can emit close/error races. */
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({
        exitCode: null,
        spawnFailed: true,
        timedOut,
        stderrTail: error.message,
      });
    });
    child.on("exit", (code) => {
      finish(code);
    });
  });
}

function withTrialWorkspace<T>(
  task: EvalTask,
  action: (workDir: string, metaDir: string) => Promise<T>,
): Promise<T> {
  // Every trial starts from a fresh copy of the fixture in a throwaway
  // directory: no state can leak between trials. The report file lives
  // outside the workspace so neither the agent nor the verifier can see it.
  const workDir = mkdtempSync(join(tmpdir(), `keel-eval-${task.id}-`));
  const metaDir = mkdtempSync(join(tmpdir(), "keel-eval-meta-"));
  cpSync(task.workspaceDir, workDir, { recursive: true });
  return action(workDir, metaDir).finally(() => {
    rmSync(workDir, { recursive: true, force: true });
    rmSync(metaDir, { recursive: true, force: true });
  });
}

function readRunReport(reportPath: string): RunReport | null {
  if (!existsSync(reportPath)) return null;
  try {
    const parsed = runReportSchema.safeParse(
      JSON.parse(readFileSync(reportPath, "utf8")),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function childRunCount(report: RunReport): number {
  return new Set(
    report.modelOperations.flatMap((operation) =>
      operation.attribution?.type === "subagent"
        ? [
            `${operation.attribution.delegationId}\0${operation.attribution.childRunId}`,
          ]
        : [],
    ),
  ).size;
}

function delegationSelection(
  policy: EvalDelegationPolicy,
  report: RunReport | undefined,
): EvalDelegationSelection {
  if (report === undefined) return { status: "unavailable", policy };
  const childRuns = childRunCount(report);
  let satisfied: boolean;
  switch (policy) {
    case "require_one":
      satisfied = childRuns === 1;
      break;
    case "forbid":
      satisfied = childRuns === 0;
      break;
    case "at_most_one":
      satisfied = childRuns <= 1;
      break;
  }
  return { status: "observed", policy, childRuns, satisfied };
}

function readableTranscriptResult(transcriptPath: string | undefined): {
  readonly transcriptPath?: string;
} {
  if (transcriptPath === undefined || !isReadableTranscript(transcriptPath)) {
    return {};
  }
  return { transcriptPath };
}

function artifactName(value: string): string {
  const name = value.replace(/[^A-Za-z0-9._-]/gu, "_");
  const digest = createHash("sha256").update(value).digest("hex").slice(0, 12);
  return `${name}-${digest}`;
}

function isReadableTranscript(transcriptPath: string): boolean {
  try {
    if (!statSync(transcriptPath).isFile()) return false;
    const firstLine = readFileSync(transcriptPath, "utf8").split("\n", 1)[0];
    if (firstLine === undefined || firstLine === "") return false;
    return transcriptHeaderSchema.safeParse(JSON.parse(firstLine)).success;
  } catch {
    return false;
  }
}

async function runTrialInWorkspace(
  task: EvalTask,
  cliEntry: string,
  selection: EvalProviderSelection,
  condition: EvalTrialCondition,
  workDir: string,
  metaDir: string,
  env: Readonly<NodeJS.ProcessEnv>,
  transcriptPath: string | undefined,
  delegation: TrialDelegationMode,
): Promise<TrialResult> {
  const reportPath = join(metaDir, `${condition}-report.json`);
  const cliArgs = [
    ...process.execArgv,
    cliEntry,
    ...(selection.providerId !== undefined
      ? ["--provider", selection.providerId]
      : []),
    ...(selection.model !== undefined ? ["--model", selection.model] : []),
    ...(task.allowBash ? ["--allow-bash"] : []),
    ...(task.maxCostUsd !== undefined
      ? ["--max-cost", String(task.maxCostUsd)]
      : []),
    ...(delegation.experimentalAgents ? ["--experimental-agents"] : []),
    ...(condition === "memory_enabled" ? [] : ["--no-memory"]),
    "--report",
    reportPath,
    ...(transcriptPath !== undefined ? ["--transcript", transcriptPath] : []),
    task.prompt,
  ];

  const startedAt = Date.now();
  const run = await runProcess(process.execPath, cliArgs, {
    cwd: workDir,
    timeoutMs: task.timeoutMs,
    env,
  });
  const wallMs = Date.now() - startedAt;

  if (run.timedOut) {
    return {
      harnessOutcome: "timeout",
      wallMs,
      ...readableTranscriptResult(transcriptPath),
    };
  }
  const report = readRunReport(reportPath);
  if (run.exitCode !== 0 || report === null) {
    if (run.stderrTail !== "") {
      process.stderr.write(`[${task.id}] agent stderr: ${run.stderrTail}\n`);
    }
    return {
      harnessOutcome: "crashed",
      wallMs,
      ...readableTranscriptResult(transcriptPath),
    };
  }

  const verify = await runProcess("bash", [task.verifyScript], {
    cwd: workDir,
    timeoutMs: task.scriptTimeoutMs,
    env,
  });
  if (verify.spawnFailed) {
    return {
      harnessOutcome: "crashed",
      wallMs,
      report,
      ...readableTranscriptResult(transcriptPath),
    };
  }
  if (verify.timedOut) {
    return {
      harnessOutcome: "timeout",
      wallMs,
      report,
      ...readableTranscriptResult(transcriptPath),
    };
  }
  if (verify.exitCode === null) {
    return {
      harnessOutcome: "crashed",
      wallMs,
      report,
      ...readableTranscriptResult(transcriptPath),
    };
  }
  return {
    harnessOutcome: "completed",
    taskOutcome: verify.exitCode === 0 ? "verified" : "verify_failed",
    wallMs,
    report,
    ...readableTranscriptResult(transcriptPath),
  };
}

function runStandardTrial(
  task: StandardEvalTask,
  cliEntry: string,
  selection: EvalProviderSelection,
  transcriptPath: string | undefined,
): Promise<TrialResult> {
  return withTrialWorkspace(task, (workDir, metaDir) =>
    runTrialInWorkspace(
      task,
      cliEntry,
      selection,
      "standard",
      workDir,
      metaDir,
      process.env,
      transcriptPath,
      { experimentalAgents: task.experimentalAgents },
    ),
  );
}

interface MemoryPairTrial {
  readonly disabled: TrialResult;
  readonly enabled: TrialResult;
}

function copyProviderConfiguration(targetKeelHome: string): void {
  const sourceKeelHome = process.env[KEEL_HOME_ENV] ?? join(homedir(), ".keel");
  for (const name of ["config.json", "auth.json"]) {
    const source = join(sourceKeelHome, name);
    if (existsSync(source)) {
      const target = join(targetKeelHome, name);
      copyFileSync(source, target);
      chmodSync(target, 0o600);
    }
  }
}

async function runMemoryPairTrial(
  task: MemoryPairEvalTask,
  cliEntry: string,
  selection: EvalProviderSelection,
  transcriptPaths: {
    readonly disabled: string | undefined;
    readonly enabled: string | undefined;
  },
): Promise<MemoryPairTrial> {
  const pairRoot = mkdtempSync(join(tmpdir(), `keel-eval-${task.id}-pair-`));
  const workDir = join(pairRoot, "workspace");
  const snapshotDir = join(pairRoot, "snapshot");
  const metaDir = join(pairRoot, "meta");
  const keelHome = join(pairRoot, "home");
  const env = { ...process.env, KEEL_HOME: keelHome };

  try {
    cpSync(task.workspaceDir, workDir, { recursive: true });
    mkdirSync(metaDir, { recursive: true });
    mkdirSync(keelHome, { recursive: true });
    copyProviderConfiguration(keelHome);

    const initialized = await runProcess("git", ["init", "--quiet"], {
      cwd: workDir,
      timeoutMs: task.scriptTimeoutMs,
      env,
    });
    if (initialized.exitCode !== 0) {
      throw new Error(`git init failed: ${initialized.stderrTail}`);
    }

    const seeded = await runProcess(
      process.execPath,
      [...process.execArgv, cliEntry, "memory", "add", task.memory],
      { cwd: workDir, timeoutMs: task.scriptTimeoutMs, env },
    );
    if (seeded.exitCode !== 0) {
      throw new Error(`memory add failed: ${seeded.stderrTail}`);
    }

    cpSync(workDir, snapshotDir, { recursive: true });
    const disabled = await runTrialInWorkspace(
      task,
      cliEntry,
      selection,
      "memory_disabled",
      workDir,
      metaDir,
      env,
      transcriptPaths.disabled,
      { experimentalAgents: false },
    );

    rmSync(workDir, { recursive: true, force: true });
    cpSync(snapshotDir, workDir, { recursive: true });
    const enabled = await runTrialInWorkspace(
      task,
      cliEntry,
      selection,
      "memory_enabled",
      workDir,
      metaDir,
      env,
      transcriptPaths.enabled,
      { experimentalAgents: false },
    );
    return { disabled, enabled };
  } finally {
    rmSync(pairRoot, { recursive: true, force: true });
  }
}

interface DelegationPairTrial {
  readonly control: TrialResult;
  readonly treatment: TrialResult;
}

async function runDelegationPairTrial(
  task: DelegationPairEvalTask,
  cliEntry: string,
  selection: EvalProviderSelection,
  treatmentFirst: boolean,
  transcriptPaths: {
    readonly control: string | undefined;
    readonly treatment: string | undefined;
  },
): Promise<DelegationPairTrial> {
  const pairRoot = mkdtempSync(join(tmpdir(), `keel-eval-${task.id}-pair-`));
  const workDir = join(pairRoot, "workspace");
  const snapshotDir = join(pairRoot, "snapshot");
  const metaDir = join(pairRoot, "meta");
  cpSync(task.workspaceDir, snapshotDir, { recursive: true });
  mkdirSync(metaDir, { recursive: true });

  const runArm = async (
    condition: "delegation_control" | "delegation_treatment",
  ): Promise<TrialResult> => {
    rmSync(workDir, { recursive: true, force: true });
    cpSync(snapshotDir, workDir, { recursive: true });
    const treatment = condition === "delegation_treatment";
    return await runTrialInWorkspace(
      task,
      cliEntry,
      selection,
      condition,
      workDir,
      metaDir,
      process.env,
      treatment ? transcriptPaths.treatment : transcriptPaths.control,
      { experimentalAgents: treatment },
    );
  };

  try {
    if (treatmentFirst) {
      const treatment = await runArm("delegation_treatment");
      const control = await runArm("delegation_control");
      return { control, treatment };
    }
    const control = await runArm("delegation_control");
    const treatment = await runArm("delegation_treatment");
    return { control, treatment };
  } finally {
    rmSync(pairRoot, { recursive: true, force: true });
  }
}

async function checkTask(task: EvalTask): Promise<boolean> {
  return withTrialWorkspace(task, async (workDir) => {
    const solution = await runProcess("bash", [task.solutionScript], {
      cwd: workDir,
      timeoutMs: task.scriptTimeoutMs,
      env: process.env,
    });
    if (solution.exitCode !== 0) return false;

    const verify = await runProcess("bash", [task.verifyScript], {
      cwd: workDir,
      timeoutMs: task.scriptTimeoutMs,
      env: process.env,
    });
    return verify.exitCode === 0;
  });
}

interface EvalProviderSelection {
  readonly providerId?: ProviderId;
  readonly model?: string;
}

function ensureResultOutputDirectory(outFile: string): boolean {
  try {
    mkdirSync(dirname(outFile), { recursive: true });
    return true;
  } catch (error) {
    process.stderr.write(
      `Error: cannot write eval results to ${outFile}: ${errorMessage(error)}\n`,
    );
    return false;
  }
}

function ensureResultOutputFile(outFile: string): boolean {
  try {
    mkdirSync(dirname(outFile), { recursive: true });
    const fd = openSync(outFile, "a");
    closeSync(fd);
    return true;
  } catch (error) {
    process.stderr.write(
      `Error: cannot write eval results to ${outFile}: ${errorMessage(error)}\n`,
    );
    return false;
  }
}

function appendResultLines(
  outFile: string,
  lines: readonly EvalResultLine[],
): boolean {
  if (!ensureResultOutputDirectory(outFile)) return false;
  try {
    appendFileSync(
      outFile,
      lines.map((line) => `${JSON.stringify(line)}\n`).join(""),
      "utf8",
    );
    return true;
  } catch (error) {
    process.stderr.write(
      `Error: cannot write eval results to ${outFile}: ${errorMessage(error)}\n`,
    );
    return false;
  }
}

function trialResultLine(
  version: string,
  task: EvalTask,
  trial: number,
  condition: EvalResultCondition,
  result: TrialResult,
): EvalResultLine {
  return {
    schemaVersion: 3,
    timestamp: new Date().toISOString(),
    keelVersion: version,
    taskId: task.id,
    trial,
    ...condition,
    ...evalResultVerdict(result),
    wallMs: result.wallMs,
    ...(result.report !== undefined ? { report: result.report } : {}),
    ...(result.transcriptPath !== undefined
      ? { transcriptPath: result.transcriptPath }
      : {}),
  };
}

function taskVerified(result: TrialResult): boolean {
  return (
    result.harnessOutcome === "completed" && result.taskOutcome === "verified"
  );
}

function harnessCompleted(result: TrialResult): boolean {
  return result.harnessOutcome === "completed";
}

function selectionSatisfied(selection: EvalDelegationSelection): boolean {
  return selection.status === "observed" && selection.satisfied;
}

function trialResultSummary(result: TrialResult): string {
  return result.harnessOutcome === "completed"
    ? result.taskOutcome
    : result.harnessOutcome;
}

function ensureTranscriptRunDirectory(transcriptRunDir: string): boolean {
  try {
    mkdirSync(transcriptRunDir, { recursive: true });
    return true;
  } catch (error) {
    process.stderr.write(
      `Error: cannot create eval transcript directory ${transcriptRunDir}: ${errorMessage(error)}\n`,
    );
    return false;
  }
}

export interface EvalCommandArgs {
  readonly suiteDir: string;
  readonly outFile: string;
  readonly trials: number;
  readonly taskId?: string;
  readonly providerId?: ProviderId;
  readonly model?: string;
  readonly check: boolean;
  readonly cliEntry: string;
  readonly transcriptDir?: string;
}

function selectTasks(args: EvalCommandArgs): readonly EvalTask[] {
  const tasks = loadEvalTasks(args.suiteDir);
  if (args.taskId === undefined) return tasks;

  const selected = tasks.filter((task) => task.id === args.taskId);
  if (selected.length === 0) {
    throw new Error(`eval task "${args.taskId}" not found in ${args.suiteDir}`);
  }
  return selected;
}

async function runCheck(tasks: readonly EvalTask[]): Promise<number> {
  let broken = 0;
  for (const task of tasks) {
    const ok = await checkTask(task);
    process.stdout.write(
      ok
        ? `${task.id}: verifier ok\n`
        : `${task.id}: verifier BROKEN (reference solution rejected)\n`,
    );
    if (!ok) broken++;
  }
  return broken === 0 ? 0 : 1;
}

export async function runEvalCommand(args: EvalCommandArgs): Promise<number> {
  let tasks: readonly EvalTask[];
  try {
    tasks = selectTasks(args);
  } catch (error) {
    const message = errorMessage(error);
    process.stderr.write(`Error: ${message}\n`);
    return 1;
  }

  if (args.check) {
    return runCheck(tasks);
  }

  const version = keelVersion();
  const transcriptRunDir =
    args.transcriptDir === undefined
      ? undefined
      : join(
          resolve(args.transcriptDir),
          `run-${new Date().toISOString().replace(/[:.]/gu, "-")}-${process.pid}`,
        );
  if (transcriptRunDir !== undefined) {
    if (!ensureTranscriptRunDirectory(transcriptRunDir)) return 1;
  }

  if (!ensureResultOutputFile(args.outFile)) return 1;

  const selection: EvalProviderSelection = {
    ...(args.providerId !== undefined ? { providerId: args.providerId } : {}),
    ...(args.model !== undefined ? { model: args.model } : {}),
  };
  let passingTasks = 0;
  let passingTrials = 0;
  for (const task of tasks) {
    if (task.kind === "delegation_pair") {
      let controlPasses = 0;
      let treatmentPasses = 0;
      let selectionPasses = 0;
      let pairPasses = 0;
      for (let trial = 1; trial <= args.trials; trial++) {
        const transcriptPrefix =
          transcriptRunDir === undefined
            ? undefined
            : join(transcriptRunDir, `${artifactName(task.id)}-trial-${trial}`);
        const pair = await runDelegationPairTrial(
          task,
          args.cliEntry,
          selection,
          trial % 2 === 0,
          {
            control:
              transcriptPrefix === undefined
                ? undefined
                : `${transcriptPrefix}-delegation-control.jsonl`,
            treatment:
              transcriptPrefix === undefined
                ? undefined
                : `${transcriptPrefix}-delegation-treatment.jsonl`,
          },
        );
        const treatmentSelection = delegationSelection(
          task.delegationPolicy,
          pair.treatment.report,
        );
        if (
          !appendResultLines(args.outFile, [
            trialResultLine(
              version,
              task,
              trial,
              {
                condition: "delegation_control",
                requiredToPass: false,
              },
              pair.control,
            ),
            trialResultLine(
              version,
              task,
              trial,
              {
                condition: "delegation_treatment",
                requiredToPass: true,
                delegationSelection: treatmentSelection,
              },
              pair.treatment,
            ),
          ])
        ) {
          return 1;
        }
        process.stderr.write(
          `[${task.id}] trial ${trial} control: ${trialResultSummary(pair.control)} (${pair.control.wallMs}ms)\n`,
        );
        process.stderr.write(
          `[${task.id}] trial ${trial} treatment: ${trialResultSummary(pair.treatment)} (${pair.treatment.wallMs}ms)\n`,
        );

        if (taskVerified(pair.control)) controlPasses++;
        if (taskVerified(pair.treatment)) treatmentPasses++;
        if (selectionSatisfied(treatmentSelection)) selectionPasses++;
        if (
          harnessCompleted(pair.control) &&
          taskVerified(pair.treatment) &&
          selectionSatisfied(treatmentSelection)
        ) {
          pairPasses++;
        }
      }
      if (pairPasses === args.trials) passingTasks++;
      passingTrials += pairPasses;
      process.stdout.write(
        `${task.id}: control ${controlPasses}/${args.trials}, treatment ${treatmentPasses}/${args.trials}, expected selection ${selectionPasses}/${args.trials}\n`,
      );
      continue;
    }

    if (task.kind === "memory_pair") {
      let disabledPasses = 0;
      let enabledPasses = 0;
      let pairPasses = 0;
      for (let trial = 1; trial <= args.trials; trial++) {
        const transcriptPrefix =
          transcriptRunDir === undefined
            ? undefined
            : join(transcriptRunDir, `${artifactName(task.id)}-trial-${trial}`);
        let pair: MemoryPairTrial;
        try {
          pair = await runMemoryPairTrial(task, args.cliEntry, selection, {
            disabled:
              transcriptPrefix === undefined
                ? undefined
                : `${transcriptPrefix}-memory-disabled.jsonl`,
            enabled:
              transcriptPrefix === undefined
                ? undefined
                : `${transcriptPrefix}-memory-enabled.jsonl`,
          });
        } catch (error) {
          process.stderr.write(
            `Error: memory eval setup for ${task.id} failed: ${errorMessage(error)}\n`,
          );
          return 1;
        }

        if (
          !appendResultLines(args.outFile, [
            trialResultLine(
              version,
              task,
              trial,
              { condition: "memory_disabled", requiredToPass: false },
              pair.disabled,
            ),
            trialResultLine(
              version,
              task,
              trial,
              { condition: "memory_enabled", requiredToPass: true },
              pair.enabled,
            ),
          ])
        ) {
          return 1;
        }
        process.stderr.write(
          `[${task.id}] trial ${trial} disabled: ${trialResultSummary(pair.disabled)} (${pair.disabled.wallMs}ms)\n`,
        );
        process.stderr.write(
          `[${task.id}] trial ${trial} enabled: ${trialResultSummary(pair.enabled)} (${pair.enabled.wallMs}ms)\n`,
        );

        if (taskVerified(pair.disabled)) disabledPasses++;
        if (taskVerified(pair.enabled)) enabledPasses++;
        if (taskVerified(pair.enabled) && harnessCompleted(pair.disabled)) {
          pairPasses++;
        }
      }
      if (pairPasses === args.trials) passingTasks++;
      passingTrials += pairPasses;
      process.stdout.write(
        `${task.id}: disabled ${disabledPasses}/${args.trials}, enabled ${enabledPasses}/${args.trials}\n`,
      );
      continue;
    }

    let passes = 0;
    for (let trial = 1; trial <= args.trials; trial++) {
      const transcriptPath =
        transcriptRunDir === undefined
          ? undefined
          : join(
              transcriptRunDir,
              `${artifactName(task.id)}-trial-${trial}.jsonl`,
            );
      const result = await runStandardTrial(
        task,
        args.cliEntry,
        selection,
        transcriptPath,
      );
      const trialSelection =
        task.experimentalAgents && task.delegationPolicy !== undefined
          ? delegationSelection(task.delegationPolicy, result.report)
          : undefined;
      const pass =
        taskVerified(result) &&
        (trialSelection === undefined || selectionSatisfied(trialSelection));
      if (pass) passes++;
      const resultCondition: Extract<
        EvalResultCondition,
        { readonly condition: "standard" }
      > = {
        condition: "standard",
        requiredToPass: true,
        ...(trialSelection === undefined
          ? {}
          : { delegationSelection: trialSelection }),
      };
      const appended = appendResultLines(args.outFile, [
        trialResultLine(version, task, trial, resultCondition, result),
      ]);
      if (!appended) return 1;
      process.stderr.write(
        `[${task.id}] trial ${trial}: ${trialResultSummary(result)} (${result.wallMs}ms)\n`,
      );
    }
    if (passes === args.trials) passingTasks++;
    passingTrials += passes;
    process.stdout.write(`${task.id}: ${passes}/${args.trials} pass\n`);
  }

  const totalTrials = tasks.length * args.trials;
  process.stdout.write(
    `suite: ${passingTasks}/${tasks.length} tasks pass (${passingTrials}/${totalTrials} trials)\n`,
  );
  process.stdout.write(`results: ${args.outFile}\n`);
  return passingTasks === tasks.length ? 0 : 1;
}
