import {
  compactMessages,
  contextCompactionStatsForCurrentMessages,
  shouldCompactBeforeRequest,
} from "../../agent/context-compaction.ts";
import {
  CostBudgetAdmissionError,
  createCostBudgetedProvider,
} from "../../agent/cost-budget.ts";
import type { CostReport } from "../../agent/events.ts";
import type { ModelOperationInstrumentation } from "../../agent/model-operations.ts";
import { restorePostCompactionReads } from "../../agent/post-compaction-restore.ts";
import type { ReadVisibilityState } from "../../agent/read-visibility.ts";
import type { CostModel } from "../../core/cost.ts";
import { modelMetadataMaxOutputTokens } from "../../core/model-metadata.ts";
import type { SessionTaskProgress } from "../../core/task-progress.ts";
import type { Message, Usage } from "../../llm/types.ts";
import type { ProjectInstructionVisibilityState } from "../../tools/scoped-project-instructions.ts";
import {
  formatContextCompactionReport,
  formatToolOutputArtifactNotice,
} from "../output.ts";
import { formatManualCompactionFailure } from "./commands.ts";
import type { InteractiveCompactionCost } from "./cost.ts";
import type {
  InteractiveResolvedProvider,
  InteractiveSessionOptions,
} from "./types.ts";

export interface ModelSwitchCompactionContext {
  readonly current: InteractiveResolvedProvider;
  readonly target: InteractiveResolvedProvider;
  readonly workspace: string;
  readonly messages: Message[];
  readonly systemPrompt: string;
  readonly summarySystemPrompt: string;
  readonly signal: AbortSignal;
  readonly readVisibility: ReadVisibilityState;
  readonly projectInstructionVisibility: ProjectInstructionVisibilityState;
  readonly nextPostCompactionReadToolCallId: () => string;
  readonly taskProgress: SessionTaskProgress;
  readonly options: InteractiveSessionOptions;
  readonly bashToolVisible: boolean;
  readonly recordCompactionCost: (
    usage: Usage,
    costModel: CostModel,
  ) => CostReport;
  readonly compactionCost: InteractiveCompactionCost;
  readonly modelOperations: ModelOperationInstrumentation | null;
}

export type ModelSwitchCompactionResult =
  | {
      readonly status: "accepted";
      readonly cost?: CostReport;
    }
  | { readonly status: "rejected"; readonly cost?: CostReport };

type VisibleReadSnapshot = ReturnType<
  ReadVisibilityState["visibleReadsMostRecentFirst"]
>[number];
type VisibleProjectInstructionSnapshot = ReturnType<
  ProjectInstructionVisibilityState["visibleInstructionsMostRecentFirst"]
>[number];

function restoreReadVisibility(
  state: ReadVisibilityState,
  snapshots: readonly VisibleReadSnapshot[],
): void {
  state.clear();
  state.applyVisibleToolExecutions(
    snapshots
      .slice()
      .reverse()
      .map((snapshot) => ({
        // applyVisibleToolExecutions uses only read metadata for read visibility.
        content: "",
        ok: true,
        readTargetPath: snapshot.targetPath,
        ...(snapshot.offset !== undefined
          ? { readTargetOffset: snapshot.offset }
          : {}),
        ...(snapshot.limit !== undefined
          ? { readTargetLimit: snapshot.limit }
          : {}),
      })),
  );
}

function restoreProjectInstructionVisibility(
  state: ProjectInstructionVisibilityState,
  snapshots: readonly VisibleProjectInstructionSnapshot[],
): void {
  state.clear();
  state.markInstructionPathsVisible(
    snapshots
      .slice()
      .reverse()
      .map((snapshot) => snapshot.instructionPath),
  );
}

function rollbackModelSwitchCompaction(options: {
  readonly messages: Message[];
  readonly messagesBeforeCompact: readonly Message[];
  readonly readVisibility: ReadVisibilityState;
  readonly readVisibilityBeforeCompact: readonly VisibleReadSnapshot[];
  readonly projectInstructionVisibility: ProjectInstructionVisibilityState;
  readonly projectInstructionVisibilityBeforeCompact: readonly VisibleProjectInstructionSnapshot[];
}): void {
  options.messages.splice(
    0,
    options.messages.length,
    ...options.messagesBeforeCompact,
  );
  restoreReadVisibility(
    options.readVisibility,
    options.readVisibilityBeforeCompact,
  );
  restoreProjectInstructionVisibility(
    options.projectInstructionVisibility,
    options.projectInstructionVisibilityBeforeCompact,
  );
}

function switchWouldOverflowTargetContext(options: {
  readonly systemPrompt: string;
  readonly messages: readonly Message[];
  readonly target: InteractiveResolvedProvider;
  readonly bashToolVisible: boolean;
}): boolean {
  if (options.messages.length === 0) {
    return false;
  }
  return shouldCompactBeforeRequest(
    options.systemPrompt,
    options.messages,
    options.target.contextCompaction,
    undefined,
    {
      kind: "auto",
      ...(options.bashToolVisible ? { bash: true } : {}),
    },
  );
}

export function modelSwitchRequiresCompaction(options: {
  readonly systemPrompt: string;
  readonly messages: readonly Message[];
  readonly target: InteractiveResolvedProvider;
  readonly bashToolVisible: boolean;
}): boolean {
  return switchWouldOverflowTargetContext({
    systemPrompt: options.systemPrompt,
    messages: options.messages,
    target: options.target,
    bashToolVisible: options.bashToolVisible,
  });
}

export async function executeModelSwitchCompaction(
  ctx: ModelSwitchCompactionContext,
): Promise<ModelSwitchCompactionResult> {
  const {
    current,
    target,
    workspace,
    messages,
    systemPrompt,
    summarySystemPrompt,
    signal,
    readVisibility,
    projectInstructionVisibility,
    nextPostCompactionReadToolCallId,
    taskProgress,
    options,
    bashToolVisible,
    recordCompactionCost,
    compactionCost,
    modelOperations,
  } = ctx;
  const compactionCostModel =
    compactionCost.kind === "untracked" ? undefined : compactionCost.model;
  const messagesBeforeCompact = messages.slice();
  const readVisibilityBeforeCompact =
    readVisibility.visibleReadsMostRecentFirst();
  const projectInstructionVisibilityBeforeCompact =
    projectInstructionVisibility.visibleInstructionsMostRecentFirst();
  const rollback = (): void => {
    rollbackModelSwitchCompaction({
      messages,
      messagesBeforeCompact,
      readVisibility,
      readVisibilityBeforeCompact,
      projectInstructionVisibility,
      projectInstructionVisibilityBeforeCompact,
    });
  };
  const modelMaxOutputTokens = modelMetadataMaxOutputTokens(
    current.modelMetadata,
  );
  const provider =
    compactionCost.kind !== "budgeted"
      ? current.provider
      : createCostBudgetedProvider({
          provider: current.provider,
          model: compactionCost.model,
          maxCostUsd: compactionCost.remainingCostUsd,
          ...(modelMaxOutputTokens !== undefined
            ? { modelMaxOutputTokens }
            : {}),
        });

  try {
    const result = await compactMessages({
      provider,
      systemPrompt,
      summarySystemPrompt,
      messages,
      signal,
      ...(target.contextCompaction !== undefined
        ? { contextCompaction: target.contextCompaction }
        : {}),
      ...(options.toolOutputArtifacts !== undefined
        ? { toolOutputArtifacts: options.toolOutputArtifacts }
        : {}),
      taskProgress,
      ...(modelOperations !== null
        ? {
            modelOperation: {
              instrumentation: modelOperations,
              purpose: "model_switch_compaction" as const,
              recoveryFor: null,
            },
          }
        : {}),
    });
    if (signal.aborted) {
      rollback();
      const cost =
        compactionCostModel === undefined
          ? undefined
          : recordCompactionCost(result.usage, compactionCostModel);
      options.writeStdout("\n");
      return {
        status: "rejected",
        ...(cost !== undefined ? { cost } : {}),
      };
    }
    if (!result.compacted) {
      rollback();
      if (result.failure !== undefined) {
        const failedCost =
          compactionCostModel === undefined
            ? undefined
            : recordCompactionCost(result.usage, compactionCostModel);
        if (
          result.failure.code === "summary_error" &&
          compactionCost.kind === "budgeted" &&
          result.failure.error instanceof CostBudgetAdmissionError
        ) {
          const cost = compactionCost.budgetLimitedReport();
          options.writeStderr(options.formatCostReport(cost));
          return { status: "rejected", cost };
        }
        options.writeStderr(
          formatManualCompactionFailure(result.failure.message),
        );
        if (failedCost !== undefined) {
          const cost = failedCost;
          if (options.cliArgs.maxCostUsd !== undefined) {
            options.writeStderr(options.formatCostReport(cost));
          }
          return { status: "rejected", cost };
        }
        return { status: "rejected" };
      }
      options.writeStderr(
        "Context compaction skipped: no safe history to compact.\n",
      );
      return { status: "rejected" };
    }

    await restorePostCompactionReads({
      workspace,
      signal,
      readVisibility,
      projectInstructionVisibility,
      messages,
      nextToolCallId: nextPostCompactionReadToolCallId,
    });
    if (signal.aborted) {
      rollback();
      options.writeStdout("\n");
      return { status: "rejected" };
    }
    if (
      switchWouldOverflowTargetContext({
        systemPrompt,
        messages,
        target,
        bashToolVisible,
      })
    ) {
      rollback();
      options.writeStderr(
        `Error: switching to ${target.providerId}/${target.model} still exceeds the target context window after model-switch compaction.\n`,
      );
      return { status: "rejected" };
    }

    const reportStats = contextCompactionStatsForCurrentMessages({
      stats: result.stats,
      systemPrompt,
      messages,
      requestMetadata: {
        kind: "auto",
        ...(bashToolVisible ? { bash: true } : {}),
      },
    });
    options.writeStderr(
      formatContextCompactionReport({
        ...reportStats,
        reasonLabel: "model switch",
      }),
    );
    for (const notice of result.artifactNotices ?? []) {
      options.writeStderr(`${formatToolOutputArtifactNotice(notice)}\n`);
    }
    if (compactionCostModel === undefined) {
      return { status: "accepted" };
    }
    const cost = recordCompactionCost(result.usage, compactionCostModel);
    if (options.cliArgs.maxCostUsd !== undefined) {
      options.writeStderr(options.formatCostReport(cost));
    }
    return { status: "accepted", cost };
  } catch (error) {
    rollback();
    if (signal.aborted) {
      options.writeStdout("\n");
      return { status: "rejected" };
    }
    if (
      compactionCost.kind === "budgeted" &&
      error instanceof CostBudgetAdmissionError
    ) {
      const cost = compactionCost.budgetLimitedReport();
      options.writeStderr(options.formatCostReport(cost));
      return { status: "rejected", cost };
    }
    options.writeStderr(formatManualCompactionFailure(error));
    return { status: "rejected" };
  }
}
