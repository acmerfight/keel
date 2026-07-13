import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, test } from "vitest";
import { runCliMain } from "../../../src/cli/index.ts";
import {
  requestModelSchema,
  runReportSchema,
} from "../../../src/testing/cli-main-schemas.ts";
import { createRuntime } from "../../../src/testing/cli-runtime-fixtures.ts";
import {
  close,
  getPort,
  listen,
  sseTextReplyWithUsage,
} from "../../../src/testing/provider-sse-fixtures.ts";

describe("CLI Main - Report Edit And Provider Env", () => {
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
        schemaVersion: 9,
        modelsUsed: [{ provider: "fake", model: "fake" }],
        usageByModel: [
          {
            provider: "fake",
            model: "fake",
            turns: 1,
            costUsd: 0,
          },
        ],
        costUsd: 0,
        contextCompactions: [],
        undoProtection: {
          status: "not_applicable",
          checkpointsWritten: 0,
          failures: [],
          latestCheckpoint: null,
        },
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
      expect(report).toMatchObject({
        modelsUsed: [{ provider: "fake", model: "fake" }],
        costUsd: 0,
      });
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
      expect(fixture.stderr()).toBe(
        "Tool: read note.txt\nTool: edit note.txt\nWarning: change applied; undo checkpoint unavailable for this task.\n",
      );
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
        "Tool: read note.txt\nTool: edit note.txt\nTool failed: edit note.txt\n",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the fake provider cannot read the edit target,
    When the CLI main runs the tool call,
    Then it reports the failed read result without crashing`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-cli-main-edit-missing-"),
    );
    const fixture = createRuntime(["replace old with new in missing.txt"], {
      cwd: workspace,
      env: { KEEL_PROVIDER: "fake" },
    });

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(0);
      expect(fixture.stdout()).toContain("Tool failed:");
      expect(fixture.stdout()).toContain("file not found");
      expect(fixture.stderr()).toBe(
        "Tool: read missing.txt\nTool failed: read missing.txt\n",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the fake provider requests a write that cannot apply,
    When the CLI main runs the tool call,
    Then it reports the failed write result without crashing`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-cli-main-write-fail-"),
    );
    await writeFile(join(workspace, "note.txt"), "already exists\n", "utf8");
    const fixture = createRuntime(["create note.txt"], {
      cwd: workspace,
      env: { KEEL_PROVIDER: "fake" },
    });

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(0);
      expect(await readFile(join(workspace, "note.txt"), "utf8")).toBe(
        "already exists\n",
      );
      expect(fixture.stdout()).toContain("Tool failed:");
      expect(fixture.stderr()).toBe(
        "Tool: write note.txt\nTool failed: write note.txt\n",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an interactive turn uses the default provider without an API key,
    When the CLI main runs in-process,
    Then it reports setup guidance for the default provider`, async () => {
    // Given
    const input = new PassThrough();
    const fixture = createRuntime([], {
      env: { KEEL_FORCE_INTERACTIVE: "1" },
      input,
    });

    // When
    const run = runCliMain(fixture.runtime);
    input.write("hello\n");
    input.end();
    const exitCode = await run;

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toContain("Error: missing API key for deepseek.");
    expect(fixture.stderr()).toContain(
      "Set DEEPSEEK_API_KEY for this run, or store it:",
    );
    expect(fixture.stderr()).toContain(
      "  printf '%s\\n' \"$DEEPSEEK_API_KEY\" | keel auth login deepseek --with-api-key",
    );
    expect(fixture.stderr()).toContain("  keel config set-provider deepseek");
    expect(fixture.stderr()).toContain("  keel --doctor");
  });

  test(`Given Qwen is configured with only QWEN_API_KEY,
    When the CLI main runs in-process,
    Then the provider key fallback is used`, async () => {
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
        res.end(sseTextReplyWithUsage("Qwen fallback."));
      });
    });
    await listen(server);
    const fixture = createRuntime(["hello"], {
      env: {
        KEEL_PROVIDER: "qwen",
        QWEN_API_KEY: "test-key",
        QWEN_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
      },
    });

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(0);
      expect(fixture.stdout()).toBe("Qwen fallback.\n");
      expect(fixture.stderr()).toBe("");
    } finally {
      await close(server);
    }
  });

  test(`Given provider and model flags override provider env,
    When the CLI main runs in-process,
    Then the selected model is sent to the provider`, async () => {
    // Given
    let capturedModel: string | undefined;
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
        capturedModel = requestModelSchema.parse(JSON.parse(body)).model;
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.end(sseTextReplyWithUsage("Selected Qwen."));
      });
    });
    await listen(server);
    const fixture = createRuntime(
      ["--provider", "qwen", "--model", "qwen3.7-plus", "hello"],
      {
        env: {
          KEEL_PROVIDER: "fake",
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
      expect(fixture.stdout()).toBe("Selected Qwen.\n");
      expect(fixture.stderr()).toBe("");
      expect(capturedModel).toBe("qwen3.7-plus");
    } finally {
      await close(server);
    }
  });

  test(`Given Kimi is configured without a model override,
    When the CLI main runs in-process,
    Then the default Kimi model configuration is used`, async () => {
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
        res.end(sseTextReplyWithUsage("Kimi default."));
      });
    });
    await listen(server);
    const fixture = createRuntime(["hello"], {
      env: {
        KEEL_PROVIDER: "kimi",
        KIMI_API_KEY: "test-key",
        KIMI_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
      },
    });

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(0);
      expect(fixture.stdout()).toBe("Kimi default.\n");
      expect(fixture.stderr()).toBe("");
    } finally {
      await close(server);
    }
  });
});
