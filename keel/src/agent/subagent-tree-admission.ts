const DEFAULT_MAX_ACTIVE_AGENT_RUNS = 5;
const DEFAULT_MAX_TOTAL_CHILD_RUNS = 8;

export type SubagentAdmissionRejection = "active_limit" | "total_limit";

export interface SubagentAdmissionLease<Value> {
  readonly value: Value;
  readonly release: () => void;
}

interface SubagentAdmissionPlan<Value> {
  readonly admitted: readonly Value[];
  readonly rejected: readonly {
    readonly value: Value;
    readonly reason: SubagentAdmissionRejection;
  }[];
}

export interface SubagentTreeAdmission {
  readonly available: () => boolean;
  readonly plan: <Value>(
    requested: readonly Value[],
  ) => SubagentAdmissionPlan<Value>;
  readonly commit: <Value>(
    admitted: readonly Value[],
  ) => readonly SubagentAdmissionLease<Value>[];
  readonly activeAgentRunCount: () => number;
  readonly totalChildRunCount: () => number;
}

interface CreateSubagentTreeAdmissionOptions {
  readonly maxActiveAgentRuns?: number;
  readonly maxTotalChildRuns?: number;
}

export function createSubagentTreeAdmission(
  options: CreateSubagentTreeAdmissionOptions = {},
): SubagentTreeAdmission {
  const maxActiveAgentRuns =
    options.maxActiveAgentRuns ?? DEFAULT_MAX_ACTIVE_AGENT_RUNS;
  const maxTotalChildRuns =
    options.maxTotalChildRuns ?? DEFAULT_MAX_TOTAL_CHILD_RUNS;
  let activeChildRuns = 0;
  let totalChildRuns = 0;

  const activeCapacity = (): number =>
    Math.max(0, maxActiveAgentRuns - 1 - activeChildRuns);
  const totalCapacity = (): number =>
    Math.max(0, maxTotalChildRuns - totalChildRuns);
  const available = (): boolean => activeCapacity() > 0 && totalCapacity() > 0;

  return {
    available,
    plan: (requested) => {
      const currentActiveCapacity = activeCapacity();
      const currentTotalCapacity = totalCapacity();
      const admittedCount = Math.min(
        requested.length,
        currentActiveCapacity,
        currentTotalCapacity,
      );
      return {
        admitted: requested.slice(0, admittedCount),
        rejected: requested.slice(admittedCount).map((value, offset) => ({
          value,
          reason:
            admittedCount + offset >= currentTotalCapacity
              ? "total_limit"
              : "active_limit",
        })),
      };
    },
    commit: (admitted) => {
      activeChildRuns += admitted.length;
      totalChildRuns += admitted.length;
      return admitted.map((value) => ({
        value,
        release: () => {
          activeChildRuns--;
        },
      }));
    },
    activeAgentRunCount: () => 1 + activeChildRuns,
    totalChildRunCount: () => totalChildRuns,
  };
}
