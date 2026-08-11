import type {
  SubagentBuiltinToolName,
  SubagentCapabilitySnapshot,
  SubagentProfileId,
} from "./subagent-capability.ts";
import {
  EXPLORER_MAX_TURNS,
  REVIEWER_MAX_TURNS,
  SUBAGENT_DEADLINE_MS,
  SUBAGENT_MAX_FINAL_TEXT_CHARS,
} from "./subagent-capability.ts";

interface BuiltinSubagentProfile {
  readonly snapshot: SubagentCapabilitySnapshot;
  readonly roleInstructions: string;
}

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
