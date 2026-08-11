export const subagentProfileIds = ["explorer", "reviewer"] as const;

export type SubagentProfileId = (typeof subagentProfileIds)[number];

const subagentBuiltinToolNames = [
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

export type SubagentCapabilitySnapshot =
  | ExplorerCapabilitySnapshot
  | ReviewerCapabilitySnapshot;

export function subagentCapabilitiesEqual(
  left: SubagentCapabilitySnapshot,
  right: SubagentCapabilitySnapshot,
): boolean {
  return (
    left.id === right.id &&
    left.profile === right.profile &&
    left.maxTurns === right.maxTurns &&
    left.deadlineMs === right.deadlineMs &&
    left.maxFinalTextChars === right.maxFinalTextChars &&
    left.builtinTools.length === right.builtinTools.length &&
    left.builtinTools.every((tool, index) => tool === right.builtinTools[index])
  );
}
