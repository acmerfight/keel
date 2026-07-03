import {
  compactMessages,
  contextCompactionStatsForCurrentMessages,
  shouldCompactBeforeRequest,
} from "../../agent/context-compaction.ts";
import {
  buildContextRescueReport,
  contextRescueReasonDetail,
  isProviderContextOverflowError,
} from "../../agent/context-rescue.ts";
import type { CostReport } from "../../agent/events.ts";
import { restorePostCompactionReads } from "../../agent/post-compaction-restore.ts";
import type { ReadVisibilityState } from "../../agent/read-visibility.ts";
import type { CostModel } from "../../core/cost.ts";
import type { Message, Usage } from "../../llm/types.ts";
import type { ProjectInstructionVisibilityState } from "../../tools/scoped-project-instructions.ts";
import {
  formatContextCompactionReport,
  formatContextRescueReport,
  formatToolOutputArtifactNotice,
} from "../output.ts";
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
      for (const notice of result.artifactNotices ?? []) {
        options.writeStderr(`${formatToolOutputArtifactNotice(notice)}\n`);
      }
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
      if (
        shouldCompactBeforeRequest(
          systemPrompt,
          messages,
          resolved.contextCompaction,
        )
      ) {
        options.writeStderr(
          formatContextRescueReport(
            await buildContextRescueReport({
              reason: "no_safe_compaction_split",
              reasonDetail:
                "The current session is over budget, but no tool-safe historical boundary is available for manual compaction.",
              systemPrompt,
              messages,
              contextCompaction: resolved.contextCompaction,
              toolOutputArtifacts: options.toolOutputArtifacts,
            }),
          ),
        );
      } else {
        options.writeStderr(
          "Context compaction skipped: no safe history to compact.\n",
        );
      }
    }
    return undefined;
  } catch (error) {
    messages.splice(0, messages.length, ...messagesBeforeCompact);
    if (signal.aborted) {
      options.writeStdout("\n");
      return undefined;
    }
    if (isProviderContextOverflowError(error)) {
      options.writeStderr(
        formatContextRescueReport(
          await buildContextRescueReport({
            reason: "summary_request_overflow",
            reasonDetail: contextRescueReasonDetail(error),
            systemPrompt,
            messages,
            contextCompaction: resolved.contextCompaction,
            toolOutputArtifacts: options.toolOutputArtifacts,
          }),
        ),
      );
      return undefined;
    }
    options.writeStderr(formatManualCompactionFailure(error));
    return undefined;
  }
}
