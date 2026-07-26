export type GitDiffFileStatus =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "copied"
  | "binary"
  | "mode-only"
  | "conflicted";

export type GitDiffScope =
  | { readonly kind: "unscoped" }
  | { readonly kind: "unstaged" }
  | { readonly kind: "staged" }
  | { readonly kind: "untracked"; readonly path: string }
  | { readonly kind: "comparison"; readonly label: string };

export type GitDiffLine =
  | { readonly kind: "metadata"; readonly text: string }
  | { readonly kind: "hunk"; readonly text: string }
  | { readonly kind: "context"; readonly text: string }
  | { readonly kind: "addition"; readonly text: string }
  | { readonly kind: "deletion"; readonly text: string }
  | { readonly kind: "conflict"; readonly text: string }
  | { readonly kind: "notice"; readonly text: string };

export type GitDiffHunk =
  | {
      readonly kind: "ordinary";
      readonly header: string;
      readonly changedLines: readonly string[];
      readonly additions: number;
      readonly deletions: number;
    }
  | {
      readonly kind: "combined";
      readonly header: string;
      readonly changedLines: readonly string[];
      readonly additions: number;
      readonly deletions: number;
    };

export interface GitDiffFile {
  readonly heading: string;
  readonly path: string;
  readonly scope: GitDiffScope;
  readonly status: GitDiffFileStatus;
  readonly lines: readonly GitDiffLine[];
  readonly hunks: readonly GitDiffHunk[];
  readonly additions: number;
  readonly deletions: number;
}

type GitDiffCompleteness =
  | { readonly kind: "complete" }
  | { readonly kind: "truncated" };

export interface GitDiffDocument {
  readonly text: string;
  readonly preludeLines: readonly string[];
  readonly files: readonly GitDiffFile[];
  readonly changedFileCount: number;
  readonly conflictedFileCount: number;
  readonly additions: number;
  readonly deletions: number;
  readonly completeness: GitDiffCompleteness;
}

interface GitDiffBlock {
  readonly kind: "ordinary" | "combined" | "unmerged";
  readonly scope: GitDiffScope;
  readonly heading: string;
  readonly path: string;
  readonly lines: readonly string[];
}

type GitDiffHeading =
  | { readonly kind: "ordinary"; readonly path: string }
  | { readonly kind: "combined"; readonly path: string }
  | { readonly kind: "unmerged"; readonly path: string };

function gitDiffHeading(line: string): GitDiffHeading | null {
  const ordinaryPrefix = "diff --git ";
  if (line.startsWith(ordinaryPrefix)) {
    const pathSpec = line.slice(ordinaryPrefix.length);
    const oldPath = gitDiffPathToken(pathSpec, 0);
    if (oldPath === null) {
      return { kind: "ordinary", path: line };
    }
    const newPath = gitDiffPathToken(
      pathSpec,
      skipSpaces(pathSpec, oldPath.nextIndex),
    );
    return {
      kind: "ordinary",
      path: newPath === null ? line : normalizedGitDiffPath(newPath.token),
    };
  }
  for (const prefix of ["diff --cc ", "diff --combined "]) {
    if (line.startsWith(prefix)) {
      return {
        kind: "combined",
        path: unquoteGitDiffPath(line.slice(prefix.length)),
      };
    }
  }
  const unmergedPrefix = "* Unmerged path ";
  if (line.startsWith(unmergedPrefix)) {
    return {
      kind: "unmerged",
      path: unquoteGitDiffPath(line.slice(unmergedPrefix.length)),
    };
  }
  return null;
}

function gitDiffScope(line: string): GitDiffScope | null {
  if (line === "Unstaged changes:") {
    return { kind: "unstaged" };
  }
  if (line === "Staged changes:") {
    return { kind: "staged" };
  }
  const untrackedPrefix = "Untracked changes (";
  const untrackedSuffix = "):";
  if (line.startsWith(untrackedPrefix) && line.endsWith(untrackedSuffix)) {
    const encodedPath = line.slice(
      untrackedPrefix.length,
      -untrackedSuffix.length,
    );
    const path: unknown = JSON.parse(encodedPath);
    if (typeof path === "string") {
      return { kind: "untracked", path };
    }
  }
  if (line.startsWith("Ref comparison (") && line.endsWith("):")) {
    return { kind: "comparison", label: line.slice(0, -1) };
  }
  return null;
}

export function gitDiffScopeLabel(scope: GitDiffScope): string {
  switch (scope.kind) {
    case "unscoped":
      return "Changes";
    case "unstaged":
      return "Unstaged";
    case "staged":
      return "Staged";
    case "untracked":
      return "Untracked";
    case "comparison":
      return scope.label;
  }
}

export function gitDiffScopeHeading(scope: GitDiffScope): string | null {
  switch (scope.kind) {
    case "unscoped":
      return null;
    case "unstaged":
      return "Unstaged changes:";
    case "staged":
      return "Staged changes:";
    case "untracked":
      return `Untracked changes (${JSON.stringify(scope.path)}):`;
    case "comparison":
      return `${scope.label}:`;
  }
}

function gitDiffBlocksWithPrelude(lines: readonly string[]): {
  readonly preludeLines: readonly string[];
  readonly blocks: readonly GitDiffBlock[];
} {
  const preludeLines: string[] = [];
  const blocks: GitDiffBlock[] = [];
  let currentScope: GitDiffScope = { kind: "unscoped" };
  let current: {
    readonly kind: "ordinary" | "combined" | "unmerged";
    readonly scope: GitDiffScope;
    readonly heading: string;
    readonly path: string;
    readonly lines: string[];
  } | null = null;
  for (const line of lines) {
    const scope = gitDiffScope(line);
    if (scope !== null) {
      if (current !== null) {
        blocks.push(current);
        current = null;
      }
      currentScope = scope;
      continue;
    }
    const heading = gitDiffHeading(line);
    if (heading !== null) {
      if (current !== null) {
        blocks.push(current);
      }
      current = {
        kind: heading.kind,
        scope: currentScope,
        heading: line,
        path: heading.path,
        lines: [line],
      };
      continue;
    }
    if (current !== null) {
      current.lines.push(line);
      continue;
    }
    if (line !== "") {
      preludeLines.push(line);
    }
  }
  if (current !== null) {
    blocks.push(current);
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
  return null;
}

function skipSpaces(input: string, startIndex: number): number {
  let index = startIndex;
  while (input[index] === " ") {
    index++;
  }
  return index;
}

function gitDiffDisplayPath(block: GitDiffBlock): string {
  return block.scope.kind === "untracked" ? block.scope.path : block.path;
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
  block: GitDiffBlock,
  hunks: readonly GitDiffHunk[],
): GitDiffFileStatus {
  if (block.kind !== "ordinary") {
    return "conflicted";
  }
  const firstHunkIndex = block.lines.findIndex((line) =>
    line.startsWith("@@ "),
  );
  const metadataLines =
    firstHunkIndex === -1 ? block.lines : block.lines.slice(0, firstHunkIndex);
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

function isGitDiffHunkHeader(line: string, block: GitDiffBlock): boolean {
  switch (block.kind) {
    case "ordinary":
      return line.startsWith("@@ ");
    case "combined":
      return /^@{3,} /u.test(line);
    case "unmerged":
      return false;
  }
}

function combinedParentCount(header: string): number {
  let markerCount = 0;
  while (header[markerCount] === "@") {
    markerCount++;
  }
  return markerCount - 1;
}

type CombinedDiffChange = "addition" | "deletion";

function combinedDiffChange(
  line: string,
  parentCount: number,
): CombinedDiffChange | null {
  const prefix = line.slice(0, parentCount);
  if (prefix.includes("+")) {
    return "addition";
  }
  return prefix.includes("-") ? "deletion" : null;
}

function gitDiffHunk(
  kind: "ordinary" | "combined",
  header: string,
  body: readonly string[],
): GitDiffHunk {
  if (kind === "ordinary") {
    const changedLines = body.filter(isGitDiffChangedBodyLine);
    return {
      kind,
      header,
      changedLines,
      additions: gitDiffChangedLineCount(changedLines, "+"),
      deletions: gitDiffChangedLineCount(changedLines, "-"),
    };
  }

  const changes = body
    .map((line) => ({
      line,
      change: combinedDiffChange(line, combinedParentCount(header)),
    }))
    .filter(
      (
        entry,
      ): entry is {
        readonly line: string;
        readonly change: CombinedDiffChange;
      } => entry.change !== null,
    );
  return {
    kind,
    header,
    changedLines: changes.map((entry) => entry.line),
    additions: changes.filter((entry) => entry.change === "addition").length,
    deletions: changes.filter((entry) => entry.change === "deletion").length,
  };
}

function gitDiffHunks(block: GitDiffBlock): readonly GitDiffHunk[] {
  if (block.kind === "unmerged") {
    return [];
  }

  const hunks: GitDiffHunk[] = [];
  let currentHeader: string | null = null;
  let currentBody: string[] = [];
  for (const line of block.lines.slice(1)) {
    if (isGitDiffHunkHeader(line, block)) {
      if (currentHeader !== null) {
        hunks.push(gitDiffHunk(block.kind, currentHeader, currentBody));
      }
      currentHeader = line;
      currentBody = [];
    } else if (currentHeader !== null) {
      currentBody.push(line);
    }
  }
  if (currentHeader !== null) {
    hunks.push(gitDiffHunk(block.kind, currentHeader, currentBody));
  }
  return hunks;
}

function gitDiffLines(block: GitDiffBlock): readonly GitDiffLine[] {
  const lines: GitDiffLine[] = [];
  let insideHunk = false;
  let combinedParents = 0;
  for (const text of block.lines.slice(1)) {
    if (isGitDiffHunkHeader(text, block)) {
      insideHunk = true;
      combinedParents =
        block.kind === "combined" ? combinedParentCount(text) : 0;
      lines.push({ kind: "hunk", text });
    } else if (text.startsWith("[git_diff ")) {
      lines.push({ kind: "notice", text });
    } else if (
      block.kind === "combined" &&
      insideHunk &&
      combinedDiffChange(text, combinedParents) !== null
    ) {
      lines.push({ kind: "conflict", text });
    } else if (insideHunk && text.startsWith("+")) {
      lines.push({ kind: "addition", text });
    } else if (insideHunk && text.startsWith("-")) {
      lines.push({ kind: "deletion", text });
    } else if (
      insideHunk &&
      (text.startsWith(" ") || text === "\\ No newline at end of file")
    ) {
      lines.push({ kind: "context", text });
    } else {
      lines.push({ kind: "metadata", text });
    }
  }
  return lines;
}

function gitDiffFiles(blocks: readonly GitDiffBlock[]): readonly GitDiffFile[] {
  const combinedPaths = new Set(
    blocks
      .filter((block) => block.kind === "combined")
      .map((block) => block.path),
  );
  const selectedUnmergedPaths = new Set<string>();
  const selectedBlocks = blocks.filter((block) => {
    if (block.kind !== "unmerged") {
      return true;
    }
    if (
      combinedPaths.has(block.path) ||
      selectedUnmergedPaths.has(block.path)
    ) {
      return false;
    }
    selectedUnmergedPaths.add(block.path);
    return true;
  });

  return selectedBlocks.map((block) => {
    const hunks = gitDiffHunks(block);
    const additions = hunks.reduce((total, hunk) => total + hunk.additions, 0);
    const deletions = hunks.reduce((total, hunk) => total + hunk.deletions, 0);
    return {
      heading: block.heading,
      path: gitDiffDisplayPath(block),
      scope: block.scope,
      status: gitDiffFileStatus(block, hunks),
      lines: gitDiffLines(block),
      hunks,
      additions,
      deletions,
    };
  });
}

export function parseGitDiffOutput(
  text: string,
  sourceTruncated: boolean,
): GitDiffDocument {
  const parsed = gitDiffBlocksWithPrelude(text.split("\n"));
  const files = gitDiffFiles(parsed.blocks);
  return {
    text,
    preludeLines: parsed.preludeLines,
    files,
    changedFileCount: new Set(files.map((file) => file.path)).size,
    conflictedFileCount: new Set(
      files
        .filter((file) => file.status === "conflicted")
        .map((file) => file.path),
    ).size,
    additions: files.reduce((total, file) => total + file.additions, 0),
    deletions: files.reduce((total, file) => total + file.deletions, 0),
    completeness: sourceTruncated
      ? { kind: "truncated" }
      : { kind: "complete" },
  };
}
