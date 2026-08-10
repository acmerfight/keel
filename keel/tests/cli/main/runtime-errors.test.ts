import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, test } from "vitest";
import { runCliMain } from "../../../src/cli/index.ts";
import { KeelError } from "../../../src/core/error.ts";
import { runReportSchema } from "../../../src/eval/report-schema.ts";
import { createRuntime } from "../../../src/testing/cli-runtime-fixtures.ts";
import {
  close,
  getPort,
  listen,
  sseToolCall,
  sseToolFinish,
} from "../../../src/testing/provider-sse-fixtures.ts";

function expectNoCrashOutput(stderr: string): void {
  expect(stderr).not.toContain(" at ");
  expect(stderr).not.toContain("Node.js v");
  expect(stderr).not.toContain("KeelError:");
}

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

interface ProcessResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

function processExitCode(
  error: { readonly code?: unknown } | null,
  exitCode: number | null,
): number {
  if (typeof error?.code === "number") return error.code;
  if (exitCode !== null) return exitCode;
  return error === null ? 0 : 1;
}

function runNodeProcess(script: string): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      ["--experimental-strip-types", "--input-type=module", "-e", script],
      { cwd: process.cwd(), maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({
          stdout,
          stderr,
          exitCode: processExitCode(error, child.exitCode),
        });
      },
    );
  });
}

describe("CLI Main - Runtime Errors", () => {
  test.each([
    {
      name: "auth failure",
      status: 401,
      body: { error: { message: "bad key" } },
      stderr:
        'Error: DeepSeek API error (401): {"error":{"message":"bad key"}}\n',
    },
    {
      name: "model rejection",
      status: 400,
      body: { error: { message: "bad model" } },
      stderr:
        'Error: DeepSeek API error (400): {"error":{"message":"bad model"}}\n',
    },
  ])(
    `Given a provider returns $name,
    When the user runs a one-shot request,
    Then the CLI reports a clean provider error`,
    async ({ status, body, stderr }) => {
      // Given
      const server = createServer((req, res) => {
        req.resume();
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
      });
      await listen(server);
      const fixture = createRuntime(["hello"], {
        env: {
          DEEPSEEK_API_KEY: "test-key",
          DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
        },
      });

      try {
        // When
        const exitCode = await runCliMain(fixture.runtime);

        // Then
        expect(exitCode).toBe(1);
        expect(fixture.stdout()).toBe("");
        expect(fixture.stderr()).toBe(stderr);
        expectNoCrashOutput(fixture.stderr());
      } finally {
        await close(server);
      }
    },
  );

  test(`Given a provider emits an unsupported tool call,
    When the user runs a one-shot request,
    Then the CLI reports a clean provider protocol error`, async () => {
    // Given
    const server = createServer((req, res) => {
      req.resume();
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.end(
        [
          sseToolCall("bad_tool", "run", { command: "ls" }),
          sseToolFinish(),
          "data: [DONE]\n\n",
        ].join(""),
      );
    });
    await listen(server);
    const fixture = createRuntime(["hello"], {
      env: {
        DEEPSEEK_API_KEY: "test-key",
        DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
      },
    });

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(1);
      expect(fixture.stdout()).toBe("");
      expect(fixture.stderr()).toBe(
        "Error: DeepSeek returned unsupported tool call: run\n",
      );
      expectNoCrashOutput(fixture.stderr());
    } finally {
      await close(server);
    }
  });

  test.each([
    {
      name: "auth failure",
      status: 401,
      body: { error: { message: "bad key interactive" } },
      stderr:
        'Error: DeepSeek API error (401): {"error":{"message":"bad key interactive"}}\n',
    },
    {
      name: "model rejection",
      status: 400,
      body: { error: { message: "bad model interactive" } },
      stderr:
        'Error: DeepSeek API error (400): {"error":{"message":"bad model interactive"}}\n',
    },
  ])(
    `Given a provider returns $name during an interactive session,
    When the user submits a prompt,
    Then the CLI reports a clean provider error`,
    async ({ status, body, stderr }) => {
      // Given
      const server = createServer((req, res) => {
        req.resume();
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
      });
      await listen(server);
      const input = new PassThrough();
      input.end("hello\n");
      const fixture = createRuntime([], {
        env: {
          KEEL_FORCE_INTERACTIVE: "1",
          DEEPSEEK_API_KEY: "test-key",
          DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
        },
        input,
      });

      try {
        // When
        const exitCode = await runCliMain(fixture.runtime);

        // Then
        expect(exitCode).toBe(1);
        expect(fixture.stdout()).toBe("");
        expect(fixture.stderr()).toBe(stderr);
        expectNoCrashOutput(fixture.stderr());
      } finally {
        await close(server);
      }
    },
  );

  test(`Given a provider emits an unsupported tool call during an interactive session,
    When the user submits a prompt,
    Then the CLI reports a clean provider protocol error`, async () => {
    // Given
    const server = createServer((req, res) => {
      req.resume();
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.end(
        [
          sseToolCall("bad_tool", "run", { command: "ls" }),
          sseToolFinish(),
          "data: [DONE]\n\n",
        ].join(""),
      );
    });
    await listen(server);
    const input = new PassThrough();
    input.end("hello\n");
    const fixture = createRuntime([], {
      env: {
        KEEL_FORCE_INTERACTIVE: "1",
        DEEPSEEK_API_KEY: "test-key",
        DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
      },
      input,
    });

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(1);
      expect(fixture.stdout()).toBe("");
      expect(fixture.stderr()).toBe(
        "Error: DeepSeek returned unsupported tool call: run\n",
      );
      expectNoCrashOutput(fixture.stderr());
    } finally {
      await close(server);
    }
  });

  test(`Given a report path is under a missing directory,
    When the user requests a one-shot report,
    Then the CLI reports a clean report write error`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-report-error-"));
    const reportPath = join(workspace, "missing", "report.json");
    const fixture = createRuntime(["--report", reportPath, "hello"], {
      cwd: workspace,
      env: { KEEL_PROVIDER: "fake" },
    });

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(1);
      expect(fixture.stdout()).toBe("Hello from fake provider.\n");
      expect(fixture.stderr()).toBe(
        `Error: cannot write report to ${reportPath}: ENOENT: no such file or directory, open '${reportPath}'\n`,
      );
      expectNoCrashOutput(fixture.stderr());
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a one-shot provider failure contains secret-like text,
    When the user requested a report,
    Then the CLI exits non-zero and writes a redacted failure report`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-failure-report-"));
    const reportPath = join(workspace, "report.json");
    const secret = "sk-provider-report-secret";
    const providerMessage = `${secret} ${"x".repeat(2_200)}`;
    const server = createServer((req, res) => {
      req.resume();
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: providerMessage } }));
    });
    await listen(server);
    const fixture = createRuntime(
      ["--max-cost", "0.01", "--report", reportPath, "hello"],
      {
        cwd: workspace,
        env: {
          DEEPSEEK_API_KEY: "test-key",
          DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
        },
      },
    );

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(1);
      expect(fixture.stderr()).toContain("DeepSeek API error (400)");
      const report = runReportSchema.parse(
        JSON.parse(await readFile(reportPath, "utf8")),
      );
      expect(report.failure?.category).toBe("provider_http_error");
      expect(report.failure?.message).toContain("[REDACTED_SECRET]");
      expect(report.failure?.message).toHaveLength(2_000);
      expect(report.failure?.message.endsWith("...")).toBe(true);
      expect(report.stopReason).toBe("failed");
      expect(report.costBudgetUsd).toBe(0.01);
      expect(report.tasks).toMatchObject([
        {
          outcome: "failed",
          agentRuns: [{ stopReason: "failed" }],
        },
      ]);
      expect(report.modelOperations).toMatchObject([
        {
          outcome: "terminal_error",
          providerRequestAttempts: [
            { outcome: "terminal_error", errorCode: "provider_http_error" },
          ],
        },
      ]);
      expect(JSON.stringify(report)).not.toContain(secret);
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given failure-report writing also fails,
    When the provider request has already failed,
    Then the report diagnostic does not replace the original provider error`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-double-failure-"));
    const reportPath = join(workspace, "missing", "report.json");
    const server = createServer((req, res) => {
      req.resume();
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ error: { message: "original provider failure" } }),
      );
    });
    await listen(server);
    const fixture = createRuntime(["--report", reportPath, "hello"], {
      cwd: workspace,
      env: {
        DEEPSEEK_API_KEY: "test-key",
        DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
      },
    });

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(1);
      expect(fixture.stderr()).toContain(
        `Error: cannot write report to ${reportPath}`,
      );
      expect(fixture.stderr()).toContain(
        'Error: DeepSeek API error (400): {"error":{"message":"original provider failure"}}\n',
      );
      expectNoCrashOutput(fixture.stderr());
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test.each([
    {
      sessionKind: "saved",
      sessionArgs: ["--session", "failure-report"],
      expectedFailure: {
        category: "provider_network_error",
        message: "DeepSeek stream failed",
        sessionId: "failure-report",
      },
    },
    {
      sessionKind: "ephemeral",
      sessionArgs: ["--ephemeral"],
      expectedFailure: {
        category: "provider_network_error",
        message: "DeepSeek stream failed",
      },
    },
  ] as const)(
    `Given a $sessionKind interactive stream fails after visible output,
    When the user requested a report,
    Then Keel does not replay the request and preserves the failed run report`,
    async ({ sessionArgs, expectedFailure }) => {
      // Given
      const workspace = await mkdtemp(
        join(tmpdir(), "keel-cli-stream-report-"),
      );
      const home = await mkdtemp(join(tmpdir(), "keel-cli-stream-home-"));
      const reportPath = join(workspace, "report.json");
      let requests = 0;
      const server = createServer((req, res) => {
        requests++;
        req.resume();
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.write(
          `data: ${JSON.stringify({
            choices: [{ delta: { content: "partial answer" } }],
          })}\n\n`,
        );
        setImmediate(() => res.destroy());
      });
      await listen(server);
      const input = new PassThrough();
      input.end("hello\n");
      const fixture = createRuntime(
        [
          ...sessionArgs,
          "--max-cost",
          "0.01",
          "--report",
          reportPath,
          "--no-skills",
          "--no-memory",
        ],
        {
          cwd: workspace,
          env: {
            KEEL_FORCE_INTERACTIVE: "1",
            KEEL_HOME: home,
            DEEPSEEK_API_KEY: "test-key",
            DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
          },
          input,
        },
      );

      try {
        // When
        const exitCode = await runCliMain(fixture.runtime);

        // Then
        expect(exitCode).toBe(1);
        expect(requests).toBe(1);
        expect(fixture.stdout()).toContain("partial answer");
        expect(fixture.stderr()).toBe("Error: DeepSeek stream failed\n");
        const report = runReportSchema.parse(
          JSON.parse(await readFile(reportPath, "utf8")),
        );
        expect(report.failure).toEqual(expectedFailure);
        expect(report.costBudgetUsd).toBe(0.01);
        expect(report.providerRequestAttemptCount).toBe(1);
        expect(report.tasks).toMatchObject([
          {
            outcome: "failed",
            agentRuns: [{ stopReason: "failed" }],
          },
        ]);
      } finally {
        await close(server);
        await rm(workspace, { recursive: true, force: true });
        await rm(home, { recursive: true, force: true });
      }
    },
  );

  test(`Given saved interactive report pricing is unknown before a request,
    When the user requested a report,
    Then Keel records the unexpected failure and closes the attempted run`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-config-report-"));
    const home = await mkdtemp(join(tmpdir(), "keel-cli-config-home-"));
    const reportPath = join(workspace, "report.json");
    const input = new PassThrough();
    input.end("hello\n");
    const fixture = createRuntime(
      [
        "--session",
        "config-failure-report",
        "--provider",
        "deepseek",
        "--model",
        "unpriced-model",
        "--report",
        reportPath,
        "--no-skills",
        "--no-memory",
      ],
      {
        cwd: workspace,
        env: {
          KEEL_FORCE_INTERACTIVE: "1",
          KEEL_HOME: home,
          DEEPSEEK_API_KEY: "test-key",
        },
        input,
      },
    );

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(1);
      expect(fixture.stderr()).toContain(
        'cost tracking is only supported for known DeepSeek model pricing; configured --model="unpriced-model".',
      );
      const report = runReportSchema.parse(
        JSON.parse(await readFile(reportPath, "utf8")),
      );
      expect(report.failure).toEqual({
        category: "unexpected_error",
        message: expect.stringContaining('configured --model="unpriced-model"'),
        sessionId: "config-failure-report",
      });
      expect(report.tasks).toMatchObject([
        {
          outcome: "failed",
          agentRuns: [{ agentLoopTurns: 0, stopReason: "failed" }],
        },
      ]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a headless Goal provider fails during activation,
    When the user requested a report,
    Then Keel preserves a failed Goal Task instead of losing the report`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-goal-report-"));
    const home = await mkdtemp(join(tmpdir(), "keel-cli-goal-home-"));
    const reportPath = join(workspace, "report.json");
    const server = createServer((req, res) => {
      req.resume();
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "goal provider failure" } }));
    });
    await listen(server);
    const fixture = createRuntime(
      [
        "goal",
        "--objective",
        "Record an interrupted Goal",
        "--verify",
        "true",
        "--session",
        "goal-failure-report",
        "--bash-policy",
        "trusted",
        "--provider",
        "deepseek",
        "--report",
        reportPath,
      ],
      {
        cwd: workspace,
        env: {
          DEEPSEEK_API_KEY: "test-key",
          DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
          KEEL_HOME: home,
        },
      },
    );

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(1);
      const report = runReportSchema.parse(
        JSON.parse(await readFile(reportPath, "utf8")),
      );
      expect(report.failure).toEqual({
        category: "provider_http_error",
        message: expect.stringContaining("goal provider failure"),
        sessionId: "goal-failure-report",
      });
      expect(report.tasks).toMatchObject([
        {
          trigger: "goal_activation",
          outcome: "failed",
          agentRuns: [{ trigger: "goal_activation", stopReason: "failed" }],
        },
      ]);
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a report path is under a missing directory,
    When the user requests an interactive report,
    Then the CLI reports a clean report write error`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-report-error-"));
    const reportPath = join(workspace, "missing", "report.json");
    const input = new PassThrough();
    input.end("hello\n");
    const fixture = createRuntime(["--report", reportPath], {
      cwd: workspace,
      env: { KEEL_FORCE_INTERACTIVE: "1", KEEL_PROVIDER: "fake" },
      input,
    });

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(1);
      expect(fixture.stdout()).toBe("Remembered: hello\n");
      expect(fixture.stderr()).toBe(
        `Error: cannot write report to ${reportPath}: ENOENT: no such file or directory, open '${reportPath}'\n`,
      );
      expectNoCrashOutput(fixture.stderr());
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the environment cannot be read,
    When the user starts an interactive session,
    Then the CLI reports a clean unexpected runtime error`, async () => {
    // Given
    const fixture = createRuntime([]);
    const runtime = {
      ...fixture.runtime,
      env: () => {
        throw new Error("environment lookup failed\n    at raw-stack.ts:1:1");
      },
    };

    // When
    const exitCode = await runCliMain(runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe(
      "Error: unexpected runtime failure: environment lookup failed\n",
    );
    expectNoCrashOutput(fixture.stderr());
  });

  test.each([
    {
      command: "auth status",
      args: ["auth", "status"],
      inputText: undefined,
    },
    {
      command: "config show",
      args: ["config", "show"],
      inputText: undefined,
    },
    {
      command: "provider setup",
      args: ["setup", "deepseek", "--with-api-key"],
      inputText: "provider-setup-secret\n",
    },
  ])(
    `Given provider storage environment lookup fails during $command,
    When the user runs the command,
    Then the shared CLI boundary reports the unexpected failure without leaking input`,
    async ({ args, inputText }) => {
      // Given
      const input = new PassThrough();
      if (inputText !== undefined) {
        input.end(inputText);
      }
      const fixture = createRuntime(args, { input });
      const runtime = {
        ...fixture.runtime,
        env: () => {
          throw new Error(
            "provider storage environment failed\n    at raw-stack.ts:1:1",
          );
        },
      };

      // When
      const exitCode = await runCliMain(runtime);

      // Then
      expect(exitCode).toBe(1);
      expect(fixture.stdout()).toBe("");
      expect(fixture.stderr()).toBe(
        "Error: unexpected runtime failure: provider storage environment failed\n",
      );
      expect(fixture.stderr()).not.toContain("provider-setup-secret");
      expectNoCrashOutput(fixture.stderr());
    },
  );

  test.each([
    {
      command: "workflow skill listing",
      args: ["skills"],
    },
    {
      command: "project approval listing",
      args: ["approvals"],
    },
    {
      command: "project memory listing",
      args: ["memory", "list"],
    },
    {
      command: "session listing",
      args: ["sessions"],
    },
    {
      command: "session detail",
      args: ["sessions", "show", "demo"],
    },
    {
      command: "session fork",
      args: ["sessions", "fork", "source", "target"],
    },
    {
      command: "external session fork-point listing",
      args: ["--resume", "demo", "--fork-points"],
    },
    {
      command: "headless Goal approval preflight",
      args: [
        "goal",
        "--objective",
        "verify the workspace",
        "--verify",
        "pnpm test",
        "--bash-policy",
        "ask",
      ],
    },
  ])(
    `Given workspace lookup fails during $command,
    When the user runs the command,
    Then the shared CLI boundary reports the unexpected failure without a stack trace`,
    async ({ args }) => {
      // Given
      const home = await mkdtemp(
        join(tmpdir(), "keel-cli-command-error-home-"),
      );
      const fixture = createRuntime(args, {
        env: {
          KEEL_HOME: home,
        },
      });
      const runtime = {
        ...fixture.runtime,
        cwd: () => {
          throw new Error(
            "command workspace lookup failed\n    at raw-stack.ts:1:1",
          );
        },
      };

      try {
        // When
        const exitCode = await runCliMain(runtime);

        // Then
        expect(exitCode).toBe(1);
        expect(fixture.stdout()).toBe("");
        expect(fixture.stderr()).toBe(
          "Error: unexpected runtime failure: command workspace lookup failed\n",
        );
        expectNoCrashOutput(fixture.stderr());
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    },
  );

  test(`Given startup is aborted before command dispatch,
    When the user starts an interactive session,
    Then the CLI exits as interrupted without crash output`, async () => {
    // Given
    const fixture = createRuntime([]);
    const runtime = {
      ...fixture.runtime,
      env: () => {
        throw abortError("environment lookup aborted");
      },
    };

    // When
    const exitCode = await runCliMain(runtime);

    // Then
    expect(exitCode).toBe(130);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe("");
  });

  test(`Given interactive startup is aborted,
    When the user starts an interactive session,
    Then the CLI exits as interrupted without crash output`, async () => {
    // Given
    const fixture = createRuntime([], {
      env: { KEEL_FORCE_INTERACTIVE: "1" },
    });
    const runtime = {
      ...fixture.runtime,
      cwd: () => {
        throw abortError("workspace lookup aborted");
      },
    };

    // When
    const exitCode = await runCliMain(runtime);

    // Then
    expect(exitCode).toBe(130);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe("");
  });

  test(`Given the CLI process has a fatal runtime failure,
    When stderr is piped,
    Then the user sees the complete clean error before exit`, async () => {
    // Given
    const bodyLength = 200_000;
    const script = `
      import { exitWithCliRuntimeError } from "./src/cli/runtime.ts";

      process.on("uncaughtException", exitWithCliRuntimeError);
      setImmediate(() => {
        throw new Error("fatal-pipe-" + "x".repeat(${bodyLength}) + "-done");
      });
    `;

    // When
    const result = await runNodeProcess(script);

    // Then
    const prefix = "Error: unexpected runtime failure: fatal-pipe-";
    const suffix = "-done\n";
    const expectedLength =
      "Error: unexpected runtime failure: ".length +
      "fatal-pipe-".length +
      bodyLength +
      "-done".length +
      1;
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.length).toBe(expectedLength);
    expect(result.stderr.startsWith(prefix)).toBe(true);
    expect(result.stderr.endsWith(suffix)).toBe(true);
    expectNoCrashOutput(result.stderr);
  });

  test.each([
    {
      name: "recovery guidance",
      error: new KeelError(
        "provider_network_error",
        "temporary provider outage",
        "Retry after checking the provider status page.",
      ),
      stderr:
        "Error: temporary provider outage\nRecovery: Retry after checking the provider status page.\n",
    },
    {
      name: "existing error prefix",
      error: new KeelError("provider_network_error", "Error: upstream failed"),
      stderr: "Error: upstream failed\n",
    },
  ])(
    `Given startup fails with $name,
    When the user runs a one-shot request,
    Then the CLI preserves the clean error text`,
    async ({ error, stderr }) => {
      // Given
      const fixture = createRuntime(["hello"], {
        env: { KEEL_PROVIDER: "fake" },
      });
      const runtime = {
        ...fixture.runtime,
        cwd: () => {
          throw error;
        },
      };

      // When
      const exitCode = await runCliMain(runtime);

      // Then
      expect(exitCode).toBe(1);
      expect(fixture.stdout()).toBe("");
      expect(fixture.stderr()).toBe(stderr);
      expectNoCrashOutput(fixture.stderr());
    },
  );
});
