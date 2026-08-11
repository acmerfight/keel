import type { ContextCompactionOptions } from "../agent/context-compaction.ts";
import {
  createSharedCostBudgetAccount,
  createSharedCostBudgetedProvider,
  type SharedCostBudgetAccount,
} from "../agent/cost-budget.ts";
import type { MainModelOperationInstrumentation } from "../agent/model-operations.ts";
import type { ProjectInstructions } from "../agent/prompt.ts";
import type { SubagentLifecyclePersistence } from "../agent/subagent-lifecycle.ts";
import {
  createSubagentProfileRegistry,
  type SubagentExecutionSnapshot,
} from "../agent/subagent-profile.ts";
import {
  createSubagentSupervisor,
  type SubagentBackgroundRuntime,
  type SubagentExecutionRuntime,
  type SubagentProgressEvent,
  type SubagentSupervisor,
} from "../agent/subagent-supervisor.ts";
import type { SubagentTreeAdmission } from "../agent/subagent-tree-admission.ts";
import {
  createSubagentTreeProvider,
  createSubagentTreeProviderCoordination,
  type SubagentTreeProviderCoordination,
} from "../agent/subagent-tree-provider.ts";
import type { AbortableToolOutputArtifactStore } from "../agent/tool-output-artifacts.ts";
import type { CostModel } from "../core/cost.ts";
import type { ModelMetadata } from "../core/model-metadata.ts";
import type { ProviderId } from "../core/provider-id.ts";
import type { LLMProvider } from "../llm/types.ts";
import { loadRepoSubagentProfiles } from "./subagent-profile-config.ts";

interface CreateCliSubagentRuntimeOptionsBase {
  readonly workspace: string;
  readonly platform: string;
  readonly parentRunId: string;
  readonly provider: LLMProvider;
  readonly providerId: ProviderId;
  readonly model: string;
  readonly costModel: CostModel;
  readonly modelMetadata: ModelMetadata;
  readonly maxCostUsd: number;
  readonly projectInstructions: ProjectInstructions | undefined;
  readonly hiddenWorkspacePaths: readonly string[];
  readonly contextCompaction: ContextCompactionOptions | undefined;
  readonly modelMaxOutputTokens: number | undefined;
  readonly modelOperations: MainModelOperationInstrumentation | undefined;
  readonly transcriptStore: AbortableToolOutputArtifactStore;
  readonly now: () => number;
  readonly onProgress: (event: SubagentProgressEvent) => void;
  readonly resolveProvider: (selection: {
    readonly providerId: ProviderId;
    readonly model: string;
  }) => CliSubagentResolvedExecution;
}

interface CliSubagentResolvedExecution {
  readonly provider: LLMProvider;
  readonly providerId: ProviderId;
  readonly model: string;
  readonly costModel: CostModel;
  readonly modelMetadata: ModelMetadata;
  readonly contextCompaction?: ContextCompactionOptions;
  readonly modelMaxOutputTokens?: number;
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
  const coordination =
    options.attachedSession?.providerCoordination ??
    createSubagentTreeProviderCoordination({ now: options.now });
  const sharedCostBudget =
    options.attachedSession?.costBudget ??
    createSharedCostBudgetAccount(options.maxCostUsd);
  const executionCache = new Map<string, SubagentExecutionRuntime>();
  const executionKey = (snapshot: SubagentExecutionSnapshot): string =>
    JSON.stringify(snapshot);
  const providerWithEffort = (
    provider: LLMProvider,
    effort: SubagentExecutionSnapshot["effort"],
  ): LLMProvider => {
    if (effort === null) return provider;
    const estimateInputTokens = provider.estimateInputTokens;
    return {
      ...provider,
      ...(estimateInputTokens === undefined
        ? {}
        : {
            estimateInputTokens: (streamOptions) =>
              estimateInputTokens({
                ...streamOptions,
                reasoningEffort: effort,
              }),
          }),
      async *stream(streamOptions) {
        yield* provider.stream({
          ...streamOptions,
          reasoningEffort: effort,
        });
      },
    };
  };
  const resolveExecution = (
    snapshot: SubagentExecutionSnapshot,
  ): SubagentExecutionRuntime => {
    const key = executionKey(snapshot);
    const cached = executionCache.get(key);
    if (cached !== undefined) return cached;
    const resolved =
      snapshot.providerId === options.providerId &&
      snapshot.model === options.model
        ? {
            provider: options.provider,
            providerId: options.providerId,
            model: options.model,
            costModel: options.costModel,
            modelMetadata: options.modelMetadata,
            ...(options.contextCompaction !== undefined
              ? { contextCompaction: options.contextCompaction }
              : {}),
            ...(options.modelMaxOutputTokens !== undefined
              ? { modelMaxOutputTokens: options.modelMaxOutputTokens }
              : {}),
          }
        : options.resolveProvider({
            providerId: snapshot.providerId,
            model: snapshot.model,
          });
    if (
      resolved.providerId !== snapshot.providerId ||
      resolved.model !== snapshot.model
    ) {
      throw new Error("child provider resolver changed the execution target");
    }
    if (
      snapshot.effort !== null &&
      (resolved.modelMetadata.status !== "known" ||
        resolved.modelMetadata.reasoningEfforts?.includes(snapshot.effort) !==
          true)
    ) {
      throw new Error(
        `project subagent effort ${JSON.stringify(snapshot.effort)} is unsupported by ${snapshot.providerId}/${snapshot.model}`,
      );
    }
    const treeProvider = createSubagentTreeProvider({
      provider: providerWithEffort(resolved.provider, snapshot.effort),
      coordination,
    });
    const execution: SubagentExecutionRuntime = {
      snapshot,
      provider: treeProvider.provider,
      costModel: resolved.costModel,
      ...(resolved.contextCompaction !== undefined
        ? { contextCompaction: resolved.contextCompaction }
        : {}),
      ...(resolved.modelMaxOutputTokens !== undefined
        ? { modelMaxOutputTokens: resolved.modelMaxOutputTokens }
        : {}),
    };
    executionCache.set(key, execution);
    return execution;
  };
  const profileRegistry = createSubagentProfileRegistry({
    execution: {
      providerId: options.providerId,
      model: options.model,
    },
    repoProfiles: loadRepoSubagentProfiles(options.workspace),
  });
  for (const entry of profileRegistry.catalog) {
    const profile = profileRegistry.resolve(entry.name);
    if (profile !== undefined) resolveExecution(profile.execution);
  }
  const rootExecution = resolveExecution({
    providerId: options.providerId,
    model: options.model,
    effort: null,
  });
  const rootBudget = createSharedCostBudgetedProvider({
    provider: rootExecution.provider,
    model: options.costModel,
    maxCostUsd: options.maxCostUsd,
    sharedAccount: sharedCostBudget,
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
      rootBudget,
      sharedCostBudget,
      profileRegistry,
      resolveExecution,
      ...(options.attachedSession !== undefined
        ? { admission: options.attachedSession.admission }
        : {}),
      ...lifecycleOwnership,
      ...(options.projectInstructions !== undefined
        ? { projectInstructions: options.projectInstructions }
        : {}),
      hiddenWorkspacePaths: options.hiddenWorkspacePaths,
      ...(options.modelMaxOutputTokens !== undefined
        ? { modelMaxOutputTokens: options.modelMaxOutputTokens }
        : {}),
      ...(options.modelOperations !== undefined
        ? { modelOperations: options.modelOperations }
        : {}),
      transcriptStore: options.transcriptStore,
      now: options.now,
      onProgress: options.onProgress,
      providerBlocked: coordination.blocked,
    }),
  };
}
