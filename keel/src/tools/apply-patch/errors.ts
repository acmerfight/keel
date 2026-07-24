import { KeelError } from "../../core/error.ts";
import { type FileRevision, sameFileRevision } from "../file-revision.ts";
import type { ReadBeforeEdit } from "../read-before-edit.ts";

export const MAX_PATCH_EDIT_FILE_BYTES = 10 * 1024 * 1024;

export function patchError(
  code:
    | "tool_invalid_patch"
    | "tool_patch_hunk_not_found"
    | "tool_unsupported_patch_operation",
  message: string,
  recovery: string,
): KeelError {
  return new KeelError(code, message, recovery);
}

function formatByteCount(bytes: number): string {
  return `${bytes.toLocaleString("en-US")} bytes`;
}

export function fileTooLargeError(filePath: string, bytes: number): KeelError {
  return new KeelError(
    "tool_file_too_large",
    `apply_patch failed: file is too large: ${filePath} (${formatByteCount(bytes)}; limit ${formatByteCount(MAX_PATCH_EDIT_FILE_BYTES)})`,
    "Use read or grep to inspect a smaller target, then split the patch into smaller source files.",
  );
}

export function assertPatchReadRevision(
  readBeforeEdit: ReadBeforeEdit | undefined,
  targetPath: string,
  filePath: string,
  currentRevision: FileRevision,
): void {
  if (readBeforeEdit === undefined) return;
  const status = readBeforeEdit.revisionStatus(targetPath, currentRevision);
  if (status === "current") return;
  if (status === "unread") {
    throw new KeelError(
      "tool_file_not_read",
      `apply_patch failed: file has not been read: ${filePath}`,
      `Use read(path: "${filePath}") to view the current file content, then retry apply_patch with changes based on the read output.`,
    );
  }
  throw fileChangedSinceReadError(filePath);
}

export function assertPreparedFileRevision(
  readBeforeEdit: ReadBeforeEdit | undefined,
  targetPath: string,
  filePath: string,
  preparedRevision: FileRevision,
  currentRevision: FileRevision,
): void {
  if (!sameFileRevision(preparedRevision, currentRevision)) {
    throw fileChangedSinceReadError(filePath);
  }
  assertPatchReadRevision(
    readBeforeEdit,
    targetPath,
    filePath,
    currentRevision,
  );
}

function fileChangedSinceReadError(filePath: string): KeelError {
  return new KeelError(
    "tool_file_changed_since_read",
    `apply_patch failed: file has changed since it was read: ${filePath}`,
    `Use read(path: "${filePath}") to view the current file content, then regenerate and retry the patch from the new read output.`,
  );
}
