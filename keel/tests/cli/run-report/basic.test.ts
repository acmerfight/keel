import { describe, expect, test } from "vitest";
import {
  join,
  mkdtemp,
  readFile,
  rm,
  runCli,
  runReportSchema,
  tmpdir,
  writeFile,
} from "./fixtures.ts";

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
      expect(report.modelsUsed).toEqual([{ provider: "fake", model: "fake" }]);
      expect(report.usageByModel).toEqual([
        {
          provider: "fake",
          model: "fake",
          turns: 3,
          usage: report.usage,
          costUsd: 0,
        },
      ]);
      expect(report.turns).toBe(3);
      expect(report.stopReason).toBe("completed");
      expect(report.costUsd).toBe(0);
      expect(result.stderr).toBe("Tool: read note.txt\nTool: edit note.txt\n");
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
