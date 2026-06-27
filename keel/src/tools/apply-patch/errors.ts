import { KeelError } from "../../core/error.ts";

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
