import { fstatSync, readSync, statSync } from "node:fs";
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
  type NormalizedText,
  normalizeLineEndings,
  normalizeWithSourceMap,
  originalSpan,
  sourceLineEnding,
  sourcePreservingReplacement,
  sourceSpanReplacement,
} from "./edit-match.ts";
import {
  createFileRevisionAccumulator,
  type FileRevision,
} from "./file-revision.ts";
import { createProjectIgnorePolicy } from "./project-ignore.ts";
import type { FileRevisionStatus, ReadBeforeEdit } from "./read-before-edit.ts";
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
  readonly readBeforeEdit?: ReadBeforeEdit;
  readonly recordCheckpoint?: boolean;
}

interface EditToolResult extends ToolResult {
  readonly targetPath: string;
  readonly checkpointOperation: RecordLastBatchCheckpointOperation;
}

const MAX_EDIT_FILE_BYTES = 10 * 1024 * 1024;
const MAX_EDIT_DIAGNOSTIC_LINES = 40;
const MAX_EDIT_DIAGNOSTIC_LINE_CHARS = 160;
const MAX_EDIT_DIAGNOSTIC_MATCHES = 5;
const EDIT_DIAGNOSTIC_CONTEXT_LINES = 1;
const REVISION_CHUNK_BYTES = 64 * 1024;

interface DiagnosticLine {
  readonly lineNumber: number;
  readonly end: number;
  readonly text: string;
}

function fileRevisionFromDescriptor(fd: number): FileRevision {
  const revision = createFileRevisionAccumulator();
  const chunk = Buffer.allocUnsafe(REVISION_CHUNK_BYTES);
  let position = 0;
  while (true) {
    const bytesRead = readSync(fd, chunk, 0, chunk.length, position);
    if (bytesRead === 0) return revision.finish();
    revision.update(chunk.subarray(0, bytesRead));
    position += bytesRead;
  }
}

function fileNotReadError(filePath: string): KeelError {
  return new KeelError(
    "tool_file_not_read",
    `edit failed: file has not been read: ${filePath}`,
    `Use read(path: "${filePath}") to view the current file content, then retry edit with edits[].oldText copied from the read output.`,
  );
}

function fileChangedSinceReadError(filePath: string): KeelError {
  return new KeelError(
    "tool_file_changed_since_read",
    `edit failed: file has changed since it was read: ${filePath}`,
    `Use read(path: "${filePath}") to view the current file content, then retry edit with edits[].oldText copied from the new read output.`,
  );
}

function assertCurrentReadRevision(
  readBeforeEdit: ReadBeforeEdit | undefined,
  targetPath: string,
  filePath: string,
  currentRevision: FileRevision,
): void {
  if (readBeforeEdit === undefined) return;
  const status: FileRevisionStatus = readBeforeEdit.revisionStatus(
    targetPath,
    currentRevision,
  );
  if (status === "unread") throw fileNotReadError(filePath);
  if (status === "changed") throw fileChangedSinceReadError(filePath);
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
  if (content === "") return 0;

  let lineCount = 1;
  for (let index = 0; index < content.length; index++) {
    if (content[index] === "\n" && index < content.length - 1) {
      lineCount++;
    }
  }
  return lineCount;
}

function diagnosticLineText(text: string): string {
  const visibleText = text.endsWith("\r") ? text.slice(0, -1) : text;
  if (visibleText.length <= MAX_EDIT_DIAGNOSTIC_LINE_CHARS) return visibleText;
  return `${visibleText.slice(0, MAX_EDIT_DIAGNOSTIC_LINE_CHARS - 3)}...`;
}

function splitDiagnosticLines(content: string): readonly DiagnosticLine[] {
  if (content === "") return [];

  const lines: DiagnosticLine[] = [];
  let start = 0;
  let lineNumber = 1;
  for (let index = 0; index < content.length; index++) {
    if (content[index] !== "\n") continue;
    lines.push({
      lineNumber,
      end: index + 1,
      text: content.slice(start, index),
    });
    start = index + 1;
    lineNumber++;
  }

  if (start < content.length) {
    lines.push({
      lineNumber,
      end: content.length,
      text: content.slice(start),
    });
  }
  return lines;
}

function formatDiagnosticLines(
  lines: readonly DiagnosticLine[],
  start: number,
  end: number,
): string {
  const visibleLines = lines.slice(start, end);
  const width = String(start + visibleLines.length).length;
  return visibleLines
    .map(
      (line) =>
        `${String(line.lineNumber).padStart(width, " ")} | ${diagnosticLineText(
          line.text,
        )}`,
    )
    .join("\n");
}

function currentFileContextDiagnostic(
  filePath: string,
  content: string,
): string {
  const lines = splitDiagnosticLines(content);
  if (lines.length === 0) {
    return `Current file context for ${filePath}:\n<empty file>`;
  }

  const shownLineCount = Math.min(lines.length, MAX_EDIT_DIAGNOSTIC_LINES);
  const output = [
    `Current file context for ${filePath}:`,
    formatDiagnosticLines(lines, 0, shownLineCount),
  ];
  const omittedLineCount = lines.length - shownLineCount;
  if (omittedLineCount > 0) {
    output.push(`[... ${omittedLineCount} more lines omitted ...]`);
  }
  return output.join("\n");
}

function currentFileContextRecovery(filePath: string, content: string): string {
  return [
    "Use the current context below to retry edit with edits[].oldText copied from the current file content.",
    `If the target is outside this excerpt, use read(path: "${filePath}") with offset/limit or grep to inspect the current target.`,
    "",
    currentFileContextDiagnostic(filePath, content),
  ].join("\n");
}

function diagnosticLineIndexAtOffset(
  lines: readonly DiagnosticLine[],
  offset: number,
): number {
  return lines.findIndex((line) => offset < line.end);
}

interface DiagnosticLineRange {
  readonly start: number;
  readonly end: number;
}

function mergeDiagnosticLineRanges(
  ranges: readonly DiagnosticLineRange[],
): readonly DiagnosticLineRange[] {
  const merged: DiagnosticLineRange[] = [];
  for (const range of ranges) {
    const previous = merged[merged.length - 1];
    if (previous !== undefined && range.start <= previous.end) {
      merged[merged.length - 1] = {
        start: previous.start,
        end: Math.max(previous.end, range.end),
      };
      continue;
    }
    merged.push(range);
  }
  return merged;
}

function matchingLocationsDiagnostic(
  filePath: string,
  content: string,
  spans: readonly EditMatchSpan[],
  occurrenceCount: number,
): string {
  const lines = splitDiagnosticLines(content);

  const ranges = spans.map((span) => {
    const lineIndex = diagnosticLineIndexAtOffset(lines, span.index);
    return {
      start: Math.max(0, lineIndex - EDIT_DIAGNOSTIC_CONTEXT_LINES),
      end: Math.min(
        lines.length,
        lineIndex + EDIT_DIAGNOSTIC_CONTEXT_LINES + 1,
      ),
    };
  });
  const windows = mergeDiagnosticLineRanges(ranges)
    .map((range) => formatDiagnosticLines(lines, range.start, range.end))
    .join("\n--\n");
  const output = [`Current matching locations in ${filePath}:`, windows];
  const omittedMatchCount = occurrenceCount - spans.length;
  if (omittedMatchCount > 0) {
    output.push(`[... ${omittedMatchCount} more matches omitted ...]`);
  }
  return output.join("\n");
}

function notUniqueRecovery(
  filePath: string,
  content: string,
  spans: readonly EditMatchSpan[],
  occurrenceCount: number,
): string {
  return [
    "Include more surrounding context in oldText to make the match unique, or set replaceAll when every occurrence should change.",
    "",
    matchingLocationsDiagnostic(filePath, content, spans, occurrenceCount),
  ].join("\n");
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

function sourcePreservingEditReplacement(
  source: string,
  edit: NormalizedEditReplacement,
  filePath: string,
  lineEnding: "\r\n" | "\n",
): string {
  const result = sourcePreservingReplacement(
    source,
    edit.normalizedOldText,
    edit.normalizedNewText,
  );
  if (result.status === "matched") {
    return sourceSpanReplacement(result.replacement, lineEnding);
  }
  throw new KeelError(
    "tool_old_string_not_found",
    `edit failed: fuzzy old string match cannot be applied safely in ${filePath} for edits[${edit.editIndex}]: ${result.reason}`,
    `Use read(path: "${filePath}") to copy the current text exactly, then retry with a smaller exact edits[${edit.editIndex}].oldText.`,
  );
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
        currentFileContextRecovery(filePath, content),
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
      currentFileContextRecovery(filePath, content),
    );
  }
  if (matchResult.status === "not_unique") {
    const spans = matchResult.matches
      .slice(0, MAX_EDIT_DIAGNOSTIC_MATCHES)
      .map((match) => originalSpan(normalizedContent, match, content.length));
    throw new KeelError(
      "tool_old_string_not_unique",
      `edit failed: old string appears ${matchResult.occurrenceCount} times in ${filePath} for edits[${edit.editIndex}]`,
      notUniqueRecovery(filePath, content, spans, matchResult.occurrenceCount),
    );
  }
  const span = originalSpan(
    normalizedContent,
    matchResult.match,
    content.length,
  );
  const normalizedSource = normalizedContent.text.slice(
    matchResult.match.index,
    matchResult.match.index + matchResult.match.length,
  );
  return [
    {
      editIndex: edit.editIndex,
      span,
      replacement: sourcePreservingEditReplacement(
        normalizedSource,
        edit,
        filePath,
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
      return {
        targetPath: openedTargetPath,
        metadata: fstatSync(fd).mode & 0o7777,
      };
    },
  });
  assertCurrentReadRevision(
    options.readBeforeEdit,
    file.targetPath,
    filePath,
    file.fileRevision,
  );
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
    mode: file.openedMetadata,
    beforeAccess: validateTargetAtAccess,
    beforeWrite: validateOpenedTempAtAccess,
    beforePublish: validateTargetAtAccess,
    afterPublish: validatePublishedTargetAtAccess,
    validateReplacement: (replacementPath, fd) => {
      validateOpenedTempAtAccess(replacementPath, fd);
      assertCurrentReadRevision(
        options.readBeforeEdit,
        replacementPath,
        filePath,
        fileRevisionFromDescriptor(fd),
      );
    },
    rollbackOnPublishFailure: { beforeContent, afterContent },
    cleanupPathsByIdentity: (identity) =>
      findWorkspacePathsByIdentity(workspacePath, identity),
  });
  const finalTargetPath = publishedTargetPath;
  if (options.recordCheckpoint !== false) {
    recordLastEditCheckpoint({
      workspace: workspacePath,
      filePath: finalTargetPath,
      beforeContent,
      afterContent,
      modeOwnership: { kind: "unowned" },
    });
  }

  return {
    content: `Edited ${filePath}`,
    targetPath: finalTargetPath,
    checkpointOperation: {
      operation: "edit",
      filePath: finalTargetPath,
      beforeContent,
      afterContent,
      modeOwnership: { kind: "unowned" },
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
