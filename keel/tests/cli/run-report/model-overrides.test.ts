import { describe, expect, test } from "vitest";
import {
  close,
  createServer,
  getPort,
  join,
  listen,
  mkdtemp,
  readFile,
  requestModelSchema,
  rm,
  runCli,
  runReportSchema,
  sseTextReplyWithUsage,
  tmpdir,
} from "./fixtures.ts";

describe("CLI Run Report", () => {
  test(`Given provider and model flags override provider env,
    When the CLI writes a run report,
    Then the selected provider and model are used end-to-end`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-provider-model-"));
    const reportPath = join(workspace, "report.json");
    let capturedModel: string | undefined;
    const server = createServer((req, res) => {
      if (req.url !== "/chat/completions") {
        res.writeHead(404);
        res.end();
        return;
      }
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        capturedModel = requestModelSchema.parse(JSON.parse(body)).model;
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.end(sseTextReplyWithUsage("Hello from selected Qwen."));
      });
    });
    await listen(server);

    try {
      // When
      const result = await runCli(
        [
          "--report",
          reportPath,
          "--provider",
          "qwen",
          "--model",
          "qwen3.7-plus",
          "hello",
        ],
        {
          cwd: workspace,
          env: {
            KEEL_PROVIDER: "fake",
            DASHSCOPE_API_KEY: "test-key",
            QWEN_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
          },
        },
      );

      // Then
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("Hello from selected Qwen.\n");
      expect(capturedModel).toBe("qwen3.7-plus");
      const report = runReportSchema.parse(
        JSON.parse(await readFile(reportPath, "utf8")),
      );
      expect(report.modelsUsed).toEqual([
        { provider: "qwen", model: "qwen3.7-plus" },
      ]);
      expect(report.costUsd).toBeGreaterThan(0);
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
      expect(report.modelsUsed).toEqual([
        { provider: "qwen", model: "qwen3.6-flash" },
      ]);
      expect(report.usage.inputTokens).toBe(300_000);
      expect(report.costUsd).toBeCloseTo(0.34);
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
