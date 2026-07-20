import type { RecordLastBatchCheckpointOperation } from "../core/git.ts";
import type { ReadResourceObservation } from "../core/resource-observation.ts";
import type { ToolExecution } from "../tools/execution.ts";

const TEST_READ_RESOURCE_OBSERVATION: ReadResourceObservation = {
  kind: "read_projection",
  targetPathSha256: "test-target-path",
  contentSha256: "test-content",
};

export function successfulReadToolExecution(options: {
  readonly targetPath: string;
  readonly content?: string;
  readonly offset?: number;
  readonly limit?: number;
}): ToolExecution {
  return {
    ok: true,
    content: options.content ?? "",
    effects: [
      {
        kind: "read",
        targetPath: options.targetPath,
        resourceObservation: TEST_READ_RESOURCE_OBSERVATION,
        ...(options.offset !== undefined ? { offset: options.offset } : {}),
        ...(options.limit !== undefined ? { limit: options.limit } : {}),
      },
    ],
  };
}

export function successfulMutationToolExecution(options: {
  readonly targetPaths: readonly string[];
  readonly content?: string;
  readonly checkpointOperations?: readonly RecordLastBatchCheckpointOperation[];
}): ToolExecution {
  return {
    ok: true,
    content: options.content ?? "",
    effects: [
      {
        kind: "mutation",
        targetPaths: options.targetPaths,
        checkpointOperations: options.checkpointOperations ?? [],
      },
    ],
  };
}
