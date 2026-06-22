import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { errorMessage } from "../core/error.ts";
import type { ProviderId } from "../core/provider-id.ts";
import { type EvalTask, loadEvalTasks } from "./task.ts";

// Mirrors the CLI --report payload. The runner consumes the report through
// the same file a user would, so this schema is the eval side of that
// contract; bump expectations together with the CLI's schemaVersion.
const runReportSchema = z.object({
  schemaVersion: z.literal(1),
  provider: z.string(),
  model: z.string(),
  turns: z.number().int().positive(),
  stopReason: z.string(),
  usage: z.object({
    inputTokens: z.number().int().nonnegative(),
    cachedInputTokens: z.number().int().nonnegative(),
    uncachedInputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
  }),
  durationMs: z.number().nonnegative(),
  costUsd: z.number().nonnegative(),
});

type RunReport = z.infer<typeof runReportSchema>;

const transcriptHeaderSchema = z.object({
  schemaVersion: z.literal(1),
  type: z.literal("transcript"),
  provider: z.string(),
  model: z.string(),
  systemPrompt: z.string(),
});

const packageJsonSchema = z.object({ version: z.string() });

function keelVersion(): string {
  const raw = readFileSync(
    join(import.meta.dirname, "../../package.json"),
    "utf8",
  );
  return packageJsonSchema.parse(JSON.parse(raw)).version;
}

// Trial outcomes separate harness failures (timeout, crashed) from graded
// failures (verify_failed) so a broken environment never reads as a bad agent.
type TrialOutcome = "verified" | "verify_failed" | "timeout" | "crashed";

interface TrialResult {
  readonly outcome: TrialOutcome;
  readonly wallMs: number;
  readonly report?: RunReport;
  readonly transcriptPath?: string;
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
  options: { readonly cwd: string; readonly timeoutMs: number },
): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      detached: process.platform !== "win32",
      env: process.env,
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

async function runTrial(
  task: EvalTask,
  cliEntry: string,
  selection: EvalProviderSelection,
  transcriptPath: string | undefined,
): Promise<TrialResult> {
  return withTrialWorkspace(task, async (workDir, metaDir) => {
    const reportPath = join(metaDir, "report.json");
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
      "--report",
      reportPath,
      ...(transcriptPath !== undefined ? ["--transcript", transcriptPath] : []),
      task.prompt,
    ];

    const startedAt = Date.now();
    const run = await runProcess(process.execPath, cliArgs, {
      cwd: workDir,
      timeoutMs: task.timeoutMs,
    });
    const wallMs = Date.now() - startedAt;

    if (run.timedOut) {
      return {
        outcome: "timeout",
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
        outcome: "crashed",
        wallMs,
        ...readableTranscriptResult(transcriptPath),
      };
    }

    const verify = await runProcess("bash", [task.verifyScript], {
      cwd: workDir,
      timeoutMs: task.scriptTimeoutMs,
    });
    /* v8 ignore next 3: CI and supported user environments provide bash. */
    if (verify.spawnFailed) {
      return {
        outcome: "crashed",
        wallMs,
        report,
        ...readableTranscriptResult(transcriptPath),
      };
    }
    if (verify.timedOut) {
      return {
        outcome: "timeout",
        wallMs,
        report,
        ...readableTranscriptResult(transcriptPath),
      };
    }
    return {
      outcome: verify.exitCode === 0 ? "verified" : "verify_failed",
      wallMs,
      report,
      ...readableTranscriptResult(transcriptPath),
    };
  });
}

async function checkTask(task: EvalTask): Promise<boolean> {
  return withTrialWorkspace(task, async (workDir) => {
    const solution = await runProcess("bash", [task.solutionScript], {
      cwd: workDir,
      timeoutMs: task.scriptTimeoutMs,
    });
    if (solution.exitCode !== 0) return false;

    const verify = await runProcess("bash", [task.verifyScript], {
      cwd: workDir,
      timeoutMs: task.scriptTimeoutMs,
    });
    return verify.exitCode === 0;
  });
}

interface ResultLine {
  readonly schemaVersion: 1;
  readonly timestamp: string;
  readonly keelVersion: string;
  readonly taskId: string;
  readonly trial: number;
  readonly pass: boolean;
  readonly outcome: TrialOutcome;
  readonly wallMs: number;
  readonly report?: RunReport;
  readonly transcriptPath?: string;
}

interface EvalProviderSelection {
  readonly providerId?: ProviderId;
  readonly model?: string;
}

function appendResultLine(outFile: string, line: ResultLine): void {
  mkdirSync(dirname(outFile), { recursive: true });
  appendFileSync(outFile, `${JSON.stringify(line)}\n`, "utf8");
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
    mkdirSync(transcriptRunDir, { recursive: true });
  }
  let passingTasks = 0;
  let passingTrials = 0;
  for (const task of tasks) {
    let passes = 0;
    for (let trial = 1; trial <= args.trials; trial++) {
      const transcriptPath =
        transcriptRunDir === undefined
          ? undefined
          : join(
              transcriptRunDir,
              `${artifactName(task.id)}-trial-${trial}.jsonl`,
            );
      const result = await runTrial(
        task,
        args.cliEntry,
        {
          ...(args.providerId !== undefined
            ? { providerId: args.providerId }
            : {}),
          ...(args.model !== undefined ? { model: args.model } : {}),
        },
        transcriptPath,
      );
      const pass = result.outcome === "verified";
      if (pass) passes++;
      appendResultLine(args.outFile, {
        schemaVersion: 1,
        timestamp: new Date().toISOString(),
        keelVersion: version,
        taskId: task.id,
        trial,
        pass,
        outcome: result.outcome,
        wallMs: result.wallMs,
        ...(result.report !== undefined ? { report: result.report } : {}),
        ...(result.transcriptPath !== undefined
          ? { transcriptPath: result.transcriptPath }
          : {}),
      });
      process.stderr.write(
        `[${task.id}] trial ${trial}: ${result.outcome} (${result.wallMs}ms)\n`,
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
  return passingTrials === totalTrials ? 0 : 1;
}
