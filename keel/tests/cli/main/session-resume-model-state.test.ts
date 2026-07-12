import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, test } from "vitest";
import { runCliMain } from "../../../src/cli/index.ts";
import { requestModelSchema } from "../../../src/testing/cli-main-schemas.ts";
import { createRuntime } from "../../../src/testing/cli-runtime-fixtures.ts";
import {
  close,
  getPort,
  listen,
  sseTextReplyWithUsage,
} from "../../../src/testing/provider-sse-fixtures.ts";

describe("CLI Main - Session Resume Model State", () => {
  test(`Given a named session switches models and is later resumed,
    When the user continues without CLI provider overrides,
    Then the resumed prompt uses the persisted active model`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-session-"));
    const home = await mkdtemp(join(tmpdir(), "keel-cli-home-"));
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
        res.end(sseTextReplyWithUsage("Hello from restored Qwen."));
      });
    });
    await listen(server);
    const firstInput = new PassThrough();
    firstInput.end("remember alpha\n/model qwen/qwen3.7-max\n");
    const firstRun = createRuntime(["--session", "source"], {
      cwd: workspace,
      env: {
        KEEL_PROVIDER: "fake",
        KEEL_FORCE_INTERACTIVE: "1",
        KEEL_HOME: home,
        DASHSCOPE_API_KEY: "test-key",
        QWEN_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
      },
      input: firstInput,
    });

    try {
      const firstExitCode = await runCliMain(firstRun.runtime);
      const resumeInput = new PassThrough();
      resumeInput.end("hello\n");
      const resumeRun = createRuntime(["--resume", "source"], {
        cwd: workspace,
        env: {
          KEEL_PROVIDER: "fake",
          KEEL_FORCE_INTERACTIVE: "1",
          KEEL_HOME: home,
          DASHSCOPE_API_KEY: "test-key",
          QWEN_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
        },
        input: resumeInput,
      });
      const providerOnlyInput = new PassThrough();
      providerOnlyInput.end("hello again\n");
      const providerOnlyRun = createRuntime(
        ["--resume", "source", "--provider", "qwen"],
        {
          cwd: workspace,
          env: {
            KEEL_PROVIDER: "fake",
            KEEL_FORCE_INTERACTIVE: "1",
            KEEL_HOME: home,
            DASHSCOPE_API_KEY: "test-key",
            QWEN_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
          },
          input: providerOnlyInput,
        },
      );

      // When
      const resumeExitCode = await runCliMain(resumeRun.runtime);
      const providerOnlyExitCode = await runCliMain(providerOnlyRun.runtime);

      // Then
      expect(firstExitCode).toBe(0);
      expect(firstRun.stdout()).toContain(
        "Model switched to qwen/qwen3.7-max\n",
      );
      expect(resumeExitCode).toBe(0);
      expect(resumeRun.stdout()).toBe("Hello from restored Qwen.\n");
      expect(resumeRun.stderr()).toBe("");
      expect(providerOnlyExitCode).toBe(0);
      expect(providerOnlyRun.stdout()).toBe("Hello from restored Qwen.\n");
      expect(providerOnlyRun.stderr()).toBe("");
      const sourceLedgerLines = (
        await readFile(join(home, "sessions", "source", "ledger.jsonl"), "utf8")
      )
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(sourceLedgerLines).toContainEqual({
        schemaVersion: 3,
        type: "model_switch",
        timestamp: "1970-01-01T00:00:00.000Z",
        from: { providerId: "fake", model: "fake" },
        to: { providerId: "qwen", model: "qwen3.7-max" },
        consumedInputIds: [expect.any(String)],
      });
      expect(
        sourceLedgerLines.filter((line) => line.type === "model_switch"),
      ).toHaveLength(1);
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a resumed session has no persisted active model,
    When the user passes an explicit provider and model,
    Then the selection is persisted for later resumes`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-session-"));
    const home = await mkdtemp(join(tmpdir(), "keel-cli-home-"));
    const requestedModels: string[] = [];
    const server = createServer((req, res) => {
      if (req.url !== "/chat/completions") {
        res.writeHead(404);
        res.end();
        return;
      }
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        requestedModels.push(requestModelSchema.parse(JSON.parse(body)).model);
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.end(sseTextReplyWithUsage("Hello from selected Qwen."));
      });
    });
    await listen(server);
    const firstInput = new PassThrough();
    firstInput.end("remember alpha\n");
    const firstRun = createRuntime(["--session", "source"], {
      cwd: workspace,
      env: {
        KEEL_PROVIDER: "fake",
        KEEL_FORCE_INTERACTIVE: "1",
        KEEL_HOME: home,
      },
      input: firstInput,
    });

    try {
      const firstExitCode = await runCliMain(firstRun.runtime);
      const overrideInput = new PassThrough();
      overrideInput.end("hello\n");
      const overrideRun = createRuntime(
        ["--resume", "source", "--provider", "qwen", "--model", "qwen3.7-plus"],
        {
          cwd: workspace,
          env: {
            KEEL_PROVIDER: "fake",
            KEEL_FORCE_INTERACTIVE: "1",
            KEEL_HOME: home,
            DASHSCOPE_API_KEY: "test-key",
            QWEN_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
          },
          input: overrideInput,
        },
      );
      const plainInput = new PassThrough();
      plainInput.end("hello again\n");
      const plainRun = createRuntime(["--resume", "source"], {
        cwd: workspace,
        env: {
          KEEL_PROVIDER: "fake",
          KEEL_FORCE_INTERACTIVE: "1",
          KEEL_HOME: home,
          DASHSCOPE_API_KEY: "test-key",
          QWEN_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
        },
        input: plainInput,
      });

      // When
      const overrideExitCode = await runCliMain(overrideRun.runtime);
      const plainExitCode = await runCliMain(plainRun.runtime);

      // Then
      expect(firstExitCode).toBe(0);
      expect(firstRun.stdout()).toBe("Remembered: remember alpha\n");
      expect(firstRun.stderr()).toBe("");
      expect(overrideExitCode).toBe(0);
      expect(overrideRun.stdout()).toBe(
        [
          "Model selected as qwen/qwen3.7-plus for resumed session.",
          "Hello from selected Qwen.",
          "",
        ].join("\n"),
      );
      expect(overrideRun.stderr()).toBe("");
      expect(plainExitCode).toBe(0);
      expect(plainRun.stdout()).toBe("Hello from selected Qwen.\n");
      expect(plainRun.stderr()).toBe("");
      expect(requestedModels).toEqual(["qwen3.7-plus", "qwen3.7-plus"]);
      const sourceLedgerLines = (
        await readFile(join(home, "sessions", "source", "ledger.jsonl"), "utf8")
      )
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(sourceLedgerLines).toContainEqual({
        schemaVersion: 3,
        type: "model_switch",
        timestamp: "1970-01-01T00:00:00.000Z",
        from: null,
        to: { providerId: "qwen", model: "qwen3.7-plus" },
      });
      expect(
        sourceLedgerLines.filter((line) => line.type === "model_switch"),
      ).toHaveLength(1);
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a resumed session has no persisted active model,
    When the user overrides only the model,
    Then the resolved provider and model are persisted for later resumes`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-session-"));
    const home = await mkdtemp(join(tmpdir(), "keel-cli-home-"));
    const firstInput = new PassThrough();
    firstInput.end("remember alpha\n");
    const firstRun = createRuntime(["--session", "source"], {
      cwd: workspace,
      env: {
        KEEL_PROVIDER: "fake",
        KEEL_FORCE_INTERACTIVE: "1",
        KEEL_HOME: home,
      },
      input: firstInput,
    });

    try {
      const firstExitCode = await runCliMain(firstRun.runtime);
      const overrideInput = new PassThrough();
      overrideInput.end("what did I ask you to remember?\n");
      const overrideRun = createRuntime(
        ["--resume", "source", "--model", "fake"],
        {
          cwd: workspace,
          env: {
            KEEL_PROVIDER: "fake",
            KEEL_FORCE_INTERACTIVE: "1",
            KEEL_HOME: home,
          },
          input: overrideInput,
        },
      );
      const plainInput = new PassThrough();
      plainInput.end("hello\n");
      const plainRun = createRuntime(["--resume", "source"], {
        cwd: workspace,
        env: {
          KEEL_PROVIDER: "unknown",
          KEEL_FORCE_INTERACTIVE: "1",
          KEEL_HOME: home,
        },
        input: plainInput,
      });

      // When
      const overrideExitCode = await runCliMain(overrideRun.runtime);
      const plainExitCode = await runCliMain(plainRun.runtime);

      // Then
      expect(firstExitCode).toBe(0);
      expect(overrideExitCode).toBe(0);
      expect(overrideRun.stdout()).toBe(
        [
          "Model selected as fake/fake for resumed session.",
          "Earlier you said: remember alpha",
          "",
        ].join("\n"),
      );
      expect(overrideRun.stderr()).toBe("");
      expect(plainExitCode).toBe(0);
      expect(plainRun.stdout()).toBe("Remembered: hello\n");
      expect(plainRun.stderr()).toBe("");
      const sourceLedgerLines = (
        await readFile(join(home, "sessions", "source", "ledger.jsonl"), "utf8")
      )
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(sourceLedgerLines).toContainEqual({
        schemaVersion: 3,
        type: "model_switch",
        timestamp: "1970-01-01T00:00:00.000Z",
        from: null,
        to: { providerId: "fake", model: "fake" },
      });
      expect(
        sourceLedgerLines.filter((line) => line.type === "model_switch"),
      ).toHaveLength(1);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a resumed session has a persisted active provider,
    When the user overrides only the model,
    Then the override stays on the restored provider`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-session-"));
    const home = await mkdtemp(join(tmpdir(), "keel-cli-home-"));
    const requestedModels: string[] = [];
    const server = createServer((req, res) => {
      if (req.url !== "/chat/completions") {
        res.writeHead(404);
        res.end();
        return;
      }
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        requestedModels.push(requestModelSchema.parse(JSON.parse(body)).model);
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.end(sseTextReplyWithUsage("Hello from overridden Qwen."));
      });
    });
    await listen(server);
    const firstInput = new PassThrough();
    firstInput.end("remember alpha\n/model qwen/qwen3.7-plus\n");
    const firstRun = createRuntime(["--session", "source"], {
      cwd: workspace,
      env: {
        KEEL_PROVIDER: "fake",
        KEEL_FORCE_INTERACTIVE: "1",
        KEEL_HOME: home,
        DASHSCOPE_API_KEY: "test-key",
        QWEN_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
      },
      input: firstInput,
    });

    try {
      const firstExitCode = await runCliMain(firstRun.runtime);
      const overrideInput = new PassThrough();
      overrideInput.end("hello\n");
      const overrideRun = createRuntime(
        ["--resume", "source", "--model", "qwen-max"],
        {
          cwd: workspace,
          env: {
            KEEL_PROVIDER: "fake",
            KEEL_FORCE_INTERACTIVE: "1",
            KEEL_HOME: home,
            DASHSCOPE_API_KEY: "test-key",
            QWEN_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
          },
          input: overrideInput,
        },
      );

      // When
      const overrideExitCode = await runCliMain(overrideRun.runtime);

      // Then
      expect(firstExitCode).toBe(0);
      expect(overrideExitCode).toBe(0);
      expect(overrideRun.stdout()).toBe(
        [
          "Model overridden to qwen/qwen-max for resumed session.",
          "Hello from overridden Qwen.",
          "",
        ].join("\n"),
      );
      expect(overrideRun.stderr()).toBe("");
      expect(requestedModels).toEqual(["qwen-max"]);
      const sourceLedgerLines = (
        await readFile(join(home, "sessions", "source", "ledger.jsonl"), "utf8")
      )
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(sourceLedgerLines).toContainEqual({
        schemaVersion: 3,
        type: "model_switch",
        timestamp: "1970-01-01T00:00:00.000Z",
        from: { providerId: "qwen", model: "qwen3.7-plus" },
        to: { providerId: "qwen", model: "qwen-max" },
      });
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a resumed session has a persisted active model,
    When the user passes an explicit provider override,
    Then the override is persisted and used for the resumed prompt`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-session-"));
    const home = await mkdtemp(join(tmpdir(), "keel-cli-home-"));
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
        res.end(sseTextReplyWithUsage("Unexpected Qwen call."));
      });
    });
    await listen(server);
    const firstInput = new PassThrough();
    firstInput.end("remember alpha\n/model qwen/qwen3.7-plus\n");
    const firstRun = createRuntime(["--session", "source"], {
      cwd: workspace,
      env: {
        KEEL_PROVIDER: "fake",
        KEEL_FORCE_INTERACTIVE: "1",
        KEEL_HOME: home,
        DASHSCOPE_API_KEY: "test-key",
        QWEN_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
      },
      input: firstInput,
    });

    try {
      const firstExitCode = await runCliMain(firstRun.runtime);
      const overrideInput = new PassThrough();
      overrideInput.end("what did I ask you to remember?\n");
      const overrideRun = createRuntime(
        ["--resume", "source", "--provider", "fake", "--model", "fake"],
        {
          cwd: workspace,
          env: {
            KEEL_PROVIDER: "qwen",
            KEEL_FORCE_INTERACTIVE: "1",
            KEEL_HOME: home,
            DASHSCOPE_API_KEY: "test-key",
            QWEN_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
          },
          input: overrideInput,
        },
      );

      // When
      const overrideExitCode = await runCliMain(overrideRun.runtime);

      // Then
      expect(firstExitCode).toBe(0);
      expect(overrideExitCode).toBe(0);
      expect(overrideRun.stdout()).toBe(
        [
          "Model overridden to fake/fake for resumed session.",
          "Earlier you said: remember alpha",
          "",
        ].join("\n"),
      );
      expect(overrideRun.stderr()).toBe("");
      const sourceLedgerLines = (
        await readFile(join(home, "sessions", "source", "ledger.jsonl"), "utf8")
      )
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(sourceLedgerLines).toContainEqual({
        schemaVersion: 3,
        type: "model_switch",
        timestamp: "1970-01-01T00:00:00.000Z",
        from: { providerId: "qwen", model: "qwen3.7-plus" },
        to: { providerId: "fake", model: "fake" },
      });
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });
});
