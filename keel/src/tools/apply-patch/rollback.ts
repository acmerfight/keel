import { chmodSync, rmSync, writeFileSync } from "node:fs";
import { KeelError } from "../../core/error.ts";
import { restoreTextFileByIdentityBestEffort } from "../atomic-write.ts";
import {
  assertWorkspaceTargetAtAccess,
  findWorkspacePathsByIdentity,
  rollbackWorkspaceParentDirectoriesBestEffort,
} from "../workspace-path.ts";
import {
  isErrnoException,
  pathHasIdentity,
  readFileIfPossible,
  uniquePaths,
} from "./filesystem.ts";
import type { AppliedPatchOperation } from "./model.ts";

export function applyWithRollback<AppliedOperation, Result>(options: {
  readonly apply: (appliedOperations: AppliedOperation[]) => Result;
  readonly rollback: (appliedOperations: readonly AppliedOperation[]) => void;
}): Result {
  const appliedOperations: AppliedOperation[] = [];
  try {
    return options.apply(appliedOperations);
  } catch (error) {
    options.rollback(appliedOperations);
    throw error;
  }
}

function restoreDeletedTextFileBestEffort(
  operation: Extract<
    AppliedPatchOperation,
    { readonly kind: "delete" | "move" }
  >,
): void {
  /* v8 ignore next 1: move rollback needs a deterministic post-move failure; delete rollback covers restoration. */
  const mode =
    operation.kind === "move" ? operation.rollbackMode : operation.mode;
  try {
    writeFileSync(operation.targetPath, operation.beforeContent, {
      encoding: "utf8",
      flag: "wx",
      mode,
    });
    chmodSync(operation.targetPath, mode);
  } catch {
    /* v8 ignore next 1: rollback is best-effort and must not overwrite user-created files. */
  }
}

function rollbackTargetPaths(
  operation: Extract<
    AppliedPatchOperation,
    { readonly kind: "add" | "copy" | "update" }
  >,
): readonly string[] {
  const identity = operation.appliedIdentity;
  try {
    const targetPath = assertWorkspaceTargetAtAccess({
      workspacePath: operation.workspacePath,
      targetPath: operation.targetPath,
      toolName: "apply_patch",
      requestedPath: operation.path,
    });
    if (pathHasIdentity(targetPath, identity)) {
      return uniquePaths([
        targetPath,
        ...findWorkspacePathsByIdentity(operation.workspacePath, identity),
      ]);
    }
    return findWorkspacePathsByIdentity(operation.workspacePath, identity);
  } catch (error) {
    if (
      isErrnoException(error) &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")
    ) {
      /* v8 ignore next 1: rollback may run after a concurrent remove. */
      return findWorkspacePathsByIdentity(operation.workspacePath, identity);
    }
    if (
      error instanceof KeelError &&
      error.code === "tool_path_outside_workspace"
    ) {
      const workspacePaths = findWorkspacePathsByIdentity(
        operation.workspacePath,
        identity,
      );
      /* v8 ignore next 3: covered outside rollback paths either restore by workspace scan or skip non-Keel files. */
      if (pathHasIdentity(operation.targetPath, identity)) {
        return uniquePaths([...workspacePaths, operation.targetPath]);
      }
      return workspacePaths;
    }
    /* v8 ignore next 1: assertWorkspaceTargetAtAccess only throws handled path errors here. */
    throw error;
  }
}

export function rollbackAppliedOperations(
  applied: readonly AppliedPatchOperation[],
): void {
  for (const operation of applied.toReversed()) {
    if (operation.kind === "move") {
      if (
        pathHasIdentity(
          operation.destinationTargetPath,
          operation.destinationIdentity,
        ) &&
        readFileIfPossible(operation.destinationTargetPath) ===
          operation.afterContent
      ) {
        rmSync(operation.destinationTargetPath, { force: true });
      }
      restoreDeletedTextFileBestEffort(operation);
      rollbackWorkspaceParentDirectoriesBestEffort(
        operation.createdDestinationParentDirectories,
      );
      continue;
    }

    if (operation.kind === "delete") {
      restoreDeletedTextFileBestEffort(operation);
      continue;
    }

    const targetPaths = rollbackTargetPaths(operation);
    if (operation.kind === "add" || operation.kind === "copy") {
      for (const targetPath of targetPaths) {
        /* v8 ignore next 1: rollback skips files changed concurrently after the failed operation. */
        if (readFileIfPossible(targetPath) === operation.afterContent) {
          rmSync(targetPath, { force: true });
        }
      }
      rollbackWorkspaceParentDirectoriesBestEffort(
        operation.createdParentDirectories,
      );
      continue;
    }

    if (targetPaths.length === 0) continue;

    for (const targetPath of targetPaths) {
      /* v8 ignore next 1: rollback skips paths that lose the applied identity after path discovery. */
      if (pathHasIdentity(targetPath, operation.appliedIdentity)) {
        restoreTextFileByIdentityBestEffort(
          targetPath,
          operation.appliedIdentity,
          {
            beforeContent: operation.beforeContent,
            afterContent: operation.afterContent,
          },
          operation.rollbackMode,
        );
      }
    }
  }
}
