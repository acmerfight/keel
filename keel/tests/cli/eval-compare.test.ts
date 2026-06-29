import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { runEvalCompareCommand } from "../../src/eval/compare.ts";
import {
  evalRunReport as report,
  evalResultLine as resultLine,
  writeEvalResultFile as writeResultFile,
} from "../../src/testing/eval-fixtures.ts";

interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
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

  test(`Given head has more harness failures but a lower harness failure rate,
    When the compare command summarizes the task,
    Then it reports the pass-rate improvement without regression transcripts`, async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "keel-eval-compare-rate-"));
    const baseFile = join(root, "base.jsonl");
    const headFile = join(root, "head.jsonl");
    await writeResultFile(baseFile, [
      resultLine({
        taskId: "more-reliable-head",
        trial: 1,
        pass: false,
        outcome: "crashed",
        transcriptPath: "/tmp/base/crashed.jsonl",
      }),
    ]);
    await writeResultFile(headFile, [
      resultLine({
        taskId: "more-reliable-head",
        trial: 1,
        pass: false,
        outcome: "crashed",
        transcriptPath: "/tmp/head/crashed-1.jsonl",
      }),
      resultLine({
        taskId: "more-reliable-head",
        trial: 2,
        pass: false,
        outcome: "timeout",
        transcriptPath: "/tmp/head/timeout-2.jsonl",
      }),
      resultLine({
        taskId: "more-reliable-head",
        trial: 3,
        pass: true,
      }),
      resultLine({
        taskId: "more-reliable-head",
        trial: 4,
        pass: true,
      }),
      resultLine({
        taskId: "more-reliable-head",
        trial: 5,
        pass: true,
      }),
    ]);

    try {
      // When
      const result = runCompare(baseFile, headFile);

      // Then
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("task: more-reliable-head");
      expect(result.stdout).toContain("status: IMPROVEMENT");
      expect(result.stdout).toContain(
        "pass: 0/1 (0.0%) -> 3/5 (60.0%) (+60.0pp)",
      );
      expect(result.stdout).toContain("head harness failures: 2");
      expect(result.stdout).not.toContain("regression transcripts:");
      expect(result.stdout).not.toContain("/tmp/head/crashed-1.jsonl");
      expect(result.stdout).not.toContain("/tmp/head/timeout-2.jsonl");
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
