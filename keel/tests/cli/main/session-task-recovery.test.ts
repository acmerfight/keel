import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import type { SessionMessage } from "../../../src/agent/session-message.ts";
import { createSessionTaskRecovery } from "../../../src/cli/interactive-session/task-recovery.ts";
import { createSessionStore } from "../../../src/cli/session-store.ts";
import { runCliProcess } from "../../../src/testing/cli-harness.ts";
import { withTimeout } from "../../../src/testing/cli-runtime-fixtures.ts";
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
