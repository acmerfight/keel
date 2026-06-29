import { patchError } from "./errors.ts";
import type { ParsedPatchHunk, ParsedPatchOperation } from "./model.ts";

const BEGIN_PATCH_MARKER = "*** Begin Patch";
const END_PATCH_MARKER = "*** End Patch";
const ADD_FILE_MARKER = "*** Add File: ";
const DELETE_FILE_MARKER = "*** Delete File: ";
const UPDATE_FILE_MARKER = "*** Update File: ";
const MOVE_TO_MARKER = "*** Move to: ";
const HUNK_MARKER = "@@";

function isFileOperationHeader(line: string): boolean {
  return (
    line.startsWith(ADD_FILE_MARKER) ||
    line.startsWith(DELETE_FILE_MARKER) ||
    line.startsWith(UPDATE_FILE_MARKER)
  );
}

function requiredPathFromHeader(line: string, marker: string): string {
  const path = line.slice(marker.length).trim();
  if (path === "") {
    throw patchError(
      "tool_invalid_patch",
      "apply_patch failed: patch file header is missing a path",
      "Include a workspace-relative path after each patch file operation header.",
    );
  }
  return path;
}

function parserLine(lines: readonly string[], index: number): string {
  const line = lines[index];
  /* v8 ignore next 3: parser callers check bounds before reading a line. */
  if (line === undefined) {
    throw new Error("apply_patch parser line invariant violated");
  }
  return line;
}

function parseAddOperation(
  lines: readonly string[],
  start: number,
): { readonly operation: ParsedPatchOperation; readonly next: number } {
  const path = requiredPathFromHeader(
    parserLine(lines, start),
    ADD_FILE_MARKER,
  );
  const contentLines: string[] = [];
  let index = start + 1;
  while (
    index < lines.length &&
    !isFileOperationHeader(parserLine(lines, index))
  ) {
    const line = parserLine(lines, index);
    if (!line.startsWith("+")) {
      throw patchError(
        "tool_invalid_patch",
        `apply_patch failed: add file ${path} contains a line without + prefix`,
        "Prefix every new file content line with +.",
      );
    }
    contentLines.push(line.slice(1));
    index++;
  }
  if (contentLines.length === 0) {
    throw patchError(
      "tool_invalid_patch",
      `apply_patch failed: add file ${path} has no content lines`,
      "Add at least one + line for the new file content.",
    );
  }
  return { operation: { kind: "add", path, lines: contentLines }, next: index };
}

function parseDeleteOperation(
  lines: readonly string[],
  start: number,
): { readonly operation: ParsedPatchOperation; readonly next: number } {
  const path = requiredPathFromHeader(
    parserLine(lines, start),
    DELETE_FILE_MARKER,
  );
  return { operation: { kind: "delete", path }, next: start + 1 };
}

function parseUpdateHunk(
  path: string,
  lines: readonly string[],
  start: number,
): { readonly hunk: ParsedPatchHunk; readonly next: number } {
  const oldLines: string[] = [];
  const newLines: string[] = [];
  let index = start + 1;
  while (
    index < lines.length &&
    !isFileOperationHeader(parserLine(lines, index)) &&
    !parserLine(lines, index).startsWith(HUNK_MARKER)
  ) {
    const line = parserLine(lines, index);
    if (line.startsWith(" ")) {
      oldLines.push(line.slice(1));
      newLines.push(line.slice(1));
    } else if (line.startsWith("-")) {
      oldLines.push(line.slice(1));
    } else if (line.startsWith("+")) {
      newLines.push(line.slice(1));
    } else {
      throw patchError(
        "tool_invalid_patch",
        `apply_patch failed: update hunk for ${path} has an invalid line`,
        "Use hunk lines prefixed with space, -, or +.",
      );
    }
    index++;
  }

  if (oldLines.length === 0 || oldLines.every((line) => line === "")) {
    throw patchError(
      "tool_invalid_patch",
      `apply_patch failed: update hunk for ${path} has no effective old lines`,
      "Include at least one non-empty context or removed line so the patch can locate the target text.",
    );
  }

  return { hunk: { oldLines, newLines }, next: index };
}

function parseUpdateOperation(
  lines: readonly string[],
  start: number,
): { readonly operation: ParsedPatchOperation; readonly next: number } {
  const path = requiredPathFromHeader(
    parserLine(lines, start),
    UPDATE_FILE_MARKER,
  );
  const hunks: ParsedPatchHunk[] = [];
  let index = start + 1;
  let movePath: string | null = null;
  if (
    index < lines.length &&
    parserLine(lines, index).startsWith(MOVE_TO_MARKER)
  ) {
    movePath = requiredPathFromHeader(parserLine(lines, index), MOVE_TO_MARKER);
    index++;
  }
  while (
    index < lines.length &&
    !isFileOperationHeader(parserLine(lines, index))
  ) {
    const line = parserLine(lines, index);
    if (!line.startsWith(HUNK_MARKER)) {
      throw patchError(
        "tool_invalid_patch",
        `apply_patch failed: update file ${path} is missing a hunk header`,
        "Start each update hunk with @@ before listing context, removed, and added lines.",
      );
    }
    const parsed = parseUpdateHunk(path, lines, index);
    hunks.push(parsed.hunk);
    index = parsed.next;
  }
  if (hunks.length === 0 && movePath === null) {
    throw patchError(
      "tool_invalid_patch",
      `apply_patch failed: update file ${path} has no hunks`,
      "Add at least one @@ hunk to update this file.",
    );
  }
  return { operation: { kind: "update", path, movePath, hunks }, next: index };
}

export function parsePatch(patch: string): readonly ParsedPatchOperation[] {
  const lines = patch
    .replace(/\r\n/gu, "\n")
    .replace(/\r/gu, "\n")
    .trim()
    .split("\n");
  if (lines[0] !== BEGIN_PATCH_MARKER || lines.at(-1) !== END_PATCH_MARKER) {
    throw patchError(
      "tool_invalid_patch",
      "apply_patch failed: patch must start with *** Begin Patch and end with *** End Patch",
      "Wrap the patch in the expected apply_patch envelope.",
    );
  }

  const body = lines.slice(1, -1);
  const operations: ParsedPatchOperation[] = [];
  let index = 0;
  while (index < body.length) {
    const line = parserLine(body, index);
    if (line.startsWith(ADD_FILE_MARKER)) {
      const parsed = parseAddOperation(body, index);
      operations.push(parsed.operation);
      index = parsed.next;
    } else if (line.startsWith(UPDATE_FILE_MARKER)) {
      const parsed = parseUpdateOperation(body, index);
      operations.push(parsed.operation);
      index = parsed.next;
    } else if (line.startsWith(DELETE_FILE_MARKER)) {
      const parsed = parseDeleteOperation(body, index);
      operations.push(parsed.operation);
      index = parsed.next;
    } else {
      throw patchError(
        "tool_invalid_patch",
        `apply_patch failed: invalid patch header: ${line}`,
        "Use *** Add File: <path>, *** Update File: <path>, or *** Delete File: <path> inside the patch.",
      );
    }
  }

  if (operations.length === 0) {
    throw patchError(
      "tool_invalid_patch",
      "apply_patch failed: patch contains no file operations",
      "Add at least one Add File, Update File, or Delete File operation.",
    );
  }
  return operations;
}
