import type { ToolCall } from "../../llm/types.ts";
import type { ToolOutputArtifactToolName } from "../tool-output-artifacts.ts";

export interface ToolOutputProjectionContext {
  readonly toolName: ToolOutputArtifactToolName;
  readonly toolCall?: ToolCall;
}

type ToolOutputProjectionPurpose =
  | "artifact-backed-compaction"
  | "summary-input";

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

function appendLinesWithinBudget(
  lines: string[],
  candidateLines: readonly string[],
  maxChars: number,
): boolean {
  const candidate = joinedLines([...lines, ...candidateLines]);
  if (candidate.length <= maxChars) {
    lines.push(...candidateLines);
    return true;
  }
  return false;
}

function appendFirstFittingLine(
  lines: string[],
  candidateLines: readonly string[],
  maxChars: number,
): boolean {
  for (const line of candidateLines) {
    if (appendLineWithinBudget(lines, line, maxChars)) {
      return true;
    }
  }
  return false;
}

function insertLineWithinBudget(
  lines: string[],
  index: number,
  line: string,
  maxChars: number,
): boolean {
  const candidate = joinedLines([
    ...lines.slice(0, index),
    line,
    ...lines.slice(index),
  ]);
  if (candidate.length <= maxChars) {
    lines.splice(index, 0, line);
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
  const parsed = parseBashOutput(lines);
  const selected: string[] = [];
  appendSourceLine(selected, context, maxChars);
  for (const line of parsed.statusLines) {
    appendLineWithinBudget(selected, line, maxChars);
  }
  const streamSummaries = bashStreamSummaries(parsed);
  for (const line of streamSummaries) {
    appendLineWithinBudget(selected, line, maxChars);
  }
  for (const stream of bashDetailStreams(parsed)) {
    appendBashStreamTail({
      lines: selected,
      label: stream.label,
      streamLines: stream.lines,
      maxChars,
    });
  }
  if (
    parsed.stdout.length === 0 &&
    parsed.stderr.length === 0 &&
    parsed.otherLines.length > 0
  ) {
    appendLineWithinBudget(selected, "[bash output tail preview]", maxChars);
    const remaining = Math.max(0, maxChars - joinedLines(selected).length - 1);
    for (const line of tailLinesWithinBudget(parsed.otherLines, remaining)) {
      /* v8 ignore next 3: tail lines are preselected against the exact remaining budget. */
      if (!appendLineWithinBudget(selected, line, maxChars)) {
        break;
      }
    }
  }
  return boundedText(joinedLines(selected), maxChars);
}

interface BashOutputSections {
  readonly statusLines: readonly string[];
  readonly stdout: readonly string[];
  readonly stderr: readonly string[];
  readonly otherLines: readonly string[];
}

interface BashStream {
  readonly label: "stdout" | "stderr";
  readonly lines: readonly string[];
}

function trimTrailingEmptyLines(lines: readonly string[]): readonly string[] {
  const trimmed = [...lines];
  while (trimmed.at(-1) === "") {
    trimmed.pop();
  }
  return trimmed;
}

function parseBashOutput(lines: readonly string[]): BashOutputSections {
  const statusLines: string[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const otherLines: string[] = [];
  let stream: "stdout" | "stderr" | null = null;
  let inStatusPrelude = true;
  for (const line of lines) {
    if (inStatusPrelude) {
      if (
        line === "" ||
        line.startsWith("Command timed out after ") ||
        line.startsWith("Exit code: ") ||
        line.startsWith("Signal: ")
      ) {
        statusLines.push(line);
        continue;
      }
      inStatusPrelude = false;
    }
    if (line === "stdout:") {
      stream = "stdout";
      continue;
    }
    if (line === "stderr:") {
      stream = "stderr";
      continue;
    }
    if (stream === "stdout") {
      stdout.push(line);
      continue;
    }
    if (stream === "stderr") {
      stderr.push(line);
      continue;
    }
    otherLines.push(line);
  }
  return {
    statusLines,
    stdout: trimTrailingEmptyLines(stdout),
    stderr: trimTrailingEmptyLines(stderr),
    otherLines: trimTrailingEmptyLines(otherLines),
  };
}

function bashStreamSummaries(parsed: BashOutputSections): readonly string[] {
  const lines: string[] = [];
  if (parsed.stdout.length > 0) {
    lines.push(`stdout: ${unitLabel(parsed.stdout.length, "line", "lines")}`);
  }
  if (parsed.stderr.length > 0) {
    lines.push(`stderr: ${unitLabel(parsed.stderr.length, "line", "lines")}`);
  }
  return lines;
}

function bashDetailStreams(parsed: BashOutputSections): readonly BashStream[] {
  const streams: BashStream[] = [];
  if (parsed.stderr.length > 0) {
    streams.push({ label: "stderr", lines: parsed.stderr });
  }
  if (parsed.stdout.length > 0) {
    streams.push({ label: "stdout", lines: parsed.stdout });
  }
  return streams;
}

function appendBashStreamTail(options: {
  readonly lines: string[];
  readonly label: "stdout" | "stderr";
  readonly streamLines: readonly string[];
  readonly maxChars: number;
}): void {
  const beforeStream = [...options.lines];
  if (
    !appendLineWithinBudget(
      options.lines,
      `${options.label} tail:`,
      options.maxChars,
    )
  ) {
    return;
  }
  const remaining = Math.max(
    0,
    options.maxChars - joinedLines(options.lines).length - 1,
  );
  const tailLines = tailLinesWithinBudget(options.streamLines, remaining);
  if (tailLines.length === 0) {
    options.lines.splice(0, options.lines.length, ...beforeStream);
    return;
  }
  const omittedLines = Math.max(
    0,
    options.streamLines.length - tailLines.length,
  );
  if (omittedLines > 0) {
    appendLineWithinBudget(
      options.lines,
      `... omitted from ${options.label} preview: ${unitLabel(
        omittedLines,
        "line",
        "lines",
      )}`,
      options.maxChars,
    );
  }
  for (const line of tailLines) {
    if (!appendLineWithinBudget(options.lines, line, options.maxChars)) {
      break;
    }
  }
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

function listedOutputNoticeLines(
  lines: readonly string[],
  prefixes: readonly string[],
): {
  readonly required: readonly string[];
  readonly optional: readonly string[];
} {
  const notices: { readonly line: string; readonly priority: number }[] = [];
  for (const line of lines) {
    const priority = prefixes.findIndex((prefix) => line.startsWith(prefix));
    if (priority !== -1) {
      notices.push({ line, priority });
    }
  }
  if (notices.length === 0) {
    return { required: [], optional: [] };
  }
  const requiredPriority = notices.reduce(
    (lowest, notice) => Math.min(lowest, notice.priority),
    Number.POSITIVE_INFINITY,
  );
  const required = notices
    .filter((notice) => notice.priority === requiredPriority)
    .map((notice) => notice.line);
  const optional = notices
    .filter((notice) => notice.priority !== requiredPriority)
    .map((notice) => notice.line);
  return { required, optional };
}

function projectListedOutput(options: {
  readonly text: string;
  readonly maxChars: number;
  readonly context: ToolOutputProjectionContext;
  readonly noticePrefixes: readonly string[];
}): string {
  const lines = options.text.split("\n");
  const noticeLines = listedOutputNoticeLines(lines, options.noticePrefixes);
  const noticeLineSet = new Set([
    ...noticeLines.required,
    ...noticeLines.optional,
  ]);
  const entryLines = lines.filter((line) => !noticeLineSet.has(line));
  const selected: string[] = [];
  appendSourceLine(selected, options.context, options.maxChars);
  const reservedNoticeLength =
    noticeLines.required.length === 0
      ? 0
      : joinedLines(noticeLines.required).length + 1;
  const entryBudget = Math.max(0, options.maxChars - reservedNoticeLength);
  for (const line of headLinesWithinBudget(entryLines, entryBudget)) {
    if (!appendLineWithinBudget(selected, line, entryBudget)) {
      break;
    }
  }
  for (const line of noticeLines.required) {
    appendLineWithinBudget(selected, line, options.maxChars);
  }
  for (const line of noticeLines.optional) {
    appendLineWithinBudget(selected, line, options.maxChars);
  }
  return boundedText(joinedLines(selected), options.maxChars);
}

type GitDiffFileStatus =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "copied"
  | "binary"
  | "mode-only";

interface GitDiffHunk {
  readonly header: string;
  readonly changedLines: readonly string[];
  readonly additions: number;
  readonly deletions: number;
}

interface GitDiffBlock {
  readonly section: string | null;
  readonly lines: readonly string[];
}

interface GitDiffFile {
  readonly path: string;
  readonly section: string | null;
  readonly status: GitDiffFileStatus;
  readonly hunks: readonly GitDiffHunk[];
  readonly additions: number;
  readonly deletions: number;
}

interface GitDiffParseResult {
  readonly preludeLines: readonly string[];
  readonly files: readonly GitDiffFile[];
}

interface GitDiffOmittedDetails {
  readonly files: number;
  readonly hunks: number;
  readonly additions: number;
  readonly deletions: number;
}

const EMPTY_GIT_DIFF_OMITTED_DETAILS: GitDiffOmittedDetails = {
  files: 0,
  hunks: 0,
  additions: 0,
  deletions: 0,
};

function unitLabel(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function isGitDiffSectionLine(line: string): boolean {
  return (
    line === "Unstaged changes:" ||
    line === "Staged changes:" ||
    line.startsWith("Untracked changes (")
  );
}

function gitDiffBlocksWithPrelude(lines: readonly string[]): {
  readonly preludeLines: readonly string[];
  readonly blocks: readonly GitDiffBlock[];
} {
  const preludeLines: string[] = [];
  const blocks: GitDiffBlock[] = [];
  let currentSection: string | null = null;
  let current: string[] = [];
  for (const line of lines) {
    if (isGitDiffSectionLine(line)) {
      if (current.length > 0) {
        blocks.push({ section: currentSection, lines: current });
        current = [];
      }
      currentSection = line;
      continue;
    }
    if (line.startsWith("diff --git ")) {
      if (current.length > 0) {
        blocks.push({ section: currentSection, lines: current });
      }
      current = [line];
      continue;
    }
    if (current.length > 0) {
      current.push(line);
      continue;
    }
    if (line !== "") {
      preludeLines.push(line);
    }
  }
  if (current.length > 0) {
    blocks.push({ section: currentSection, lines: current });
  }
  return { preludeLines, blocks };
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
  /* v8 ignore next 3: gitDiffBlocksWithPrelude only passes headings with this prefix. */
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

function isGitDiffChangedBodyLine(line: string): boolean {
  return line.startsWith("+") || line.startsWith("-");
}

function gitDiffChangedLineCount(
  lines: readonly string[],
  prefix: "+" | "-",
): number {
  return lines.filter((line) => line.startsWith(prefix)).length;
}

function gitDiffFileStatus(
  block: readonly string[],
  hunks: readonly GitDiffHunk[],
): GitDiffFileStatus {
  const firstHunkIndex = block.findIndex((line) => line.startsWith("@@ "));
  const metadataLines =
    firstHunkIndex === -1 ? block : block.slice(0, firstHunkIndex);
  const hasBinary = metadataLines.some(
    (line) =>
      line.startsWith("Binary files ") ||
      line === "GIT binary patch" ||
      line.startsWith("literal ") ||
      line.startsWith("delta "),
  );
  if (hasBinary) {
    return "binary";
  }
  const hasRename = metadataLines.some(
    (line) => line.startsWith("rename from ") || line.startsWith("rename to "),
  );
  if (hasRename) {
    return "renamed";
  }
  const hasCopy = metadataLines.some(
    (line) => line.startsWith("copy from ") || line.startsWith("copy to "),
  );
  if (hasCopy) {
    return "copied";
  }
  const hasNewFile = metadataLines.some(
    (line) => line.startsWith("new file mode ") || line === "--- /dev/null",
  );
  if (hasNewFile) {
    return "added";
  }
  const hasDeletedFile = metadataLines.some(
    (line) => line.startsWith("deleted file mode ") || line === "+++ /dev/null",
  );
  if (hasDeletedFile) {
    return "deleted";
  }
  const hasModeChange = metadataLines.some(
    (line) => line.startsWith("old mode ") || line.startsWith("new mode "),
  );
  if (hasModeChange && hunks.length === 0) {
    return "mode-only";
  }
  return "modified";
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
    const changedLines = body.filter(isGitDiffChangedBodyLine);
    hunks.push({
      header,
      changedLines,
      additions: gitDiffChangedLineCount(changedLines, "+"),
      deletions: gitDiffChangedLineCount(changedLines, "-"),
    });
  }
  return hunks;
}

function gitDiffFiles(blocks: readonly GitDiffBlock[]): readonly GitDiffFile[] {
  const files: GitDiffFile[] = [];
  for (const block of blocks) {
    const heading = block.lines[0];
    /* v8 ignore next 3: gitDiffBlocksWithPrelude only yields non-empty blocks that begin with a diff heading. */
    if (heading === undefined) {
      continue;
    }
    const hunks = gitDiffHunks(block.lines);
    const additions = hunks.reduce((total, hunk) => total + hunk.additions, 0);
    const deletions = hunks.reduce((total, hunk) => total + hunk.deletions, 0);
    files.push({
      path: gitDiffDisplayPath(heading),
      section: block.section,
      status: gitDiffFileStatus(block.lines, hunks),
      hunks,
      additions,
      deletions,
    });
  }
  return files;
}

function parseGitDiffOutput(lines: readonly string[]): GitDiffParseResult {
  const parsed = gitDiffBlocksWithPrelude(lines);
  return {
    preludeLines: parsed.preludeLines,
    files: gitDiffFiles(parsed.blocks),
  };
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

function gitDiffChangedLineOmissionLine(
  additions: number,
  deletions: number,
): string | null {
  if (additions === 0 && deletions === 0) {
    return null;
  }
  return `... omitted within hunk: +${additions}/-${deletions} changed lines`;
}

function gitDiffHunkSnippetLines(
  file: GitDiffFile,
  hunk: GitDiffHunk,
): readonly string[] {
  const lines = [`Snippet: ${file.path} ${hunk.header}`];
  const deletion = firstChangedLine(hunk.changedLines, "-");
  if (deletion !== null) {
    lines.push(deletion);
  }
  const addition = firstChangedLine(hunk.changedLines, "+");
  if (addition !== null) {
    lines.push(addition);
  }

  const selectedAdditions = lines.filter((line) => line.startsWith("+")).length;
  const selectedDeletions = lines.filter((line) => line.startsWith("-")).length;
  const omissionLine = gitDiffChangedLineOmissionLine(
    hunk.additions - selectedAdditions,
    hunk.deletions - selectedDeletions,
  );
  if (omissionLine !== null) {
    lines.push(omissionLine);
  }
  return lines;
}

function gitDiffHunkBodyOmissionLine(
  file: GitDiffFile,
  hunk: GitDiffHunk,
  purpose: ToolOutputProjectionPurpose,
): readonly string[] {
  const replacementGuidance =
    purpose === "summary-input"
      ? "full old/new lines omitted from summary input"
      : "inspect artifact for full old/new lines";
  const changedGuidance =
    purpose === "summary-input"
      ? "full changed lines omitted from summary input"
      : "inspect artifact for full changed lines";
  if (hunk.additions > 0 && hunk.deletions > 0) {
    return [
      `Snippet omitted: ${file.path} ${hunk.header} replacement hunk omitted from preview; +${hunk.additions}/-${hunk.deletions}; ${replacementGuidance}`,
      `Snippet omitted: ${file.path} ${hunk.header}; +${hunk.additions}/-${hunk.deletions}`,
      `Snippet omitted: +${hunk.additions}/-${hunk.deletions}`,
    ];
  }
  if (hunk.additions > 0) {
    return [
      `Snippet omitted: ${file.path} ${hunk.header} add-only hunk omitted from preview; +${hunk.additions}/-${hunk.deletions}; ${changedGuidance}`,
      `Snippet omitted: ${file.path} ${hunk.header}; +${hunk.additions}/-${hunk.deletions}`,
      `Snippet omitted: +${hunk.additions}/-${hunk.deletions}`,
    ];
  }
  return [
    `Snippet omitted: ${file.path} ${hunk.header} delete-only hunk omitted from preview; +${hunk.additions}/-${hunk.deletions}; ${changedGuidance}`,
    `Snippet omitted: ${file.path} ${hunk.header}; +${hunk.additions}/-${hunk.deletions}`,
    `Snippet omitted: +${hunk.additions}/-${hunk.deletions}`,
  ];
}

function gitDiffFileSummaryLine(file: GitDiffFile): string {
  return `- ${file.path}: ${file.status}, ${unitLabel(
    file.hunks.length,
    "hunk",
    "hunks",
  )}, +${file.additions}/-${file.deletions}`;
}

function mergeGitDiffOmittedDetails(
  left: GitDiffOmittedDetails,
  right: GitDiffOmittedDetails,
): GitDiffOmittedDetails {
  return {
    files: left.files + right.files,
    hunks: left.hunks + right.hunks,
    additions: left.additions + right.additions,
    deletions: left.deletions + right.deletions,
  };
}

function omittedDetailsForFile(file: GitDiffFile): GitDiffOmittedDetails {
  return {
    files: 1,
    hunks: file.hunks.length,
    additions: file.additions,
    deletions: file.deletions,
  };
}

function omittedDetailsForSummarizedFile(
  file: GitDiffFile,
): GitDiffOmittedDetails {
  return {
    files: 0,
    hunks: file.hunks.length,
    additions: file.additions,
    deletions: file.deletions,
  };
}

function omittedDetailsForHunk(hunk: GitDiffHunk): GitDiffOmittedDetails {
  return {
    files: 0,
    hunks: 1,
    additions: hunk.additions,
    deletions: hunk.deletions,
  };
}

function omittedDetailsLines(
  details: GitDiffOmittedDetails,
): readonly string[] {
  if (
    details.files === 0 &&
    details.hunks === 0 &&
    details.additions === 0 &&
    details.deletions === 0
  ) {
    return [];
  }
  const parts: string[] = [];
  if (details.files > 0) {
    parts.push(unitLabel(details.files, "file", "files"));
  }
  if (details.hunks > 0) {
    parts.push(unitLabel(details.hunks, "hunk", "hunks"));
  }
  if (details.additions > 0 || details.deletions > 0) {
    parts.push(`+${details.additions}/-${details.deletions} changed lines`);
  }
  const summary = parts.join(", ");
  return [
    `... details omitted from preview: ${summary}`,
    `... details omitted: ${summary}`,
    `... omitted: ${summary}`,
  ];
}

function hasGitDiffOmittedDetails(details: GitDiffOmittedDetails): boolean {
  return (
    details.files > 0 ||
    details.hunks > 0 ||
    details.additions > 0 ||
    details.deletions > 0
  );
}

function appendGitDiffHunkPreview(options: {
  readonly lines: string[];
  readonly file: GitDiffFile;
  readonly hunk: GitDiffHunk;
  readonly maxChars: number;
  readonly purpose: ToolOutputProjectionPurpose;
}): GitDiffOmittedDetails {
  const snippetLines = gitDiffHunkSnippetLines(options.file, options.hunk);
  if (appendLinesWithinBudget(options.lines, snippetLines, options.maxChars)) {
    return EMPTY_GIT_DIFF_OMITTED_DETAILS;
  }
  appendFirstFittingLine(
    options.lines,
    gitDiffHunkBodyOmissionLine(options.file, options.hunk, options.purpose),
    options.maxChars,
  );
  return omittedDetailsForHunk(options.hunk);
}

function projectGitDiffOutput(
  text: string,
  maxChars: number,
  context: ToolOutputProjectionContext,
  purpose: ToolOutputProjectionPurpose,
): string {
  const lines = text.split("\n");
  const parsed = parseGitDiffOutput(lines);
  if (parsed.files.length === 0) {
    return compactLineAware(text, maxChars, context);
  }

  const additions = parsed.files.reduce(
    (total, file) => total + file.additions,
    0,
  );
  const deletions = parsed.files.reduce(
    (total, file) => total + file.deletions,
    0,
  );
  const hunkCount = parsed.files.reduce(
    (total, file) => total + file.hunks.length,
    0,
  );
  const previewLines: string[] = [];
  appendFirstFittingLine(
    previewLines,
    [
      `git_diff ${
        purpose === "summary-input" ? "summary input" : "compacted"
      } preview: ${unitLabel(
        parsed.files.length,
        "file",
        "files",
      )}, ${unitLabel(
        hunkCount,
        "hunk",
        "hunks",
      )}, +${additions}/-${deletions}; ${
        purpose === "summary-input"
          ? "full output omitted from summary input"
          : "full output artifact is referenced below"
      }`,
      `git_diff ${
        purpose === "summary-input" ? "summary input" : "compacted"
      } preview: ${unitLabel(
        parsed.files.length,
        "file",
        "files",
      )}, ${unitLabel(hunkCount, "hunk", "hunks")}, +${additions}/-${deletions}`,
      `git_diff compacted preview: ${unitLabel(
        parsed.files.length,
        "file",
        "files",
      )}, ${unitLabel(hunkCount, "hunk", "hunks")}, +${additions}/-${deletions}`,
      `git_diff: ${unitLabel(parsed.files.length, "file", "files")}, ${unitLabel(
        hunkCount,
        "hunk",
        "hunks",
      )}, +${additions}/-${deletions}`,
    ],
    maxChars,
  );
  for (const line of parsed.preludeLines) {
    appendLineWithinBudget(previewLines, line, maxChars);
  }

  const summarizedFiles: GitDiffFile[] = [];
  let omittedDetails = EMPTY_GIT_DIFF_OMITTED_DETAILS;
  if (appendLineWithinBudget(previewLines, "Files:", maxChars)) {
    let currentSection: string | null = null;
    let sectionPrintedForCurrentGroup = false;
    for (const file of parsed.files) {
      if (file.section !== currentSection) {
        currentSection = file.section;
        sectionPrintedForCurrentGroup = false;
      }
      const summaryLines =
        currentSection === null || sectionPrintedForCurrentGroup
          ? [gitDiffFileSummaryLine(file)]
          : [currentSection, gitDiffFileSummaryLine(file)];
      if (appendLinesWithinBudget(previewLines, summaryLines, maxChars)) {
        sectionPrintedForCurrentGroup = currentSection !== null;
        summarizedFiles.push(file);
        continue;
      }
      omittedDetails = mergeGitDiffOmittedDetails(
        omittedDetails,
        omittedDetailsForFile(file),
      );
    }
  } else {
    omittedDetails = parsed.files.reduce(
      (total, file) =>
        mergeGitDiffOmittedDetails(total, omittedDetailsForFile(file)),
      EMPTY_GIT_DIFF_OMITTED_DETAILS,
    );
  }

  if (summarizedFiles.length > 0) {
    appendLineWithinBudget(previewLines, "", maxChars);
  }
  let detailsClosed = false;
  for (const file of summarizedFiles) {
    if (detailsClosed) {
      omittedDetails = mergeGitDiffOmittedDetails(
        omittedDetails,
        omittedDetailsForSummarizedFile(file),
      );
      continue;
    }
    for (const hunk of file.hunks) {
      const hunkOmittedDetails = appendGitDiffHunkPreview({
        lines: previewLines,
        file,
        hunk,
        maxChars,
        purpose,
      });
      omittedDetails = mergeGitDiffOmittedDetails(
        omittedDetails,
        hunkOmittedDetails,
      );
      if (hasGitDiffOmittedDetails(hunkOmittedDetails)) {
        detailsClosed = true;
        const hunkIndex = file.hunks.indexOf(hunk);
        for (const remainingHunk of file.hunks.slice(hunkIndex + 1)) {
          omittedDetails = mergeGitDiffOmittedDetails(
            omittedDetails,
            omittedDetailsForHunk(remainingHunk),
          );
        }
        break;
      }
    }
  }

  appendFirstFittingLine(
    previewLines,
    omittedDetailsLines(omittedDetails),
    maxChars,
  );
  const sourceLine = sourceLineForToolCall(context);
  /* v8 ignore next 3: valid git_diff tool-result ledgers preserve a matching tool call. */
  if (sourceLine !== null) {
    insertLineWithinBudget(previewLines, 1, sourceLine, maxChars);
  }
  return boundedText(joinedLines(previewLines), maxChars);
}

function projectToolOutputPreview(
  text: string,
  maxChars: number,
  context: ToolOutputProjectionContext,
  purpose: ToolOutputProjectionPurpose,
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
        noticePrefixes: [
          "[grep warning: some paths were inaccessible",
          "[grep output truncated:",
        ],
      });
    case "glob":
      return projectListedOutput({
        text,
        maxChars,
        context,
        noticePrefixes: ["[glob output truncated:"],
      });
    case "ls":
      return projectListedOutput({
        text,
        maxChars,
        context,
        noticePrefixes: ["[ls output truncated:"],
      });
    case "git_diff":
      return projectGitDiffOutput(text, maxChars, context, purpose);
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
  readonly purpose?: ToolOutputProjectionPurpose;
}): ProjectedToolOutput {
  const preview = projectToolOutputPreview(
    options.text,
    options.maxChars,
    options.context,
    options.purpose ?? "artifact-backed-compaction",
  );
  return {
    preview,
    omittedChars: projectedOmittedChars(options.text, preview),
  };
}
