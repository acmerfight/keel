export const subagentProfileIds = ["explorer", "reviewer"] as const;

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
] as const;

export type SubagentBuiltinToolName = (typeof subagentBuiltinToolNames)[number];

export const SUBAGENT_MAX_FINAL_TEXT_CHARS = 4_000;
export const SUBAGENT_DEADLINE_MS = 120_000;
export const EXPLORER_MAX_TURNS = 16;
export const REVIEWER_MAX_TURNS = 20;

interface SubagentCapabilityLimits {
  readonly maxTurns: number;
  readonly deadlineMs: number;
  readonly maxFinalTextChars: number;
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

export type RepoSubagentCapabilitySnapshotId = `repo-profile-v1:${string}`;

interface RepoSubagentCapabilitySnapshot extends SubagentCapabilityLimits {
  readonly id: RepoSubagentCapabilitySnapshotId;
  readonly profile: RepoSubagentProfileName;
  readonly baseProfile: SubagentProfileId;
  readonly builtinTools: readonly SubagentBuiltinToolName[];
}

export type SubagentCapabilitySnapshot =
  | ExplorerCapabilitySnapshot
  | ReviewerCapabilitySnapshot
  | RepoSubagentCapabilitySnapshot;

type SubagentCapabilityDimension =
  | "baseProfile"
  | "builtinTools"
  | "maxTurns"
  | "deadlineMs"
  | "maxFinalTextChars";

export type SubagentCapabilityRelation =
  | { readonly kind: "subset" }
  | {
      readonly kind: "expansion";
      readonly dimension: SubagentCapabilityDimension;
    };

export function subagentCapabilityBaseProfile(
  snapshot: SubagentCapabilitySnapshot,
): SubagentProfileId {
  return snapshot.profile === "explorer" || snapshot.profile === "reviewer"
    ? snapshot.profile
    : snapshot.baseProfile;
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
  if (snapshot.profile === "explorer") {
    return { ...snapshot, ...narrowedLimits };
  }
  if (snapshot.profile === "reviewer") {
    return { ...snapshot, ...narrowedLimits };
  }
  return {
    ...snapshot,
    ...narrowedLimits,
    builtinTools: [...snapshot.builtinTools],
  };
}

export function narrowSubagentCapabilityToCeiling(
  snapshot: SubagentCapabilitySnapshot,
  ceiling: SubagentCapabilitySnapshot,
): SubagentCapabilitySnapshot {
  const narrowed = narrowSubagentCapabilityLimits(snapshot, ceiling);
  if (narrowed.profile === "explorer" || narrowed.profile === "reviewer") {
    return narrowed;
  }
  const ceilingTools: ReadonlySet<SubagentBuiltinToolName> = new Set(
    ceiling.builtinTools,
  );
  return {
    ...narrowed,
    builtinTools: narrowed.builtinTools.filter((tool) =>
      ceilingTools.has(tool),
    ),
  };
}

export function subagentCapabilityFingerprint(
  snapshot: SubagentCapabilitySnapshot,
): string {
  return JSON.stringify({
    id: snapshot.id,
    profile: snapshot.profile,
    baseProfile: subagentCapabilityBaseProfile(snapshot),
    builtinTools: snapshot.builtinTools,
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
    left.builtinTools.length === right.builtinTools.length &&
    left.builtinTools.every((tool, index) => tool === right.builtinTools[index])
  );
}
