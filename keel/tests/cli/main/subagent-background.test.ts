import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, test } from "vitest";
import { runCliMain } from "../../../src/cli/index.ts";
import { requestWithMessagesSchema } from "../../../src/testing/cli-main-schemas.ts";
import { createRuntime } from "../../../src/testing/cli-runtime-fixtures.ts";
import {
  close,
  getPort,
  listen,
  sseTextReplyWithUsage,
  sseToolCall,
  sseToolFinish,
} from "../../../src/testing/provider-sse-fixtures.ts";

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

function requestText(request: unknown): string {
  return JSON.stringify(requestWithMessagesSchema.parse(request));
}

function delegatedAgentId(request: unknown): string | undefined {
  const receipt = requestWithMessagesSchema
    .parse(request)
    .messages?.find(
      (message) =>
        message.role === "tool" &&
        message.tool_call_id === "delegate_background",
    );
  return receipt?.content?.match(/"agentId":"(agent-[a-f0-9-]+)"/u)?.[1];
}

describe("CLI Main - Attached Background Subagents", () => {
  test(`Given a saved interactive session starts a read-only child in the background,
    When the user continues working, inspects it live, and waits while it is still running,
    Then main stays responsive and returns the durable result after the child settles without requiring another prompt`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-background-agent-"));
    const keelHome = join(workspace, ".keel-home");
    await writeFile(
      join(workspace, "module.ts"),
      "export const answer = 42;\n",
      "utf8",
    );
    const requests: unknown[] = [];
    const backgroundFinalResponse = Promise.withResolvers<ServerResponse>();
    const firstMainAnswer = Promise.withResolvers<void>();
    const followupAnswer = Promise.withResolvers<void>();
    const resultUsed = Promise.withResolvers<void>();
    const completionAcknowledged = Promise.withResolvers<void>();
    const runningList = Promise.withResolvers<void>();
    const completionNotification = Promise.withResolvers<void>();
    let releaseBackground: () => void = () => {
      throw new Error("background child final request did not start");
    };
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        const parsed: unknown = JSON.parse(body);
        requests.push(parsed);
        const text = requestText(parsed);
        response.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });

        if (text.includes("Delegation ID:")) {
          if (!text.includes("child_read_module")) {
            response.end(
              [
                sseToolCall("child_read_module", "read", {
                  path: "module.ts",
                }),
                sseToolFinish(),
                "data: [DONE]\n\n",
              ].join(""),
            );
            return;
          }
          backgroundFinalResponse.resolve(response);
          releaseBackground = () => {
            response.end(
              sseTextReplyWithUsage("module.ts:1 exports answer = 42."),
            );
          };
          return;
        }

        if (text.includes("Acknowledge the recorded completion.")) {
          response.end(sseTextReplyWithUsage("Completion acknowledged."));
          return;
        }
        if (text.includes("Use the running background result now.")) {
          if (text.includes("agent_wait_use_result")) {
            response.end(sseTextReplyWithUsage("Used the child result: 42."));
            return;
          }
          const agentId = delegatedAgentId(parsed);
          if (agentId === undefined) {
            response.writeHead(500);
            response.end("stable agent ID missing from parent context");
            return;
          }
          response.end(
            [
              sseToolCall("agent_wait_use_result", "agent_wait", { agentId }),
              sseToolFinish(),
              "data: [DONE]\n\n",
            ].join(""),
          );
          setTimeout(releaseBackground, 100);
          return;
        }
        if (text.includes("Continue with another task while it runs.")) {
          response.end(
            sseTextReplyWithUsage("Continued without waiting for the child."),
          );
          return;
        }
        if (text.includes("delegate_background")) {
          response.end(
            sseTextReplyWithUsage("The background child has started."),
          );
          return;
        }
        response.end(
          [
            sseToolCall("delegate_background", "delegate", {
              mode: "background",
              task: "Read module.ts and report its exported value.",
              focusPaths: ["module.ts"],
            }),
            sseToolFinish(),
            "data: [DONE]\n\n",
          ].join(""),
        );
      });
    });
    await listen(server);
    const input = new PassThrough();
    let stdout = "";
    let stderr = "";
    const fixture = createRuntime(
      [
        "--session",
        "background-agent",
        "--agent-policy",
        "explicit",
        "--max-cost",
        "1",
        "--no-skills",
      ],
      {
        cwd: workspace,
        input,
        env: {
          KEEL_HOME: keelHome,
          KEEL_FORCE_INTERACTIVE: "1",
          DEEPSEEK_API_KEY: "test-key",
          DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
        },
        onStdout: (text) => {
          stdout += text;
          if (stdout.includes("The background child has started.")) {
            firstMainAnswer.resolve();
          }
          if (stdout.includes("Continued without waiting for the child.")) {
            followupAnswer.resolve();
          }
          if (stdout.includes("Used the child result: 42.")) {
            resultUsed.resolve();
          }
          if (stdout.includes("Completion acknowledged.")) {
            completionAcknowledged.resolve();
          }
          if (/\[running\].*Read module\.ts/u.test(stdout)) {
            runningList.resolve();
          }
        },
        onStderr: (text) => {
          stderr += text;
          if (/Background subagent agent-[^ ]+ completed\./u.test(stderr)) {
            completionNotification.resolve();
          }
        },
      },
    );

    try {
      // When
      const run = runCliMain(fixture.runtime);
      input.write("Use a subagent in the background to inspect module.ts.\n");
      await withTimeout(
        backgroundFinalResponse.promise,
        5_000,
        "background child did not reach its final request",
      );
      await withTimeout(
        firstMainAnswer.promise,
        5_000,
        "main waited for the background child",
      );
      input.write("Continue with another task while it runs.\n");
      await withTimeout(
        followupAnswer.promise,
        5_000,
        "main did not accept a later task while the child was running",
      );
      input.write("/agents\n/agents show 1\n");
      await withTimeout(
        runningList.promise,
        5_000,
        "/agents did not show the live child",
      );
      input.write("Use the running background result now.\n");
      await withTimeout(
        completionNotification.promise,
        5_000,
        "background completion was not notified",
      );
      await withTimeout(
        resultUsed.promise,
        5_000,
        "main could not wait for and use the background result",
      );
      input.write("Acknowledge the recorded completion.\n");
      await withTimeout(
        completionAcknowledged.promise,
        5_000,
        "main did not accept the turn after background completion",
      );
      input.end("/agents wait 1\n");
      const exitCode = await run;

      // Then
      expect(exitCode, fixture.stderr()).toBe(0);
      expect(stdout).toContain("[running]");
      expect(stdout).toContain("result: pending");
      expect(stdout).toContain('"status":"completed"');
      expect(stdout).toContain(
        '"finalText":"module.ts:1 exports answer = 42."',
      );
      expect(
        stderr.match(/Background subagent agent-[^ ]+ completed\./gu),
      ).toHaveLength(1);
      expect(
        requests.filter((request) =>
          requestText(request).includes("Delegation ID:"),
        ),
      ).toHaveLength(2);
      expect(
        requests.some((request) => {
          const text = requestText(request);
          return (
            text.includes("agent_wait_use_result") &&
            text.includes("module.ts:1 exports answer = 42.")
          );
        }),
        requests
          .map((request) =>
            JSON.stringify(requestWithMessagesSchema.parse(request).messages),
          )
          .join("\n\n"),
      ).toBe(true);
      const parentLedger = await readFile(
        join(keelHome, "sessions", "background-agent", "ledger.jsonl"),
        "utf8",
      );
      expect(parentLedger.match(/Background subagent agent-/gu)).toHaveLength(
        1,
      );
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an attached background child is blocked in provider work,
    When the user cancels it by stable agent ID,
    Then the child settles as cancelled, notifies once, and the session exits without an orphan`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-background-cancel-"));
    const keelHome = join(workspace, ".keel-home");
    const childStarted = Promise.withResolvers<void>();
    const mainAnswered = Promise.withResolvers<void>();
    const heldChildResponses: ServerResponse[] = [];
    let childRequests = 0;
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        const text = requestText(JSON.parse(body));
        response.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        if (text.includes("Delegation ID:")) {
          childRequests++;
          heldChildResponses.push(response);
          response.write(": child is running\n\n");
          childStarted.resolve();
          return;
        }
        if (text.includes("delegate_cancel")) {
          response.end(sseTextReplyWithUsage("Main remains available."));
          return;
        }
        response.end(
          [
            sseToolCall("delegate_cancel", "delegate", {
              mode: "background",
              task: "Wait while inspecting the workspace.",
            }),
            sseToolFinish(),
            "data: [DONE]\n\n",
          ].join(""),
        );
      });
    });
    await listen(server);
    const input = new PassThrough();
    let stdout = "";
    let stderr = "";
    const fixture = createRuntime(
      [
        "--session",
        "background-cancel",
        "--agent-policy",
        "explicit",
        "--max-cost",
        "0.05",
        "--no-skills",
      ],
      {
        cwd: workspace,
        input,
        env: {
          KEEL_HOME: keelHome,
          KEEL_FORCE_INTERACTIVE: "1",
          DEEPSEEK_API_KEY: "test-key",
          DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
        },
        onStdout: (text) => {
          stdout += text;
          if (stdout.includes("Main remains available."))
            mainAnswered.resolve();
        },
        onStderr: (text) => {
          stderr += text;
        },
      },
    );

    try {
      const run = runCliMain(fixture.runtime);
      input.write("Start a background subagent and keep it running.\n");
      await withTimeout(
        childStarted.promise,
        5_000,
        "background child did not start",
      );
      await withTimeout(
        mainAnswered.promise,
        5_000,
        "main did not finish its turn",
      );
      input.end("/agents cancel 1\n");

      expect(await run, fixture.stderr()).toBe(0);
      expect(stdout).toContain('"status":"cancelled"');
      expect(stdout).not.toContain('"error"');
      expect(
        stderr.match(/Background subagent agent-[^ ]+ cancelled\./gu),
      ).toHaveLength(1);
      expect(childRequests).toBe(1);
    } finally {
      for (const response of heldChildResponses) response.end();
      await close(server);
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an attached background child reports spend beyond the saved-session limit,
    When its canonical result settles while Main remains active,
    Then the owner records the child spend and stops without admitting another provider request`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-background-budget-"));
    const keelHome = join(workspace, ".keel-home");
    const mainAnswered = Promise.withResolvers<void>();
    const childSettled = Promise.withResolvers<void>();
    const requests: unknown[] = [];
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        const parsed: unknown = JSON.parse(body);
        requests.push(parsed);
        const text = requestText(parsed);
        response.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        if (text.includes("Delegation ID:")) {
          response.end(
            sseTextReplyWithUsage("The expensive inspection completed.", {
              prompt_tokens: 100_000_000,
              completion_tokens: 1,
            }),
          );
          return;
        }
        if (text.includes("delegate_expensive_background")) {
          response.end(sseTextReplyWithUsage("Main accepted the child."));
          return;
        }
        response.end(
          [
            sseToolCall("delegate_expensive_background", "delegate", {
              mode: "background",
              task: "Inspect the workspace with a bounded child.",
            }),
            sseToolFinish(),
            "data: [DONE]\n\n",
          ].join(""),
        );
      });
    });
    await listen(server);
    const input = new PassThrough();
    let stderr = "";
    const fixture = createRuntime(
      [
        "--session",
        "background-budget",
        "--agent-policy",
        "explicit",
        "--max-cost",
        "0.05",
        "--no-skills",
      ],
      {
        cwd: workspace,
        input,
        env: {
          KEEL_HOME: keelHome,
          KEEL_FORCE_INTERACTIVE: "1",
          DEEPSEEK_API_KEY: "test-key",
          DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
        },
        onStdout: (text) => {
          if (text.includes("Main accepted the child.")) {
            mainAnswered.resolve();
          }
        },
        onStderr: (text) => {
          stderr += text;
          if (/Background subagent agent-[^ ]+ completed\./u.test(stderr)) {
            childSettled.resolve();
          }
        },
      },
    );

    try {
      const run = runCliMain(fixture.runtime);
      input.write("Start an expensive background subagent.\n");
      await withTimeout(
        Promise.all([mainAnswered.promise, childSettled.promise]),
        5_000,
        "background spend was not settled into the saved session",
      );
      input.end("Do not admit this follow-up after the budget is spent.\n");

      expect(await run, fixture.stderr()).toBe(0);
      expect(requests).toHaveLength(3);
      expect(
        requests.some((request) =>
          requestText(request).includes("Do not admit this follow-up"),
        ),
      ).toBe(false);
      expect(stderr).toContain("Background subagent");
      expect(stderr).toContain(
        "best-effort budget $0.0500 exceeded by $13.9500",
      );
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an attached background child is still running,
    When its saved-session owner exits normally and a new owner resumes,
    Then shutdown cancels and settles the child before release so resume sees terminal truth instead of an orphan`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-background-owner-"));
    const keelHome = join(workspace, ".keel-home");
    const sessionId = "background-owner-exit";
    const childStarted = Promise.withResolvers<void>();
    const mainAnswered = Promise.withResolvers<void>();
    const heldChildResponses: ServerResponse[] = [];
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        const text = requestText(JSON.parse(body));
        response.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        if (text.includes("Delegation ID:")) {
          heldChildResponses.push(response);
          response.write(": child is running\n\n");
          childStarted.resolve();
          return;
        }
        if (text.includes("delegate_owner_exit")) {
          response.end(
            sseTextReplyWithUsage("The background child is attached."),
          );
          return;
        }
        response.end(
          [
            sseToolCall("delegate_owner_exit", "delegate", {
              mode: "background",
              task: "Remain active until the saved-session owner exits.",
            }),
            sseToolFinish(),
            "data: [DONE]\n\n",
          ].join(""),
        );
      });
    });
    await listen(server);
    const input = new PassThrough();
    const first = createRuntime(
      [
        "--session",
        sessionId,
        "--agent-policy",
        "explicit",
        "--max-cost",
        "0.05",
        "--no-skills",
      ],
      {
        cwd: workspace,
        input,
        env: {
          KEEL_HOME: keelHome,
          KEEL_FORCE_INTERACTIVE: "1",
          DEEPSEEK_API_KEY: "test-key",
          DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
        },
        onStdout: (text) => {
          if (text.includes("The background child is attached.")) {
            mainAnswered.resolve();
          }
        },
      },
    );

    try {
      const firstRun = runCliMain(first.runtime);
      input.write("Start one attached background subagent.\n");
      await withTimeout(
        childStarted.promise,
        5_000,
        "background child did not start",
      );
      await withTimeout(
        mainAnswered.promise,
        5_000,
        "main did not finish its turn",
      );
      input.end();
      expect(await firstRun, first.stderr()).toBe(0);
      expect(
        first.stderr().match(/Background subagent agent-[^ ]+ cancelled\./gu),
      ).toHaveLength(1);

      const resumedInput = new PassThrough();
      resumedInput.end("/agents show 1\n");
      const resumed = createRuntime(
        ["--resume", sessionId, "--provider", "fake", "--no-skills"],
        {
          cwd: workspace,
          input: resumedInput,
          env: {
            KEEL_HOME: keelHome,
            KEEL_FORCE_INTERACTIVE: "1",
          },
        },
      );
      expect(await runCliMain(resumed.runtime), resumed.stderr()).toBe(0);
      expect(resumed.stdout()).toContain("status: cancelled");
      expect(resumed.stdout()).not.toContain("status: interrupted");

      const events = await readFile(
        join(keelHome, "sessions", sessionId, "agents", "events.jsonl"),
        "utf8",
      );
      expect(events.match(/"type":"agent_result"/gu)).toHaveLength(1);
      expect(events.match(/"type":"agent_run_terminal"/gu)).toHaveLength(1);
    } finally {
      for (const response of heldChildResponses) response.end();
      await close(server);
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
