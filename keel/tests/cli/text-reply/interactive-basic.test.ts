import { describe, expect, test } from "vitest";
import {
  close,
  createServer,
  getPort,
  listen,
  requestModelSchema,
  runCliProcess,
  sseTextReplyWithUsage,
  withTimeout,
} from "./fixtures.ts";

describe("CLI Text Reply", () => {
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
      expect(exit.stdout).toContain("keel --ephemeral");
      expect(exit.stdout).toContain("keel --session <id>");
      const sessionVisibilityNote =
        "Interactive sessions save ledgers by default with best-effort at-rest redaction.";
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
});
