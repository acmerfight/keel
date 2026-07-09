import { describe, expect, test } from "vitest";
import { join, mkdtemp, readFile, rm, runCli, tmpdir } from "./fixtures.ts";

describe("CLI Run Report", () => {
  test(`Given DeepSeek is selected with unknown model pricing,
    When the CLI is asked to write a run report,
    Then it rejects the run before writing misleading cost data`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-cli-deepseek-report-cost-model-"),
    );
    const reportPath = join(workspace, "report.json");

    try {
      // When
      const result = await runCli(
        [
          "--provider",
          "deepseek",
          "--model",
          "deepseek-unknown",
          "--report",
          reportPath,
          "hello",
        ],
        {
          cwd: workspace,
          env: {
            DEEPSEEK_API_KEY: "test-key",
          },
        },
      );

      // Then
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe(
        'Error: cost tracking is only supported for known DeepSeek model pricing; configured --model="deepseek-unknown".\n',
      );
      await expect(readFile(reportPath, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given Qwen is configured with an unknown cost model,
    When the CLI is asked to write a run report,
    Then it rejects the run before writing misleading cost data`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-qwen-report-"));
    const reportPath = join(workspace, "report.json");

    try {
      // When
      const result = await runCli(["--report", reportPath, "hello"], {
        cwd: workspace,
        env: {
          KEEL_PROVIDER: "qwen",
          DASHSCOPE_API_KEY: "test-key",
          QWEN_MODEL: "qwen-unknown",
        },
      });

      // Then
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe(
        'Error: cost tracking is only supported for known Qwen model pricing; configured QWEN_MODEL="qwen-unknown".\n',
      );
      await expect(readFile(reportPath, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given Kimi is configured with an unsupported cost model,
    When the CLI is asked to write a run report,
    Then it rejects the run before writing misleading cost data`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-cli-kimi-report-cost-model-"),
    );
    const reportPath = join(workspace, "report.json");

    try {
      // When
      const result = await runCli(["--report", reportPath, "hello"], {
        cwd: workspace,
        env: {
          KEEL_PROVIDER: "kimi",
          KIMI_API_KEY: "test-key",
          KIMI_MODEL: "kimi-k2.5",
        },
      });

      // Then
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe(
        'Error: cost tracking is only supported for Kimi model "kimi-k2.6"; configured KIMI_MODEL="kimi-k2.5".\n',
      );
      await expect(readFile(reportPath, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
