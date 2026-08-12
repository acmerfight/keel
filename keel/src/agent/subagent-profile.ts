import { createHash } from "node:crypto";
import type { ReasoningEffort } from "../core/model-metadata.ts";
import type { ProviderId } from "../core/provider-id.ts";
import type { McpRuntime } from "../mcp/runtime-types.ts";
import type { SkillActivationCapability } from "../skills/model.ts";
import type {
  ReadOnlySubagentCapabilitySnapshot,
  RepoSubagentCapabilitySnapshot,
  RepoSubagentCapabilitySnapshotId,
  RepoSubagentProfileName,
  SubagentBuiltinToolName,
  SubagentCapabilitySnapshot,
  SubagentMcpToolSelector,
  SubagentMcpToolSnapshot,
  SubagentProfileId,
  SubagentProfileName,
  SubagentSkillSnapshot,
} from "./subagent-capability.ts";
import {
  compareSubagentCapability,
  EXPLORER_MAX_TURNS,
  narrowSubagentCapabilityToCeiling,
  REVIEWER_MAX_TURNS,
  SUBAGENT_DEADLINE_MS,
  SUBAGENT_MAX_FINAL_TEXT_CHARS,
  subagentCapabilityWithMcpTools,
  subagentCapabilityWithSkills,
  subagentProfileIds,
  WRITER_MAX_TURNS,
} from "./subagent-capability.ts";

export interface SubagentExecutionSnapshot {
  readonly providerId: ProviderId;
  readonly model: string;
  readonly effort: ReasoningEffort | null;
}

export interface RepoSubagentProfileDefinition {
  readonly name: RepoSubagentProfileName;
  readonly base: SubagentProfileId;
  readonly model?: string;
  readonly effort?: ReasoningEffort;
  readonly tools?: readonly SubagentBuiltinToolName[];
  readonly skills?: readonly string[];
  readonly mcp?: readonly SubagentMcpToolSelector[];
  readonly maxTurns?: number;
  readonly deadlineMs?: number;
  readonly maxResultChars?: number;
}

interface BuiltinSubagentProfile<
  Capability extends SubagentCapabilitySnapshot = SubagentCapabilitySnapshot,
> {
  readonly snapshot: Capability;
  readonly roleInstructions: string;
}

interface ResolvedSubagentProfile {
  readonly name: SubagentProfileName;
  readonly base: SubagentProfileId;
  readonly capability: SubagentCapabilitySnapshot;
  readonly execution: SubagentExecutionSnapshot;
  readonly roleInstructions: string;
}

export interface SubagentProfileCatalogEntry {
  readonly name: SubagentProfileName;
  readonly base: SubagentProfileId;
  readonly skills: readonly string[];
  readonly mcp: readonly SubagentMcpToolSelector[];
}

export type SubagentProfileCatalog = readonly [
  SubagentProfileCatalogEntry,
  ...SubagentProfileCatalogEntry[],
];

export const builtinSubagentProfileCatalog = [
  { name: "explorer", base: "explorer", skills: [], mcp: [] },
  { name: "reviewer", base: "reviewer", skills: [], mcp: [] },
  { name: "writer", base: "writer", skills: [], mcp: [] },
] as const satisfies SubagentProfileCatalog;

export type SubagentProfileSkillRuntime =
  | { readonly kind: "disabled" }
  | {
      readonly kind: "enabled";
      readonly resolveSkill: (
        qualifiedName: string,
      ) => SubagentSkillSnapshot | undefined;
      readonly createActivation: (
        capability: SubagentCapabilitySnapshot,
      ) => SkillActivationCapability | undefined;
      readonly resolveCurrent: (
        skills: readonly SubagentSkillSnapshot[],
      ) => readonly SubagentSkillSnapshot[];
    };

export type SubagentProfileMcpRuntime =
  | { readonly kind: "disabled" }
  | {
      readonly kind: "enabled";
      readonly resolveTool: (
        selector: SubagentMcpToolSelector,
      ) => SubagentMcpToolSnapshot | undefined;
      readonly resolveCurrent: (
        tools: readonly SubagentMcpToolSnapshot[],
      ) => Promise<readonly SubagentMcpToolSnapshot[]>;
      readonly createRuntime: (
        capability: SubagentCapabilitySnapshot,
        execution: SubagentExecutionSnapshot,
      ) => McpRuntime | undefined;
    };

export interface SubagentProfileRegistry {
  readonly catalog: SubagentProfileCatalog;
  readonly skillRuntime: SubagentProfileSkillRuntime;
  readonly mcpRuntime: SubagentProfileMcpRuntime;
  readonly resolve: (
    name: SubagentProfileName,
  ) => ResolvedSubagentProfile | undefined;
  readonly resolveBuiltin: (name: SubagentProfileId) => ResolvedSubagentProfile;
  readonly all: () => readonly ResolvedSubagentProfile[];
}

export interface SubagentDelegationProfileAuthority {
  readonly catalog: SubagentProfileCatalog;
  readonly resolve: (
    name: SubagentProfileName,
  ) => ResolvedSubagentProfile | undefined;
}

interface SubagentDelegationParentProfile {
  readonly name: SubagentProfileName;
  readonly base: SubagentProfileId;
  readonly execution: SubagentExecutionSnapshot;
  readonly roleInstructions: string;
}

export function narrowSubagentDelegationProfiles(
  registry: SubagentProfileRegistry,
  parentProfile: SubagentDelegationParentProfile,
  ceiling: ReadOnlySubagentCapabilitySnapshot,
): SubagentDelegationProfileAuthority {
  const profiles = registry.all().flatMap((profile) => {
    if (profile.name === parentProfile.name || profile.base === "writer") {
      return [];
    }
    const capability = narrowSubagentCapabilityToCeiling(
      profile.capability,
      ceiling,
    );
    if (compareSubagentCapability(capability, ceiling).kind === "expansion") {
      return [];
    }
    return [{ ...profile, capability }];
  });
  const first = { ...parentProfile, capability: ceiling };
  const allProfiles = [first, ...profiles];
  const resolved = new Map(
    allProfiles.map((profile) => [profile.name, profile] as const),
  );
  const catalogEntry = (
    profile: ResolvedSubagentProfile,
  ): SubagentProfileCatalogEntry => ({
    name: profile.name,
    base: profile.base,
    skills: profile.capability.skills.map((skill) => skill.qualifiedName),
    mcp: profile.capability.mcpTools.map((tool) => ({
      server: tool.serverId,
      tool: tool.rawToolName,
    })),
  });
  return {
    catalog: [catalogEntry(first), ...profiles.map(catalogEntry)],
    resolve: (name) => resolved.get(name),
  };
}

class SubagentProfileDefinitionError extends Error {}

const explorerTools = [
  "read",
  "ls",
  "glob",
  "grep",
] as const satisfies readonly SubagentBuiltinToolName[];

const reviewerTools = [
  ...explorerTools,
  "git_status",
  "git_diff",
] as const satisfies readonly SubagentBuiltinToolName[];

const writerTools = [
  ...reviewerTools,
  "edit",
  "write",
  "apply_patch",
] as const satisfies readonly SubagentBuiltinToolName[];

const builtinSubagentProfiles = {
  explorer: {
    snapshot: {
      id: "builtin-explorer-v1",
      profile: "explorer",
      builtinTools: explorerTools,
      skills: [],
      mcpTools: [],
      maxTurns: EXPLORER_MAX_TURNS,
      deadlineMs: SUBAGENT_DEADLINE_MS,
      maxFinalTextChars: SUBAGENT_MAX_FINAL_TEXT_CHARS,
    },
    roleInstructions:
      "Map the relevant files, symbols, and control flow efficiently. Return the direct answer with decisive workspace citations and remaining uncertainty; do not broaden into an unsolicited review.",
  },
  reviewer: {
    snapshot: {
      id: "builtin-reviewer-v1",
      profile: "reviewer",
      builtinTools: reviewerTools,
      skills: [],
      mcpTools: [],
      maxTurns: REVIEWER_MAX_TURNS,
      deadlineMs: SUBAGENT_DEADLINE_MS,
      maxFinalTextChars: SUBAGENT_MAX_FINAL_TEXT_CHARS,
    },
    roleInstructions:
      "Review for concrete correctness, security, regression, and missing-test risks. Start with the stated scope and inspect related code only when a concrete suspicion requires it; do not exhaustively read consumers to prove the absence of bugs. Prioritize actionable findings with exact workspace locations, and stop as soon as the available evidence supports those findings or a no-findings verdict.",
  },
  writer: {
    snapshot: {
      id: "builtin-writer-v1",
      profile: "writer",
      builtinTools: writerTools,
      skills: [],
      mcpTools: [],
      maxTurns: WRITER_MAX_TURNS,
      deadlineMs: SUBAGENT_DEADLINE_MS,
      maxFinalTextChars: SUBAGENT_MAX_FINAL_TEXT_CHARS,
    },
    roleInstructions:
      "Make the delegated change only in the isolated child worktree. Inspect the exact targets before editing, keep the patch scoped to the task, and finish with a concise description of changed files and any verification still needed.",
  },
} satisfies Record<SubagentProfileId, BuiltinSubagentProfile>;

export function resolveBuiltinSubagentProfile(
  profile: "explorer",
  overrides?: {
    readonly maxTurns?: number;
    readonly deadlineMs?: number;
  },
): BuiltinSubagentProfile<
  Extract<SubagentCapabilitySnapshot, { readonly profile: "explorer" }>
>;
export function resolveBuiltinSubagentProfile(
  profile: "reviewer",
  overrides?: {
    readonly maxTurns?: number;
    readonly deadlineMs?: number;
  },
): BuiltinSubagentProfile<
  Extract<SubagentCapabilitySnapshot, { readonly profile: "reviewer" }>
>;
export function resolveBuiltinSubagentProfile(
  profile: "writer",
  overrides?: {
    readonly maxTurns?: number;
    readonly deadlineMs?: number;
  },
): BuiltinSubagentProfile<
  Extract<SubagentCapabilitySnapshot, { readonly profile: "writer" }>
>;
export function resolveBuiltinSubagentProfile(
  profile: SubagentProfileId,
  overrides?: {
    readonly maxTurns?: number;
    readonly deadlineMs?: number;
  },
): BuiltinSubagentProfile;
export function resolveBuiltinSubagentProfile(
  profile: SubagentProfileId,
  overrides: {
    readonly maxTurns?: number;
    readonly deadlineMs?: number;
  } = {},
): BuiltinSubagentProfile {
  if (profile === "explorer") {
    const selected = builtinSubagentProfiles.explorer;
    return {
      ...selected,
      snapshot: {
        ...selected.snapshot,
        builtinTools: [...selected.snapshot.builtinTools],
        skills: [...selected.snapshot.skills],
        mcpTools: [...selected.snapshot.mcpTools],
        maxTurns: Math.min(
          overrides.maxTurns ?? selected.snapshot.maxTurns,
          selected.snapshot.maxTurns,
        ),
        deadlineMs: Math.min(
          overrides.deadlineMs ?? selected.snapshot.deadlineMs,
          selected.snapshot.deadlineMs,
        ),
      },
    };
  }
  if (profile === "reviewer") {
    const selected = builtinSubagentProfiles.reviewer;
    return {
      ...selected,
      snapshot: {
        ...selected.snapshot,
        builtinTools: [...selected.snapshot.builtinTools],
        skills: [...selected.snapshot.skills],
        mcpTools: [...selected.snapshot.mcpTools],
        maxTurns: Math.min(
          overrides.maxTurns ?? selected.snapshot.maxTurns,
          selected.snapshot.maxTurns,
        ),
        deadlineMs: Math.min(
          overrides.deadlineMs ?? selected.snapshot.deadlineMs,
          selected.snapshot.deadlineMs,
        ),
      },
    };
  }
  const selected = builtinSubagentProfiles.writer;
  return {
    ...selected,
    snapshot: {
      ...selected.snapshot,
      builtinTools: [...selected.snapshot.builtinTools],
      skills: [...selected.snapshot.skills],
      mcpTools: [...selected.snapshot.mcpTools],
      maxTurns: Math.min(
        overrides.maxTurns ?? selected.snapshot.maxTurns,
        selected.snapshot.maxTurns,
      ),
      deadlineMs: Math.min(
        overrides.deadlineMs ?? selected.snapshot.deadlineMs,
        selected.snapshot.deadlineMs,
      ),
    },
  };
}

function repoCapabilityId(input: {
  readonly name: RepoSubagentProfileName;
  readonly base: SubagentProfileId;
  readonly builtinTools: readonly SubagentBuiltinToolName[];
  readonly skills: readonly SubagentSkillSnapshot[];
  readonly mcpTools: readonly SubagentMcpToolSnapshot[];
  readonly maxTurns: number;
  readonly deadlineMs: number;
  readonly maxFinalTextChars: number;
}): RepoSubagentCapabilitySnapshotId {
  const digest = createHash("sha256")
    .update(JSON.stringify(input))
    .digest("hex");
  return `repo-profile-v1:${digest}`;
}

function repoCapabilitySnapshot<BaseProfile extends SubagentProfileId>(
  baseProfile: BaseProfile,
  input: {
    readonly id: RepoSubagentCapabilitySnapshotId;
    readonly profile: RepoSubagentProfileName;
    readonly builtinTools: readonly SubagentBuiltinToolName[];
    readonly skills: readonly SubagentSkillSnapshot[];
    readonly mcpTools: readonly SubagentMcpToolSnapshot[];
    readonly maxTurns: number;
    readonly deadlineMs: number;
    readonly maxFinalTextChars: number;
  },
): RepoSubagentCapabilitySnapshot<BaseProfile> {
  return { ...input, baseProfile };
}

export function createSubagentProfileRegistry(options: {
  readonly execution: Omit<SubagentExecutionSnapshot, "effort">;
  readonly writer?: "enabled" | "disabled";
  readonly repoProfiles?: readonly RepoSubagentProfileDefinition[];
  readonly skillRuntime?: Extract<
    SubagentProfileSkillRuntime,
    { readonly kind: "enabled" }
  >;
  readonly mcpRuntime?: Extract<
    SubagentProfileMcpRuntime,
    { readonly kind: "enabled" }
  >;
  readonly maxTurns?: number;
  readonly deadlineMs?: number;
}): SubagentProfileRegistry {
  const resolveBuiltin = (name: SubagentProfileId): ResolvedSubagentProfile => {
    const selected = resolveBuiltinSubagentProfile(name, {
      ...(options.maxTurns !== undefined ? { maxTurns: options.maxTurns } : {}),
      ...(options.deadlineMs !== undefined
        ? { deadlineMs: options.deadlineMs }
        : {}),
    });
    return {
      name,
      base: name,
      capability: selected.snapshot,
      execution: { ...options.execution, effort: null },
      roleInstructions: selected.roleInstructions,
    };
  };

  const builtinProfiles: Record<SubagentProfileId, ResolvedSubagentProfile> = {
    explorer: resolveBuiltin("explorer"),
    reviewer: resolveBuiltin("reviewer"),
    writer: resolveBuiltin("writer"),
  };
  const resolved = new Map<SubagentProfileName, ResolvedSubagentProfile>();
  const repoProfiles: ResolvedSubagentProfile[] = [];
  for (const name of subagentProfileIds) {
    if (name === "writer" && options.writer === "disabled") continue;
    resolved.set(name, builtinProfiles[name]);
  }
  for (const definition of options.repoProfiles ?? []) {
    if (definition.base === "writer" && options.writer === "disabled") {
      continue;
    }
    const base = builtinProfiles[definition.base];
    const skills = (definition.skills ?? []).map((qualifiedName) => {
      const skill = options.skillRuntime?.resolveSkill(qualifiedName);
      if (skill === undefined) {
        throw new SubagentProfileDefinitionError(
          `project subagent profile ${JSON.stringify(definition.name)} references unavailable or non-model-activatable workflow Skill ${JSON.stringify(qualifiedName)}`,
        );
      }
      return skill;
    });
    const mcpTools = (definition.mcp ?? []).map((selector) => {
      const tool = options.mcpRuntime?.resolveTool(selector);
      if (tool === undefined) {
        throw new SubagentProfileDefinitionError(
          `project subagent profile ${JSON.stringify(definition.name)} references unavailable MCP tool ${JSON.stringify(`${selector.server}/${selector.tool}`)}`,
        );
      }
      return tool;
    });
    if (
      definition.base === "writer" &&
      (skills.length > 0 || mcpTools.length > 0)
    ) {
      throw new SubagentProfileDefinitionError(
        `project subagent profile ${JSON.stringify(definition.name)} cannot attach Skills or MCP tools to the initial writer workspace lease`,
      );
    }
    const capabilityFields = {
      name: definition.name,
      base: definition.base,
      builtinTools: definition.tools ?? base.capability.builtinTools,
      skills,
      mcpTools,
      maxTurns: definition.maxTurns ?? base.capability.maxTurns,
      deadlineMs: definition.deadlineMs ?? base.capability.deadlineMs,
      maxFinalTextChars:
        definition.maxResultChars ?? base.capability.maxFinalTextChars,
    };
    const capability = repoCapabilitySnapshot(definition.base, {
      id: repoCapabilityId(capabilityFields),
      profile: definition.name,
      builtinTools: [...capabilityFields.builtinTools],
      skills: [...capabilityFields.skills],
      mcpTools: [...capabilityFields.mcpTools],
      maxTurns: capabilityFields.maxTurns,
      deadlineMs: capabilityFields.deadlineMs,
      maxFinalTextChars: capabilityFields.maxFinalTextChars,
    });
    const relation = compareSubagentCapability(
      capability,
      subagentCapabilityWithMcpTools(
        subagentCapabilityWithSkills(base.capability, skills),
        mcpTools,
      ),
    );
    if (relation.kind === "expansion") {
      throw new SubagentProfileDefinitionError(
        `project subagent profile ${JSON.stringify(definition.name)} expands ${definition.base} ${relation.dimension}`,
      );
    }
    const profile: ResolvedSubagentProfile = {
      name: definition.name,
      base: definition.base,
      capability,
      execution: {
        providerId: options.execution.providerId,
        model: definition.model ?? options.execution.model,
        effort: definition.effort ?? null,
      },
      roleInstructions: base.roleInstructions,
    };
    resolved.set(definition.name, profile);
    repoProfiles.push(profile);
  }

  const all: readonly [ResolvedSubagentProfile, ...ResolvedSubagentProfile[]] =
    [
      builtinProfiles.explorer,
      builtinProfiles.reviewer,
      ...(options.writer === "disabled" ? [] : [builtinProfiles.writer]),
      ...repoProfiles,
    ];
  const catalog: SubagentProfileCatalog = [
    builtinSubagentProfileCatalog[0],
    builtinSubagentProfileCatalog[1],
    ...(options.writer === "disabled"
      ? []
      : [builtinSubagentProfileCatalog[2]]),
    ...repoProfiles.map((profile) => ({
      name: profile.name,
      base: profile.base,
      skills: profile.capability.skills.map((skill) => skill.qualifiedName),
      mcp: profile.capability.mcpTools.map((tool) => ({
        server: tool.serverId,
        tool: tool.rawToolName,
      })),
    })),
  ];
  return {
    catalog,
    skillRuntime: options.skillRuntime ?? { kind: "disabled" },
    mcpRuntime: options.mcpRuntime ?? { kind: "disabled" },
    resolve: (name) => resolved.get(name),
    resolveBuiltin: (name) => builtinProfiles[name],
    all: () => [...all],
  };
}
