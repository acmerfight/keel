export type UndoCheckpointUnavailableReason =
  | "checkpoint_write_failed"
  | "git_workspace_unavailable"
  | "target_unavailable";

export type RecordUndoCheckpointResult =
  | { readonly written: true }
  | {
      readonly written: false;
      readonly reason: UndoCheckpointUnavailableReason | "no_changes";
    };

interface UndoProtectionFailure {
  readonly reason: UndoCheckpointUnavailableReason;
  readonly count: number;
}

type UndoCheckpointProtectionResult =
  | { readonly written: true }
  | {
      readonly written: false;
      readonly reason: UndoCheckpointUnavailableReason;
    };

export interface UndoProtectionSummary {
  readonly status: "available" | "not_applicable" | "unavailable";
  readonly checkpointsWritten: number;
  readonly failures: readonly UndoProtectionFailure[];
  readonly latestCheckpoint: UndoCheckpointProtectionResult | null;
}

export interface UndoProtectionTracker {
  readonly record: (result: RecordUndoCheckpointResult) => void;
  readonly summary: () => UndoProtectionSummary;
}

export function undoCheckpointUnavailable(
  result: RecordUndoCheckpointResult,
): result is {
  readonly written: false;
  readonly reason: UndoCheckpointUnavailableReason;
} {
  return result.written === false && result.reason !== "no_changes";
}

export function createUndoProtectionTracker(): UndoProtectionTracker {
  let checkpointsWritten = 0;
  let latestCheckpoint: UndoCheckpointProtectionResult | null = null;
  const failureCounts = new Map<UndoCheckpointUnavailableReason, number>();
  return {
    record: (result) => {
      if (result.written) {
        checkpointsWritten += 1;
        latestCheckpoint = result;
        return;
      }
      if (result.reason === "no_changes") return;
      latestCheckpoint = { written: false, reason: result.reason };
      failureCounts.set(
        result.reason,
        (failureCounts.get(result.reason) ?? 0) + 1,
      );
    },
    summary: () => {
      const failures = [...failureCounts].map(([reason, count]) => ({
        reason,
        count,
      }));
      return {
        status:
          failures.length > 0
            ? "unavailable"
            : checkpointsWritten > 0
              ? "available"
              : "not_applicable",
        checkpointsWritten,
        failures,
        latestCheckpoint,
      };
    },
  };
}
