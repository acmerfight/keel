import { statSync } from "node:fs";
import { KeelError } from "../core/error.ts";
import { recordLastEditCheckpoint } from "../core/git.ts";
import { writeTextFileAtomically } from "./atomic-write.ts";
import {
  type EditMatchSpan,
  locateExactEditSpans,
  locateUniqueEditSpan,
} from "./edit-match.ts";
import { createProjectIgnorePolicy } from "./project-ignore.ts";
import { readEditableTextFileWithMetadata } from "./text-file.ts";
import type { ToolResult } from "./types.ts";
import { resolveWorkspaceTarget } from "./workspace-path.ts";

interface ExecuteEditOptions {
  readonly replaceAll?: boolean;
  readonly readBeforeEdit?: {
    readonly hasRead: (targetPath: string) => boolean;
  };
}

interface EditToolResult extends ToolResult {
  readonly targetPath: string;
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

function replaceAllNormalized(
  content: string,
  normalized: NormalizedText,
  matches: readonly EditMatchSpan[],
  newString: string,
): string {
  const parts: string[] = [];
  let start = 0;
  for (const match of matches) {
    const sourceMatch = originalSpan(normalized, match, content.length);
    parts.push(
      content.slice(start, sourceMatch.index),
      sourceSpanReplacement(newString, sourceLineEnding(content, sourceMatch)),
    );
    start = sourceMatch.index + sourceMatch.length;
  }
  parts.push(content.slice(start));
  return parts.join("");
}

export function executeEdit(
  workspace: string,
  filePath: string,
  oldString: string,
  newString: string,
  options: ExecuteEditOptions = {},
): EditToolResult {
  if (oldString === "") {
    throw new KeelError(
      "tool_empty_old_string",
      "edit failed: old string is empty",
      "Provide the exact text to replace. Use read to find the target text first.",
    );
  }
  const normalizedOldString = normalizeLineEndings(oldString);
  const normalizedNewString = normalizeLineEndings(newString);
  if (normalizedOldString === normalizedNewString) {
    throw new KeelError(
      "tool_edit_no_op",
      "edit failed: old string and new string are identical",
      "Change newString to the desired replacement text, or skip the edit if no change is needed.",
    );
  }

  const { workspacePath, requestedPath, targetPath } = resolveWorkspaceTarget(
    workspace,
    filePath,
    "edit",
  );

  const targetStat = statSync(targetPath);
  const targetIsDirectory = targetStat.isDirectory();
  const projectIgnorePolicy = createProjectIgnorePolicy(workspacePath);
  if (
    projectIgnorePolicy.isIgnored(requestedPath, targetIsDirectory) ||
    projectIgnorePolicy.isIgnored(targetPath, targetIsDirectory)
  ) {
    throw new KeelError(
      "tool_path_ignored",
      `edit failed: ignored path: ${filePath}`,
      "This file is excluded by project .gitignore. Choose a different file that is not ignored.",
    );
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
    !options.readBeforeEdit.hasRead(targetPath)
  ) {
    throw new KeelError(
      "tool_file_not_read",
      `edit failed: file has not been read: ${filePath}`,
      `Use read(path: "${filePath}") to view the current file content, then retry edit with oldString copied from the read output.`,
    );
  }

  const file = readEditableTextFileWithMetadata(targetPath, filePath, {
    maxBytes: MAX_EDIT_FILE_BYTES,
    tooLargeError: (observedBytes) =>
      fileTooLargeError(filePath, observedBytes),
  });
  const content = file.content;
  const normalizedContent = normalizeWithSourceMap(content);
  let updated: string;

  if (options.replaceAll === true) {
    const matches = locateExactEditSpans(
      normalizedContent.text,
      normalizedOldString,
    );
    if (matches.length === 0) {
      const lineCount = countLines(content);
      throw new KeelError(
        "tool_old_string_not_found",
        `edit failed: old string not found in ${filePath} (${lineCount} lines)`,
        `Use read(path: "${filePath}") to view the current file content, then retry edit with the exact text from the file.`,
      );
    }
    updated = replaceAllNormalized(
      content,
      normalizedContent,
      matches,
      newString,
    );
  } else {
    const matchResult = locateUniqueEditSpan(
      normalizedContent.text,
      normalizedOldString,
    );
    if (matchResult.status === "not_found") {
      const lineCount = countLines(content);
      throw new KeelError(
        "tool_old_string_not_found",
        `edit failed: old string not found in ${filePath} (${lineCount} lines)`,
        `Use read(path: "${filePath}") to view the current file content, then retry edit with the exact text from the file.`,
      );
    }
    if (matchResult.status === "not_unique") {
      throw new KeelError(
        "tool_old_string_not_unique",
        `edit failed: old string appears ${matchResult.occurrenceCount} times in ${filePath}`,
        "Include more surrounding context in oldString to make the match unique, or target a specific occurrence.",
      );
    }
    const match = originalSpan(
      normalizedContent,
      matchResult.match,
      content.length,
    );
    const replacement = sourceSpanReplacement(
      newString,
      sourceLineEnding(content, match),
    );
    updated =
      content.slice(0, match.index) +
      replacement +
      content.slice(match.index + match.length);
  }

  const beforeContent = withUtf8Bom(content, file.hasUtf8Bom);
  const afterContent = withUtf8Bom(updated, file.hasUtf8Bom);
  writeTextFileAtomically(targetPath, afterContent, {
    mode: targetStat.mode & 0o7777,
  });
  recordLastEditCheckpoint({
    workspace: workspacePath,
    filePath: targetPath,
    beforeContent,
    afterContent,
  });

  return { content: `Edited ${filePath}`, targetPath };
}
