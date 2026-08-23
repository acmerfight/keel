import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  CostBudgetAdmissionError,
  createCostBudgetedProvider,
  createSharedCostBudgetAccount,
  createSharedCostBudgetedProvider,
} from "../../src/agent/cost-budget.ts";
import { runAgent, runAgentTurn } from "../../src/agent/loop.ts";
import type { SessionMessage } from "../../src/agent/session-message.ts";
import {
  defaultStopPolicy,
  maxTurnFallbackPolicy,
} from "../../src/agent/stop-policy.ts";
import {
  builtinSubagentProfileCatalog,
  resolveBuiltinSubagentProfile,
} from "../../src/agent/subagent-profile.ts";
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
  test(`Given the saved-session budget receives invalid, oversized, or repeated reservation operations,
    When callers reserve, release, and settle,
    Then invalid work is rejected and every valid reservation changes the balance at most once`, () => {
    const account = createSharedCostBudgetAccount(1);

    expect(account.reserve(Number.NaN)).toBeNull();
    expect(account.reserve(-1)).toBeNull();
    expect(account.reserve(2)).toBeNull();
    const released = account.reserve(0.4);
    expect(released).not.toBeNull();
    released?.release();
    released?.release();
    released?.settle(0.4);
    expect(account.remainingUsd()).toBe(1);
    expect(account.observedSpendUsd()).toBe(0);

    const settled = account.reserve(0.5);
    expect(settled).not.toBeNull();
    settled?.settle(0.25);
    settled?.settle(0.25);
    settled?.release();
    expect(account.remainingUsd()).toBe(0.75);
    expect(account.observedSpendUsd()).toBe(0.25);
  });

  test(`Given separate Main turns price requests against one saved-session budget concurrently,
    When both reach atomic provider-attempt admission with room for only one,
    Then exactly one starts and the other is rejected without overselling the session`, async () => {
    const bothPriced = Promise.withResolvers<void>();
    let entered = 0;
    let started = 0;
    const usage = {
      inputTokens: 100,
      cachedInputTokens: 0,
      uncachedInputTokens: 100,
      outputTokens: 10,
    } as const;
    const underlying: LLMProvider = {
      id: "session-shared-budget",
      estimateInputTokens: () => 100,
      async *stream(options) {
        entered++;
        if (entered === 2) bothPriced.resolve();
        await bothPriced.promise;
        const attempt = options.providerRequestAttempts?.begin();
        started++;
        await new Promise<void>((resolve) => setImmediate(resolve));
        attempt?.finish({ outcome: "completed", usage });
        yield { type: "stop", reason: "stop", usage };
      },
    };
    const maxCostUsd = calculateConservativeRequestCostUsd(
      100,
      256,
      budgetModel,
    );
    const account = createSharedCostBudgetAccount(maxCostUsd);
    const turnProviders = [0, 1].map(() =>
      createSharedCostBudgetedProvider({
        provider: underlying,
        model: budgetModel,
        maxCostUsd,
        sharedAccount: account,
      }),
    );

    const outcomes = await Promise.allSettled(
      turnProviders.map((turn) =>
        collect(
          turn.provider.stream({
            systemPrompt: "main",
            messages: [],
            signal: freshSignal(),
            maxOutputTokens: 256,
          }),
        ),
      ),
    );

    expect(
      outcomes.filter((outcome) => outcome.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      outcomes.filter((outcome) => outcome.status === "rejected"),
    ).toHaveLength(1);
    expect(
      outcomes.find((outcome) => outcome.status === "rejected"),
    ).toMatchObject({ reason: expect.any(CostBudgetAdmissionError) });
    expect(started).toBe(1);
    expect(account.observedSpendUsd()).toBeCloseTo(0.00012, 10);
    expect(account.remainingUsd()).toBeCloseTo(maxCostUsd - 0.00012, 10);
  });

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
            profile: "explorer",
            mode: "foreground",
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
          bash: { kind: "trusted" },
          stopPolicy: defaultStopPolicy(),
          delegation: {
            mode: "foreground",
            profileCatalog: builtinSubagentProfileCatalog,
            available: () => true,
            prepareBatch: () => ({
              close: () => {},
              executor: createDelegationExecutor(async () => {
                childCalls++;
                return {
                  delivery: "fresh",
                  ok: true,
                  content: "unexpected child result",
                  costUsd: 0.001,
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
                costUsd: 0.001,
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
    Then only the leased provider can atomically spend the held Main reservation`, async () => {
    let providerCalls = 0;
    const observedRequests: StreamOptions[] = [];
    const toolCall: Extract<ToolCall, { readonly tool: "delegate" }> = {
      id: "delegate-call",
      tool: "delegate",
      profile: "explorer",
      mode: "foreground",
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
        observedRequests.push(options);
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
      toolExposure: {
        kind: "auto",
        delegation: {
          mode: "foreground",
          profileCatalog: builtinSubagentProfileCatalog,
        },
      } as const,
    };
    const childOptions: StreamOptions = {
      systemPrompt: "child",
      messages: childMessages,
      signal: freshSignal(),
      toolExposure: {
        kind: "auto",
        profile: "subagent",
        capability: resolveBuiltinSubagentProfile("explorer").snapshot,
      } as const,
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

    await expect(
      (async () => {
        for await (const _event of root.provider.stream(continuationOptions)) {
          // An ordinary tree request cannot borrow Main's held reservation.
        }
      })(),
    ).rejects.toBeInstanceOf(CostBudgetAdmissionError);

    const invokeLeasedContinuation = () =>
      collect(
        lease.continuation.provider.stream({
          ...continuationOptions,
          systemPrompt: "unpriced dynamic system prompt",
          requestSystemPrompt: () => "unpriced request-time prompt",
          toolExposure: {
            kind: "auto",
            delegation: {
              mode: "background",
              profileCatalog: builtinSubagentProfileCatalog,
            },
            agentControl: true,
          },
          maxOutputTokens: 10_000,
        }),
      );
    const concurrentClaims = await Promise.allSettled([
      invokeLeasedContinuation(),
      invokeLeasedContinuation(),
    ]);
    expect(
      concurrentClaims.filter((outcome) => outcome.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      concurrentClaims.filter((outcome) => outcome.status === "rejected"),
    ).toHaveLength(1);
    await expect(invokeLeasedContinuation()).rejects.toBeInstanceOf(
      CostBudgetAdmissionError,
    );
    lease.release();
    expect(providerCalls).toBe(4);
    expect(observedRequests[2]).toMatchObject({
      systemPrompt: "main",
      toolExposure: {
        kind: "auto",
        delegation: {
          mode: "foreground",
          profileCatalog: builtinSubagentProfileCatalog,
        },
      },
      maxOutputTokens: 256,
    });
    expect(observedRequests[2]?.requestSystemPrompt).toBeUndefined();
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
    let sharedReserveCalls = 0;
    const sharedReservationRoot = createSharedCostBudgetedProvider({
      provider: underlying,
      model: budgetModel,
      maxCostUsd: 1,
      sharedAccount: {
        remainingUsd: () => 1,
        observedSpendUsd: () => 0,
        reserve: () => {
          sharedReserveCalls++;
          return sharedReserveCalls === 1
            ? { settle: () => {}, release: () => {} }
            : null;
        },
      },
    });
    let rejectedSharedTransportCalls = 0;
    const rejectedSharedRequestRoot = createSharedCostBudgetedProvider({
      provider: {
        ...underlying,
        async *stream(options) {
          options.providerRequestAttempts?.begin();
          rejectedSharedTransportCalls++;
          yield { type: "text", text: "unexpected transport" };
        },
      },
      model: budgetModel,
      maxCostUsd: 1,
      sharedAccount: {
        remainingUsd: () => 1,
        observedSpendUsd: () => 0,
        reserve: () => null,
      },
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
      toolExposure: { kind: "auto" },
    })) {
      // Establish a valid baseline before the provider rejects the full shape.
    }
    expect(invalidEstimateRoot.leaseContinuation(request)).toEqual({
      kind: "rejected",
      reason: "invalid_estimate",
    });
    for await (const _event of sharedReservationRoot.provider.stream({
      systemPrompt: "shared baseline",
      messages: [],
      signal: freshSignal(),
      toolExposure: { kind: "auto" },
    })) {
      // Establish a baseline before the atomic shared reserve loses its race.
    }
    expect(sharedReservationRoot.leaseContinuation(request)).toEqual({
      kind: "rejected",
      reason: "insufficient_budget",
    });
    await expect(
      collect(
        rejectedSharedRequestRoot.provider.stream({
          systemPrompt: "shared budget was consumed concurrently",
          messages: [],
          signal: freshSignal(),
        }),
      ),
    ).rejects.toBeInstanceOf(CostBudgetAdmissionError);
    expect(rejectedSharedTransportCalls).toBe(0);
    await expect(
      (async () => {
        for await (const _event of invalidFinalShapeRoot.provider.stream({
          systemPrompt: "initial estimate is valid",
          messages: [],
          signal: freshSignal(),
          toolExposure: { kind: "auto" },
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
      toolExposure: { kind: "auto" },
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
          bash: { kind: "trusted" },
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
          bash: { kind: "trusted" },
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
          bash: { kind: "trusted" },
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
          bash: { kind: "trusted" },
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
          bash: { kind: "trusted" },
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
          bash: { kind: "trusted" },
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
          bash: { kind: "trusted" },
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
            bash: { kind: "trusted" },
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
          bash: { kind: "trusted" },
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
          bash: { kind: "trusted" },
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
          bash: { kind: "trusted" },
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
          bash: { kind: "trusted" },
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
