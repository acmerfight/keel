import {
  type BeginModelOperationOptions,
  type ModelOperationHandle,
  type ModelOperationOutcome,
  type ModelOperationOwner,
  type ModelOperationPurpose,
  type ModelOperationRecorder,
  type ModelOperationRecoveryTarget,
  modelOperationOutcomeFromError,
  requestCostUsd,
} from "../agent/model-operations.ts";
import type { CostModel } from "../core/cost.ts";
import type {
  ProviderRequestAttemptFinish,
  ProviderRequestAttemptHandle,
  ProviderRequestRetryDecision,
  Usage,
} from "../llm/types.ts";

type RunReportModelOperationOwner =
  | {
      readonly type: "agent_run";
      readonly taskOrdinal: number;
      readonly agentRunOrdinal: number;
    }
  | { readonly type: "session" };

interface RunReportProviderRequestAttemptBase {
  readonly ordinal: number;
}

type RunReportProviderRequestAttempt =
  | (RunReportProviderRequestAttemptBase & {
      readonly outcome: "completed";
      readonly usage: Usage;
      readonly costUsd: number;
    })
  | (RunReportProviderRequestAttemptBase & {
      readonly outcome: "retryable_error";
      readonly retryDecision: ProviderRequestRetryDecision;
    })
  | (RunReportProviderRequestAttemptBase & {
      readonly outcome: "context_overflow";
      readonly recoveryOperationOrdinal: number | null;
    })
  | (RunReportProviderRequestAttemptBase & {
      readonly outcome: "terminal_error" | "aborted";
    });

interface RunReportModelOperationBase {
  readonly ordinal: number;
  readonly owner: RunReportModelOperationOwner;
  readonly purpose: ModelOperationPurpose;
  readonly provider: string;
  readonly model: string;
  readonly providerRequestAttempts: readonly RunReportProviderRequestAttempt[];
  readonly outcome: ModelOperationOutcome;
  readonly usage: Usage;
  readonly costUsd: number;
}

export type RunReportModelOperation = RunReportModelOperationBase;

export interface RunReportModelUsage {
  readonly provider: string;
  readonly model: string;
  readonly agentLoopTurns: number;
  readonly usage: Usage;
  readonly costUsd: number;
}

interface RunReportModelOperationAccounting {
  readonly modelOperations: readonly RunReportModelOperation[];
  readonly modelOperationCount: number;
  readonly providerRequestAttemptCount: number;
  readonly modelsUsed: readonly {
    readonly provider: string;
    readonly model: string;
  }[];
  readonly usageByModel: readonly RunReportModelUsage[];
  readonly agentLoopTurns: number;
  readonly usage: Usage;
  readonly costUsd: number;
}

export interface CurrentAgentRunReportOwner {
  readonly taskOrdinal: number;
  readonly agentRunOrdinal: number;
}

export interface ModelOperationReportLedger extends ModelOperationRecorder {
  readonly modelOperations: () => readonly RunReportModelOperation[];
}

type MutableProviderRequestAttemptResult =
  | { readonly state: "pending" }
  | {
      readonly state: "completed";
      readonly usage: Usage;
      readonly costUsd: number;
    }
  | {
      readonly state: "retryable_error";
      readonly retryDecision: ProviderRequestRetryDecision;
    }
  | {
      readonly state: "context_overflow";
      readonly recovery: {
        operationOrdinal: number | null;
      };
    }
  | { readonly state: "terminal_error" | "aborted" };

type FinishedProviderRequestAttemptResult = Exclude<
  MutableProviderRequestAttemptResult,
  { readonly state: "pending" }
>;

interface MutableProviderRequestAttempt {
  readonly ordinal: number;
  result: MutableProviderRequestAttemptResult;
}

interface FinishedProviderRequestAttempt {
  readonly ordinal: number;
  readonly result: FinishedProviderRequestAttemptResult;
}

type MutableModelOperationResult =
  | { readonly state: "pending" }
  | {
      readonly state: "finished";
      readonly outcome: ModelOperationOutcome;
      readonly providerRequestAttempts: readonly FinishedProviderRequestAttempt[];
      readonly hasCompletedAttempt: boolean;
      readonly usage: Usage;
      readonly costUsd: number;
    };

interface MutableModelOperation {
  readonly ordinal: number;
  readonly owner: RunReportModelOperationOwner;
  readonly purpose: ModelOperationPurpose;
  readonly provider: string;
  readonly model: string;
  readonly costModel: CostModel;
  readonly providerRequestAttempts: MutableProviderRequestAttempt[];
  result: MutableModelOperationResult;
  latestContextOverflowRecoveryTarget: ModelOperationRecoveryTarget | null;
}

const ZERO_USAGE: Usage = {
  inputTokens: 0,
  cachedInputTokens: 0,
  uncachedInputTokens: 0,
  outputTokens: 0,
};

function addUsage(left: Usage, right: Usage): Usage {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
    uncachedInputTokens: left.uncachedInputTokens + right.uncachedInputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
  };
}

function resolveOperationOwner(
  owner: ModelOperationOwner,
  currentAgentRun: CurrentAgentRunReportOwner | null,
): RunReportModelOperationOwner {
  switch (owner.type) {
    case "current_agent_run":
      if (currentAgentRun === null) {
        throw new Error(
          "internal: report model operation requires an active Agent Run owner",
        );
      }
      return { type: "agent_run", ...currentAgentRun };
    case "session":
      return { type: "session" };
  }
}

function finishProviderRequestAttempt(
  attempt: MutableProviderRequestAttempt,
  result: ProviderRequestAttemptFinish,
  costModel: CostModel,
): ModelOperationRecoveryTarget | null {
  if (attempt.result.state !== "pending") {
    throw new Error("internal: provider request attempt finished twice");
  }
  switch (result.outcome) {
    case "completed":
      attempt.result = {
        state: "completed",
        usage: { ...result.usage },
        costUsd: requestCostUsd(result.usage, costModel),
      };
      return null;
    case "retryable_error":
      attempt.result = {
        state: "retryable_error",
        retryDecision: { ...result.retryDecision },
      };
      return null;
    case "context_overflow": {
      const recovery: { operationOrdinal: number | null } = {
        operationOrdinal: null,
      };
      attempt.result = {
        state: "context_overflow",
        recovery,
      };
      return (recoveryOperationOrdinal) => {
        if (recovery.operationOrdinal !== null) {
          throw new Error(
            "internal: provider request attempt already has a recovery operation",
          );
        }
        recovery.operationOrdinal = recoveryOperationOrdinal;
      };
    }
    case "terminal_error":
    case "aborted":
      attempt.result = { state: result.outcome };
      return null;
  }
}

function providerRequestAttemptReport(
  attempt: FinishedProviderRequestAttempt,
): RunReportProviderRequestAttempt {
  const base = { ordinal: attempt.ordinal };
  const result = attempt.result;
  switch (result.state) {
    case "completed":
      return {
        ...base,
        outcome: "completed",
        usage: { ...result.usage },
        costUsd: result.costUsd,
      };
    case "retryable_error":
      return {
        ...base,
        outcome: "retryable_error",
        retryDecision: { ...result.retryDecision },
      };
    case "context_overflow":
      return {
        ...base,
        outcome: "context_overflow",
        recoveryOperationOrdinal: result.recovery.operationOrdinal,
      };
    case "terminal_error":
    case "aborted":
      return { ...base, outcome: result.state };
  }
}

function modelOperationAttemptAccounting(
  attempts: readonly FinishedProviderRequestAttempt[],
): {
  readonly hasCompletedAttempt: boolean;
  readonly usage: Usage;
  readonly costUsd: number;
} {
  let hasCompletedAttempt = false;
  let usage = { ...ZERO_USAGE };
  let costUsd = 0;
  for (const attempt of attempts) {
    if (attempt.result.state !== "completed") continue;
    hasCompletedAttempt = true;
    usage = addUsage(usage, attempt.result.usage);
    costUsd += attempt.result.costUsd;
  }
  return { hasCompletedAttempt, usage, costUsd };
}

function modelOperationReport(
  operation: MutableModelOperation,
): RunReportModelOperation {
  if (operation.result.state === "pending") {
    throw new Error("internal: model operation never finished");
  }
  if (
    operation.result.outcome === "completed" &&
    !operation.result.hasCompletedAttempt
  ) {
    throw new Error(
      "internal: completed model operation requires a completed provider request attempt",
    );
  }
  return {
    ordinal: operation.ordinal,
    owner: { ...operation.owner },
    purpose: operation.purpose,
    provider: operation.provider,
    model: operation.model,
    providerRequestAttempts: operation.result.providerRequestAttempts.map(
      providerRequestAttemptReport,
    ),
    outcome: operation.result.outcome,
    usage: { ...operation.result.usage },
    costUsd: operation.result.costUsd,
  };
}

function beginModelOperation(
  operations: MutableModelOperation[],
  recoveryTargets: WeakSet<ModelOperationRecoveryTarget>,
  currentAgentRun: CurrentAgentRunReportOwner | null,
  options: BeginModelOperationOptions,
): ModelOperationHandle {
  const operation: MutableModelOperation = {
    ordinal: operations.length + 1,
    owner: resolveOperationOwner(options.owner, currentAgentRun),
    purpose: options.purpose,
    provider: options.provider,
    model: options.model,
    costModel: options.costModel,
    providerRequestAttempts: [],
    result: { state: "pending" },
    latestContextOverflowRecoveryTarget: null,
  };
  if (options.recoveryFor !== null) {
    if (!recoveryTargets.has(options.recoveryFor)) {
      throw new Error(
        "internal: model operation recovery target belongs to another report ledger",
      );
    }
    options.recoveryFor(operation.ordinal);
  }
  operations.push(operation);

  const finishOperation = (outcome: ModelOperationOutcome): void => {
    if (operation.result.state !== "pending") {
      throw new Error("internal: model operation finished twice");
    }
    const finishedAttempts: FinishedProviderRequestAttempt[] = [];
    for (const attempt of operation.providerRequestAttempts) {
      if (attempt.result.state === "pending") {
        throw new Error(
          "internal: model operation finished with an unfinished provider request attempt",
        );
      }
      finishedAttempts.push({
        ordinal: attempt.ordinal,
        result: attempt.result,
      });
    }
    if (outcome === "admission_rejected" && finishedAttempts.length > 0) {
      throw new Error(
        "internal: admission-rejected model operation cannot have provider request attempts",
      );
    }
    const accounting = modelOperationAttemptAccounting(finishedAttempts);
    operation.result = {
      state: "finished",
      outcome,
      providerRequestAttempts: finishedAttempts,
      hasCompletedAttempt: accounting.hasCompletedAttempt,
      usage: accounting.usage,
      costUsd: accounting.costUsd,
    };
  };
  const failureOutcome = (error: unknown): ModelOperationOutcome => {
    const errorOutcome = modelOperationOutcomeFromError(error);
    if (
      errorOutcome !== "admission_rejected" ||
      operation.providerRequestAttempts.length === 0
    ) {
      return errorOutcome;
    }
    return operation.providerRequestAttempts.at(-1)?.result.state ===
      "context_overflow"
      ? "context_overflow"
      : "terminal_error";
  };

  return {
    providerRequestAttempts: {
      begin: (): ProviderRequestAttemptHandle => {
        if (operation.result.state !== "pending") {
          throw new Error(
            "internal: provider request attempt started after model operation finished",
          );
        }
        const attempt: MutableProviderRequestAttempt = {
          ordinal: operation.providerRequestAttempts.length + 1,
          result: { state: "pending" },
        };
        operation.providerRequestAttempts.push(attempt);
        return {
          finish: (result): void => {
            const recoveryTarget = finishProviderRequestAttempt(
              attempt,
              result,
              operation.costModel,
            );
            if (recoveryTarget !== null) {
              recoveryTargets.add(recoveryTarget);
              operation.latestContextOverflowRecoveryTarget = recoveryTarget;
            }
          },
        };
      },
    },
    finish: (result) => finishOperation(result.outcome),
    finishFromError: (error) => finishOperation(failureOutcome(error)),
    latestContextOverflowRecoveryTarget: () =>
      operation.latestContextOverflowRecoveryTarget,
  };
}

export function createModelOperationReportLedger(
  currentAgentRun: () => CurrentAgentRunReportOwner | null,
): ModelOperationReportLedger {
  const operations: MutableModelOperation[] = [];
  const recoveryTargets = new WeakSet<ModelOperationRecoveryTarget>();
  return {
    beginModelOperation: (options) =>
      beginModelOperation(
        operations,
        recoveryTargets,
        currentAgentRun(),
        options,
      ),
    modelOperations: () => operations.map(modelOperationReport),
  };
}

export function accountModelOperations(
  operations: readonly RunReportModelOperation[],
): RunReportModelOperationAccounting {
  const usageByModel = new Map<string, RunReportModelUsage>();
  let providerRequestAttemptCount = 0;
  let agentLoopTurns = 0;
  let usage = { ...ZERO_USAGE };
  let costUsd = 0;

  for (const operation of operations) {
    providerRequestAttemptCount += operation.providerRequestAttempts.length;
    const operationAgentLoopTurns =
      operation.purpose === "agent_turn" && operation.outcome === "completed"
        ? 1
        : 0;
    agentLoopTurns += operationAgentLoopTurns;
    const operationUsage = operation.usage;
    const operationCostUsd = operation.costUsd;
    usage = addUsage(usage, operationUsage);
    costUsd += operationCostUsd;

    const key = `${operation.provider}\0${operation.model}`;
    const current = usageByModel.get(key);
    if (current === undefined) {
      usageByModel.set(key, {
        provider: operation.provider,
        model: operation.model,
        agentLoopTurns: operationAgentLoopTurns,
        usage: { ...operationUsage },
        costUsd: operationCostUsd,
      });
      continue;
    }
    usageByModel.set(key, {
      provider: current.provider,
      model: current.model,
      agentLoopTurns: current.agentLoopTurns + operationAgentLoopTurns,
      usage: addUsage(current.usage, operationUsage),
      costUsd: current.costUsd + operationCostUsd,
    });
  }

  const perModel = [...usageByModel.values()];
  return {
    modelOperations: operations,
    modelOperationCount: operations.length,
    providerRequestAttemptCount,
    modelsUsed: perModel.map(({ provider, model }) => ({ provider, model })),
    usageByModel: perModel,
    agentLoopTurns,
    usage,
    costUsd,
  };
}
