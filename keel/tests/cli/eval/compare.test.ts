import { describe, expect, test } from "vitest";
import {
  join,
  mkdtemp,
  resultLine,
  rm,
  runCli,
  runReport,
  tmpdir,
  writeFile,
  writeResultFile,
} from "./fixtures.ts";

describe("CLI Eval", () => {
  test(`Given two eval result files where the new run regresses,
    When user compares the eval results,
    Then the CLI reports score and efficiency deltas with regression transcripts`, async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "keel-eval-compare-"));
    const baseFile = join(root, "base.jsonl");
    const headFile = join(root, "head.jsonl");

    await writeResultFile(baseFile, [
      resultLine({
        taskId: "edit-note",
        trial: 1,
        pass: true,
        report: runReport({ turns: 3, inputTokens: 100, outputTokens: 20 }),
        wallMs: 1000,
        transcriptPath: "/tmp/base/edit-note-1.jsonl",
      }),
      resultLine({
        taskId: "edit-note",
        trial: 2,
        pass: true,
        report: runReport({ turns: 3, inputTokens: 100, outputTokens: 20 }),
        wallMs: 1000,
        transcriptPath: "/tmp/base/edit-note-2.jsonl",
      }),
      resultLine({
        taskId: "stable-task",
        trial: 1,
        pass: true,
        report: runReport({
          turns: 2,
          inputTokens: 50,
          outputTokens: 10,
          costUsd: 0.0005,
          humanInterventions: 0,
        }),
        wallMs: 500,
      }),
      resultLine({
        taskId: "harness-task",
        trial: 1,
        pass: true,
        report: runReport({
          turns: 2,
          inputTokens: 60,
          outputTokens: 10,
          costUsd: 0.0006,
        }),
        wallMs: 700,
      }),
    ]);
    await writeResultFile(headFile, [
      resultLine({
        taskId: "edit-note",
        trial: 1,
        pass: true,
        report: runReport({
          turns: 4,
          inputTokens: 150,
          outputTokens: 30,
          costUsd: 0.002,
        }),
        wallMs: 1200,
        transcriptPath: "/tmp/head/edit-note-1.jsonl",
      }),
      resultLine({
        taskId: "edit-note",
        trial: 2,
        pass: false,
        report: runReport({
          turns: 4,
          inputTokens: 150,
          outputTokens: 30,
          costUsd: 0.002,
        }),
        wallMs: 1200,
        transcriptPath: "/tmp/head/edit-note-2.jsonl",
      }),
      resultLine({
        taskId: "stable-task",
        trial: 1,
        pass: true,
        report: runReport({
          turns: 2,
          inputTokens: 50,
          outputTokens: 10,
          costUsd: 0.0005,
          humanInterventions: 1,
        }),
        wallMs: 500,
      }),
      resultLine({
        taskId: "harness-task",
        trial: 1,
        pass: false,
        outcome: "timeout",
        wallMs: 5000,
        transcriptPath: "/tmp/head/harness-task-1.jsonl",
      }),
    ]);

    try {
      // When
      const result = await runCli(
        ["eval", "compare", "--base", baseFile, "--head", headFile],
        {
          cwd: root,
          env: { KEEL_PROVIDER: "unknown" },
          timeoutMs: 60_000,
        },
      );

      // Then
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("Eval comparison:");
      expect(result.stdout).toContain(`base: ${baseFile}`);
      expect(result.stdout).toContain(`head: ${headFile}`);
      expect(result.stdout).toContain("task: edit-note");
      expect(result.stdout).toContain("status: REGRESSION");
      expect(result.stdout).toContain(
        "pass: 2/2 (100.0%) -> 1/2 (50.0%) (-50.0pp)",
      );
      expect(result.stdout).toContain("turns avg: 3.0 -> 4.0 (+1.0)");
      expect(result.stdout).toContain(
        "human interventions avg: 0.0 -> 0.0 (+0.0)",
      );
      expect(result.stdout).toContain(
        "input tokens avg: 100.0 -> 150.0 (+50.0)",
      );
      expect(result.stdout).toContain(
        "output tokens avg: 20.0 -> 30.0 (+10.0)",
      );
      expect(result.stdout).toContain(
        "cost avg: $0.001000 -> $0.002000 (+$0.001000)",
      );
      expect(result.stdout).toContain("wall avg: 1000ms -> 1200ms (+200ms)");
      expect(result.stdout).toContain("regression transcripts:");
      expect(result.stdout).toContain("/tmp/head/edit-note-2.jsonl");
      expect(result.stdout).toContain("task: stable-task");
      expect(result.stdout).toContain("status: INTERVENTION REGRESSION");
      expect(result.stdout).toContain(
        "human interventions avg: 0.0 -> 1.0 (+1.0)",
      );
      expect(result.stdout).toContain("task: harness-task");
      expect(result.stdout).toContain("status: HARNESS FAILURE");
      expect(result.stdout).toContain("head harness failures: 1");
      expect(result.stdout).toContain("/tmp/head/harness-task-1.jsonl");
      expect(result.stdout).toContain(
        "suite pass: 4/4 (100.0%) -> 2/4 (50.0%) (-50.0pp)",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test(`Given one eval result file has invalid JSONL,
    When user compares the eval results,
    Then the CLI exits with an error naming the bad line`, async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "keel-eval-compare-invalid-"));
    const baseFile = join(root, "base.jsonl");
    const headFile = join(root, "head.jsonl");
    await writeFile(baseFile, "not-json\n", "utf8");
    await writeResultFile(headFile, [
      resultLine({
        taskId: "edit-note",
        trial: 1,
        pass: true,
        report: runReport(),
      }),
    ]);

    try {
      // When
      const result = await runCli(
        ["eval", "compare", "--base", baseFile, "--head", headFile],
        { cwd: root, env: { KEEL_PROVIDER: "unknown" } },
      );

      // Then
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(baseFile);
      expect(result.stderr).toContain("line 1 is not valid JSON");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test.each([
    {
      contradiction: "a passing trial has a crashed outcome",
      fields: {
        condition: "standard",
        requiredToPass: true,
        pass: true,
        outcome: "crashed",
      },
    },
    {
      contradiction: "a verified trial is marked as failed",
      fields: {
        condition: "standard",
        requiredToPass: true,
        pass: false,
        outcome: "verified",
      },
    },
    {
      contradiction: "a standard trial is not required to pass",
      fields: {
        condition: "standard",
        requiredToPass: false,
        pass: true,
        outcome: "verified",
      },
    },
    {
      contradiction: "a memory-disabled trial is required to pass",
      fields: {
        condition: "memory_disabled",
        requiredToPass: true,
        pass: false,
        outcome: "verify_failed",
      },
    },
  ])(
    `Given an eval result where $contradiction,
    When user compares it with a current result file,
    Then the CLI rejects the contradictory result line`,
    async ({ fields }) => {
      // Given
      const root = await mkdtemp(
        join(tmpdir(), "keel-eval-compare-contradictory-"),
      );
      const baseFile = join(root, "base.jsonl");
      const headFile = join(root, "head.jsonl");
      await writeFile(
        baseFile,
        `${JSON.stringify({
          schemaVersion: 2,
          timestamp: "2026-06-22T00:00:00.000Z",
          keelVersion: "0.0.1",
          taskId: "contradictory-result",
          trial: 1,
          ...fields,
          wallMs: 1000,
        })}\n`,
        "utf8",
      );
      await writeResultFile(headFile, [
        resultLine({
          taskId: "contradictory-result",
          trial: 1,
          pass: true,
        }),
      ]);

      try {
        // When
        const result = await runCli(
          ["eval", "compare", "--base", baseFile, "--head", headFile],
          { cwd: root, env: { KEEL_PROVIDER: "unknown" } },
        );

        // Then
        expect(result.exitCode).not.toBe(0);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain(baseFile);
        expect(result.stderr).toContain(
          "line 1 is not a schemaVersion 2 eval result",
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  test(`Given an eval result contains an obsolete v1 run report,
    When user compares it with a current result file,
    Then the CLI rejects the old report schema`, async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "keel-eval-compare-old-report-"));
    const baseFile = join(root, "base.jsonl");
    const headFile = join(root, "head.jsonl");
    await writeFile(
      baseFile,
      `${JSON.stringify({
        schemaVersion: 2,
        timestamp: "2026-06-22T00:00:00.000Z",
        keelVersion: "0.0.1",
        taskId: "old-report",
        trial: 1,
        condition: "standard",
        requiredToPass: true,
        pass: true,
        outcome: "verified",
        wallMs: 1000,
        report: {
          schemaVersion: 1,
          provider: "deepseek",
          model: "deepseek-v4-flash",
          turns: 2,
          stopReason: "completed",
          usage: {
            inputTokens: 20,
            cachedInputTokens: 0,
            uncachedInputTokens: 20,
            outputTokens: 4,
          },
          durationMs: 900,
          costUsd: 0.001,
        },
      })}\n`,
      "utf8",
    );
    await writeResultFile(headFile, [
      resultLine({
        taskId: "old-report",
        trial: 1,
        pass: true,
        report: runReport(),
      }),
    ]);

    try {
      // When
      const result = await runCli(
        ["eval", "compare", "--base", baseFile, "--head", headFile],
        { cwd: root, env: { KEEL_PROVIDER: "unknown" } },
      );

      // Then
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(baseFile);
      expect(result.stderr).toContain(
        "line 1 is not a schemaVersion 2 eval result",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
