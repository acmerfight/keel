import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { Server } from "node:net";
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
    inputTokens: z.number().int().nonnegative(),
    cachedInputTokens: z.number().int().nonnegative(),
    uncachedInputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
  }),
  durationMs: z.number().nonnegative(),
  costUsd: z.number(),
});

function getPort(server: Server): number {
  const addr = server.address();
  if (addr === null || typeof addr === "string") {
    throw new Error("Server not listening on a TCP port");
  }
  return addr.port;
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function sseTextReplyWithUsage(
  text: string,
  usage: {
    readonly promptTokens: number;
    readonly completionTokens: number;
  } = { promptTokens: 10, completionTokens: 3 },
): string {
  return [
    `data: ${JSON.stringify({
      choices: [{ delta: { content: text } }],
    })}\n\n`,
    `data: ${JSON.stringify({
      choices: [{ delta: {}, finish_reason: "stop" }],
      usage: {
        prompt_tokens: usage.promptTokens,
        completion_tokens: usage.completionTokens,
      },
    })}\n\n`,
    "data: [DONE]\n\n",
  ].join("");
}

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
      expect(report.costUsd).toBe(0);
      expect(result.stderr).toBe("Tool: edit note.txt\n");
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

  test(`Given Kimi is selected with an explicit model,
    When the CLI writes a run report,
    Then the report records the Kimi provider and configured model`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-kimi-report-"));
    const reportPath = join(workspace, "report.json");
    const server = createServer((req, res) => {
      if (req.url !== "/chat/completions") {
        res.writeHead(404);
        res.end();
        return;
      }
      req.resume();
      req.on("end", () => {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.end(sseTextReplyWithUsage("Hello from Kimi."));
      });
    });
    await listen(server);

    try {
      // When
      const result = await runCli(["--report", reportPath, "hello"], {
        cwd: workspace,
        env: {
          KEEL_PROVIDER: "kimi",
          KIMI_API_KEY: "test-key",
          KIMI_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
          KIMI_MODEL: "kimi-k2.6",
        },
      });

      // Then
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("Hello from Kimi.\n");
      const report = runReportSchema.parse(
        JSON.parse(await readFile(reportPath, "utf8")),
      );
      expect(report.provider).toBe("kimi");
      expect(report.model).toBe("kimi-k2.6");
      expect(report.costUsd).toBeGreaterThan(0);
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given Qwen is selected with its default cost-supported model,
    When the CLI writes a run report,
    Then the report records the Qwen provider, model, and cost`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-cli-qwen-max-report-"),
    );
    const reportPath = join(workspace, "report.json");
    const server = createServer((req, res) => {
      if (req.url !== "/chat/completions") {
        res.writeHead(404);
        res.end();
        return;
      }
      req.resume();
      req.on("end", () => {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.end(sseTextReplyWithUsage("Hello from Qwen Max."));
      });
    });
    await listen(server);

    try {
      // When
      const result = await runCli(["--report", reportPath, "hello"], {
        cwd: workspace,
        env: {
          KEEL_PROVIDER: "qwen",
          DASHSCOPE_API_KEY: "test-key",
          QWEN_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
        },
      });

      // Then
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("Hello from Qwen Max.\n");
      const report = runReportSchema.parse(
        JSON.parse(await readFile(reportPath, "utf8")),
      );
      expect(report.provider).toBe("qwen");
      expect(report.model).toBe("qwen3.7-max");
      expect(report.costUsd).toBeGreaterThan(0);
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given Qwen is selected with a per-request tiered model,
    When the CLI writes a run report,
    Then the report cost uses the request's input-token tier`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-cli-qwen-plus-report-"),
    );
    const reportPath = join(workspace, "report.json");
    const server = createServer((req, res) => {
      if (req.url !== "/chat/completions") {
        res.writeHead(404);
        res.end();
        return;
      }
      req.resume();
      req.on("end", () => {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.end(
          sseTextReplyWithUsage("Hello from Qwen Plus.", {
            promptTokens: 300_000,
            completionTokens: 100_000,
          }),
        );
      });
    });
    await listen(server);

    try {
      // When
      const result = await runCli(["--report", reportPath, "hello"], {
        cwd: workspace,
        env: {
          KEEL_PROVIDER: "qwen",
          DASHSCOPE_API_KEY: "test-key",
          QWEN_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
          QWEN_MODEL: "qwen3.7-plus",
        },
      });

      // Then
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("Hello from Qwen Plus.\n");
      const report = runReportSchema.parse(
        JSON.parse(await readFile(reportPath, "utf8")),
      );
      expect(report.provider).toBe("qwen");
      expect(report.model).toBe("qwen3.7-plus");
      expect(report.usage.inputTokens).toBe(300_000);
      expect(report.costUsd).toBeCloseTo(0.84);
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given Qwen Flash crosses its higher per-request input-token tier,
    When the CLI writes a run report,
    Then the report cost uses the Qwen Flash high-tier pricing`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-cli-qwen-flash-report-"),
    );
    const reportPath = join(workspace, "report.json");
    const server = createServer((req, res) => {
      if (req.url !== "/chat/completions") {
        res.writeHead(404);
        res.end();
        return;
      }
      req.resume();
      req.on("end", () => {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.end(
          sseTextReplyWithUsage("Hello from Qwen Flash.", {
            promptTokens: 300_000,
            completionTokens: 10_000,
          }),
        );
      });
    });
    await listen(server);

    try {
      // When
      const result = await runCli(["--report", reportPath, "hello"], {
        cwd: workspace,
        env: {
          KEEL_PROVIDER: "qwen",
          DASHSCOPE_API_KEY: "test-key",
          QWEN_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
          QWEN_MODEL: "qwen3.6-flash",
        },
      });

      // Then
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("Hello from Qwen Flash.\n");
      const report = runReportSchema.parse(
        JSON.parse(await readFile(reportPath, "utf8")),
      );
      expect(report.provider).toBe("qwen");
      expect(report.model).toBe("qwen3.6-flash");
      expect(report.usage.inputTokens).toBe(300_000);
      expect(report.costUsd).toBeCloseTo(0.34);
    } finally {
      await close(server);
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
