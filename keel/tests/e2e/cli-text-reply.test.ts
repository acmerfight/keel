import { execFile, spawn } from "node:child_process";
import { createServer } from "node:http";
import type { Server } from "node:net";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const CLI_PATH = join(import.meta.dirname, "../../src/cli/index.ts");

interface SpawnResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
}

function runCli(
  args: readonly string[],
  env: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const child = execFile(
      "node",
      ["--experimental-strip-types", CLI_PATH, ...args],
      {
        env: { ...process.env, ...env },
        timeout: 5000,
      },
      (error, stdout, stderr) => {
        resolve({
          stdout,
          stderr,
          exitCode: error?.code ? Number(error.code) : (child.exitCode ?? 0),
        });
      },
    );
  });
}

function runCliProcess(
  args: readonly string[],
  env: Record<string, string> = {},
) {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const child = spawn(
    "node",
    ["--experimental-strip-types", CLI_PATH, ...args],
    {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  child.stdout.on("data", (chunk: Buffer) => {
    stdout.push(chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr.push(chunk);
  });

  const result = new Promise<SpawnResult>((resolve) => {
    child.on("exit", (exitCode, signal) => {
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        exitCode,
        signal,
      });
    });
  });

  return { child, result };
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

  test(`Given no provider API key and no fake provider,
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

  test(`Given a DeepSeek request is still streaming,
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
        1000,
        "CLI did not send the DeepSeek request to the local server",
      );
      child.kill("SIGINT");

      // Then
      await withTimeout(
        responseClosed,
        1000,
        "DeepSeek request was not cancelled after SIGINT",
      );
      const exit = await withTimeout(
        result,
        1000,
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
