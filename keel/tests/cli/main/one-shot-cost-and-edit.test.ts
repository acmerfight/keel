import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { runCliMain } from "../../../src/cli/index.ts";
import {
  createRuntime,
  type SigintCapture,
} from "../../../src/testing/cli-runtime-fixtures.ts";
import {
  close,
  getPort,
  listen,
  sseTextReplyWithUsage,
} from "../../../src/testing/provider-sse-fixtures.ts";

describe("CLI Main - One Shot Cost And Edit", () => {
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

  test(`Given DeepSeek is selected with unknown model pricing and a max cost,
    When the CLI main resolves cost tracking,
    Then it rejects the run before calling the provider`, async () => {
    // Given
    const fixture = createRuntime(
      [
        "--max-cost",
        "1",
        "--provider",
        "deepseek",
        "--model",
        "deepseek-unknown",
        "hello",
      ],
      {
        env: { DEEPSEEK_API_KEY: "test-key" },
      },
    );

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe(
      'Error: cost tracking is only supported for known DeepSeek model pricing; configured --model="deepseek-unknown".\n',
    );
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
      env: {
        KEEL_PROVIDER: "qwen",
        DASHSCOPE_API_KEY: "test-key",
        QWEN_MODEL: "qwen-unknown",
      },
      stderr:
        'Error: cost tracking is only supported for known Qwen model pricing; configured QWEN_MODEL="qwen-unknown".\n',
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
});
