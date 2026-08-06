import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { AgentEvent } from "../../src/agent/events.ts";
import { runAgent, runAgentTurn } from "../../src/agent/loop.ts";
import type { SessionMessage } from "../../src/agent/session-message.ts";
import {
  defaultStopPolicy,
  maxTurnFallbackPolicy,
} from "../../src/agent/stop-policy.ts";
import {
  accountModelOperations,
  createAgentEventReportRecorder,
} from "../../src/cli/report-events.ts";
import type { CostModel } from "../../src/core/cost.ts";
import { KeelError } from "../../src/core/error.ts";
import type { SessionGoal } from "../../src/core/session-goal.ts";
import { createDeepseekProvider } from "../../src/llm/providers/deepseek.ts";
import {
  createFakeProvider,
  fakeResponse,
  fakeToolResponse,
} from "../../src/llm/providers/fake.ts";
import type { LLMProvider, Usage } from "../../src/llm/types.ts";
import { sessionLedgerMirroringMessages } from "../../src/testing/session-ledger-fixtures.ts";

const ZERO_USAGE: Usage = {
  inputTokens: 0,
  cachedInputTokens: 0,
  uncachedInputTokens: 0,
  outputTokens: 0,
};

const ZERO_COST_MODEL: CostModel = {
  type: "fixed",
  uncachedInputPerMillionTokens: 0,
  cachedInputPerMillionTokens: 0,
  outputPerMillionTokens: 0,
};

async function collect(
  source: AsyncIterable<AgentEvent>,
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of source) events.push(event);
  return events;
}

function reportRecorderWithAgentRun() {
  const recorder = createAgentEventReportRecorder();
  recorder.beginTask("user_prompt");
  recorder.beginAgentRun("user_prompt");
  return recorder;
}

describe("Model Operations", () => {
  test(`Given the Agent loop reaches its turn cap and requests wrap-up,
    When the provider completes the wrap-up request,
    Then the report classifies wrap-up separately without increasing Agent-loop turns`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-model-operation-"));
    await writeFile(join(workspace, "note.txt"), "old\n", "utf8");
    const provider = createFakeProvider([
      fakeToolResponse("edit", {
        path: "note.txt",
        edits: [{ oldText: "old", newText: "new" }],
      }),
      fakeToolResponse("read", { path: "note.txt" }),
      fakeResponse("Reached the turn limit after updating note.txt."),
    ]);
    const recorder = reportRecorderWithAgentRun();

    try {
      // When
      await collect(
        runAgent({
          workspace,
          provider,
          userMessage: "Update and inspect note.txt",
          systemPrompt: "You are helpful.",
          signal: new AbortController().signal,
          bash: { kind: "disabled" },
          stopPolicy: maxTurnFallbackPolicy(2),
          modelOperations: {
            recorder,
            owner: { type: "current_agent_run" },
            provider: "fake",
            model: "fake",
            costModel: ZERO_COST_MODEL,
          },
        }),
      );

      // Then
      const accounting = accountModelOperations(recorder.modelOperations());
      expect(
        accounting.modelOperations.map((operation) => operation.purpose),
      ).toEqual(["agent_turn", "agent_turn", "turn_limit_summary"]);
      expect(accounting.agentLoopTurns).toBe(2);
      expect(accounting.providerRequestAttemptCount).toBe(3);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an assertion goal asks the independent evaluator for judgment,
    When the evaluator rejects the proposed completion and the Agent continues,
    Then evaluator work is not counted as an Agent-loop model turn`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-model-operation-"));
    const messages: SessionMessage[] = [
      { role: "user", content: "Complete the assertion goal." },
    ];
    const goal: SessionGoal = {
      objective: "Complete the assertion goal",
      status: "active",
      budget: {},
      usage: { turns: 0, tokens: 0, activeTimeMs: 0 },
      completion: {
        kind: "assertion",
        assertion: "Trusted evidence proves the work is complete.",
      },
    };
    let agentRequests = 0;
    const provider: LLMProvider = {
      id: "assertion-operation-provider",
      async *stream(options) {
        const attempt = options.providerRequestAttempts?.begin();
        if (options.toolExposure?.kind === "none") {
          const text = JSON.stringify({
            completed: false,
            reason: "No trusted evidence was surfaced.",
          });
          yield { type: "text", text };
          attempt?.finish({ outcome: "completed", usage: ZERO_USAGE });
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        agentRequests++;
        if (agentRequests === 1) {
          yield {
            type: "tool_call",
            id: "complete_goal",
            tool: "update_goal",
            status: "completed",
          };
        } else {
          yield { type: "text", text: "More evidence is required." };
        }
        attempt?.finish({ outcome: "completed", usage: ZERO_USAGE });
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const recorder = reportRecorderWithAgentRun();

    try {
      // When
      await collect(
        runAgentTurn({
          workspace,
          provider,
          ledger: sessionLedgerMirroringMessages(messages),
          systemPrompt: "You are helpful.",
          signal: new AbortController().signal,
          bash: { kind: "disabled" },
          stopPolicy: defaultStopPolicy(),
          sessionGoal: goal,
          modelOperations: {
            recorder,
            owner: { type: "current_agent_run" },
            provider: provider.id,
            model: "test-model",
            costModel: ZERO_COST_MODEL,
          },
        }),
      );

      // Then
      const accounting = accountModelOperations(recorder.modelOperations());
      expect(
        accounting.modelOperations.map((operation) => operation.purpose),
      ).toEqual(["agent_turn", "goal_assertion_evaluation", "agent_turn"]);
      expect(accounting.agentLoopTurns).toBe(2);
      expect(accounting.providerRequestAttemptCount).toBe(3);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given cost admission rejects before any upstream request,
    When the Agent tries its first model operation,
    Then the operation is admission-rejected with zero physical attempts and no retry`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-model-operation-"));
    let providerCalls = 0;
    const provider: LLMProvider = {
      id: "unaffordable-operation-provider",
      estimateInputTokens: () => 1_000_000,
      async *stream() {
        providerCalls++;
        yield { type: "text", text: "unexpected" };
      },
    };
    const costModel: CostModel = {
      type: "fixed",
      uncachedInputPerMillionTokens: 1,
      cachedInputPerMillionTokens: 1,
      outputPerMillionTokens: 1,
    };
    const recorder = reportRecorderWithAgentRun();

    try {
      // When
      await collect(
        runAgent({
          workspace,
          provider,
          userMessage: "Do not send this request",
          systemPrompt: "You are helpful.",
          signal: new AbortController().signal,
          bash: { kind: "disabled" },
          stopPolicy: defaultStopPolicy(),
          costTracking: { model: costModel, maxCostUsd: 0.01 },
          modelOperations: {
            recorder,
            owner: { type: "current_agent_run" },
            provider: provider.id,
            model: "expensive-model",
            costModel,
          },
        }),
      );

      // Then
      expect(providerCalls).toBe(0);
      const accounting = accountModelOperations(recorder.modelOperations());
      expect(accounting.modelOperations).toMatchObject([
        {
          purpose: "agent_turn",
          outcome: "admission_rejected",
          providerRequestAttempts: [],
        },
      ]);
      expect(accounting.providerRequestAttemptCount).toBe(0);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given DeepSeek rate-limits an admitted request and retry admission exceeds the remaining budget,
    When the Agent applies the provider retry policy,
    Then the run stops normally with the failed physical attempt instead of an invalid admission-rejected operation`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-model-operation-"));
    let physicalRequests = 0;
    const server = createServer((req, res) => {
      physicalRequests++;
      req.resume();
      req.on("end", () => {
        res.writeHead(429, {
          "Content-Type": "application/json",
          "retry-after-ms": "0",
        });
        res.end(JSON.stringify({ error: { message: "try again" } }));
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("local DeepSeek server has no TCP address");
    }
    const provider = createDeepseekProvider({
      apiKey: "test-key",
      baseUrl: `http://127.0.0.1:${address.port}`,
      model: "deepseek-v4-flash",
      retry: { maxRetries: 1, initialDelayMs: 0, maxDelayMs: 0 },
    });
    const costModel: CostModel = {
      type: "fixed",
      uncachedInputPerMillionTokens: 0,
      cachedInputPerMillionTokens: 0,
      outputPerMillionTokens: 1,
    };
    const recorder = reportRecorderWithAgentRun();

    try {
      // When
      const events = await collect(
        runAgent({
          workspace,
          provider,
          userMessage: "Retry only while the request remains affordable.",
          systemPrompt: "You are helpful.",
          signal: new AbortController().signal,
          bash: { kind: "disabled" },
          stopPolicy: defaultStopPolicy(),
          costTracking: {
            model: costModel,
            maxCostUsd: 0.0003,
            modelMaxOutputTokens: 256,
          },
          modelOperations: {
            recorder,
            owner: { type: "current_agent_run" },
            provider: provider.id,
            model: "deepseek-v4-flash",
            costModel,
          },
        }),
      );

      // Then
      expect(physicalRequests).toBe(1);
      expect(events.at(-1)).toMatchObject({
        type: "end",
        stopReason: "cost_budget",
      });
      const accounting = accountModelOperations(recorder.modelOperations());
      expect(accounting.modelOperations).toMatchObject([
        {
          purpose: "agent_turn",
          outcome: "terminal_error",
          providerRequestAttempts: [
            {
              outcome: "retryable_error",
              retryDecision: {
                reason: "provider_rate_limited",
                attempt: 1,
                maxRetries: 1,
              },
            },
          ],
        },
      ]);
      expect(accounting.providerRequestAttemptCount).toBe(1);
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given proactive compaction is required before an Agent request,
    When cost admission rejects the compaction request,
    Then the report records only the compaction operation and no phantom Agent turn`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-model-operation-"));
    const messages: SessionMessage[] = [
      { role: "user", content: `Investigate ${"old context ".repeat(500)}` },
      {
        role: "assistant",
        content: "Earlier investigation result.",
        toolCalls: [],
      },
      { role: "user", content: "Continue." },
    ];
    let providerCalls = 0;
    const provider: LLMProvider = {
      id: "unaffordable-compaction-provider",
      estimateInputTokens: () => 1_000_000,
      async *stream() {
        providerCalls++;
        yield { type: "text", text: "unexpected" };
      },
    };
    const costModel: CostModel = {
      type: "fixed",
      uncachedInputPerMillionTokens: 1,
      cachedInputPerMillionTokens: 1,
      outputPerMillionTokens: 1,
    };
    const recorder = reportRecorderWithAgentRun();

    try {
      // When
      await collect(
        runAgentTurn({
          workspace,
          provider,
          ledger: sessionLedgerMirroringMessages(messages),
          systemPrompt: "You are helpful.",
          signal: new AbortController().signal,
          bash: { kind: "disabled" },
          stopPolicy: defaultStopPolicy(),
          contextCompaction: {
            contextWindowTokens: 120,
            reserveTokens: 0,
            keepRecentTokens: 1,
          },
          costTracking: { model: costModel, maxCostUsd: 0.01 },
          modelOperations: {
            recorder,
            owner: { type: "current_agent_run" },
            provider: provider.id,
            model: "expensive-model",
            costModel,
          },
        }),
      );

      // Then
      expect(providerCalls).toBe(0);
      expect(recorder.modelOperations()).toMatchObject([
        {
          purpose: "context_compaction",
          outcome: "admission_rejected",
          providerRequestAttempts: [],
        },
      ]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given proactive compaction overflows once and its retry exceeds the remaining budget,
    When the Agent stops for the cost budget,
    Then the report preserves the overflow attempt without inventing an Agent turn`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-model-operation-"));
    const messages: SessionMessage[] = [
      { role: "user", content: `Investigate ${"old context ".repeat(500)}` },
      {
        role: "assistant",
        content: "Earlier investigation result.",
        toolCalls: [],
      },
      { role: "user", content: "Continue." },
    ];
    let physicalRequests = 0;
    const provider: LLMProvider = {
      id: "overflowing-compaction-retry",
      estimateInputTokens: () => 1,
      async *stream(options) {
        yield* [];
        physicalRequests++;
        const attempt = options.providerRequestAttempts?.begin();
        attempt?.finish({ outcome: "context_overflow" });
        throw new KeelError(
          "provider_context_overflow",
          "context length exceeded",
        );
      },
    };
    const costModel: CostModel = {
      type: "fixed",
      uncachedInputPerMillionTokens: 0,
      cachedInputPerMillionTokens: 0,
      outputPerMillionTokens: 1,
    };
    const recorder = reportRecorderWithAgentRun();

    try {
      // When
      const events = await collect(
        runAgentTurn({
          workspace,
          provider,
          ledger: sessionLedgerMirroringMessages(messages),
          systemPrompt: "You are helpful.",
          signal: new AbortController().signal,
          bash: { kind: "disabled" },
          stopPolicy: defaultStopPolicy(),
          contextCompaction: {
            contextWindowTokens: 1_000,
            reserveTokens: 0,
            keepRecentTokens: 1,
            summaryInputMaxChars: 4_000,
          },
          costTracking: {
            model: costModel,
            maxCostUsd: 0.0003,
            modelMaxOutputTokens: 256,
          },
          modelOperations: {
            recorder,
            owner: { type: "current_agent_run" },
            provider: provider.id,
            model: "test-model",
            costModel,
          },
        }),
      );

      // Then
      expect(physicalRequests).toBe(1);
      expect(events.at(-1)).toMatchObject({
        type: "end",
        stopReason: "cost_budget",
      });
      expect(recorder.modelOperations()).toMatchObject([
        {
          purpose: "context_compaction",
          outcome: "context_overflow",
          providerRequestAttempts: [
            { outcome: "context_overflow", recoveryOperationOrdinal: null },
          ],
        },
      ]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an admitted Agent request is aborted upstream,
    When the Agent surfaces the provider abort,
    Then the report records both the logical operation and physical attempt as aborted`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-model-operation-"));
    const provider: LLMProvider = {
      id: "aborted-operation-provider",
      async *stream(options) {
        yield* [];
        const attempt = options.providerRequestAttempts?.begin();
        attempt?.finish({ outcome: "aborted" });
        throw new KeelError("provider_aborted", "request aborted");
      },
    };
    const recorder = reportRecorderWithAgentRun();

    try {
      // When / Then
      await expect(
        collect(
          runAgent({
            workspace,
            provider,
            userMessage: "Stop the request.",
            systemPrompt: "You are helpful.",
            signal: new AbortController().signal,
            bash: { kind: "disabled" },
            stopPolicy: defaultStopPolicy(),
            modelOperations: {
              recorder,
              owner: { type: "current_agent_run" },
              provider: provider.id,
              model: "test-model",
              costModel: ZERO_COST_MODEL,
            },
          }),
        ),
      ).rejects.toMatchObject({ code: "provider_aborted" });
      expect(recorder.modelOperations()).toMatchObject([
        {
          purpose: "agent_turn",
          outcome: "aborted",
          providerRequestAttempts: [{ outcome: "aborted" }],
        },
      ]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an Agent provider throws an unexpected runtime error,
    When the model operation fails before a physical request is reported,
    Then the report records a terminal failure and preserves the original error`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-model-operation-"));
    const unexpectedError = new Error("unexpected provider implementation bug");
    const provider: LLMProvider = {
      id: "unexpected-error-provider",
      async *stream() {
        yield* [];
        throw unexpectedError;
      },
    };
    const recorder = reportRecorderWithAgentRun();

    try {
      // When / Then
      await expect(
        collect(
          runAgent({
            workspace,
            provider,
            userMessage: "Run the model request.",
            systemPrompt: "You are helpful.",
            signal: new AbortController().signal,
            bash: { kind: "disabled" },
            stopPolicy: defaultStopPolicy(),
            modelOperations: {
              recorder,
              owner: { type: "current_agent_run" },
              provider: provider.id,
              model: "test-model",
              costModel: ZERO_COST_MODEL,
            },
          }),
        ),
      ).rejects.toBe(unexpectedError);
      expect(recorder.modelOperations()).toMatchObject([
        {
          purpose: "agent_turn",
          outcome: "terminal_error",
          providerRequestAttempts: [],
        },
      ]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given compaction receives a forbidden tool call,
    When the consumer rejects the provider output before its stop event,
    Then the attempt is finalized and the original protocol error is preserved`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-model-operation-"));
    const recorder = reportRecorderWithAgentRun();
    const provider = createFakeProvider([
      fakeToolResponse("read", { path: "unexpected.txt" }),
    ]);
    const messages: SessionMessage[] = [
      { role: "user", content: `Investigate ${"history ".repeat(500)}` },
      {
        role: "assistant",
        content: "Earlier investigation result.",
        toolCalls: [],
      },
      { role: "user", content: "Continue." },
    ];

    try {
      // When / Then
      await expect(
        collect(
          runAgentTurn({
            workspace,
            provider,
            ledger: sessionLedgerMirroringMessages(messages),
            systemPrompt: "You are helpful.",
            signal: new AbortController().signal,
            bash: { kind: "disabled" },
            stopPolicy: defaultStopPolicy(),
            contextCompaction: {
              contextWindowTokens: 120,
              reserveTokens: 0,
              keepRecentTokens: 1,
            },
            modelOperations: {
              recorder,
              owner: { type: "current_agent_run" },
              provider: provider.id,
              model: "fake",
              costModel: ZERO_COST_MODEL,
            },
          }),
        ),
      ).rejects.toMatchObject({ code: "provider_protocol_error" });
      expect(recorder.modelOperations()).toMatchObject([
        {
          purpose: "context_compaction",
          outcome: "terminal_error",
          providerRequestAttempts: [{ outcome: "terminal_error" }],
        },
      ]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given DeepSeek completes a physical request with usage and a forbidden compaction tool call,
    When the logical operation ends with a protocol error,
    Then root accounting still includes the billed attempt usage and cost`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-model-operation-"));
    const usage: Usage = {
      inputTokens: 10,
      cachedInputTokens: 2,
      uncachedInputTokens: 8,
      outputTokens: 3,
    };
    const costModel: CostModel = {
      type: "fixed",
      uncachedInputPerMillionTokens: 1,
      cachedInputPerMillionTokens: 1,
      outputPerMillionTokens: 1,
    };
    let physicalRequests = 0;
    const server = createServer((req, res) => {
      physicalRequests++;
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.end(
          [
            `data: ${JSON.stringify({
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: "forbidden_compaction_tool",
                        function: {
                          name: "read",
                          arguments: JSON.stringify({
                            path: "unexpected.txt",
                          }),
                        },
                      },
                    ],
                  },
                },
              ],
            })}`,
            "",
            `data: ${JSON.stringify({
              choices: [{ delta: {}, finish_reason: "tool_calls" }],
              usage: {
                prompt_tokens: usage.inputTokens,
                prompt_cache_hit_tokens: usage.cachedInputTokens,
                prompt_cache_miss_tokens: usage.uncachedInputTokens,
                completion_tokens: usage.outputTokens,
              },
            })}`,
            "",
            "data: [DONE]",
            "",
          ].join("\n"),
        );
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("local DeepSeek server has no TCP address");
    }
    const provider = createDeepseekProvider({
      apiKey: "test-key",
      baseUrl: `http://127.0.0.1:${address.port}`,
      model: "deepseek-v4-flash",
      retry: { maxRetries: 0 },
    });
    const recorder = reportRecorderWithAgentRun();
    const messages: SessionMessage[] = [
      { role: "user", content: `Investigate ${"history ".repeat(500)}` },
      {
        role: "assistant",
        content: "Earlier investigation result.",
        toolCalls: [],
      },
      { role: "user", content: "Continue." },
    ];

    try {
      // When
      await expect(
        collect(
          runAgentTurn({
            workspace,
            provider,
            ledger: sessionLedgerMirroringMessages(messages),
            systemPrompt: "You are helpful.",
            signal: new AbortController().signal,
            bash: { kind: "disabled" },
            stopPolicy: defaultStopPolicy(),
            contextCompaction: {
              contextWindowTokens: 120,
              reserveTokens: 0,
              keepRecentTokens: 1,
            },
            modelOperations: {
              recorder,
              owner: { type: "current_agent_run" },
              provider: provider.id,
              model: "test-model",
              costModel,
            },
          }),
        ),
      ).rejects.toMatchObject({ code: "provider_protocol_error" });

      // Then
      const accounting = accountModelOperations(recorder.modelOperations());
      expect(accounting.modelOperations).toMatchObject([
        {
          purpose: "context_compaction",
          outcome: "terminal_error",
          usage,
          providerRequestAttempts: [{ outcome: "completed", usage }],
        },
      ]);
      expect(accounting.usage).toEqual(usage);
      expect(accounting.costUsd).toBeGreaterThan(0);
      expect(physicalRequests).toBe(1);
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an Agent request overflows after one admitted physical attempt,
    When the recovery compaction is rejected by cost admission,
    Then the original operation remains context-overflow and only recovery is admission-rejected`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-model-operation-"));
    const messages: SessionMessage[] = [
      { role: "user", content: "Preserve the earlier investigation." },
      {
        role: "assistant",
        content: "Earlier investigation result.",
        toolCalls: [],
      },
      { role: "user", content: "Continue." },
    ];
    let providerCalls = 0;
    const provider: LLMProvider = {
      id: "overflow-before-recovery-admission",
      estimateInputTokens: () => 1,
      async *stream(options) {
        providerCalls++;
        if (providerCalls > 1) {
          yield { type: "text", text: "unexpected second provider call" };
        }
        const attempt = options.providerRequestAttempts?.begin();
        attempt?.finish({ outcome: "context_overflow" });
        throw new KeelError(
          "provider_context_overflow",
          "context length exceeded",
        );
      },
    };
    const costModel: CostModel = {
      type: "fixed",
      uncachedInputPerMillionTokens: 0,
      cachedInputPerMillionTokens: 0,
      outputPerMillionTokens: 1,
    };
    const recorder = reportRecorderWithAgentRun();

    try {
      // When
      await collect(
        runAgentTurn({
          workspace,
          provider,
          ledger: sessionLedgerMirroringMessages(messages),
          systemPrompt: "You are helpful.",
          signal: new AbortController().signal,
          bash: { kind: "disabled" },
          stopPolicy: defaultStopPolicy(),
          contextCompaction: {
            contextWindowTokens: 100_000,
            reserveTokens: 0,
            keepRecentTokens: 1,
          },
          costTracking: { model: costModel, maxCostUsd: 0.0003 },
          modelOperations: {
            recorder,
            owner: { type: "current_agent_run" },
            provider: provider.id,
            model: "test-model",
            costModel,
          },
        }),
      );

      // Then
      expect(providerCalls).toBe(1);
      expect(recorder.modelOperations()).toMatchObject([
        {
          purpose: "agent_turn",
          outcome: "context_overflow",
          providerRequestAttempts: [
            { outcome: "context_overflow", recoveryOperationOrdinal: 2 },
          ],
        },
        {
          purpose: "context_compaction",
          outcome: "admission_rejected",
          providerRequestAttempts: [],
        },
      ]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
