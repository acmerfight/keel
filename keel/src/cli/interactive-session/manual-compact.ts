import {
  compactMessages,
  contextCompactionStatsForCurrentMessages,
} from "../../agent/context-compaction.ts";
import { CostBudgetAdmissionError } from "../../agent/cost-budget.ts";
import type { CostReport } from "../../agent/events.ts";
import type { MainModelOperationInstrumentation } from "../../agent/model-operations.ts";
import { restorePostCompactionReads } from "../../agent/post-compaction-restore.ts";
import type { ReadVisibilityState } from "../../agent/read-visibility.ts";
import type { SessionMessage } from "../../agent/session-message.ts";
import type { CostModel } from "../../core/cost.ts";
import { modelMetadataMaxOutputTokens } from "../../core/model-metadata.ts";
import type { SessionTaskProgress } from "../../core/task-progress.ts";
import type { Usage } from "../../llm/types.ts";
import type { ProjectInstructionVisibilityState } from "../../tools/scoped-project-instructions.ts";
import {
  formatContextCompactionReport,
  formatToolOutputArtifactNotice,
} from "../agent-event-format.ts";
import {
  formatManualCompactionFailure,
  type ManualCompactCommand,
} from "./commands.ts";
import {
  createInteractiveCostBudgetedProvider,
  type InteractiveCompactionCost,
} from "./cost.ts";
import type {
  InteractiveResolvedProvider,
  InteractiveSessionOptions,
} from "./types.ts";

export interface ManualCompactContext {
  readonly command: ManualCompactCommand;
  readonly resolved: InteractiveResolvedProvider;
  readonly workspace: string;
  readonly messages: SessionMessage[];
  readonly systemPrompt: string;
  readonly summarySystemPrompt: string;
  readonly signal: AbortSignal;
  readonly readVisibility: ReadVisibilityState;
  readonly projectInstructionVisibility: ProjectInstructionVisibilityState;
  readonly nextPostCompactionReadToolCallId: () => string;
  readonly taskProgress: SessionTaskProgress;
  readonly options: Pick<
    InteractiveSessionOptions,
    "cliArgs" | "display" | "toolOutputArtifacts"
  >;
  readonly recordCompactionCost: (
    usage: Usage,
    costModel: CostModel,
  ) => CostReport;
  readonly compactionCost: InteractiveCompactionCost;
  readonly modelOperations: MainModelOperationInstrumentation | null;
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
  const display = options.display;
  const manualCostModel =
    compactionCost.kind === "untracked" ? undefined : compactionCost.model;
  const messagesBeforeCompact = messages.slice();
  const modelMaxOutputTokens = modelMetadataMaxOutputTokens(
    resolved.modelMetadata,
  );
  const provider =
    compactionCost.kind !== "budgeted"
      ? resolved.provider
      : createInteractiveCostBudgetedProvider({
          provider: resolved.provider,
          model: compactionCost.model,
          admission: compactionCost.admission,
          modelMaxOutputTokens,
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
      display.writeStdout("\n");
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
      display.writeStderr(
        formatContextCompactionReport({
          ...reportStats,
          reasonLabel: "manual",
        }),
      );
      for (const notice of result.artifactNotices ?? []) {
        display.writeStderr(`${formatToolOutputArtifactNotice(notice)}\n`);
      }
      if (manualCostModel !== undefined) {
        const cost = recordCompactionCost(result.usage, manualCostModel);
        if (options.cliArgs.maxCostUsd !== undefined) {
          display.writeStderr(display.formatCostReport(cost));
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
        display.writeStderr(display.formatCostReport(cost));
        return { status: "not_committed", cost };
      }
      display.writeStderr(
        formatManualCompactionFailure(result.failure.message),
      );
      if (failedCost !== undefined) {
        const cost = failedCost;
        if (options.cliArgs.maxCostUsd !== undefined) {
          display.writeStderr(display.formatCostReport(cost));
        }
        return { status: "not_committed", cost };
      }
    } else {
      display.writeStderr(
        "Context compaction skipped: no safe history to compact.\n",
      );
    }
    return { status: "not_committed" };
  } catch (error) {
    messages.splice(0, messages.length, ...messagesBeforeCompact);
    if (signal.aborted) {
      display.writeStdout("\n");
      return { status: "not_committed" };
    }
    if (
      compactionCost.kind === "budgeted" &&
      error instanceof CostBudgetAdmissionError
    ) {
      const cost = compactionCost.budgetLimitedReport();
      display.writeStderr(display.formatCostReport(cost));
      return { status: "not_committed", cost };
    }
    display.writeStderr(formatManualCompactionFailure(error));
    return { status: "not_committed" };
  }
}
