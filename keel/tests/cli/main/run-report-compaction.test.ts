import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
        /^tool-output:interactive-[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/u,
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
