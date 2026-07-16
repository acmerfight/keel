import { readFileSync, statSync } from "node:fs";
import { KeelError } from "../../core/error.ts";
import { type FileIdentity, sameFileIdentity } from "../workspace-path.ts";
import type { PreparedPatchOperation } from "./model.ts";

export function readFileIfPossible(filePath: string): string | null {
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    // rollback tolerates concurrent file removal.
    return null;
  }
}

export function pathHasIdentity(path: string, identity: FileIdentity): boolean {
  try {
    return sameFileIdentity(statSync(path), identity);
  } catch {
    // rollback tolerates concurrently removed target paths.
    return false;
  }
}

export function uniquePaths(paths: readonly string[]): readonly string[] {
  return [...new Set(paths)];
}

export function isErrnoException(
  error: unknown,
): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export function changedTargetError(
  operation: PreparedPatchOperation,
): KeelError {
  return new KeelError(
    "tool_path_outside_workspace",
    `apply_patch failed: path changed outside the verified workspace target: ${operation.path}`,
    "Retry after ensuring the target path remains stable within the workspace.",
  );
}
