import {
  compactMessages,
  contextCompactionStatsForCurrentMessages,
} from "../../agent/context-compaction.ts";
import type { CostReport } from "../../agent/events.ts";
import { restorePostCompactionReads } from "../../agent/post-compaction-restore.ts";
import type { ReadVisibilityState } from "../../agent/read-visibility.ts";
import type { CostModel } from "../../core/cost.ts";
import type { Message, Usage } from "../../llm/types.ts";
import type { ProjectInstructionVisibilityState } from "../../tools/scoped-project-instructions.ts";
import { formatContextCompactionReport } from "../output.ts";
import {
  formatManualCompactionFailure,
  type ManualCompactCommand,
} from "./commands.ts";
import { shouldTrackInteractiveCost } from "./cost.ts";
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
  readonly signal: AbortSignal;
  readonly readVisibility: ReadVisibilityState;
  readonly projectInstructionVisibility: ProjectInstructionVisibilityState;
  readonly nextPostCompactionReadToolCallId: () => string;
  readonly options: InteractiveSessionOptions;
  readonly recordCompactionCost: (
    usage: Usage,
    costModel: CostModel,
  ) => CostReport;
}

export async function executeManualCompaction(
  ctx: ManualCompactContext,
): Promise<CostReport | undefined> {
  const {
    command,
    resolved,
    workspace,
    messages,
    systemPrompt,
    signal,
    readVisibility,
    projectInstructionVisibility,
    nextPostCompactionReadToolCallId,
    options,
    recordCompactionCost,
  } = ctx;
  const manualCostModel = !shouldTrackInteractiveCost(options.cliArgs)
    ? undefined
    : options.requireKnownCostModel(resolved);
  const messagesBeforeCompact = messages.slice();

  try {
    const result = await compactMessages({
      provider: resolved.provider,
      systemPrompt,
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
    });
    if (signal.aborted) {
      messages.splice(0, messages.length, ...messagesBeforeCompact);
      options.writeStdout("\n");
      return undefined;
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
      if (manualCostModel !== undefined) {
        const cost = recordCompactionCost(result.usage, manualCostModel);
        if (options.cliArgs.maxCostUsd !== undefined) {
          options.writeStderr(
            options.formatCostReport(cost, options.cliArgs.maxCostUsd),
          );
        }
        return cost;
      }
    } else {
      options.writeStderr(
        "Context compaction skipped: no safe history to compact.\n",
      );
    }
    return undefined;
  } catch (error) {
    messages.splice(0, messages.length, ...messagesBeforeCompact);
    if (signal.aborted) {
      options.writeStdout("\n");
      return undefined;
    }
    options.writeStderr(formatManualCompactionFailure(error));
    return undefined;
  }
}
