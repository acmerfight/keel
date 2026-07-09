import { describe, expect, test } from "vitest";
import {
  close,
  createServer,
  getPort,
  join,
  listen,
  mkdtemp,
  readFile,
  rm,
  runCli,
  runReportSchema,
  sseTextReplyWithUsage,
  tmpdir,
} from "./fixtures.ts";

describe("CLI Run Report", () => {
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
      expect(report.modelsUsed).toEqual([
        { provider: "kimi", model: "kimi-k2.6" },
      ]);
      expect(report.costUsd).toBeGreaterThan(0);
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given Kimi stops because the provider output token limit is reached,
    When the CLI writes a run report,
    Then the report records provider_length instead of failing the run`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-cli-kimi-length-report-"),
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
          sseTextReplyWithUsage(
            "Partial from Kimi.",
            { promptTokens: 10, completionTokens: 5 },
            "length",
          ),
        );
      });
    });
    await listen(server);

    try {
      // When
      const result = await runCli(
        ["--report", reportPath, "write a long note"],
        {
          cwd: workspace,
          env: {
            KEEL_PROVIDER: "kimi",
            KIMI_API_KEY: "test-key",
            KIMI_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
            KIMI_MODEL: "kimi-k2.6",
          },
        },
      );

      // Then
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("Partial from Kimi.\n");
      const report = runReportSchema.parse(
        JSON.parse(await readFile(reportPath, "utf8")),
      );
      expect(report.modelsUsed).toEqual([
        { provider: "kimi", model: "kimi-k2.6" },
      ]);
      expect(report.stopReason).toBe("provider_length");
      expect(report.usage).toMatchObject({
        inputTokens: 10,
        outputTokens: 5,
      });
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
      expect(report.modelsUsed).toEqual([
        { provider: "qwen", model: "qwen3.7-max" },
      ]);
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
      expect(report.modelsUsed).toEqual([
        { provider: "qwen", model: "qwen3.7-plus" },
      ]);
      expect(report.usage.inputTokens).toBe(300_000);
      expect(report.costUsd).toBeCloseTo(0.84);
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
