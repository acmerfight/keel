import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import {
  runCli as runCliCommand,
  runCliProcess as runCliProcessCommand,
} from "../../src/testing/cli-harness.ts";

function runCli(
  args: readonly string[],
  env: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return runCliCommand(args, { env });
}

function runCliProcess(
  args: readonly string[],
  env: Record<string, string> = {},
  options: { readonly stdin?: "pipe" | "ignore" } = {},
) {
  return runCliProcessCommand(args, { env, ...options });
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

const requestModelSchema = z.object({
  model: z.string(),
});

function sseTextReplyWithUsage(
  text: string,
  usage: {
    readonly promptTokens: number;
    readonly promptCacheHitTokens: number;
    readonly promptCacheMissTokens: number;
    readonly completionTokens: number;
  },
): string {
  return [
    `data: ${JSON.stringify({
      choices: [{ delta: { content: text } }],
    })}\n\n`,
    `data: ${JSON.stringify({
      choices: [{ delta: {}, finish_reason: "stop" }],
      usage: {
        prompt_tokens: usage.promptTokens,
        prompt_cache_hit_tokens: usage.promptCacheHitTokens,
        prompt_cache_miss_tokens: usage.promptCacheMissTokens,
        completion_tokens: usage.completionTokens,
      },
    })}\n\n`,
    "data: [DONE]\n\n",
  ].join("");
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(message));
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

describe("CLI Text Reply", () => {
  test(`Given no user message and no interactive terminal,
    When user runs the CLI,
    Then the CLI exits with usage instructions`, async () => {
    // Given
    const args: readonly string[] = [];

    // When
    const result = await runCli(args);

    // Then
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toBe(
      [
        "Usage: keel [--provider <fake|deepseek|kimi|qwen>] [--model <id>] [--allow-bash] [--bash-policy <ask|deny|trusted>] [--max-cost <usd>] [--report <file>] [--transcript <file>] [--skill <name>] <message>",
        "       keel [--provider <fake|deepseek|kimi|qwen>] [--model <id>] [--allow-bash] [--bash-policy <ask|deny|trusted>] [--max-cost <usd>] [--report <file>] [--skill <name>] [--session <id> | --resume <id> [--fork-points | --fork <new-id> [--fork-before-message <id>]]]",
        "       keel --doctor [--offline] [--provider <fake|deepseek|kimi|qwen>] [--model <id>]",
        "       keel sessions",
        "       keel sessions fork <source-id> <target-id> [--before-message <id>]",
        "       keel skills",
        "       keel eval [--provider <fake|deepseek|kimi|qwen>] [--model <id>] [--suite <dir>] [--task <id>] [--trials <n>] [--out <file>] [--transcript-dir <dir>] [--check]",
        "       keel eval compare --base <old.jsonl> --head <new.jsonl>",
        "       keel /undo",
        "",
        "--allow-bash enables trusted shell commands. Shell commands run with the current OS user's permissions and may read or modify gitignored files.",
        "--bash-policy controls shell command approval: ask requires a real TTY approval prompt, deny disables bash, trusted runs commands without per-command approval. Approved or trusted command output may be sent to the provider unredacted. Do not combine it with --allow-bash; use --bash-policy trusted instead.",
        "--report writes a machine-readable JSON run report (turns, stop reason, token usage, cost) to the given file.",
        "--transcript writes a best-effort redacted provider-visible one-shot transcript as schema-versioned JSONL. Live provider requests are not redacted.",
        "--skill loads .agents/skills/<name>/SKILL.md as explicit workflow guidance for the current run.",
        "--session/--resume persist interactive provider context with best-effort at-rest redaction. Live provider requests may still include raw user and tool content.",
        "--fork-points lists restored user message ids for sessions fork --before-message; it requires --resume.",
        "--fork-before-message cuts a fork before the restored message id; it requires --resume and --fork.",
        "--before-message cuts a sessions fork before the restored message id.",
        "--transcript-dir writes one best-effort redacted provider-visible transcript JSONL file per eval trial.",
        "--provider and --model override provider env for the current run.",
        "Provider env: KEEL_PROVIDER=deepseek|kimi|qwen, DEEPSEEK_API_KEY, KIMI_API_KEY, DASHSCOPE_API_KEY or QWEN_API_KEY, optional *_BASE_URL, DEEPSEEK_MODEL, KIMI_MODEL, QWEN_MODEL, and KEEL_CONTEXT_WINDOW_TOKENS.",
        "Context compaction uses model registry context windows; set KEEL_CONTEXT_WINDOW_TOKENS to override the selected model window.",
        "Qwen default endpoint is https://dashscope-intl.aliyuncs.com/compatible-mode/v1; set QWEN_BASE_URL if your key belongs to China region or a workspace-scoped DashScope endpoint.",
        "",
      ].join("\n"),
    );
  });

  test(`Given user starts an interactive session,
    When user enters /help,
    Then the CLI prints local interactive help`, async () => {
    // Given
    const { child, result } = runCliProcess(
      [],
      { KEEL_FORCE_INTERACTIVE: "1" },
      { stdin: "pipe" },
    );

    // When
    child.stdin?.write("/help\n");
    child.stdin?.end();

    // Then
    try {
      const exit = await withTimeout(
        result,
        5000,
        "interactive CLI did not finish after stdin closed",
      );
      expect(exit.exitCode).toBe(0);
      expect(exit.stderr).toBe("");
      expect(exit.stdout).toContain("Interactive commands:");
      expect(exit.stdout).toContain("/help");
      expect(exit.stdout).toContain("/compact [focus]");
      expect(exit.stdout).toContain("keel sessions");
      expect(exit.stdout).toContain("keel sessions fork");
      const sessionVisibilityNote =
        "Session ledgers are best-effort redacted at rest; live provider requests may include raw content.";
      expect(exit.stdout).toContain(sessionVisibilityNote);
      expect(exit.stdout.indexOf(sessionVisibilityNote)).toBeLessThan(
        exit.stdout.indexOf("  keel sessions"),
      );
    } finally {
      child.kill("SIGKILL");
    }
  });

  test(`Given user starts an interactive session,
    When user sends two related messages,
    Then the second answer uses context from the first`, async () => {
    // Given
    const { child, result } = runCliProcess(
      [],
      { KEEL_PROVIDER: "fake", KEEL_FORCE_INTERACTIVE: "1" },
      { stdin: "pipe" },
    );

    // When
    child.stdin?.write("remember alpha\n");
    child.stdin?.write("what did I ask you to remember?\n");
    child.stdin?.end();

    // Then
    try {
      const exit = await withTimeout(
        result,
        5000,
        "interactive CLI did not finish after stdin closed",
      );
      expect(exit.exitCode).toBe(0);
      expect(exit.stderr).toBe("");
      expect(exit.stdout).toContain("Remembered: remember alpha\n");
      expect(exit.stdout).toContain("Earlier you said: remember alpha\n");
    } finally {
      child.kill("SIGKILL");
    }
  });

  test(`Given user starts an interactive session with provider and model flags,
    When user sends a prompt,
    Then the selected provider and model override provider env`, async () => {
    // Given
    let receiveRequestModel: (model: string) => void = () => {};
    const requestModelReceived = new Promise<string>((resolve) => {
      receiveRequestModel = resolve;
    });
    const server = createServer((req, res) => {
      if (req.url !== "/chat/completions") {
        res.writeHead(404);
        res.end();
        return;
      }

      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        receiveRequestModel(requestModelSchema.parse(JSON.parse(body)).model);
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.end(
          sseTextReplyWithUsage("interactive selected Qwen", {
            promptTokens: 10,
            promptCacheHitTokens: 0,
            promptCacheMissTokens: 10,
            completionTokens: 3,
          }),
        );
      });
    });
    await listen(server);
    const { child, result } = runCliProcess(
      ["--provider", "qwen", "--model", "qwen3.7-plus"],
      {
        KEEL_PROVIDER: "fake",
        DASHSCOPE_API_KEY: "test-key",
        QWEN_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
        KEEL_FORCE_INTERACTIVE: "1",
      },
      { stdin: "pipe" },
    );
    child.stdin?.on("error", () => {});

    try {
      // When
      child.stdin?.write("hello selected provider\n");
      child.stdin?.end();

      // Then
      const requestModel = await withTimeout(
        requestModelReceived,
        5000,
        "interactive CLI did not send a provider request",
      );
      const exit = await withTimeout(
        result,
        5000,
        "interactive CLI did not finish after stdin closed",
      );
      expect(exit.exitCode).toBe(0);
      expect(exit.signal).toBeNull();
      expect(exit.stdout).toContain("interactive selected Qwen\n");
      expect(exit.stderr).toBe("");
      expect(requestModel).toBe("qwen3.7-plus");
    } finally {
      child.kill("SIGKILL");
      await close(server);
    }
  });

  test(`Given user starts an interactive session,
    When user switches provider and model with /model,
    Then the next prompt uses the selected provider and model`, async () => {
    // Given
    let receiveRequestModel: (model: string) => void = () => {};
    const requestModelReceived = new Promise<string>((resolve) => {
      receiveRequestModel = resolve;
    });
    const server = createServer((req, res) => {
      if (req.url !== "/chat/completions") {
        res.writeHead(404);
        res.end();
        return;
      }

      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        receiveRequestModel(requestModelSchema.parse(JSON.parse(body)).model);
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.end(
          sseTextReplyWithUsage("interactive switched Qwen", {
            promptTokens: 10,
            promptCacheHitTokens: 0,
            promptCacheMissTokens: 10,
            completionTokens: 3,
          }),
        );
      });
    });
    await listen(server);
    const { child, result } = runCliProcess(
      [],
      {
        KEEL_PROVIDER: "fake",
        DASHSCOPE_API_KEY: "test-key",
        QWEN_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
        KEEL_FORCE_INTERACTIVE: "1",
      },
      { stdin: "pipe" },
    );
    child.stdin?.on("error", () => {});

    try {
      // When
      child.stdin?.write("/model qwen/qwen3.7-plus\n");
      child.stdin?.write("hello selected provider\n");
      child.stdin?.end();

      // Then
      const requestModel = await withTimeout(
        requestModelReceived,
        5000,
        "interactive CLI did not send a switched provider request",
      );
      const exit = await withTimeout(
        result,
        5000,
        "interactive CLI did not finish after stdin closed",
      );
      expect(exit.exitCode).toBe(0);
      expect(exit.signal).toBeNull();
      expect(exit.stdout).toContain("Model switched to qwen/qwen3.7-plus\n");
      expect(exit.stdout).toContain("interactive switched Qwen\n");
      expect(exit.stderr).toBe("");
      expect(requestModel).toBe("qwen3.7-plus");
    } finally {
      child.kill("SIGKILL");
      await close(server);
    }
  });

  test(`Given an interactive session is waiting for input,
    When user interrupts the idle session,
    Then the CLI exits as interrupted`, async () => {
    // Given
    let stdout = "";
    let receiveWarmupReply: () => void = () => {};
    const warmupReplyReceived = new Promise<void>((resolve) => {
      receiveWarmupReply = resolve;
    });
    const { child, result } = runCliProcess(
      [],
      { KEEL_PROVIDER: "fake", KEEL_FORCE_INTERACTIVE: "1" },
      { stdin: "pipe" },
    );
    child.stdin?.on("error", () => {});
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.includes("Remembered: warmup\n")) {
        receiveWarmupReply();
      }
    });

    try {
      // When
      child.stdin?.write("warmup\n");
      await withTimeout(
        warmupReplyReceived,
        5000,
        "interactive CLI did not become idle after warmup",
      );
      child.kill("SIGINT");

      // Then
      const exit = await withTimeout(
        result,
        5000,
        "interactive CLI did not exit after idle SIGINT",
      );
      expect(exit.exitCode).toBe(130);
      expect(exit.signal).toBeNull();
      expect(exit.stdout).toBe("Remembered: warmup\n\n");
      expect(exit.stderr).toBe("");
    } finally {
      child.kill("SIGKILL");
    }
  });

  test(`Given an interactive provider request is interrupted,
    When user sends another prompt in the same session,
    Then the next turn uses a fresh abort signal and completes`, async () => {
    // Given
    let receiveFirstRequest: () => void = () => {};
    let receiveSecondRequest: () => void = () => {};
    let closeFirstResponse: () => void = () => {};
    let receiveSecondRequestBody: (body: string) => void = () => {};
    const firstRequestReceived = new Promise<void>((resolve) => {
      receiveFirstRequest = resolve;
    });
    const secondRequestReceived = new Promise<void>((resolve) => {
      receiveSecondRequest = resolve;
    });
    const firstResponseClosed = new Promise<void>((resolve) => {
      closeFirstResponse = resolve;
    });
    const secondRequestBodyReceived = new Promise<string>((resolve) => {
      receiveSecondRequestBody = resolve;
    });
    let requestCount = 0;
    const server = createServer((req, res) => {
      if (req.url !== "/chat/completions") {
        res.writeHead(404);
        res.end();
        return;
      }

      requestCount++;
      const currentRequest = requestCount;
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });
      if (currentRequest === 2) {
        req.on("end", () => {
          receiveSecondRequestBody(Buffer.concat(chunks).toString("utf8"));
        });
      }
      req.resume();
      if (currentRequest === 1) {
        receiveFirstRequest();
        res.on("close", closeFirstResponse);
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
        return;
      }

      receiveSecondRequest();
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.end(
        sseTextReplyWithUsage("second turn survived", {
          promptTokens: 10,
          promptCacheHitTokens: 0,
          promptCacheMissTokens: 10,
          completionTokens: 3,
        }),
      );
    });
    await listen(server);
    const { child, result } = runCliProcess(
      [],
      {
        DEEPSEEK_API_KEY: "test-key",
        DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
        KEEL_FORCE_INTERACTIVE: "1",
      },
      { stdin: "pipe" },
    );
    child.stdin?.on("error", () => {});

    try {
      // When
      child.stdin?.write("first prompt\n");
      await withTimeout(
        firstRequestReceived,
        5000,
        "interactive CLI did not send the first provider request",
      );
      child.kill("SIGINT");
      await withTimeout(
        firstResponseClosed,
        5000,
        "interactive provider request was not cancelled after SIGINT",
      );
      child.stdin?.write("second prompt\n");
      child.stdin?.end();

      // Then
      await withTimeout(
        secondRequestReceived,
        5000,
        "interactive CLI did not send the second provider request",
      );
      const secondRequestBody = await withTimeout(
        secondRequestBodyReceived,
        5000,
        "interactive CLI did not finish sending the second request body",
      );
      const exit = await withTimeout(
        result,
        5000,
        "interactive CLI did not finish after stdin closed",
      );
      expect(exit.exitCode).toBe(0);
      expect(exit.signal).toBeNull();
      expect(exit.stdout).toContain("second turn survived\n");
      expect(exit.stderr).not.toMatch(/AbortError|DOMException/);
      expect(secondRequestBody).toContain("second prompt");
      expect(secondRequestBody).not.toContain("first prompt");
    } finally {
      child.kill("SIGKILL");
      await close(server);
    }
  });

  test(`Given user requests an interactive session report,
    When user finishes prompts from stdin,
    Then the CLI writes the report`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-text-report-"));
    const reportPath = join(workspace, "run.json");
    const { child, result } = runCliProcess(
      ["--report", reportPath],
      { KEEL_PROVIDER: "fake", KEEL_FORCE_INTERACTIVE: "1" },
      { stdin: "pipe" },
    );

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
      expect(exit.stdout).toContain("Remembered: remember alpha\n");
      expect(exit.stdout).toContain("Earlier you said: remember alpha\n");
      expect(exit.stderr).toBe("");
      expect(JSON.parse(await readFile(reportPath, "utf8"))).toMatchObject({
        schemaVersion: 2,
        modelsUsed: [{ provider: "fake", model: "fake" }],
        usageByModel: [
          {
            provider: "fake",
            model: "fake",
            turns: 2,
            costUsd: 0,
          },
        ],
        costUsd: 0,
      });
    } finally {
      child.kill("SIGKILL");
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given user asks for diagnostics,
    When user runs the CLI doctor command,
    Then the CLI reports bundled ripgrep and provider status`, async () => {
    // Given
    const args: readonly string[] = ["--doctor", "--provider=fake"];

    // When
    const result = await runCli(args);

    // Then
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Keel doctor");
    expect(result.stdout).toContain("ripgrep: ok (vscode-ripgrep)");
    expect(result.stdout).toContain("ripgrep path:");
    expect(result.stdout).toMatch(/^ripgrep version: ripgrep\s+\S+/m);
    expect(result.stdout).toContain("provider: fake (source: --provider)");
    expect(result.stdout).toContain("api key: not required");
    expect(result.stderr).toBe("");
  });

  test(`Given a user message and a configured provider,
    When user runs the CLI with the message,
    Then the agent's text reply is printed to stdout`, async () => {
    // Given — fake provider is used when KEEL_PROVIDER=fake
    const env = { KEEL_PROVIDER: "fake" };

    // When
    const result = await runCli(["hello"], env);

    // Then
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).not.toBe("");
    expect(result.stdout.trim()).not.toBe("keel v0.0.1");
  });

  test(`Given user requests a one-shot transcript,
    When user runs the CLI with a message,
    Then the CLI writes provider-visible messages as JSONL`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-transcript-"));
    const transcriptPath = join(workspace, "run.jsonl");

    try {
      // When
      const result = await runCli(["--transcript", transcriptPath, "hello"], {
        KEEL_PROVIDER: "fake",
      });

      // Then
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("Hello from fake provider.\n");
      expect(result.stderr).toBe("");

      const records = (await readFile(transcriptPath, "utf8"))
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(records[0]).toMatchObject({
        schemaVersion: 1,
        type: "transcript",
        provider: "fake",
        model: "fake",
        systemPrompt: expect.stringContaining("You are keel"),
      });
      expect(records.slice(1)).toMatchObject([
        { type: "message", message: { role: "user", content: "hello" } },
        {
          type: "message",
          message: {
            role: "assistant",
            content: "Hello from fake provider.",
          },
        },
      ]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test.each(["0", "abc"])(`Given an invalid max cost value %s,
    When user runs the CLI,
    Then the CLI exits with a validation error before requiring a provider`, async (maxCost) => {
    // Given
    const args: readonly string[] = ["--max-cost", maxCost, "hello"];

    // When
    const result = await runCli(args, {
      KEEL_PROVIDER: "deepseek",
      DEEPSEEK_API_KEY: "",
    });

    // Then
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "Error: --max-cost must be a positive number.\n",
    );
  });

  test(`Given a max cost and the configured provider reports costly usage,
    When user runs the CLI,
    Then the CLI prints the spent cost and exits successfully`, async () => {
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
        res.write(
          sseTextReplyWithUsage("Done.", {
            promptTokens: 1_000_000,
            promptCacheHitTokens: 0,
            promptCacheMissTokens: 1_000_000,
            completionTokens: 0,
          }),
        );
        res.end();
      });
    });
    await listen(server);

    try {
      // When
      const result = await runCli(
        ["--max-cost", "0.001", "summarize expensive context"],
        {
          DEEPSEEK_API_KEY: "test-key",
          DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
        },
      );

      // Then
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("Done.\n");
      expect(result.stderr).toContain("Cost: $");
      expect(result.stderr).toContain("budget $0.0010 exceeded");
    } finally {
      await close(server);
    }
  });

  test(`Given a tiny max cost and the configured provider reports a small overage,
    When user runs the CLI,
    Then the CLI prints non-zero spent cost and budget values`, async () => {
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
        res.write(
          sseTextReplyWithUsage("Done.", {
            promptTokens: 10,
            promptCacheHitTokens: 0,
            promptCacheMissTokens: 10,
            completionTokens: 0,
          }),
        );
        res.end();
      });
    });
    await listen(server);

    try {
      // When
      const result = await runCli(["--max-cost", "0.000001", "summarize"], {
        DEEPSEEK_API_KEY: "test-key",
        DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
      });

      // Then
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain("Cost: $0.000001");
      expect(result.stderr).toContain("budget $0.000001 exceeded");
    } finally {
      await close(server);
    }
  });

  test(`Given no provider API key and no demo provider,
    When user runs the CLI,
    Then the CLI exits with an error message`, async () => {
    // Given — no DEEPSEEK_API_KEY, no KEEL_PROVIDER=fake
    const env = {
      KEEL_PROVIDER: "deepseek",
      DEEPSEEK_API_KEY: "",
    };

    // When
    const result = await runCli(["hello"], env);

    // Then
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/api key/i);
  });

  test(`Given Kimi is configured without an API key,
    When user runs the CLI,
    Then the CLI exits with a Kimi API key error`, async () => {
    // Given
    const env = {
      KEEL_PROVIDER: "kimi",
      KIMI_API_KEY: "",
    };

    // When
    const result = await runCli(["hello"], env);

    // Then
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toBe(
      "Error: KIMI_API_KEY is required. Set the API key to use Kimi.\n",
    );
  });

  test(`Given Qwen is configured without an API key,
    When user runs the CLI,
    Then the CLI exits with a Qwen API key error`, async () => {
    // Given
    const env = {
      KEEL_PROVIDER: "qwen",
      DASHSCOPE_API_KEY: "",
    };

    // When
    const result = await runCli(["hello"], env);

    // Then
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toBe(
      "Error: DASHSCOPE_API_KEY or QWEN_API_KEY is required. Qwen default endpoint is https://dashscope-intl.aliyuncs.com/compatible-mode/v1; set QWEN_BASE_URL if your key belongs to China region or a workspace-scoped DashScope endpoint.\n",
    );
  });

  test(`Given Kimi is configured with an unsupported cost model,
    When user runs the CLI with a max cost,
    Then the CLI rejects cost tracking before contacting the provider`, async () => {
    // Given
    const env = {
      KEEL_PROVIDER: "kimi",
      KIMI_API_KEY: "test-key",
      KIMI_MODEL: "kimi-k2.5",
    };

    // When
    const result = await runCli(["--max-cost", "1", "hello"], env);

    // Then
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      'Error: cost tracking is only supported for Kimi model "kimi-k2.6"; configured KIMI_MODEL="kimi-k2.5".\n',
    );
  });

  test(`Given Qwen is configured with an unknown cost model,
    When user runs the CLI with a max cost,
    Then the CLI rejects cost tracking before contacting the provider`, async () => {
    // Given
    const env = {
      KEEL_PROVIDER: "qwen",
      DASHSCOPE_API_KEY: "test-key",
      QWEN_MODEL: "qwen-unknown",
    };

    // When
    const result = await runCli(["--max-cost", "1", "hello"], env);

    // Then
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      'Error: cost tracking is only supported for known Qwen model pricing; configured QWEN_MODEL="qwen-unknown".\n',
    );
  });

  test(`Given an unknown provider is configured,
    When user runs the CLI,
    Then the CLI exits with a provider configuration error`, async () => {
    // Given
    const env = { KEEL_PROVIDER: "unknown" };

    // When
    const result = await runCli(["hello"], env);

    // Then
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toBe('Error: unknown provider "unknown"\n');
  });

  test(`Given a provider response is still in progress,
    When user interrupts the CLI,
    Then the CLI aborts the request and exits as interrupted`, async () => {
    // Given
    let receiveRequest: () => void = () => {};
    let closeResponse: () => void = () => {};
    const requestReceived = new Promise<void>((resolve) => {
      receiveRequest = resolve;
    });
    const responseClosed = new Promise<void>((resolve) => {
      closeResponse = resolve;
    });
    const server = createServer((req, res) => {
      if (req.url !== "/chat/completions") {
        res.writeHead(404);
        res.end();
        return;
      }

      req.resume();
      receiveRequest();
      res.on("close", closeResponse);
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

    const { child, result } = runCliProcess(["hello"], {
      DEEPSEEK_API_KEY: "test-key",
      DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
    });

    try {
      // When
      await withTimeout(
        requestReceived,
        5000,
        "CLI did not send the DeepSeek request to the local server",
      );
      child.kill("SIGINT");

      // Then
      await withTimeout(
        responseClosed,
        5000,
        "DeepSeek request was not cancelled after SIGINT",
      );
      const exit = await withTimeout(
        result,
        5000,
        "CLI did not exit after SIGINT",
      );
      expect(exit.exitCode).toBe(130);
      expect(exit.signal).toBeNull();
      expect(exit.stderr).not.toMatch(/AbortError|DOMException/);
    } finally {
      child.kill("SIGKILL");
      await close(server);
    }
  });
});
