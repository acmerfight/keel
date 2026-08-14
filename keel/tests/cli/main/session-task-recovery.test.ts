import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
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
      blocked.child.stdin?.end();
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
      expect(ledger).not.toContain('"input_consumed"');
    } finally {
      original.child.kill("SIGKILL");
      replacement?.child.kill("SIGKILL");
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
