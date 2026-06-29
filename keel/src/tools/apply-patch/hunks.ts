import {
  type EditMatchSpan,
  locateUniqueEditSpan,
  sourcePreservingReplacement,
} from "../edit-match.ts";
import { patchError } from "./errors.ts";
import type { ParsedPatchHunk } from "./model.ts";

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

function sourcePreservingHunkReplacement(
  filePath: string,
  source: string,
  oldText: string,
  newText: string,
  lineEnding: "\r\n" | "\n",
): string {
  const result = sourcePreservingReplacement(source, oldText, newText);
  if (result.status === "matched") {
    return sourceSpanReplacement(result.replacement, lineEnding);
  }
  throw patchError(
    "tool_patch_hunk_not_found",
    `apply_patch failed: fuzzy hunk match cannot be applied safely in ${filePath}: ${result.reason}`,
    `Use read(path: "${filePath}") to copy the current text exactly, then retry with a smaller exact hunk.`,
  );
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

function isLineBoundarySpan(content: string, span: EditMatchSpan): boolean {
  const start = span.index;
  const end = span.index + span.length;
  return (
    (start === 0 || content[start - 1] === "\n") &&
    (end === content.length || content[end] === "\n")
  );
}

export function withUtf8Bom(content: string, hasUtf8Bom: boolean): string {
  return hasUtf8Bom ? `\uFEFF${content}` : content;
}

export function addFileContent(lines: readonly string[]): string {
  const content = lines.join("\n");
  if (content === "" || content.endsWith("\n")) return content;
  return `${content}\n`;
}

export function applyUpdateHunks(
  filePath: string,
  content: string,
  hunks: readonly ParsedPatchHunk[],
): string {
  let updated = content;
  for (const hunk of hunks) {
    const oldText = normalizeLineEndings(hunk.oldLines.join("\n"));
    const newText = hunk.newLines.join("\n");
    const normalized = normalizeWithSourceMap(updated);
    const matchResult = locateUniqueEditSpan(normalized.text, oldText, {
      includeSpan: (span) => isLineBoundarySpan(normalized.text, span),
    });
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
    const normalizedSource = normalized.text.slice(
      matchResult.match.index,
      matchResult.match.index + matchResult.match.length,
    );
    updated =
      updated.slice(0, match.index) +
      sourcePreservingHunkReplacement(
        filePath,
        normalizedSource,
        oldText,
        newText,
        sourceLineEnding(updated, match),
      ) +
      updated.slice(match.index + match.length);
  }
  return updated;
}
