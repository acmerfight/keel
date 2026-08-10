import {
  type CostModel,
  calculateConservativeRequestCostUsd,
} from "../core/cost.ts";
import type {
  ProviderContinuationLease,
  ProviderMessage,
} from "../llm/types.ts";
import {
  MIN_USEFUL_OUTPUT_TOKENS,
  type SharedCostBudgetedProvider,
} from "./cost-budget.ts";

const DEFAULT_MAX_AGGREGATE_RESULT_CHARS = 24_000;
export const MAX_SUBAGENT_RESULT_CHARS = 6_000;
const resultAdmissionPlan = Symbol("subagentResultAdmissionPlan");

function maximumUtf8ToolResult(maxCodeUnits: number): string {
  return "\u0800".repeat(maxCodeUnits);
}

export interface SubagentTreeBudgetCandidate<Value> {
  readonly value: Value;
  readonly minimumInputTokens: number;
}

export interface SubagentChildBudgetLease<Value> {
  readonly value: Value;
  readonly maxCostUsd: number;
  readonly maxResultChars: number;
}

type SubagentResultContent =
  | { readonly kind: "pending" }
  | { readonly kind: "exact"; readonly value: string }
  | {
      readonly kind: "projected";
      readonly value: (maxResultChars: number) => string;
    };

export interface SubagentResultOutcome {
  readonly toolCallId: string;
  readonly content: SubagentResultContent;
}

interface SubagentResultAdmissionPlan {
  readonly [resultAdmissionPlan]: true;
  readonly maxResultChars: number;
  readonly additionalMessages: readonly ProviderMessage[];
}

export type SubagentTreeBudgetLeaseResult<Value> =
  | {
      readonly kind: "granted";
      readonly children: readonly SubagentChildBudgetLease<Value>[];
      readonly continuation: ProviderContinuationLease;
      readonly release: () => void;
    }
  | {
      readonly kind: "rejected";
    };

export type SubagentResultContinuationLease =
  | {
      readonly kind: "granted";
      readonly maxResultChars: number;
      readonly continuation: ProviderContinuationLease;
      readonly release: () => void;
    }
  | { readonly kind: "rejected" };

export interface SubagentResultContinuationBudget {
  readonly lease: (
    toolCallIds: readonly string[],
  ) => SubagentResultContinuationLease;
}

interface CreateSubagentTreeBudgetOptions {
  readonly rootBudget: SharedCostBudgetedProvider;
  readonly costModel: CostModel;
}

export interface SubagentTreeBudget {
  readonly planResults: (
    outcomes: readonly SubagentResultOutcome[],
  ) => SubagentResultAdmissionPlan;
  readonly leaseBatch: <Value>(input: {
    readonly resultAdmission: SubagentResultAdmissionPlan;
    readonly children: readonly SubagentTreeBudgetCandidate<Value>[];
    readonly continuationMaxOutputTokens: number;
  }) => SubagentTreeBudgetLeaseResult<Value>;
}

export function maxSubagentResultCharsForBatch(resultCount: number): number {
  return Math.min(
    MAX_SUBAGENT_RESULT_CHARS,
    Math.floor(DEFAULT_MAX_AGGREGATE_RESULT_CHARS / Math.max(1, resultCount)),
  );
}

function admittedResultContent(
  content: string,
  maxResultChars: number,
): string {
  return content.length <= maxResultChars
    ? content
    : content.slice(0, maxResultChars);
}

export function createSubagentTreeBudget(
  options: CreateSubagentTreeBudgetOptions,
): SubagentTreeBudget {
  return {
    planResults: (outcomes) => {
      const maxResultChars = maxSubagentResultCharsForBatch(outcomes.length);
      const additionalMessages: ProviderMessage[] = outcomes.map((outcome) => {
        let content: string;
        switch (outcome.content.kind) {
          case "pending":
            content = maximumUtf8ToolResult(maxResultChars);
            break;
          case "exact":
            content = admittedResultContent(
              outcome.content.value,
              maxResultChars,
            );
            break;
          case "projected":
            content = admittedResultContent(
              outcome.content.value(maxResultChars),
              maxResultChars,
            );
            break;
        }
        return {
          role: "tool",
          toolCallId: outcome.toolCallId,
          content,
        };
      });
      return {
        [resultAdmissionPlan]: true,
        maxResultChars,
        additionalMessages,
      };
    },
    leaseBatch: (input) => {
      const pricedCandidates = input.children.map((candidate) => ({
        candidate,
        minimumCostUsd: calculateConservativeRequestCostUsd(
          candidate.minimumInputTokens,
          MIN_USEFUL_OUTPUT_TOKENS,
          options.costModel,
        ),
      }));
      const minimumAdditionalRequestCostUsd = pricedCandidates.reduce(
        (total, priced) => total + priced.minimumCostUsd,
        0,
      );
      const continuation = options.rootBudget.leaseContinuation({
        additionalMessages: input.resultAdmission.additionalMessages,
        maxOutputTokens: input.continuationMaxOutputTokens,
        minimumAdditionalRequestCostUsd,
      });
      if (continuation.kind !== "granted") return { kind: "rejected" };

      const extraBudgetUsd =
        continuation.additionalRequestBudgetUsd -
        minimumAdditionalRequestCostUsd;
      let remainingBudgetUsd = continuation.additionalRequestBudgetUsd;
      const children = pricedCandidates.map((priced, index) => {
        const maxCostUsd =
          index === pricedCandidates.length - 1
            ? remainingBudgetUsd
            : priced.minimumCostUsd + extraBudgetUsd / pricedCandidates.length;
        remainingBudgetUsd -= maxCostUsd;
        return {
          value: priced.candidate.value,
          maxCostUsd,
          maxResultChars: input.resultAdmission.maxResultChars,
        };
      });
      let released = false;
      return {
        kind: "granted",
        children,
        continuation: continuation.continuation,
        release: () => {
          if (released) return;
          released = true;
          continuation.release();
        },
      };
    },
  };
}
