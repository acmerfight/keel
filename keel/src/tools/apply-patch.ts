import {
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, resolve } from "node:path";
import { KeelError } from "../core/error.ts";
import {
  type RecordLastBatchCheckpointOperation,
  recordLastBatchCheckpoint,
} from "../core/git.ts";
import {
  createTextFileAtomically,
  writeTextFileAtomically,
} from "./atomic-write.ts";
import { type EditMatchSpan, locateUniqueEditSpan } from "./edit-match.ts";
import { createProjectIgnorePolicy } from "./project-ignore.ts";
import { readEditableTextFileWithMetadata } from "./text-file.ts";
import type { ToolResult } from "./types.ts";
import {
  isInsideWorkspace,
  resolveWorkspaceCreateTarget,
  resolveWorkspaceTarget,
} from "./workspace-path.ts";

interface ExecuteApplyPatchOptions {
  readonly readBeforeEdit?: {
    readonly hasRead: (targetPath: string) => boolean;
  };
}

interface ApplyPatchToolResult extends ToolResult {
  readonly targetPaths: readonly string[];
  readonly checkpointOperations: readonly RecordLastBatchCheckpointOperation[];
}

type ParsedPatchOperation =
  | {
      readonly kind: "add";
      readonly path: string;
      readonly lines: readonly string[];
    }
  | {
      readonly kind: "update";
      readonly path: string;
      readonly hunks: readonly ParsedPatchHunk[];
    };

interface ParsedPatchHunk {
  readonly oldLines: readonly string[];
  readonly newLines: readonly string[];
}

type PreparedPatchOperation =
  | {
      readonly kind: "add";
      readonly path: string;
      readonly workspacePath: string;
      readonly targetPath: string;
      readonly parentPath: string;
      readonly afterContent: string;
    }
  | {
      readonly kind: "update";
      readonly path: string;
      readonly targetPath: string;
      readonly beforeContent: string;
      readonly afterContent: string;
      readonly mode: number;
    };

type NormalizedText =
  | {
      readonly kind: "identity";
      readonly text: string;
    }
  | {
      readonly kind: "mapped";
      readonly text: string;
      readonly sourceIndexByNormalizedIndex: readonly number[];
    };

const MAX_PATCH_EDIT_FILE_BYTES = 10 * 1024 * 1024;

const BEGIN_PATCH_MARKER = "*** Begin Patch";
const END_PATCH_MARKER = "*** End Patch";
const ADD_FILE_MARKER = "*** Add File: ";
const DELETE_FILE_MARKER = "*** Delete File: ";
const UPDATE_FILE_MARKER = "*** Update File: ";
const MOVE_TO_MARKER = "*** Move to: ";
const HUNK_MARKER = "@@";

function patchError(
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

function fileTooLargeError(filePath: string, bytes: number): KeelError {
  return new KeelError(
    "tool_file_too_large",
    `apply_patch failed: file is too large: ${filePath} (${formatByteCount(bytes)}; limit ${formatByteCount(MAX_PATCH_EDIT_FILE_BYTES)})`,
    "Use read or grep to inspect a smaller target, then split the patch into smaller source files.",
  );
}

function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/gu, "\n");
}

function lineEndingAdjusted(text: string, lineEnding: "\r\n" | "\n"): string {
  return normalizeLineEndings(text).replaceAll("\n", lineEnding);
}

function lineEndingAtNewline(
  content: string,
  newlineIndex: number,
): "\r\n" | "\n" {
  return content[newlineIndex - 1] === "\r" ? "\r\n" : "\n";
}

function sourceLineEnding(content: string, span: EditMatchSpan): "\r\n" | "\n" {
  const spanEnd = span.index + span.length;
  for (let index = span.index; index < spanEnd; index++) {
    if (content[index] === "\n") return lineEndingAtNewline(content, index);
  }
  for (let index = spanEnd; index < content.length; index++) {
    if (content[index] === "\n") return lineEndingAtNewline(content, index);
  }
  for (let index = span.index - 1; index >= 0; index--) {
    if (content[index] === "\n") return lineEndingAtNewline(content, index);
  }
  return "\n";
}

function sourceSpanReplacement(
  text: string,
  lineEnding: "\r\n" | "\n",
): string {
  if (!text.includes("\r") && !text.includes("\n")) return text;
  return lineEndingAdjusted(text, lineEnding);
}

function normalizeWithSourceMap(content: string): NormalizedText {
  if (!content.includes("\r\n")) {
    return { kind: "identity", text: content };
  }

  const normalized: string[] = [];
  const sourceIndexByNormalizedIndex: number[] = [];
  let index = 0;
  while (index < content.length) {
    if (content[index] === "\r" && content[index + 1] === "\n") {
      normalized.push("\n");
      sourceIndexByNormalizedIndex.push(index);
      index += 2;
      continue;
    }
    normalized.push(content.charAt(index));
    sourceIndexByNormalizedIndex.push(index);
    index++;
  }
  return {
    kind: "mapped",
    text: normalized.join(""),
    sourceIndexByNormalizedIndex,
  };
}

function originalSpan(
  normalized: NormalizedText,
  match: EditMatchSpan,
  originalLength: number,
): EditMatchSpan {
  if (normalized.kind === "identity") {
    return { index: match.index, length: match.length };
  }

  const index = normalized.sourceIndexByNormalizedIndex[match.index];
  const normalizedEnd = match.index + match.length;
  const end =
    normalizedEnd >= normalized.sourceIndexByNormalizedIndex.length
      ? originalLength
      : normalized.sourceIndexByNormalizedIndex[normalizedEnd];
  /* v8 ignore next 3: locateUniqueEditSpan only returns spans from normalized text. */
  if (index === undefined || end === undefined) {
    throw new Error("apply_patch source map invariant violated");
  }
  return { index, length: end - index };
}

function withUtf8Bom(content: string, hasUtf8Bom: boolean): string {
  return hasUtf8Bom ? `\uFEFF${content}` : content;
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

function unsupportedOperation(message: string): KeelError {
  return patchError(
    "tool_unsupported_patch_operation",
    message,
    "This apply_patch slice supports only Add File and Update File. Use edit/write for deletes or renames.",
  );
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

  if (oldLines.length === 0) {
    throw patchError(
      "tool_invalid_patch",
      `apply_patch failed: update hunk for ${path} has no old lines`,
      "Include context or removed lines so the patch can locate the target text.",
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
  if (
    index < lines.length &&
    parserLine(lines, index).startsWith(MOVE_TO_MARKER)
  ) {
    throw unsupportedOperation(
      `apply_patch failed: Move to is not supported for ${path}`,
    );
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
  if (hunks.length === 0) {
    throw patchError(
      "tool_invalid_patch",
      `apply_patch failed: update file ${path} has no hunks`,
      "Add at least one @@ hunk to update this file.",
    );
  }
  return { operation: { kind: "update", path, hunks }, next: index };
}

function parsePatch(patch: string): readonly ParsedPatchOperation[] {
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
      throw unsupportedOperation(
        "apply_patch failed: Delete File is not supported",
      );
    } else {
      throw patchError(
        "tool_invalid_patch",
        `apply_patch failed: invalid patch header: ${line}`,
        "Use *** Add File: <path> or *** Update File: <path> inside the patch.",
      );
    }
  }

  if (operations.length === 0) {
    throw patchError(
      "tool_invalid_patch",
      "apply_patch failed: patch contains no file operations",
      "Add at least one Add File or Update File operation.",
    );
  }
  return operations;
}

function addFileContent(lines: readonly string[]): string {
  const content = lines.join("\n");
  if (content === "" || content.endsWith("\n")) return content;
  return `${content}\n`;
}

function applyUpdateHunks(
  filePath: string,
  content: string,
  hunks: readonly ParsedPatchHunk[],
): string {
  let updated = content;
  for (const hunk of hunks) {
    const oldText = normalizeLineEndings(hunk.oldLines.join("\n"));
    const newText = hunk.newLines.join("\n");
    const normalized = normalizeWithSourceMap(updated);
    const matchResult = locateUniqueEditSpan(normalized.text, oldText);
    if (matchResult.status === "not_found") {
      throw patchError(
        "tool_patch_hunk_not_found",
        `apply_patch failed: expected lines not found in ${filePath}`,
        `Use read(path: "${filePath}") to view the current content, then regenerate the hunk with exact context.`,
      );
    }
    if (matchResult.status === "not_unique") {
      throw patchError(
        "tool_patch_hunk_not_found",
        `apply_patch failed: expected lines are not unique in ${filePath}`,
        "Add more context lines to the patch hunk so it identifies one location.",
      );
    }
    const match = originalSpan(normalized, matchResult.match, updated.length);
    updated =
      updated.slice(0, match.index) +
      sourceSpanReplacement(newText, sourceLineEnding(updated, match)) +
      updated.slice(match.index + match.length);
  }
  return updated;
}

function validateUpdateTarget(
  workspacePath: string,
  requestedPath: string,
  targetPath: string,
  displayPath: string,
): number {
  const targetStat = statSync(targetPath);
  const targetIsDirectory = targetStat.isDirectory();
  const projectIgnorePolicy = createProjectIgnorePolicy(workspacePath);
  if (
    projectIgnorePolicy.isIgnored(requestedPath, targetIsDirectory) ||
    projectIgnorePolicy.isIgnored(targetPath, targetIsDirectory)
  ) {
    throw new KeelError(
      "tool_path_ignored",
      `apply_patch failed: ignored path: ${displayPath}`,
      "This file is excluded by project .gitignore. Choose a different file that is not ignored.",
    );
  }
  if (!targetStat.isFile()) {
    throw new KeelError(
      "tool_not_file",
      `apply_patch failed: not a file: ${displayPath}`,
      "The path is a directory, not a file. Specify a file path inside it.",
    );
  }
  return targetStat.mode & 0o7777;
}

function prepareUpdateOperation(
  workspace: string,
  operation: Extract<ParsedPatchOperation, { readonly kind: "update" }>,
  options: ExecuteApplyPatchOptions,
): PreparedPatchOperation {
  const { workspacePath, requestedPath, targetPath } = resolveWorkspaceTarget(
    workspace,
    operation.path,
    "edit",
  );
  const mode = validateUpdateTarget(
    workspacePath,
    requestedPath,
    targetPath,
    operation.path,
  );
  if (
    options.readBeforeEdit !== undefined &&
    !options.readBeforeEdit.hasRead(targetPath)
  ) {
    throw new KeelError(
      "tool_file_not_read",
      `apply_patch failed: file has not been read: ${operation.path}`,
      `Use read(path: "${operation.path}") to view the current file content, then retry apply_patch with hunks copied from the read output.`,
    );
  }

  const file = readEditableTextFileWithMetadata(targetPath, operation.path, {
    command: "apply_patch",
    maxBytes: MAX_PATCH_EDIT_FILE_BYTES,
    tooLargeError: (observedBytes) =>
      fileTooLargeError(operation.path, observedBytes),
  });
  const updated = applyUpdateHunks(
    operation.path,
    file.content,
    operation.hunks,
  );
  return {
    kind: "update",
    path: operation.path,
    targetPath,
    beforeContent: withUtf8Bom(file.content, file.hasUtf8Bom),
    afterContent: withUtf8Bom(updated, file.hasUtf8Bom),
    mode,
  };
}

function prepareAddOperation(
  workspace: string,
  operation: Extract<ParsedPatchOperation, { readonly kind: "add" }>,
): PreparedPatchOperation {
  const { workspacePath, targetPath, parentPath } =
    resolveWorkspaceCreateTarget(workspace, operation.path, "write");
  return {
    kind: "add",
    path: operation.path,
    workspacePath,
    targetPath,
    parentPath,
    afterContent: addFileContent(operation.lines),
  };
}

function preparePatchOperations(
  workspace: string,
  operations: readonly ParsedPatchOperation[],
  options: ExecuteApplyPatchOptions,
): readonly PreparedPatchOperation[] {
  const prepared: PreparedPatchOperation[] = [];
  const targetPaths = new Set<string>();
  for (const operation of operations) {
    const next =
      operation.kind === "add"
        ? prepareAddOperation(workspace, operation)
        : prepareUpdateOperation(workspace, operation, options);
    if (targetPaths.has(next.targetPath)) {
      throw patchError(
        "tool_invalid_patch",
        `apply_patch failed: multiple operations target ${operation.path}`,
        "Combine changes for the same file into one patch operation.",
      );
    }
    targetPaths.add(next.targetPath);
    prepared.push(next);
  }
  return prepared;
}

function readFileIfPossible(filePath: string): string | null {
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    /* v8 ignore next 1: rollback tolerates concurrent file removal. */
    return null;
  }
}

function rollbackAppliedOperations(
  applied: readonly PreparedPatchOperation[],
): void {
  for (const operation of applied.toReversed()) {
    if (operation.kind === "add") {
      /* v8 ignore next 1: rollback skips files changed concurrently after the failed operation. */
      if (readFileIfPossible(operation.targetPath) === operation.afterContent) {
        rmSync(operation.targetPath, { force: true });
      }
      continue;
    }

    const currentContent = readFileIfPossible(operation.targetPath);
    /* v8 ignore next 1: rollback skips files changed concurrently after the failed operation. */
    if (currentContent !== operation.afterContent) {
      continue;
    }
    writeTextFileAtomically(operation.targetPath, operation.beforeContent, {
      mode: operation.mode,
    });
  }
}

/* v8 ignore next 3: only used for create races after prevalidation. */
function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function validateAddTargetAfterMkdir(
  operation: Extract<PreparedPatchOperation, { readonly kind: "add" }>,
): void {
  const parentRealPath = realpathSync(operation.parentPath);
  /* v8 ignore next 6: resolveWorkspaceCreateTarget rejects outside real parents; this guards post-validation symlink races. */
  if (!isInsideWorkspace(operation.workspacePath, parentRealPath)) {
    throw new KeelError(
      "tool_path_outside_workspace",
      `apply_patch failed: path is outside the workspace: ${operation.path}`,
      "Use a workspace-relative path under the current workspace.",
    );
  }

  const realTargetPath = resolve(
    parentRealPath,
    basename(operation.targetPath),
  );
  const projectIgnorePolicy = createProjectIgnorePolicy(
    operation.workspacePath,
  );
  if (projectIgnorePolicy.isIgnored(realTargetPath, false)) {
    throw new KeelError(
      "tool_path_ignored",
      `apply_patch failed: ignored path: ${operation.path}`,
      "This file is excluded by project .gitignore. Choose a different file that is not ignored.",
    );
  }
}

function applyPreparedOperation(operation: PreparedPatchOperation): void {
  if (operation.kind === "add") {
    mkdirSync(operation.parentPath, { recursive: true });
    validateAddTargetAfterMkdir(operation);
    try {
      createTextFileAtomically(operation.targetPath, operation.afterContent);
    } catch (error) {
      /* v8 ignore next 7: EEXIST requires a concurrent create after prevalidation. */
      if (isErrnoException(error) && error.code === "EEXIST") {
        throw new KeelError(
          "tool_file_exists",
          `apply_patch failed: file already exists: ${operation.path}`,
          "Read the existing file and use an Update File hunk instead of Add File.",
        );
      }
      /* v8 ignore next 1: unknown atomic create errors are rethrown unchanged. */
      throw error;
    }
  } else {
    writeTextFileAtomically(operation.targetPath, operation.afterContent, {
      mode: operation.mode,
    });
  }
}

function checkpointOperationFor(
  operation: PreparedPatchOperation,
): RecordLastBatchCheckpointOperation {
  if (operation.kind === "add") {
    return {
      operation: "create",
      filePath: realpathSync(operation.targetPath),
      afterContent: operation.afterContent,
    };
  }
  return {
    operation: "edit",
    filePath: operation.targetPath,
    beforeContent: operation.beforeContent,
    afterContent: operation.afterContent,
  };
}

function summaryLine(operation: PreparedPatchOperation): string {
  return `${operation.kind === "add" ? "A" : "M"} ${operation.path}`;
}

export function executeApplyPatch(
  workspace: string,
  patch: string,
  options: ExecuteApplyPatchOptions = {},
): ApplyPatchToolResult {
  const operations = parsePatch(patch);
  const prepared = preparePatchOperations(workspace, operations, options);
  const applied: PreparedPatchOperation[] = [];
  try {
    for (const operation of prepared) {
      applyPreparedOperation(operation);
      applied.push(operation);
    }
  } catch (error) {
    rollbackAppliedOperations(applied);
    throw error;
  }

  const checkpointOperations = prepared.map(checkpointOperationFor);
  recordLastBatchCheckpoint({
    workspace,
    operations: checkpointOperations,
  });

  return {
    content: ["Applied patch:", ...prepared.map(summaryLine)].join("\n"),
    targetPaths: prepared.map((operation) => operation.targetPath),
    checkpointOperations,
  };
}
