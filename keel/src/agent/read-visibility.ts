import {
  type ToolExecution,
  toolExecutionEffect,
  toolExecutionEffects,
} from "../tools/execution.ts";

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
    if (!execution.ok) {
      return;
    }
    for (const mutation of toolExecutionEffects(execution, "mutation")) {
      for (const targetPath of mutation.targetPaths) {
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
        const read = toolExecutionEffect(execution, "read");
        if (read !== undefined) {
          // Delete+set refreshes Map insertion order so iteration is recency ordered.
          visibleReads.delete(read.targetPath);
          visibleReads.set(read.targetPath, {
            targetPath: read.targetPath,
            ...(read.offset !== undefined ? { offset: read.offset } : {}),
            ...(read.limit !== undefined ? { limit: read.limit } : {}),
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
