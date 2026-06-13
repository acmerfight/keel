import { createServer } from "node:http";
import type { Server } from "node:net";
import { describe, expect, test } from "vitest";
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
        "Usage: keel [--allow-bash] [--max-cost <usd>] [--report <file>] <message>",
        "       keel eval [--suite <dir>] [--task <id>] [--trials <n>] [--out <file>] [--check]",
        "       keel /undo",
        "",
        "--allow-bash enables trusted shell commands. Shell commands run with the current OS user's permissions and may read or modify gitignored files.",
        "--report writes a machine-readable JSON run report (turns, stop reason, token usage, cost) to the given file.",
        "",
      ].join("\n"),
    );
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

  test(`Given user requests an interactive session report,
    When user runs the CLI without a message,
    Then the CLI rejects the unsupported report option`, async () => {
    // Given
    const args: readonly string[] = ["--report", "run.json"];

    // When
    const result = await runCli(args, { KEEL_FORCE_INTERACTIVE: "1" });

    // Then
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "Error: --report is only supported for one-shot runs.\n",
    );
  });

  test(`Given user asks for diagnostics,
    When user runs the CLI doctor command,
    Then the CLI reports bundled ripgrep status without requiring a provider`, async () => {
    // Given
    const args: readonly string[] = ["--doctor"];

    // When
    const result = await runCli(args, {
      KEEL_PROVIDER: "deepseek",
      DEEPSEEK_API_KEY: "",
    });

    // Then
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Keel doctor");
    expect(result.stdout).toContain("ripgrep: ok (vscode-ripgrep)");
    expect(result.stdout).toContain("ripgrep path:");
    expect(result.stdout).toMatch(/^ripgrep version: ripgrep\s+\S+/m);
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
