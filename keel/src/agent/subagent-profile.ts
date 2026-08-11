import { createHash } from "node:crypto";
import type { ReasoningEffort } from "../core/model-metadata.ts";
import type { ProviderId } from "../core/provider-id.ts";
import type { SkillActivationCapability } from "../skills/model.ts";
import type {
  RepoSubagentCapabilitySnapshotId,
  RepoSubagentProfileName,
  SubagentBuiltinToolName,
  SubagentCapabilitySnapshot,
  SubagentProfileId,
  SubagentProfileName,
  SubagentSkillSnapshot,
} from "./subagent-capability.ts";
import {
  compareSubagentCapability,
  EXPLORER_MAX_TURNS,
  REVIEWER_MAX_TURNS,
  SUBAGENT_DEADLINE_MS,
  SUBAGENT_MAX_FINAL_TEXT_CHARS,
  subagentCapabilityWithSkills,
  subagentProfileIds,
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
  readonly maxTurns?: number;
  readonly deadlineMs?: number;
  readonly maxResultChars?: number;
}

interface BuiltinSubagentProfile {
  readonly snapshot: SubagentCapabilitySnapshot;
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
}

export type SubagentProfileCatalog = readonly [
  SubagentProfileCatalogEntry,
  ...SubagentProfileCatalogEntry[],
];

export const builtinSubagentProfileCatalog: SubagentProfileCatalog = [
  { name: "explorer", base: "explorer", skills: [] },
  { name: "reviewer", base: "reviewer", skills: [] },
];

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

export interface SubagentProfileRegistry {
  readonly catalog: SubagentProfileCatalog;
  readonly skillRuntime: SubagentProfileSkillRuntime;
  readonly resolve: (
    name: SubagentProfileName,
  ) => ResolvedSubagentProfile | undefined;
  readonly resolveBuiltin: (name: SubagentProfileId) => ResolvedSubagentProfile;
  readonly all: () => readonly ResolvedSubagentProfile[];
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

const builtinSubagentProfiles = {
  explorer: {
    snapshot: {
      id: "builtin-explorer-v1",
      profile: "explorer",
      builtinTools: explorerTools,
      skills: [],
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
      maxTurns: REVIEWER_MAX_TURNS,
      deadlineMs: SUBAGENT_DEADLINE_MS,
      maxFinalTextChars: SUBAGENT_MAX_FINAL_TEXT_CHARS,
    },
    roleInstructions:
      "Review for concrete correctness, security, regression, and missing-test risks. Start with the stated scope and inspect related code only when a concrete suspicion requires it; do not exhaustively read consumers to prove the absence of bugs. Prioritize actionable findings with exact workspace locations, and stop as soon as the available evidence supports those findings or a no-findings verdict.",
  },
} satisfies Record<SubagentProfileId, BuiltinSubagentProfile>;

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
  const selected = builtinSubagentProfiles.reviewer;
  return {
    ...selected,
    snapshot: {
      ...selected.snapshot,
      builtinTools: [...selected.snapshot.builtinTools],
      skills: [...selected.snapshot.skills],
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
  readonly maxTurns: number;
  readonly deadlineMs: number;
  readonly maxFinalTextChars: number;
}): RepoSubagentCapabilitySnapshotId {
  const digest = createHash("sha256")
    .update(JSON.stringify(input))
    .digest("hex");
  return `repo-profile-v1:${digest}`;
}

export function createSubagentProfileRegistry(options: {
  readonly execution: Omit<SubagentExecutionSnapshot, "effort">;
  readonly repoProfiles?: readonly RepoSubagentProfileDefinition[];
  readonly skillRuntime?: Extract<
    SubagentProfileSkillRuntime,
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
  };
  const resolved = new Map<SubagentProfileName, ResolvedSubagentProfile>();
  const repoProfiles: ResolvedSubagentProfile[] = [];
  for (const name of subagentProfileIds) {
    resolved.set(name, builtinProfiles[name]);
  }
  for (const definition of options.repoProfiles ?? []) {
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
    const capabilityFields = {
      name: definition.name,
      base: definition.base,
      builtinTools: definition.tools ?? base.capability.builtinTools,
      skills,
      maxTurns: definition.maxTurns ?? base.capability.maxTurns,
      deadlineMs: definition.deadlineMs ?? base.capability.deadlineMs,
      maxFinalTextChars:
        definition.maxResultChars ?? base.capability.maxFinalTextChars,
    };
    const capability: SubagentCapabilitySnapshot = {
      id: repoCapabilityId(capabilityFields),
      profile: definition.name,
      baseProfile: definition.base,
      builtinTools: [...capabilityFields.builtinTools],
      skills: [...capabilityFields.skills],
      maxTurns: capabilityFields.maxTurns,
      deadlineMs: capabilityFields.deadlineMs,
      maxFinalTextChars: capabilityFields.maxFinalTextChars,
    };
    const relation = compareSubagentCapability(
      capability,
      subagentCapabilityWithSkills(base.capability, skills),
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
    [builtinProfiles.explorer, builtinProfiles.reviewer, ...repoProfiles];
  const catalog: SubagentProfileCatalog = [
    ...builtinSubagentProfileCatalog,
    ...repoProfiles.map((profile) => ({
      name: profile.name,
      base: profile.base,
      skills: profile.capability.skills.map((skill) => skill.qualifiedName),
    })),
  ];
  return {
    catalog,
    skillRuntime: options.skillRuntime ?? { kind: "disabled" },
    resolve: (name) => resolved.get(name),
    resolveBuiltin: (name) => builtinProfiles[name],
    all: () => [...all],
  };
}
