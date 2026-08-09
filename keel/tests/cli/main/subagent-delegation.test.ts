import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { z } from "zod";
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

const requestSchema = requestWithMessagesSchema.and(requestWithToolsSchema);
const artifactRefSchema = z
  .string()
  .regex(/^tool-output:[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/u);

function toolNames(request: unknown): readonly string[] {
  return (
    requestSchema
      .parse(request)
      .tools?.flatMap((tool) =>
        tool.function?.name === undefined ? [] : [tool.function.name],
      ) ?? []
  );
}

function requestText(request: unknown): string {
  return JSON.stringify(requestSchema.parse(request));
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

describe("CLI Main - Subagent Delegation", () => {
  test(`Given experimental agents are enabled with a minimal provider configuration,
    When main answers without delegating or writing a report,
    Then optional child metadata remains absent without changing one-shot behavior`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-subagent-minimal-"));
    const keelHome = await mkdtemp(join(tmpdir(), "keel-subagent-home-"));
    const fixture = createRuntime(
      ["--experimental-agents", "--max-cost", "1", "Say hello."],
      {
        cwd: workspace,
        env: { KEEL_PROVIDER: "fake", KEEL_HOME: keelHome },
      },
    );

    try {
      expect(await runCliMain(fixture.runtime)).toBe(0);
      expect(fixture.stdout()).toBe("Hello from fake provider.\n");
      expect(fixture.stderr()).toBe("Cost: $0.000000 (budget $1.0000)\n");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(keelHome, { recursive: true, force: true });
    }
  });

  test(`Given experimental agents are disabled,
    When the provider fabricates a delegate tool call,
    Then delegate is absent from the schema and dispatch fails closed without a child run`, async () => {
    // Given
    const requests: unknown[] = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        requests.push(JSON.parse(body));
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        if (requests.length === 1) {
          res.end(
            [
              sseToolCall("forged_delegate", "delegate", {
                task: "Inspect the workspace.",
              }),
              sseToolFinish(),
              "data: [DONE]\n\n",
            ].join(""),
          );
          return;
        }
        res.end(sseTextReplyWithUsage("Recovered without delegation."));
      });
    });
    await listen(server);
    const fixture = createRuntime(["Inspect the workspace."], {
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
      expect(toolNames(requests[0])).not.toContain("delegate");
      expect(requestText(requests[0])).not.toContain("subagent");
      expect(
        requests,
        JSON.stringify({ stdout: fixture.stdout(), stderr: fixture.stderr() }),
      ).toHaveLength(2);
      expect(fixture.stdout()).toBe("Recovered without delegation.\n");
      expect(fixture.stderr()).toContain("Tool failed: delegate");
    } finally {
      await close(server);
    }
  });

  test(`Given experimental agents are enabled and the model first supplies an overlong delegation task,
    When main retries with valid arguments and the child finishes normally,
    Then the invalid call is recoverable, consumes no child slot, and delegation remains one-shot`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-subagent-retry-"));
    const reportPath = join(workspace, "report.json");
    const requests: unknown[] = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        requests.push(JSON.parse(body));
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        switch (requests.length) {
          case 1:
            res.end(
              [
                sseToolCall("delegate_too_long", "delegate", {
                  task: "x".repeat(4_001),
                }),
                sseToolFinish(),
                "data: [DONE]\n\n",
              ].join(""),
            );
            return;
          case 2:
            res.end(
              [
                sseToolCall("delegate_retry", "delegate", {
                  task: "Inspect the workspace and return a concise evidence summary.",
                }),
                sseToolFinish(),
                "data: [DONE]\n\n",
              ].join(""),
            );
            return;
          case 3:
            res.end(
              sseTextReplyWithUsage(
                "The delegated read-only investigation completed with no findings.",
              ),
            );
            return;
          case 4:
            res.end(
              sseTextReplyWithUsage(
                "Completed after one recovered delegation attempt.",
              ),
            );
            return;
          default:
            res.writeHead(500);
            res.end("unexpected request");
        }
      });
    });
    await listen(server);
    const fixture = createRuntime(
      [
        "--experimental-agents",
        "--no-skills",
        "--max-cost",
        "0.05",
        "--report",
        reportPath,
        "Use a subagent to inspect this workspace.",
      ],
      {
        cwd: workspace,
        env: {
          KEEL_HOME: join(workspace, ".keel-home"),
          DEEPSEEK_API_KEY: "test-key",
          DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
        },
      },
    );

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(0);
      expect(requests).toHaveLength(4);
      expect(toolNames(requests[0])).toContain("delegate");
      expect(toolNames(requests[1])).toContain("delegate");
      expect(toolNames(requests[2])).not.toContain("delegate");
      expect(toolNames(requests[3])).not.toContain("delegate");
      expect(requestText(requests[1])).toContain(
        "delegate failed: invalid arguments",
      );
      expect(requestText(requests[1])).toContain(
        "no longer than 4,000 characters",
      );
      expect(requestText(requests[3])).toContain(
        "The delegated read-only investigation completed with no findings.",
      );
      expect(fixture.stdout()).toBe(
        "Completed after one recovered delegation attempt.\n",
      );
      expect(fixture.stderr()).toContain("Tool failed: delegate");

      const report = z
        .object({
          modelOperations: z.array(
            z.object({ purpose: z.string() }).passthrough(),
          ),
        })
        .passthrough()
        .parse(JSON.parse(await readFile(reportPath, "utf8")));
      expect(
        report.modelOperations.filter(
          (operation) => operation.purpose === "subagent_turn",
        ),
      ).toHaveLength(1);
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the user explicitly requests a subagent and a root cost budget is enabled,
    When one read-only child finishes with a normal evidence-based answer,
    Then host hands its bounded final to main without tool-specific evidence, removes delegate, and main writes the result`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-subagent-"));
    const keelHome = join(workspace, ".keel-home");
    const reportPath = join(workspace, "report.json");
    await writeFile(
      join(workspace, "module.ts"),
      "export const answer = 42;\n",
      "utf8",
    );
    await writeFile(
      join(workspace, "AGENTS.md"),
      "DELEGATED_FIXTURE_RULE: report exact workspace evidence.\n",
      "utf8",
    );
    const requests: unknown[] = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        requests.push(JSON.parse(body));
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        switch (requests.length) {
          case 1:
            res.end(
              [
                sseToolCall("delegate_once", "delegate", {
                  task: "Inspect module.ts and report the exported value with exact file evidence.",
                  focusPaths: ["module.ts"],
                }),
                sseToolFinish(),
                "data: [DONE]\n\n",
              ].join(""),
            );
            return;
          case 2:
            res.end(
              [
                sseToolCall("child_read", "read", { path: "module.ts" }),
                sseToolFinish(),
                "data: [DONE]\n\n",
              ].join(""),
            );
            return;
          case 3:
            res.end(
              sseTextReplyWithUsage(
                "module.ts:1 exports answer with value 42. I observed it with the read tool.",
              ),
            );
            return;
          case 4:
            res.end(
              [
                sseToolCall("main_write", "write", {
                  path: "delegated-result.md",
                  content: "module.ts:1 exports answer = 42.\n",
                }),
                sseToolFinish(),
                "data: [DONE]\n\n",
              ].join(""),
            );
            return;
          case 5:
            res.end(
              sseTextReplyWithUsage(
                "Wrote delegated-result.md from the child handoff.",
              ),
            );
            return;
          default:
            res.writeHead(500);
            res.end("unexpected request");
        }
      });
    });
    await listen(server);
    const fixture = createRuntime(
      [
        "--experimental-agents",
        "--no-skills",
        "--max-cost",
        "0.05",
        "--report",
        reportPath,
        "使用 subagent 调研这个任务。\n\nPRIVATE PARENT CONTEXT: do not copy this. Analyze module.ts.",
      ],
      {
        cwd: workspace,
        env: {
          KEEL_HOME: keelHome,
          DEEPSEEK_API_KEY: "test-key",
          DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
        },
      },
    );

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(0);
      expect(
        requests,
        JSON.stringify({
          stdout: fixture.stdout(),
          stderr: fixture.stderr(),
          tools: requests.map(toolNames),
        }),
      ).toHaveLength(5);
      expect(toolNames(requests[0])).toContain("delegate");

      const childInitial = requestText(requests[1]);
      expect(childInitial).toContain(
        "Inspect module.ts and report the exported value with exact file evidence.",
      );
      expect(childInitial).toMatch(/Delegation ID: main-[^:]+:delegate_once/u);
      expect(childInitial).toContain("DELEGATED_FIXTURE_RULE");
      expect(childInitial).not.toContain("PRIVATE PARENT CONTEXT");
      expect(toolNames(requests[1]).toSorted()).toEqual(
        ["git_diff", "git_status", "glob", "grep", "ls", "read"].toSorted(),
      );
      expect(toolNames(requests[1])).not.toContain("write");
      expect(toolNames(requests[1])).not.toContain("edit");
      expect(toolNames(requests[1])).not.toContain("apply_patch");
      expect(toolNames(requests[1])).not.toContain("bash");
      expect(toolNames(requests[1])).not.toContain("delegate");

      const resumedMainRequest = requestSchema.parse(requests[3]);
      expect(toolNames(requests[3])).not.toContain("delegate");
      const delegatedToolResult = resumedMainRequest.messages?.find(
        (message) => message.tool_call_id === "delegate_once",
      )?.content;
      expect(delegatedToolResult).toContain(
        "module.ts:1 exports answer with value 42.",
      );
      expect(delegatedToolResult).not.toContain("observedResources");
      expect(delegatedToolResult).toContain('"childLimitReached":true');
      const artifactRef = artifactRefSchema.parse(
        delegatedToolResult?.match(
          /tool-output:[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+/u,
        )?.[0],
      );
      expect(fixture.stdout()).toBe(
        "Wrote delegated-result.md from the child handoff.\n",
      );
      expect(
        await readFile(join(workspace, "delegated-result.md"), "utf8"),
      ).toBe("module.ts:1 exports answer = 42.\n");
      expect(fixture.stderr()).toMatch(/Subagent .*: queued .*deadline/u);
      expect(fixture.stderr()).toMatch(/Subagent .*: running/u);
      expect(fixture.stderr()).toMatch(/Subagent .*: turn 1 .*deadline/u);
      expect(fixture.stderr()).toMatch(/Subagent .*: tool read .*elapsed/u);
      expect(fixture.stderr()).toMatch(/Subagent .*: turn 2 .*deadline/u);
      expect(fixture.stderr()).not.toContain("submit_agent_result");
      expect(fixture.stderr()).toMatch(/Subagent .*: completed .*elapsed/u);

      const report = z
        .object({
          modelOperationCount: z.number(),
          providerRequestAttemptCount: z.number(),
          usage: z.object({
            inputTokens: z.number(),
            outputTokens: z.number(),
          }),
          costUsd: z.number(),
          modelOperations: z.array(
            z
              .object({
                purpose: z.string(),
                attribution: z
                  .object({
                    type: z.literal("subagent"),
                    delegationId: z.string(),
                    childRunId: z.string(),
                  })
                  .optional(),
              })
              .passthrough(),
          ),
        })
        .passthrough()
        .parse(JSON.parse(await readFile(reportPath, "utf8")));
      expect(report.modelOperationCount).toBe(5);
      expect(report.providerRequestAttemptCount).toBe(5);
      expect(report.usage.inputTokens).toBe(50);
      expect(report.usage.outputTokens).toBe(15);
      expect(report.costUsd).toBeGreaterThan(0);
      const childOperations = report.modelOperations.filter(
        (operation) => operation.purpose === "subagent_turn",
      );
      expect(childOperations).toHaveLength(2);
      expect(childOperations.map((operation) => operation.attribution)).toEqual(
        [
          {
            type: "subagent",
            delegationId: expect.stringMatching(/^main-[^:]+:delegate_once$/u),
            childRunId: expect.stringMatching(/^subagent-/u),
          },
          {
            type: "subagent",
            delegationId: expect.stringMatching(/^main-[^:]+:delegate_once$/u),
            childRunId: expect.stringMatching(/^subagent-/u),
          },
        ],
      );
      expect(
        new Set(
          childOperations.map((operation) => operation.attribution?.childRunId),
        ).size,
      ).toBe(1);

      const inspectFixture = createRuntime(["artifacts", "show", artifactRef], {
        cwd: workspace,
        env: { KEEL_HOME: keelHome },
      });
      expect(await runCliMain(inspectFixture.runtime)).toBe(0);
      expect(inspectFixture.stdout()).toContain('"type":"transcript"');
      expect(inspectFixture.stdout()).toContain(
        '"origin":"runtime_subagent_delegation"',
      );
      expect(inspectFixture.stdout()).toContain(
        "module.ts:1 exports answer with value 42.",
      );
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a foreground child provider request is running,
    When the user sends Ctrl-C to the real CLI process,
    Then the child request closes and Keel exits 130 without an orphan`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-subagent-abort-"));
    let requestCount = 0;
    let markChildStarted: () => void = () => {};
    let markChildClosed: () => void = () => {};
    const childStarted = new Promise<void>((resolve) => {
      markChildStarted = resolve;
    });
    const childClosed = new Promise<void>((resolve) => {
      markChildClosed = resolve;
    });
    const server = createServer((req, res) => {
      requestCount++;
      req.resume();
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      if (requestCount === 1) {
        res.end(
          [
            sseToolCall("delegate_abort", "delegate", {
              task: "Inspect the workspace until cancelled.",
            }),
            sseToolFinish(),
            "data: [DONE]\n\n",
          ].join(""),
        );
        return;
      }
      markChildStarted();
      res.on("close", markChildClosed);
      res.write(
        `data: ${JSON.stringify({
          choices: [{ delta: { content: "still investigating" } }],
        })}\n\n`,
      );
    });
    await listen(server);
    const { child, result } = runCliProcess(
      [
        "--experimental-agents",
        "--max-cost",
        "0.05",
        "Delegate a read-only investigation.",
      ],
      {
        cwd: workspace,
        env: {
          KEEL_HOME: join(workspace, ".keel-home"),
          DEEPSEEK_API_KEY: "test-key",
          DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
        },
      },
    );

    try {
      // When
      await withTimeout(childStarted, 5_000, "child request did not start");
      child.kill("SIGINT");

      // Then
      await withTimeout(childClosed, 5_000, "child request remained live");
      const exit = await withTimeout(result, 5_000, "CLI did not exit");
      expect(exit.exitCode).toBe(130);
      expect(exit.signal).toBeNull();
      expect(exit.stderr).toContain(": cancelled —");
      expect(exit.stderr).not.toMatch(/AbortError|DOMException/u);
    } finally {
      child.kill("SIGKILL");
      await close(server);
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
