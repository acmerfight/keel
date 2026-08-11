import { createHash } from "node:crypto";
import type { ReasoningEffort } from "../core/model-metadata.ts";
import type { ProviderId } from "../core/provider-id.ts";
import type {
  RepoSubagentCapabilitySnapshotId,
  RepoSubagentProfileName,
  SubagentBuiltinToolName,
  SubagentCapabilitySnapshot,
  SubagentProfileId,
  SubagentProfileName,
} from "./subagent-capability.ts";
import {
  compareSubagentCapability,
  EXPLORER_MAX_TURNS,
  REVIEWER_MAX_TURNS,
  SUBAGENT_DEADLINE_MS,
  SUBAGENT_MAX_FINAL_TEXT_CHARS,
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
  readonly threadCapabilityCeiling: SubagentCapabilitySnapshot;
  readonly capability: SubagentCapabilitySnapshot;
  readonly execution: SubagentExecutionSnapshot;
  readonly roleInstructions: string;
}

export interface SubagentProfileCatalogEntry {
  readonly name: SubagentProfileName;
  readonly base: SubagentProfileId;
}

export type SubagentProfileCatalog = readonly [
  SubagentProfileCatalogEntry,
  ...SubagentProfileCatalogEntry[],
];

export const builtinSubagentProfileCatalog: SubagentProfileCatalog = [
  { name: "explorer", base: "explorer" },
  { name: "reviewer", base: "reviewer" },
];

export interface SubagentProfileRegistry {
  readonly catalog: SubagentProfileCatalog;
  readonly resolve: (
    name: SubagentProfileName,
  ) => ResolvedSubagentProfile | undefined;
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
      threadCapabilityCeiling: selected.snapshot,
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
  for (const name of subagentProfileIds) {
    resolved.set(name, builtinProfiles[name]);
  }
  for (const definition of options.repoProfiles ?? []) {
    if (resolved.has(definition.name)) {
      throw new SubagentProfileDefinitionError(
        `duplicate project subagent profile ${JSON.stringify(definition.name)}`,
      );
    }
    const base = builtinProfiles[definition.base];
    const capabilityFields = {
      name: definition.name,
      base: definition.base,
      builtinTools: definition.tools ?? base.capability.builtinTools,
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
      maxTurns: capabilityFields.maxTurns,
      deadlineMs: capabilityFields.deadlineMs,
      maxFinalTextChars: capabilityFields.maxFinalTextChars,
    };
    const relation = compareSubagentCapability(
      capability,
      base.threadCapabilityCeiling,
    );
    if (relation.kind === "expansion") {
      throw new SubagentProfileDefinitionError(
        `project subagent profile ${JSON.stringify(definition.name)} expands ${definition.base} ${relation.dimension}`,
      );
    }
    resolved.set(definition.name, {
      name: definition.name,
      base: definition.base,
      threadCapabilityCeiling: base.threadCapabilityCeiling,
      capability,
      execution: {
        providerId: options.execution.providerId,
        model: definition.model ?? options.execution.model,
        effort: definition.effort ?? null,
      },
      roleInstructions: base.roleInstructions,
    });
  }

  const catalog: SubagentProfileCatalog = [
    ...builtinSubagentProfileCatalog,
    ...(options.repoProfiles ?? []).map(({ name, base }) => ({ name, base })),
  ];
  return {
    catalog,
    resolve: (name) => resolved.get(name),
  };
}
