import { statSync, writeFileSync } from "node:fs";
import { KeelError } from "../core/error.ts";
import { recordLastEditCheckpoint } from "../core/git.ts";
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
}

interface NormalizedText {
  readonly text: string;
  readonly sourceIndexByNormalizedIndex: readonly number[];
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

function detectLineEnding(content: string): "\r\n" | "\n" | undefined {
  for (let index = 0; index < content.length; index++) {
    if (content[index] === "\r" && content[index + 1] === "\n") {
      return "\r\n";
    }
    if (content[index] === "\n") {
      return "\n";
    }
  }
  return undefined;
}

function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/gu, "\n");
}

function lineEndingAdjusted(text: string, lineEnding: "\r\n" | "\n"): string {
  return normalizeLineEndings(text).replaceAll("\n", lineEnding);
}

function sourceSpanReplacement(text: string, sourceSpan: string): string {
  if (!text.includes("\r") && !text.includes("\n")) return text;
  const sourceLineEnding = detectLineEnding(sourceSpan);
  if (sourceLineEnding === undefined) return text;
  return lineEndingAdjusted(text, sourceLineEnding);
}

function normalizeWithSourceMap(content: string): NormalizedText {
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
  return { text: normalized.join(""), sourceIndexByNormalizedIndex };
}

function originalSpan(
  normalized: NormalizedText,
  match: EditMatchSpan,
  originalLength: number,
): EditMatchSpan {
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
    const sourceSpan = content.slice(
      sourceMatch.index,
      sourceMatch.index + sourceMatch.length,
    );
    parts.push(
      content.slice(start, sourceMatch.index),
      sourceSpanReplacement(newString, sourceSpan),
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
): ToolResult {
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

  const file = readEditableTextFileWithMetadata(targetPath, filePath);
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
    const sourceSpan = content.slice(match.index, match.index + match.length);
    const replacement = sourceSpanReplacement(newString, sourceSpan);
    updated =
      content.slice(0, match.index) +
      replacement +
      content.slice(match.index + match.length);
  }

  const beforeContent = withUtf8Bom(content, file.hasUtf8Bom);
  const afterContent = withUtf8Bom(updated, file.hasUtf8Bom);
  writeFileSync(targetPath, afterContent, "utf8");
  recordLastEditCheckpoint({
    workspace: workspacePath,
    filePath: targetPath,
    beforeContent,
    afterContent,
  });

  return { content: `Edited ${filePath}` };
}
