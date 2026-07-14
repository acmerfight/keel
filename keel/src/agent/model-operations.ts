import { type CostModel, calculateRequestCostBatchUsd } from "../core/cost.ts";
import { KeelError } from "../core/error.ts";
import type {
  ProviderRequestAttemptObserver,
  ProviderRequestAttemptOutcome,
  Usage,
} from "../llm/types.ts";
import { CostBudgetAdmissionError } from "./cost-budget.ts";

export type ModelOperationPurpose =
  | "agent_turn"
  | "turn_limit_summary"
  | "context_compaction"
  | "goal_assertion_evaluation"
  | "manual_compaction"
  | "model_switch_compaction";

export type ModelOperationOutcome =
  | Exclude<ProviderRequestAttemptOutcome, "retryable_error">
  | "admission_rejected";

export type ModelOperationOwner =
  | { readonly type: "current_agent_run" }
  | { readonly type: "session" }
  | { readonly type: "invocation" };

export interface ModelOperationRecoveryTarget {
  readonly operationToken: symbol;
  readonly attemptToken: symbol;
}

export interface ModelOperationInstrumentation {
  readonly recorder: ModelOperationRecorder;
  readonly owner: ModelOperationOwner;
  readonly provider: string;
  readonly model: string;
  readonly costModel: CostModel;
}

export type ModelOperationRequest<
  Purpose extends ModelOperationPurpose = ModelOperationPurpose,
> = Purpose extends ModelOperationPurpose
  ? {
      readonly instrumentation: ModelOperationInstrumentation;
      readonly purpose: Purpose;
      readonly recoveryFor: Purpose extends "context_compaction"
        ? ModelOperationRecoveryTarget | null
        : null;
    }
  : never;

type BeginModelOperationOptionsFor<Purpose extends ModelOperationPurpose> =
  Purpose extends ModelOperationPurpose
    ? ModelOperationInstrumentation & {
        readonly purpose: Purpose;
        readonly recoveryFor: Purpose extends "context_compaction"
          ? ModelOperationRecoveryTarget | null
          : null;
      }
    : never;

export type BeginModelOperationOptions =
  BeginModelOperationOptionsFor<ModelOperationPurpose>;

interface ModelOperationFinish {
  readonly outcome: ModelOperationOutcome;
}

export interface ModelOperationHandle {
  readonly providerRequestAttempts: ProviderRequestAttemptObserver;
  readonly finish: (result: ModelOperationFinish) => void;
  readonly finishFromError: (error: unknown) => void;
  readonly latestContextOverflowRecoveryTarget: () => ModelOperationRecoveryTarget | null;
}

export interface ModelOperationRecorder {
  readonly beginModelOperation: (
    options: BeginModelOperationOptions,
  ) => ModelOperationHandle;
}

export function requestCostUsd(usage: Usage, costModel: CostModel): number {
  return calculateRequestCostBatchUsd({ requests: [{ usage }] }, costModel);
}

export function modelOperationOutcomeFromError(
  error: unknown,
): ModelOperationOutcome {
  if (error instanceof CostBudgetAdmissionError) {
    return "admission_rejected";
  }
  /* v8 ignore next -- supported providers normalize request failures to KeelError; the fallback below preserves terminal handling for unexpected runtime failures. */
  if (error instanceof KeelError) {
    switch (error.code) {
      case "provider_aborted":
        return "aborted";
      case "provider_context_overflow":
        return "context_overflow";
      default:
        return "terminal_error";
    }
  }
  /* v8 ignore next -- supported providers normalize request failures to KeelError; unexpected runtime failures still remain terminal. */
  return "terminal_error";
}
