import { describe, expect, test } from "vitest";
import type { SharedCostBudgetedProvider } from "../../src/agent/cost-budget.ts";
import { createSubagentTreeBudget } from "../../src/agent/subagent-tree-budget.ts";
import type { CostModel } from "../../src/core/cost.ts";

const costModel: CostModel = {
  type: "fixed",
  uncachedInputPerMillionTokens: 1,
  cachedInputPerMillionTokens: 0.5,
  outputPerMillionTokens: 2,
};

function rootBudgetFixture(): {
  readonly rootBudget: SharedCostBudgetedProvider;
  readonly leaseCalls: () => number;
  readonly leaseInputs: () => readonly Parameters<
    SharedCostBudgetedProvider["leaseContinuation"]
  >[0][];
  readonly releases: () => number;
} {
  let leaseCalls = 0;
  const leaseInputs: Parameters<
    SharedCostBudgetedProvider["leaseContinuation"]
  >[0][] = [];
  let releases = 0;
  const provider: SharedCostBudgetedProvider["provider"] = {
    id: "tree-budget-fixture",
    async *stream() {
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
  return {
    rootBudget: {
      provider,
      remainingUsd: () => 0.01,
      observedUsage: () => ({
        inputTokens: 0,
        cachedInputTokens: 0,
        uncachedInputTokens: 0,
        outputTokens: 0,
      }),
      observedSpendUsd: () => 0,
      leaseContinuation: (input) => {
        leaseCalls++;
        leaseInputs.push(input);
        const release = () => {
          releases++;
        };
        return {
          kind: "granted",
          reservedUsd: 0.002,
          additionalRequestBudgetUsd: 0.008,
          estimatedContinuationInputTokens: 1_000,
          continuation: {
            provider,
            requestShape: {
              systemPrompt: "main",
              toolExposure: { kind: "auto", delegation: "foreground" },
            },
            release,
          },
          release,
        };
      },
    },
    leaseCalls: () => leaseCalls,
    leaseInputs: () => leaseInputs,
    releases: () => releases,
  };
}

describe("Subagent tree budget", () => {
  test(`Given four siblings share one aggregate continuation and result budget,
    When the tree partitions child leases and the settled batch closes,
    Then ceilings do not oversell and the continuation releases exactly once`, () => {
    const fixture = rootBudgetFixture();
    const budget = createSubagentTreeBudget({
      rootBudget: fixture.rootBudget,
      costModel,
    });

    const resultAdmission = budget.planResults([
      { toolCallId: "one", content: { kind: "pending" } },
      { toolCallId: "two", content: { kind: "pending" } },
      { toolCallId: "three", content: { kind: "pending" } },
      { toolCallId: "four", content: { kind: "pending" } },
    ]);
    const lease = budget.leaseBatch({
      resultAdmission,
      children: [
        { value: "one", minimumInputTokens: 100 },
        { value: "two", minimumInputTokens: 200 },
        { value: "three", minimumInputTokens: 300 },
        { value: "four", minimumInputTokens: 400 },
      ],
      continuationMaxOutputTokens: 4_096,
    });

    expect(lease.kind).toBe("granted");
    if (lease.kind !== "granted") return;
    expect(fixture.leaseCalls()).toBe(1);
    expect(lease.children).toHaveLength(4);
    expect(
      lease.children.reduce((total, child) => total + child.maxCostUsd, 0),
    ).toBeCloseTo(0.008, 12);
    expect(
      lease.children.reduce((total, child) => total + child.maxResultChars, 0),
    ).toBe(24_000);

    lease.release();
    lease.release();
    expect(fixture.releases()).toBe(1);
  });

  test(`Given fresh, rejected, and replayed delegate outcomes all enter main context,
    When the tree reserves fresh-plus-rejected, fresh-plus-replayed, and replay-only batches,
    Then every source result is priced while only fresh children consume child budget`, () => {
    const cases = [
      {
        name: "fresh-plus-rejected",
        outcomes: [
          { toolCallId: "fresh", content: { kind: "pending" } as const },
          {
            toolCallId: "rejected",
            content: {
              kind: "exact" as const,
              value: "R".repeat(7_000),
            },
          },
        ],
        children: [
          {
            value: "fresh",
            minimumInputTokens: 100,
          },
        ],
        exactResult: "R".repeat(6_000),
      },
      {
        name: "fresh-plus-replayed",
        outcomes: [
          { toolCallId: "fresh", content: { kind: "pending" } as const },
          {
            toolCallId: "replayed",
            content: {
              kind: "projected" as const,
              value: (maxChars: number) =>
                '{"status":"completed","finalText":"cached"}'.slice(
                  0,
                  maxChars,
                ),
            },
          },
        ],
        children: [
          {
            value: "fresh",
            minimumInputTokens: 100,
          },
        ],
        exactResult: '{"status":"completed","finalText":"cached"}',
      },
      {
        name: "replay-only",
        outcomes: [
          {
            toolCallId: "replayed",
            content: {
              kind: "projected" as const,
              value: (maxChars: number) => "cached result".slice(0, maxChars),
            },
          },
        ],
        children: [],
        exactResult: "cached result",
      },
    ];

    for (const scenario of cases) {
      const fixture = rootBudgetFixture();
      const budget = createSubagentTreeBudget({
        rootBudget: fixture.rootBudget,
        costModel,
      });
      const resultAdmission = budget.planResults(scenario.outcomes);
      const lease = budget.leaseBatch({
        resultAdmission,
        children: scenario.children,
        continuationMaxOutputTokens: 4_096,
      });

      expect(lease.kind, scenario.name).toBe("granted");
      if (lease.kind !== "granted") continue;
      const leaseInput = fixture.leaseInputs()[0];
      expect(leaseInput?.additionalMessages, scenario.name).toHaveLength(
        scenario.outcomes.length,
      );
      expect(
        leaseInput?.additionalMessages.at(-1)?.content,
        scenario.name,
      ).toBe(scenario.exactResult);
      if (scenario.children.length === 0) {
        expect(leaseInput?.minimumAdditionalRequestCostUsd, scenario.name).toBe(
          0,
        );
      } else {
        expect(
          leaseInput?.minimumAdditionalRequestCostUsd,
          scenario.name,
        ).toBeGreaterThan(0);
      }
      expect(lease.children, scenario.name).toHaveLength(
        scenario.children.length,
      );
      lease.release();
      expect(fixture.releases(), scenario.name).toBe(1);
    }
  });
});
