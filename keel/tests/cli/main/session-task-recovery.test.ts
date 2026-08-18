import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import type { SessionMessage } from "../../../src/agent/session-message.ts";
import { runCliMain } from "../../../src/cli/index.ts";
import { createSessionTaskRecovery } from "../../../src/cli/interactive-session/task-recovery.ts";
import {
  createSessionStore,
  resumeSessionStore,
} from "../../../src/cli/session-store.ts";
import { runCliProcess } from "../../../src/testing/cli-harness.ts";
import {
  createRuntime as createCliRuntime,
  withTimeout,
} from "../../../src/testing/cli-runtime-fixtures.ts";
import {
  close,
  getPort,
  listen,
  sseTextReplyWithUsage,
  sseToolCall,
  sseToolFinish,
} from "../../../src/testing/provider-sse-fixtures.ts";
import { runtime } from "../../../src/testing/session-store-fixtures.ts";

describe("CLI Main - Session Task Recovery", () => {
  test(`Given a named session is killed during a provider request,
    When the user resumes the session,
    Then Keel completes the same Task without committing partial output`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-task-recovery-"));
    const home = await mkdtemp(join(tmpdir(), "keel-task-recovery-home-"));
    const prompt = "recover provider task sentinel";
    const partial = "partial response before crash";
    const completed = "Recovered the same durable Task.";
    const requestBodies: string[] = [];
    let observeFirstRequest: () => void = () => {};
    const firstRequestObserved = new Promise<void>((resolve) => {
      observeFirstRequest = resolve;
    });
    const server = createServer((request, response) => {
      if (request.url !== "/chat/completions") {
        response.writeHead(404);
        response.end();
        return;
      }

      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });
      request.on("end", () => {
        requestBodies.push(Buffer.concat(chunks).toString("utf8"));
        response.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        if (requestBodies.length === 1) {
          response.write(
            `data: ${JSON.stringify({
              choices: [{ delta: { content: partial } }],
            })}\n\n`,
          );
          observeFirstRequest();
          return;
        }
        response.end(sseTextReplyWithUsage(completed));
      });
    });
    await listen(server);
    const environment = {
      DEEPSEEK_API_KEY: "test-key",
      DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
      KEEL_FORCE_INTERACTIVE: "1",
      KEEL_HOME: home,
      KEEL_PROVIDER: "deepseek",
    };
    const first = runCliProcess(["--session", "provider-recovery"], {
      cwd: workspace,
      env: environment,
      stdin: "pipe",
    });
    first.child.stdin?.on("error", () => {});

    try {
      first.child.stdin?.write(`${prompt}\n`);
      await withTimeout(
        firstRequestObserved,
        5_000,
        "initial provider request was not observed",
      );
      first.child.kill("SIGKILL");
      const killed = await withTimeout(
        first.result,
        5_000,
        "initial Keel process did not terminate",
      );
      expect(killed.signal).toBe("SIGKILL");

      // When
      const resumed = runCliProcess(
        ["--resume", "provider-recovery", "--model", "deepseek-reasoner"],
        {
          cwd: workspace,
          env: environment,
          stdin: "pipe",
        },
      );
      resumed.child.stdin?.end();
      const resumedExit = await withTimeout(
        resumed.result,
        5_000,
        "resumed Keel process did not finish",
      );

      // Then
      expect(resumedExit.exitCode, resumedExit.stderr).toBe(0);
      expect(resumedExit.signal).toBeNull();
      expect(resumedExit.stdout).toContain(completed);
      expect(requestBodies).toHaveLength(2);
      expect(requestBodies[1]?.split(prompt)).toHaveLength(2);
      expect(JSON.parse(requestBodies[1] ?? "{}")).toMatchObject({
        model: JSON.parse(requestBodies[0] ?? "{}").model,
      });
      const ledger = await readFile(
        join(home, "sessions", "provider-recovery", "ledger.jsonl"),
        "utf8",
      );
      expect(ledger).not.toContain(partial);
    } finally {
      first.child.kill("SIGKILL");
      await close(server);
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a named session is killed after a bash effect starts,
    When the user resumes the session,
    Then Keel preserves the unknown effect without dispatching the old invocation again`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-tool-recovery-"));
    const home = await mkdtemp(join(tmpdir(), "keel-tool-recovery-home-"));
    const markerPath = join(workspace, "effect-count.txt");
    const bashPidPath = join(workspace, "bash.pid");
    const command =
      "printf %s $$ > bash.pid; printf x >> effect-count.txt; sleep 30";
    let requestCount = 0;
    const server = createServer((request, response) => {
      if (request.url !== "/chat/completions") {
        response.writeHead(404);
        response.end();
        return;
      }
      requestCount++;
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end(
        `${sseToolCall("bash_unknown_effect", "bash", {
          command,
        })}${sseToolFinish()}data: [DONE]\n\n`,
      );
    });
    await listen(server);
    const environment = {
      DEEPSEEK_API_KEY: "test-key",
      DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
      KEEL_FORCE_INTERACTIVE: "1",
      KEEL_HOME: home,
      KEEL_PROVIDER: "deepseek",
    };
    const original = runCliProcess(
      ["--session", "tool-effect-recovery", "--bash-policy", "trusted"],
      {
        cwd: workspace,
        env: environment,
        stdin: "pipe",
      },
    );
    original.child.stdin?.on("error", () => {});

    try {
      original.child.stdin?.write("perform the requested effect once\n");
      await withTimeout(
        (async () => {
          for (;;) {
            const marker = await readFile(markerPath, "utf8").catch(() => "");
            if (marker === "x") return;
            await new Promise<void>((resolve) => setTimeout(resolve, 10));
          }
        })(),
        5_000,
        "bash effect was not observed",
      );
      original.child.kill("SIGKILL");
      expect(
        (
          await withTimeout(
            original.result,
            5_000,
            "original tool process did not terminate",
          )
        ).signal,
      ).toBe("SIGKILL");

      // When
      const resumed = runCliProcess(
        ["--resume", "tool-effect-recovery", "--bash-policy", "trusted"],
        {
          cwd: workspace,
          env: environment,
          stdin: "pipe",
        },
      );
      resumed.child.stdin?.end();
      const resumedResult = await withTimeout(
        resumed.result,
        5_000,
        "tool recovery process did not finish",
      );

      // Then
      expect(resumedResult.exitCode, resumedResult.stderr).toBe(0);
      expect(resumedResult.stderr).toContain("recovery_blocked");
      expect(resumedResult.stderr).toContain("tool_effect");
      expect(requestCount).toBe(1);
      expect(await readFile(markerPath, "utf8")).toBe("x");
      const ledger = await readFile(
        join(home, "sessions", "tool-effect-recovery", "ledger.jsonl"),
        "utf8",
      );
      expect(ledger).toContain('"type":"tool_intent"');
      expect(ledger).toContain('"kind":"interrupted_effect_unknown"');
    } finally {
      original.child.kill("SIGKILL");
      const bashPid = Number.parseInt(
        await readFile(bashPidPath, "utf8").catch(() => ""),
        10,
      );
      if (process.platform !== "win32" && Number.isSafeInteger(bashPid)) {
        try {
          process.kill(-bashPid, "SIGKILL");
        } catch {
          // The bounded test command may already have exited.
        }
      }
      await close(server);
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a named session is SIGKILLed while a foreground read-only delegate is running,
    When the user resumes without enabling delegation again,
    Then agent-tree evidence continues the same Task without a duplicate child or recovery decision`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-delegate-recovery-"));
    const home = await mkdtemp(join(tmpdir(), "keel-delegate-recovery-home-"));
    const sessionId = "foreground-delegate-recovery";
    const completed = "Continued the original Task from agent-tree evidence.";
    const reportPath = join(workspace, "delegate-recovery-report.json");
    const requestBodies: string[] = [];
    const childStarted = Promise.withResolvers<void>();
    const server = createServer((request, response) => {
      if (request.url !== "/chat/completions") {
        response.writeHead(404);
        response.end();
        return;
      }
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });
      request.on("end", () => {
        requestBodies.push(Buffer.concat(chunks).toString("utf8"));
        response.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        if (requestBodies.length === 1) {
          response.end(
            `${sseToolCall("delegate_interrupted", "delegate", {
              task: "Inspect the workspace until the parent owner exits.",
            })}${sseToolFinish()}data: [DONE]\n\n`,
          );
          return;
        }
        if (requestBodies.length === 2) {
          childStarted.resolve();
          response.write(
            `data: ${JSON.stringify({
              choices: [{ delta: { content: "partial child work" } }],
            })}\n\n`,
          );
          return;
        }
        response.end(sseTextReplyWithUsage(completed));
      });
    });
    await listen(server);
    const environment = {
      DEEPSEEK_API_KEY: "test-key",
      DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
      KEEL_FORCE_INTERACTIVE: "1",
      KEEL_HOME: home,
      KEEL_PROVIDER: "deepseek",
    };
    const original = runCliProcess(
      [
        "--session",
        sessionId,
        "--agent-policy",
        "explicit",
        "--max-cost",
        "0.05",
        "--no-skills",
      ],
      { cwd: workspace, env: environment, stdin: "pipe" },
    );
    original.child.stdin?.on("error", () => {});

    try {
      original.child.stdin?.end("Use one read-only subagent to investigate.\n");
      await withTimeout(
        childStarted.promise,
        5_000,
        "foreground child did not start",
      );
      original.child.kill("SIGKILL");
      expect(
        (
          await withTimeout(
            original.result,
            5_000,
            "original delegate process did not terminate",
          )
        ).signal,
      ).toBe("SIGKILL");

      // When
      const resumed = runCliProcess(
        ["--resume", sessionId, "--no-skills", "--report", reportPath],
        { cwd: workspace, env: environment, stdin: "pipe" },
      );
      resumed.child.stdin?.end();
      const resumedResult = await withTimeout(
        resumed.result,
        5_000,
        "delegate recovery process did not finish",
      );

      // Then
      expect(resumedResult.exitCode, resumedResult.stderr).toBe(0);
      expect(resumedResult.stdout).toContain(completed);
      expect(resumedResult.stderr).not.toContain("recovery_blocked");
      expect(requestBodies).toHaveLength(3);
      expect(requestBodies[1]).toContain("Delegation ID:");
      expect(requestBodies[2]).toContain("interrupted_effect_unknown");
      expect(requestBodies[2]).toContain("agent_tree");
      const recoveredRequest = z
        .object({
          messages: z.array(
            z
              .object({
                role: z.string(),
                content: z.unknown(),
              })
              .passthrough(),
          ),
        })
        .passthrough()
        .parse(JSON.parse(requestBodies[2] ?? "{}"));
      const recoveredToolContent = z
        .string()
        .parse(
          recoveredRequest.messages.find((message) => message.role === "tool")
            ?.content,
        );
      expect(JSON.parse(recoveredToolContent)).toMatchObject({
        status: "interrupted_effect_unknown",
        reconciliation: {
          ownerKey: "agent_tree",
          effect: "applied",
          evidence: {
            kind: "agent_tree_delegate",
            status: "interrupted",
            result: {
              status: "interrupted",
              finalText: null,
              error:
                "Child was interrupted when its foreground session owner exited.",
            },
          },
        },
      });
      const ledger = await readFile(
        join(home, "sessions", sessionId, "ledger.jsonl"),
        "utf8",
      );
      expect(ledger.match(/"type":"effect_reconciled"/gu)).toHaveLength(1);
      expect(ledger).not.toContain('"type":"task_recovery_disposition"');
      expect(ledger).toContain('"outcome":"completed"');
      const report = z
        .object({
          tasks: z.array(
            z
              .object({
                outcome: z.string(),
              })
              .passthrough(),
          ),
        })
        .passthrough()
        .parse(JSON.parse(await readFile(reportPath, "utf8")));
      expect(report.tasks).toMatchObject([{ outcome: "completed" }]);
      const agentEvents = await readFile(
        join(home, "sessions", sessionId, "agents", "events.jsonl"),
        "utf8",
      );
      expect(agentEvents.match(/"type":"agent_run_accepted"/gu)).toHaveLength(
        1,
      );
      expect(agentEvents.match(/"type":"agent_result"/gu)).toHaveLength(1);
    } finally {
      original.child.kill("SIGKILL");
      await close(server);
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a named session is SIGKILLed after a background read-only delegate is accepted,
    When the user resumes without enabling delegation again,
    Then agent-tree evidence continues the same Task without a duplicate child or recovery decision`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-background-delegate-recovery-"),
    );
    const home = await mkdtemp(
      join(tmpdir(), "keel-background-delegate-recovery-home-"),
    );
    const sessionId = "background-delegate-recovery";
    const completed =
      "Continued the original Task from background agent-tree evidence.";
    const requestBodies: string[] = [];
    const server = createServer((request, response) => {
      if (request.url !== "/chat/completions") {
        response.writeHead(404);
        response.end();
        return;
      }
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });
      request.on("end", () => {
        requestBodies.push(Buffer.concat(chunks).toString("utf8"));
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.end(sseTextReplyWithUsage(completed));
      });
    });
    await listen(server);
    const fixture = spawn(
      process.execPath,
      [
        "--experimental-strip-types",
        join(
          process.cwd(),
          "tests/fixtures/session-task-recovery-background-accepted.ts",
        ),
        home,
        workspace,
        sessionId,
      ],
      { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] },
    );
    if (fixture.stdout === null || fixture.stderr === null) {
      throw new Error("accepted background fixture requires piped output");
    }
    let fixtureStdout = "";
    let fixtureStderr = "";
    fixture.stdout.setEncoding("utf8");
    fixture.stderr.setEncoding("utf8");
    const fixtureReady = Promise.withResolvers<void>();
    fixture.stdout.on("data", (chunk: string) => {
      fixtureStdout += chunk;
      if (fixtureStdout.includes("ready\n")) fixtureReady.resolve();
    });
    fixture.stderr.on("data", (chunk: string) => {
      fixtureStderr += chunk;
    });
    const fixtureExit = new Promise<{
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
    }>((resolve, reject) => {
      fixture.once("error", reject);
      fixture.once("exit", (code, signal) => {
        resolve({ code, signal });
      });
    });
    const environment = {
      DEEPSEEK_API_KEY: "test-key",
      DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
      KEEL_FORCE_INTERACTIVE: "1",
      KEEL_HOME: home,
      KEEL_PROVIDER: "deepseek",
    };

    try {
      await withTimeout(
        fixtureReady.promise,
        5_000,
        `accepted background fixture did not become ready: ${fixtureStderr}`,
      );
      fixture.kill("SIGKILL");
      expect(
        (
          await withTimeout(
            fixtureExit,
            5_000,
            "accepted background fixture did not terminate",
          )
        ).signal,
      ).toBe("SIGKILL");

      // When
      const input = new PassThrough();
      input.end();
      const resumed = createCliRuntime(["--resume", sessionId, "--no-skills"], {
        cwd: workspace,
        env: environment,
        input,
      });
      const exitCode = await withTimeout(
        runCliMain(resumed.runtime),
        5_000,
        "accepted background recovery process did not finish",
      );

      // Then
      expect(exitCode, resumed.stderr()).toBe(0);
      expect(resumed.stdout()).toContain(completed);
      expect(resumed.stderr()).not.toContain("recovery_blocked");
      expect(requestBodies).toHaveLength(1);
      const recoveredRequest = z
        .object({
          messages: z.array(
            z
              .object({
                role: z.string(),
                content: z.unknown(),
              })
              .passthrough(),
          ),
        })
        .passthrough()
        .parse(JSON.parse(requestBodies[0] ?? "{}"));
      const recoveredToolContent = z
        .string()
        .parse(
          recoveredRequest.messages.find((message) => message.role === "tool")
            ?.content,
        );
      expect(JSON.parse(recoveredToolContent)).toMatchObject({
        status: "interrupted_effect_unknown",
        reconciliation: {
          ownerKey: "agent_tree",
          effect: "applied",
          evidence: {
            kind: "agent_tree_delegate",
            status: "interrupted",
            result: {
              status: "interrupted",
              finalText: null,
              error:
                "Child was interrupted when its background session owner exited.",
            },
          },
        },
      });
      const ledger = await readFile(
        join(home, "sessions", sessionId, "ledger.jsonl"),
        "utf8",
      );
      expect(ledger.match(/"type":"effect_reconciled"/gu)).toHaveLength(1);
      expect(ledger).not.toContain('"type":"task_recovery_disposition"');
      expect(ledger).toContain('"outcome":"completed"');
      const agentEvents = await readFile(
        join(home, "sessions", sessionId, "agents", "events.jsonl"),
        "utf8",
      );
      expect(agentEvents.match(/"type":"agent_run_accepted"/gu)).toHaveLength(
        1,
      );
      expect(agentEvents.match(/"type":"agent_result"/gu)).toHaveLength(1);
      expect(
        agentEvents.match(/"type":"agent_result_delivery_pending"/gu),
      ).toHaveLength(1);
      expect(
        agentEvents.match(/"type":"agent_result_delivery_delivered"/gu),
      ).toHaveLength(1);
    } finally {
      fixture.kill("SIGKILL");
      await close(server);
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test.each(["foreground", "background"] as const)(
    `Given a named session is SIGKILLed after a %s read-only delegate intent but before child acceptance,
    When the user resumes without enabling delegation again,
    Then agent-tree absence continues the same Task without a duplicate child or recovery decision`,
    async (mode) => {
      // Given
      const workspace = await mkdtemp(
        join(tmpdir(), "keel-delegate-not-applied-"),
      );
      const home = await mkdtemp(
        join(tmpdir(), "keel-delegate-not-applied-home-"),
      );
      const sessionId = `${mode}-delegate-not-applied`;
      const completed = "Continued after proving the child was never accepted.";
      const requestBodies: string[] = [];
      const server = createServer((request, response) => {
        if (request.url !== "/chat/completions") {
          response.writeHead(404);
          response.end();
          return;
        }
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
        });
        request.on("end", () => {
          requestBodies.push(Buffer.concat(chunks).toString("utf8"));
          response.writeHead(200, { "Content-Type": "text/event-stream" });
          response.end(sseTextReplyWithUsage(completed));
        });
      });
      await listen(server);
      const fixture = spawn(
        process.execPath,
        [
          "--experimental-strip-types",
          join(
            process.cwd(),
            "tests/fixtures/session-task-recovery-pre-acceptance.ts",
          ),
          home,
          workspace,
          sessionId,
          mode,
        ],
        { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] },
      );
      if (fixture.stdout === null || fixture.stderr === null) {
        throw new Error("pre-acceptance fixture requires piped output");
      }
      let fixtureStdout = "";
      let fixtureStderr = "";
      fixture.stdout.setEncoding("utf8");
      fixture.stderr.setEncoding("utf8");
      const fixtureReady = Promise.withResolvers<void>();
      fixture.stdout.on("data", (chunk: string) => {
        fixtureStdout += chunk;
        if (fixtureStdout.includes("ready\n")) fixtureReady.resolve();
      });
      fixture.stderr.on("data", (chunk: string) => {
        fixtureStderr += chunk;
      });
      const fixtureExit = new Promise<{
        readonly code: number | null;
        readonly signal: NodeJS.Signals | null;
      }>((resolve, reject) => {
        fixture.once("error", reject);
        fixture.once("exit", (code, signal) => {
          resolve({ code, signal });
        });
      });
      const environment = {
        DEEPSEEK_API_KEY: "test-key",
        DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
        KEEL_FORCE_INTERACTIVE: "1",
        KEEL_HOME: home,
        KEEL_PROVIDER: "deepseek",
      };

      try {
        await withTimeout(
          fixtureReady.promise,
          5_000,
          `pre-acceptance fixture did not become ready: ${fixtureStderr}`,
        );
        fixture.kill("SIGKILL");
        expect(
          (
            await withTimeout(
              fixtureExit,
              5_000,
              "pre-acceptance fixture did not terminate",
            )
          ).signal,
        ).toBe("SIGKILL");

        // When
        const input = new PassThrough();
        input.end();
        const resumed = createCliRuntime(
          ["--resume", sessionId, "--no-skills"],
          {
            cwd: workspace,
            env: environment,
            input,
          },
        );
        const exitCode = await withTimeout(
          runCliMain(resumed.runtime),
          5_000,
          "pre-acceptance recovery process did not finish",
        );

        // Then
        expect(exitCode, resumed.stderr()).toBe(0);
        expect(resumed.stdout()).toContain(completed);
        expect(resumed.stderr()).not.toContain("recovery_blocked");
        expect(requestBodies).toHaveLength(1);
        expect(requestBodies[0]).toContain("interrupted_effect_unknown");
        expect(requestBodies[0]).toContain("agent_tree_delegate_not_accepted");
        const ledger = await readFile(
          join(home, "sessions", sessionId, "ledger.jsonl"),
          "utf8",
        );
        expect(ledger.match(/"type":"effect_reconciled"/gu)).toHaveLength(1);
        expect(ledger).toContain('"effect":"not_applied"');
        expect(ledger).toContain(`"mode":"${mode}"`);
        expect(ledger).not.toContain('"type":"task_recovery_disposition"');
        expect(ledger).toContain('"outcome":"completed"');
        const agentEvents = await readFile(
          join(home, "sessions", sessionId, "agents", "events.jsonl"),
          "utf8",
        );
        expect(agentEvents).not.toContain('"type":"agent_run_accepted"');
      } finally {
        fixture.kill("SIGKILL");
        await close(server);
        await rm(workspace, { recursive: true, force: true });
        await rm(home, { recursive: true, force: true });
      }
    },
  );

  test(`Given a named session accepts unknown effects before a bash effect is interrupted,
    When the host resumes the session after SIGKILL,
    Then Keel continues the same Task without replay or an end-user recovery decision`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-accept-unknown-recovery-"),
    );
    const home = await mkdtemp(
      join(tmpdir(), "keel-accept-unknown-recovery-home-"),
    );
    const markerPath = join(workspace, "effect-count.txt");
    const bashPidPath = join(workspace, "bash.pid");
    const reportPath = join(workspace, "recovery-report.json");
    const command =
      "printf %s $$ > bash.pid; printf x >> effect-count.txt; sleep 30";
    const completed = "Continued after the interrupted effect.";
    const requestBodies: string[] = [];
    const server = createServer((request, response) => {
      if (request.url !== "/chat/completions") {
        response.writeHead(404);
        response.end();
        return;
      }
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });
      request.on("end", () => {
        requestBodies.push(Buffer.concat(chunks).toString("utf8"));
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.end(
          requestBodies.length === 1
            ? `${sseToolCall("bash_accepted_unknown", "bash", {
                command,
              })}${sseToolFinish()}data: [DONE]\n\n`
            : sseTextReplyWithUsage(completed),
        );
      });
    });
    await listen(server);
    const environment = {
      DEEPSEEK_API_KEY: "test-key",
      DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
      KEEL_FORCE_INTERACTIVE: "1",
      KEEL_HOME: home,
      KEEL_PROVIDER: "deepseek",
    };
    const original = runCliProcess(
      [
        "--session",
        "accept-unknown-effect",
        "--bash-policy",
        "trusted",
        "--recovery-policy",
        "accept-unknown",
      ],
      {
        cwd: workspace,
        env: environment,
        stdin: "pipe",
      },
    );
    original.child.stdin?.on("error", () => {});

    try {
      original.child.stdin?.write(
        "perform the effect and recover automatically\n",
      );
      await withTimeout(
        (async () => {
          for (;;) {
            const marker = await readFile(markerPath, "utf8").catch(() => "");
            if (marker === "x") return;
            await new Promise<void>((resolve) => setTimeout(resolve, 10));
          }
        })(),
        5_000,
        "bash effect was not observed",
      );
      original.child.kill("SIGKILL");
      expect(
        (
          await withTimeout(
            original.result,
            5_000,
            "original accept-unknown process did not terminate",
          )
        ).signal,
      ).toBe("SIGKILL");

      // When
      const resumed = runCliProcess(
        [
          "--resume",
          "accept-unknown-effect",
          "--bash-policy",
          "trusted",
          "--report",
          reportPath,
        ],
        {
          cwd: workspace,
          env: environment,
          stdin: "pipe",
        },
      );
      resumed.child.stdin?.end();
      const resumedResult = await withTimeout(
        resumed.result,
        5_000,
        "accept-unknown recovery process did not finish",
      );

      // Then
      expect(resumedResult.exitCode, resumedResult.stderr).toBe(0);
      expect(resumedResult.stdout).toContain(completed);
      expect(resumedResult.stderr).toContain("completed_with_unknown_effects");
      expect(resumedResult.stderr).not.toContain("recovery_blocked");
      expect(requestBodies).toHaveLength(2);
      expect(requestBodies[1]).toContain("interrupted_effect_unknown");
      expect(await readFile(markerPath, "utf8")).toBe("x");
      const ledger = await readFile(
        join(home, "sessions", "accept-unknown-effect", "ledger.jsonl"),
        "utf8",
      );
      expect(ledger).toContain('"type":"task_recovery_disposition"');
      expect(ledger).toContain('"kind":"accept_unknown"');
      expect(ledger).toContain('"outcome":"completed_with_unknown_effects"');
      const report = z
        .object({
          tasks: z.array(
            z
              .object({
                outcome: z.string(),
              })
              .passthrough(),
          ),
        })
        .passthrough()
        .parse(JSON.parse(await readFile(reportPath, "utf8")));
      expect(report.tasks).toMatchObject([
        { outcome: "completed_with_unknown_effects" },
      ]);
      const shown = await withTimeout(
        runCliProcess(["sessions", "show", "accept-unknown-effect", "--all"], {
          cwd: workspace,
          env: environment,
        }).result,
        5_000,
        "accepted unknown outcome was not available from session detail",
      );
      expect(shown.exitCode, shown.stderr).toBe(0);
      expect(shown.stdout).toContain(
        "last task: completed_with_unknown_effects; unknown tool effects: 1",
      );
    } finally {
      original.child.kill("SIGKILL");
      const bashPid = Number.parseInt(
        await readFile(bashPidPath, "utf8").catch(() => ""),
        10,
      );
      if (process.platform !== "win32" && Number.isSafeInteger(bashPid)) {
        try {
          process.kill(-bashPid, "SIGKILL");
        } catch {
          // The bounded test command may already have exited.
        }
      }
      await close(server);
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given the original provider request and its one replacement are both SIGKILLed,
    When a third process resumes the named session,
    Then recovery blocks without a third request and preserves queued user input`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-task-recovery-"));
    const home = await mkdtemp(join(tmpdir(), "keel-task-recovery-home-"));
    const requestBodies: string[] = [];
    const requestObservers: Array<() => void> = [];
    const firstRequestObserved = new Promise<void>((resolve) => {
      requestObservers[0] = resolve;
    });
    const secondRequestObserved = new Promise<void>((resolve) => {
      requestObservers[1] = resolve;
    });
    const server = createServer((request, response) => {
      if (request.url !== "/chat/completions") {
        response.writeHead(404);
        response.end();
        return;
      }
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });
      request.on("end", () => {
        requestBodies.push(Buffer.concat(chunks).toString("utf8"));
        response.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        requestObservers[requestBodies.length - 1]?.();
      });
    });
    await listen(server);
    const environment = {
      DEEPSEEK_API_KEY: "test-key",
      DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
      KEEL_FORCE_INTERACTIVE: "1",
      KEEL_HOME: home,
      KEEL_PROVIDER: "deepseek",
    };
    const original = runCliProcess(["--session", "replacement-limit"], {
      cwd: workspace,
      env: environment,
      stdin: "pipe",
    });
    original.child.stdin?.on("error", () => {});
    let replacement: ReturnType<typeof runCliProcess> | undefined;

    try {
      original.child.stdin?.write("start bounded recovery\n");
      await withTimeout(
        firstRequestObserved,
        5_000,
        "original provider request was not observed",
      );
      original.child.kill("SIGKILL");
      expect(
        (
          await withTimeout(
            original.result,
            5_000,
            "original process did not terminate",
          )
        ).signal,
      ).toBe("SIGKILL");

      replacement = runCliProcess(["--resume", "replacement-limit"], {
        cwd: workspace,
        env: environment,
        stdin: "pipe",
      });
      replacement.child.stdin?.on("error", () => {});
      await withTimeout(
        secondRequestObserved,
        5_000,
        "replacement provider request was not observed",
      );
      replacement.child.stdin?.write("keep this queued input\n");
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      replacement.child.kill("SIGKILL");
      expect(
        (
          await withTimeout(
            replacement.result,
            5_000,
            "replacement process did not terminate",
          )
        ).signal,
      ).toBe("SIGKILL");

      const blocked = runCliProcess(["--resume", "replacement-limit"], {
        cwd: workspace,
        env: environment,
        stdin: "pipe",
      });
      blocked.child.stdin?.end("keep this second queued input\n");
      const blockedExit = await withTimeout(
        blocked.result,
        5_000,
        "blocked recovery process did not finish",
      );

      expect(blockedExit.exitCode, blockedExit.stderr).toBe(0);
      expect(blockedExit.stderr).toContain("provider_replacement_limit");
      expect(requestBodies).toHaveLength(2);
      const ledger = await readFile(
        join(home, "sessions", "replacement-limit", "ledger.jsonl"),
        "utf8",
      );
      expect(ledger).toContain('"line":"keep this queued input"');
      expect(ledger).toContain('"line":"keep this second queued input"');
      expect(ledger).not.toContain('"input_consumed"');
    } finally {
      original.child.kill("SIGKILL");
      replacement?.child.kill("SIGKILL");
      await close(server);
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a named session has either a settled text response or a known terminal provider failure,
    When a fresh process resumes it,
    Then Keel delivers or terminalizes the durable Task without another provider request`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-task-recovery-"));
    const home = await mkdtemp(join(tmpdir(), "keel-task-recovery-home-"));
    const provider = {
      providerId: "deepseek" as const,
      model: "deepseek-chat",
    };
    const usage = {
      inputTokens: 3,
      cachedInputTokens: 0,
      uncachedInputTokens: 3,
      outputTokens: 2,
    };
    const environment = {
      DEEPSEEK_API_KEY: "test-key",
      DEEPSEEK_BASE_URL: "http://127.0.0.1:1",
      KEEL_FORCE_INTERACTIVE: "1",
      KEEL_HOME: home,
      KEEL_PROVIDER: "deepseek",
    };

    try {
      for (const scenario of ["delivered", "terminal_error"] as const) {
        let messages: readonly SessionMessage[] = [];
        const session = createSessionStore({
          sessionId: `resume-${scenario}`,
          workspace,
          runtime: runtime(home),
        });
        const recovery = createSessionTaskRecovery({
          session: () => session,
          runtime: runtime(home, 1),
          currentMessages: () => messages,
          onMessagesPersisted: (persisted) => {
            messages = persisted;
          },
        });
        recovery.admit({
          userMessage: {
            role: "user",
            content: scenario,
            origin: { type: "user_prompt" },
          },
          provider,
          consumedInputIds: [],
        });
        const lifecycle = recovery.providerLifecycle(provider);
        if (scenario === "delivered") {
          lifecycle.providerRequestAttempts
            .begin()
            .finish({ outcome: "completed", usage });
          lifecycle.settled({
            assistantMessage: {
              role: "assistant",
              content: "durable response delivered after restart",
              toolCalls: [],
            },
            usage,
            stopReason: "stop",
          });
        } else {
          lifecycle.auxiliaryProviderRequestAttempts.begin().finish({
            outcome: "terminal_error",
            errorCode: "provider_http_error",
          });
        }

        const resumed = runCliProcess(["--resume", session.id], {
          cwd: workspace,
          env: environment,
          stdin: "pipe",
        });
        resumed.child.stdin?.end();
        const result = await withTimeout(
          resumed.result,
          5_000,
          `${scenario} recovery did not finish`,
        );

        expect(result.exitCode, result.stderr).toBe(0);
        if (scenario === "delivered") {
          expect(result.stdout).toContain(
            "durable response delivered after restart",
          );
        }
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a recovered Task cannot afford its replacement provider request,
    When the named session resumes with more input already waiting,
    Then Keel blocks the Task and exits before accepting that input or calling the provider`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-task-recovery-"));
    const home = await mkdtemp(join(tmpdir(), "keel-task-recovery-home-"));
    const provider = {
      providerId: "deepseek" as const,
      model: "deepseek-v4-flash",
    };
    let messages: readonly SessionMessage[] = [];
    let requestCount = 0;
    const server = createServer((_request, response) => {
      requestCount++;
      response.writeHead(500);
      response.end();
    });
    await listen(server);

    try {
      const stored = createSessionStore({
        sessionId: "recovery-cost-budget",
        workspace,
        runtime: runtime(home),
      });
      const recovery = createSessionTaskRecovery({
        session: () => stored,
        runtime: runtime(home, 1),
        currentMessages: () => messages,
        onMessagesPersisted: (persisted) => {
          messages = persisted;
        },
      });
      recovery.admit({
        userMessage: {
          role: "user",
          content: "resume only if the provider request is affordable",
          origin: { type: "user_prompt" },
        },
        provider,
        consumedInputIds: [],
      });
      recovery.providerLifecycle(provider).providerRequestAttempts.begin();

      const resumed = runCliProcess(
        ["--resume", stored.id, "--max-cost", "0.000000001"],
        {
          cwd: workspace,
          env: {
            DEEPSEEK_API_KEY: "test-key",
            DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
            KEEL_FORCE_INTERACTIVE: "1",
            KEEL_HOME: home,
            KEEL_PROVIDER: "deepseek",
          },
          stdin: "pipe",
        },
      );
      resumed.child.stdin?.end("do not accept this follow-up\n");
      const result = await withTimeout(
        resumed.result,
        5_000,
        "budget-blocked recovery did not finish",
      );

      expect(result.exitCode, result.stderr).toBe(0);
      expect(requestCount).toBe(0);
      expect(
        resumeSessionStore({
          sessionId: stored.id,
          workspace,
          runtime: runtime(home, 2),
        }).activeTask,
      ).toMatchObject({
        phase: "recovery_blocked",
        reason: "provider_budget",
        recovered: true,
      });
      expect(await readFile(stored.filePath, "utf8")).not.toContain(
        "do not accept this follow-up",
      );
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given steering arrives while the first provider request is still in flight,
    When the first response completes a tool round and Keel starts the second request,
    Then the steering input is durably consumed exactly once before that request`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-task-recovery-"));
    const home = await mkdtemp(join(tmpdir(), "keel-task-recovery-home-"));
    await writeFile(join(workspace, "note.txt"), "steering boundary\n", "utf8");
    const steering = "include this steering before the next request";
    const requestBodies: string[] = [];
    let observeFirstRequest: () => void = () => {};
    let observeSecondRequest: () => void = () => {};
    let releaseFirstResponse: () => void = () => {};
    const firstRequestObserved = new Promise<void>((resolve) => {
      observeFirstRequest = resolve;
    });
    const secondRequestObserved = new Promise<void>((resolve) => {
      observeSecondRequest = resolve;
    });
    const server = createServer((request, response) => {
      if (request.url !== "/chat/completions") {
        response.writeHead(404);
        response.end();
        return;
      }
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });
      request.on("end", () => {
        requestBodies.push(Buffer.concat(chunks).toString("utf8"));
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        if (requestBodies.length === 1) {
          releaseFirstResponse = () => {
            response.end(
              `${sseToolCall("read_after_steering", "read", {
                path: "note.txt",
              })}${sseToolFinish()}data: [DONE]\n\n`,
            );
          };
          observeFirstRequest();
          return;
        }
        response.end(
          sseTextReplyWithUsage("Steering was included before this request."),
        );
        observeSecondRequest();
      });
    });
    await listen(server);
    const run = runCliProcess(["--session", "steering-provider-boundary"], {
      cwd: workspace,
      env: {
        DEEPSEEK_API_KEY: "test-key",
        DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
        KEEL_FORCE_INTERACTIVE: "1",
        KEEL_HOME: home,
        KEEL_PROVIDER: "deepseek",
      },
      stdin: "pipe",
    });
    run.child.stdin?.on("error", () => {});

    try {
      run.child.stdin?.write("read the note, then answer\n");
      await withTimeout(
        firstRequestObserved,
        5_000,
        "first provider request was not observed",
      );
      run.child.stdin?.write(`${steering}\n`);
      const ledgerPath = join(
        home,
        "sessions",
        "steering-provider-boundary",
        "ledger.jsonl",
      );
      await withTimeout(
        (async () => {
          for (;;) {
            const ledger = await readFile(ledgerPath, "utf8");
            if (ledger.includes(steering)) return;
            await new Promise<void>((resolve) => setTimeout(resolve, 10));
          }
        })(),
        5_000,
        "steering input was not durably queued",
      );
      releaseFirstResponse();
      await withTimeout(
        secondRequestObserved,
        5_000,
        "second provider request was not observed",
      );
      run.child.stdin?.end();
      const result = await withTimeout(
        run.result,
        5_000,
        "steering boundary process did not finish",
      );

      expect(result.exitCode, result.stderr).toBe(0);
      expect(requestBodies).toHaveLength(2);
      expect(requestBodies[1]?.split(steering)).toHaveLength(2);
      const records = (await readFile(ledgerPath, "utf8"))
        .trimEnd()
        .split("\n")
        .map((line) =>
          z
            .object({
              type: z.string(),
              id: z.string().optional(),
              line: z.string().optional(),
              consumedInputIds: z.array(z.string()).optional(),
            })
            .passthrough()
            .parse(JSON.parse(line)),
        );
      const queued = records.find(
        (record) =>
          record.type === "input_admitted" && record.line === steering,
      );
      expect(queued?.id).toBeDefined();
      const inputId = queued?.id;
      if (inputId === undefined) throw new Error("missing steering input id");
      expect(
        records.filter((record) => record.consumedInputIds?.includes(inputId)),
      ).toHaveLength(1);
      expect(
        records.find((record) => record.type === "step_committed")
          ?.consumedInputIds,
      ).toContain(inputId);
    } finally {
      run.child.kill("SIGKILL");
      await close(server);
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a named-session provider repeats the same tool request until the stop policy fires,
    When Keel stops without executing the final tool plan,
    Then the durable Task commits the final non-tool response and exits cleanly`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-task-recovery-"));
    const home = await mkdtemp(join(tmpdir(), "keel-task-recovery-home-"));
    await writeFile(join(workspace, "note.txt"), "stable\n", "utf8");
    let requestCount = 0;
    const server = createServer((request, response) => {
      if (request.url !== "/chat/completions") {
        response.writeHead(404);
        response.end();
        return;
      }
      requestCount++;
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end(
        `${sseToolCall(`repeat_read_${requestCount}`, "read", {
          path: "note.txt",
        })}${sseToolFinish()}data: [DONE]\n\n`,
      );
    });
    await listen(server);

    try {
      const run = runCliProcess(["--session", "repeated-tool-stop"], {
        cwd: workspace,
        env: {
          DEEPSEEK_API_KEY: "test-key",
          DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
          KEEL_FORCE_INTERACTIVE: "1",
          KEEL_HOME: home,
          KEEL_PROVIDER: "deepseek",
        },
        stdin: "pipe",
      });
      run.child.stdin?.end("read the note repeatedly\n");
      const result = await withTimeout(
        run.result,
        5_000,
        "repeated-tool session did not finish",
      );

      expect(result.exitCode, result.stderr).toBe(0);
      expect(requestCount).toBe(3);
      const ledger = await readFile(
        join(home, "sessions", "repeated-tool-stop", "ledger.jsonl"),
        "utf8",
      );
      expect(ledger).toContain('"type":"task_terminal"');
      expect(ledger).not.toContain('"reason":"tool_plan"');
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });
});
