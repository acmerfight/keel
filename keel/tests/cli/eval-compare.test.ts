import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { runEvalCompareCommand } from "../../src/eval/compare.ts";

type TrialOutcome = "verified" | "verify_failed" | "timeout" | "crashed";

interface RunReport {
  readonly schemaVersion: 1;
  readonly provider: string;
  readonly model: string;
  readonly turns: number;
  readonly stopReason: string;
  readonly usage: {
    readonly inputTokens: number;
    readonly cachedInputTokens: number;
    readonly uncachedInputTokens: number;
    readonly outputTokens: number;
  };
  readonly durationMs: number;
  readonly costUsd: number;
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

interface ReportOptions {
  readonly turns?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly costUsd?: number;
}

interface ResultLineOptions {
  readonly taskId: string;
  readonly trial: number;
  readonly pass: boolean;
  readonly outcome?: TrialOutcome;
  readonly wallMs?: number;
  readonly report?: RunReport;
  readonly transcriptPath?: string;
}

interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

function report(options: ReportOptions = {}): RunReport {
  const inputTokens = options.inputTokens ?? 100;
  return {
    schemaVersion: 1,
    provider: "deepseek",
    model: "deepseek-v4-flash",
    turns: options.turns ?? 3,
    stopReason: "completed",
    usage: {
      inputTokens,
      cachedInputTokens: 0,
      uncachedInputTokens: inputTokens,
      outputTokens: options.outputTokens ?? 20,
    },
    durationMs: 1000,
    costUsd: options.costUsd ?? 0.001,
  };
}

function resultLine(options: ResultLineOptions): ResultLine {
  return {
    schemaVersion: 1,
    timestamp: "2026-06-22T00:00:00.000Z",
    keelVersion: "0.0.1",
    taskId: options.taskId,
    trial: options.trial,
    pass: options.pass,
    outcome:
      options.outcome ?? (options.pass === true ? "verified" : "verify_failed"),
    wallMs: options.wallMs ?? 1000,
    ...(options.report !== undefined ? { report: options.report } : {}),
    ...(options.transcriptPath !== undefined
      ? { transcriptPath: options.transcriptPath }
      : {}),
  };
}

async function writeResultFile(
  filePath: string,
  lines: readonly ResultLine[],
): Promise<void> {
  await writeFile(
    filePath,
    `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
    "utf8",
  );
}

function runCompare(baseFile: string, headFile: string): CommandResult {
  let stdout = "";
  let stderr = "";
  const writeStdout = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: string | Uint8Array) => {
      stdout += chunk.toString();
      return true;
    });
  const writeStderr = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((chunk: string | Uint8Array) => {
      stderr += chunk.toString();
      return true;
    });

  try {
    const exitCode = runEvalCompareCommand({ baseFile, headFile });
    return { exitCode, stdout, stderr };
  } finally {
    writeStdout.mockRestore();
    writeStderr.mockRestore();
  }
}

describe("Eval Compare", () => {
  test(`Given two eval result files with score and efficiency changes,
    When the compare command runs,
    Then it reports task statuses, metric deltas, and regression transcripts`, async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "keel-eval-compare-unit-"));
    const baseFile = join(root, "base.jsonl");
    const headFile = join(root, "head.jsonl");
    await writeResultFile(baseFile, [
      resultLine({
        taskId: "added-or-removed",
        trial: 1,
        pass: true,
        report: report(),
      }),
      resultLine({
        taskId: "efficiency-improved",
        trial: 1,
        pass: true,
        report: report({ turns: 5, inputTokens: 200, outputTokens: 40 }),
        wallMs: 900,
      }),
      resultLine({
        taskId: "efficiency-regressed",
        trial: 1,
        pass: true,
        report: report({ turns: 2, inputTokens: 50, outputTokens: 10 }),
        wallMs: 500,
      }),
      resultLine({
        taskId: "improved-score",
        trial: 1,
        pass: false,
      }),
      resultLine({
        taskId: "harness-failure",
        trial: 1,
        pass: true,
        report: report(),
      }),
      resultLine({
        taskId: "regressed-score",
        trial: 1,
        pass: true,
        report: report({ turns: 3, inputTokens: 100, outputTokens: 20 }),
        transcriptPath: "/tmp/base/regressed-score.jsonl",
      }),
      resultLine({
        taskId: "unchanged",
        trial: 1,
        pass: true,
        report: report(),
      }),
    ]);
    await writeResultFile(headFile, [
      resultLine({
        taskId: "brand-new",
        trial: 1,
        pass: true,
        report: report(),
      }),
      resultLine({
        taskId: "efficiency-improved",
        trial: 1,
        pass: true,
        report: report({ turns: 5, inputTokens: 200, outputTokens: 40 }),
        wallMs: 600,
      }),
      resultLine({
        taskId: "efficiency-regressed",
        trial: 1,
        pass: true,
        report: report({ turns: 2, inputTokens: 50, outputTokens: 10 }),
        wallMs: 800,
      }),
      resultLine({
        taskId: "improved-score",
        trial: 1,
        pass: true,
      }),
      resultLine({
        taskId: "harness-failure",
        trial: 1,
        pass: false,
        outcome: "timeout",
        report: report(),
        transcriptPath: "/tmp/head/harness-failure.jsonl",
      }),
      resultLine({
        taskId: "regressed-score",
        trial: 1,
        pass: false,
        report: report({ turns: 4, inputTokens: 150, outputTokens: 30 }),
        wallMs: 1200,
        transcriptPath: "/tmp/head/regressed-score.jsonl",
      }),
      resultLine({
        taskId: "unchanged",
        trial: 1,
        pass: true,
        report: report(),
      }),
    ]);

    try {
      // When
      const result = runCompare(baseFile, headFile);

      // Then
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("task: added-or-removed");
      expect(result.stdout).toContain("status: REMOVED");
      expect(result.stdout).toContain("task: brand-new");
      expect(result.stdout).toContain("status: ADDED");
      expect(result.stdout).toContain("task: improved-score");
      expect(result.stdout).toContain("status: IMPROVEMENT");
      expect(result.stdout).toContain("task: regressed-score");
      expect(result.stdout).toContain("status: REGRESSION");
      expect(result.stdout).toContain("/tmp/head/regressed-score.jsonl");
      expect(result.stdout).toContain("task: harness-failure");
      expect(result.stdout).toContain("status: HARNESS FAILURE");
      expect(result.stdout).toContain("head harness failures: 1");
      expect(result.stdout).toContain("/tmp/head/harness-failure.jsonl");
      expect(result.stdout).toContain("task: efficiency-regressed");
      expect(result.stdout).toContain("status: EFFICIENCY REGRESSION");
      expect(result.stdout).toContain("task: efficiency-improved");
      expect(result.stdout).toContain("status: EFFICIENCY IMPROVEMENT");
      expect(result.stdout).toContain("task: unchanged");
      expect(result.stdout).toContain("status: UNCHANGED");
      expect(result.stdout).toContain(
        "suite pass: 6/7 (85.7%) -> 5/7 (71.4%) (-14.3pp)",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test(`Given a task has repeated trials with lower head cost,
    When the compare command summarizes the task,
    Then it averages repeated trials and reports the negative cost delta`, async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "keel-eval-compare-trials-"));
    const baseFile = join(root, "base.jsonl");
    const headFile = join(root, "head.jsonl");
    await writeResultFile(baseFile, [
      resultLine({
        taskId: "cheaper-task",
        trial: 1,
        pass: true,
        report: report({ costUsd: 0.002 }),
      }),
      resultLine({
        taskId: "cheaper-task",
        trial: 2,
        pass: true,
        report: report({ costUsd: 0.002 }),
      }),
    ]);
    await writeResultFile(headFile, [
      resultLine({
        taskId: "cheaper-task",
        trial: 1,
        pass: true,
        report: report({ costUsd: 0.001 }),
      }),
      resultLine({
        taskId: "cheaper-task",
        trial: 2,
        pass: true,
        report: report({ costUsd: 0.001 }),
      }),
    ]);

    try {
      // When
      const result = runCompare(baseFile, headFile);

      // Then
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("task: cheaper-task");
      expect(result.stdout).toContain("status: EFFICIENCY IMPROVEMENT");
      expect(result.stdout).toContain(
        "cost avg: $0.002000 -> $0.001000 (-$0.001000)",
      );
      expect(result.stdout).toContain(
        "suite pass: 2/2 (100.0%) -> 2/2 (100.0%) (+0.0pp)",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test(`Given an eval result file has no usable result lines,
    When the compare command reads it,
    Then it reports the empty file instead of printing a comparison`, async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "keel-eval-compare-empty-"));
    const baseFile = join(root, "base.jsonl");
    const headFile = join(root, "head.jsonl");
    await writeFile(baseFile, "\n", "utf8");
    await writeResultFile(headFile, [
      resultLine({ taskId: "fix-note", trial: 1, pass: true }),
    ]);

    try {
      // When
      const result = runCompare(baseFile, headFile);

      // Then
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("has no result lines");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test(`Given an eval result line does not match the eval schema,
    When the compare command reads it,
    Then it reports the invalid schema line`, async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "keel-eval-compare-schema-"));
    const baseFile = join(root, "base.jsonl");
    const headFile = join(root, "head.jsonl");
    await writeFile(baseFile, '{"schemaVersion":1}\n', "utf8");
    await writeResultFile(headFile, [
      resultLine({ taskId: "fix-note", trial: 1, pass: true }),
    ]);

    try {
      // When
      const result = runCompare(baseFile, headFile);

      // Then
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("line 1 is not a schemaVersion 1");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test(`Given an eval result line is not JSON,
    When the compare command reads it,
    Then it reports the JSONL line number`, async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "keel-eval-compare-json-"));
    const baseFile = join(root, "base.jsonl");
    const headFile = join(root, "head.jsonl");
    await writeFile(baseFile, "not-json\n", "utf8");
    await writeResultFile(headFile, [
      resultLine({ taskId: "fix-note", trial: 1, pass: true }),
    ]);

    try {
      // When
      const result = runCompare(baseFile, headFile);

      // Then
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("line 1 is not valid JSON");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test(`Given the base eval result file does not exist,
    When the compare command reads it,
    Then it reports the unreadable file path`, async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "keel-eval-compare-missing-"));
    const baseFile = join(root, "missing.jsonl");
    const headFile = join(root, "head.jsonl");
    await writeResultFile(headFile, [
      resultLine({ taskId: "fix-note", trial: 1, pass: true }),
    ]);

    try {
      // When
      const result = runCompare(baseFile, headFile);

      // Then
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(baseFile);
      expect(result.stderr).toContain("cannot read eval result file");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
