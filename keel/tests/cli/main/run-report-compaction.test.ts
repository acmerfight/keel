import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, test } from "vitest";
import { z } from "zod";
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

function largeReadFixture(label: string): string {
  return [
    `${label}_START`,
    ...Array.from(
      { length: 3_200 },
      (_, index) => `${label.toLowerCase()} output line ${index}`,
    ),
    `${label}_END`,
  ].join("\n");
}

function retainedStaleReadFixture(label: string): string {
  return [
    `${label}_START`,
    `${label.toLowerCase()} retained evidence `.repeat(1_800),
    `${label}_END`,
  ].join("\n");
}

function barelyOversizedStaleReadFixture(label: string): string {
  return [
    `${label}_START`,
    ...Array.from(
      { length: 28 },
      (_, index) =>
        `${label.toLowerCase()} retained evidence ${index}: ${"x".repeat(42)}`,
    ),
    `${label}_END`,
  ].join("\n");
}

const reportSchema = z
  .object({
    schemaVersion: z.literal(3),
    contextCompactions: z.array(
      z
        .object({
          reason: z.enum(["proactive", "preflight", "overflow_recovery"]),
          providerRequestAction: z.enum([
            "compacted_before_request",
            "avoided_predictable_overflow_request",
            "retried_after_context_overflow",
          ]),
          scopes: z.array(
            z.enum([
              "history",
              "stale_tool_output",
              "current_tool_output_round",
            ]),
          ),
          beforeMessageCount: z.number().int().nonnegative(),
          afterMessageCount: z.number().int().nonnegative(),
          beforeEstimatedTokens: z.number().int().nonnegative(),
          afterEstimatedTokens: z.number().int().nonnegative(),
          toolOutputsCompacted: z.number().int().nonnegative(),
          staleToolOutputsCompacted: z.number().int().nonnegative(),
          currentToolOutputsCompacted: z.number().int().nonnegative(),
          toolOutputCharsBefore: z.number().int().nonnegative(),
          toolOutputCharsAfter: z.number().int().nonnegative(),
          toolOutputEstimatedTokensBefore: z.number().int().nonnegative(),
          toolOutputEstimatedTokensAfter: z.number().int().nonnegative(),
          artifacts: z.array(
            z.discriminatedUnion("status", [
              z.object({
                status: z.literal("stored"),
                ref: z.string(),
                toolCallId: z.string(),
                toolName: z.string(),
                sourceStatus: z.enum(["complete", "source-truncated"]),
                omittedChars: z.number().int().nonnegative(),
              }),
              z.object({
                status: z.literal("reused"),
                ref: z.string(),
                toolCallId: z.string(),
                toolName: z.string(),
                sourceStatus: z.enum(["complete", "source-truncated"]),
                omittedChars: z.number().int().nonnegative(),
              }),
              z.object({
                status: z.literal("failed"),
                reason: z.string(),
                toolCallId: z.string(),
                toolName: z.string(),
                sourceStatus: z.enum(["complete", "source-truncated"]),
                omittedChars: z.number().int().nonnegative(),
              }),
            ]),
          ),
        })
        .passthrough(),
    ),
  })
  .passthrough();
const requestControlSchema = z
  .object({
    tool_choice: z.unknown().optional(),
    tools: z.unknown().optional(),
  })
  .passthrough();

async function readReport(path: string): Promise<z.infer<typeof reportSchema>> {
  return reportSchema.parse(JSON.parse(await readFile(path, "utf8")));
}

async function toolOutputArtifactFileCount(home: string): Promise<number> {
  try {
    const entries = await readdir(join(home, "artifacts", "tool-output"), {
      recursive: true,
      withFileTypes: true,
    });
    return entries.filter((entry) => entry.isFile()).length;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return 0;
    }
    throw error;
  }
}

function onlyContextCompaction(report: z.infer<typeof reportSchema>) {
  expect(report.contextCompactions).toHaveLength(1);
  const compaction = report.contextCompactions[0];
  if (compaction === undefined) {
    throw new Error("report did not contain a context compaction");
  }
  return compaction;
}

function firstArtifactRef(
  compaction: ReturnType<typeof onlyContextCompaction>,
): string {
  const artifact = compaction.artifacts[0];
  if (artifact === undefined) {
    throw new Error("compaction did not contain an artifact");
  }
  if (artifact.status === "failed") {
    throw new Error("compaction artifact does not have a ref");
  }
  return artifact.ref;
}

function toolMessageContent(body: unknown, toolCallId: string): string {
  const request = requestWithMessagesSchema.parse(body);
  return (
    request.messages?.find(
      (message) =>
        message.role === "tool" && message.tool_call_id === toolCallId,
    )?.content ?? ""
  );
}

function isSummaryRequest(body: unknown): boolean {
  const request = requestControlSchema.parse(body);
  return request.tool_choice === "none" || request.tools === undefined;
}

describe("CLI Main - Run Report Compaction", () => {
  test(`Given a one-shot report run preflight-compacts current tool output,
    When the CLI writes the report,
    Then the report records the preflight reason, current-output scope, size change, and artifact state`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-cli-report-preflight-"),
    );
    const home = await mkdtemp(join(tmpdir(), "keel-artifact-home-"));
    const reportPath = join(workspace, "run.json");
    await writeFile(
      join(workspace, "preflight.log"),
      largeReadFixture("PREFLIGHT"),
      "utf8",
    );
    const mainBodies: unknown[] = [];
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
        const requestBody = JSON.parse(body);
        if (isSummaryRequest(requestBody)) {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          });
          res.end(sseTextReplyWithUsage("Earlier log read."));
          return;
        }
        mainBodies.push(requestBody);
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        if (mainBodies.length === 1) {
          res.write(
            sseToolCall("read_preflight_log", "read", {
              path: "preflight.log",
            }),
          );
          res.write(sseToolFinish());
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }

        const currentOutput = toolMessageContent(
          mainBodies[1],
          "read_preflight_log",
        );
        const preflightCompacted = currentOutput.includes(
          "[current tool output compacted before provider request:",
        );
        res.end(
          sseTextReplyWithUsage(
            preflightCompacted ? "preflight report ready" : "preflight missing",
          ),
        );
      });
    });
    await listen(server);
    const run = createRuntime(
      ["--report", reportPath, "inspect preflight.log"],
      {
        cwd: workspace,
        env: {
          DEEPSEEK_API_KEY: "test-key",
          DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
          KEEL_CONTEXT_WINDOW_TOKENS: "20000",
          KEEL_HOME: home,
        },
      },
    );

    try {
      // When
      const exitCode = await runCliMain(run.runtime);

      // Then
      expect(exitCode).toBe(0);
      expect(run.stdout()).toBe("preflight report ready\n");
      expect(run.stderr()).toContain("Context compacted: preflight");
      const report = await readReport(reportPath);
      expect(report).toMatchObject({
        schemaVersion: 3,
        contextCompactions: [
          {
            reason: "preflight",
            providerRequestAction: "avoided_predictable_overflow_request",
            scopes: ["current_tool_output_round"],
            staleToolOutputsCompacted: 0,
            currentToolOutputsCompacted: 1,
            toolOutputsCompacted: 1,
            artifacts: [
              {
                status: "reused",
                toolCallId: "read_preflight_log",
                toolName: "read",
              },
            ],
          },
        ],
      });
      const compaction = onlyContextCompaction(report);
      expect(compaction.toolOutputCharsBefore).toBeGreaterThan(
        compaction.toolOutputCharsAfter,
      );
      expect(compaction.toolOutputEstimatedTokensBefore).toBeGreaterThan(
        compaction.toolOutputEstimatedTokensAfter,
      );
      expect(firstArtifactRef(compaction)).toMatch(
        /^tool-output:run-[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/u,
      );
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given current-output preflight compaction would only save an orphan artifact,
    When the compacted marker would make the output larger,
    Then the report records no compaction and no artifact remains on disk`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-cli-report-current-noop-"),
    );
    const home = await mkdtemp(join(tmpdir(), "keel-artifact-home-"));
    const reportPath = join(workspace, "current-noop.json");
    await writeFile(join(workspace, "current-small.log"), "small output\n");
    const mainBodies: unknown[] = [];
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
        const requestBody = JSON.parse(body);
        if (isSummaryRequest(requestBody)) {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          });
          res.end(sseTextReplyWithUsage("unexpected summary request"));
          return;
        }
        mainBodies.push(requestBody);
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        if (mainBodies.length === 1) {
          res.write(
            sseToolCall("read_current_noop", "read", {
              path: "current-small.log",
            }),
          );
          res.write(sseToolFinish());
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }

        const currentOutput = toolMessageContent(
          mainBodies[1],
          "read_current_noop",
        );
        const originalOutputKept =
          currentOutput.includes("small output") &&
          !currentOutput.includes("[current tool output compacted");
        res.end(
          sseTextReplyWithUsage(
            originalOutputKept ? "current noop ready" : "current noop leaked",
          ),
        );
      });
    });
    await listen(server);
    const run = createRuntime(
      ["--report", reportPath, "inspect current-small.log"],
      {
        cwd: workspace,
        env: {
          DEEPSEEK_API_KEY: "test-key",
          DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
          KEEL_CONTEXT_WINDOW_TOKENS: "4000",
          KEEL_HOME: home,
        },
      },
    );

    try {
      // When
      const exitCode = await runCliMain(run.runtime);

      // Then
      expect(exitCode).toBe(0);
      expect(run.stdout()).toBe("current noop ready\n");
      expect(run.stderr()).not.toContain("Context compacted:");
      expect(run.stderr()).not.toContain("Tool output artifact:");
      const report = await readReport(reportPath);
      expect(report.contextCompactions).toEqual([]);
      expect(await toolOutputArtifactFileCount(home)).toBe(0);
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a one-shot report run recovers from provider context overflow,
    When Keel retries after compacting current tool output,
    Then the report records overflow recovery and the retry-related compaction facts`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-cli-report-overflow-"),
    );
    const home = await mkdtemp(join(tmpdir(), "keel-artifact-home-"));
    const reportPath = join(workspace, "run.json");
    await writeFile(
      join(workspace, "overflow.log"),
      largeReadFixture("OVERFLOW"),
      "utf8",
    );
    const mainBodies: unknown[] = [];
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
        const requestBody = JSON.parse(body);
        if (isSummaryRequest(requestBody)) {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          });
          res.end(sseTextReplyWithUsage("Earlier overflow log read."));
          return;
        }
        mainBodies.push(requestBody);
        if (mainBodies.length === 2) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: { message: "context_length_exceeded: prompt too long" },
            }),
          );
          return;
        }

        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        if (mainBodies.length === 1) {
          res.write(
            sseToolCall("read_overflow_log", "read", {
              path: "overflow.log",
            }),
          );
          res.write(sseToolFinish());
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }

        const currentOutput = toolMessageContent(
          mainBodies[2],
          "read_overflow_log",
        );
        const overflowCompacted = currentOutput.includes(
          "[current tool output compacted after context overflow:",
        );
        res.end(
          sseTextReplyWithUsage(
            overflowCompacted ? "overflow report ready" : "overflow missing",
          ),
        );
      });
    });
    await listen(server);
    const run = createRuntime(
      ["--report", reportPath, "inspect overflow.log"],
      {
        cwd: workspace,
        env: {
          DEEPSEEK_API_KEY: "test-key",
          DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
          KEEL_HOME: home,
        },
      },
    );

    try {
      // When
      const exitCode = await runCliMain(run.runtime);

      // Then
      expect(exitCode).toBe(0);
      expect(run.stdout()).toBe("overflow report ready\n");
      expect(run.stderr()).toContain("Context compacted: overflow recovery");
      expect(mainBodies).toHaveLength(3);
      const report = await readReport(reportPath);
      expect(report).toMatchObject({
        schemaVersion: 3,
        contextCompactions: [
          {
            reason: "overflow_recovery",
            providerRequestAction: "retried_after_context_overflow",
            scopes: ["current_tool_output_round"],
            staleToolOutputsCompacted: 0,
            currentToolOutputsCompacted: 1,
            toolOutputsCompacted: 1,
            artifacts: [
              {
                status: "reused",
                toolCallId: "read_overflow_log",
                toolName: "read",
              },
            ],
          },
        ],
      });
      const compaction = onlyContextCompaction(report);
      expect(compaction.beforeEstimatedTokens).toBeGreaterThan(
        compaction.afterEstimatedTokens,
      );
      expect(compaction.toolOutputCharsBefore).toBeGreaterThan(
        compaction.toolOutputCharsAfter,
      );
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given an interactive report session proactively summarizes old history,
    When the next provider request is sent,
    Then the report records proactive history compaction`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-cli-session-history-report-"),
    );
    const home = await mkdtemp(join(tmpdir(), "keel-artifact-home-"));
    const reportPath = join(workspace, "history.json");
    const input = new PassThrough();
    input.end("remember a large answer\ncontinue from that answer\n");
    const firstAssistantAnswer = [
      "HISTORY_START",
      "history remembered ".repeat(3_200),
      "HISTORY_END",
    ].join("\n");
    const mainBodies: unknown[] = [];
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
        const requestBody = JSON.parse(body);
        if (isSummaryRequest(requestBody)) {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          });
          res.end(sseTextReplyWithUsage("FIRST_TURN_CHECKPOINT"));
          return;
        }
        mainBodies.push(requestBody);
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        if (mainBodies.length === 1) {
          res.end(sseTextReplyWithUsage(firstAssistantAnswer));
          return;
        }

        const requestText = JSON.stringify(mainBodies[1]);
        const historyCompacted = !requestText.includes("HISTORY_END");
        res.end(
          sseTextReplyWithUsage(
            historyCompacted ? "history report ready" : "history missing",
          ),
        );
      });
    });
    await listen(server);
    const run = createRuntime(["--report", reportPath], {
      cwd: workspace,
      env: {
        DEEPSEEK_API_KEY: "test-key",
        DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
        KEEL_CONTEXT_WINDOW_TOKENS: "2000",
        KEEL_FORCE_INTERACTIVE: "1",
        KEEL_HOME: home,
      },
      input,
    });

    try {
      // When
      const exitCode = await runCliMain(run.runtime);

      // Then
      expect(exitCode).toBe(0);
      expect(run.stdout().slice(-128)).toContain("history report ready\n");
      expect(run.stderr()).toContain("Context compacted: proactive");
      expect(mainBodies).toHaveLength(2);
      const report = await readReport(reportPath);
      expect(report).toMatchObject({
        schemaVersion: 3,
        contextCompactions: [
          {
            reason: "proactive",
            providerRequestAction: "compacted_before_request",
            scopes: ["history"],
            staleToolOutputsCompacted: 0,
            currentToolOutputsCompacted: 0,
            toolOutputsCompacted: 0,
            artifacts: [],
          },
        ],
      });
      const compaction = onlyContextCompaction(report);
      expect(compaction.beforeMessageCount).toBeGreaterThan(
        compaction.afterMessageCount,
      );
      expect(compaction.beforeEstimatedTokens).toBeGreaterThan(
        compaction.afterEstimatedTokens,
      );
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given proactive history compaction would grow the request,
    When the next provider request is sent,
    Then the original smaller history is kept without recording compaction`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-cli-session-growing-history-report-"),
    );
    const home = await mkdtemp(join(tmpdir(), "keel-artifact-home-"));
    const reportPath = join(workspace, "growing-history.json");
    await writeFile(
      join(workspace, "medium.txt"),
      [
        "GROWING_START",
        ...Array.from(
          { length: 180 },
          (_, index) =>
            `growing line ${index} context payload for the proactive growing compaction reproduction`,
        ),
        "GROWING_END",
      ].join("\n"),
      "utf8",
    );
    const input = new PassThrough();
    input.write("read medium.txt and confirm\n");
    let continuationQueued = false;
    const queueContinuation = () => {
      if (continuationQueued) {
        return;
      }
      continuationQueued = true;
      input.end("Now summarize\n");
    };
    let summaryRequests = 0;
    const mainBodies: unknown[] = [];
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
        const requestBody = JSON.parse(body);
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        if (isSummaryRequest(requestBody)) {
          summaryRequests++;
          res.end(sseTextReplyWithUsage("OVERSIZED_CHECKPOINT ".repeat(1_500)));
          return;
        }

        mainBodies.push(requestBody);
        if (mainBodies.length === 1) {
          res.write(
            sseToolCall("glob_growing_medium", "glob", {
              pattern: "**/medium.txt",
            }),
          );
          res.write(sseToolFinish());
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }

        if (mainBodies.length === 2) {
          res.write(
            sseToolCall("read_growing_medium", "read", { path: "medium.txt" }),
          );
          res.write(sseToolFinish());
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }

        if (mainBodies.length === 3) {
          const currentOutput = toolMessageContent(
            mainBodies[2],
            "read_growing_medium",
          );
          const preflightCompacted = currentOutput.includes(
            "[current tool output compacted before provider request:",
          );
          res.end(
            sseTextReplyWithUsage(
              preflightCompacted ? "medium confirmed" : "medium missing",
            ),
          );
          return;
        }

        const requestText = JSON.stringify(mainBodies[3]);
        const keptOriginalHistory =
          requestText.includes("medium confirmed") &&
          requestText.includes(
            "[current tool output compacted before provider request:",
          ) &&
          !requestText.includes("OVERSIZED_CHECKPOINT");
        res.end(
          sseTextReplyWithUsage(
            keptOriginalHistory
              ? "original history kept"
              : "larger checkpoint sent",
          ),
        );
      });
    });
    await listen(server);
    const run = createRuntime(["--report", reportPath], {
      cwd: workspace,
      env: {
        DEEPSEEK_API_KEY: "test-key",
        DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
        KEEL_CONTEXT_WINDOW_TOKENS: "4000",
        KEEL_FORCE_INTERACTIVE: "1",
        KEEL_HOME: home,
      },
      input,
      onStdout: (text) => {
        if (text.includes("medium confirmed")) {
          queueContinuation();
        }
      },
    });

    try {
      // When
      const exitCode = await runCliMain(run.runtime);

      // Then
      expect(exitCode).toBe(0);
      expect(summaryRequests).toBe(1);
      expect(mainBodies).toHaveLength(4);
      expect(run.stdout().slice(-128)).toContain("original history kept\n");
      expect(run.stderr()).toContain("Context compacted: preflight");
      expect(run.stderr()).not.toContain("Context compacted: proactive");
      const report = await readReport(reportPath);
      expect(
        report.contextCompactions.some(
          (compaction) => compaction.reason === "preflight",
        ),
      ).toBe(true);
      expect(
        report.contextCompactions.some(
          (compaction) => compaction.reason === "proactive",
        ),
      ).toBe(false);
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given restored reads make a proactive history checkpoint larger after finalization,
    When the next provider request is sent,
    Then the final larger checkpoint is rejected without recording compaction`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-cli-session-post-restore-growth-report-"),
    );
    const home = await mkdtemp(join(tmpdir(), "keel-artifact-home-"));
    const reportPath = join(workspace, "post-restore-growth.json");
    await writeFile(
      join(workspace, "restore-growth.txt"),
      [
        "RESTORE_GROWTH_START",
        ...Array.from(
          { length: 1_200 },
          (_, index) => `restore growth line ${index}: ${"payload ".repeat(8)}`,
        ),
        "RESTORE_GROWTH_END",
      ].join("\n"),
      "utf8",
    );
    const input = new PassThrough();
    input.write("read restore-growth.txt and confirm\n");
    let continuationQueued = false;
    const queueContinuation = () => {
      if (continuationQueued) {
        return;
      }
      continuationQueued = true;
      input.end("Now summarize\n");
    };
    let summaryRequests = 0;
    const mainBodies: unknown[] = [];
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
        const requestBody = JSON.parse(body);
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        if (isSummaryRequest(requestBody)) {
          summaryRequests++;
          res.end(sseTextReplyWithUsage("RESTORE_SMALL_CHECKPOINT"));
          return;
        }

        mainBodies.push(requestBody);
        if (mainBodies.length === 1) {
          res.write(
            sseToolCall("read_restore_growth", "read", {
              path: "restore-growth.txt",
            }),
          );
          res.write(sseToolFinish());
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }

        if (mainBodies.length === 2) {
          const currentOutput = toolMessageContent(
            mainBodies[1],
            "read_restore_growth",
          );
          const preflightCompacted = currentOutput.includes(
            "[current tool output compacted before provider request:",
          );
          res.end(
            sseTextReplyWithUsage(
              preflightCompacted
                ? "restore growth confirmed"
                : "restore growth missing",
            ),
          );
          return;
        }

        const requestText = JSON.stringify(mainBodies[2]);
        const keptOriginalHistory =
          requestText.includes("restore growth confirmed") &&
          requestText.includes(
            "[current tool output compacted before provider request:",
          ) &&
          !requestText.includes("RESTORE_SMALL_CHECKPOINT") &&
          !requestText.includes("RESTORE_GROWTH_END");
        res.end(
          sseTextReplyWithUsage(
            keptOriginalHistory
              ? "post-restore growth rejected"
              : "larger restored checkpoint sent",
          ),
        );
      });
    });
    await listen(server);
    const run = createRuntime(["--report", reportPath], {
      cwd: workspace,
      env: {
        DEEPSEEK_API_KEY: "test-key",
        DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
        KEEL_CONTEXT_WINDOW_TOKENS: "4000",
        KEEL_FORCE_INTERACTIVE: "1",
        KEEL_HOME: home,
      },
      input,
      onStdout: (text) => {
        if (text.includes("restore growth confirmed")) {
          queueContinuation();
        }
      },
    });

    try {
      // When
      const exitCode = await runCliMain(run.runtime);

      // Then
      expect(exitCode).toBe(0);
      expect(summaryRequests).toBe(1);
      expect(mainBodies).toHaveLength(3);
      expect(run.stdout().slice(-128)).toContain(
        "post-restore growth rejected\n",
      );
      expect(run.stderr()).toContain("Context compacted: preflight");
      expect(run.stderr()).not.toContain("Context compacted: proactive");
      const report = await readReport(reportPath);
      expect(
        report.contextCompactions.some(
          (compaction) => compaction.reason === "preflight",
        ),
      ).toBe(true);
      expect(
        report.contextCompactions.some(
          (compaction) => compaction.reason === "proactive",
        ),
      ).toBe(false);
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given an interactive report session restores a compacted read after history compaction,
    When the report message count is unchanged,
    Then the report still records proactive history scope`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-cli-session-history-scope-report-"),
    );
    const home = await mkdtemp(join(tmpdir(), "keel-artifact-home-"));
    const reportPath = join(workspace, "history-scope.json");
    await writeFile(
      join(workspace, "medium.txt"),
      [
        "MEDIUM_START",
        ...Array.from(
          { length: 180 },
          (_, index) =>
            `medium line ${index} context payload for summary scope detection and live compaction verification`,
        ),
        "MEDIUM_END",
      ].join("\n"),
      "utf8",
    );
    const input = new PassThrough();
    input.write(
      `read medium.txt and confirm. ${"background context ".repeat(1_500)}\n`,
    );
    let continuationQueued = false;
    const queueContinuation = () => {
      if (continuationQueued) {
        return;
      }
      continuationQueued = true;
      input.end("Now summarize\n");
    };
    const mainBodies: unknown[] = [];
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
        const requestBody = JSON.parse(body);
        if (isSummaryRequest(requestBody)) {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          });
          res.end(sseTextReplyWithUsage("MEDIUM_CHECKPOINT"));
          return;
        }
        mainBodies.push(requestBody);
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        if (mainBodies.length === 1) {
          res.write(
            sseToolCall("read_medium_file", "read", { path: "medium.txt" }),
          );
          res.write(sseToolFinish());
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }
        if (mainBodies.length === 2) {
          const currentOutput = toolMessageContent(
            mainBodies[1],
            "read_medium_file",
          );
          const preflightCompacted = currentOutput.includes(
            "[current tool output compacted before provider request:",
          );
          res.end(
            sseTextReplyWithUsage(
              preflightCompacted ? "medium confirmed" : "medium missing",
            ),
          );
          return;
        }

        res.end(sseTextReplyWithUsage("history scope report ready"));
      });
    });
    await listen(server);
    const run = createRuntime(["--report", reportPath], {
      cwd: workspace,
      env: {
        DEEPSEEK_API_KEY: "test-key",
        DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
        KEEL_CONTEXT_WINDOW_TOKENS: "4000",
        KEEL_FORCE_INTERACTIVE: "1",
        KEEL_HOME: home,
      },
      input,
      onStdout: (text) => {
        if (text.includes("medium confirmed")) {
          queueContinuation();
        }
      },
    });

    try {
      // When
      const exitCode = await runCliMain(run.runtime);

      // Then
      expect(exitCode).toBe(0);
      expect(run.stdout().slice(-128)).toContain(
        "history scope report ready\n",
      );
      expect(run.stderr()).toContain("Context compacted: proactive");
      const report = await readReport(reportPath);
      const proactive = report.contextCompactions.find(
        (compaction) => compaction.reason === "proactive",
      );
      expect(proactive).toMatchObject({
        providerRequestAction: "compacted_before_request",
        scopes: ["history"],
        staleToolOutputsCompacted: 0,
        currentToolOutputsCompacted: 0,
        toolOutputsCompacted: 0,
        artifacts: [],
      });
      expect(proactive?.afterEstimatedTokens).toBeLessThan(
        proactive?.beforeEstimatedTokens ?? 0,
      );
      expect(proactive?.beforeMessageCount).toBe(proactive?.afterMessageCount);
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given stale tool-output compaction would grow the retained output,
    When queued input continues after the read,
    Then the provider request keeps the smaller original output and the report records only history compaction`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-cli-session-stale-growth-report-"),
    );
    const home = await mkdtemp(join(tmpdir(), "keel-artifact-home-"));
    const reportPath = join(workspace, "stale-growth.json");
    await writeFile(
      join(workspace, "stale-growth.log"),
      barelyOversizedStaleReadFixture("STALE_GROWTH"),
      "utf8",
    );
    const input = new PassThrough();
    input.write("remember setup before the small stale read\n");
    input.write("inspect stale-growth.log\n");
    const firstAssistantAnswer = [
      "SETUP_START",
      "setup remembered ".repeat(5_800),
      "SETUP_END",
    ].join("\n");
    const mainBodies: unknown[] = [];
    let continuationQueued = false;
    const queueContinuation = () => {
      if (continuationQueued) {
        return;
      }
      continuationQueued = true;
      input.end("continue after the small stale read\n");
    };
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
        const requestBody = JSON.parse(body);
        if (isSummaryRequest(requestBody)) {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          });
          res.end(sseTextReplyWithUsage("STALE_GROWTH_SETUP_CHECKPOINT"));
          return;
        }
        mainBodies.push(requestBody);
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        if (mainBodies.length === 1) {
          res.end(sseTextReplyWithUsage(firstAssistantAnswer));
          return;
        }
        if (mainBodies.length === 2) {
          res.write(
            sseToolCall("read_stale_growth_report", "read", {
              path: "stale-growth.log",
            }),
          );
          res.write(sseToolFinish());
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }

        const staleOutput = toolMessageContent(
          mainBodies[mainBodies.length - 1],
          "read_stale_growth_report",
        );
        if (mainBodies.length === 3) {
          const fullOutputVisible = staleOutput.includes("STALE_GROWTH_END");
          res.end(
            sseTextReplyWithUsage(
              fullOutputVisible
                ? `The small stale report was inspected.\n${"analysis note ".repeat(
                    2_500,
                  )}`
                : "small stale read missing",
            ),
          );
          return;
        }

        const smallerOriginalKept =
          staleOutput.includes("STALE_GROWTH_END") &&
          !staleOutput.includes("[stale tool output compacted:");
        res.end(
          sseTextReplyWithUsage(
            smallerOriginalKept
              ? "stale growth avoided"
              : "stale tool output grew",
          ),
        );
      });
    });
    await listen(server);
    const run = createRuntime(["--report", reportPath], {
      cwd: workspace,
      env: {
        DEEPSEEK_API_KEY: "test-key",
        DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
        KEEL_CONTEXT_WINDOW_TOKENS: "46384",
        KEEL_FORCE_INTERACTIVE: "1",
        KEEL_HOME: home,
      },
      input,
      onStdout: (text) => {
        if (text.includes("The small stale report was inspected.")) {
          queueContinuation();
        }
      },
    });

    try {
      // When
      const exitCode = await runCliMain(run.runtime);

      // Then
      expect(exitCode).toBe(0);
      expect(run.stdout().slice(-128)).toContain("stale growth avoided\n");
      expect(run.stderr()).toContain("Context compacted: proactive");
      expect(mainBodies).toHaveLength(4);
      const report = await readReport(reportPath);
      const proactive = onlyContextCompaction(report);
      expect(proactive).toMatchObject({
        reason: "proactive",
        providerRequestAction: "compacted_before_request",
        scopes: ["history"],
        staleToolOutputsCompacted: 0,
        currentToolOutputsCompacted: 0,
        toolOutputsCompacted: 0,
        artifacts: [],
      });
      expect(proactive.toolOutputCharsBefore).toBe(0);
      expect(proactive.toolOutputCharsAfter).toBe(0);
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given an interactive report session compacts retained stale tool output,
    When queued input continues after the read,
    Then the report records stale tool-output scope and artifact details`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-cli-session-stale-report-"),
    );
    const home = await mkdtemp(join(tmpdir(), "keel-artifact-home-"));
    const reportPath = join(workspace, "stale.json");
    await writeFile(
      join(workspace, "stale.log"),
      retainedStaleReadFixture("STALE"),
      "utf8",
    );
    const input = new PassThrough();
    input.write("remember enough setup\ninspect stale.log\n");
    const firstAssistantAnswer = [
      "SETUP_START",
      "setup remembered ".repeat(5_800),
      "SETUP_END",
    ].join("\n");
    const mainBodies: unknown[] = [];
    let continuationQueued = false;
    const queueContinuation = () => {
      if (continuationQueued) {
        return;
      }
      continuationQueued = true;
      input.end("continue after stale read\n");
    };
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
        const requestBody = JSON.parse(body);
        if (isSummaryRequest(requestBody)) {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          });
          res.end(sseTextReplyWithUsage("STALE_SETUP_CHECKPOINT"));
          return;
        }
        mainBodies.push(requestBody);
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        if (mainBodies.length === 1) {
          res.end(sseTextReplyWithUsage(firstAssistantAnswer));
          return;
        }
        if (mainBodies.length === 2) {
          res.write(
            sseToolCall("read_stale_report", "read", { path: "stale.log" }),
          );
          res.write(sseToolFinish());
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }

        const staleOutput = toolMessageContent(
          mainBodies[mainBodies.length - 1],
          "read_stale_report",
        );
        if (mainBodies.length === 3) {
          const fullOutputVisible = staleOutput.includes("STALE_END");
          res.end(
            sseTextReplyWithUsage(
              fullOutputVisible
                ? "The stale report was inspected."
                : "stale read missing",
            ),
          );
          return;
        }
        const staleCompacted =
          staleOutput.includes("[stale tool output compacted:") &&
          staleOutput.includes("full output artifact: tool-output:") &&
          !staleOutput.includes("STALE_END");
        res.end(
          sseTextReplyWithUsage(
            staleCompacted ? "stale report ready" : "stale missing",
          ),
        );
      });
    });
    await listen(server);
    const run = createRuntime(["--report", reportPath], {
      cwd: workspace,
      env: {
        DEEPSEEK_API_KEY: "test-key",
        DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
        KEEL_CONTEXT_WINDOW_TOKENS: "46384",
        KEEL_FORCE_INTERACTIVE: "1",
        KEEL_HOME: home,
      },
      input,
      onStdout: (text) => {
        if (text.includes("The stale report was inspected.")) {
          queueContinuation();
        }
      },
    });

    try {
      // When
      const exitCode = await runCliMain(run.runtime);

      // Then
      expect(exitCode).toBe(0);
      expect(run.stdout().slice(-128)).toContain("stale report ready\n");
      expect(run.stderr()).toContain("Context compacted: proactive");
      expect(mainBodies).toHaveLength(4);
      const report = await readReport(reportPath);
      expect(report).toMatchObject({
        schemaVersion: 3,
        contextCompactions: [
          {
            reason: "proactive",
            providerRequestAction: "compacted_before_request",
            scopes: ["history", "stale_tool_output"],
            staleToolOutputsCompacted: 1,
            currentToolOutputsCompacted: 0,
            toolOutputsCompacted: 1,
            artifacts: [
              {
                status: "stored",
                toolCallId: "read_stale_report",
                toolName: "read",
                sourceStatus: "complete",
              },
            ],
          },
        ],
      });
      const compaction = onlyContextCompaction(report);
      expect(compaction.toolOutputCharsBefore).toBeGreaterThan(
        compaction.toolOutputCharsAfter,
      );
      expect(firstArtifactRef(compaction)).toMatch(
        /^tool-output:session-session-[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/u,
      );
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given an interactive report session preflight-compacts current tool output,
    When the session exits,
    Then the session report includes the automatic compaction event`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-cli-session-compaction-report-"),
    );
    const home = await mkdtemp(join(tmpdir(), "keel-artifact-home-"));
    const reportPath = join(workspace, "session.json");
    await writeFile(
      join(workspace, "session.log"),
      largeReadFixture("SESSION"),
      "utf8",
    );
    const input = new PassThrough();
    input.end("inspect session.log\n");
    const mainBodies: unknown[] = [];
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
        const requestBody = JSON.parse(body);
        if (isSummaryRequest(requestBody)) {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          });
          res.end(sseTextReplyWithUsage("Earlier session log read."));
          return;
        }
        mainBodies.push(requestBody);
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        if (mainBodies.length === 1) {
          res.write(
            sseToolCall("read_session_log", "read", { path: "session.log" }),
          );
          res.write(sseToolFinish());
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }

        const currentOutput = toolMessageContent(
          mainBodies[1],
          "read_session_log",
        );
        const preflightCompacted = currentOutput.includes(
          "[current tool output compacted before provider request:",
        );
        res.end(
          sseTextReplyWithUsage(
            preflightCompacted ? "session report ready" : "session missing",
          ),
        );
      });
    });
    await listen(server);
    const run = createRuntime(["--report", reportPath], {
      cwd: workspace,
      env: {
        DEEPSEEK_API_KEY: "test-key",
        DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
        KEEL_CONTEXT_WINDOW_TOKENS: "20000",
        KEEL_FORCE_INTERACTIVE: "1",
        KEEL_HOME: home,
      },
      input,
    });

    try {
      // When
      const exitCode = await runCliMain(run.runtime);

      // Then
      expect(exitCode).toBe(0);
      expect(run.stdout()).toContain("session report ready\n");
      const report = await readReport(reportPath);
      expect(report).toMatchObject({
        schemaVersion: 3,
        contextCompactions: [
          {
            reason: "preflight",
            providerRequestAction: "avoided_predictable_overflow_request",
            scopes: ["current_tool_output_round"],
            currentToolOutputsCompacted: 1,
            artifacts: [
              {
                toolCallId: "read_session_log",
                toolName: "read",
              },
            ],
          },
        ],
      });
      const compaction = onlyContextCompaction(report);
      expect(["stored", "reused"]).toContain(compaction.artifacts[0]?.status);
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });
});
