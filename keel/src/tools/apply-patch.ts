import { fstatSync, readFileSync, rmSync, statSync } from "node:fs";
import { KeelError } from "../core/error.ts";
import {
  type RecordLastBatchCheckpointOperation,
  recordLastBatchCheckpoint,
} from "../core/git.ts";
import {
  type AtomicWriteResult,
  createTextFileAtomically,
  restoreTextFileByIdentityBestEffort,
  writeTextFileAtomically,
} from "./atomic-write.ts";
import { type EditMatchSpan, locateUniqueEditSpan } from "./edit-match.ts";
import { createProjectIgnorePolicy } from "./project-ignore.ts";
import { readEditableTextFileWithMetadata } from "./text-file.ts";
import type { ToolResult } from "./types.ts";
import {
  assertWorkspaceFileIdentityAtAccess,
  assertWorkspaceOpenTargetAtAccess,
  assertWorkspaceTargetAtAccess,
  createWorkspaceParentDirectories,
  type FileIdentity,
  findWorkspacePathsByIdentity,
  resolveWorkspaceCreateTarget,
  resolveWorkspaceCreateTargetAtAccess,
  resolveWorkspaceTarget,
  sameFileIdentity,
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

interface ValidatedUpdateTarget {
  readonly targetPath: string;
  readonly mode: number;
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
      readonly workspacePath: string;
      readonly targetPath: string;
      readonly beforeContent: string;
      readonly afterContent: string;
      readonly mode: number;
    };

type AppliedPatchOperation = PreparedPatchOperation & {
  readonly appliedIdentity: FileIdentity;
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
): ValidatedUpdateTarget {
  const accessTargetPath = assertWorkspaceTargetAtAccess({
    workspacePath,
    targetPath,
    toolName: "apply_patch",
    requestedPath: displayPath,
  });
  const targetStat = statSync(accessTargetPath);
  const targetIsDirectory = targetStat.isDirectory();
  const projectIgnorePolicy = createProjectIgnorePolicy(workspacePath);
  if (
    projectIgnorePolicy.isIgnored(requestedPath, targetIsDirectory) ||
    projectIgnorePolicy.isIgnored(accessTargetPath, targetIsDirectory)
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
  return {
    targetPath: accessTargetPath,
    mode: targetStat.mode & 0o7777,
  };
}

function prepareUpdateOperation(
  workspace: string,
  operation: Extract<ParsedPatchOperation, { readonly kind: "update" }>,
  options: ExecuteApplyPatchOptions,
): PreparedPatchOperation {
  const { workspacePath, requestedPath, targetPath } = resolveWorkspaceTarget(
    workspace,
    operation.path,
    "apply_patch",
  );
  const validatedTarget = validateUpdateTarget(
    workspacePath,
    requestedPath,
    targetPath,
    operation.path,
  );
  if (
    options.readBeforeEdit !== undefined &&
    !options.readBeforeEdit.hasRead(validatedTarget.targetPath)
  ) {
    throw new KeelError(
      "tool_file_not_read",
      `apply_patch failed: file has not been read: ${operation.path}`,
      `Use read(path: "${operation.path}") to view the current file content, then retry apply_patch with hunks copied from the read output.`,
    );
  }

  const projectIgnorePolicy = createProjectIgnorePolicy(workspacePath);
  let openedMode = validatedTarget.mode;
  const file = readEditableTextFileWithMetadata(
    validatedTarget.targetPath,
    operation.path,
    {
      command: "apply_patch",
      maxBytes: MAX_PATCH_EDIT_FILE_BYTES,
      tooLargeError: (observedBytes) =>
        fileTooLargeError(operation.path, observedBytes),
      validateOpenedFile: (fd) => {
        const openedTargetPath = assertWorkspaceOpenTargetAtAccess({
          fd,
          workspacePath,
          targetPath: validatedTarget.targetPath,
          toolName: "apply_patch",
          requestedPath: operation.path,
        });
        if (projectIgnorePolicy.isIgnored(openedTargetPath, false)) {
          throw new KeelError(
            "tool_path_ignored",
            `apply_patch failed: ignored path: ${operation.path}`,
            "This file is excluded by project .gitignore. Choose a different file that is not ignored.",
          );
        }
        if (
          options.readBeforeEdit !== undefined &&
          !options.readBeforeEdit.hasRead(openedTargetPath)
        ) {
          throw new KeelError(
            "tool_file_not_read",
            `apply_patch failed: file has not been read: ${operation.path}`,
            `Use read(path: "${operation.path}") to view the current file content, then retry apply_patch with hunks copied from the read output.`,
          );
        }
        openedMode = fstatSync(fd).mode & 0o7777;
        return openedTargetPath;
      },
    },
  );
  const updated = applyUpdateHunks(
    operation.path,
    file.content,
    operation.hunks,
  );
  return {
    kind: "update",
    path: operation.path,
    workspacePath,
    targetPath: file.targetPath,
    beforeContent: withUtf8Bom(file.content, file.hasUtf8Bom),
    afterContent: withUtf8Bom(updated, file.hasUtf8Bom),
    mode: openedMode,
  };
}

function prepareAddOperation(
  workspace: string,
  operation: Extract<ParsedPatchOperation, { readonly kind: "add" }>,
): PreparedPatchOperation {
  const { workspacePath, targetPath, parentPath } =
    resolveWorkspaceCreateTarget(workspace, operation.path, "apply_patch");
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

function pathHasIdentity(path: string, identity: FileIdentity): boolean {
  try {
    return sameFileIdentity(statSync(path), identity);
  } catch {
    /* v8 ignore next 1: rollback tolerates concurrently removed target paths. */
    return false;
  }
}

function uniquePaths(paths: readonly string[]): readonly string[] {
  return [...new Set(paths)];
}

function rollbackTargetPaths(
  operation: AppliedPatchOperation,
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

function rollbackAppliedOperations(
  applied: readonly AppliedPatchOperation[],
): void {
  for (const operation of applied.toReversed()) {
    const targetPaths = rollbackTargetPaths(operation);
    if (targetPaths.length === 0) continue;

    if (operation.kind === "add") {
      for (const targetPath of targetPaths) {
        /* v8 ignore next 1: rollback skips files changed concurrently after the failed operation. */
        if (readFileIfPossible(targetPath) === operation.afterContent) {
          rmSync(targetPath, { force: true });
        }
      }
      continue;
    }

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
          operation.mode,
        );
      }
    }
  }
}

/* v8 ignore next 3: only used for create races after prevalidation. */
function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function validateAddTargetAfterMkdir(
  operation: Extract<PreparedPatchOperation, { readonly kind: "add" }>,
): string {
  const realTargetPath = resolveWorkspaceCreateTargetAtAccess({
    workspacePath: operation.workspacePath,
    parentPath: operation.parentPath,
    targetPath: operation.targetPath,
    toolName: "apply_patch",
    requestedPath: operation.path,
  });
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
  return realTargetPath;
}

function applyPreparedOperation(
  operation: PreparedPatchOperation,
): AppliedPatchOperation {
  if (operation.kind === "add") {
    createWorkspaceParentDirectories({
      workspacePath: operation.workspacePath,
      parentPath: operation.parentPath,
      toolName: "apply_patch",
      requestedPath: operation.path,
    });
    const realTargetPath = validateAddTargetAfterMkdir(operation);
    const validateTargetAtAccess = (): void => {
      validateAddTargetAfterMkdir(operation);
    };
    const validateOpenedTempAtAccess = (tempPath: string, fd: number): void => {
      assertWorkspaceOpenTargetAtAccess({
        fd,
        workspacePath: operation.workspacePath,
        targetPath: tempPath,
        toolName: "apply_patch",
        requestedPath: operation.path,
      });
    };
    let publishedTargetPath = realTargetPath;
    const validatePublishedTargetAtAccess = (
      publishedPath: string,
      identity: FileIdentity,
    ): void => {
      const accessTargetPath = assertWorkspaceFileIdentityAtAccess({
        identity,
        workspacePath: operation.workspacePath,
        targetPath: publishedPath,
        toolName: "apply_patch",
        requestedPath: operation.path,
      });
      const projectIgnorePolicy = createProjectIgnorePolicy(
        operation.workspacePath,
      );
      if (projectIgnorePolicy.isIgnored(accessTargetPath, false)) {
        throw new KeelError(
          "tool_path_ignored",
          `apply_patch failed: ignored path: ${operation.path}`,
          "This file is excluded by project .gitignore. Choose a different file that is not ignored.",
        );
      }
      publishedTargetPath = accessTargetPath;
    };
    let result: AtomicWriteResult;
    try {
      result = createTextFileAtomically(
        realTargetPath,
        operation.afterContent,
        {
          beforeAccess: validateTargetAtAccess,
          beforeWrite: validateOpenedTempAtAccess,
          beforePublish: validateTargetAtAccess,
          afterPublish: validatePublishedTargetAtAccess,
          cleanupPathsByIdentity: (identity) =>
            findWorkspacePathsByIdentity(operation.workspacePath, identity),
        },
      );
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
    return {
      ...operation,
      targetPath: publishedTargetPath,
      appliedIdentity: result.identity,
    };
  } else {
    const projectIgnorePolicy = createProjectIgnorePolicy(
      operation.workspacePath,
    );
    const validateTargetAtAccess = (): string => {
      const accessTargetPath = assertWorkspaceTargetAtAccess({
        workspacePath: operation.workspacePath,
        targetPath: operation.targetPath,
        toolName: "apply_patch",
        requestedPath: operation.path,
      });
      if (projectIgnorePolicy.isIgnored(accessTargetPath, false)) {
        throw new KeelError(
          "tool_path_ignored",
          `apply_patch failed: ignored path: ${operation.path}`,
          "This file is excluded by project .gitignore. Choose a different file that is not ignored.",
        );
      }
      return accessTargetPath;
    };
    const validateOpenedTempAtAccess = (tempPath: string, fd: number): void => {
      assertWorkspaceOpenTargetAtAccess({
        fd,
        workspacePath: operation.workspacePath,
        targetPath: tempPath,
        toolName: "apply_patch",
        requestedPath: operation.path,
      });
    };
    let publishedTargetPath = operation.targetPath;
    const validatePublishedTargetAtAccess = (
      publishedPath: string,
      identity: FileIdentity,
    ): void => {
      const accessTargetPath = assertWorkspaceFileIdentityAtAccess({
        identity,
        workspacePath: operation.workspacePath,
        targetPath: publishedPath,
        toolName: "apply_patch",
        requestedPath: operation.path,
      });
      if (projectIgnorePolicy.isIgnored(accessTargetPath, false)) {
        throw new KeelError(
          "tool_path_ignored",
          `apply_patch failed: ignored path: ${operation.path}`,
          "This file is excluded by project .gitignore. Choose a different file that is not ignored.",
        );
      }
      publishedTargetPath = accessTargetPath;
    };
    const result = writeTextFileAtomically(
      operation.targetPath,
      operation.afterContent,
      {
        mode: operation.mode,
        beforeAccess: validateTargetAtAccess,
        beforeWrite: validateOpenedTempAtAccess,
        beforePublish: validateTargetAtAccess,
        afterPublish: validatePublishedTargetAtAccess,
        validateReplacement: validateOpenedTempAtAccess,
        rollbackOnPublishFailure: {
          beforeContent: operation.beforeContent,
          afterContent: operation.afterContent,
        },
        /* v8 ignore next 2: update temp cleanup by identity is covered through edit/write; this is the same atomic path. */
        cleanupPathsByIdentity: (identity) =>
          findWorkspacePathsByIdentity(operation.workspacePath, identity),
      },
    );
    return {
      ...operation,
      targetPath: publishedTargetPath,
      appliedIdentity: result.identity,
    };
  }
}

function changedTargetError(operation: PreparedPatchOperation): KeelError {
  return new KeelError(
    "tool_path_outside_workspace",
    `apply_patch failed: path changed outside the verified workspace target: ${operation.path}`,
    "Retry after ensuring the target path remains stable within the workspace.",
  );
}

function verifyAppliedOperation(
  operation: AppliedPatchOperation,
): AppliedPatchOperation {
  const finalTargetPath = assertWorkspaceTargetAtAccess({
    workspacePath: operation.workspacePath,
    targetPath: operation.targetPath,
    toolName: "apply_patch",
    requestedPath: operation.path,
  });
  if (!pathHasIdentity(finalTargetPath, operation.appliedIdentity)) {
    throw changedTargetError(operation);
  }
  return { ...operation, targetPath: finalTargetPath };
}

function checkpointOperationFor(
  operation: AppliedPatchOperation,
): RecordLastBatchCheckpointOperation {
  const targetPath = assertWorkspaceTargetAtAccess({
    workspacePath: operation.workspacePath,
    targetPath: operation.targetPath,
    toolName: "apply_patch",
    requestedPath: operation.path,
  });
  if (!pathHasIdentity(targetPath, operation.appliedIdentity)) {
    throw changedTargetError(operation);
  }
  if (operation.kind === "add") {
    return {
      operation: "create",
      filePath: targetPath,
      afterContent: operation.afterContent,
    };
  }
  return {
    operation: "edit",
    filePath: targetPath,
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
  const applied: AppliedPatchOperation[] = [];
  let checkpointOperations: readonly RecordLastBatchCheckpointOperation[];
  try {
    for (const operation of prepared) {
      const appliedOperation = applyPreparedOperation(operation);
      applied.push(appliedOperation);
      applied[applied.length - 1] = verifyAppliedOperation(appliedOperation);
    }
    checkpointOperations = applied.map(checkpointOperationFor);
    recordLastBatchCheckpoint({
      workspace,
      operations: checkpointOperations,
    });
  } catch (error) {
    rollbackAppliedOperations(applied);
    throw error;
  }

  return {
    content: ["Applied patch:", ...prepared.map(summaryLine)].join("\n"),
    targetPaths: applied.map((operation) => operation.targetPath),
    checkpointOperations,
  };
}
