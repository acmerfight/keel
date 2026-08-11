import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, test } from "vitest";
import { runCliMain } from "../../../src/cli/index.ts";
import { runCliProcess } from "../../../src/testing/cli-harness.ts";
import {
  requestWithMessagesSchema,
  requestWithToolsSchema,
} from "../../../src/testing/cli-main-schemas.ts";
import { createRuntime } from "../../../src/testing/cli-runtime-fixtures.ts";
import {
  close,
  getPort,
  listen,
  sseTextReplyWithUsage,
  sseToolCall,
  sseToolFinish,
} from "../../../src/testing/provider-sse-fixtures.ts";

const SESSION_ID = "agent-history";
const requestSchema = requestWithMessagesSchema.and(requestWithToolsSchema);

function toolNames(request: unknown): readonly string[] {
  return (
    requestSchema
      .parse(request)
      .tools?.flatMap((tool) =>
        tool.function?.name === undefined ? [] : [tool.function.name],
      ) ?? []
  );
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (result) => {
        clearTimeout(timeout);
        resolve(result);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

describe("CLI Main - Durable Subagent History", () => {
  test(`Given a saved session asks for a reviewer subagent,
    When main delegates the review and the user later inspects that agent,
    Then the child has reviewer-only tools and /agents shows its durable capability snapshot`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-agent-profile-"));
    const keelHome = join(workspace, ".keel-home");
    const sessionId = "reviewer-agent-profile";
    await writeFile(
      join(workspace, "module.ts"),
      "export const answer = 42;\n",
      "utf8",
    );
    const requests: unknown[] = [];
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        requests.push(JSON.parse(body));
        response.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        switch (requests.length) {
          case 1:
            response.end(
              [
                sseToolCall("delegate_review", "delegate", {
                  profile: "reviewer",
                  task: "Review module.ts and report one evidence-based finding.",
                  focusPaths: ["module.ts"],
                }),
                sseToolFinish(),
                "data: [DONE]\n\n",
              ].join(""),
            );
            return;
          case 2:
            response.end(
              [
                sseToolCall("reviewer_read", "read", {
                  path: "module.ts",
                }),
                sseToolFinish(),
                "data: [DONE]\n\n",
              ].join(""),
            );
            return;
          case 3:
            response.end(
              sseTextReplyWithUsage(
                "module.ts:1 exports a constant without tests.",
              ),
            );
            return;
          case 4:
            response.end(
              sseTextReplyWithUsage("The reviewer found missing coverage."),
            );
            return;
          default:
            response.writeHead(500);
            response.end("unexpected request");
        }
      });
    });
    await listen(server);
    const input = new PassThrough();
    input.end("Use a reviewer subagent to review module.ts.\n");
    const run = createRuntime(
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
      },
    );

    try {
      // When
      expect(await runCliMain(run.runtime), run.stderr()).toBe(0);
      const inspectInput = new PassThrough();
      inspectInput.end("/agents show 1\n");
      const inspect = createRuntime(
        [
          "--resume",
          sessionId,
          "--provider",
          "fake",
          "--agent-policy",
          "explicit",
          "--max-cost",
          "0.05",
          "--no-skills",
        ],
        {
          cwd: workspace,
          input: inspectInput,
          env: {
            KEEL_HOME: keelHome,
            KEEL_FORCE_INTERACTIVE: "1",
          },
        },
      );
      const exitCode = await runCliMain(inspect.runtime);

      // Then
      expect(exitCode, inspect.stderr()).toBe(0);
      expect(requests).toHaveLength(4);
      expect(toolNames(requests[1]).toSorted()).toEqual(
        ["read", "ls", "glob", "grep", "git_status", "git_diff"].toSorted(),
      );
      expect(inspect.stdout()).toContain("profile: reviewer");
      expect(inspect.stdout()).toContain(
        "capability snapshot: builtin-reviewer-v1",
      );
      expect(inspect.stdout()).toContain("status: completed");
      expect(inspect.stdout()).toContain(
        "result: module.ts:1 exports a constant without tests.",
      );
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a saved-session delegation has an invalid focus path,
    When admission rejects it before creating a child run,
    Then only the durable rejection receipt remains and main can continue`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-agent-rejection-"));
    const keelHome = join(workspace, ".keel-home");
    const sessionId = "rejected-agent-history";
    const requests: unknown[] = [];
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        requests.push(JSON.parse(body));
        response.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        if (requests.length === 1) {
          response.end(
            [
              sseToolCall("delegate_outside", "delegate", {
                task: "Inspect a path outside the workspace.",
                focusPaths: ["../outside"],
              }),
              sseToolFinish(),
              "data: [DONE]\n\n",
            ].join(""),
          );
          return;
        }
        response.end(
          sseTextReplyWithUsage("The unsafe delegation was rejected."),
        );
      });
    });
    await listen(server);
    const input = new PassThrough();
    input.end("Use a subagent to inspect an unsafe path.\n");
    const fixture = createRuntime(
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
      },
    );

    try {
      expect(await runCliMain(fixture.runtime), fixture.stderr()).toBe(0);
      expect(requests).toHaveLength(2);
      const recoveryRequest = requestWithMessagesSchema.parse(requests[1]);
      expect(recoveryRequest.messages).toContainEqual(
        expect.objectContaining({
          role: "tool",
          content: expect.stringMatching(
            /Tool failed:.*invalid focus path[\s\S]*Recovery:.*Correct or omit/u,
          ),
        }),
      );
      expect(fixture.stdout()).toContain("The unsafe delegation was rejected.");
      const agentsDirectory = join(keelHome, "sessions", sessionId, "agents");
      const events = await readFile(
        join(agentsDirectory, "events.jsonl"),
        "utf8",
      );
      expect(events).toContain('"type":"delegation_rejected"');
      expect(events).not.toContain('"type":"agent_run_accepted"');
      expect(events).not.toContain('"type":"agent_result"');
      await expect(
        readdir(join(agentsDirectory, "transcripts")),
      ).resolves.toEqual([]);
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a saved interactive session completed a foreground child,
    When the user restarts Keel, inspects its agents, and forks the parent session,
    Then terminal facts survive restart while the parent ledger and fork stay free of copied child history`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-agent-history-"));
    const keelHome = join(workspace, ".keel-home");
    await writeFile(
      join(workspace, "module.ts"),
      "export const answer = 42;\n",
      "utf8",
    );
    const requests: unknown[] = [];
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        requests.push(JSON.parse(body));
        response.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        switch (requests.length) {
          case 1:
            response.end(
              [
                sseToolCall("delegate_module", "delegate", {
                  task: "Read module.ts and report its exported value.",
                  focusPaths: ["module.ts"],
                }),
                sseToolFinish(),
                "data: [DONE]\n\n",
              ].join(""),
            );
            return;
          case 2:
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
          case 3:
            response.end(
              sseTextReplyWithUsage("module.ts:1 exports answer = 42."),
            );
            return;
          case 4:
            response.end(
              sseTextReplyWithUsage(
                "The child confirmed that module.ts exports answer = 42.",
              ),
            );
            return;
          default:
            response.writeHead(500);
            response.end("unexpected request");
        }
      });
    });
    await listen(server);
    const firstInput = new PassThrough();
    firstInput.end("Use a subagent to investigate module.ts.\n");
    const first = createRuntime(
      [
        "--session",
        SESSION_ID,
        "--agent-policy",
        "explicit",
        "--max-cost",
        "0.05",
        "--no-skills",
      ],
      {
        cwd: workspace,
        input: firstInput,
        env: {
          KEEL_HOME: keelHome,
          KEEL_FORCE_INTERACTIVE: "1",
          DEEPSEEK_API_KEY: "test-key",
          DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
        },
      },
    );

    try {
      expect(await runCliMain(first.runtime)).toBe(0);
      expect(requests).toHaveLength(4);
      expect(first.stdout()).toContain(
        "The child confirmed that module.ts exports answer = 42.",
      );

      // When
      const resumedInput = new PassThrough();
      resumedInput.end(
        ["/agents", "/agents show 1", "/agents transcript 1", ""].join("\n"),
      );
      const resumed = createRuntime(
        [
          "--resume",
          SESSION_ID,
          "--provider",
          "fake",
          "--agent-policy",
          "explicit",
          "--max-cost",
          "0.05",
          "--no-skills",
        ],
        {
          cwd: workspace,
          input: resumedInput,
          env: {
            KEEL_HOME: keelHome,
            KEEL_FORCE_INTERACTIVE: "1",
          },
        },
      );
      const exitCode = await runCliMain(resumed.runtime);

      // Then
      expect(exitCode, resumed.stderr()).toBe(0);
      expect(requests).toHaveLength(4);
      expect(resumed.stdout()).toContain(`Agents for session: ${SESSION_ID}`);
      expect(resumed.stdout()).toContain("status: completed");
      expect(resumed.stdout()).toContain(
        "task: Read module.ts and report its exported value.",
      );
      expect(resumed.stdout()).toContain("turns: 2");
      expect(resumed.stdout()).toContain("cost: $");
      expect(resumed.stdout()).toContain(
        "result: module.ts:1 exports answer = 42.",
      );
      expect(resumed.stdout()).toContain("Child transcript");
      expect(resumed.stdout()).toContain('"type":"transcript"');
      expect(resumed.stdout()).toContain("child_read_module");

      const parentLedger = await readFile(
        join(keelHome, "sessions", SESSION_ID, "ledger.jsonl"),
        "utf8",
      );
      expect(parentLedger).not.toContain("child_read_module");
      expect(
        requestWithMessagesSchema.parse(requests.at(-1)).messages,
      ).toBeDefined();

      const forkSessionId = "agent-history-fork";
      const forked = createRuntime(
        ["sessions", "fork", SESSION_ID, forkSessionId],
        {
          cwd: workspace,
          env: { KEEL_HOME: keelHome },
        },
      );
      expect(await runCliMain(forked.runtime), forked.stderr()).toBe(0);

      const forkInput = new PassThrough();
      forkInput.end("/agents\n");
      const inspectFork = createRuntime(
        ["--resume", forkSessionId, "--provider", "fake", "--no-skills"],
        {
          cwd: workspace,
          input: forkInput,
          env: {
            KEEL_HOME: keelHome,
            KEEL_FORCE_INTERACTIVE: "1",
          },
        },
      );
      expect(await runCliMain(inspectFork.runtime), inspectFork.stderr()).toBe(
        0,
      );
      expect(inspectFork.stdout()).toContain("No subagents recorded.");
      const forkEvents = await readFile(
        join(keelHome, "sessions", forkSessionId, "agents", "events.jsonl"),
        "utf8",
      );
      expect(forkEvents).toContain('"type":"agent_tree"');
      expect(forkEvents).not.toContain('"type":"agent_run_accepted"');
      expect(requests).toHaveLength(4);
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a foreground child is running when the real saved-session process dies,
    When another exclusive owner resumes the session and inspects its agents,
    Then the abandoned run becomes one interrupted terminal with an incomplete transcript`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-agent-crash-"));
    const keelHome = join(workspace, ".keel-home");
    const sessionId = "interrupted-agent-history";
    let requestCount = 0;
    const childStarted = Promise.withResolvers<string>();
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        requestCount++;
        response.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        if (requestCount === 1) {
          response.end(
            [
              sseToolCall("delegate_crash", "delegate", {
                task: "Inspect the workspace until the owner exits.",
              }),
              sseToolFinish(),
              "data: [DONE]\n\n",
            ].join(""),
          );
          return;
        }
        childStarted.resolve(body);
        response.write(
          `data: ${JSON.stringify({
            choices: [{ delta: { content: "partial child work" } }],
          })}\n\n`,
        );
      });
    });
    await listen(server);
    const { child, result } = runCliProcess(
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
        stdin: "pipe",
        env: {
          KEEL_HOME: keelHome,
          KEEL_FORCE_INTERACTIVE: "1",
          DEEPSEEK_API_KEY: "test-key",
          DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
        },
      },
    );

    try {
      child.stdin?.end("Use a subagent to investigate this workspace.\n");
      const childRequest = await withTimeout(
        childStarted.promise,
        5_000,
        "child did not start",
      );
      expect(childRequest).toContain("Delegation ID:");

      // When
      child.kill("SIGKILL");
      const killed = await withTimeout(result, 5_000, "CLI did not exit");
      expect(killed.signal).toBe("SIGKILL");
      const resumedInput = new PassThrough();
      resumedInput.end("/agents show 1\n/agents transcript 1\n");
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
      const exitCode = await runCliMain(resumed.runtime);

      // Then
      expect(
        exitCode,
        [killed.stdout, killed.stderr, resumed.stderr()].join("\n"),
      ).toBe(0);
      expect(resumed.stdout()).toContain("status: interrupted");
      expect(resumed.stdout()).toContain(
        "error: Child was interrupted when its foreground session owner exited.",
      );
      expect(resumed.stdout()).toContain(
        '"type":"transcript_terminal","status":"interrupted","pendingInputCount":0,"complete":false',
      );
      const events = await readFile(
        join(keelHome, "sessions", sessionId, "agents", "events.jsonl"),
        "utf8",
      );
      expect(events.match(/"type":"agent_result"/gu)).toHaveLength(1);
      expect(events.match(/"type":"agent_run_terminal"/gu)).toHaveLength(1);
      expect(requestCount).toBe(2);
    } finally {
      child.kill("SIGKILL");
      await close(server);
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
