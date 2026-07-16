import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { errorMessage } from "../core/error.ts";
import {
  type ToolCall,
  toolCallCanonicalArguments,
  toolCallSchema,
} from "../tools/tool-call.ts";
import { type RunReport, runReportSchema } from "./report-schema.ts";
import {
  type ConfiguredMemory,
  createEvalResultLine,
  type EvalProviderSelection,
  type EvalResultLine,
  evalTrialPasses,
  type MemoryCondition,
  memoryPairGatePasses,
  memoryStructuralFailures,
  pairDelta,
  type RecordedToolCall,
  resultMemory,
  type TranscriptEvidence,
  type TrialResult,
} from "./result.ts";
import {
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

const transcriptAssistantMessageSchema = z.object({
  type: z.literal("message"),
  message: z.object({
    role: z.literal("assistant"),
    content: z.string(),
    toolCalls: z.array(toolCallSchema),
  }),
});

const packageJsonSchema = z.object({ version: z.string() });

function keelVersion(): string {
  const raw = readFileSync(
    join(import.meta.dirname, "../../package.json"),
    "utf8",
  );
  return packageJsonSchema.parse(JSON.parse(raw)).version;
}

function keelRevision(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: join(import.meta.dirname, "../.."),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    /* v8 ignore next: published packages may run outside a Git checkout. */
    return null;
  }
}

interface ProcessResult {
  readonly exitCode: number | null;
  readonly spawnFailed: boolean;
  readonly timedOut: boolean;
  readonly stdout: string;
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
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });
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
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
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
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderrTail: error.message,
      });
    });
    child.on("close", (code) => {
      finish(code);
    });
  });
}

function withTrialWorkspace<T>(
  task: EvalTask,
  action: (workDir: string, metaDir: string, keelHome: string) => Promise<T>,
): Promise<T> {
  // Every trial starts from a fresh copy of the fixture in a throwaway
  // directory: no state can leak between trials. The report file lives
  // outside the workspace so neither the agent nor the verifier can see it.
  const workDir = mkdtempSync(join(tmpdir(), `keel-eval-${task.id}-`));
  const metaDir = mkdtempSync(join(tmpdir(), "keel-eval-meta-"));
  const keelHome = mkdtempSync(join(tmpdir(), "keel-eval-home-"));
  cpSync(task.workspaceDir, workDir, { recursive: true });
  return action(workDir, metaDir, keelHome).finally(() => {
    rmSync(workDir, { recursive: true, force: true });
    rmSync(metaDir, { recursive: true, force: true });
    rmSync(keelHome, { recursive: true, force: true });
  });
}

function evalEnvironment(keelHome: string): Readonly<NodeJS.ProcessEnv> {
  return { ...process.env, KEEL_HOME: keelHome };
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

function recordedToolCall(toolCall: ToolCall): RecordedToolCall {
  return {
    id: toolCall.id,
    tool: toolCall.tool,
    arguments: toolCallCanonicalArguments(toolCall),
  };
}

function readTranscriptEvidence(
  transcriptPath: string | null,
): TranscriptEvidence {
  if (transcriptPath === null || !isReadableTranscript(transcriptPath)) {
    return {
      readable: false,
      systemPrompt: null,
      providerText: "",
      assistantTexts: [],
      toolCalls: [],
    };
  }
  try {
    const providerText = readFileSync(transcriptPath, "utf8");
    const records = providerText
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
    const header = transcriptHeaderSchema.parse(records[0]);
    const assistantMessages = records.flatMap((record) => {
      const parsed = transcriptAssistantMessageSchema.safeParse(record);
      return parsed.success ? [parsed.data.message] : [];
    });
    return {
      readable: true,
      systemPrompt: header.systemPrompt,
      providerText,
      assistantTexts: assistantMessages.map((message) => message.content),
      toolCalls: assistantMessages.flatMap((message) =>
        message.toolCalls.map(recordedToolCall),
      ),
    };
  } catch {
    return {
      readable: false,
      systemPrompt: null,
      providerText: "",
      assistantTexts: [],
      toolCalls: [],
    };
  }
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

async function runAgentTrial(
  task: EvalTask,
  cliEntry: string,
  selection: EvalProviderSelection,
  condition: MemoryCondition,
  workDir: string,
  metaDir: string,
  keelHome: string,
  persistedTranscriptPath: string | null,
): Promise<TrialResult> {
  const reportPath = join(metaDir, `${condition}-report.json`);
  const capturedTranscriptPath =
    persistedTranscriptPath ??
    (condition === "standard"
      ? null
      : join(metaDir, `${condition}-transcript.jsonl`));
  const env = evalEnvironment(keelHome);
  const cliArgs = [
    ...process.execArgv,
    cliEntry,
    "--provider",
    selection.providerId,
    "--model",
    selection.model,
    ...(task.allowBash ? ["--allow-bash"] : []),
    "--max-cost",
    String(task.maxCostUsd),
    ...(condition === "memory_disabled" ? ["--no-memory"] : []),
    "--report",
    reportPath,
    ...(capturedTranscriptPath !== null
      ? ["--transcript", capturedTranscriptPath]
      : []),
    task.prompt,
  ];

  const startedAt = Date.now();
  const run = await runProcess(process.execPath, cliArgs, {
    cwd: workDir,
    timeoutMs: task.timeoutMs,
    env,
  });
  const wallMs = Date.now() - startedAt;
  const transcript = readTranscriptEvidence(capturedTranscriptPath);
  const transcriptPath =
    persistedTranscriptPath !== null && transcript.readable
      ? persistedTranscriptPath
      : null;

  if (run.timedOut) {
    return {
      outcome: "timeout",
      wallMs,
      report: null,
      transcriptPath,
      transcript,
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
      report: null,
      transcriptPath,
      transcript,
    };
  }

  const verify = await runProcess("bash", [task.verifyScript], {
    cwd: workDir,
    timeoutMs: task.scriptTimeoutMs,
    env,
  });
  /* v8 ignore next 3: CI and supported user environments provide bash. */
  if (verify.spawnFailed) {
    return {
      outcome: "crashed",
      wallMs,
      report,
      transcriptPath,
      transcript,
    };
  }
  if (verify.timedOut) {
    return {
      outcome: "timeout",
      wallMs,
      report,
      transcriptPath,
      transcript,
    };
  }
  return {
    outcome: verify.exitCode === 0 ? "verified" : "verify_failed",
    wallMs,
    report,
    transcriptPath,
    transcript,
  };
}

async function runStandardTrial(
  task: StandardEvalTask,
  cliEntry: string,
  selection: EvalProviderSelection,
  transcriptPath: string | null,
): Promise<TrialResult> {
  return withTrialWorkspace(task, (workDir, metaDir, keelHome) =>
    runAgentTrial(
      task,
      cliEntry,
      selection,
      "standard",
      workDir,
      metaDir,
      keelHome,
      transcriptPath,
    ),
  );
}

interface MemoryPairTrial {
  readonly configured: ConfiguredMemory;
  readonly setupFailures: readonly string[];
  readonly disabled: TrialResult;
  readonly enabled: TrialResult;
}

const SAVED_MEMORY_PATTERN =
  /^Saved project memory (mem_[a-f0-9-]+) for ([a-f0-9-]+)\.\n$/u;
const UPDATED_MEMORY_PATTERN =
  /^Updated project memory (mem_[a-f0-9-]+) with (mem_[a-f0-9-]+) for ([a-f0-9-]+);/u;
const FORGOT_MEMORY_PATTERN =
  /^Forgot project memory (mem_[a-f0-9-]+) for ([a-f0-9-]+)\./u;

const activeMemoryFixtureSchema = z.object({
  id: z.string(),
  status: z.enum(["current", "stale"]),
});
type ActiveMemoryFixture = z.infer<typeof activeMemoryFixtureSchema>;

function memoryCommandFailure(
  operation: "add" | "update" | "forget",
  result: ProcessResult,
): Error {
  return new Error(
    `memory ${operation} failed (exit ${String(result.exitCode)}): stdout=${JSON.stringify(result.stdout)} stderr=${JSON.stringify(result.stderrTail)}`,
  );
}

function failedSetupTrial(): TrialResult {
  return {
    outcome: "crashed",
    wallMs: 0,
    report: null,
    transcriptPath: null,
    transcript: {
      readable: false,
      systemPrompt: null,
      providerText: "",
      assistantTexts: [],
      toolCalls: [],
    },
  };
}

async function seedMemoryFixture(
  task: MemoryPairEvalTask,
  cliEntry: string,
  workDir: string,
  keelHome: string,
): Promise<ConfiguredMemory> {
  const env = evalEnvironment(keelHome);
  const initialized = await runProcess("git", ["init", "--quiet"], {
    cwd: workDir,
    timeoutMs: task.scriptTimeoutMs,
    env,
  });
  if (initialized.exitCode !== 0) {
    throw new Error(`git init failed: ${initialized.stderrTail}`);
  }

  const active = new Map<string, ActiveMemoryFixture>();
  let projectId = "";
  const acceptProjectId = (savedProjectId: string): void => {
    if (projectId !== "" && projectId !== savedProjectId) {
      throw new Error("memory fixture changed project scope while seeding");
    }
    projectId = savedProjectId;
  };
  for (const operation of task.memorySetup) {
    if (operation.operation === "forget") {
      const target = activeMemoryFixtureSchema.parse(
        active.get(operation.target),
      );
      const forgotten = await runProcess(
        process.execPath,
        [...process.execArgv, cliEntry, "memory", "forget", target.id],
        { cwd: workDir, timeoutMs: task.scriptTimeoutMs, env },
      );
      const match = FORGOT_MEMORY_PATTERN.exec(forgotten.stdout);
      if (
        forgotten.exitCode !== 0 ||
        match === null ||
        match[1] !== target.id
      ) {
        throw memoryCommandFailure("forget", forgotten);
      }
      acceptProjectId(z.string().parse(match[2]));
      active.delete(operation.target);
      continue;
    }

    const lifecycleArgs =
      operation.lifecycle === "stale"
        ? ["--review-after", "2000-01-01T00:00:00.000Z"]
        : [];
    if (operation.operation === "update") {
      const target = activeMemoryFixtureSchema.parse(
        active.get(operation.target),
      );
      const updated = await runProcess(
        process.execPath,
        [
          ...process.execArgv,
          cliEntry,
          "memory",
          "update",
          target.id,
          operation.text,
          ...lifecycleArgs,
        ],
        { cwd: workDir, timeoutMs: task.scriptTimeoutMs, env },
      );
      const match = UPDATED_MEMORY_PATTERN.exec(updated.stdout);
      if (updated.exitCode !== 0 || match === null || match[1] !== target.id) {
        throw memoryCommandFailure("update", updated);
      }
      acceptProjectId(z.string().parse(match[3]));
      active.delete(operation.target);
      active.set(operation.alias, {
        id: z.string().parse(match[2]),
        status: operation.lifecycle,
      });
      continue;
    }

    const added = await runProcess(
      process.execPath,
      [
        ...process.execArgv,
        cliEntry,
        "memory",
        "add",
        operation.text,
        ...lifecycleArgs,
      ],
      { cwd: workDir, timeoutMs: task.scriptTimeoutMs, env },
    );
    const saved = SAVED_MEMORY_PATTERN.exec(added.stdout);
    if (added.exitCode !== 0 || saved === null) {
      throw memoryCommandFailure("add", added);
    }
    const savedId = z.string().parse(saved[1]);
    const savedProjectId = z.string().parse(saved[2]);
    acceptProjectId(savedProjectId);
    active.set(operation.alias, {
      id: savedId,
      status: operation.lifecycle,
    });
  }
  return {
    ids: [...active.values()].map((entry) => entry.id),
    statuses: [...active.values()].map((entry) => entry.status),
    scope: { kind: "project", id: projectId },
  };
}

async function runMemoryPairTrial(
  task: MemoryPairEvalTask,
  cliEntry: string,
  selection: EvalProviderSelection,
  transcriptPaths: {
    readonly disabled: string | null;
    readonly enabled: string | null;
  },
): Promise<MemoryPairTrial> {
  const pairRoot = mkdtempSync(join(tmpdir(), `keel-eval-pair-${task.id}-`));
  const metaDir = mkdtempSync(join(tmpdir(), "keel-eval-pair-meta-"));
  try {
    const baseWorkDir = join(pairRoot, "base-workspace");
    const baseKeelHome = join(pairRoot, "base-home");
    cpSync(task.workspaceDir, baseWorkDir, { recursive: true });
    mkdirSync(baseKeelHome, { recursive: true });

    let configured: ConfiguredMemory;
    try {
      configured = await seedMemoryFixture(
        task,
        cliEntry,
        baseWorkDir,
        baseKeelHome,
      );
    } catch (error) {
      return {
        configured: { ids: [], statuses: [], scope: null },
        setupFailures: [`memory fixture setup failed: ${errorMessage(error)}`],
        disabled: failedSetupTrial(),
        enabled: failedSetupTrial(),
      };
    }

    const activeWorkDir = join(pairRoot, "workspace");
    const activeKeelHome = join(pairRoot, "home");
    const restoreSnapshot = (): void => {
      rmSync(activeWorkDir, { recursive: true, force: true });
      rmSync(activeKeelHome, { recursive: true, force: true });
      cpSync(baseWorkDir, activeWorkDir, { recursive: true });
      cpSync(baseKeelHome, activeKeelHome, { recursive: true });
    };

    restoreSnapshot();

    const disabled = await runAgentTrial(
      task,
      cliEntry,
      selection,
      "memory_disabled",
      activeWorkDir,
      metaDir,
      activeKeelHome,
      transcriptPaths.disabled,
    );
    restoreSnapshot();
    const enabled = await runAgentTrial(
      task,
      cliEntry,
      selection,
      "memory_enabled",
      activeWorkDir,
      metaDir,
      activeKeelHome,
      transcriptPaths.enabled,
    );
    return { configured, setupFailures: [], disabled, enabled };
  } finally {
    rmSync(pairRoot, { recursive: true, force: true });
    rmSync(metaDir, { recursive: true, force: true });
  }
}

async function checkTask(task: EvalTask): Promise<boolean> {
  return withTrialWorkspace(task, async (workDir, _metaDir, keelHome) => {
    const env = evalEnvironment(keelHome);
    const solution = await runProcess("bash", [task.solutionScript], {
      cwd: workDir,
      timeoutMs: task.scriptTimeoutMs,
      env,
    });
    if (solution.exitCode !== 0) return false;

    const verify = await runProcess("bash", [task.verifyScript], {
      cwd: workDir,
      timeoutMs: task.scriptTimeoutMs,
      env,
    });
    return verify.exitCode === 0;
  });
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

function appendResultLine(outFile: string, line: EvalResultLine): boolean {
  if (!ensureResultOutputDirectory(outFile)) return false;
  try {
    appendFileSync(outFile, `${JSON.stringify(line)}\n`, "utf8");
    return true;
  } catch (error) {
    process.stderr.write(
      `Error: cannot write eval results to ${outFile}: ${errorMessage(error)}\n`,
    );
    return false;
  }
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

interface EvalCommandCommonArgs {
  readonly suiteDir: string;
  readonly outFile: string;
  readonly trials: number;
  readonly taskId?: string;
  readonly cliEntry: string;
  readonly transcriptDir?: string;
}

export type EvalCommandArgs = EvalCommandCommonArgs &
  (
    | { readonly check: true; readonly selection: null }
    | {
        readonly check: false;
        readonly selection: EvalProviderSelection;
      }
  );

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
  const revision = keelRevision();
  const selection = args.selection;
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

  let passingTasks = 0;
  let passingRequiredRuns = 0;
  let requiredRuns = 0;
  let resultRuns = 0;
  for (const task of tasks) {
    let taskPassed = true;
    if (task.kind === "standard") {
      let passes = 0;
      for (let trial = 1; trial <= args.trials; trial++) {
        const transcriptPath =
          transcriptRunDir === undefined
            ? null
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
        const line = createEvalResultLine({
          version,
          revision,
          task,
          trial,
          repetitionCount: args.trials,
          condition: "standard",
          requiredToPass: true,
          result,
          structuralFailures: [],
          memory: resultMemory("standard", null),
          pairDelta: null,
          selection,
        });
        if (line.pass) {
          passes++;
          passingRequiredRuns++;
        } else {
          taskPassed = false;
        }
        requiredRuns++;
        resultRuns++;
        if (!appendResultLine(args.outFile, line)) return 1;
        process.stderr.write(
          `[${task.id}] trial ${trial}: ${result.outcome} (${result.wallMs}ms)\n`,
        );
      }
      process.stdout.write(`${task.id}: ${passes}/${args.trials} pass\n`);
    } else {
      let disabledPasses = 0;
      let enabledPasses = 0;
      for (let trial = 1; trial <= args.trials; trial++) {
        const transcriptBase =
          transcriptRunDir === undefined
            ? null
            : join(transcriptRunDir, `${artifactName(task.id)}-trial-${trial}`);
        const pair = await runMemoryPairTrial(task, args.cliEntry, selection, {
          disabled:
            transcriptBase === null
              ? null
              : `${transcriptBase}-memory-disabled.jsonl`,
          enabled:
            transcriptBase === null
              ? null
              : `${transcriptBase}-memory-enabled.jsonl`,
        });
        const disabledStructural = memoryStructuralFailures(
          task,
          "memory_disabled",
          pair.configured,
          pair.disabled,
          pair.setupFailures,
        );
        const enabledStructural = memoryStructuralFailures(
          task,
          "memory_enabled",
          pair.configured,
          pair.enabled,
          pair.setupFailures,
        );
        const disabledPass = evalTrialPasses(
          task,
          pair.disabled,
          disabledStructural,
        );
        const enabledPass = evalTrialPasses(
          task,
          pair.enabled,
          enabledStructural,
        );
        const delta = pairDelta(
          pair.disabled,
          pair.enabled,
          disabledPass,
          enabledPass,
        );
        const disabledRequired = task.passPolicy === "both_must_pass";
        const disabledLine = createEvalResultLine({
          version,
          revision,
          task,
          trial,
          repetitionCount: args.trials,
          condition: "memory_disabled",
          requiredToPass: disabledRequired,
          result: pair.disabled,
          structuralFailures: disabledStructural,
          memory: resultMemory("memory_disabled", pair.configured),
          pairDelta: delta,
          selection,
        });
        const enabledLine = createEvalResultLine({
          version,
          revision,
          task,
          trial,
          repetitionCount: args.trials,
          condition: "memory_enabled",
          requiredToPass: true,
          result: pair.enabled,
          structuralFailures: enabledStructural,
          memory: resultMemory("memory_enabled", pair.configured),
          pairDelta: delta,
          selection,
        });

        if (disabledLine.pass) disabledPasses++;
        if (enabledLine.pass) enabledPasses++;
        if (!memoryPairGatePasses(task.passPolicy, disabledLine, enabledLine)) {
          taskPassed = false;
        }
        if (disabledRequired) {
          requiredRuns++;
          if (disabledLine.pass) passingRequiredRuns++;
        }
        requiredRuns++;
        if (enabledLine.pass) passingRequiredRuns++;
        resultRuns += 2;
        /* v8 ignore next: shared append failure is covered by output-path race tests. */
        if (!appendResultLine(args.outFile, disabledLine)) return 1;
        /* v8 ignore next: shared append failure is covered by output-path race tests. */
        if (!appendResultLine(args.outFile, enabledLine)) return 1;
        process.stderr.write(
          `[${task.id}] trial ${trial} disabled: ${pair.disabled.outcome} (${pair.disabled.wallMs}ms)\n`,
        );
        process.stderr.write(
          `[${task.id}] trial ${trial} enabled: ${pair.enabled.outcome} (${pair.enabled.wallMs}ms)\n`,
        );
      }
      const aggregateDelta =
        ((enabledPasses - disabledPasses) / args.trials) * 100;
      const deltaLabel = `${aggregateDelta >= 0 ? "+" : ""}${aggregateDelta.toFixed(1)}pp`;
      process.stdout.write(
        `${task.id}: disabled ${disabledPasses}/${args.trials}, enabled ${enabledPasses}/${args.trials}, delta ${deltaLabel}\n`,
      );
    }
    if (taskPassed) passingTasks++;
  }

  if (tasks.every((task) => task.kind === "standard")) {
    process.stdout.write(
      `suite: ${passingTasks}/${tasks.length} tasks pass (${passingRequiredRuns}/${requiredRuns} trials)\n`,
    );
  } else {
    process.stdout.write(
      `suite: ${passingTasks}/${tasks.length} tasks pass (${passingRequiredRuns}/${requiredRuns} required runs; ${resultRuns} recorded runs)\n`,
    );
  }
  process.stdout.write(`results: ${args.outFile}\n`);
  return passingTasks === tasks.length ? 0 : 1;
}
