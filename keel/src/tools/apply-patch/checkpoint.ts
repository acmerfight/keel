import type { RecordLastBatchCheckpointOperation } from "../../core/git.ts";
import { assertWorkspaceTargetAtAccess } from "../workspace-path.ts";
import { changedTargetError, pathHasIdentity } from "./filesystem.ts";
import type { AppliedPatchOperation, PreparedPatchOperation } from "./model.ts";

export function checkpointOperationsFor(
  operation: AppliedPatchOperation,
): readonly RecordLastBatchCheckpointOperation[] {
  if (operation.kind === "move") {
    return [
      {
        operation: "delete",
        filePath: operation.targetPath,
        beforeContent: operation.beforeContent,
        mode: operation.rollbackMode,
      },
      {
        operation: "create",
        filePath: operation.destinationTargetPath,
        afterContent: operation.afterContent,
        ...(operation.modeChange === null ? {} : { mode: operation.mode }),
      },
    ];
  }

  if (operation.kind === "delete") {
    /* v8 ignore next 3: verifyAppliedOperation rejects this first except for a race between verification and checkpointing. */
    if (pathHasIdentity(operation.targetPath, operation.appliedIdentity)) {
      throw changedTargetError(operation);
    }
    return [
      {
        operation: "delete",
        filePath: operation.targetPath,
        beforeContent: operation.beforeContent,
        mode: operation.mode,
      },
    ];
  }

  const targetPath = assertWorkspaceTargetAtAccess({
    workspacePath: operation.workspacePath,
    targetPath: operation.targetPath,
    toolName: "apply_patch",
    requestedPath: operation.path,
  });
  if (!pathHasIdentity(targetPath, operation.appliedIdentity)) {
    throw changedTargetError(operation);
  }
  if (operation.kind === "add" || operation.kind === "copy") {
    const mode =
      operation.kind === "add"
        ? operation.mode
        : operation.modeChange === null
          ? null
          : operation.mode;
    return [
      {
        operation: "create",
        filePath: targetPath,
        afterContent: operation.afterContent,
        ...(mode === null ? {} : { mode }),
      },
    ];
  }
  return [
    {
      operation: "edit",
      filePath: targetPath,
      beforeContent: operation.beforeContent,
      afterContent: operation.afterContent,
      ...(operation.modeChange === null
        ? {}
        : {
            beforeMode: operation.modeChange.beforeMode,
            afterMode: operation.modeChange.afterMode,
          }),
    },
  ];
}

export function summaryLine(operation: PreparedPatchOperation): string {
  if (operation.kind === "move") {
    return `R ${operation.path} -> ${operation.movePath}`;
  }
  if (operation.kind === "copy") {
    return `C ${operation.sourcePath} -> ${operation.path}`;
  }
  const marker =
    operation.kind === "add" ? "A" : operation.kind === "update" ? "M" : "D";
  return `${marker} ${operation.path}`;
}

export function appliedTargetPaths(
  operation: AppliedPatchOperation,
): readonly string[] {
  if (operation.kind === "move") {
    return [operation.targetPath, operation.destinationTargetPath];
  }
  return [operation.targetPath];
}
