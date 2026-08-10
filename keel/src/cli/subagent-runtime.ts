import type { ContextCompactionOptions } from "../agent/context-compaction.ts";
import { createSharedCostBudgetedProvider } from "../agent/cost-budget.ts";
import type { MainModelOperationInstrumentation } from "../agent/model-operations.ts";
import type { ProjectInstructions } from "../agent/prompt.ts";
import type { SubagentLifecyclePersistence } from "../agent/subagent-lifecycle.ts";
import {
  createSubagentSupervisor,
  type SubagentProgressEvent,
  type SubagentSupervisor,
} from "../agent/subagent-supervisor.ts";
import { createSubagentTreeProvider } from "../agent/subagent-tree-provider.ts";
import type { AbortableToolOutputArtifactStore } from "../agent/tool-output-artifacts.ts";
import type { CostModel } from "../core/cost.ts";
import type { LLMProvider } from "../llm/types.ts";

interface CreateCliSubagentRuntimeOptions {
  readonly workspace: string;
  readonly platform: string;
  readonly parentRunId: string;
  readonly provider: LLMProvider;
  readonly providerId: string;
  readonly model: string;
  readonly costModel: CostModel;
  readonly maxCostUsd: number;
  readonly projectInstructions: ProjectInstructions | undefined;
  readonly hiddenWorkspacePaths: readonly string[];
  readonly contextCompaction: ContextCompactionOptions | undefined;
  readonly modelMaxOutputTokens: number | undefined;
  readonly modelOperations: MainModelOperationInstrumentation | undefined;
  readonly transcriptStore: AbortableToolOutputArtifactStore;
  readonly lifecyclePersistence?: SubagentLifecyclePersistence;
  readonly now: () => number;
  readonly onProgress: (event: SubagentProgressEvent) => void;
}

export interface CliSubagentRuntime {
  readonly costBudgetProvider: LLMProvider;
  readonly supervisor: SubagentSupervisor;
}

export function createCliSubagentRuntime(
  options: CreateCliSubagentRuntimeOptions,
): CliSubagentRuntime {
  const treeProvider = createSubagentTreeProvider({
    provider: options.provider,
  });
  const rootBudget = createSharedCostBudgetedProvider({
    provider: treeProvider.provider,
    model: options.costModel,
    maxCostUsd: options.maxCostUsd,
    ...(options.modelMaxOutputTokens !== undefined
      ? { modelMaxOutputTokens: options.modelMaxOutputTokens }
      : {}),
  });
  return {
    costBudgetProvider: rootBudget.provider,
    supervisor: createSubagentSupervisor({
      workspace: options.workspace,
      platform: options.platform,
      parentRunId: options.parentRunId,
      provider: rootBudget.provider,
      providerId: options.providerId,
      model: options.model,
      costModel: options.costModel,
      rootBudget,
      ...(options.projectInstructions !== undefined
        ? { projectInstructions: options.projectInstructions }
        : {}),
      hiddenWorkspacePaths: options.hiddenWorkspacePaths,
      ...(options.contextCompaction !== undefined
        ? { contextCompaction: options.contextCompaction }
        : {}),
      ...(options.modelMaxOutputTokens !== undefined
        ? { modelMaxOutputTokens: options.modelMaxOutputTokens }
        : {}),
      ...(options.modelOperations !== undefined
        ? { modelOperations: options.modelOperations }
        : {}),
      transcriptStore: options.transcriptStore,
      ...(options.lifecyclePersistence !== undefined
        ? { lifecyclePersistence: options.lifecyclePersistence }
        : {}),
      now: options.now,
      onProgress: options.onProgress,
      providerBlocked: treeProvider.blocked,
    }),
  };
}
