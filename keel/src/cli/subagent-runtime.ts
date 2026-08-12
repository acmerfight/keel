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
  type SubagentMcpToolSelector,
  type SubagentMcpToolSnapshot,
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
import type { DelegatingAgentPolicy } from "../core/agent-policy.ts";
import type { CostModel } from "../core/cost.ts";
import type { ModelMetadata } from "../core/model-metadata.ts";
import type { ProviderId } from "../core/provider-id.ts";
import type { LLMProvider } from "../llm/types.ts";
import {
  type McpAuthorizationIdentity,
  sameMcpAuthorizationIdentity,
} from "../mcp/oauth.ts";
import { mcpProviderSchemaTarget } from "../mcp/provider-schema.ts";
import {
  createMcpRuntime,
  mcpServerConfigurationDigest,
} from "../mcp/runtime.ts";
import type {
  McpConnectionFactory,
  McpLifecyclePolicy,
  McpPermissionPolicy,
  McpRuntimeServer,
} from "../mcp/runtime-types.ts";
import { createSkillActivation } from "../skills/lifecycle.ts";
import type {
  SkillActivationCapability,
  SkillCatalog,
} from "../skills/model.ts";
import { WorkflowSkillError } from "../skills/model.ts";
import { loadRepoSubagentProfiles } from "./subagent-profile-config.ts";
import { createCliSubagentWriteWorkspaceRuntime } from "./subagent-workspace.ts";
import { workflowSkillWorkspacePaths } from "./workflow-skills.ts";

interface CreateCliSubagentRuntimeOptionsBase {
  readonly workspace: string;
  readonly workspaceLeasesRoot: string;
  readonly platform: NodeJS.Platform;
  readonly parentRunId: string;
  readonly provider: LLMProvider;
  readonly providerId: ProviderId;
  readonly model: string;
  readonly costModel: CostModel;
  readonly modelMetadata: ModelMetadata;
  readonly maxCostUsd: number;
  readonly policy: DelegatingAgentPolicy;
  readonly projectInstructions: ProjectInstructions | undefined;
  readonly hiddenWorkspacePaths: readonly string[];
  readonly skillCatalog?: SkillCatalog;
  readonly mcp?: {
    readonly servers: readonly McpRuntimeServer[];
    readonly connectionFactory: (
      authorizationIdentity: McpAuthorizationIdentity,
    ) => McpConnectionFactory;
    readonly lifecycle: McpLifecyclePolicy;
    readonly permission: McpPermissionPolicy;
    readonly authorizationIdentity: (
      server: McpRuntimeServer,
    ) => Promise<McpAuthorizationIdentity>;
  };
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

function mcpSelectorKey(selector: SubagentMcpToolSelector): string {
  return `${selector.server}\u0000${selector.tool}`;
}

function mcpSnapshotKey(snapshot: SubagentMcpToolSnapshot): string {
  return `${snapshot.serverId}\u0000${snapshot.rawToolName}`;
}

function configuredMcpToolIsAllowed(
  server: McpRuntimeServer,
  rawToolName: string,
): boolean {
  return (
    !server.toolFilter.deny.includes(rawToolName) &&
    (server.toolFilter.allow === null ||
      server.toolFilter.allow.includes(rawToolName))
  );
}

async function resolveMcpToolSnapshots(
  selectors: readonly SubagentMcpToolSelector[],
  servers: readonly McpRuntimeServer[],
  authorizationIdentity: (
    server: McpRuntimeServer,
  ) => Promise<McpAuthorizationIdentity>,
): Promise<readonly SubagentMcpToolSnapshot[]> {
  const byId = new Map(
    servers
      .filter((server) => server.enabled)
      .map((server) => [server.id, server]),
  );
  const identities = new Map<string, McpAuthorizationIdentity>();
  const snapshots: SubagentMcpToolSnapshot[] = [];
  for (const selector of selectors) {
    const server = byId.get(selector.server);
    if (
      server === undefined ||
      !configuredMcpToolIsAllowed(server, selector.tool)
    ) {
      continue;
    }
    let identity = identities.get(server.id);
    if (identity === undefined) {
      identity = await authorizationIdentity(server);
      identities.set(server.id, identity);
    }
    snapshots.push({
      serverId: server.id,
      rawToolName: selector.tool,
      serverIncarnation: server.incarnation,
      configurationDigest: mcpServerConfigurationDigest(server),
      authorizationIdentity: identity,
    });
  }
  return snapshots;
}

type CliSubagentMcpOptions = NonNullable<
  CreateCliSubagentRuntimeOptionsBase["mcp"]
>;

function serverMatchesMcpLeaseConfiguration(
  server: McpRuntimeServer,
  leased: readonly SubagentMcpToolSnapshot[],
): readonly SubagentMcpToolSnapshot[] {
  const configurationDigest = mcpServerConfigurationDigest(server);
  return leased.filter(
    (tool) =>
      tool.serverId === server.id &&
      tool.serverIncarnation === server.incarnation &&
      tool.configurationDigest === configurationDigest &&
      configuredMcpToolIsAllowed(server, tool.rawToolName),
  );
}

async function serverMatchesCurrentMcpLease(
  server: McpRuntimeServer,
  leased: readonly SubagentMcpToolSnapshot[],
  mcp: CliSubagentMcpOptions,
): Promise<boolean> {
  const candidates = serverMatchesMcpLeaseConfiguration(server, leased);
  if (candidates.length === 0 || !server.enabled) return false;
  try {
    if (!(await mcp.lifecycle.isCurrentAndEnabled(server))) return false;
    const currentIdentity = await mcp.authorizationIdentity(server);
    return candidates.some((tool) =>
      sameMcpAuthorizationIdentity(tool.authorizationIdentity, currentIdentity),
    );
  } catch {
    return false;
  }
}

function leasedMcpLifecycle(
  leased: readonly SubagentMcpToolSnapshot[],
  mcp: CliSubagentMcpOptions,
): McpLifecyclePolicy {
  return {
    isCurrentAndEnabled: async (server) =>
      await serverMatchesCurrentMcpLease(server, leased, mcp),
    listCurrent: async () => {
      const current = await mcp.lifecycle.listCurrent();
      const admitted = await Promise.all(
        current.map(async (server) =>
          (await serverMatchesCurrentMcpLease(server, leased, mcp))
            ? [server]
            : [],
        ),
      );
      return admitted.flat();
    },
  };
}

export async function createCliSubagentRuntime(
  options: CreateCliSubagentRuntimeOptions,
): Promise<CliSubagentRuntime> {
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
  const repoProfiles = loadRepoSubagentProfiles(options.workspace);
  const configuredMcpSelectors = repoProfiles.flatMap(
    (profile) => profile.mcp ?? [],
  );
  const uniqueMcpSelectors = [
    ...new Map(
      configuredMcpSelectors.map((selector) => [
        mcpSelectorKey(selector),
        selector,
      ]),
    ).values(),
  ];
  let currentMcpServers = new Map<string, McpRuntimeServer>();
  let resolvedMcpTools = new Map<string, SubagentMcpToolSnapshot>();
  const mcpOptions = options.mcp;
  if (mcpOptions !== undefined && uniqueMcpSelectors.length > 0) {
    const servers = await mcpOptions.lifecycle.listCurrent();
    currentMcpServers = new Map(servers.map((server) => [server.id, server]));
    resolvedMcpTools = new Map(
      (
        await resolveMcpToolSnapshots(
          uniqueMcpSelectors,
          servers,
          mcpOptions.authorizationIdentity,
        )
      ).map((snapshot) => [mcpSnapshotKey(snapshot), snapshot]),
    );
  }
  const mcpRuntime =
    mcpOptions === undefined
      ? undefined
      : {
          kind: "enabled" as const,
          resolveTool: (selector: SubagentMcpToolSelector) =>
            resolvedMcpTools.get(mcpSelectorKey(selector)),
          resolveCurrent: async (tools: readonly SubagentMcpToolSnapshot[]) => {
            const servers = await mcpOptions.lifecycle.listCurrent();
            currentMcpServers = new Map(
              servers.map((server) => [server.id, server]),
            );
            const current = await resolveMcpToolSnapshots(
              tools.map((tool) => ({
                server: tool.serverId,
                tool: tool.rawToolName,
              })),
              servers,
              mcpOptions.authorizationIdentity,
            );
            return current.filter((candidate) => {
              const previous = tools.find(
                (tool) => mcpSnapshotKey(tool) === mcpSnapshotKey(candidate),
              );
              return (
                previous !== undefined &&
                previous.serverIncarnation === candidate.serverIncarnation &&
                previous.configurationDigest ===
                  candidate.configurationDigest &&
                sameMcpAuthorizationIdentity(
                  previous.authorizationIdentity,
                  candidate.authorizationIdentity,
                )
              );
            });
          },
          createRuntime: (
            capability: SubagentCapabilitySnapshot,
            execution: SubagentExecutionSnapshot,
          ) => {
            if (capability.mcpTools.length === 0) return undefined;
            const leased = capability.mcpTools;
            const servers = [
              ...new Map(
                leased.flatMap((tool) => {
                  const server = currentMcpServers.get(tool.serverId);
                  return server !== undefined &&
                    server.incarnation === tool.serverIncarnation &&
                    mcpServerConfigurationDigest(server) ===
                      tool.configurationDigest
                    ? [[server.id, server] as const]
                    : [];
                }),
              ).values(),
            ];
            const lifecycle = leasedMcpLifecycle(leased, mcpOptions);
            return createMcpRuntime({
              servers,
              connectionFactory: {
                connect: async (server, signal) => {
                  const expected = serverMatchesMcpLeaseConfiguration(
                    server,
                    leased,
                  )[0];
                  if (
                    expected === undefined ||
                    !(await serverMatchesCurrentMcpLease(
                      server,
                      leased,
                      mcpOptions,
                    ))
                  ) {
                    throw new Error(
                      "MCP server or authorization identity changed after child capability admission.",
                    );
                  }
                  return await mcpOptions
                    .connectionFactory(expected.authorizationIdentity)
                    .connect(server, signal);
                },
              },
              lifecycle,
              filter: {
                allows: ({ server, rawToolName }) =>
                  configuredMcpToolIsAllowed(server, rawToolName) &&
                  leased.some(
                    (tool) =>
                      tool.serverId === server.id &&
                      tool.rawToolName === rawToolName &&
                      tool.serverIncarnation === server.incarnation &&
                      tool.configurationDigest ===
                        mcpServerConfigurationDigest(server),
                  ),
              },
              permission: {
                review: async (request) => {
                  const authorized = leased.some(
                    (tool) =>
                      tool.serverId === request.serverId &&
                      tool.rawToolName === request.rawToolName &&
                      tool.configurationDigest ===
                        request.configurationDigest &&
                      sameMcpAuthorizationIdentity(
                        tool.authorizationIdentity,
                        request.authorizationIdentity,
                      ),
                  );
                  return authorized
                    ? await mcpOptions.permission.review(request)
                    : {
                        type: "deny" as const,
                        message:
                          "MCP call denied because the child task lease or authorization identity changed.",
                      };
                },
              },
              schemaTarget: mcpProviderSchemaTarget(
                execution.providerId,
                execution.model,
              ),
              now: options.now,
            });
          },
        };
  const profileRegistry = createSubagentProfileRegistry({
    execution: {
      providerId: options.providerId,
      model: options.model,
    },
    repoProfiles,
    writer: options.policy === "explicit" ? "enabled" : "disabled",
    ...(mcpRuntime !== undefined ? { mcpRuntime } : {}),
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
      parent: {
        kind: "main",
        runId: options.parentRunId,
        childDelegation:
          options.policy === "explicit" ? "foreground_read_only" : "none",
      },
      rootBudget,
      sharedCostBudget,
      profileRegistry,
      ...(options.policy === "explicit"
        ? {
            writeWorkspace: createCliSubagentWriteWorkspaceRuntime({
              workspace: options.workspace,
              leasesRoot: options.workspaceLeasesRoot,
              platform: options.platform,
            }),
          }
        : {}),
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
