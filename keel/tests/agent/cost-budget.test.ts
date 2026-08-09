import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  CostBudgetAdmissionError,
  createCostBudgetedProvider,
  createSharedCostBudgetedProvider,
} from "../../src/agent/cost-budget.ts";
import { runAgent, runAgentTurn } from "../../src/agent/loop.ts";
import type { SessionMessage } from "../../src/agent/session-message.ts";
import {
  defaultStopPolicy,
  maxTurnFallbackPolicy,
} from "../../src/agent/stop-policy.ts";
import {
  type CostModel,
  calculateConservativeRequestCostUsd,
  maxAffordableOutputTokens,
} from "../../src/core/cost.ts";
import type { SessionGoal } from "../../src/core/session-goal.ts";
import type {
  LLMProvider,
  StreamOptions,
  ToolCall,
} from "../../src/llm/types.ts";
import { sessionLedgerMirroringMessages } from "../../src/testing/session-ledger-fixtures.ts";
import { createDelegationExecutor } from "../../src/tools/delegation.ts";

async function collect<Event>(source: AsyncIterable<Event>): Promise<Event[]> {
  const events: Event[] = [];
  for await (const event of source) {
    events.push(event);
  }
  return events;
}

function freshSignal(): AbortSignal {
  return new AbortController().signal;
}

const budgetModel: CostModel = {
  type: "fixed",
  uncachedInputPerMillionTokens: 1,
  cachedInputPerMillionTokens: 0.5,
  outputPerMillionTokens: 2,
};

const tieredBudgetModel: CostModel = {
  type: "input-token-tiers",
  tiers: [
    {
      startsAboveInputTokens: 0,
      uncachedInputPerMillionTokens: 0.4,
      cachedInputPerMillionTokens: 0.04,
      outputPerMillionTokens: 1.6,
    },
    {
      startsAboveInputTokens: 256_000,
      uncachedInputPerMillionTokens: 1.2,
      cachedInputPerMillionTokens: 0.12,
      outputPerMillionTokens: 4.8,
    },
  ],
};

describe("Cost Budget", () => {
  test(`Given two child provider attempts reserve the shared root budget concurrently,
    When they complete out of order,
    Then each attempt releases only its own reservation without leaking or overselling budget`, async () => {
    const bothStarted = Promise.withResolvers<void>();
    const releaseFirst = Promise.withResolvers<void>();
    const releaseSecond = Promise.withResolvers<void>();
    let started = 0;
    const usage = {
      inputTokens: 100,
      cachedInputTokens: 0,
      uncachedInputTokens: 100,
      outputTokens: 10,
    } as const;
    const underlying: LLMProvider = {
      id: "concurrent-root-budget",
      estimateInputTokens: () => 100,
      async *stream(options) {
        const index = started++;
        const attempt = options.providerRequestAttempts?.begin();
        if (started === 2) bothStarted.resolve();
        await bothStarted.promise;
        await (index === 0 ? releaseFirst.promise : releaseSecond.promise);
        attempt?.finish({ outcome: "completed", usage });
        yield { type: "stop", reason: "stop", usage };
      },
    };
    const root = createSharedCostBudgetedProvider({
      provider: underlying,
      model: budgetModel,
      maxCostUsd: 1,
    });
    const first = collect(
      root.provider.stream({
        systemPrompt: "first child",
        messages: [],
        signal: freshSignal(),
        maxOutputTokens: 256,
      }),
    );
    const second = collect(
      root.provider.stream({
        systemPrompt: "second child",
        messages: [],
        signal: freshSignal(),
        maxOutputTokens: 256,
      }),
    );

    await bothStarted.promise;
    releaseSecond.resolve();
    await Promise.resolve();
    releaseFirst.resolve();
    await Promise.all([first, second]);

    expect(root.observedSpendUsd()).toBeCloseTo(0.00024, 10);
    expect(root.remainingUsd()).toBeCloseTo(0.99976, 10);
    expect(root.observedUsage()).toEqual({
      inputTokens: 200,
      cachedInputTokens: 0,
      uncachedInputTokens: 200,
      outputTokens: 20,
    });
  });

  test(`Given delegate is emitted beside another tool call,
    When the host executes the tool round,
    Then it rejects delegation before child work because the continuation shape is not isolated`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-delegate-isolation-"));
    await writeFile(join(workspace, "note.txt"), "evidence\n", "utf8");
    let providerCalls = 0;
    let childCalls = 0;
    let transcript: readonly SessionMessage[] = [];
    const provider: LLMProvider = {
      id: "delegate-isolation",
      async *stream() {
        providerCalls++;
        if (providerCalls === 1) {
          yield {
            type: "tool_call",
            id: "delegate-call",
            tool: "delegate",
            task: "Inspect the note independently.",
          };
          yield {
            type: "tool_call",
            id: "read-call",
            tool: "read",
            path: "note.txt",
          };
        } else {
          yield { type: "text", text: "done" };
        }
        yield {
          type: "stop",
          reason: "stop",
          usage: {
            inputTokens: 100,
            cachedInputTokens: 0,
            uncachedInputTokens: 100,
            outputTokens: 10,
          },
        };
      },
    };

    try {
      await collect(
        runAgent({
          workspace,
          provider,
          userMessage: "Use a subagent to inspect the note.",
          systemPrompt: "You are helpful.",
          signal: freshSignal(),
          bash: { kind: "disabled" },
          stopPolicy: defaultStopPolicy(),
          delegation: {
            available: () => true,
            prepareBatch: () => ({
              close: () => {},
              executor: createDelegationExecutor(async () => {
                childCalls++;
                return {
                  delivery: "fresh",
                  ok: true,
                  content: "unexpected child result",
                  usage: {
                    inputTokens: 1,
                    cachedInputTokens: 0,
                    uncachedInputTokens: 1,
                    outputTokens: 1,
                  },
                };
              }),
            }),
            delegate: async () => {
              childCalls++;
              return {
                delivery: "fresh",
                ok: true,
                content: "unexpected child result",
                usage: {
                  inputTokens: 1,
                  cachedInputTokens: 0,
                  uncachedInputTokens: 1,
                  outputTokens: 1,
                },
              };
            },
          },
          onTranscriptReady: (messages) => {
            transcript = messages;
          },
        }),
      );

      expect(childCalls).toBe(0);
      expect(transcript).toContainEqual(
        expect.objectContaining({
          role: "tool",
          toolCallId: "delegate-call",
          content: expect.stringContaining(
            "delegate calls may share a tool round only with other delegate calls",
          ),
        }),
      );
      expect(transcript).toContainEqual(
        expect.objectContaining({
          role: "tool",
          toolCallId: "read-call",
          content: expect.stringContaining("evidence"),
        }),
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a child lease wraps the shared root cost budget,
    When both layers calculate an affordable output ceiling,
    Then the outer root wrapper preserves the smaller child ceiling`, async () => {
    let receivedMaxOutputTokens: number | undefined;
    const underlying: LLMProvider = {
      id: "nested-budget",
      estimateInputTokens: () => 100,
      async *stream(options) {
        receivedMaxOutputTokens = options.maxOutputTokens;
        yield { type: "text", text: "done" };
      },
    };
    const root = createSharedCostBudgetedProvider({
      provider: underlying,
      model: budgetModel,
      maxCostUsd: 1,
    });
    const child = createCostBudgetedProvider({
      provider: root.provider,
      model: budgetModel,
      maxCostUsd: 0.5,
    });

    for await (const _event of child.stream({
      systemPrompt: "bounded",
      messages: [],
      signal: freshSignal(),
    })) {
      // Consume the provider stream so both admission layers run.
    }

    expect(receivedMaxOutputTokens).toBe(
      maxAffordableOutputTokens({
        remainingUsd: 0.5,
        inputTokens: 100,
        model: budgetModel,
      }),
    );
  });

  test(`Given a child lease wraps the shared root budget and an attempt settles without usage,
    When the outer wrapper retains a conservative reservation for uncertain spend,
    Then it reserves only the child's admitted ceiling and preserves main synthesis budget`, async () => {
    const underlying: LLMProvider = {
      id: "nested-abnormal-budget",
      estimateInputTokens: () => 100,
      async *stream(options) {
        yield { type: "text", text: "request started" };
        options.providerRequestAttempts?.begin().finish({
          outcome: "terminal_error",
          errorCode: "provider_network_error",
        });
        throw new Error("provider failed after request admission");
      },
    };
    const root = createSharedCostBudgetedProvider({
      provider: underlying,
      model: budgetModel,
      maxCostUsd: 1,
    });
    const child = createCostBudgetedProvider({
      provider: root.provider,
      model: budgetModel,
      maxCostUsd: 0.5,
    });

    await expect(async () => {
      for await (const _event of child.stream({
        systemPrompt: "bounded abnormal attempt",
        messages: [],
        signal: freshSignal(),
      })) {
        // Consume the provider stream so both admission layers run.
      }
    }).rejects.toThrow("provider failed after request admission");

    expect(root.remainingUsd()).toBeGreaterThanOrEqual(0.5);
  });

  test(`Given a completed main request and a bounded non-ASCII tool result,
    When host leases the continuation before running a child,
    Then the provider estimator prices the assistant and tool envelopes so the next main request is admitted`, async () => {
    let providerCalls = 0;
    const toolCall: Extract<ToolCall, { readonly tool: "delegate" }> = {
      id: "delegate-call",
      tool: "delegate",
      task: "Inspect the workspace.",
    };
    const reasoningContent = "我会委派这个调查。";
    const initialMessages = [
      { role: "user", content: "使用 subagent 调研这个任务。" },
    ] as const;
    const childMessages = [
      { role: "user", content: "Inspect the workspace." },
    ] as const;
    const toolResultMessage = {
      role: "tool",
      toolCallId: toolCall.id,
      content: "\u0800".repeat(1_000),
    } as const;
    const inputEstimate = (
      options: Parameters<LLMProvider["stream"]>[0],
    ): number =>
      new TextEncoder().encode(
        JSON.stringify({
          systemPrompt: options.systemPrompt,
          messages: options.messages,
          toolExposure: options.toolExposure,
          maxOutputTokens: options.maxOutputTokens,
        }),
      ).length;
    const underlying: LLMProvider = {
      id: "continuation-lease",
      estimateInputTokens: inputEstimate,
      async *stream(options) {
        providerCalls++;
        if (providerCalls === 1) {
          yield { type: "reasoning", text: reasoningContent };
          yield { type: "tool_call", ...toolCall };
        } else yield { type: "text", text: "done" };
        const inputTokens = inputEstimate(options);
        const outputTokens =
          providerCalls === 1 ? 1 : providerCalls === 2 ? 256 : 100;
        const usage = {
          inputTokens,
          cachedInputTokens: 0,
          uncachedInputTokens: inputTokens,
          outputTokens,
        };
        options.providerRequestAttempts
          ?.begin()
          .finish({ outcome: "completed", usage });
        yield { type: "stop", reason: "stop", usage };
      },
    };
    const baselineOptions: StreamOptions = {
      systemPrompt: "main",
      messages: initialMessages,
      signal: freshSignal(),
      toolExposure: { kind: "auto", delegation: true } as const,
    };
    const childOptions: StreamOptions = {
      systemPrompt: "child",
      messages: childMessages,
      signal: freshSignal(),
      toolExposure: { kind: "auto", profile: "read-only-subagent" } as const,
    };
    const continuationOptions: StreamOptions = {
      ...baselineOptions,
      messages: [
        ...initialMessages,
        {
          role: "assistant",
          content: "",
          toolCalls: [toolCall],
          providerMetadata: {
            openaiCompatible: { reasoningContent },
          },
        } as const,
        toolResultMessage,
      ],
      maxOutputTokens: 256,
    };
    const baselineInputTokens = inputEstimate({
      ...baselineOptions,
      maxOutputTokens: 256,
    });
    const childInputTokens = inputEstimate({
      ...childOptions,
      maxOutputTokens: 256,
    });
    const continuationInputTokens = inputEstimate(continuationOptions);
    const maxCostUsd =
      (baselineInputTokens +
        2 +
        childInputTokens +
        2 * 256 +
        continuationInputTokens +
        2 * 256 +
        10) /
      1_000_000;
    const root = createSharedCostBudgetedProvider({
      provider: underlying,
      model: budgetModel,
      maxCostUsd,
      modelMaxOutputTokens: 256,
    });

    for await (const _event of root.provider.stream(baselineOptions)) {
      // Establish the root request baseline used by the lease estimator.
    }
    const lease = root.leaseContinuation({
      additionalMessages: [toolResultMessage],
      maxOutputTokens: 256,
      minimumAdditionalRequestCostUsd: calculateConservativeRequestCostUsd(
        childInputTokens,
        256,
        budgetModel,
      ),
    });
    expect(lease).toMatchObject({
      kind: "granted",
      estimatedContinuationInputTokens: continuationInputTokens,
    });
    if (lease.kind !== "granted") throw new Error("lease was not granted");
    expect(
      root.leaseContinuation({
        additionalMessages: [toolResultMessage],
        maxOutputTokens: 256,
        minimumAdditionalRequestCostUsd: calculateConservativeRequestCostUsd(
          childInputTokens,
          256,
          budgetModel,
        ),
      }),
    ).toEqual({ kind: "rejected", reason: "active_lease" });
    await expect(
      (async () => {
        for await (const _event of root.provider.stream({
          ...childOptions,
          systemPrompt: "\u0800".repeat(1_000),
        })) {
          // A request outside the child cap cannot borrow the held main lease.
        }
      })(),
    ).rejects.toBeInstanceOf(CostBudgetAdmissionError);
    const child = createCostBudgetedProvider({
      provider: root.provider,
      model: budgetModel,
      maxCostUsd: lease.additionalRequestBudgetUsd,
      modelMaxOutputTokens: 256,
    });

    for await (const _event of child.stream(childOptions)) {
      // Child uses the residual budget only.
    }
    expect(root.remainingUsd()).toBeGreaterThanOrEqual(0);
    lease.release();
    expect(root.remainingUsd()).toBeGreaterThanOrEqual(lease.reservedUsd);

    await expect(
      (async () => {
        for await (const _event of root.provider.stream(continuationOptions)) {
          // The leased main continuation is now admitted on the root provider.
        }
      })(),
    ).resolves.toBeUndefined();
    expect(providerCalls).toBe(3);
  });

  test(`Given no baseline, an invalid continuation estimate, or insufficient remaining budget,
    When host asks for a continuation lease,
    Then the typed lease result rejects before child work can start`, async () => {
    const underlying: LLMProvider = {
      id: "rejected-continuation-lease",
      estimateInputTokens: () => 100,
      async *stream(options) {
        const usage = {
          inputTokens: 900,
          cachedInputTokens: 0,
          uncachedInputTokens: 900,
          outputTokens: 0,
        };
        options.providerRequestAttempts
          ?.begin()
          .finish({ outcome: "completed", usage });
        yield { type: "stop", reason: "stop", usage };
      },
    };
    const root = createSharedCostBudgetedProvider({
      provider: underlying,
      model: budgetModel,
      maxCostUsd: 0.001,
    });
    const invalidEstimateRoot = createSharedCostBudgetedProvider({
      provider: {
        ...underlying,
        estimateInputTokens: (options) =>
          options.messages.some((message) => message.role === "tool")
            ? Number.NaN
            : 100,
      },
      model: budgetModel,
      maxCostUsd: 0.01,
    });
    let invalidFinalShapeProviderCalls = 0;
    const invalidFinalShapeRoot = createSharedCostBudgetedProvider({
      provider: {
        ...underlying,
        estimateInputTokens: (options) =>
          options.maxOutputTokens === undefined ? 100 : Number.NaN,
        async *stream() {
          invalidFinalShapeProviderCalls++;
          yield { type: "text", text: "unexpected" };
        },
      },
      model: budgetModel,
      maxCostUsd: 0.01,
    });
    const request = {
      additionalMessages: [
        { role: "tool", toolCallId: "delegate-call", content: "result" },
      ],
      maxOutputTokens: 256,
      minimumAdditionalRequestCostUsd: calculateConservativeRequestCostUsd(
        100,
        256,
        budgetModel,
      ),
    } as const;

    expect(root.leaseContinuation(request)).toEqual({
      kind: "rejected",
      reason: "missing_baseline",
    });
    for await (const _event of invalidEstimateRoot.provider.stream({
      systemPrompt: "valid baseline",
      messages: [],
      signal: freshSignal(),
    })) {
      // Establish a valid baseline before the provider rejects the full shape.
    }
    expect(invalidEstimateRoot.leaseContinuation(request)).toEqual({
      kind: "rejected",
      reason: "invalid_estimate",
    });
    await expect(
      (async () => {
        for await (const _event of invalidFinalShapeRoot.provider.stream({
          systemPrompt: "initial estimate is valid",
          messages: [],
          signal: freshSignal(),
        })) {
          // The final provider shape must be rejected before transport starts.
        }
      })(),
    ).rejects.toMatchObject({ estimatedInputTokens: null });
    expect(invalidFinalShapeProviderCalls).toBe(0);
    for await (const _event of root.provider.stream({
      systemPrompt: "spend baseline",
      messages: [],
      signal: freshSignal(),
    })) {
      // Leave too little capacity for both leases.
    }
    expect(root.leaseContinuation(request)).toEqual({
      kind: "rejected",
      reason: "insufficient_budget",
    });
  });

  test(`Given the conservative input cost cannot fit the session budget,
    When the agent prepares its first model turn,
    Then it stops without calling the provider`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cost-budget-"));
    let providerCalls = 0;
    const provider: LLMProvider = {
      id: "unaffordable-request",
      estimateInputTokens: () => 1_000_000,
      async *stream() {
        providerCalls++;
        yield { type: "text", text: "unexpected" };
        yield {
          type: "stop",
          reason: "stop",
          usage: {
            inputTokens: 1,
            cachedInputTokens: 0,
            uncachedInputTokens: 1,
            outputTokens: 1,
          },
        };
      },
    };

    try {
      // When
      const events = await collect(
        runAgent({
          workspace,
          provider,
          userMessage: "do not overspend",
          systemPrompt: "You are helpful.",
          signal: freshSignal(),
          bash: { kind: "disabled" },
          stopPolicy: defaultStopPolicy(),
          costTracking: { model: budgetModel, maxCostUsd: 0.5 },
        }),
      );

      // Then
      expect(providerCalls).toBe(0);
      expect(events).toContainEqual({
        type: "end",
        usage: {
          inputTokens: 0,
          cachedInputTokens: 0,
          uncachedInputTokens: 0,
          outputTokens: 0,
        },
        turns: 0,
        stopReason: "cost_budget",
        cost: {
          spentUsd: 0,
          budget: {
            kind: "budget_limited",
            maxUsd: 0.5,
            overshootUsd: 0,
          },
        },
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a provider returns an invalid input estimate,
    When the agent prepares a model turn,
    Then admission fails closed without calling the provider`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cost-budget-"));
    let providerCalls = 0;
    const provider: LLMProvider = {
      id: "invalid-estimate",
      estimateInputTokens: () => Number.NaN,
      async *stream() {
        providerCalls++;
        yield { type: "text", text: "unexpected" };
      },
    };

    try {
      // When
      const events = await collect(
        runAgent({
          workspace,
          provider,
          userMessage: "do not send",
          systemPrompt: "You are helpful.",
          signal: freshSignal(),
          bash: { kind: "disabled" },
          stopPolicy: defaultStopPolicy(),
          costTracking: { model: budgetModel, maxCostUsd: 1 },
        }),
      );

      // Then
      expect(providerCalls).toBe(0);
      expect(events.at(-1)).toMatchObject({
        type: "end",
        turns: 0,
        stopReason: "cost_budget",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given one physical request attempt reserves the affordable allowance,
    When the provider tries a second physical attempt without reported usage,
    Then the retry is suppressed before another provider request`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cost-budget-"));
    let physicalRequests = 0;
    const provider: LLMProvider = {
      id: "ambiguous-retry-spend",
      estimateInputTokens: () => 1,
      async *stream(options) {
        const firstAttempt = options.providerRequestAttempts?.begin();
        physicalRequests++;
        firstAttempt?.finish({
          outcome: "retryable_error",
          retryDecision: {
            provider: "ambiguous-retry-spend",
            reason: "provider_network_error",
            attempt: 1,
            maxRetries: 1,
            delayMs: 0,
          },
        });
        options.providerRequestAttempts?.begin();
        physicalRequests++;
        yield { type: "text", text: "unexpected retry" };
      },
    };

    try {
      // When
      const events = await collect(
        runAgent({
          workspace,
          provider,
          userMessage: "retry conservatively",
          systemPrompt: "You are helpful.",
          signal: freshSignal(),
          bash: { kind: "disabled" },
          stopPolicy: defaultStopPolicy(),
          costTracking: { model: budgetModel, maxCostUsd: 0.001 },
        }),
      );

      // Then
      expect(physicalRequests).toBe(1);
      expect(events.at(-1)).toMatchObject({
        type: "end",
        turns: 0,
        stopReason: "cost_budget",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an assertion completion turn leaves too little budget for its evaluator,
    When update_goal requests the fresh AI judgment,
    Then Keel stops for the budget without calling the evaluator or completing the goal`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cost-budget-"));
    const messages: SessionMessage[] = [
      { role: "user", content: "Complete the assertion goal." },
    ];
    const sessionGoal: SessionGoal = {
      objective: "Complete the assertion goal",
      status: "active",
      budget: {},
      usage: { turns: 0, tokens: 0, activeTimeMs: 0 },
      completion: {
        kind: "assertion",
        assertion: "The work is demonstrably complete.",
      },
    };
    let providerCalls = 0;
    const provider: LLMProvider = {
      id: "unaffordable-assertion-evaluator",
      estimateInputTokens: () => 1,
      async *stream(options) {
        const attempt = options.providerRequestAttempts?.begin();
        providerCalls++;
        yield {
          type: "tool_call",
          id: "complete_goal",
          tool: "update_goal",
          status: "completed",
        };
        const usage = {
          inputTokens: 499_800,
          cachedInputTokens: 0,
          uncachedInputTokens: 499_800,
          outputTokens: 0,
        };
        attempt?.finish({ outcome: "completed", usage });
        yield {
          type: "stop",
          reason: "stop",
          usage,
        };
      },
    };

    try {
      // When
      const events = await collect(
        runAgentTurn({
          workspace,
          provider,
          ledger: sessionLedgerMirroringMessages(messages),
          systemPrompt: "You are helpful.",
          signal: freshSignal(),
          bash: { kind: "disabled" },
          stopPolicy: defaultStopPolicy(),
          sessionGoal,
          costTracking: { model: budgetModel, maxCostUsd: 0.5 },
        }),
      );

      // Then
      expect(providerCalls).toBe(1);
      expect(events).not.toContainEqual(
        expect.objectContaining({ type: "session_goal_updated" }),
      );
      expect(events).not.toContainEqual(
        expect.objectContaining({ type: "tool_end" }),
      );
      expect(messages.at(-1)).toEqual({
        role: "tool",
        toolCallId: "complete_goal",
        content:
          "Goal completion was not evaluated because the remaining session cost budget could not admit the assertion evaluator request.",
      });
      expect(events.at(-1)).toMatchObject({
        type: "end",
        turns: 1,
        stopReason: "cost_budget",
        cost: {
          spentUsd: 0.4998,
          budget: { kind: "budget_limited", overshootUsd: 0 },
        },
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a request fits only with a bounded completion,
    When the agent sends the request,
    Then the provider receives the affordable model output limit`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cost-budget-"));
    let receivedMaxOutputTokens: number | undefined;
    const provider: LLMProvider = {
      id: "bounded-output",
      estimateInputTokens: () => 100,
      async *stream(options) {
        receivedMaxOutputTokens = options.maxOutputTokens;
        yield { type: "text", text: "done" };
        yield {
          type: "stop",
          reason: "stop",
          usage: {
            inputTokens: 100,
            cachedInputTokens: 0,
            uncachedInputTokens: 100,
            outputTokens: 1,
          },
        };
      },
    };

    try {
      // When
      await collect(
        runAgent({
          workspace,
          provider,
          userMessage: "stay bounded",
          systemPrompt: "You are helpful.",
          signal: freshSignal(),
          bash: { kind: "disabled" },
          stopPolicy: defaultStopPolicy(),
          costTracking: {
            model: budgetModel,
            maxCostUsd: 0.001,
            modelMaxOutputTokens: 300,
          },
        }),
      );

      // Then
      expect(receivedMaxOutputTokens).toBe(300);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a provider response exactly exhausts the cost budget,
    When it proposes work that would require another turn,
    Then the agent sends no additional provider request`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cost-budget-"));
    let providerCalls = 0;
    const provider: LLMProvider = {
      id: "exact-budget",
      estimateInputTokens: () => 1,
      async *stream() {
        providerCalls++;
        yield {
          type: "tool_call",
          id: "read_note",
          tool: "read",
          path: "note.txt",
        };
        yield {
          type: "stop",
          reason: "stop",
          usage: {
            inputTokens: 500_000,
            cachedInputTokens: 0,
            uncachedInputTokens: 500_000,
            outputTokens: 0,
          },
        };
      },
    };

    try {
      // When
      const events = await collect(
        runAgent({
          workspace,
          provider,
          userMessage: "read note",
          systemPrompt: "You are helpful.",
          signal: freshSignal(),
          bash: { kind: "disabled" },
          stopPolicy: defaultStopPolicy(),
          costTracking: { model: budgetModel, maxCostUsd: 0.5 },
        }),
      );

      // Then
      expect(providerCalls).toBe(1);
      expect(events.at(-1)).toMatchObject({
        type: "end",
        turns: 1,
        stopReason: "cost_budget",
        cost: {
          spentUsd: 0.5,
          budget: { kind: "budget_limited", overshootUsd: 0 },
        },
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the first turn leaves too little budget for a required wrap-up,
    When the turn fallback requests a summary,
    Then the agent stops without sending the wrap-up request`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cost-budget-"));
    let providerCalls = 0;
    const provider: LLMProvider = {
      id: "unaffordable-wrap-up",
      estimateInputTokens: () => 1,
      async *stream(options) {
        const attempt = options.providerRequestAttempts?.begin();
        providerCalls++;
        yield {
          type: "tool_call",
          id: "read_note",
          tool: "read",
          path: "note.txt",
        };
        const usage = {
          inputTokens: 499_800,
          cachedInputTokens: 0,
          uncachedInputTokens: 499_800,
          outputTokens: 0,
        };
        attempt?.finish({ outcome: "completed", usage });
        yield {
          type: "stop",
          reason: "stop",
          usage,
        };
      },
    };

    try {
      // When
      const events = await collect(
        runAgent({
          workspace,
          provider,
          userMessage: "read note",
          systemPrompt: "You are helpful.",
          signal: freshSignal(),
          bash: { kind: "disabled" },
          stopPolicy: maxTurnFallbackPolicy(1),
          costTracking: { model: budgetModel, maxCostUsd: 0.5 },
        }),
      );

      // Then
      expect(providerCalls).toBe(1);
      expect(events.at(-1)).toMatchObject({
        type: "end",
        turns: 1,
        stopReason: "cost_budget",
        cost: {
          spentUsd: 0.4998,
          budget: { kind: "budget_limited", overshootUsd: 0 },
        },
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a provider fails while generating an affordable wrap-up,
    When the turn fallback requests that summary,
    Then Keel preserves the provider failure instead of reporting a budget limit`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cost-budget-"));
    let providerCalls = 0;
    const provider: LLMProvider = {
      id: "failed-wrap-up",
      estimateInputTokens: () => 1,
      async *stream() {
        providerCalls++;
        if (providerCalls === 2) {
          throw new Error("wrap-up failed");
        }
        yield {
          type: "tool_call",
          id: "read_note",
          tool: "read",
          path: "note.txt",
        };
        yield {
          type: "stop",
          reason: "stop",
          usage: {
            inputTokens: 1,
            cachedInputTokens: 0,
            uncachedInputTokens: 1,
            outputTokens: 0,
          },
        };
      },
    };

    try {
      // When / Then
      await expect(
        collect(
          runAgent({
            workspace,
            provider,
            userMessage: "read note",
            systemPrompt: "You are helpful.",
            signal: freshSignal(),
            bash: { kind: "disabled" },
            stopPolicy: maxTurnFallbackPolicy(1),
            costTracking: { model: budgetModel, maxCostUsd: 0.5 },
          }),
        ),
      ).rejects.toThrow("wrap-up failed");
      expect(providerCalls).toBe(2);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a session cost limit,
    When the projected session spend exceeds that limit before a file change,
    Then the agent stops and reports the spent cost without changing the file`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cost-budget-"));
    await writeFile(join(workspace, "note.txt"), "old value\n", "utf8");
    const provider: LLMProvider = {
      id: "expensive-tool-call",
      estimateInputTokens: () => 1,
      async *stream() {
        yield {
          type: "tool_call",
          id: "edit_note",
          tool: "edit",
          path: "note.txt",
          edits: [{ oldText: "old", newText: "new" }],
        };
        yield {
          type: "stop",
          reason: "stop",
          usage: {
            inputTokens: 1_000_000,
            cachedInputTokens: 0,
            uncachedInputTokens: 1_000_000,
            outputTokens: 0,
          },
        };
      },
    };

    try {
      // When
      const events = await collect(
        runAgent({
          workspace,
          provider,
          userMessage: "edit note",
          systemPrompt: "You are helpful.",
          signal: freshSignal(),
          bash: { kind: "disabled" },
          stopPolicy: defaultStopPolicy(),
          costTracking: {
            model: budgetModel,
            maxCostUsd: 0.5,
          },
        }),
      );

      // Then
      expect(await readFile(join(workspace, "note.txt"), "utf8")).toBe(
        "old value\n",
      );
      expect(events).toContainEqual({
        type: "end",
        usage: {
          inputTokens: 1_000_000,
          cachedInputTokens: 0,
          uncachedInputTokens: 1_000_000,
          outputTokens: 0,
        },
        turns: 1,
        stopReason: "cost_budget",
        cost: {
          spentUsd: 1,
          budget: {
            kind: "budget_limited",
            maxUsd: 0.5,
            overshootUsd: 0.5,
          },
        },
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given no session cost limit is configured,
    When an expensive response requests a file change,
    Then the agent still applies the change`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cost-budget-"));
    await writeFile(join(workspace, "note.txt"), "old value\n", "utf8");
    let turn = 0;
    const provider: LLMProvider = {
      id: "unlimited-tool-call",
      async *stream() {
        if (turn === 0) {
          turn++;
          yield {
            type: "tool_call",
            id: "read_note",
            tool: "read",
            path: "note.txt",
          };
          yield {
            type: "stop",
            reason: "stop",
            usage: {
              inputTokens: 0,
              cachedInputTokens: 0,
              uncachedInputTokens: 0,
              outputTokens: 0,
            },
          };
          return;
        }

        if (turn === 1) {
          turn++;
          yield {
            type: "tool_call",
            id: "edit_note",
            tool: "edit",
            path: "note.txt",
            edits: [{ oldText: "old", newText: "new" }],
          };
          yield {
            type: "stop",
            reason: "stop",
            usage: {
              inputTokens: 1_000_000,
              cachedInputTokens: 0,
              uncachedInputTokens: 1_000_000,
              outputTokens: 0,
            },
          };
          return;
        }
        yield { type: "text", text: "Done." };
        yield {
          type: "stop",
          reason: "stop",
          usage: {
            inputTokens: 0,
            cachedInputTokens: 0,
            uncachedInputTokens: 0,
            outputTokens: 0,
          },
        };
      },
    };

    try {
      // When
      const events = await collect(
        runAgent({
          workspace,
          provider,
          userMessage: "edit note",
          systemPrompt: "You are helpful.",
          signal: freshSignal(),
          bash: { kind: "disabled" },
          stopPolicy: defaultStopPolicy(),
        }),
      );

      // Then
      expect(await readFile(join(workspace, "note.txt"), "utf8")).toBe(
        "new value\n",
      );
      expect(events).toContainEqual({ type: "text", text: "Done." });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a tiered model request crosses the higher input-token tier,
    When the high-tier cost exceeds the session budget,
    Then the agent stops before changing files`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cost-budget-"));
    await writeFile(join(workspace, "note.txt"), "old value\n", "utf8");
    const provider: LLMProvider = {
      id: "high-tier-tool-call",
      estimateInputTokens: () => 1,
      async *stream() {
        yield {
          type: "tool_call",
          id: "edit_note",
          tool: "edit",
          path: "note.txt",
          edits: [{ oldText: "old", newText: "new" }],
        };
        yield {
          type: "stop",
          reason: "stop",
          usage: {
            inputTokens: 300_000,
            cachedInputTokens: 0,
            uncachedInputTokens: 300_000,
            outputTokens: 0,
          },
        };
      },
    };

    try {
      // When
      const events = await collect(
        runAgent({
          workspace,
          provider,
          userMessage: "edit note",
          systemPrompt: "You are helpful.",
          signal: freshSignal(),
          bash: { kind: "disabled" },
          stopPolicy: defaultStopPolicy(),
          costTracking: {
            model: tieredBudgetModel,
            maxCostUsd: 0.2,
          },
        }),
      );

      // Then
      expect(await readFile(join(workspace, "note.txt"), "utf8")).toBe(
        "old value\n",
      );
      expect(events).toContainEqual({
        type: "end",
        usage: {
          inputTokens: 300_000,
          cachedInputTokens: 0,
          uncachedInputTokens: 300_000,
          outputTokens: 0,
        },
        turns: 1,
        stopReason: "cost_budget",
        cost: {
          spentUsd: 0.36,
          budget: {
            kind: "budget_limited",
            maxUsd: 0.2,
            overshootUsd: 0.15999999999999998,
          },
        },
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a session cost limit and an expensive response proposes multiple file changes,
    When the response already exceeds the budget,
    Then the agent stops before validating or applying the changes`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cost-budget-"));
    await writeFile(join(workspace, "note.txt"), "old value\n", "utf8");
    const provider: LLMProvider = {
      id: "expensive-multiple-tool-calls",
      estimateInputTokens: () => 1,
      async *stream() {
        yield {
          type: "tool_call",
          id: "first_edit",
          tool: "edit",
          path: "note.txt",
          edits: [{ oldText: "old", newText: "first" }],
        };
        yield {
          type: "tool_call",
          id: "second_edit",
          tool: "edit",
          path: "note.txt",
          edits: [{ oldText: "old", newText: "second" }],
        };
        yield {
          type: "stop",
          reason: "stop",
          usage: {
            inputTokens: 1_000_000,
            cachedInputTokens: 0,
            uncachedInputTokens: 1_000_000,
            outputTokens: 0,
          },
        };
      },
    };

    try {
      // When
      const events = await collect(
        runAgent({
          workspace,
          provider,
          userMessage: "edit note twice",
          systemPrompt: "You are helpful.",
          signal: freshSignal(),
          bash: { kind: "disabled" },
          stopPolicy: defaultStopPolicy(),
          costTracking: {
            model: budgetModel,
            maxCostUsd: 0.5,
          },
        }),
      );

      // Then
      expect(await readFile(join(workspace, "note.txt"), "utf8")).toBe(
        "old value\n",
      );
      expect(events).toContainEqual({
        type: "end",
        usage: {
          inputTokens: 1_000_000,
          cachedInputTokens: 0,
          uncachedInputTokens: 1_000_000,
          outputTokens: 0,
        },
        turns: 1,
        stopReason: "cost_budget",
        cost: {
          spentUsd: 1,
          budget: {
            kind: "budget_limited",
            maxUsd: 0.5,
            overshootUsd: 0.5,
          },
        },
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
