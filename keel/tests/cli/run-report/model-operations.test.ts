import { PassThrough } from "node:stream";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import type { AgentEvent } from "../../../src/agent/events.ts";
import { runInteractiveSession } from "../../../src/cli/interactive-session.ts";
import { ZERO_COST_MODEL } from "../../../src/core/cost.ts";
import { createDeepseekProvider } from "../../../src/llm/providers/deepseek.ts";
import type { LLMProvider } from "../../../src/llm/types.ts";
import { sseTextReplyWithUsage } from "../../../src/testing/provider-sse-fixtures.ts";
import {
  close,
  createServer,
  getPort,
  join,
  listen,
  mkdtemp,
  readFile,
  rm,
  runCli,
  tmpdir,
} from "./fixtures.ts";

const usageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative(),
  uncachedInputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
});

const retryDecisionSchema = z.object({
  provider: z.string(),
  reason: z.string(),
  attempt: z.number().int().positive(),
  maxRetries: z.number().int().nonnegative(),
  delayMs: z.number().nonnegative(),
});

const providerAttemptBase = { ordinal: z.number().int().positive() };

const providerAttemptSchema = z.discriminatedUnion("outcome", [
  z.object({
    ...providerAttemptBase,
    outcome: z.literal("completed"),
    usage: usageSchema,
    costUsd: z.number().nonnegative(),
  }),
  z.object({
    ...providerAttemptBase,
    outcome: z.literal("retryable_error"),
    retryDecision: retryDecisionSchema,
  }),
  z.object({
    ...providerAttemptBase,
    outcome: z.literal("context_overflow"),
    recoveryOperationOrdinal: z.number().int().positive().nullable(),
  }),
  z.object({
    ...providerAttemptBase,
    outcome: z.enum(["terminal_error", "aborted"]),
  }),
]);

const modelOperationBase = {
  ordinal: z.number().int().positive(),
  owner: z.discriminatedUnion("type", [
    z.object({
      type: z.literal("agent_run"),
      taskOrdinal: z.number().int().positive(),
      agentRunOrdinal: z.number().int().positive(),
    }),
    z.object({ type: z.literal("session") }),
    z.object({ type: z.literal("invocation") }),
  ]),
  purpose: z.enum([
    "agent_turn",
    "turn_limit_summary",
    "context_compaction",
    "goal_assertion_evaluation",
    "manual_compaction",
    "model_switch_compaction",
  ]),
  provider: z.string(),
  model: z.string(),
  providerRequestAttempts: z.array(providerAttemptSchema),
  outcome: z.enum([
    "completed",
    "context_overflow",
    "terminal_error",
    "aborted",
    "admission_rejected",
  ]),
  usage: usageSchema,
  costUsd: z.number().nonnegative(),
};

const modelOperationSchema = z.object(modelOperationBase);

const modelOperationReportSchema = z
  .object({
    schemaVersion: z.literal(11),
    modelOperations: z.array(modelOperationSchema),
    modelOperationCount: z.number().int().nonnegative(),
    providerRequestAttemptCount: z.number().int().nonnegative(),
  })
  .passthrough();

async function readModelOperationReport(path: string) {
  return modelOperationReportSchema.parse(
    JSON.parse(await readFile(path, "utf8")),
  );
}

function isSummaryRequest(body: unknown): boolean {
  const result = z
    .object({
      tool_choice: z.unknown().optional(),
      tools: z.unknown().optional(),
    })
    .passthrough()
    .parse(body);
  return result.tool_choice === "none" || result.tools === undefined;
}

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

describe("CLI Run Report - Model Operations", () => {
  test(`Given a provider retries a rate-limited request and succeeds,
    When the user writes a run report,
    Then one agent turn operation records both physical attempts and the retry decision`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-report-operation-retry-"),
    );
    const reportPath = join(workspace, "retry-report.json");
    let requests = 0;
    const server = createServer((req, res) => {
      if (req.url !== "/chat/completions") {
        res.writeHead(404);
        res.end();
        return;
      }
      req.resume();
      req.on("end", () => {
        requests++;
        if (requests === 1) {
          res.writeHead(429, {
            "Content-Type": "application/json",
            "retry-after-ms": "0",
          });
          res.end(JSON.stringify({ error: { message: "try again" } }));
          return;
        }
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.end(sseTextReplyWithUsage("Recovered after retry."));
      });
    });
    await listen(server);

    try {
      // When
      const result = await runCli(
        ["--report", reportPath, "hello after retry"],
        {
          cwd: workspace,
          env: {
            KEEL_PROVIDER: "deepseek",
            DEEPSEEK_API_KEY: "test-key",
            DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
          },
        },
      );

      // Then
      expect(result.exitCode).toBe(0);
      expect(requests).toBe(2);
      const report = await readModelOperationReport(reportPath);
      expect(report.modelOperationCount).toBe(1);
      expect(report.providerRequestAttemptCount).toBe(2);
      expect(report.modelOperations).toMatchObject([
        {
          ordinal: 1,
          owner: { type: "agent_run", taskOrdinal: 1, agentRunOrdinal: 1 },
          purpose: "agent_turn",
          provider: "deepseek",
          model: "deepseek-v4-flash",
          outcome: "completed",
          providerRequestAttempts: [
            {
              ordinal: 1,
              outcome: "retryable_error",
              retryDecision: {
                provider: "DeepSeek",
                reason: "provider_rate_limited",
                attempt: 1,
                maxRetries: 4,
                delayMs: 0,
              },
            },
            {
              ordinal: 2,
              outcome: "completed",
              usage: {
                inputTokens: 10,
                outputTokens: 3,
              },
            },
          ],
          usage: {
            inputTokens: 10,
            outputTokens: 3,
          },
        },
      ]);
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a provider request overflows before assistant output,
    When Keel compacts and retries inside the same run,
    Then the report preserves the failed attempt, recovery operation, and retried attempt causality`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-report-operation-overflow-"),
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
        const requestBody: unknown = JSON.parse(body);
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
        if (mainBodies.length === 1) {
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
        res.end(sseTextReplyWithUsage("overflow report ready"));
      });
    });
    await listen(server);
    const input = new PassThrough();
    input.end("continue after overflow\n");
    const provider = createDeepseekProvider({
      apiKey: "test-key",
      baseUrl: `http://127.0.0.1:${getPort(server)}`,
      model: "deepseek-v4-flash",
    });
    const sigintHandlers = new Set<() => void>();

    try {
      // When
      const result = await runInteractiveSession({
        cliArgs: { bashMode: "disabled", reportFile: "report.json" },
        workspace,
        platform: process.platform,
        input,
        initialMessages: [
          { role: "user", content: "Preserve the earlier investigation." },
          {
            role: "assistant",
            content: largeReadFixture("EARLIER_INVESTIGATION"),
            toolCalls: [],
          },
        ],
        writeStdout: () => {},
        writeStderr: () => {},
        onSigint: (handler) => {
          sigintHandlers.add(handler);
        },
        offSigint: (handler) => {
          sigintHandlers.delete(handler);
        },
        setExitCode: () => {},
        forceExit: (code) => {
          throw new Error(`unexpected forced exit ${code}`);
        },
        resolveProvider: () => ({
          provider,
          providerId: "deepseek",
          model: "deepseek-v4-flash",
          costModel: ZERO_COST_MODEL,
          modelSource: "default",
          contextCompaction: { keepRecentTokens: 1 },
        }),
        requireKnownCostModel: () => ZERO_COST_MODEL,
        printAgentEvents: async (stream) => {
          let end: Extract<AgentEvent, { readonly type: "end" }> | undefined;
          for await (const event of stream) {
            if (event.type === "end") end = event;
          }
          return end;
        },
        formatCostReport: () => "",
      });

      // Then
      expect(result.report).toBeDefined();
      expect(mainBodies).toHaveLength(2);
      const report = modelOperationReportSchema.parse({
        schemaVersion: 11,
        modelOperations: result.report?.modelOperations ?? [],
        modelOperationCount: result.report?.modelOperationCount ?? 0,
        providerRequestAttemptCount:
          result.report?.providerRequestAttemptCount ?? 0,
      });
      expect(report.modelOperations).toMatchObject([
        {
          ordinal: 1,
          owner: { type: "agent_run", taskOrdinal: 1, agentRunOrdinal: 1 },
          purpose: "agent_turn",
          outcome: "completed",
          providerRequestAttempts: [
            {
              ordinal: 1,
              outcome: "context_overflow",
              recoveryOperationOrdinal: 2,
            },
            { ordinal: 2, outcome: "completed" },
          ],
        },
        {
          ordinal: 2,
          owner: { type: "agent_run", taskOrdinal: 1, agentRunOrdinal: 1 },
          purpose: "context_compaction",
          outcome: "completed",
          providerRequestAttempts: [{ ordinal: 1, outcome: "completed" }],
        },
      ]);
      expect(report.providerRequestAttemptCount).toBe(3);
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an interactive session only performs manual compaction,
    When the report is written without any Agent Run,
    Then the session-owned manual compaction operation still records its provider attempt`, async () => {
    // Given
    const input = new PassThrough();
    input.end("/compact\n");
    const provider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        expect(options.toolChoice).toBe("none");
        const attempt = options.providerRequestAttempts?.begin();
        yield { type: "text", text: "Manual checkpoint summary." };
        const usage = {
          inputTokens: 7,
          cachedInputTokens: 0,
          uncachedInputTokens: 7,
          outputTokens: 2,
        };
        attempt?.finish({ outcome: "completed", usage });
        yield {
          type: "stop",
          reason: "stop",
          usage,
        };
      },
    };
    let stdout = "";
    let stderr = "";
    const sigintHandlers = new Set<() => void>();

    // When
    const result = await runInteractiveSession({
      cliArgs: { bashMode: "disabled", reportFile: "report.json" },
      workspace: process.cwd(),
      platform: process.platform,
      input,
      initialMessages: [
        { role: "user", content: "remember prior context" },
        {
          role: "assistant",
          content: "Prior context answer.",
          toolCalls: [],
        },
      ],
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
      },
      onSigint: (handler) => {
        sigintHandlers.add(handler);
      },
      offSigint: (handler) => {
        sigintHandlers.delete(handler);
      },
      setExitCode: () => {},
      forceExit: (code) => {
        throw new Error(`unexpected forced exit ${code}`);
      },
      resolveProvider: () => ({
        provider,
        providerId: "fake",
        model: "fake",
        costModel: ZERO_COST_MODEL,
        contextCompaction: { keepRecentTokens: 1 },
      }),
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async (stream) => {
        let finalEnd: Extract<AgentEvent, { readonly type: "end" }> | undefined;
        for await (const event of stream) {
          if (event.type === "text") {
            stdout += event.text;
          } else if (event.type === "end") {
            finalEnd = event;
          }
        }
        return finalEnd;
      },
      formatCostReport: () => "",
    });

    // Then
    expect(stdout).toBe("");
    expect(stderr).toContain("Context compacted: manual");
    expect(result.report).toBeDefined();
    const rawReport = {
      schemaVersion: 11,
      tasks: result.report?.tasks ?? [],
      modelOperations: result.report?.modelOperations ?? [],
      modelOperationCount: result.report?.modelOperationCount ?? 0,
      providerRequestAttemptCount:
        result.report?.providerRequestAttemptCount ?? 0,
    };
    const report = modelOperationReportSchema.parse(rawReport);
    expect(report).toMatchObject({
      tasks: [],
      modelOperationCount: 1,
      providerRequestAttemptCount: 1,
      modelOperations: [
        {
          ordinal: 1,
          owner: { type: "session" },
          purpose: "manual_compaction",
          provider: "fake",
          model: "fake",
          outcome: "completed",
          providerRequestAttempts: [
            {
              ordinal: 1,
              outcome: "completed",
              usage: {
                inputTokens: 7,
                outputTokens: 2,
              },
            },
          ],
          usage: {
            inputTokens: 7,
            outputTokens: 2,
          },
        },
      ],
    });
  });
});
