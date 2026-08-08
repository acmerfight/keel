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
  | "subagent_turn"
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
  | { readonly type: "session" };

export interface ModelOperationAttribution {
  readonly type: "subagent";
  readonly delegationId: string;
  readonly childRunId: string;
}

export type MainOnlyModelOperationPurpose = Extract<
  ModelOperationPurpose,
  | "agent_turn"
  | "goal_assertion_evaluation"
  | "manual_compaction"
  | "model_switch_compaction"
>;

export type SharedModelOperationPurpose = Extract<
  ModelOperationPurpose,
  "turn_limit_summary" | "context_compaction"
>;

type SubagentOnlyModelOperationPurpose = Extract<
  ModelOperationPurpose,
  "subagent_turn"
>;

export type ModelOperationRecoveryTarget = (
  recoveryOperationOrdinal: number,
) => void;

interface ModelOperationInstrumentationBase {
  readonly recorder: ModelOperationRecorder;
  readonly owner: ModelOperationOwner;
  readonly provider: string;
  readonly model: string;
  readonly costModel: CostModel;
}

export type MainModelOperationInstrumentation =
  ModelOperationInstrumentationBase & {
    readonly attribution?: never;
  };

export type SubagentModelOperationInstrumentation =
  ModelOperationInstrumentationBase & {
    readonly attribution: ModelOperationAttribution;
  };

export type ModelOperationInstrumentation =
  | MainModelOperationInstrumentation
  | SubagentModelOperationInstrumentation;

type InstrumentationForPurpose<Purpose extends ModelOperationPurpose> =
  Purpose extends SubagentOnlyModelOperationPurpose
    ? SubagentModelOperationInstrumentation
    : Purpose extends MainOnlyModelOperationPurpose
      ? MainModelOperationInstrumentation
      : ModelOperationInstrumentation;

export type ModelOperationRequest<
  Purpose extends ModelOperationPurpose = ModelOperationPurpose,
> = Purpose extends ModelOperationPurpose
  ? {
      readonly instrumentation: InstrumentationForPurpose<Purpose>;
      readonly purpose: Purpose;
      readonly recoveryFor: Purpose extends "context_compaction"
        ? ModelOperationRecoveryTarget | null
        : null;
    }
  : never;

type BeginModelOperationOptionsFor<Purpose extends ModelOperationPurpose> =
  Purpose extends ModelOperationPurpose
    ? InstrumentationForPurpose<Purpose> & {
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
  return "terminal_error";
}
