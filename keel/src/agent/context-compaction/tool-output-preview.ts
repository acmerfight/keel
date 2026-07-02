import type { ToolCall } from "../../llm/types.ts";
import type { ToolOutputArtifactToolName } from "../tool-output-artifacts.ts";

export interface ToolOutputProjectionContext {
  readonly toolName: ToolOutputArtifactToolName;
  readonly toolCall?: ToolCall;
}

export interface ProjectedToolOutput {
  readonly preview: string;
  readonly omittedChars: number;
}

function projectedOmittedChars(text: string, preview: string): number {
  return Math.max(0, text.length - preview.length);
}

function boundedText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return text.slice(0, maxChars);
}

function joinedLines(lines: readonly string[]): string {
  return lines.join("\n");
}

function appendLineWithinBudget(
  lines: string[],
  line: string,
  maxChars: number,
): boolean {
  const candidate = joinedLines([...lines, line]);
  if (candidate.length <= maxChars) {
    lines.push(line);
    return true;
  }
  return false;
}

function prependLineWithinBudget(
  lines: string[],
  line: string,
  maxChars: number,
): boolean {
  const candidate = joinedLines([line, ...lines]);
  if (candidate.length <= maxChars) {
    lines.unshift(line);
    return true;
  }
  return false;
}

function headLinesWithinBudget(
  lines: readonly string[],
  maxChars: number,
): readonly string[] {
  const selected: string[] = [];
  for (const line of lines) {
    if (!appendLineWithinBudget(selected, line, maxChars)) {
      break;
    }
  }
  if (selected.length === 0 && lines[0] !== undefined && maxChars > 0) {
    return [boundedText(lines[0], maxChars)];
  }
  return selected;
}

function tailLinesWithinBudget(
  lines: readonly string[],
  maxChars: number,
): readonly string[] {
  const candidateLines = [...lines];
  while (candidateLines.at(-1) === "") {
    candidateLines.pop();
  }

  const selected: string[] = [];
  for (const line of Array.from(candidateLines).reverse()) {
    if (!prependLineWithinBudget(selected, line, maxChars)) {
      break;
    }
  }
  const lastLine = candidateLines.at(-1);
  if (selected.length === 0 && lastLine !== undefined && maxChars > 0) {
    return [lastLine.slice(-maxChars)];
  }
  return selected;
}

function sourceLineForToolCall(
  context: ToolOutputProjectionContext,
): string | null {
  const { toolCall } = context;
  /* v8 ignore next 3: active ledger context supplies a toolCall for every known tool identity. */
  if (toolCall === undefined) {
    return null;
  }
  switch (toolCall.tool) {
    case "bash":
      return `bash command: ${toolCall.command}`;
    case "read": {
      const windowParts: string[] = [];
      if (toolCall.offset !== undefined) {
        windowParts.push(`offset=${toolCall.offset}`);
      }
      if (toolCall.limit !== undefined) {
        windowParts.push(`limit=${toolCall.limit}`);
      }
      return windowParts.length === 0
        ? `read source: ${toolCall.path}`
        : `read source: ${toolCall.path} (${windowParts.join(", ")})`;
    }
    case "grep":
      return toolCall.path === undefined
        ? `grep source: ${toolCall.pattern}`
        : `grep source: ${toolCall.pattern} in ${toolCall.path}`;
    case "glob":
      return toolCall.path === undefined
        ? `glob source: ${toolCall.pattern}`
        : `glob source: ${toolCall.pattern} in ${toolCall.path}`;
    case "ls":
      return toolCall.path === undefined
        ? "ls source: ."
        : `ls source: ${toolCall.path}`;
    case "git_diff":
      return toolCall.paths === undefined || toolCall.paths.length === 0
        ? "git_diff source: all changes"
        : `git_diff source: ${toolCall.paths.join(" ")}`;
  }
  /* v8 ignore next: generic edit/write/apply_patch projections do not request source lines. */
  return null;
}

function appendSourceLine(
  lines: string[],
  context: ToolOutputProjectionContext,
  maxChars: number,
): void {
  const sourceLine = sourceLineForToolCall(context);
  /* v8 ignore next 3: generic projections do not call appendSourceLine. */
  if (sourceLine === null) {
    return;
  }
  appendLineWithinBudget(lines, sourceLine, maxChars);
}

function compactLineAware(
  text: string,
  maxChars: number,
  context: ToolOutputProjectionContext,
): string {
  const selected: string[] = [];
  appendSourceLine(selected, context, maxChars);
  for (const line of headLinesWithinBudget(text.split("\n"), maxChars)) {
    /* v8 ignore next 3: compactLineAware content lines are preselected against the same budget. */
    if (!appendLineWithinBudget(selected, line, maxChars)) {
      break;
    }
  }
  return boundedText(joinedLines(selected), maxChars);
}

function projectBashOutput(
  text: string,
  maxChars: number,
  context: ToolOutputProjectionContext,
): string {
  const lines = text.split("\n");
  const selected: string[] = [];
  appendSourceLine(selected, context, maxChars);
  for (const line of lines) {
    if (
      line === "" ||
      line.startsWith("Command timed out after ") ||
      line.startsWith("Exit code: ") ||
      line.startsWith("Signal: ")
    ) {
      appendLineWithinBudget(selected, line, maxChars);
      continue;
    }
    break;
  }
  appendLineWithinBudget(selected, "[bash output tail preview]", maxChars);
  const remaining = Math.max(0, maxChars - joinedLines(selected).length - 1);
  for (const line of tailLinesWithinBudget(lines, remaining)) {
    /* v8 ignore next 3: tail lines are preselected against the exact remaining budget. */
    if (!appendLineWithinBudget(selected, line, maxChars)) {
      break;
    }
  }
  return boundedText(joinedLines(selected), maxChars);
}

function readContinuationNotice(lines: readonly string[]): string | undefined {
  return lines.findLast(
    (line) =>
      line.startsWith("[Read output truncated") ||
      line.startsWith("[Read output stopped"),
  );
}

function projectReadOutput(
  text: string,
  maxChars: number,
  context: ToolOutputProjectionContext,
): string {
  const lines = text.split("\n");
  const notice = readContinuationNotice(lines);
  const contentLines =
    notice === undefined ? lines : lines.filter((line) => line !== notice);
  const selected: string[] = [];
  appendSourceLine(selected, context, maxChars);
  const noticeLines =
    notice === undefined ? [] : ["[read continuation]", notice];
  const reservedNoticeLength =
    noticeLines.length === 0 ? 0 : joinedLines(noticeLines).length + 1;
  const contentBudget = Math.max(
    0,
    maxChars - reservedNoticeLength - joinedLines(selected).length - 1,
  );
  let contentLinesAdded = 0;
  for (const line of headLinesWithinBudget(contentLines, contentBudget)) {
    /* v8 ignore next 3: read content lines are preselected against the notice-reserved budget. */
    if (!appendLineWithinBudget(selected, line, maxChars)) {
      break;
    }
    contentLinesAdded++;
  }
  if (contentLinesAdded === 0 && contentLines[0] !== undefined) {
    const remaining = Math.max(0, maxChars - joinedLines(selected).length - 1);
    appendLineWithinBudget(
      selected,
      boundedText(contentLines[0], remaining),
      maxChars,
    );
  }
  for (const line of noticeLines) {
    appendLineWithinBudget(selected, line, maxChars);
  }
  return boundedText(joinedLines(selected), maxChars);
}

function truncationGuidanceLine(
  lines: readonly string[],
  prefix: string,
): string | undefined {
  return lines.findLast((line) => line.startsWith(prefix));
}

function projectListedOutput(options: {
  readonly text: string;
  readonly maxChars: number;
  readonly context: ToolOutputProjectionContext;
  readonly guidancePrefix: string;
}): string {
  const lines = options.text.split("\n");
  const guidance = truncationGuidanceLine(lines, options.guidancePrefix);
  const entryLines =
    guidance === undefined ? lines : lines.filter((line) => line !== guidance);
  const selected: string[] = [];
  appendSourceLine(selected, options.context, options.maxChars);
  const reservedGuidanceLength =
    guidance === undefined ? 0 : guidance.length + 1;
  const entryBudget = Math.max(0, options.maxChars - reservedGuidanceLength);
  for (const line of headLinesWithinBudget(entryLines, entryBudget)) {
    if (!appendLineWithinBudget(selected, line, entryBudget)) {
      break;
    }
  }
  if (guidance !== undefined) {
    appendLineWithinBudget(selected, guidance, options.maxChars);
  }
  return boundedText(joinedLines(selected), options.maxChars);
}

function gitDiffBlocks(
  lines: readonly string[],
): readonly (readonly string[])[] {
  const blocks: string[][] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      if (current.length > 0) {
        blocks.push(current);
      }
      current = [line];
      continue;
    }
    if (current.length > 0) {
      current.push(line);
    }
  }
  if (current.length > 0) {
    blocks.push(current);
  }
  return blocks;
}

interface GitDiffHunk {
  readonly header: string;
  readonly changedLines: readonly string[];
  readonly additions: number;
  readonly deletions: number;
}

interface GitDiffFile {
  readonly path: string;
  readonly hunks: readonly GitDiffHunk[];
  readonly additions: number;
  readonly deletions: number;
}

interface GitDiffHunkPreview {
  readonly lines: readonly string[];
  readonly omittedAdditions: number;
  readonly omittedDeletions: number;
}

function unquoteGitDiffPath(rawPath: string): string {
  if (!rawPath.startsWith('"') || !rawPath.endsWith('"')) {
    return rawPath;
  }
  return rawPath.slice(1, -1).replace(/\\"/gu, '"');
}

function normalizedGitDiffPath(rawPath: string): string {
  const path = unquoteGitDiffPath(rawPath);
  return path.replace(/^[ab]\//u, "");
}

function gitDiffPathToken(
  input: string,
  startIndex: number,
): { readonly token: string; readonly nextIndex: number } | null {
  /* v8 ignore next 3: git_diff headings passed here contain at least one path token. */
  if (startIndex >= input.length) {
    return null;
  }
  if (input[startIndex] !== '"') {
    const endIndex = input.indexOf(" ", startIndex);
    return endIndex === -1
      ? { token: input.slice(startIndex), nextIndex: input.length }
      : { token: input.slice(startIndex, endIndex), nextIndex: endIndex };
  }

  let escaped = false;
  for (let index = startIndex + 1; index < input.length; index++) {
    const char = input[index];
    if (char === "\\" && !escaped) {
      escaped = true;
      continue;
    }
    if (char === '"' && !escaped) {
      return {
        token: input.slice(startIndex, index + 1),
        nextIndex: index + 1,
      };
    }
    escaped = false;
  }
  /* v8 ignore next: malformed quoted git path; fall back to the raw heading. */
  return null;
}

function skipSpaces(input: string, startIndex: number): number {
  let index = startIndex;
  while (input[index] === " ") {
    index++;
  }
  return index;
}

function gitDiffDisplayPath(heading: string): string {
  const prefix = "diff --git ";
  /* v8 ignore next 3: gitDiffBlocks only passes headings with this prefix. */
  if (!heading.startsWith(prefix)) {
    return heading;
  }
  const rest = heading.slice(prefix.length);
  const oldPath = gitDiffPathToken(rest, 0);
  /* v8 ignore next 3: git_diff headings contain the old path token. */
  if (oldPath === null) {
    return heading;
  }
  const newPath = gitDiffPathToken(rest, skipSpaces(rest, oldPath.nextIndex));
  /* v8 ignore next 3: git_diff headings contain the new path token. */
  if (newPath === null) {
    return heading;
  }
  return normalizedGitDiffPath(newPath.token);
}

function isGitDiffChangedLine(line: string): boolean {
  return line.startsWith("+") || line.startsWith("-");
}

function gitDiffChangedLineCount(
  lines: readonly string[],
  prefix: "+" | "-",
): number {
  return lines.filter((line) => line.startsWith(prefix)).length;
}

function gitDiffHunks(block: readonly string[]): readonly GitDiffHunk[] {
  const hunks: GitDiffHunk[] = [];
  for (let index = 0; index < block.length; index++) {
    const header = block[index];
    if (header === undefined || !header.startsWith("@@ ")) {
      continue;
    }
    const body: string[] = [];
    for (let bodyIndex = index + 1; bodyIndex < block.length; bodyIndex++) {
      const line = block[bodyIndex];
      if (line === undefined || line.startsWith("@@ ")) {
        break;
      }
      body.push(line);
    }
    const changedLines = body.filter(isGitDiffChangedLine);
    hunks.push({
      header,
      changedLines,
      additions: gitDiffChangedLineCount(changedLines, "+"),
      deletions: gitDiffChangedLineCount(changedLines, "-"),
    });
  }
  return hunks;
}

function gitDiffFiles(
  blocks: readonly (readonly string[])[],
): readonly GitDiffFile[] {
  const files: GitDiffFile[] = [];
  for (const block of blocks) {
    const heading = block[0];
    /* v8 ignore next 3: gitDiffBlocks only yields non-empty blocks that begin with a diff heading. */
    if (heading === undefined) {
      continue;
    }
    const hunks = gitDiffHunks(block);
    const additions = hunks.reduce((total, hunk) => total + hunk.additions, 0);
    const deletions = hunks.reduce((total, hunk) => total + hunk.deletions, 0);
    files.push({
      path: gitDiffDisplayPath(heading),
      hunks,
      additions,
      deletions,
    });
  }
  return files;
}

function firstChangedLine(
  lines: readonly string[],
  prefix: "+" | "-",
): string | null {
  for (const line of lines) {
    if (line.startsWith(prefix)) {
      return line;
    }
  }
  return null;
}

function gitDiffHunkPreview(hunk: GitDiffHunk): GitDiffHunkPreview {
  const selectedLines: string[] = [];
  const deletion = firstChangedLine(hunk.changedLines, "-");
  if (deletion !== null) {
    selectedLines.push(deletion);
  }
  const addition = firstChangedLine(hunk.changedLines, "+");
  if (addition !== null) {
    selectedLines.push(addition);
  }

  const selectedAdditions = selectedLines.filter((line) =>
    line.startsWith("+"),
  ).length;
  const selectedDeletions = selectedLines.filter((line) =>
    line.startsWith("-"),
  ).length;
  return {
    lines: selectedLines,
    omittedAdditions: hunk.additions - selectedAdditions,
    omittedDeletions: hunk.deletions - selectedDeletions,
  };
}

function hunkOmittedLine(preview: GitDiffHunkPreview): string | null {
  if (preview.omittedAdditions === 0 && preview.omittedDeletions === 0) {
    return null;
  }
  return `[hunk omitted: +${preview.omittedAdditions}/-${preview.omittedDeletions} more lines]`;
}

function omittedHunksLine(hunks: readonly GitDiffHunk[]): string | null {
  if (hunks.length === 0) {
    return null;
  }
  const additions = hunks.reduce((total, hunk) => total + hunk.additions, 0);
  const deletions = hunks.reduce((total, hunk) => total + hunk.deletions, 0);
  const hunkLabel = hunks.length === 1 ? "hunk" : "hunks";
  return `[file omitted: ${hunks.length} more ${hunkLabel}, +${additions}/-${deletions} more lines]`;
}

function gitDiffFilePreviewLines(file: GitDiffFile): readonly string[] {
  const lines = [file.path];
  const firstHunk = file.hunks[0];
  if (firstHunk === undefined) {
    lines.push("[no hunks shown]");
    return lines;
  }
  lines.push(firstHunk.header);
  const preview = gitDiffHunkPreview(firstHunk);
  for (const line of preview.lines) {
    lines.push(line);
  }
  const omittedLine = hunkOmittedLine(preview);
  if (omittedLine !== null) {
    lines.push(omittedLine);
  }
  const fileOmittedLine = omittedHunksLine(file.hunks.slice(1));
  if (fileOmittedLine !== null) {
    lines.push(fileOmittedLine);
  }
  return lines;
}

function projectGitDiffOutput(
  text: string,
  maxChars: number,
  context: ToolOutputProjectionContext,
): string {
  const lines = text.split("\n");
  const blocks = gitDiffBlocks(lines);
  if (blocks.length === 0) {
    return compactLineAware(text, maxChars, context);
  }

  const files = gitDiffFiles(blocks);
  const additions = files.reduce((total, file) => total + file.additions, 0);
  const deletions = files.reduce((total, file) => total + file.deletions, 0);
  const previewLines: string[] = [];
  const sourceLine = sourceLineForToolCall(context);
  /* v8 ignore next 3: valid git_diff tool-result ledgers preserve a matching tool call. */
  if (sourceLine !== null) {
    previewLines.push(sourceLine);
  }
  previewLines.push(
    `files changed: ${files.length}, +${additions}/-${deletions}`,
  );
  for (const file of files) {
    previewLines.push("", ...gitDiffFilePreviewLines(file));
  }
  return boundedText(
    joinedLines(headLinesWithinBudget(previewLines, maxChars)),
    maxChars,
  );
}

function projectToolOutputPreview(
  text: string,
  maxChars: number,
  context: ToolOutputProjectionContext,
): string {
  switch (context.toolName) {
    case "bash":
      return projectBashOutput(text, maxChars, context);
    case "read":
      return projectReadOutput(text, maxChars, context);
    case "grep":
      return projectListedOutput({
        text,
        maxChars,
        context,
        guidancePrefix: "[grep output truncated:",
      });
    case "glob":
      return projectListedOutput({
        text,
        maxChars,
        context,
        guidancePrefix: "[glob output truncated:",
      });
    case "ls":
      return projectListedOutput({
        text,
        maxChars,
        context,
        guidancePrefix: "[ls output truncated:",
      });
    case "git_diff":
      return projectGitDiffOutput(text, maxChars, context);
    case "edit":
    case "write":
    case "apply_patch":
    case "unknown":
      return boundedText(text, maxChars);
  }
}

export function projectCompactedToolOutput(options: {
  readonly text: string;
  readonly maxChars: number;
  readonly context: ToolOutputProjectionContext;
}): ProjectedToolOutput {
  const preview = projectToolOutputPreview(
    options.text,
    options.maxChars,
    options.context,
  );
  return {
    preview,
    omittedChars: projectedOmittedChars(options.text, preview),
  };
}
