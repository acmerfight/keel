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
  sseTextReplyWithUsage,
  tmpdir,
} from "./fixtures.ts";

describe("CLI Text Reply", () => {
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

  test(`Given the provider stream disconnects before answering,
    When user runs the CLI,
    Then the CLI reports a retry and prints the recovered answer`, async () => {
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
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        if (requestCount === 1) {
          res.end();
          return;
        }
        res.end(
          sseTextReplyWithUsage("Recovered.", {
            promptTokens: 10,
            promptCacheHitTokens: 0,
            promptCacheMissTokens: 10,
            completionTokens: 3,
          }),
        );
      });
    });
    await listen(server);

    try {
      // When
      const result = await runCli(["hello"], {
        DEEPSEEK_API_KEY: "test-key",
        DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
      });

      // Then
      expect(result.exitCode).toBe(0);
      expect(requestCount).toBe(2);
      expect(result.stdout).toBe("Recovered.\n");
      expect(result.stderr).toMatch(
        /^Provider retry: DeepSeek stream interrupted \(attempt 1\/4 in \d+ms\)\n$/,
      );
    } finally {
      await close(server);
    }
  });
});
