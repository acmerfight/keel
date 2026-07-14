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
  runCliProcess,
  runReportSchema,
  sseTextReplyWithUsage,
  tmpdir,
  withTimeout,
} from "./fixtures.ts";

describe("CLI Run Report", () => {
  test(`Given an interactive run only handles local commands,
    When it exits with --report before any provider turn,
    Then Keel still writes a zero-usage machine-readable report`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-cli-zero-turn-report-"),
    );
    const reportPath = join(workspace, "session-report.json");
    const { child, result } = runCliProcess(["--report", reportPath], {
      cwd: workspace,
      env: { KEEL_PROVIDER: "fake", KEEL_FORCE_INTERACTIVE: "1" },
      stdin: "pipe",
    });

    try {
      // When
      child.stdin?.end("/status\n");
      const exit = await withTimeout(
        result,
        5000,
        "zero-turn interactive CLI did not finish after stdin closed",
      );

      // Then
      expect(exit.exitCode).toBe(0);
      const report = runReportSchema.parse(
        JSON.parse(await readFile(reportPath, "utf8")),
      );
      expect(report.modelsUsed).toEqual([]);
      expect(report.usageByModel).toEqual([]);
      expect(report.agentLoopTurns).toBe(0);
      expect(report.tasks).toEqual([]);
      expect(report.stopReason).toBe("completed");
      expect(report.usage).toEqual({
        inputTokens: 0,
        cachedInputTokens: 0,
        uncachedInputTokens: 0,
        outputTokens: 0,
      });
      expect(report.costUsd).toBe(0);
    } finally {
      child.kill("SIGKILL");
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a user wants machine-readable interactive session metrics,
    When the interactive CLI finishes multiple prompts with --report,
    Then a structured report file records the whole session`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-session-report-"));
    const reportPath = join(workspace, "session-report.json");
    const { child, result } = runCliProcess(["--report", reportPath], {
      cwd: workspace,
      env: { KEEL_PROVIDER: "fake", KEEL_FORCE_INTERACTIVE: "1" },
      stdin: "pipe",
    });

    try {
      // When
      child.stdin?.end("remember alpha\nwhat did I ask you to remember?\n");

      // Then
      const exit = await withTimeout(
        result,
        5000,
        "interactive CLI did not finish after stdin closed",
      );
      expect(exit.exitCode).toBe(0);
      expect(exit.stderr).toBe("");
      expect(exit.stdout).toContain("Remembered: remember alpha\n");
      expect(exit.stdout).toContain("Earlier you said: remember alpha\n");

      const report = runReportSchema.parse(
        JSON.parse(await readFile(reportPath, "utf8")),
      );
      expect(report.modelsUsed).toEqual([{ provider: "fake", model: "fake" }]);
      expect(report.usageByModel).toEqual([
        {
          provider: "fake",
          model: "fake",
          agentLoopTurns: 2,
          usage: report.usage,
          costUsd: 0,
        },
      ]);
      expect(report.agentLoopTurns).toBe(2);
      expect(report.tasks).toMatchObject([
        {
          ordinal: 1,
          trigger: "user_prompt",
          agentRuns: [{ ordinal: 1, trigger: "user_prompt" }],
          outcome: "completed",
        },
        {
          ordinal: 2,
          trigger: "user_prompt",
          agentRuns: [{ ordinal: 1, trigger: "user_prompt" }],
          outcome: "completed",
        },
      ]);
      expect(report.stopReason).toBe("completed");
      expect(report.usage).toEqual({
        inputTokens: 0,
        cachedInputTokens: 0,
        uncachedInputTokens: 0,
        outputTokens: 0,
      });
      expect(report.costUsd).toBe(0);
    } finally {
      child.kill("SIGKILL");
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an interactive session switches models after a reported turn,
    When the CLI writes a session report,
    Then the report records each model instead of one misleading model`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-cli-session-switch-report-"),
    );
    const reportPath = join(workspace, "session-report.json");
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
          sseTextReplyWithUsage("Hello from Qwen.", {
            promptTokens: 20,
            completionTokens: 4,
          }),
        );
      });
    });
    await listen(server);
    const { child, result } = runCliProcess(["--report", reportPath], {
      cwd: workspace,
      env: {
        KEEL_PROVIDER: "fake",
        KEEL_FORCE_INTERACTIVE: "1",
        DASHSCOPE_API_KEY: "test-key",
        QWEN_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
      },
      stdin: "pipe",
    });

    try {
      // When
      child.stdin?.end("remember alpha\n/model qwen/qwen3.7-plus\nhello\n");

      // Then
      const exit = await withTimeout(
        result,
        5000,
        "interactive CLI did not finish after switched stdin closed",
      );
      expect(exit.exitCode).toBe(0);
      expect(exit.stderr).toBe("");
      expect(exit.stdout).toContain("Remembered: remember alpha\n");
      expect(exit.stdout).toContain("Model switched to qwen/qwen3.7-plus\n");
      expect(exit.stdout).toContain("Hello from Qwen.");

      const report = runReportSchema.parse(
        JSON.parse(await readFile(reportPath, "utf8")),
      );
      expect(report.modelsUsed).toEqual([
        { provider: "fake", model: "fake" },
        { provider: "qwen", model: "qwen3.7-plus" },
      ]);
      expect(report.usageByModel).toMatchObject([
        {
          provider: "fake",
          model: "fake",
          agentLoopTurns: 1,
        },
        {
          provider: "qwen",
          model: "qwen3.7-plus",
          agentLoopTurns: 1,
          usage: {
            inputTokens: 20,
            outputTokens: 4,
          },
        },
      ]);
      expect(report.agentLoopTurns).toBe(2);
    } finally {
      child.kill("SIGKILL");
      await close(server);
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
