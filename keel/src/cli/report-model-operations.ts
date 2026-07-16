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
  | { readonly type: "session" }
  | { readonly type: "invocation" };

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
      readonly recoveryOperationOrdinal: number | null;
    }
  | { readonly state: "terminal_error" | "aborted" };

type FinishedProviderRequestAttemptResult = Exclude<
  MutableProviderRequestAttemptResult,
  { readonly state: "pending" }
>;

interface MutableProviderRequestAttempt {
  readonly token: symbol;
  readonly ordinal: number;
  result: MutableProviderRequestAttemptResult;
}

function finishedProviderRequestAttemptResult(
  result: MutableProviderRequestAttemptResult,
): FinishedProviderRequestAttemptResult {
  // model operations reject unfinished attempts before report materialization.
  if (result.state === "pending") {
    throw new Error("internal: provider request attempt never finished");
  }
  return result;
}

type MutableModelOperationResult =
  | { readonly state: "pending" }
  | { readonly state: "finished"; readonly outcome: ModelOperationOutcome };

interface MutableModelOperation {
  readonly token: symbol;
  readonly ordinal: number;
  readonly owner: RunReportModelOperationOwner;
  readonly purpose: ModelOperationPurpose;
  readonly provider: string;
  readonly model: string;
  readonly costModel: CostModel;
  readonly providerRequestAttempts: MutableProviderRequestAttempt[];
  result: MutableModelOperationResult;
  latestContextOverflowAttempt: MutableProviderRequestAttempt | null;
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
  // current behavior covers Agent Run and session ownership; invocation is the remaining explicit non-Agent owner variant.
  switch (owner.type) {
    case "current_agent_run":
      // CLI report lifecycle starts an Agent Run before current-agent operations; keep the fail-fast guard at the recorder boundary.
      if (currentAgentRun === null) {
        throw new Error(
          "internal: report model operation requires an active Agent Run owner",
        );
      }
      return { type: "agent_run", ...currentAgentRun };
    case "session":
      return { type: "session" };
    case "invocation":
      // current provider work outside Agent Runs is session-owned; retain the explicit invocation owner contract.
      return { type: "invocation" };
  }
}

function finishProviderRequestAttempt(
  attempt: MutableProviderRequestAttempt,
  result: ProviderRequestAttemptFinish,
  costModel: CostModel,
): void {
  // supported-provider conformance requires each physical attempt handle to finish exactly once.
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
      return;
    case "retryable_error":
      attempt.result = {
        state: "retryable_error",
        retryDecision: { ...result.retryDecision },
      };
      return;
    case "context_overflow":
      attempt.result = {
        state: "context_overflow",
        recoveryOperationOrdinal: null,
      };
      return;
    case "terminal_error":
    case "aborted":
      attempt.result = { state: result.outcome };
      return;
  }
}

function providerRequestAttemptReport(
  attempt: MutableProviderRequestAttempt,
): RunReportProviderRequestAttempt {
  const base = { ordinal: attempt.ordinal };
  const result = finishedProviderRequestAttemptResult(attempt.result);
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
        recoveryOperationOrdinal: result.recoveryOperationOrdinal,
      };
    case "terminal_error":
    case "aborted":
      return { ...base, outcome: result.state };
  }
}

function operationUsage(operation: MutableModelOperation): Usage | null {
  let usage: Usage | null = null;
  for (const attempt of operation.providerRequestAttempts) {
    if (attempt.result.state !== "completed") {
      continue;
    }
    usage = addUsage(usage ?? ZERO_USAGE, attempt.result.usage);
  }
  return usage;
}

function operationCostUsd(operation: MutableModelOperation): number | null {
  let costUsd: number | null = null;
  for (const attempt of operation.providerRequestAttempts) {
    if (attempt.result.state !== "completed") {
      continue;
    }
    costUsd = (costUsd ?? 0) + attempt.result.costUsd;
  }
  return costUsd;
}

function modelOperationReport(
  operation: MutableModelOperation,
): RunReportModelOperation {
  // report lifecycle finishes every operation before requesting its immutable report projection.
  if (operation.result.state === "pending") {
    throw new Error("internal: model operation never finished");
  }
  const base = {
    ordinal: operation.ordinal,
    owner: { ...operation.owner },
    purpose: operation.purpose,
    provider: operation.provider,
    model: operation.model,
    providerRequestAttempts: operation.providerRequestAttempts.map(
      providerRequestAttemptReport,
    ),
  };
  const usage = operationUsage(operation);
  const costUsd = operationCostUsd(operation);
  // a completed operation can only follow a conforming provider's completed attempt with usage.
  if (
    operation.result.outcome === "completed" &&
    (usage === null || costUsd === null)
  ) {
    throw new Error(
      "internal: completed model operation requires a completed provider request attempt",
    );
  }
  return {
    ...base,
    outcome: operation.result.outcome,
    usage: usage ?? { ...ZERO_USAGE },
    costUsd: costUsd ?? 0,
  };
}

function linkRecoveryOperation(
  operations: readonly MutableModelOperation[],
  recoveryFor: ModelOperationRecoveryTarget,
  recoveryOperationOrdinal: number,
): void {
  const operation = operations.find(
    (candidate) => candidate.token === recoveryFor.operationToken,
  );
  const attempt = operation?.providerRequestAttempts.find(
    (candidate) => candidate.token === recoveryFor.attemptToken,
  );
  // recovery targets are opaque handles created only from a recorded context-overflow attempt.
  if (attempt?.result.state !== "context_overflow") {
    throw new Error(
      "internal: report model operation recovery target is not a context overflow attempt",
    );
  }
  // one overflow attempt starts at most one recovery compaction operation.
  if (attempt.result.recoveryOperationOrdinal !== null) {
    throw new Error(
      "internal: provider request attempt already has a recovery operation",
    );
  }
  attempt.result = {
    state: "context_overflow",
    recoveryOperationOrdinal,
  };
}

function beginModelOperation(
  operations: MutableModelOperation[],
  currentAgentRun: CurrentAgentRunReportOwner | null,
  options: BeginModelOperationOptions,
): ModelOperationHandle {
  const operation: MutableModelOperation = {
    token: Symbol("model operation"),
    ordinal: operations.length + 1,
    owner: resolveOperationOwner(options.owner, currentAgentRun),
    purpose: options.purpose,
    provider: options.provider,
    model: options.model,
    costModel: options.costModel,
    providerRequestAttempts: [],
    result: { state: "pending" },
    latestContextOverflowAttempt: null,
  };
  if (options.recoveryFor !== null) {
    linkRecoveryOperation(operations, options.recoveryFor, operation.ordinal);
  }
  operations.push(operation);

  const finishOperation = (outcome: ModelOperationOutcome): void => {
    // each operation-owning control path has one terminal finish site.
    if (operation.result.state !== "pending") {
      throw new Error("internal: model operation finished twice");
    }
    // supported-provider conformance finishes the physical attempt before its logical operation.
    if (
      operation.providerRequestAttempts.some(
        (attempt) => attempt.result.state === "pending",
      )
    ) {
      throw new Error(
        "internal: model operation finished with an unfinished provider request attempt",
      );
    }
    // admission rejection occurs before the provider attempt hook; post-attempt rejections are normalized below.
    if (
      outcome === "admission_rejected" &&
      operation.providerRequestAttempts.length > 0
    ) {
      throw new Error(
        "internal: admission-rejected model operation cannot have provider request attempts",
      );
    }
    operation.result = { state: "finished", outcome };
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
        // provider conformance cannot begin a physical attempt after its owning operation finishes.
        if (operation.result.state !== "pending") {
          throw new Error(
            "internal: provider request attempt started after model operation finished",
          );
        }
        const attempt: MutableProviderRequestAttempt = {
          token: Symbol("provider request attempt"),
          ordinal: operation.providerRequestAttempts.length + 1,
          result: { state: "pending" },
        };
        operation.providerRequestAttempts.push(attempt);
        return {
          finish: (result): void => {
            finishProviderRequestAttempt(attempt, result, operation.costModel);
            if (result.outcome === "context_overflow") {
              operation.latestContextOverflowAttempt = attempt;
            }
          },
        };
      },
    },
    finish: (result) => finishOperation(result.outcome),
    finishFromError: (error) => finishOperation(failureOutcome(error)),
    latestContextOverflowRecoveryTarget: () => {
      const attempt = operation.latestContextOverflowAttempt;
      // recovery lookup is called only after a conforming provider records context overflow.
      if (attempt === null) {
        return null;
      }
      return {
        operationToken: operation.token,
        attemptToken: attempt.token,
      };
    },
  };
}

export function createModelOperationReportLedger(
  currentAgentRun: () => CurrentAgentRunReportOwner | null,
): ModelOperationReportLedger {
  const operations: MutableModelOperation[] = [];
  return {
    beginModelOperation: (options) =>
      beginModelOperation(operations, currentAgentRun(), options),
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
