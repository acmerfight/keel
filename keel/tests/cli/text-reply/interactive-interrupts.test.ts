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
  sseTextReplyWithUsage,
  tmpdir,
  withTimeout,
} from "./fixtures.ts";

describe("CLI Text Reply", () => {
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
        schemaVersion: 4,
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
        contextCompactions: [],
      });
    } finally {
      child.kill("SIGKILL");
      await rm(workspace, { recursive: true, force: true });
    }
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
