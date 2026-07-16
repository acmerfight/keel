import { patchError } from "./errors.ts";
import type {
  GitRegularFileMode,
  ParsedPatchHunk,
  ParsedPatchModeChange,
  ParsedPatchOperation,
} from "./model.ts";

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
const STANDARD_NULL_FILE = "/dev/null";
const NO_NEWLINE_MARKER = "\\ No newline at end of file";
const UNSUPPORTED_STANDARD_DIFF_METADATA_PREFIXES = [
  "dissimilarity index ",
  "Binary files ",
] as const;

interface StandardFileHeaders {
  readonly oldPath: string | null;
  readonly newPath: string | null;
  readonly newFileMode: GitRegularFileMode | null;
  readonly deletedFileMode: GitRegularFileMode | null;
  readonly oldMode: GitRegularFileMode | null;
  readonly newMode: GitRegularFileMode | null;
  readonly sawSimilarityIndex: boolean;
  readonly renameFrom: string | null;
  readonly renameTo: string | null;
  readonly copyFrom: string | null;
  readonly copyTo: string | null;
  readonly next: number;
}

interface ParsedStandardFileDiff {
  readonly operation: ParsedPatchOperation;
  readonly next: number;
}

interface ParsedStandardHunk {
  readonly hunk: ParsedPatchHunk;
  readonly oldContent: string;
  readonly newContent: string;
  readonly newHasNoFinalNewline: boolean;
  readonly next: number;
}

interface ValidatedStandardCopyMetadata {
  readonly kind: "copy";
  readonly sourcePath: string;
  readonly targetPath: string;
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
  // parser callers check bounds before reading a line.
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
    "Use a standard unified diff that updates, adds, deletes, renames, or copies text files. Regular file modes 100644 and 100755 are supported; binary, symlink, submodule, tree, and special modes are not.",
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

function hasStandardRenameMetadata(headers: StandardFileHeaders): boolean {
  return (
    headers.renameFrom !== null ||
    headers.renameTo !== null ||
    (headers.sawSimilarityIndex && !hasStandardCopyMetadata(headers))
  );
}

function hasStandardCopyMetadata(headers: StandardFileHeaders): boolean {
  return headers.copyFrom !== null || headers.copyTo !== null;
}

function standardMetadataDiffPathMismatch(
  headers: StandardFileHeaders,
): string {
  if (hasStandardCopyMetadata(headers)) {
    return "copy metadata does not match diff --git paths";
  }
  if (hasStandardRenameMetadata(headers)) {
    return "rename metadata does not match diff --git paths";
  }
  return "diff --git paths do not match ---/+++ file headers";
}

function assertStandardDiffGitMatchesFileHeaders(
  line: string,
  headers: StandardFileHeaders,
): void {
  const paths = standardDiffGitPathText(line);
  const targetPath = standardFileHeaderTargetPath(headers);
  const oldDiffPath = headers.oldPath ?? targetPath;
  const newDiffPath = headers.newPath ?? targetPath;
  const expected = `${STANDARD_OLD_PATH_PREFIX}${oldDiffPath} ${STANDARD_NEW_PATH_PREFIX}${newDiffPath}`;
  if (paths !== expected) {
    invalidStandardDiff(standardMetadataDiffPathMismatch(headers));
  }
}

function standardDiffGitSameTargetPath(line: string): string {
  const paths = standardDiffGitPathText(line);
  const candidates: string[] = [];
  let searchStart = 0;
  while (searchStart < paths.length) {
    const separator = paths.indexOf(
      ` ${STANDARD_NEW_PATH_PREFIX}`,
      searchStart,
    );
    if (separator === -1) break;
    const oldPath = paths.slice(0, separator);
    const newPath = paths.slice(separator + 1);
    const oldWorkspacePath = oldPath.slice(STANDARD_OLD_PATH_PREFIX.length);
    const newWorkspacePath = newPath.slice(STANDARD_NEW_PATH_PREFIX.length);
    if (oldWorkspacePath === newWorkspacePath) {
      candidates.push(oldWorkspacePath);
    }
    searchStart = separator + 1;
  }
  if (candidates.length === 1) return candidates.join("");
  invalidStandardDiff("file lifecycle diff header must target one path");
}

function standardFileHeaderTargetPath(headers: StandardFileHeaders): string {
  const targetPath = headers.newPath ?? headers.oldPath;
  if (targetPath === null) {
    invalidStandardDiff("file headers cannot both use /dev/null");
  }
  return targetPath;
}

function parseStandardFileHeaderPath(
  line: string,
  marker: string,
  pathPrefix: string,
): string | null {
  if (!line.startsWith(marker)) {
    invalidStandardDiff(`expected ${marker}<path> file header`);
  }
  const path = metadataFreePath(line.slice(marker.length));
  if (path === STANDARD_NULL_FILE) {
    return null;
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

function parseStandardGitRegularFileMode(
  line: string,
  prefix: string,
): GitRegularFileMode {
  const mode = line.slice(prefix.length);
  if (mode === "100644") return 0o644;
  if (mode === "100755") return 0o755;
  unsupportedStandardDiff(line);
}

function formatStandardGitRegularFileMode(mode: GitRegularFileMode): string {
  return mode === 0o755 ? "100755" : "100644";
}

function hasStandardFileLifecycleMetadata(
  headers: StandardFileHeaders,
): boolean {
  return headers.newFileMode !== null || headers.deletedFileMode !== null;
}

function hasStandardModeChangeMetadata(headers: StandardFileHeaders): boolean {
  return headers.oldMode !== null || headers.newMode !== null;
}

function standardModeChangeFromHeaders(
  headers: StandardFileHeaders,
): ParsedPatchModeChange | null {
  if (headers.oldMode === null && headers.newMode === null) return null;
  if (headers.oldMode === null) {
    invalidStandardDiff("mode change is missing old mode metadata");
  }
  if (headers.newMode === null) {
    invalidStandardDiff("mode change is missing new mode metadata");
  }
  if (headers.oldMode === headers.newMode) {
    invalidStandardDiff(
      `mode change does not change mode ${formatStandardGitRegularFileMode(headers.oldMode)}`,
    );
  }
  return { oldMode: headers.oldMode, newMode: headers.newMode };
}

function isStandardSimilarityIndexMetadata(line: string): boolean {
  if (!line.startsWith("similarity index ")) return false;
  if (!/^similarity index (?:100|[1-9]?\d)%$/u.test(line)) {
    invalidStandardDiff(line);
  }
  return true;
}

function parseStandardPathMetadata(
  line: string,
  prefix: string,
  metadataName: "copy" | "rename",
): string {
  const path = metadataFreePath(line.slice(prefix.length));
  if (path === "") {
    invalidStandardDiff(`${metadataName} metadata path is empty`);
  }
  return path;
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
  diffHeader: string,
): StandardFileHeaders {
  let index = start;
  let newFileMode: GitRegularFileMode | null = null;
  let deletedFileMode: GitRegularFileMode | null = null;
  let oldMode: GitRegularFileMode | null = null;
  let newMode: GitRegularFileMode | null = null;
  let sawSimilarityIndex = false;
  let renameFrom: string | null = null;
  let renameTo: string | null = null;
  let copyFrom: string | null = null;
  let copyTo: string | null = null;
  while (index < lines.length) {
    const line = parserLine(lines, index);
    if (line.startsWith(STANDARD_OLD_FILE_MARKER)) break;
    if (line.startsWith(HUNK_MARKER)) {
      invalidStandardDiff(
        `missing --- file header for ${diffHeader.slice(STANDARD_DIFF_MARKER.length)}`,
      );
    }
    if (line.startsWith(STANDARD_DIFF_MARKER)) {
      return parseStandardLifecycleHeadersWithoutFileHeaders(
        diffHeader,
        index,
        newFileMode,
        deletedFileMode,
        oldMode,
        newMode,
        sawSimilarityIndex,
        renameFrom,
        renameTo,
        copyFrom,
        copyTo,
      );
    }
    if (isStandardSimilarityIndexMetadata(line)) {
      sawSimilarityIndex = true;
      index++;
      continue;
    }
    if (line.startsWith("rename from ")) {
      renameFrom = parseStandardPathMetadata(line, "rename from ", "rename");
      index++;
      continue;
    }
    if (line.startsWith("rename to ")) {
      renameTo = parseStandardPathMetadata(line, "rename to ", "rename");
      index++;
      continue;
    }
    if (line.startsWith("copy from ")) {
      copyFrom = parseStandardPathMetadata(line, "copy from ", "copy");
      index++;
      continue;
    }
    if (line.startsWith("copy to ")) {
      copyTo = parseStandardPathMetadata(line, "copy to ", "copy");
      index++;
      continue;
    }
    if (line.startsWith("new file mode ")) {
      if (newFileMode !== null) {
        invalidStandardDiff("duplicate new file mode metadata");
      }
      newFileMode = parseStandardGitRegularFileMode(line, "new file mode ");
      index++;
      continue;
    }
    if (line.startsWith("deleted file mode ")) {
      if (deletedFileMode !== null) {
        invalidStandardDiff("duplicate deleted file mode metadata");
      }
      deletedFileMode = parseStandardGitRegularFileMode(
        line,
        "deleted file mode ",
      );
      index++;
      continue;
    }
    if (line.startsWith("old mode ")) {
      if (oldMode !== null) {
        invalidStandardDiff("duplicate old mode metadata");
      }
      oldMode = parseStandardGitRegularFileMode(line, "old mode ");
      index++;
      continue;
    }
    if (line.startsWith("new mode ")) {
      if (newMode !== null) {
        invalidStandardDiff("duplicate new mode metadata");
      }
      newMode = parseStandardGitRegularFileMode(line, "new mode ");
      index++;
      continue;
    }
    if (isUnsupportedStandardDiffMetadata(line)) {
      unsupportedStandardDiff(line);
    }
    index++;
  }

  if (index >= lines.length) {
    return parseStandardLifecycleHeadersWithoutFileHeaders(
      diffHeader,
      index,
      newFileMode,
      deletedFileMode,
      oldMode,
      newMode,
      sawSimilarityIndex,
      renameFrom,
      renameTo,
      copyFrom,
      copyTo,
    );
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
  return {
    oldPath,
    newPath,
    newFileMode,
    deletedFileMode,
    oldMode,
    newMode,
    sawSimilarityIndex,
    renameFrom,
    renameTo,
    copyFrom,
    copyTo,
    next: index + 1,
  };
}

function parseStandardLifecycleHeadersWithoutFileHeaders(
  diffHeader: string,
  next: number,
  newFileMode: GitRegularFileMode | null,
  deletedFileMode: GitRegularFileMode | null,
  oldMode: GitRegularFileMode | null,
  newMode: GitRegularFileMode | null,
  sawSimilarityIndex: boolean,
  renameFrom: string | null,
  renameTo: string | null,
  copyFrom: string | null,
  copyTo: string | null,
): StandardFileHeaders {
  const sawNewFileMode = newFileMode !== null;
  const sawDeletedFileMode = deletedFileMode !== null;
  if (copyFrom !== null || copyTo !== null) {
    if (copyFrom === null || copyTo === null) {
      invalidStandardDiff("copy diff is missing copy from/to metadata");
    }
    if (renameFrom !== null || renameTo !== null) {
      invalidStandardDiff(
        "copy metadata cannot be combined with rename metadata",
      );
    }
    if (sawNewFileMode || sawDeletedFileMode) {
      invalidStandardDiff(
        "copy metadata cannot be combined with file lifecycle metadata",
      );
    }
    return {
      oldPath: copyFrom,
      newPath: copyTo,
      newFileMode,
      deletedFileMode,
      oldMode,
      newMode,
      sawSimilarityIndex,
      renameFrom,
      renameTo,
      copyFrom,
      copyTo,
      next,
    };
  }
  if (sawSimilarityIndex || renameFrom !== null || renameTo !== null) {
    if (renameFrom === null || renameTo === null) {
      invalidStandardDiff("rename diff is missing rename from/to metadata");
    }
    if (sawNewFileMode || sawDeletedFileMode) {
      invalidStandardDiff(
        "rename metadata cannot be combined with file lifecycle metadata",
      );
    }
    return {
      oldPath: renameFrom,
      newPath: renameTo,
      newFileMode,
      deletedFileMode,
      oldMode,
      newMode,
      sawSimilarityIndex,
      renameFrom,
      renameTo,
      copyFrom,
      copyTo,
      next,
    };
  }
  if (oldMode !== null || newMode !== null) {
    if (sawNewFileMode || sawDeletedFileMode) {
      invalidStandardDiff(
        "file lifecycle metadata cannot be combined with mode change metadata",
      );
    }
    const path = standardDiffGitSameTargetPath(diffHeader);
    return {
      oldPath: path,
      newPath: path,
      newFileMode,
      deletedFileMode,
      oldMode,
      newMode,
      sawSimilarityIndex,
      renameFrom,
      renameTo,
      copyFrom,
      copyTo,
      next,
    };
  }
  if (sawNewFileMode === sawDeletedFileMode) {
    invalidStandardDiff(
      `missing --- file header for ${diffHeader.slice(STANDARD_DIFF_MARKER.length)}`,
    );
  }
  const path = standardDiffGitSameTargetPath(diffHeader);
  return {
    oldPath: sawNewFileMode ? null : path,
    newPath: sawNewFileMode ? path : null,
    newFileMode,
    deletedFileMode,
    oldMode,
    newMode,
    sawSimilarityIndex,
    renameFrom,
    renameTo,
    copyFrom,
    copyTo,
    next,
  };
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
  let newHasNoFinalNewline = false;
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
        newHasNoFinalNewline = true;
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
  return {
    hunk: { oldLines, newLines },
    oldContent: oldSide.text,
    newContent: newSide.text,
    newHasNoFinalNewline,
    next: index,
  };
}

function hasEffectiveStandardLines(lines: readonly string[]): boolean {
  return lines.some((line) => line !== "");
}

function validateStandardFileMetadata(
  headers: StandardFileHeaders,
): ValidatedStandardCopyMetadata | null {
  if (hasStandardCopyMetadata(headers)) {
    if (headers.copyFrom === null || headers.copyTo === null) {
      invalidStandardDiff("copy diff is missing copy from/to metadata");
    }
    if (headers.renameFrom !== null || headers.renameTo !== null) {
      invalidStandardDiff(
        "copy metadata cannot be combined with rename metadata",
      );
    }
    if (headers.oldPath === null || headers.newPath === null) {
      invalidStandardDiff("copy metadata cannot use /dev/null file headers");
    }
    if (headers.oldPath === headers.newPath) {
      invalidStandardDiff("copy metadata does not copy a file");
    }
    if (hasStandardFileLifecycleMetadata(headers)) {
      invalidStandardDiff(
        "copy metadata cannot be combined with file lifecycle metadata",
      );
    }
    if (
      headers.copyFrom !== headers.oldPath ||
      headers.copyTo !== headers.newPath
    ) {
      invalidStandardDiff("copy metadata does not match file headers");
    }
    standardModeChangeFromHeaders(headers);
    return {
      kind: "copy",
      sourcePath: headers.oldPath,
      targetPath: headers.newPath,
    };
  }
  if (hasStandardRenameMetadata(headers)) {
    if (headers.renameFrom === null || headers.renameTo === null) {
      invalidStandardDiff("rename diff is missing rename from/to metadata");
    }
    if (headers.oldPath === null || headers.newPath === null) {
      invalidStandardDiff("rename metadata cannot use /dev/null file headers");
    }
    if (headers.oldPath === headers.newPath) {
      invalidStandardDiff("rename metadata does not rename a file");
    }
    if (hasStandardFileLifecycleMetadata(headers)) {
      invalidStandardDiff(
        "rename metadata cannot be combined with file lifecycle metadata",
      );
    }
    if (
      headers.renameFrom !== headers.oldPath ||
      headers.renameTo !== headers.newPath
    ) {
      invalidStandardDiff("rename metadata does not match file headers");
    }
  }
  if (headers.oldPath === null) {
    if (headers.deletedFileMode !== null) {
      invalidStandardDiff(
        "new file diff cannot use deleted file mode metadata",
      );
    }
    if (hasStandardModeChangeMetadata(headers)) {
      invalidStandardDiff("new file diff cannot use mode change metadata");
    }
    return null;
  }
  if (headers.newPath === null) {
    if (headers.newFileMode !== null) {
      invalidStandardDiff(
        "deleted file diff cannot use new file mode metadata",
      );
    }
    if (hasStandardModeChangeMetadata(headers)) {
      invalidStandardDiff("deleted file diff cannot use mode change metadata");
    }
    return null;
  }
  if (hasStandardFileLifecycleMetadata(headers)) {
    invalidStandardDiff("file lifecycle metadata does not match file headers");
  }
  standardModeChangeFromHeaders(headers);
  return null;
}

function addFileLinesFromStandardContent(content: string): readonly string[] {
  if (content === "") return [];
  return content.split("\n");
}

function standardUpdateHunksFromParsed(
  path: string,
  parsedHunks: readonly ParsedStandardHunk[],
): readonly ParsedPatchHunk[] {
  return parsedHunks.map((parsed) => {
    if (!hasEffectiveStandardLines(parsed.hunk.oldLines)) {
      invalidStandardDiff(`hunk for ${path} has no effective old lines`);
    }
    return parsed.hunk;
  });
}

function standardPatchOperationFromHunks(
  headers: StandardFileHeaders,
  parsedHunks: readonly ParsedStandardHunk[],
): ParsedPatchOperation {
  const metadata = validateStandardFileMetadata(headers);
  const modeChange = standardModeChangeFromHeaders(headers);
  if (headers.oldPath === null) {
    const path = standardFileHeaderTargetPath(headers);
    let content = "";
    for (const parsed of parsedHunks) {
      if (parsed.oldContent !== "") {
        invalidStandardDiff(`new file ${path} hunk contains old lines`);
      }
      if (parsed.newHasNoFinalNewline) {
        unsupportedStandardDiff(
          `new file ${path} without a trailing newline is not supported`,
        );
      }
      content += parsed.newContent;
    }
    return {
      kind: "add",
      path,
      lines: addFileLinesFromStandardContent(content),
      mode: headers.newFileMode,
    };
  }
  if (headers.newPath === null) {
    const path = standardFileHeaderTargetPath(headers);
    let expectedContent = "";
    for (const parsed of parsedHunks) {
      if (parsed.newContent !== "") {
        invalidStandardDiff(`deleted file ${path} hunk contains new lines`);
      }
      expectedContent += parsed.oldContent;
    }
    return {
      kind: "delete",
      path,
      expectedContent,
      mode: headers.deletedFileMode,
    };
  }
  if (metadata?.kind === "copy") {
    return {
      kind: "copy",
      sourcePath: metadata.sourcePath,
      path: metadata.targetPath,
      hunks: standardUpdateHunksFromParsed(metadata.sourcePath, parsedHunks),
      modeChange,
    };
  }
  if (headers.oldPath !== headers.newPath) {
    if (!hasStandardRenameMetadata(headers)) {
      invalidStandardDiff("rename diff is missing rename from/to metadata");
    }
    return {
      kind: "update",
      path: headers.oldPath,
      movePath: headers.newPath,
      hunks: standardUpdateHunksFromParsed(headers.oldPath, parsedHunks),
      modeChange,
    };
  }
  return {
    kind: "update",
    path: headers.oldPath,
    movePath: null,
    hunks: standardUpdateHunksFromParsed(headers.oldPath, parsedHunks),
    modeChange,
  };
}

function parseStandardFileDiff(
  lines: readonly string[],
  start: number,
): ParsedStandardFileDiff {
  const diffHeader = parserLine(lines, start);
  standardDiffGitPathText(diffHeader);
  const headers = parseStandardFileHeaders(lines, start + 1, diffHeader);
  assertStandardDiffGitMatchesFileHeaders(diffHeader, headers);

  let index = headers.next;
  const parsedHunks: ParsedStandardHunk[] = [];
  const targetPath = standardFileHeaderTargetPath(headers);
  while (index < lines.length) {
    const line = parserLine(lines, index);
    if (line.startsWith(STANDARD_DIFF_MARKER)) break;
    if (!line.startsWith(HUNK_MARKER)) {
      invalidStandardDiff(`expected @@ hunk header for ${targetPath}`);
    }
    const parsed = parseStandardHunk(targetPath, lines, index);
    parsedHunks.push(parsed);
    index = parsed.next;
  }
  if (
    parsedHunks.length === 0 &&
    headers.oldPath !== null &&
    headers.newPath !== null &&
    !hasStandardRenameMetadata(headers) &&
    !hasStandardCopyMetadata(headers) &&
    !hasStandardModeChangeMetadata(headers)
  ) {
    invalidStandardDiff(`file ${targetPath} has no hunks`);
  }
  return {
    operation: standardPatchOperationFromHunks(headers, parsedHunks),
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
  return {
    operation: { kind: "add", path, lines: contentLines, mode: null },
    next: index,
  };
}

function parseDeleteOperation(
  lines: readonly string[],
  start: number,
): { readonly operation: ParsedPatchOperation; readonly next: number } {
  const path = requiredPathFromHeader(
    parserLine(lines, start),
    DELETE_FILE_MARKER,
  );
  return {
    operation: { kind: "delete", path, expectedContent: null, mode: null },
    next: start + 1,
  };
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
  return {
    operation: { kind: "update", path, movePath, hunks, modeChange: null },
    next: index,
  };
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
