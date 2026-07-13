import { spawn } from "node:child_process";
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
import type { ProviderId } from "../core/provider-id.ts";
import { type RunReport, runReportSchema } from "./report-schema.ts";
import type {
  EvalResultLine as ResultLine,
  SkillRoutingResult,
  TrialOutcome,
} from "./result.ts";
import { type EvalTask, loadEvalTasks } from "./task.ts";

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
const PROVIDER_CONNECTION_ENV_KEYS = [
  "KEEL_PROVIDER",
  "DEEPSEEK_API_KEY",
  "DEEPSEEK_MODEL",
  "DEEPSEEK_BASE_URL",
  "KIMI_API_KEY",
  "KIMI_MODEL",
  "KIMI_BASE_URL",
  "DASHSCOPE_API_KEY",
  "QWEN_API_KEY",
  "QWEN_MODEL",
  "QWEN_BASE_URL",
] as const;

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
    readonly env?: NodeJS.ProcessEnv;
  },
): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      detached: process.platform !== "win32",
      env: options.env ?? process.env,
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
  const workDir = mkdtempSync(join(tmpdir(), "keel-eval-workspace-"));
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

function evalChildEnvironment(
  selection: EvalProviderSelection,
  homeDir: string,
  keelHomeDir: string,
): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  if (selection.environment !== undefined) {
    for (const key of PROVIDER_CONNECTION_ENV_KEYS) {
      delete environment[key];
    }
  }
  return {
    ...environment,
    ...selection.environment,
    HOME: homeDir,
    USERPROFILE: homeDir,
    KEEL_HOME: keelHomeDir,
    KEEL_SYSTEM_SKILL_ROOTS: "",
    KEEL_EXTRA_SKILL_ROOTS: "",
  };
}

async function runTrial(
  task: EvalTask,
  cliEntry: string,
  selection: EvalProviderSelection,
  transcriptPath: string | undefined,
): Promise<TrialResult> {
  return withTrialWorkspace(task, async (workDir, metaDir) => {
    const reportPath = join(metaDir, "report.json");
    const homeDir = join(metaDir, "home");
    const keelHomeDir = join(metaDir, "keel-home");
    mkdirSync(homeDir, { recursive: true });
    mkdirSync(keelHomeDir, { recursive: true });
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
      env: evalChildEnvironment(selection, homeDir, keelHomeDir),
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

function evaluateSkillRouting(
  task: EvalTask,
  report: RunReport | undefined,
): SkillRoutingResult | undefined {
  const expectation = task.skillRouting;
  if (expectation === undefined) return undefined;

  const expectedActivations = [...expectation.expectedActivations];
  const actualActivations =
    report === undefined
      ? []
      : [
          ...new Set(
            report.skillActivations.map((activation) => activation.name),
          ),
        ];
  const expected = new Set(expectedActivations);
  const actual = new Set(actualActivations);
  const truePositives = expectedActivations.filter((name) =>
    actual.has(name),
  ).length;
  const falsePositives = actualActivations.filter(
    (name) => !expected.has(name),
  ).length;
  const falseNegatives = expectedActivations.filter(
    (name) => !actual.has(name),
  ).length;
  return {
    expectedActivations,
    actualActivations,
    truePositives,
    falsePositives,
    falseNegatives,
    evaluated: report !== undefined,
    exact: report !== undefined && falsePositives === 0 && falseNegatives === 0,
    ...(expectation.pair !== undefined
      ? { pair: { ...expectation.pair } }
      : {}),
  };
}

function routingAwareOutcome(
  outcome: TrialOutcome,
  routing: SkillRoutingResult | undefined,
): TrialOutcome {
  return outcome === "verified" && routing?.exact === false
    ? "routing_failed"
    : outcome;
}

interface EvalProviderSelection {
  readonly providerId?: ProviderId;
  readonly model?: string;
  readonly environment?: Readonly<Record<string, string>>;
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

function appendResultLine(outFile: string, line: ResultLine): boolean {
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

export interface EvalCommandArgs {
  readonly suiteDir: string;
  readonly outFile: string;
  readonly trials: number;
  readonly taskId?: string;
  readonly providerId?: ProviderId;
  readonly model?: string;
  readonly resolveProviderSelection?: () => EvalProviderSelection;
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

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function formatSigned(value: number, digits: number): string {
  const rounded = Number(value.toFixed(digits));
  return `${rounded >= 0 ? "+" : ""}${rounded.toFixed(digits)}`;
}

function formatSignedUsd(value: number): string {
  const rounded = Number(value.toFixed(6));
  const sign = rounded >= 0 ? "+" : "-";
  return `${sign}$${Math.abs(rounded).toFixed(6)}`;
}

function renderSkillRoutingSummary(lines: readonly ResultLine[]): string {
  const routing = lines.flatMap((line) =>
    line.skillRouting?.evaluated === true ? [line.skillRouting] : [],
  );
  if (routing.length === 0) return "";

  const exact = routing.filter((result) => result.exact).length;
  const truePositives = routing.reduce(
    (sum, result) => sum + result.truePositives,
    0,
  );
  const falsePositives = routing.reduce(
    (sum, result) => sum + result.falsePositives,
    0,
  );
  const falseNegatives = routing.reduce(
    (sum, result) => sum + result.falseNegatives,
    0,
  );
  const precisionDenominator = truePositives + falsePositives;
  const recallDenominator = truePositives + falseNegatives;
  const precision =
    precisionDenominator === 0
      ? "n/a"
      : formatPercent(truePositives / precisionDenominator);
  const recall =
    recallDenominator === 0
      ? "n/a"
      : formatPercent(truePositives / recallDenominator);
  const negativeCases = routing.filter(
    (result) => result.expectedActivations.length === 0,
  );
  const abstained = negativeCases.filter(
    (result) => result.actualActivations.length === 0,
  ).length;
  const abstention =
    negativeCases.length === 0
      ? "n/a"
      : `${abstained}/${negativeCases.length} (${formatPercent(
          abstained / negativeCases.length,
        )})`;
  return `skill routing: ${exact}/${routing.length} exact; precision ${precision}; recall ${recall}; no-Skill abstention ${abstention}\n`;
}

function taskOutcomePassed(line: ResultLine): boolean {
  return line.outcome === "verified" || line.outcome === "routing_failed";
}

function averageReportMetric(
  lines: readonly ResultLine[],
  read: (report: RunReport) => number,
): number | null {
  const values = lines.flatMap((line) =>
    line.report === undefined ? [] : [read(line.report)],
  );
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function renderSkillValueSummary(lines: readonly ResultLine[]): string {
  const pairs = new Map<
    string,
    {
      readonly withSkill: ResultLine[];
      readonly withoutSkill: ResultLine[];
    }
  >();
  for (const line of lines) {
    const pair = line.skillRouting?.pair;
    if (pair === undefined) continue;
    const group = pairs.get(pair.id) ?? {
      withSkill: [],
      withoutSkill: [],
    };
    if (pair.condition === "with_skill") {
      group.withSkill.push(line);
    } else {
      group.withoutSkill.push(line);
    }
    pairs.set(pair.id, group);
  }

  const output: string[] = [];
  for (const [pairId, group] of [...pairs.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (group.withSkill.length === 0 || group.withoutSkill.length === 0) {
      continue;
    }
    const withoutPasses = group.withoutSkill.filter(taskOutcomePassed).length;
    const withPasses = group.withSkill.filter(taskOutcomePassed).length;
    const withoutPassRate = withoutPasses / group.withoutSkill.length;
    const withPassRate = withPasses / group.withSkill.length;
    const withoutTurns = averageReportMetric(
      group.withoutSkill,
      (report) => report.turns,
    );
    const withTurns = averageReportMetric(
      group.withSkill,
      (report) => report.turns,
    );
    const withoutCost = averageReportMetric(
      group.withoutSkill,
      (report) => report.costUsd,
    );
    const withCost = averageReportMetric(
      group.withSkill,
      (report) => report.costUsd,
    );
    output.push(
      `skill value ${pairId}: task pass ${withoutPasses}/${group.withoutSkill.length} (${formatPercent(withoutPassRate)}) -> ${withPasses}/${group.withSkill.length} (${formatPercent(withPassRate)}) (${formatSigned((withPassRate - withoutPassRate) * 100, 1)}pp)`,
    );
    if (withoutTurns !== null && withTurns !== null) {
      output.push(
        `  turns avg ${withoutTurns.toFixed(1)} -> ${withTurns.toFixed(1)} (${formatSigned(withTurns - withoutTurns, 1)})`,
      );
    }
    if (withoutCost !== null && withCost !== null) {
      output.push(
        `  cost avg $${withoutCost.toFixed(6)} -> $${withCost.toFixed(6)} (${formatSignedUsd(withCost - withoutCost)})`,
      );
    }
  }
  return output.length === 0 ? "" : `${output.join("\n")}\n`;
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

  const providerSelection =
    args.resolveProviderSelection?.() ??
    ({
      ...(args.providerId !== undefined ? { providerId: args.providerId } : {}),
      ...(args.model !== undefined ? { model: args.model } : {}),
    } satisfies EvalProviderSelection);

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

  let passingTasks = 0;
  let passingTrials = 0;
  const resultLines: ResultLine[] = [];
  for (const [taskIndex, task] of tasks.entries()) {
    let passes = 0;
    for (let trial = 1; trial <= args.trials; trial++) {
      const transcriptPath =
        transcriptRunDir === undefined
          ? undefined
          : join(
              transcriptRunDir,
              `task-${taskIndex + 1}-trial-${trial}.jsonl`,
            );
      const result = await runTrial(
        task,
        args.cliEntry,
        providerSelection,
        transcriptPath,
      );
      const skillRouting = evaluateSkillRouting(task, result.report);
      const outcome = routingAwareOutcome(result.outcome, skillRouting);
      const pass = outcome === "verified";
      if (pass) passes++;
      const resultLine: ResultLine = {
        schemaVersion: 1,
        timestamp: new Date().toISOString(),
        keelVersion: version,
        taskId: task.id,
        trial,
        pass,
        outcome,
        wallMs: result.wallMs,
        ...(skillRouting !== undefined ? { skillRouting } : {}),
        ...(result.report !== undefined ? { report: result.report } : {}),
        ...(result.transcriptPath !== undefined
          ? { transcriptPath: result.transcriptPath }
          : {}),
      };
      const appended = appendResultLine(args.outFile, resultLine);
      if (!appended) return 1;
      resultLines.push(resultLine);
      process.stderr.write(
        `[${task.id}] trial ${trial}: ${outcome} (${result.wallMs}ms)\n`,
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
  process.stdout.write(renderSkillRoutingSummary(resultLines));
  process.stdout.write(renderSkillValueSummary(resultLines));
  process.stdout.write(`results: ${args.outFile}\n`);
  return passingTrials === totalTrials ? 0 : 1;
}
