import {
  createCostBudgetedProvider,
  type SharedCostBudgetAccount,
} from "../../agent/cost-budget.ts";
import type { CostReport } from "../../agent/events.ts";
import type { SubagentTreeProviderCoordination } from "../../agent/subagent-tree-provider.ts";
import { createSubagentTreeProvider } from "../../agent/subagent-tree-provider.ts";
import type { CostModel } from "../../core/cost.ts";
import type { LLMProvider, Usage } from "../../llm/types.ts";
import type { InteractiveSessionArgs } from "./types.ts";

export type InteractiveCompactionCost =
  | {
      readonly kind: "untracked";
    }
  | {
      readonly kind: "tracked";
      readonly model: CostModel;
    }
  | {
      readonly kind: "budgeted";
      readonly model: CostModel;
      readonly maxCostUsd: number;
      readonly admission:
        | {
            readonly kind: "isolated";
            readonly remainingCostUsd: number;
          }
        | {
            readonly kind: "shared";
            readonly account: SharedCostBudgetAccount;
            readonly providerCoordination: SubagentTreeProviderCoordination;
          };
      readonly budgetLimitedReport: () => CostReport;
    };

type InteractiveBudgetAdmission = Extract<
  InteractiveCompactionCost,
  { readonly kind: "budgeted" }
>["admission"];

export function createInteractiveCostBudgetedProvider(options: {
  readonly provider: LLMProvider;
  readonly model: CostModel;
  readonly admission: InteractiveBudgetAdmission;
  readonly modelMaxOutputTokens: number | undefined;
}): LLMProvider {
  const budget =
    options.admission.kind === "shared"
      ? {
          provider: createSubagentTreeProvider({
            provider: options.provider,
            coordination: options.admission.providerCoordination,
          }).provider,
          maxCostUsd: options.admission.account.remainingUsd(),
          sharedAccount: options.admission.account,
        }
      : {
          provider: options.provider,
          maxCostUsd: options.admission.remainingCostUsd,
        };
  return createCostBudgetedProvider({
    ...budget,
    model: options.model,
    ...(options.modelMaxOutputTokens !== undefined
      ? { modelMaxOutputTokens: options.modelMaxOutputTokens }
      : {}),
  });
}

export const EMPTY_USAGE: Usage = {
  inputTokens: 0,
  cachedInputTokens: 0,
  uncachedInputTokens: 0,
  outputTokens: 0,
};

export function addUsage(left: Usage, right: Usage): Usage {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
    uncachedInputTokens: left.uncachedInputTokens + right.uncachedInputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
  };
}

export function shouldTrackInteractiveCost(
  args: InteractiveSessionArgs,
): boolean {
  return args.maxCostUsd !== undefined || args.reportFile !== undefined;
}

export function buildSessionCostReport(
  spentUsd: number,
  maxCostUsd: number | undefined,
): CostReport {
  if (maxCostUsd === undefined) {
    return {
      spentUsd,
      budget: { kind: "unbounded" },
    };
  }
  if (spentUsd >= maxCostUsd) {
    return {
      spentUsd,
      budget: {
        kind: "budget_limited",
        maxUsd: maxCostUsd,
        overshootUsd: Math.max(0, spentUsd - maxCostUsd),
      },
    };
  }
  return {
    spentUsd,
    budget: { kind: "within_budget", maxUsd: maxCostUsd },
  };
}

export function buildSessionCostBudgetLimitedReport(
  spentUsd: number,
  maxCostUsd: number,
): CostReport {
  return {
    spentUsd,
    budget: {
      kind: "budget_limited",
      maxUsd: maxCostUsd,
      overshootUsd: Math.max(0, spentUsd - maxCostUsd),
    },
  };
}
