export const subagentNonCompletedStatuses = [
  "failed",
  "turn_limited",
  "timed_out",
  "budget_limited",
  "provider_blocked",
  "cancelled",
  "interrupted",
] as const;

export const subagentTerminalStatuses = [
  "completed",
  ...subagentNonCompletedStatuses,
] as const;

export type SubagentTerminalStatus = (typeof subagentTerminalStatuses)[number];
