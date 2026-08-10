import type { ContextCompactionOptions } from "../agent/context-compaction.ts";
import {
  createSharedCostBudgetedProvider,
  type SharedCostBudgetAccount,
} from "../agent/cost-budget.ts";
import type { MainModelOperationInstrumentation } from "../agent/model-operations.ts";
import type { ProjectInstructions } from "../agent/prompt.ts";
import type { SubagentLifecyclePersistence } from "../agent/subagent-lifecycle.ts";
import {
  createSubagentSupervisor,
  type SubagentBackgroundRuntime,
  type SubagentProgressEvent,
  type SubagentSupervisor,
} from "../agent/subagent-supervisor.ts";
import type { SubagentTreeAdmission } from "../agent/subagent-tree-admission.ts";
import type { SubagentTreeProviderCoordination } from "../agent/subagent-tree-provider.ts";
import { createSubagentTreeProvider } from "../agent/subagent-tree-provider.ts";
import type { AbortableToolOutputArtifactStore } from "../agent/tool-output-artifacts.ts";
import type { CostModel } from "../core/cost.ts";
import type { LLMProvider } from "../llm/types.ts";

interface CreateCliSubagentRuntimeOptionsBase {
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
  readonly now: () => number;
  readonly onProgress: (event: SubagentProgressEvent) => void;
}

interface AttachedSubagentSession {
  readonly lifecyclePersistence: SubagentLifecyclePersistence;
  readonly costBudget: SharedCostBudgetAccount;
  readonly admission: SubagentTreeAdmission;
  readonly providerCoordination: SubagentTreeProviderCoordination;
  readonly background: SubagentBackgroundRuntime;
  readonly modelOperations: MainModelOperationInstrumentation | undefined;
}

type CreateCliSubagentRuntimeOptions = CreateCliSubagentRuntimeOptionsBase &
  (
    | {
        readonly attachedSession?: never;
      }
    | {
        readonly attachedSession: AttachedSubagentSession;
        readonly lifecyclePersistence?: never;
      }
  );

export interface CliSubagentRuntime {
  readonly costBudgetProvider: LLMProvider;
  readonly supervisor: SubagentSupervisor;
}

export function createCliSubagentRuntime(
  options: CreateCliSubagentRuntimeOptions,
): CliSubagentRuntime {
  const treeProvider = createSubagentTreeProvider({
    provider: options.provider,
    ...(options.attachedSession !== undefined
      ? { coordination: options.attachedSession.providerCoordination }
      : {}),
  });
  const rootBudget = createSharedCostBudgetedProvider({
    provider: treeProvider.provider,
    model: options.costModel,
    maxCostUsd: options.maxCostUsd,
    ...(options.attachedSession !== undefined
      ? { sharedAccount: options.attachedSession.costBudget }
      : {}),
    ...(options.modelMaxOutputTokens !== undefined
      ? { modelMaxOutputTokens: options.modelMaxOutputTokens }
      : {}),
  });
  const lifecycleOwnership =
    options.attachedSession === undefined
      ? {}
      : {
          background: options.attachedSession.background,
          lifecyclePersistence: options.attachedSession.lifecyclePersistence,
          backgroundModelOperations: options.attachedSession.modelOperations,
        };
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
      ...(options.attachedSession !== undefined
        ? { admission: options.attachedSession.admission }
        : {}),
      ...lifecycleOwnership,
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
      now: options.now,
      onProgress: options.onProgress,
      providerBlocked: treeProvider.blocked,
    }),
  };
}
