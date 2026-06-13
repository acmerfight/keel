import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { runCli } from "../../src/testing/cli-harness.ts";

const runReportSchema = z.object({
  schemaVersion: z.literal(1),
  provider: z.string(),
  model: z.string(),
  turns: z.number().int().positive(),
  stopReason: z.string(),
  usage: z.object({
    inputTokens: z.number(),
    cachedInputTokens: z.number(),
    uncachedInputTokens: z.number(),
    outputTokens: z.number(),
  }),
  durationMs: z.number().nonnegative(),
  costUsd: z.number().optional(),
});

describe("CLI Run Report", () => {
  test(`Given a user wants machine-readable run metrics,
    When the CLI finishes a task with --report,
    Then a structured report file records turns, stop reason, and token usage`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-report-"));
    await writeFile(join(workspace, "note.txt"), "hello old world\n", "utf8");
    const reportPath = join(workspace, "report.json");

    try {
      // When
      const result = await runCli(
        ["--report", reportPath, "replace old with new in note.txt"],
        { cwd: workspace, env: { KEEL_PROVIDER: "fake" } },
      );

      // Then
      expect(result.exitCode).toBe(0);
      expect(await readFile(join(workspace, "note.txt"), "utf8")).toBe(
        "hello new world\n",
      );
      const report = runReportSchema.parse(
        JSON.parse(await readFile(reportPath, "utf8")),
      );
      expect(report.provider).toBe("fake");
      expect(report.model).toBe("fake");
      expect(report.turns).toBe(2);
      expect(report.stopReason).toBe("completed");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a run without --report,
    When the CLI finishes,
    Then no report file is created and output is unchanged`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-no-report-"));

    try {
      // When
      const result = await runCli(["hello"], {
        cwd: workspace,
        env: { KEEL_PROVIDER: "fake" },
      });

      // Then
      expect(result.exitCode).toBe(0);
      await expect(
        readFile(join(workspace, "report.json"), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given --report is passed without a file path,
    When the user runs the CLI,
    Then the CLI exits with a validation error before contacting a provider`, async () => {
    // Given
    const args: readonly string[] = ["--report"];

    // When
    const result = await runCli(args, {
      env: { KEEL_PROVIDER: "deepseek", DEEPSEEK_API_KEY: "" },
    });

    // Then
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toBe("Error: --report requires a file path.\n");
  });

  test(`Given cost tracking is enabled alongside --report,
    When the CLI finishes a run,
    Then the report includes the spent cost`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-report-cost-"));
    const reportPath = join(workspace, "report.json");

    try {
      // When
      const result = await runCli(
        ["--max-cost", "1", "--report", reportPath, "hello"],
        { cwd: workspace, env: { KEEL_PROVIDER: "fake" } },
      );

      // Then
      expect(result.exitCode).toBe(0);
      const report = runReportSchema.parse(
        JSON.parse(await readFile(reportPath, "utf8")),
      );
      expect(report.costUsd).toBe(0);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
