import {
  compactMessages,
  contextCompactionStatsForCurrentMessages,
  shouldCompactBeforeRequest,
} from "../../agent/context-compaction.ts";
import type { CostReport } from "../../agent/events.ts";
import { restorePostCompactionReads } from "../../agent/post-compaction-restore.ts";
import type { ReadVisibilityState } from "../../agent/read-visibility.ts";
import type { CostModel } from "../../core/cost.ts";
import type { SessionTaskProgress } from "../../core/task-progress.ts";
import type { Message, Usage } from "../../llm/types.ts";
import { bashModeExposesTool } from "../../permissions/bash.ts";
import type { ProjectInstructionVisibilityState } from "../../tools/scoped-project-instructions.ts";
import {
  formatContextCompactionReport,
  formatToolOutputArtifactNotice,
} from "../output.ts";
import { formatManualCompactionFailure } from "./commands.ts";
import { shouldTrackInteractiveCost } from "./cost.ts";
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
}

export type ModelSwitchCompactionResult =
  | {
      readonly status: "accepted";
      readonly cost?: CostReport;
    }
  | { readonly status: "rejected" };

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
    { allowBash: options.bashToolVisible },
  );
}

export function modelSwitchRequiresCompaction(options: {
  readonly systemPrompt: string;
  readonly messages: readonly Message[];
  readonly target: InteractiveResolvedProvider;
  readonly cliArgs: InteractiveSessionOptions["cliArgs"];
}): boolean {
  return switchWouldOverflowTargetContext({
    systemPrompt: options.systemPrompt,
    messages: options.messages,
    target: options.target,
    bashToolVisible: bashModeExposesTool(options.cliArgs.bashMode),
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
    signal,
    readVisibility,
    projectInstructionVisibility,
    nextPostCompactionReadToolCallId,
    taskProgress,
    options,
    recordCompactionCost,
  } = ctx;
  const compactionCostModel = !shouldTrackInteractiveCost(options.cliArgs)
    ? undefined
    : options.requireKnownCostModel(current);
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

  try {
    const result = await compactMessages({
      provider: current.provider,
      systemPrompt,
      messages,
      signal,
      ...(target.contextCompaction !== undefined
        ? { contextCompaction: target.contextCompaction }
        : {}),
      ...(options.toolOutputArtifacts !== undefined
        ? { toolOutputArtifacts: options.toolOutputArtifacts }
        : {}),
      taskProgress,
    });
    if (signal.aborted) {
      rollback();
      options.writeStdout("\n");
      return { status: "rejected" };
    }
    if (!result.compacted) {
      rollback();
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
        bashToolVisible: bashModeExposesTool(options.cliArgs.bashMode),
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
        allowBash: bashModeExposesTool(options.cliArgs.bashMode),
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
      options.writeStderr(
        options.formatCostReport(cost, options.cliArgs.maxCostUsd),
      );
    }
    return { status: "accepted", cost };
  } catch (error) {
    rollback();
    if (signal.aborted) {
      options.writeStdout("\n");
      return { status: "rejected" };
    }
    options.writeStderr(formatManualCompactionFailure(error));
    return { status: "rejected" };
  }
}
