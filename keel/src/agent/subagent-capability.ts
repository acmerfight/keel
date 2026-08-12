import type { McpAuthorizationIdentity } from "../mcp/oauth.ts";
import type { SkillDescriptor, WorkflowSkill } from "../skills/model.ts";

export const subagentProfileIds = ["explorer", "reviewer", "writer"] as const;

export type SubagentProfileId = (typeof subagentProfileIds)[number];

export type RepoSubagentProfileName = `repo:${string}`;

export type SubagentProfileName = SubagentProfileId | RepoSubagentProfileName;

export const subagentBuiltinToolNames = [
  "read",
  "ls",
  "glob",
  "grep",
  "git_status",
  "git_diff",
  "edit",
  "write",
  "apply_patch",
] as const;

export type SubagentBuiltinToolName = (typeof subagentBuiltinToolNames)[number];

export const SUBAGENT_MAX_FINAL_TEXT_CHARS = 4_000;
export const SUBAGENT_DEADLINE_MS = 120_000;
export const EXPLORER_MAX_TURNS = 16;
export const REVIEWER_MAX_TURNS = 20;
export const WRITER_MAX_TURNS = 24;
export const MAX_SUBAGENT_SKILLS = 8;
export const MAX_SUBAGENT_MCP_TOOLS = 16;

export interface SubagentMcpToolSelector {
  readonly server: string;
  readonly tool: string;
}

export interface SubagentMcpToolSnapshot {
  readonly serverId: string;
  readonly rawToolName: string;
  readonly serverIncarnation: string;
  readonly configurationDigest: string;
  readonly authorizationIdentity: McpAuthorizationIdentity;
}

export interface SubagentSkillSnapshot {
  readonly descriptorId: string;
  readonly packageId: string;
  readonly rootKey: string;
  readonly rootPriority: number;
  readonly qualifiedName: string;
  readonly scope: SkillDescriptor["scope"];
  readonly activationPolicy: "implicit";
  readonly name: string;
  readonly description: string;
  readonly relativePath: string;
  readonly digest: string;
  readonly resourcePaths: readonly string[];
  readonly content: string;
}

interface SubagentCapabilityLimits {
  readonly maxTurns: number;
  readonly deadlineMs: number;
  readonly maxFinalTextChars: number;
  readonly skills: readonly SubagentSkillSnapshot[];
  readonly mcpTools: readonly SubagentMcpToolSnapshot[];
}

interface ExplorerCapabilitySnapshot extends SubagentCapabilityLimits {
  readonly id: "builtin-explorer-v1";
  readonly profile: "explorer";
  readonly builtinTools: readonly ["read", "ls", "glob", "grep"];
}

interface ReviewerCapabilitySnapshot extends SubagentCapabilityLimits {
  readonly id: "builtin-reviewer-v1";
  readonly profile: "reviewer";
  readonly builtinTools: readonly [
    "read",
    "ls",
    "glob",
    "grep",
    "git_status",
    "git_diff",
  ];
}

interface WriterCapabilitySnapshot extends SubagentCapabilityLimits {
  readonly id: "builtin-writer-v1";
  readonly profile: "writer";
  readonly builtinTools: readonly [
    "read",
    "ls",
    "glob",
    "grep",
    "git_status",
    "git_diff",
    "edit",
    "write",
    "apply_patch",
  ];
}

export type RepoSubagentCapabilitySnapshotId = `repo-profile-v1:${string}`;

export interface RepoSubagentCapabilitySnapshot<
  BaseProfile extends SubagentProfileId,
> extends SubagentCapabilityLimits {
  readonly id: RepoSubagentCapabilitySnapshotId;
  readonly profile: RepoSubagentProfileName;
  readonly baseProfile: BaseProfile;
  readonly builtinTools: readonly SubagentBuiltinToolName[];
}

export type ReadOnlySubagentCapabilitySnapshot =
  | ExplorerCapabilitySnapshot
  | ReviewerCapabilitySnapshot
  | RepoSubagentCapabilitySnapshot<"explorer" | "reviewer">;

export type WriterSubagentCapabilitySnapshot =
  | WriterCapabilitySnapshot
  | RepoSubagentCapabilitySnapshot<"writer">;

export type SubagentCapabilitySnapshot =
  | ReadOnlySubagentCapabilitySnapshot
  | WriterSubagentCapabilitySnapshot;

type SubagentCapabilityDimension =
  | "baseProfile"
  | "builtinTools"
  | "skills"
  | "mcpTools"
  | "maxTurns"
  | "deadlineMs"
  | "maxFinalTextChars";

export type SubagentCapabilityRelation =
  | { readonly kind: "subset" }
  | {
      readonly kind: "expansion";
      readonly dimension: SubagentCapabilityDimension;
    };

export function subagentSkillSnapshotFromWorkflowSkill(
  skill: WorkflowSkill,
  descriptor: SkillDescriptor & { readonly activationPolicy: "implicit" },
): SubagentSkillSnapshot {
  return {
    descriptorId: skill.id,
    packageId: skill.packageId,
    rootKey: descriptor.rootKey,
    rootPriority: descriptor.rootPriority,
    qualifiedName: skill.qualifiedName,
    scope: skill.scope,
    activationPolicy: descriptor.activationPolicy,
    name: skill.name,
    description: descriptor.description,
    relativePath: skill.relativePath,
    digest: skill.digest,
    resourcePaths: [...skill.resourcePaths],
    content: skill.content,
  };
}

export function workflowSkillFromSubagentSnapshot(
  snapshot: SubagentSkillSnapshot,
): WorkflowSkill {
  return {
    id: snapshot.descriptorId,
    packageId: snapshot.packageId,
    qualifiedName: snapshot.qualifiedName,
    scope: snapshot.scope,
    digest: snapshot.digest,
    relativePath: snapshot.relativePath,
    name: snapshot.name,
    resourcePaths: [...snapshot.resourcePaths],
    content: snapshot.content,
  };
}

export function skillDescriptorFromSubagentSnapshot(
  snapshot: SubagentSkillSnapshot,
): SkillDescriptor {
  return {
    id: snapshot.descriptorId,
    packageId: snapshot.packageId,
    rootKey: snapshot.rootKey,
    rootPriority: snapshot.rootPriority,
    qualifiedName: snapshot.qualifiedName,
    scope: snapshot.scope,
    activationPolicy: snapshot.activationPolicy,
    name: snapshot.name,
    description: snapshot.description,
    relativePath: snapshot.relativePath,
    digest: snapshot.digest,
  };
}

function subagentSkillFingerprint(snapshot: SubagentSkillSnapshot): string {
  return JSON.stringify(snapshot);
}

function subagentSkillsEqual(
  left: readonly SubagentSkillSnapshot[],
  right: readonly SubagentSkillSnapshot[],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function subagentMcpToolFingerprint(snapshot: SubagentMcpToolSnapshot): string {
  return JSON.stringify(snapshot);
}

function subagentMcpToolsEqual(
  left: readonly SubagentMcpToolSnapshot[],
  right: readonly SubagentMcpToolSnapshot[],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function subagentCapabilityBaseProfile(
  snapshot: SubagentCapabilitySnapshot,
): SubagentProfileId {
  return snapshot.profile === "explorer" ||
    snapshot.profile === "reviewer" ||
    snapshot.profile === "writer"
    ? snapshot.profile
    : snapshot.baseProfile;
}

export function subagentCapabilityIsWriter(
  snapshot: SubagentCapabilitySnapshot,
): snapshot is WriterSubagentCapabilitySnapshot {
  return subagentCapabilityBaseProfile(snapshot) === "writer";
}

export function compareSubagentCapability(
  candidate: SubagentCapabilitySnapshot,
  ceiling: SubagentCapabilitySnapshot,
): SubagentCapabilityRelation {
  if (
    subagentCapabilityBaseProfile(candidate) !==
    subagentCapabilityBaseProfile(ceiling)
  ) {
    return { kind: "expansion", dimension: "baseProfile" };
  }
  const ceilingTools: ReadonlySet<SubagentBuiltinToolName> = new Set(
    ceiling.builtinTools,
  );
  if (candidate.builtinTools.some((tool) => !ceilingTools.has(tool))) {
    return { kind: "expansion", dimension: "builtinTools" };
  }
  const ceilingSkills = new Set(ceiling.skills.map(subagentSkillFingerprint));
  if (
    candidate.skills.some(
      (skill) => !ceilingSkills.has(subagentSkillFingerprint(skill)),
    )
  ) {
    return { kind: "expansion", dimension: "skills" };
  }
  const ceilingMcpTools = new Set(
    ceiling.mcpTools.map(subagentMcpToolFingerprint),
  );
  if (
    candidate.mcpTools.some(
      (tool) => !ceilingMcpTools.has(subagentMcpToolFingerprint(tool)),
    )
  ) {
    return { kind: "expansion", dimension: "mcpTools" };
  }
  if (candidate.maxTurns > ceiling.maxTurns) {
    return { kind: "expansion", dimension: "maxTurns" };
  }
  if (candidate.deadlineMs > ceiling.deadlineMs) {
    return { kind: "expansion", dimension: "deadlineMs" };
  }
  if (candidate.maxFinalTextChars > ceiling.maxFinalTextChars) {
    return { kind: "expansion", dimension: "maxFinalTextChars" };
  }
  return { kind: "subset" };
}

export function narrowSubagentCapabilityLimits(
  snapshot: ReadOnlySubagentCapabilitySnapshot,
  limits: {
    readonly maxTurns?: number;
    readonly deadlineMs?: number;
    readonly maxFinalTextChars?: number;
  },
): ReadOnlySubagentCapabilitySnapshot;
export function narrowSubagentCapabilityLimits(
  snapshot: WriterSubagentCapabilitySnapshot,
  limits: {
    readonly maxTurns?: number;
    readonly deadlineMs?: number;
    readonly maxFinalTextChars?: number;
  },
): WriterSubagentCapabilitySnapshot;
export function narrowSubagentCapabilityLimits(
  snapshot: SubagentCapabilitySnapshot,
  limits: {
    readonly maxTurns?: number;
    readonly deadlineMs?: number;
    readonly maxFinalTextChars?: number;
  },
): SubagentCapabilitySnapshot;
export function narrowSubagentCapabilityLimits(
  snapshot: SubagentCapabilitySnapshot,
  limits: {
    readonly maxTurns?: number;
    readonly deadlineMs?: number;
    readonly maxFinalTextChars?: number;
  },
): SubagentCapabilitySnapshot {
  const narrowedLimits = {
    maxTurns: Math.min(limits.maxTurns ?? snapshot.maxTurns, snapshot.maxTurns),
    deadlineMs: Math.min(
      limits.deadlineMs ?? snapshot.deadlineMs,
      snapshot.deadlineMs,
    ),
    maxFinalTextChars: Math.min(
      limits.maxFinalTextChars ?? snapshot.maxFinalTextChars,
      snapshot.maxFinalTextChars,
    ),
  };
  return { ...snapshot, ...narrowedLimits };
}

export function narrowSubagentCapabilityToCeiling<
  Capability extends SubagentCapabilitySnapshot,
>(snapshot: Capability, ceiling: SubagentCapabilitySnapshot): Capability;
export function narrowSubagentCapabilityToCeiling(
  snapshot: SubagentCapabilitySnapshot,
  ceiling: SubagentCapabilitySnapshot,
): SubagentCapabilitySnapshot {
  const narrowed = narrowSubagentCapabilityLimits(snapshot, ceiling);
  const ceilingSkills = new Set(ceiling.skills.map(subagentSkillFingerprint));
  const skills = narrowed.skills.filter((skill) =>
    ceilingSkills.has(subagentSkillFingerprint(skill)),
  );
  const ceilingMcpTools = new Set(
    ceiling.mcpTools.map(subagentMcpToolFingerprint),
  );
  const mcpTools = narrowed.mcpTools.filter((tool) =>
    ceilingMcpTools.has(subagentMcpToolFingerprint(tool)),
  );
  if (
    narrowed.profile === "explorer" ||
    narrowed.profile === "reviewer" ||
    narrowed.profile === "writer"
  ) {
    return { ...narrowed, skills, mcpTools };
  }
  const ceilingTools: ReadonlySet<SubagentBuiltinToolName> = new Set(
    ceiling.builtinTools,
  );
  return {
    ...narrowed,
    skills,
    mcpTools,
    builtinTools: narrowed.builtinTools.filter((tool) =>
      ceilingTools.has(tool),
    ),
  };
}

export function subagentCapabilityWithSkills<
  Capability extends SubagentCapabilitySnapshot,
>(snapshot: Capability, skills: readonly SubagentSkillSnapshot[]): Capability {
  return { ...snapshot, skills: [...skills] };
}

export function subagentCapabilityWithMcpTools<
  Capability extends SubagentCapabilitySnapshot,
>(
  snapshot: Capability,
  mcpTools: readonly SubagentMcpToolSnapshot[],
): Capability {
  return { ...snapshot, mcpTools: [...mcpTools] };
}

export function selectSubagentCapabilitySkills<
  Capability extends SubagentCapabilitySnapshot,
>(snapshot: Capability, qualifiedNames: readonly string[]): Capability | null {
  const requested = new Set(qualifiedNames);
  if (
    qualifiedNames.length > MAX_SUBAGENT_SKILLS ||
    requested.size !== qualifiedNames.length
  ) {
    return null;
  }
  const skills = snapshot.skills.filter((skill) =>
    requested.has(skill.qualifiedName),
  );
  return skills.length === requested.size
    ? subagentCapabilityWithSkills(snapshot, skills)
    : null;
}

export function selectSubagentCapabilityMcpTools<
  Capability extends SubagentCapabilitySnapshot,
>(
  snapshot: Capability,
  selectors: readonly SubagentMcpToolSelector[],
): Capability | null {
  const requested = new Set(
    selectors.map(({ server, tool }) => `${server}\u0000${tool}`),
  );
  if (
    selectors.length > MAX_SUBAGENT_MCP_TOOLS ||
    requested.size !== selectors.length
  ) {
    return null;
  }
  const mcpTools = snapshot.mcpTools.filter((candidate) =>
    requested.has(`${candidate.serverId}\u0000${candidate.rawToolName}`),
  );
  return mcpTools.length === requested.size
    ? subagentCapabilityWithMcpTools(snapshot, mcpTools)
    : null;
}

export function subagentCapabilityFingerprint(
  snapshot: SubagentCapabilitySnapshot,
): string {
  return JSON.stringify({
    id: snapshot.id,
    profile: snapshot.profile,
    baseProfile: subagentCapabilityBaseProfile(snapshot),
    builtinTools: snapshot.builtinTools,
    skills: snapshot.skills,
    mcpTools: snapshot.mcpTools,
    maxTurns: snapshot.maxTurns,
    deadlineMs: snapshot.deadlineMs,
    maxFinalTextChars: snapshot.maxFinalTextChars,
  });
}

export function subagentCapabilitiesEqual(
  left: SubagentCapabilitySnapshot,
  right: SubagentCapabilitySnapshot,
): boolean {
  return (
    left.id === right.id &&
    left.profile === right.profile &&
    subagentCapabilityBaseProfile(left) ===
      subagentCapabilityBaseProfile(right) &&
    left.maxTurns === right.maxTurns &&
    left.deadlineMs === right.deadlineMs &&
    left.maxFinalTextChars === right.maxFinalTextChars &&
    subagentSkillsEqual(left.skills, right.skills) &&
    subagentMcpToolsEqual(left.mcpTools, right.mcpTools) &&
    left.builtinTools.length === right.builtinTools.length &&
    left.builtinTools.every((tool, index) => tool === right.builtinTools[index])
  );
}
