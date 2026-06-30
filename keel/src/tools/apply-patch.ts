import type { RecordLastBatchCheckpointOperation } from "../core/git.ts";
import { recordLastBatchCheckpoint } from "../core/git.ts";
import {
  appliedTargetPaths,
  checkpointOperationsFor,
  summaryLine,
} from "./apply-patch/checkpoint.ts";
import type {
  AppliedPatchOperation,
  ExecuteApplyPatchOptions,
} from "./apply-patch/model.ts";
import {
  applyPreparedOperation,
  verifyAppliedOperation,
} from "./apply-patch/mutation.ts";
import { parsePatch } from "./apply-patch/parser.ts";
import {
  preparedMutationTargetPaths,
  preparePatchOperations,
} from "./apply-patch/prepare.ts";
import {
  applyWithRollback,
  rollbackAppliedOperations,
} from "./apply-patch/rollback.ts";
import type { ToolResult } from "./types.ts";

export type { ParsedPatchOperation } from "./apply-patch/model.ts";
export { parsePatch } from "./apply-patch/parser.ts";

interface ApplyPatchToolResult extends ToolResult {
  readonly targetPaths: readonly string[];
  readonly checkpointOperations: readonly RecordLastBatchCheckpointOperation[];
}

export function executeApplyPatch(
  workspace: string,
  patch: string,
  options: ExecuteApplyPatchOptions = {},
): ApplyPatchToolResult {
  const operations = parsePatch(patch);
  const prepared = preparePatchOperations(workspace, operations, options);
  options.projectInstructions?.assertMutationAllowed(
    prepared.flatMap(preparedMutationTargetPaths),
  );
  const applied: AppliedPatchOperation[] = [];
  const checkpointOperations = applyWithRollback({
    appliedOperations: applied,
    rollback: rollbackAppliedOperations,
    apply: () => {
      for (const operation of prepared) {
        const appliedOperation = applyPreparedOperation(operation, options);
        applied.push(appliedOperation);
        applied[applied.length - 1] = verifyAppliedOperation(appliedOperation);
      }
      const operations = applied.flatMap(checkpointOperationsFor);
      recordLastBatchCheckpoint({
        workspace,
        operations,
      });
      return operations;
    },
  });

  return {
    content: ["Applied patch:", ...prepared.map(summaryLine)].join("\n"),
    targetPaths: applied.flatMap(appliedTargetPaths),
    checkpointOperations,
  };
}
