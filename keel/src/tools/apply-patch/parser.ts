import { patchError } from "./errors.ts";
import type { ParsedPatchHunk, ParsedPatchOperation } from "./model.ts";

const BEGIN_PATCH_MARKER = "*** Begin Patch";
const END_PATCH_MARKER = "*** End Patch";
const ADD_FILE_MARKER = "*** Add File: ";
const DELETE_FILE_MARKER = "*** Delete File: ";
const UPDATE_FILE_MARKER = "*** Update File: ";
const MOVE_TO_MARKER = "*** Move to: ";
const HUNK_MARKER = "@@";
const STANDARD_DIFF_MARKER = "diff --git ";
const STANDARD_OLD_FILE_MARKER = "--- ";
const STANDARD_NEW_FILE_MARKER = "+++ ";
const STANDARD_OLD_PATH_PREFIX = "a/";
const STANDARD_NEW_PATH_PREFIX = "b/";
const NO_NEWLINE_MARKER = "\\ No newline at end of file";
const UNSUPPORTED_STANDARD_DIFF_METADATA_PREFIXES = [
  "new file mode ",
  "deleted file mode ",
  "old mode ",
  "new mode ",
  "similarity index ",
  "dissimilarity index ",
  "rename from ",
  "rename to ",
  "copy from ",
  "copy to ",
  "Binary files ",
] as const;

interface StandardFileHeaders {
  readonly oldPath: string;
  readonly newPath: string;
  readonly next: number;
}

interface ParsedStandardFileDiff {
  readonly operation: ParsedPatchOperation;
  readonly next: number;
}

interface ParsedStandardHunk {
  readonly hunk: ParsedPatchHunk;
  readonly next: number;
}

type StandardHunkLineSide = "old" | "new" | "both";

interface StandardHunkSideBuilder {
  text: string;
}

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

function isStandardUnifiedDiff(lines: readonly string[]): boolean {
  return lines[0]?.startsWith(STANDARD_DIFF_MARKER) === true;
}

function unsupportedStandardDiff(message: string): never {
  throw patchError(
    "tool_invalid_patch",
    `apply_patch failed: unsupported standard unified diff: ${message}`,
    "Use a standard unified diff that updates an existing file without renames, file mode changes, binary patches, additions, or deletions.",
  );
}

function invalidStandardDiff(message: string): never {
  throw patchError(
    "tool_invalid_patch",
    `apply_patch failed: invalid standard unified diff: ${message}`,
    "Use diff --git a/<path> b/<path>, --- a/<path>, +++ b/<path>, and @@ hunks with lines prefixed by space, -, or +.",
  );
}

function metadataFreePath(text: string): string {
  const tabIndex = text.indexOf("\t");
  return tabIndex === -1 ? text : text.slice(0, tabIndex);
}

function standardDiffGitPathText(line: string): string {
  const paths = line.slice(STANDARD_DIFF_MARKER.length);
  if (!paths.startsWith(STANDARD_OLD_PATH_PREFIX)) {
    invalidStandardDiff("file header must be diff --git a/<path> b/<path>");
  }
  if (!paths.includes(` ${STANDARD_NEW_PATH_PREFIX}`)) {
    invalidStandardDiff("file header must be diff --git a/<path> b/<path>");
  }
  if (
    paths.startsWith(`${STANDARD_OLD_PATH_PREFIX} `) ||
    paths.endsWith(` ${STANDARD_NEW_PATH_PREFIX}`)
  ) {
    invalidStandardDiff("file header path is empty");
  }
  return paths;
}

function assertStandardDiffGitMatchesFileHeaders(
  line: string,
  headers: StandardFileHeaders,
): void {
  const paths = standardDiffGitPathText(line);
  const expected = `${STANDARD_OLD_PATH_PREFIX}${headers.oldPath} ${STANDARD_NEW_PATH_PREFIX}${headers.newPath}`;
  if (paths !== expected) {
    invalidStandardDiff("diff --git paths do not match ---/+++ file headers");
  }
}

function parseStandardFileHeaderPath(
  line: string,
  marker: string,
  pathPrefix: string,
): string {
  if (!line.startsWith(marker)) {
    invalidStandardDiff(`expected ${marker}<path> file header`);
  }
  const path = metadataFreePath(line.slice(marker.length));
  if (path === "/dev/null") {
    unsupportedStandardDiff("file additions and deletions are not supported");
  }
  if (!path.startsWith(pathPrefix)) {
    invalidStandardDiff(`expected ${marker}${pathPrefix}<path>`);
  }
  const workspacePath = path.slice(pathPrefix.length);
  if (workspacePath === "") {
    invalidStandardDiff("file header path is empty");
  }
  return workspacePath;
}

function isUnsupportedStandardDiffMetadata(line: string): boolean {
  return (
    UNSUPPORTED_STANDARD_DIFF_METADATA_PREFIXES.some((prefix) =>
      line.startsWith(prefix),
    ) || line === "GIT binary patch"
  );
}

function parseStandardFileHeaders(
  lines: readonly string[],
  start: number,
  diffPathHint: string,
): StandardFileHeaders {
  let index = start;
  while (index < lines.length) {
    const line = parserLine(lines, index);
    if (line.startsWith(STANDARD_OLD_FILE_MARKER)) break;
    if (line.startsWith(STANDARD_DIFF_MARKER)) {
      invalidStandardDiff(`missing ---/+++ file headers for ${diffPathHint}`);
    }
    if (isUnsupportedStandardDiffMetadata(line)) {
      unsupportedStandardDiff(line);
    }
    index++;
  }

  if (index >= lines.length) {
    invalidStandardDiff(`missing --- file header for ${diffPathHint}`);
  }
  const oldPath = parseStandardFileHeaderPath(
    parserLine(lines, index),
    STANDARD_OLD_FILE_MARKER,
    STANDARD_OLD_PATH_PREFIX,
  );
  index++;
  if (index >= lines.length) {
    invalidStandardDiff(`missing +++ file header for ${oldPath}`);
  }
  const newPath = parseStandardFileHeaderPath(
    parserLine(lines, index),
    STANDARD_NEW_FILE_MARKER,
    STANDARD_NEW_PATH_PREFIX,
  );
  return { oldPath, newPath, next: index + 1 };
}

function appendStandardHunkSideLine(
  side: StandardHunkSideBuilder,
  text: string,
): void {
  side.text += `${text}\n`;
}

function markStandardHunkSideNoNewline(side: StandardHunkSideBuilder): void {
  side.text = side.text.slice(0, -1);
}

function standardHunkSideLines(
  side: StandardHunkSideBuilder,
  sawNoNewlineMarker: boolean,
): readonly string[] {
  const text =
    !sawNoNewlineMarker && side.text.endsWith("\n")
      ? side.text.slice(0, -1)
      : side.text;
  return text.split("\n");
}

function parseStandardHunk(
  path: string,
  lines: readonly string[],
  start: number,
): ParsedStandardHunk {
  const header = parserLine(lines, start);
  if (!/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/u.test(header)) {
    invalidStandardDiff(`invalid hunk header for ${path}`);
  }

  const oldSide: StandardHunkSideBuilder = {
    text: "",
  };
  const newSide: StandardHunkSideBuilder = {
    text: "",
  };
  let lastLineSide: StandardHunkLineSide | null = null;
  let sawNoNewlineMarker = false;
  let index = start + 1;
  while (index < lines.length) {
    const line = parserLine(lines, index);
    if (line.startsWith(STANDARD_DIFF_MARKER) || line.startsWith(HUNK_MARKER)) {
      break;
    }
    if (line === NO_NEWLINE_MARKER) {
      if (lastLineSide === null) {
        invalidStandardDiff(`no-newline marker for ${path} has no file line`);
      }
      sawNoNewlineMarker = true;
      if (lastLineSide === "old" || lastLineSide === "both") {
        markStandardHunkSideNoNewline(oldSide);
      }
      if (lastLineSide === "new" || lastLineSide === "both") {
        markStandardHunkSideNoNewline(newSide);
      }
      lastLineSide = null;
      index++;
      continue;
    }
    if (line.startsWith(" ")) {
      appendStandardHunkSideLine(oldSide, line.slice(1));
      appendStandardHunkSideLine(newSide, line.slice(1));
      lastLineSide = "both";
    } else if (line.startsWith("-")) {
      appendStandardHunkSideLine(oldSide, line.slice(1));
      lastLineSide = "old";
    } else if (line.startsWith("+")) {
      appendStandardHunkSideLine(newSide, line.slice(1));
      lastLineSide = "new";
    } else {
      invalidStandardDiff(`hunk for ${path} has an invalid line`);
    }
    index++;
  }

  const oldLines = standardHunkSideLines(oldSide, sawNoNewlineMarker);
  const newLines = standardHunkSideLines(newSide, sawNoNewlineMarker);
  if (oldLines.length === 0 || oldLines.every((line) => line === "")) {
    invalidStandardDiff(`hunk for ${path} has no effective old lines`);
  }
  return { hunk: { oldLines, newLines }, next: index };
}

function parseStandardFileDiff(
  lines: readonly string[],
  start: number,
): ParsedStandardFileDiff {
  const diffHeader = parserLine(lines, start);
  standardDiffGitPathText(diffHeader);
  const headers = parseStandardFileHeaders(
    lines,
    start + 1,
    diffHeader.slice(STANDARD_DIFF_MARKER.length),
  );
  if (headers.oldPath !== headers.newPath) {
    unsupportedStandardDiff("renames and copies are not supported");
  }
  assertStandardDiffGitMatchesFileHeaders(diffHeader, headers);

  let index = headers.next;
  const hunks: ParsedPatchHunk[] = [];
  while (index < lines.length) {
    const line = parserLine(lines, index);
    if (line.startsWith(STANDARD_DIFF_MARKER)) break;
    if (!line.startsWith(HUNK_MARKER)) {
      invalidStandardDiff(`expected @@ hunk header for ${headers.oldPath}`);
    }
    const parsed = parseStandardHunk(headers.oldPath, lines, index);
    hunks.push(parsed.hunk);
    index = parsed.next;
  }
  if (hunks.length === 0) {
    invalidStandardDiff(`file ${headers.oldPath} has no hunks`);
  }
  return {
    operation: { kind: "update", path: headers.oldPath, movePath: null, hunks },
    next: index,
  };
}

function parseStandardUnifiedDiff(
  lines: readonly string[],
): readonly ParsedPatchOperation[] {
  const operations: ParsedPatchOperation[] = [];
  let index = 0;
  while (index < lines.length) {
    const parsed = parseStandardFileDiff(lines, index);
    operations.push(parsed.operation);
    index = parsed.next;
  }
  return operations;
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
  if (isStandardUnifiedDiff(lines)) {
    return parseStandardUnifiedDiff(lines);
  }
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
