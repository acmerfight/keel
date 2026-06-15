import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { type CliRuntime, runCliMain } from "../../src/cli/index.ts";
import { recordLastEditCheckpoint } from "../../src/core/git.ts";
import { runGit } from "../../src/testing/cli-harness.ts";

const runReportSchema = z.object({
  schemaVersion: z.literal(1),
  provider: z.string(),
  model: z.string(),
  costUsd: z.number(),
});

const requestWithMessagesSchema = z
  .object({
    messages: z
      .array(
        z
          .object({
            role: z.string().optional(),
            tool_call_id: z.string().optional(),
            content: z.string().nullable().optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

interface RuntimeFixture {
  readonly runtime: CliRuntime;
  readonly stdout: () => string;
  readonly stderr: () => string;
}

interface SigintCapture {
  handler: (() => void) | null;
}

function createRuntime(
  args: readonly string[],
  options: {
    readonly cwd?: string;
    readonly env?: Record<string, string>;
    readonly input?: PassThrough;
    readonly onSigint?: (handler: () => void) => void;
    readonly offSigint?: (handler: () => void) => void;
  } = {},
): RuntimeFixture {
  let stdout = "";
  let stderr = "";
  const input = options.input ?? new PassThrough();

  return {
    runtime: {
      args,
      cliEntry: join(process.cwd(), "src/cli/index.ts"),
      cwd: () => options.cwd ?? process.cwd(),
      env: (key) => options.env?.[key],
      input,
      platform: process.platform,
      now: () => 0,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
      },
      onSigint: options.onSigint ?? (() => {}),
      offSigint: options.offSigint ?? (() => {}),
      forceExit: (code) => {
        throw new Error(`unexpected forceExit(${code})`);
      },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

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

function sseData(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function sseToolCall(
  id: string,
  name: string,
  args: Record<string, unknown>,
): string {
  return sseData({
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              id,
              type: "function",
              function: {
                name,
                arguments: JSON.stringify(args),
              },
            },
          ],
        },
        finish_reason: null,
      },
    ],
    usage: null,
  });
}

function sseToolFinish(): string {
  return sseData({
    choices: [{ delta: {}, finish_reason: "tool_calls" }],
    usage: {
      prompt_tokens: 10,
      prompt_cache_hit_tokens: 0,
      prompt_cache_miss_tokens: 10,
      completion_tokens: 3,
    },
  });
}

function sseTextReplyWithUsage(
  text: string,
  usage: {
    readonly prompt_tokens: number;
    readonly completion_tokens: number;
  } = { prompt_tokens: 10, completion_tokens: 3 },
): string {
  return [
    `data: ${JSON.stringify({
      choices: [{ delta: { content: text } }],
    })}\n\n`,
    `data: ${JSON.stringify({
      choices: [{ delta: {}, finish_reason: "stop" }],
      usage: {
        prompt_tokens: usage.prompt_tokens,
        prompt_cache_hit_tokens: 0,
        prompt_cache_miss_tokens: usage.prompt_tokens,
        completion_tokens: usage.completion_tokens,
      },
    })}\n\n`,
    "data: [DONE]\n\n",
  ].join("");
}

describe("CLI Main", () => {
  test(`Given no user message and no interactive terminal,
    When the CLI main is invoked in-process,
    Then it returns usage instructions without starting a subprocess`, async () => {
    // Given
    const fixture = createRuntime([]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toContain("Usage: keel");
  });

  test(`Given a report option without a file path,
    When the CLI main parses the request,
    Then it returns a validation error before resolving a provider`, async () => {
    // Given
    const fixture = createRuntime(["--report"]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe("Error: --report requires a file path.\n");
  });

  test.each(["0", "abc"])(`Given invalid max cost value %s,
    When the CLI main parses the request,
    Then it returns a validation error before resolving a provider`, async (maxCost) => {
    // Given
    const fixture = createRuntime(["--max-cost", maxCost, "hello"], {
      env: { KEEL_PROVIDER: "deepseek", DEEPSEEK_API_KEY: "" },
    });

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe(
      "Error: --max-cost must be a positive number.\n",
    );
  });

  test(`Given an unknown eval option,
    When the CLI main parses the eval request,
    Then it returns an eval option validation error`, async () => {
    // Given
    const fixture = createRuntime(["eval", "--wat"]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe('Error: unknown eval option "--wat"\n');
  });

  test(`Given an eval option is missing its value,
    When the CLI main parses the eval request,
    Then it returns an option value validation error`, async () => {
    // Given
    const fixture = createRuntime(["eval", "--suite"]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe("Error: --suite requires a value.\n");
  });

  test(`Given an invalid eval trial count,
    When the CLI main parses the eval request,
    Then it returns a trial validation error`, async () => {
    // Given
    const fixture = createRuntime(["eval", "--trials", "0"]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe(
      "Error: --trials must be a positive integer.\n",
    );
  });

  test(`Given eval options are valid but the suite is missing,
    When the CLI main dispatches to the eval runner,
    Then it returns the eval configuration failure`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-main-eval-"));
    const fixture = createRuntime(
      [
        "eval",
        "--suite",
        join(workspace, "missing-suite"),
        "--out",
        join(workspace, "results.jsonl"),
        "--trials",
        "1",
        "--task",
        "fix-note",
        "--check",
      ],
      { cwd: workspace },
    );

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(1);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given eval runs without a task filter,
    When the CLI main dispatches to the eval runner,
    Then it omits the optional task selection`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-main-eval-all-"));
    const fixture = createRuntime(
      [
        "eval",
        "--suite",
        join(workspace, "missing-suite"),
        "--out",
        join(workspace, "results.jsonl"),
      ],
      { cwd: workspace },
    );

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(1);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given there is no edit checkpoint,
    When the CLI main dispatches undo,
    Then it returns the user-visible undo failure`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-main-undo-"));
    const fixture = createRuntime(["/undo"], { cwd: workspace });

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(1);
      expect(fixture.stdout()).toBe("");
      expect(fixture.stderr()).not.toBe("");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the user asks for diagnostics,
    When the CLI main dispatches the doctor command,
    Then it returns the diagnostic result`, async () => {
    // Given
    const fixture = createRuntime(["--doctor"]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(0);
    expect(fixture.stdout()).toContain("Keel doctor");
    expect(fixture.stderr()).toBe("");
  });

  test(`Given the last edit checkpoint can be restored,
    When the CLI main dispatches undo,
    Then it restores the file and reports the path`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-main-undo-ok-"));
    await runGit(workspace, ["init"]);
    await writeFile(join(workspace, "note.txt"), "after\n", "utf8");
    recordLastEditCheckpoint({
      workspace,
      filePath: join(workspace, "note.txt"),
      beforeContent: "before\n",
      afterContent: "after\n",
    });
    const fixture = createRuntime(["/undo"], { cwd: workspace });

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(0);
      expect(await readFile(join(workspace, "note.txt"), "utf8")).toBe(
        "before\n",
      );
      expect(fixture.stdout()).toContain("Restored note.txt\n");
      expect(fixture.stderr()).toBe("");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the last edit checkpoint no longer matches the file,
    When the CLI main dispatches undo,
    Then it refuses to overwrite the user's newer changes`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-cli-main-undo-blocked-"),
    );
    await runGit(workspace, ["init"]);
    await writeFile(join(workspace, "note.txt"), "after\n", "utf8");
    recordLastEditCheckpoint({
      workspace,
      filePath: join(workspace, "note.txt"),
      beforeContent: "before\n",
      afterContent: "after\n",
    });
    await writeFile(join(workspace, "note.txt"), "newer change\n", "utf8");
    const fixture = createRuntime(["/undo"], { cwd: workspace });

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(1);
      expect(await readFile(join(workspace, "note.txt"), "utf8")).toBe(
        "newer change\n",
      );
      expect(fixture.stdout()).toBe("");
      expect(fixture.stderr()).not.toBe("");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an interactive run asks for a report,
    When the CLI main sees there is no one-shot message,
    Then it rejects the unsupported report option`, async () => {
    // Given
    const fixture = createRuntime(["--report", "run.json"], {
      env: { KEEL_FORCE_INTERACTIVE: "1" },
    });

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe(
      "Error: --report is only supported for one-shot runs.\n",
    );
  });

  test(`Given an unknown provider is configured,
    When the CLI main resolves the provider for a one-shot run,
    Then it returns a provider configuration error`, async () => {
    // Given
    const fixture = createRuntime(["hello"], {
      env: { KEEL_PROVIDER: "unknown" },
    });

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe('Error: unknown provider "unknown"\n');
  });

  test(`Given the fake provider is selected,
    When the CLI main runs a one-shot text request,
    Then it prints the provider reply and exits successfully`, async () => {
    // Given
    const fixture = createRuntime(["hello"], {
      env: { KEEL_PROVIDER: "fake" },
    });

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(0);
    expect(fixture.stdout()).toBe("Hello from fake provider.\n");
    expect(fixture.stderr()).toBe("");
  });

  test(`Given trusted shell mode is enabled,
    When the CLI main runs a one-shot request,
    Then it passes the allow-bash option into the agent run`, async () => {
    // Given
    const fixture = createRuntime(["--allow-bash", "hello"], {
      env: { KEEL_PROVIDER: "fake" },
    });

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(0);
    expect(fixture.stdout()).toBe("Hello from fake provider.\n");
    expect(fixture.stderr()).toBe("");
  });

  test(`Given the default provider is configured against a local protocol server,
    When the CLI main runs a one-shot text request,
    Then it streams the provider reply through the process boundary`, async () => {
    // Given
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
        res.end(sseTextReplyWithUsage("Hello\u001b[31m from DeepSeek."));
      });
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
      expect(exitCode).toBe(0);
      expect(fixture.stdout()).toBe("Hello\\x1b[31m from DeepSeek.\n");
      expect(fixture.stderr()).toBe("");
    } finally {
      await close(server);
    }
  });

  test(`Given the provider rate limits before succeeding,
    When the CLI main runs in-process,
    Then it reports the retry before printing the final answer`, async () => {
    // Given
    let requestCount = 0;
    const server = createServer((req, res) => {
      if (req.url !== "/chat/completions") {
        res.writeHead(404);
        res.end();
        return;
      }
      req.resume();
      req.on("end", () => {
        requestCount++;
        if (requestCount === 1) {
          res.writeHead(429, {
            "Content-Type": "application/json",
            "Retry-After": "0",
          });
          res.end(JSON.stringify({ error: { message: "Rate limited" } }));
          return;
        }

        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.end(sseTextReplyWithUsage("Recovered."));
      });
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
      expect(exitCode).toBe(0);
      expect(requestCount).toBe(2);
      expect(fixture.stdout()).toBe("Recovered.\n");
      expect(fixture.stderr()).toBe(
        "Provider retry: DeepSeek provider_rate_limited attempt 1/4 in 0ms\n",
      );
    } finally {
      await close(server);
    }
  });

  test(`Given the configured provider reads a workspace file,
    When the CLI main runs in-process,
    Then it reports the read tool and sends the content back to the provider`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-main-read-"));
    await writeFile(join(workspace, "note.txt"), "hello from note\n", "utf8");
    const capturedBodies: unknown[] = [];
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
        capturedBodies.push(JSON.parse(body));
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        if (capturedBodies.length === 1) {
          res.write(sseToolCall("call_read", "read", { path: "note.txt" }));
          res.write(sseToolFinish());
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }

        res.end(sseTextReplyWithUsage("Read done."));
      });
    });
    await listen(server);
    const fixture = createRuntime(["read note.txt"], {
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
      expect(exitCode).toBe(0);
      expect(fixture.stdout()).toBe("Read done.\n");
      expect(fixture.stderr()).toBe("Tool: read note.txt\n");
      const secondRequest = requestWithMessagesSchema.parse(capturedBodies[1]);
      expect(secondRequest.messages).toContainEqual({
        role: "tool",
        tool_call_id: "call_read",
        content: "hello from note\n",
      });
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the configured provider searches the workspace,
    When the CLI main runs in-process,
    Then it reports the grep tool and sends matches back to the provider`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-main-grep-"));
    await writeFile(
      join(workspace, "app.ts"),
      "export function handleSubmit() {}\n",
      "utf8",
    );
    const capturedBodies: unknown[] = [];
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
        capturedBodies.push(JSON.parse(body));
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        if (capturedBodies.length === 1) {
          res.write(
            sseToolCall("call_grep", "grep", { pattern: "handleSubmit" }),
          );
          res.write(sseToolFinish());
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }

        res.end(sseTextReplyWithUsage("Grep done."));
      });
    });
    await listen(server);
    const fixture = createRuntime(["find handleSubmit"], {
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
      expect(exitCode).toBe(0);
      expect(fixture.stdout()).toBe("Grep done.\n");
      expect(fixture.stderr()).toBe("Tool: grep handleSubmit\n");
      const secondRequest = requestWithMessagesSchema.parse(capturedBodies[1]);
      expect(secondRequest.messages).toContainEqual({
        role: "tool",
        tool_call_id: "call_grep",
        content: "app.ts:1:export function handleSubmit() {}",
      });
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a tool label contains terminal control characters,
    When the CLI main reports tool progress,
    Then it escapes the label before writing stderr`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-main-label-"));
    const unsafePattern = "needle\t\r\n\u202e";
    const capturedBodies: unknown[] = [];
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
        capturedBodies.push(JSON.parse(body));
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        if (capturedBodies.length === 1) {
          res.write(
            sseToolCall("call_grep", "grep", { pattern: unsafePattern }),
          );
          res.write(sseToolFinish());
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }

        res.end(sseTextReplyWithUsage("Escaped."));
      });
    });
    await listen(server);
    const fixture = createRuntime(["search unsafe label"], {
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
      expect(exitCode).toBe(0);
      expect(fixture.stdout()).toBe("Escaped.\n");
      expect(fixture.stderr()).toBe(
        "Tool: grep needle\\t\\r\\n\\u{202e}\nTool failed: grep needle\\t\\r\\n\\u{202e}\n",
      );
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a tool label is too long and includes a path,
    When the CLI main reports tool progress,
    Then it truncates the single stderr line`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-cli-main-label-long-"),
    );
    const pattern = "needle".repeat(40);
    const capturedBodies: unknown[] = [];
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
        capturedBodies.push(JSON.parse(body));
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        if (capturedBodies.length === 1) {
          res.write(
            sseToolCall("call_grep", "grep", {
              pattern,
              path: "missing.txt",
            }),
          );
          res.write(sseToolFinish());
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }

        res.end(sseTextReplyWithUsage("Truncated."));
      });
    });
    await listen(server);
    const fixture = createRuntime(["search long label"], {
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
      expect(exitCode).toBe(0);
      expect(fixture.stdout()).toBe("Truncated.\n");
      const stderrLines = fixture.stderr().trimEnd().split("\n");
      expect(stderrLines).toHaveLength(2);
      expect(stderrLines[0]).toMatch(/^Tool: grep needle/);
      expect(stderrLines[0]).toContain("...");
      expect(stderrLines[0]).toHaveLength("Tool: ".length + 163);
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given trusted shell mode is enabled for the configured provider,
    When the CLI main runs in-process,
    Then it reports the bash tool and sends shell output back to the provider`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-main-bash-"));
    const capturedBodies: unknown[] = [];
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
        capturedBodies.push(JSON.parse(body));
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        if (capturedBodies.length === 1) {
          res.write(
            sseToolCall("call_bash", "bash", { command: "printf shell-ok" }),
          );
          res.write(sseToolFinish());
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }

        res.end(sseTextReplyWithUsage("Bash done."));
      });
    });
    await listen(server);
    const fixture = createRuntime(["--allow-bash", "run shell"], {
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
      expect(exitCode).toBe(0);
      expect(fixture.stdout()).toBe("Bash done.\n");
      expect(fixture.stderr()).toBe("Tool: bash printf shell-ok\n");
      const secondRequest = requestWithMessagesSchema.parse(capturedBodies[1]);
      expect(secondRequest.messages).toContainEqual(
        expect.objectContaining({
          role: "tool",
          tool_call_id: "call_bash",
          content: expect.stringContaining("stdout:\nshell-ok"),
        }),
      );
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a one-shot provider request is interrupted,
    When the CLI main receives SIGINT,
    Then it aborts the request and returns the interrupted exit code`, async () => {
    // Given
    const sigint: SigintCapture = { handler: null };
    let receiveRequest: () => void = () => {};
    const requestReceived = new Promise<void>((resolve) => {
      receiveRequest = resolve;
    });
    const server = createServer((req, res) => {
      if (req.url !== "/chat/completions") {
        res.writeHead(404);
        res.end();
        return;
      }
      req.resume();
      receiveRequest();
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write(
        `data: ${JSON.stringify({
          choices: [{ delta: { content: "partial" } }],
        })}\n\n`,
      );
    });
    await listen(server);
    const fixture = createRuntime(["hello"], {
      env: {
        DEEPSEEK_API_KEY: "test-key",
        DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
      },
      onSigint: (handler) => {
        sigint.handler = handler;
      },
      offSigint: (handler) => {
        if (sigint.handler === handler) sigint.handler = null;
      },
    });

    try {
      // When
      const run = runCliMain(fixture.runtime);
      await requestReceived;
      const handler = sigint.handler;
      if (handler === null) {
        throw new Error("SIGINT handler was not registered");
      }
      handler();
      const exitCode = await run;

      // Then
      expect(exitCode).toBe(130);
      expect(fixture.stdout()).toBe("\n");
      expect(fixture.stderr()).toBe("");
      expect(sigint.handler).toBeNull();
    } finally {
      await close(server);
    }
  });

  test.each([
    {
      provider: "deepseek",
      env: { KEEL_PROVIDER: "deepseek", DEEPSEEK_API_KEY: "" },
      stderr:
        "Error: DEEPSEEK_API_KEY is required. Set the API key to use DeepSeek.\n",
    },
    {
      provider: "kimi",
      env: { KEEL_PROVIDER: "kimi", KIMI_API_KEY: "" },
      stderr: "Error: KIMI_API_KEY is required. Set the API key to use Kimi.\n",
    },
    {
      provider: "qwen",
      env: { KEEL_PROVIDER: "qwen", DASHSCOPE_API_KEY: "" },
      stderr:
        "Error: DASHSCOPE_API_KEY or QWEN_API_KEY is required. Qwen default endpoint is https://dashscope-intl.aliyuncs.com/compatible-mode/v1; set QWEN_BASE_URL if your key belongs to China region or a workspace-scoped DashScope endpoint.\n",
    },
  ])(`Given $provider is configured without an API key,
    When the CLI main resolves the provider,
    Then it returns the provider-specific API key error`, async ({
    env,
    stderr,
  }) => {
    // Given
    const fixture = createRuntime(["hello"], { env });

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe(stderr);
  });

  test(`Given the fake provider is selected with a max cost,
    When the CLI main finishes a one-shot request,
    Then it prints the spent cost report`, async () => {
    // Given
    const fixture = createRuntime(["--max-cost", "1", "hello"], {
      env: { KEEL_PROVIDER: "fake" },
    });

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(0);
    expect(fixture.stdout()).toBe("Hello from fake provider.\n");
    expect(fixture.stderr()).toBe("Cost: $0.000000 (budget $1.0000)\n");
  });

  test(`Given the configured provider exceeds the max cost,
    When the CLI main finishes a one-shot request,
    Then it marks the cost budget as exceeded`, async () => {
    // Given
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
          sseTextReplyWithUsage("Expensive.", {
            prompt_tokens: 1_000_000_000,
            completion_tokens: 1_000_000_000,
          }),
        );
      });
    });
    await listen(server);
    const fixture = createRuntime(["--max-cost", "0.0001", "hello"], {
      env: {
        DEEPSEEK_API_KEY: "test-key",
        DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
      },
    });

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(0);
      expect(fixture.stdout()).toBe("Expensive.\n");
      expect(fixture.stderr()).toContain("exceeded");
    } finally {
      await close(server);
    }
  });

  test.each([
    {
      provider: "kimi",
      env: {
        KEEL_PROVIDER: "kimi",
        KIMI_API_KEY: "test-key",
        KIMI_MODEL: "kimi-k2.5",
      },
      stderr:
        'Error: cost tracking is only supported for Kimi model "kimi-k2.6"; configured KIMI_MODEL="kimi-k2.5".\n',
    },
    {
      provider: "qwen",
      env: { KEEL_PROVIDER: "qwen", DASHSCOPE_API_KEY: "test-key" },
      stderr:
        'Error: cost tracking is not supported for Qwen model "qwen3.7-plus" because its official pricing is tiered by per-request input tokens.\n',
    },
  ])(`Given $provider has no supported cost model,
    When the CLI main is asked to track cost,
    Then it rejects the run before contacting the provider`, async ({
    env,
    stderr,
  }) => {
    // Given
    const fixture = createRuntime(["--max-cost", "1", "hello"], { env });

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe(stderr);
  });

  test(`Given the fake provider writes a file,
    When the CLI main runs a one-shot create request,
    Then it writes the file through real tools and reports progress`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-main-write-"));
    const fixture = createRuntime(["create generated.json"], {
      cwd: workspace,
      env: { KEEL_PROVIDER: "fake" },
    });

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(0);
      expect(await readFile(join(workspace, "generated.json"), "utf8")).toBe(
        '{"created":true}\n',
      );
      expect(fixture.stdout()).toBe("Created generated.json\n");
      expect(fixture.stderr()).toBe("Tool: write generated.json\n");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test.each([
    ["replace old new"],
    ["replace old with new"],
    ["replace  with new in note.txt"],
    ["replace old with  in note.txt"],
    ["replace old with new in "],
    ["create "],
  ])(`Given the fake provider receives unsupported demo input "%s",
    When the CLI main runs the request,
    Then it falls back to a plain fake reply`, async (message) => {
    // Given
    const fixture = createRuntime([message], {
      env: { KEEL_PROVIDER: "fake" },
    });

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(0);
    expect(fixture.stdout()).toBe("Hello from fake provider.\n");
    expect(fixture.stderr()).toBe("");
  });

  test(`Given the fake provider runs interactively,
    When the user sends two prompts on stdin,
    Then the second reply can use the first prompt as context`, async () => {
    // Given
    const input = new PassThrough();
    input.end("remember alpha\nwhat did I ask you to remember?\n");
    const fixture = createRuntime([], {
      env: { KEEL_PROVIDER: "fake", KEEL_FORCE_INTERACTIVE: "1" },
      input,
    });

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(0);
    expect(fixture.stdout()).toContain("Remembered: remember alpha\n");
    expect(fixture.stdout()).toContain("Earlier you said: remember alpha\n");
    expect(fixture.stderr()).toBe("");
  });

  test(`Given interactive mode has cost tracking enabled,
    When the user sends one prompt,
    Then the CLI main prints the turn cost report`, async () => {
    // Given
    const input = new PassThrough();
    input.end("hello\n");
    const fixture = createRuntime(["--max-cost", "1"], {
      env: { KEEL_PROVIDER: "fake", KEEL_FORCE_INTERACTIVE: "1" },
      input,
    });

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(0);
    expect(fixture.stdout()).toBe("Remembered: hello\n");
    expect(fixture.stderr()).toBe("Cost: $0.000000 (budget $1.0000)\n");
  });

  test(`Given an interactive session is idle,
    When the CLI main receives SIGINT,
    Then it closes the session as interrupted`, async () => {
    // Given
    const input = new PassThrough();
    const sigint: SigintCapture = { handler: null };
    const fixture = createRuntime([], {
      env: { KEEL_PROVIDER: "fake", KEEL_FORCE_INTERACTIVE: "1" },
      input,
      onSigint: (handler) => {
        sigint.handler = handler;
      },
      offSigint: (handler) => {
        if (sigint.handler === handler) sigint.handler = null;
      },
    });

    // When
    const run = runCliMain(fixture.runtime);
    const handler = sigint.handler;
    if (handler === null) {
      throw new Error("SIGINT handler was not registered");
    }
    handler();
    const exitCode = await run;

    // Then
    expect(exitCode).toBe(130);
    expect(fixture.stdout()).toBe("\n");
    expect(fixture.stderr()).toBe("");
    expect(sigint.handler).toBeNull();
  });

  test(`Given interactive mode resolves a provider configuration error,
    When the user sends a prompt,
    Then the CLI main returns the user-facing error`, async () => {
    // Given
    const input = new PassThrough();
    input.end("hello\n");
    const fixture = createRuntime([], {
      env: {
        KEEL_FORCE_INTERACTIVE: "1",
        KEEL_PROVIDER: "deepseek",
        DEEPSEEK_API_KEY: "",
      },
      input,
    });

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe(
      "Error: DEEPSEEK_API_KEY is required. Set the API key to use DeepSeek.\n",
    );
  });

  test(`Given a one-shot run asks for a machine-readable report,
    When the CLI main completes through the fake provider,
    Then it writes the run report from the in-process boundary`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-main-report-"));
    const reportPath = join(workspace, "run.json");
    const fixture = createRuntime(["--report", reportPath, "hello"], {
      cwd: workspace,
      env: { KEEL_PROVIDER: "fake" },
    });

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(0);
      expect(fixture.stdout()).toBe("Hello from fake provider.\n");
      const report = runReportSchema.parse(
        JSON.parse(await readFile(reportPath, "utf8")),
      );
      expect(report).toMatchObject({
        schemaVersion: 1,
        provider: "fake",
        model: "fake",
        costUsd: 0,
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given max cost and report are passed with equals syntax,
    When the CLI main completes the one-shot run,
    Then it honors both options`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-main-equals-"));
    const reportPath = join(workspace, "run.json");
    const fixture = createRuntime(
      [`--max-cost=1`, `--report=${reportPath}`, "hello"],
      {
        cwd: workspace,
        env: { KEEL_PROVIDER: "fake" },
      },
    );

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(0);
      expect(fixture.stderr()).toBe("Cost: $0.000000 (budget $1.0000)\n");
      const report = runReportSchema.parse(
        JSON.parse(await readFile(reportPath, "utf8")),
      );
      expect(report).toMatchObject({ provider: "fake", costUsd: 0 });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the fake provider edits a file,
    When the CLI main runs in-process with a workspace,
    Then the user-visible file behavior still goes through real tools`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-main-edit-"));
    await writeFile(join(workspace, "note.txt"), "hello old world\n", "utf8");
    const fixture = createRuntime(["replace old with new in note.txt"], {
      cwd: workspace,
      env: { KEEL_PROVIDER: "fake" },
    });

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(0);
      expect(await readFile(join(workspace, "note.txt"), "utf8")).toBe(
        "hello new world\n",
      );
      expect(fixture.stdout()).toBe("Edited note.txt\n");
      expect(fixture.stderr()).toBe("Tool: edit note.txt\n");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the fake provider requests an edit that cannot apply,
    When the CLI main runs the tool call,
    Then it reports the failed tool result without crashing`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-main-edit-fail-"));
    await writeFile(join(workspace, "note.txt"), "hello world\n", "utf8");
    const fixture = createRuntime(["replace old with new in note.txt"], {
      cwd: workspace,
      env: { KEEL_PROVIDER: "fake" },
    });

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(0);
      expect(await readFile(join(workspace, "note.txt"), "utf8")).toBe(
        "hello world\n",
      );
      expect(fixture.stdout()).toContain("Tool failed:");
      expect(fixture.stderr()).toBe(
        "Tool: edit note.txt\nTool failed: edit note.txt\n",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
