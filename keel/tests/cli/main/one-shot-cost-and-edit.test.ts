import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { z } from "zod";
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
  sseToolCall,
  sseToolFinish,
} from "../../../src/testing/provider-sse-fixtures.ts";

describe("CLI Main - One Shot Cost And Edit", () => {
  test(`Given a provider fails after changing a workspace with unavailable undo protection,
    When the one-shot stream terminates with that error,
    Then the change remains and one separated warning is shown before the terminal error`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-undo-error-"));
    let requestCount = 0;
    const server = createServer((req, res) => {
      if (req.url !== "/chat/completions") {
        res.writeHead(404);
        res.end();
        return;
      }
      req.resume();
      req.on("end", () => {
        requestCount += 1;
        if (requestCount === 1) {
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          res.write(
            sseToolCall("write_generated", "write", {
              path: "generated.txt",
              content: "generated\n",
            }),
          );
          res.write(sseToolFinish());
          res.end("data: [DONE]\n\n");
          return;
        }
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "provider failed" } }));
      });
    });
    await listen(server);
    let terminal = "";
    const fixture = createRuntime(["create generated.txt"], {
      cwd: workspace,
      env: {
        DEEPSEEK_API_KEY: "test-key",
        DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
      },
      onStdout: (text) => {
        terminal += text;
      },
      onStderr: (text) => {
        terminal += text;
      },
    });

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(1);
      expect(await readFile(join(workspace, "generated.txt"), "utf8")).toBe(
        "generated\n",
      );
      expect(
        fixture
          .stderr()
          .match(
            /Warning: change applied; undo checkpoint unavailable for this task\./gu,
          ),
      ).toHaveLength(1);
      expect(fixture.stderr()).toContain("provider failed");
      const warningIndex = terminal.indexOf(
        "Warning: change applied; undo checkpoint unavailable for this task.",
      );
      expect(warningIndex).toBeGreaterThan(
        terminal.indexOf("Tool: write generated.txt\n"),
      );
      expect(terminal.indexOf("provider failed")).toBeGreaterThan(warningIndex);
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a task changes a Git workspace whose undo checkpoint cannot be written,
    When the one-shot run completes with a report,
    Then the change succeeds and the user sees one unavailable-protection warning recorded in the report`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-undo-warning-"));
    execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
    await mkdir(join(workspace, ".git", "keel", "undo-checkpoints.json"), {
      recursive: true,
    });
    const reportPath = join(workspace, "run.json");
    let terminal = "";
    const fixture = createRuntime(
      ["--report", reportPath, "create generated.json"],
      {
        cwd: workspace,
        env: { KEEL_PROVIDER: "fake" },
        onStdout: (text) => {
          terminal += text;
        },
        onStderr: (text) => {
          terminal += text;
        },
      },
    );
    const reportSchema = z.object({
      undoProtection: z.object({
        status: z.literal("unavailable"),
        checkpointsWritten: z.literal(0),
        failures: z.array(
          z.object({
            reason: z.literal("checkpoint_write_failed"),
            count: z.literal(1),
          }),
        ),
        latestCheckpoint: z.object({
          written: z.literal(false),
          reason: z.literal("checkpoint_write_failed"),
        }),
      }),
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
      expect(fixture.stderr()).toBe(
        "Tool: write generated.json\nWarning: change applied; undo checkpoint unavailable for this task.\n",
      );
      expect(terminal).toBe(
        "Tool: write generated.json\nCreated generated.json\nWarning: change applied; undo checkpoint unavailable for this task.\n",
      );
      expect(
        reportSchema.parse(JSON.parse(await readFile(reportPath, "utf8"))),
      ).toEqual({
        undoProtection: {
          status: "unavailable",
          checkpointsWritten: 0,
          failures: [{ reason: "checkpoint_write_failed", count: 1 }],
          latestCheckpoint: {
            written: false,
            reason: "checkpoint_write_failed",
          },
        },
      });
    } finally {
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
      expectedLines: [
        "Error: missing API key for deepseek.",
        "Set DEEPSEEK_API_KEY for this run, or store it:",
        "  printf '%s\\n' \"$DEEPSEEK_API_KEY\" | keel auth login deepseek --with-api-key",
        "  keel config set-provider deepseek",
        "  keel --doctor",
      ],
    },
    {
      provider: "deepseek",
      env: { KEEL_PROVIDER: "deepseek", DEEPSEEK_API_KEY: "   " },
      expectedLines: [
        "Error: missing API key for deepseek.",
        "Set DEEPSEEK_API_KEY for this run, or store it:",
        "  printf '%s\\n' \"$DEEPSEEK_API_KEY\" | keel auth login deepseek --with-api-key",
        "  keel config set-provider deepseek",
        "  keel --doctor",
      ],
    },
    {
      provider: "kimi",
      env: { KEEL_PROVIDER: "kimi", KIMI_API_KEY: "" },
      expectedLines: [
        "Error: missing API key for kimi.",
        "Set KIMI_API_KEY for this run, or store it:",
        "  printf '%s\\n' \"$KIMI_API_KEY\" | keel auth login kimi --with-api-key",
        "  keel config set-provider kimi",
        "  keel --doctor",
      ],
    },
    {
      provider: "qwen",
      env: { KEEL_PROVIDER: "qwen", DASHSCOPE_API_KEY: "" },
      expectedLines: [
        "Error: missing API key for qwen.",
        "Set DASHSCOPE_API_KEY or QWEN_API_KEY for this run, or store it:",
        `  printf '%s\\n' "\${DASHSCOPE_API_KEY:-$QWEN_API_KEY}" | keel auth login qwen --with-api-key`,
        "  keel config set-provider qwen",
        "  keel --doctor",
        "Qwen default endpoint is https://dashscope-intl.aliyuncs.com/compatible-mode/v1; set QWEN_BASE_URL if your key belongs to China region or a workspace-scoped DashScope endpoint.",
      ],
    },
  ])(`Given $provider is configured without an API key,
    When the CLI main resolves the provider,
    Then it tells the user how to configure provider credentials`, async ({
    env,
    expectedLines,
  }) => {
    // Given
    const fixture = createRuntime(["hello"], { env });

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    for (const line of expectedLines) {
      expect(fixture.stderr()).toContain(line);
    }
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

  test(`Given Qwen runs under a max-cost budget,
    When the CLI sends the admitted provider request,
    Then it bounds reasoning plus answer output with max_completion_tokens`, async () => {
    // Given
    let requestBody: unknown;
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
        requestBody = JSON.parse(body);
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.end(
          sseTextReplyWithUsage("Qwen budget respected.", {
            prompt_tokens: 100,
            completion_tokens: 10,
          }),
        );
      });
    });
    await listen(server);
    const fixture = createRuntime(
      [
        "--provider",
        "qwen",
        "--model",
        "qwen3.7-plus",
        "--max-cost",
        "0.1",
        "hello",
      ],
      {
        env: {
          DASHSCOPE_API_KEY: "test-key",
          QWEN_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
        },
      },
    );

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(0);
      expect(fixture.stdout()).toBe("Qwen budget respected.\n");
      expect(
        z
          .object({
            max_completion_tokens: z.number().int().positive(),
            max_tokens: z.undefined().optional(),
          })
          .passthrough()
          .parse(requestBody),
      ).toMatchObject({ max_completion_tokens: expect.any(Number) });
    } finally {
      await close(server);
    }
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
    const fixture = createRuntime(["--max-cost", "0.01", "hello"], {
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
      expect(fixture.stderr()).toBe(
        "Tool: write generated.json\nWarning: change applied; undo checkpoint unavailable for this task.\n",
      );
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
