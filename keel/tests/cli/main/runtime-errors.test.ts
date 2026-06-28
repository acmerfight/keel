import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, test } from "vitest";
import { runCliMain } from "../../../src/cli/index.ts";
import { formatCliRuntimeError } from "../../../src/cli/runtime-error.ts";
import { KeelError } from "../../../src/core/error.ts";
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
  ])(`Given a provider returns $name,
    When the user runs a one-shot request,
    Then the CLI reports a clean provider error`, async ({
    status,
    body,
    stderr,
  }) => {
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
  });

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
  ])(`Given a provider returns $name during an interactive session,
    When the user submits a prompt,
    Then the CLI reports a clean provider error`, async ({
    status,
    body,
    stderr,
  }) => {
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
  });

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

  test(`Given a recoverable runtime error reaches the CLI formatter,
    When the error is formatted,
    Then the recovery guidance is preserved`, () => {
    // Given
    const error = new KeelError(
      "provider_network_error",
      "temporary provider outage",
      "Retry after checking the provider status page.",
    );

    // When
    const formatted = formatCliRuntimeError(error);

    // Then
    expect(formatted).toBe(
      "Error: temporary provider outage\nRecovery: Retry after checking the provider status page.\n",
    );
  });

  test(`Given a runtime error message already has the CLI error prefix,
    When the error is formatted,
    Then the prefix is not duplicated`, () => {
    // Given
    const error = new KeelError(
      "provider_network_error",
      "Error: upstream failed",
    );

    // When
    const formatted = formatCliRuntimeError(error);

    // Then
    expect(formatted).toBe("Error: upstream failed\n");
  });
});
