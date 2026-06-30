import {
  type EditMatchSpan,
  locateUniqueEditSpan,
  normalizeLineEndings,
  normalizeWithSourceMap,
  originalSpan,
  sourceLineEnding,
  sourcePreservingReplacement,
  sourceSpanReplacement,
} from "../edit-match.ts";
import { patchError } from "./errors.ts";
import type { ParsedPatchHunk } from "./model.ts";

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
