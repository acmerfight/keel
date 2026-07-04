import type { ToolExecution } from "../tools/execution.ts";

const VISIBLE_READS_MAX_ENTRIES = 256;

interface VisibleReadSnapshot {
  readonly targetPath: string;
  readonly offset?: number;
  readonly limit?: number;
}

export interface ReadVisibilityState {
  readonly hasRead: (targetPath: string) => boolean;
  readonly visibleReadsMostRecentFirst: () => readonly VisibleReadSnapshot[];
  readonly clear: () => void;
  readonly snapshot: () => readonly VisibleReadSnapshot[];
  readonly restoreSnapshot: (snapshot: readonly VisibleReadSnapshot[]) => void;
  readonly applyImmediateMutation: (execution: ToolExecution) => void;
  readonly applyVisibleToolExecutions: (
    executions: readonly ToolExecution[],
  ) => void;
}

export function createReadVisibilityState(): ReadVisibilityState {
  const visibleReads = new Map<string, VisibleReadSnapshot>();
  const evictOldestVisibleReads = (): void => {
    while (visibleReads.size > VISIBLE_READS_MAX_ENTRIES) {
      const [oldestTargetPath] = visibleReads.keys();
      /* v8 ignore next 3: size is above the cap, so the map has an oldest key. */
      if (oldestTargetPath === undefined) {
        return;
      }
      visibleReads.delete(oldestTargetPath);
    }
  };
  const applyMutation = (execution: ToolExecution): void => {
    if (execution.ok && execution.mutatedTargetPath !== undefined) {
      visibleReads.delete(execution.mutatedTargetPath);
    }
    if (execution.ok && execution.mutatedTargetPaths !== undefined) {
      for (const targetPath of execution.mutatedTargetPaths) {
        visibleReads.delete(targetPath);
      }
    }
  };
  return {
    hasRead: (targetPath) => visibleReads.has(targetPath),
    visibleReadsMostRecentFirst: () => [...visibleReads.values()].reverse(),
    clear: () => visibleReads.clear(),
    snapshot: () => [...visibleReads.values()],
    restoreSnapshot: (snapshot) => {
      visibleReads.clear();
      for (const read of snapshot) {
        visibleReads.set(read.targetPath, read);
      }
    },
    applyImmediateMutation: applyMutation,
    applyVisibleToolExecutions: (executions) => {
      for (const execution of executions) {
        if (!execution.ok) continue;
        applyMutation(execution);
        if (execution.readTargetPath !== undefined) {
          // Delete+set refreshes Map insertion order so iteration is recency ordered.
          visibleReads.delete(execution.readTargetPath);
          visibleReads.set(execution.readTargetPath, {
            targetPath: execution.readTargetPath,
            ...(execution.readTargetOffset !== undefined
              ? { offset: execution.readTargetOffset }
              : {}),
            ...(execution.readTargetLimit !== undefined
              ? { limit: execution.readTargetLimit }
              : {}),
          });
          evictOldestVisibleReads();
        }
      }
    },
  };
}

export function clearReadVisibilityState(state: ReadVisibilityState): void {
  state.clear();
}
