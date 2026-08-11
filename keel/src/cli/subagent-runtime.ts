import type { ContextCompactionOptions } from "../agent/context-compaction.ts";
import {
  createSharedCostBudgetAccount,
  createSharedCostBudgetedProvider,
  type SharedCostBudgetAccount,
} from "../agent/cost-budget.ts";
import type { MainModelOperationInstrumentation } from "../agent/model-operations.ts";
import type { ProjectInstructions } from "../agent/prompt.ts";
import {
  type SubagentCapabilitySnapshot,
  type SubagentSkillSnapshot,
  skillDescriptorFromSubagentSnapshot,
  subagentSkillSnapshotFromWorkflowSkill,
  workflowSkillFromSubagentSnapshot,
} from "../agent/subagent-capability.ts";
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
import { createSkillActivation } from "../skills/lifecycle.ts";
import type {
  SkillActivationCapability,
  SkillCatalog,
} from "../skills/model.ts";
import { WorkflowSkillError } from "../skills/model.ts";
import { loadRepoSubagentProfiles } from "./subagent-profile-config.ts";
import { workflowSkillWorkspacePaths } from "./workflow-skills.ts";

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
  readonly skillCatalog?: SkillCatalog;
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

function resolveCatalogSkillSnapshot(
  catalog: SkillCatalog,
  qualifiedName: string,
): SubagentSkillSnapshot | undefined {
  const descriptor = catalog.skills.find(
    (candidate) => candidate.qualifiedName === qualifiedName,
  );
  if (descriptor === undefined || descriptor.activationPolicy !== "implicit") {
    return undefined;
  }
  const implicitDescriptor: typeof descriptor & {
    readonly activationPolicy: "implicit";
  } = { ...descriptor, activationPolicy: "implicit" };
  return subagentSkillSnapshotFromWorkflowSkill(
    catalog.load(qualifiedName),
    implicitDescriptor,
  );
}

function childSkillCatalog(
  catalog: SkillCatalog,
  skills: readonly SubagentSkillSnapshot[],
): SkillCatalog {
  const descriptors = skills.map(skillDescriptorFromSubagentSnapshot);
  const byQualifiedName = new Map(
    skills.map((skill) => [skill.qualifiedName, skill]),
  );
  const resolve = (lookup: string): SubagentSkillSnapshot => {
    const skill = byQualifiedName.get(lookup);
    if (skill !== undefined) return skill;
    throw new WorkflowSkillError(
      `Error: workflow skill ${JSON.stringify(lookup)} is outside this child Run's task lease.`,
    );
  };
  return {
    skills: descriptors,
    implicitSkills: descriptors,
    warnings: [],
    audits: [],
    load: (lookup) => workflowSkillFromSubagentSnapshot(resolve(lookup)),
    loadImplicit: (lookup) =>
      workflowSkillFromSubagentSnapshot(resolve(lookup)),
    loadPackage: (packageId) => {
      const skill = skills.find(
        (candidate) => candidate.packageId === packageId,
      );
      return skill === undefined
        ? undefined
        : workflowSkillFromSubagentSnapshot(skill);
    },
    search: (query, limit = 20) => {
      const normalized = query.trim().toLowerCase();
      return descriptors
        .filter(
          (descriptor) =>
            descriptor.qualifiedName.toLowerCase().includes(normalized) ||
            descriptor.description.toLowerCase().includes(normalized),
        )
        .slice(0, Math.max(0, limit));
    },
    readResource: (lookup, path) => {
      const skill = resolve(lookup);
      return catalog.readPackageResource(skill.packageId, skill.digest, path);
    },
    readPackageResource: (packageId, digest, path) => {
      const skill = skills.find(
        (candidate) =>
          candidate.packageId === packageId && candidate.digest === digest,
      );
      if (skill === undefined) {
        throw new WorkflowSkillError(
          "Error: workflow Skill resource is outside this child Run's task lease.",
        );
      }
      return catalog.readPackageResource(packageId, digest, path);
    },
  };
}

function childSkillActivation(
  catalog: SkillCatalog,
  capability: SubagentCapabilitySnapshot,
): SkillActivationCapability | undefined {
  if (capability.skills.length === 0) return undefined;
  const boundedCatalog = childSkillCatalog(catalog, capability.skills);
  const activation = createSkillActivation(boundedCatalog);
  activation.expose(boundedCatalog.skills);
  activation.beginTurn();
  return activation;
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
  const skillCatalog = options.skillCatalog;
  const profileRegistry = createSubagentProfileRegistry({
    execution: {
      providerId: options.providerId,
      model: options.model,
    },
    repoProfiles: loadRepoSubagentProfiles(options.workspace),
    ...(skillCatalog !== undefined
      ? {
          skillRuntime: {
            kind: "enabled",
            resolveSkill: (qualifiedName: string) =>
              resolveCatalogSkillSnapshot(skillCatalog, qualifiedName),
            createActivation: (capability: SubagentCapabilitySnapshot) =>
              childSkillActivation(skillCatalog, capability),
            resolveCurrent: (skills: readonly SubagentSkillSnapshot[]) =>
              skills.flatMap((skill) => {
                const current = resolveCatalogSkillSnapshot(
                  skillCatalog,
                  skill.qualifiedName,
                );
                return current === undefined ? [] : [current];
              }),
          },
        }
      : {}),
  });
  for (const profile of profileRegistry.all()) {
    resolveExecution(profile.execution);
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
  const childHiddenWorkspacePaths = [
    ...new Set([
      ...options.hiddenWorkspacePaths,
      ...(options.skillCatalog === undefined
        ? []
        : workflowSkillWorkspacePaths(
            options.workspace,
            options.skillCatalog.skills,
          )),
    ]),
  ];
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
      hiddenWorkspacePaths: childHiddenWorkspacePaths,
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
