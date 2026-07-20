import {
  compactMessages,
  contextCompactionStatsForCurrentMessages,
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
import {
  formatManualCompactionFailure,
  type ManualCompactCommand,
} from "./commands.ts";
import type { InteractiveCompactionCost } from "./cost.ts";
import type {
  InteractiveResolvedProvider,
  InteractiveSessionOptions,
} from "./types.ts";

export interface ManualCompactContext {
  readonly command: ManualCompactCommand;
  readonly resolved: InteractiveResolvedProvider;
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
  readonly recordCompactionCost: (
    usage: Usage,
    costModel: CostModel,
  ) => CostReport;
  readonly compactionCost: InteractiveCompactionCost;
  readonly modelOperations: ModelOperationInstrumentation | null;
}

export interface ManualCompactionResult {
  readonly status: "committed" | "not_committed";
  readonly cost?: CostReport;
}

export async function executeManualCompaction(
  ctx: ManualCompactContext,
): Promise<ManualCompactionResult> {
  const {
    command,
    resolved,
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
    recordCompactionCost,
    compactionCost,
    modelOperations,
  } = ctx;
  const manualCostModel =
    compactionCost.kind === "untracked" ? undefined : compactionCost.model;
  const messagesBeforeCompact = messages.slice();
  const modelMaxOutputTokens = modelMetadataMaxOutputTokens(
    resolved.modelMetadata,
  );
  const provider =
    compactionCost.kind !== "budgeted"
      ? resolved.provider
      : createCostBudgetedProvider({
          provider: resolved.provider,
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
      ...(resolved.contextCompaction !== undefined
        ? { contextCompaction: resolved.contextCompaction }
        : {}),
      ...(command.focusInstruction !== undefined
        ? { focusInstruction: command.focusInstruction }
        : {}),
      ...(options.toolOutputArtifacts !== undefined
        ? { toolOutputArtifacts: options.toolOutputArtifacts }
        : {}),
      taskProgress,
      ...(modelOperations !== null
        ? {
            modelOperation: {
              instrumentation: modelOperations,
              purpose: "manual_compaction" as const,
              recoveryFor: null,
            },
          }
        : {}),
    });
    if (signal.aborted) {
      messages.splice(0, messages.length, ...messagesBeforeCompact);
      const cost =
        manualCostModel === undefined
          ? undefined
          : recordCompactionCost(result.usage, manualCostModel);
      options.writeStdout("\n");
      return {
        status: "not_committed",
        ...(cost !== undefined ? { cost } : {}),
      };
    }
    if (result.compacted) {
      await restorePostCompactionReads({
        workspace,
        signal,
        readVisibility,
        projectInstructionVisibility,
        messages,
        nextToolCallId: nextPostCompactionReadToolCallId,
      });
      const reportStats = contextCompactionStatsForCurrentMessages({
        stats: result.stats,
        systemPrompt,
        messages,
      });
      options.writeStderr(
        formatContextCompactionReport({
          ...reportStats,
          reasonLabel: "manual",
        }),
      );
      for (const notice of result.artifactNotices ?? []) {
        options.writeStderr(`${formatToolOutputArtifactNotice(notice)}\n`);
      }
      if (manualCostModel !== undefined) {
        const cost = recordCompactionCost(result.usage, manualCostModel);
        if (options.cliArgs.maxCostUsd !== undefined) {
          options.writeStderr(options.formatCostReport(cost));
        }
        return { status: "committed", cost };
      }
      return { status: "committed" };
    }
    if (result.failure !== undefined) {
      messages.splice(0, messages.length, ...messagesBeforeCompact);
      const failedCost =
        manualCostModel === undefined
          ? undefined
          : recordCompactionCost(result.usage, manualCostModel);
      if (
        result.failure.code === "summary_error" &&
        compactionCost.kind === "budgeted" &&
        result.failure.error instanceof CostBudgetAdmissionError
      ) {
        const cost = compactionCost.budgetLimitedReport();
        options.writeStderr(options.formatCostReport(cost));
        return { status: "not_committed", cost };
      }
      options.writeStderr(
        formatManualCompactionFailure(result.failure.message),
      );
      if (failedCost !== undefined) {
        const cost = failedCost;
        if (options.cliArgs.maxCostUsd !== undefined) {
          options.writeStderr(options.formatCostReport(cost));
        }
        return { status: "not_committed", cost };
      }
    } else {
      options.writeStderr(
        "Context compaction skipped: no safe history to compact.\n",
      );
    }
    return { status: "not_committed" };
  } catch (error) {
    messages.splice(0, messages.length, ...messagesBeforeCompact);
    if (signal.aborted) {
      options.writeStdout("\n");
      return { status: "not_committed" };
    }
    if (
      compactionCost.kind === "budgeted" &&
      error instanceof CostBudgetAdmissionError
    ) {
      const cost = compactionCost.budgetLimitedReport();
      options.writeStderr(options.formatCostReport(cost));
      return { status: "not_committed", cost };
    }
    options.writeStderr(formatManualCompactionFailure(error));
    return { status: "not_committed" };
  }
}
