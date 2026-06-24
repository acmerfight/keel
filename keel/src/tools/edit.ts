import { fstatSync, statSync } from "node:fs";
import { KeelError } from "../core/error.ts";
import {
  type RecordLastBatchCheckpointOperation,
  recordLastEditCheckpoint,
} from "../core/git.ts";
import { writeTextFileAtomically } from "./atomic-write.ts";
import {
  type EditMatchSpan,
  locateExactEditSpans,
  locateUniqueEditSpan,
} from "./edit-match.ts";
import { createProjectIgnorePolicy } from "./project-ignore.ts";
import { readEditableTextFileWithMetadata } from "./text-file.ts";
import type { ToolResult } from "./types.ts";
import {
  assertWorkspaceFileIdentityAtAccess,
  assertWorkspaceOpenTargetAtAccess,
  assertWorkspaceTargetAtAccess,
  type FileIdentity,
  findWorkspacePathsByIdentity,
  resolveWorkspaceTarget,
} from "./workspace-path.ts";

export interface EditReplacement {
  readonly oldText: string;
  readonly newText: string;
  readonly replaceAll?: boolean;
}

interface ExecuteEditOptions {
  readonly readBeforeEdit?: {
    readonly hasRead: (targetPath: string) => boolean;
  };
}

interface EditToolResult extends ToolResult {
  readonly targetPath: string;
  readonly checkpointOperation: RecordLastBatchCheckpointOperation;
}

const MAX_EDIT_FILE_BYTES = 10 * 1024 * 1024;

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

function fileNotReadError(filePath: string): KeelError {
  return new KeelError(
    "tool_file_not_read",
    `edit failed: file has not been read: ${filePath}`,
    `Use read(path: "${filePath}") to view the current file content, then retry edit with edits[].oldText copied from the read output.`,
  );
}

function ignoredPathError(filePath: string): KeelError {
  return new KeelError(
    "tool_path_ignored",
    `edit failed: ignored path: ${filePath}`,
    "This file is excluded by project .gitignore. Choose a different file that is not ignored.",
  );
}

interface NormalizedEditReplacement {
  readonly editIndex: number;
  readonly oldText: string;
  readonly newText: string;
  readonly normalizedOldText: string;
  readonly normalizedNewText: string;
  readonly replaceAll: boolean;
}

interface MatchedReplacement {
  readonly editIndex: number;
  readonly span: EditMatchSpan;
  readonly replacement: string;
}

function countLines(content: string): number {
  let lineCount = 1;
  for (const character of content) {
    if (character === "\n") {
      lineCount++;
    }
  }
  return lineCount;
}

function formatByteCount(bytes: number): string {
  return `${bytes.toLocaleString("en-US")} bytes`;
}

function formatFileSizeLimit(bytes: number): string {
  const mebibytes = bytes / (1024 * 1024);
  return `${formatByteCount(bytes)} (${mebibytes.toFixed(0)} MiB)`;
}

function fileTooLargeError(filePath: string, bytes: number): KeelError {
  return new KeelError(
    "tool_file_too_large",
    `edit failed: file is too large: ${filePath} (${formatByteCount(bytes)}; limit ${formatFileSizeLimit(MAX_EDIT_FILE_BYTES)})`,
    "Use grep or read a smaller region to inspect the file, then edit a smaller source file, split the file, regenerate it, or use a targeted external command if appropriate.",
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
    throw new Error("edit source map invariant violated: match is invalid");
  }
  return { index, length: end - index };
}

function withUtf8Bom(content: string, hasUtf8Bom: boolean): string {
  return hasUtf8Bom ? `\uFEFF${content}` : content;
}

function normalizeEditReplacements(
  edits: readonly EditReplacement[],
): readonly NormalizedEditReplacement[] {
  if (edits.length === 0) {
    throw new KeelError(
      "tool_empty_old_string",
      "edit failed: edits is empty",
      "Provide at least one edit with oldText copied from read output.",
    );
  }

  const normalized: NormalizedEditReplacement[] = [];
  let editIndex = 0;
  for (const edit of edits) {
    if (edit.oldText === "") {
      throw new KeelError(
        "tool_empty_old_string",
        `edit failed: old string is empty in edits[${editIndex}]`,
        "Provide the exact text to replace. Use read to find the target text first.",
      );
    }
    const normalizedOldText = normalizeLineEndings(edit.oldText);
    const normalizedNewText = normalizeLineEndings(edit.newText);
    if (normalizedOldText === normalizedNewText) {
      throw new KeelError(
        "tool_edit_no_op",
        `edit failed: old string and new string are identical in edits[${editIndex}]`,
        "Change newText to the desired replacement text, or skip the edit if no change is needed.",
      );
    }
    normalized.push({
      editIndex,
      oldText: edit.oldText,
      newText: edit.newText,
      normalizedOldText,
      normalizedNewText,
      replaceAll: edit.replaceAll === true,
    });
    editIndex++;
  }
  return normalized;
}

function matchedReplacementsForEdit(
  content: string,
  normalizedContent: NormalizedText,
  edit: NormalizedEditReplacement,
  filePath: string,
): readonly MatchedReplacement[] {
  if (edit.replaceAll) {
    const matches = locateExactEditSpans(
      normalizedContent.text,
      edit.normalizedOldText,
    );
    if (matches.length === 0) {
      const lineCount = countLines(content);
      throw new KeelError(
        "tool_old_string_not_found",
        `edit failed: old string not found in ${filePath} (${lineCount} lines) for edits[${edit.editIndex}]`,
        `Use read(path: "${filePath}") to view the current file content, then retry edit with the exact text from the file.`,
      );
    }
    return matches.map((match) => {
      const span = originalSpan(normalizedContent, match, content.length);
      return {
        editIndex: edit.editIndex,
        span,
        replacement: sourceSpanReplacement(
          edit.newText,
          sourceLineEnding(content, span),
        ),
      };
    });
  }

  const matchResult = locateUniqueEditSpan(
    normalizedContent.text,
    edit.normalizedOldText,
  );
  if (matchResult.status === "not_found") {
    const lineCount = countLines(content);
    throw new KeelError(
      "tool_old_string_not_found",
      `edit failed: old string not found in ${filePath} (${lineCount} lines) for edits[${edit.editIndex}]`,
      `Use read(path: "${filePath}") to view the current file content, then retry edit with the exact text from the file.`,
    );
  }
  if (matchResult.status === "not_unique") {
    throw new KeelError(
      "tool_old_string_not_unique",
      `edit failed: old string appears ${matchResult.occurrenceCount} times in ${filePath} for edits[${edit.editIndex}]`,
      "Include more surrounding context in oldText to make the match unique, or set replaceAll when every occurrence should change.",
    );
  }
  const span = originalSpan(
    normalizedContent,
    matchResult.match,
    content.length,
  );
  return [
    {
      editIndex: edit.editIndex,
      span,
      replacement: sourceSpanReplacement(
        edit.newText,
        sourceLineEnding(content, span),
      ),
    },
  ];
}

function sortedMatchedReplacements(
  edits: readonly NormalizedEditReplacement[],
  content: string,
  normalizedContent: NormalizedText,
  filePath: string,
): readonly MatchedReplacement[] {
  const matched: MatchedReplacement[] = [];
  for (const edit of edits) {
    matched.push(
      ...matchedReplacementsForEdit(content, normalizedContent, edit, filePath),
    );
  }

  const sorted = matched.toSorted((left, right) => {
    if (left.span.index !== right.span.index) {
      return left.span.index - right.span.index;
    }
    return left.editIndex - right.editIndex;
  });
  let previous: MatchedReplacement | null = null;
  for (const current of sorted) {
    if (
      previous !== null &&
      previous.span.index + previous.span.length > current.span.index
    ) {
      throw new KeelError(
        "tool_edit_overlap",
        `edit failed: edits[${previous.editIndex}] and edits[${current.editIndex}] overlap in ${filePath}`,
        "Merge overlapping or nested changes into one edit, or target disjoint regions.",
      );
    }
    previous = current;
  }
  return sorted;
}

function applyMatchedReplacements(
  content: string,
  replacements: readonly MatchedReplacement[],
): string {
  let updated = content;
  for (const replacement of replacements.toReversed()) {
    updated =
      updated.slice(0, replacement.span.index) +
      replacement.replacement +
      updated.slice(replacement.span.index + replacement.span.length);
  }
  return updated;
}

function executeEditBatch(
  workspace: string,
  filePath: string,
  edits: readonly EditReplacement[],
  options: ExecuteEditOptions = {},
): EditToolResult {
  const normalizedEdits = normalizeEditReplacements(edits);
  const { workspacePath, requestedPath, targetPath } = resolveWorkspaceTarget(
    workspace,
    filePath,
    "edit",
  );

  const accessTargetPath = assertWorkspaceTargetAtAccess({
    workspacePath,
    targetPath,
    toolName: "edit",
    requestedPath: filePath,
  });
  const targetStat = statSync(accessTargetPath);
  const targetIsDirectory = targetStat.isDirectory();
  const projectIgnorePolicy = createProjectIgnorePolicy(workspacePath);
  if (
    projectIgnorePolicy.isIgnored(requestedPath, targetIsDirectory) ||
    projectIgnorePolicy.isIgnored(accessTargetPath, targetIsDirectory)
  ) {
    throw ignoredPathError(filePath);
  }
  if (!targetStat.isFile()) {
    throw new KeelError(
      "tool_not_file",
      `edit failed: not a file: ${filePath}`,
      "The path is a directory, not a file. Specify a file path inside it.",
    );
  }
  if (
    options.readBeforeEdit !== undefined &&
    !options.readBeforeEdit.hasRead(accessTargetPath)
  ) {
    throw fileNotReadError(filePath);
  }

  let openedMode = targetStat.mode & 0o7777;
  const file = readEditableTextFileWithMetadata(accessTargetPath, filePath, {
    maxBytes: MAX_EDIT_FILE_BYTES,
    tooLargeError: (observedBytes) =>
      fileTooLargeError(filePath, observedBytes),
    validateOpenedFile: (fd) => {
      const openedTargetPath = assertWorkspaceOpenTargetAtAccess({
        fd,
        workspacePath,
        targetPath: accessTargetPath,
        toolName: "edit",
        requestedPath: filePath,
      });
      if (projectIgnorePolicy.isIgnored(openedTargetPath, false)) {
        throw ignoredPathError(filePath);
      }
      if (
        options.readBeforeEdit !== undefined &&
        !options.readBeforeEdit.hasRead(openedTargetPath)
      ) {
        throw fileNotReadError(filePath);
      }
      openedMode = fstatSync(fd).mode & 0o7777;
      return openedTargetPath;
    },
  });
  const content = file.content;
  const normalizedContent = normalizeWithSourceMap(content);
  const updated = applyMatchedReplacements(
    content,
    sortedMatchedReplacements(
      normalizedEdits,
      content,
      normalizedContent,
      filePath,
    ),
  );

  const beforeContent = withUtf8Bom(content, file.hasUtf8Bom);
  const afterContent = withUtf8Bom(updated, file.hasUtf8Bom);
  const validateTargetAtAccess = (): string => {
    const openedTargetPath = assertWorkspaceTargetAtAccess({
      workspacePath,
      targetPath: file.targetPath,
      toolName: "edit",
      requestedPath: filePath,
    });
    if (projectIgnorePolicy.isIgnored(openedTargetPath, false)) {
      throw ignoredPathError(filePath);
    }
    return openedTargetPath;
  };
  const validateOpenedTempAtAccess = (tempPath: string, fd: number): void => {
    assertWorkspaceOpenTargetAtAccess({
      fd,
      workspacePath,
      targetPath: tempPath,
      toolName: "edit",
      requestedPath: filePath,
    });
  };
  let publishedTargetPath = file.targetPath;
  const validatePublishedTargetAtAccess = (
    publishedPath: string,
    identity: FileIdentity,
  ): void => {
    const openedTargetPath = assertWorkspaceFileIdentityAtAccess({
      identity,
      workspacePath,
      targetPath: publishedPath,
      toolName: "edit",
      requestedPath: filePath,
    });
    if (projectIgnorePolicy.isIgnored(openedTargetPath, false)) {
      throw ignoredPathError(filePath);
    }
    publishedTargetPath = openedTargetPath;
  };
  writeTextFileAtomically(file.targetPath, afterContent, {
    mode: openedMode,
    beforeAccess: validateTargetAtAccess,
    beforeWrite: validateOpenedTempAtAccess,
    beforePublish: validateTargetAtAccess,
    afterPublish: validatePublishedTargetAtAccess,
    validateReplacement: validateOpenedTempAtAccess,
    rollbackOnPublishFailure: { beforeContent, afterContent },
    cleanupPathsByIdentity: (identity) =>
      findWorkspacePathsByIdentity(workspacePath, identity),
  });
  const finalTargetPath = publishedTargetPath;
  recordLastEditCheckpoint({
    workspace: workspacePath,
    filePath: finalTargetPath,
    beforeContent,
    afterContent,
  });

  return {
    content: `Edited ${filePath}`,
    targetPath: finalTargetPath,
    checkpointOperation: {
      operation: "edit",
      filePath: finalTargetPath,
      beforeContent,
      afterContent,
    },
  };
}

export function executeEdit(
  workspace: string,
  filePath: string,
  edits: readonly EditReplacement[],
  options?: ExecuteEditOptions,
): EditToolResult;
export function executeEdit(
  workspace: string,
  filePath: string,
  edits: readonly EditReplacement[],
  options: ExecuteEditOptions = {},
): EditToolResult {
  return executeEditBatch(workspace, filePath, edits, options);
}
