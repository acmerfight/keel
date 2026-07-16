import { readdirSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { KeelError } from "../core/error.ts";
import { hasIgnoredPathSegment } from "./file-search.ts";
import { limitCountedOutput } from "./output-limit.ts";
import { createProjectIgnorePolicy } from "./project-ignore.ts";
import type { ToolResult } from "./types.ts";
import { isInsideWorkspace, resolveWorkspaceTarget } from "./workspace-path.ts";

const DEFAULT_LS_LIMIT = 200;
const MAX_LS_LIMIT = 1000;
const NEXT_LINE = String.fromCharCode(0x85);
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);

export interface LsOptions {
  readonly path?: string;
  readonly limit?: number;
  readonly hiddenPaths?: readonly string[];
}

interface LsEntry {
  readonly name: string;
  readonly isDirectory: boolean;
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LS_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LS_LIMIT) {
    throw new KeelError(
      "tool_invalid_ls_options",
      `ls failed: limit must be a positive integer up to ${MAX_LS_LIMIT}`,
      `Use a positive integer no greater than ${MAX_LS_LIMIT}.`,
    );
  }
  return limit;
}

function formatLsOutput(
  entries: readonly LsEntry[],
  limit: number,
): ToolResult {
  if (entries.length === 0) {
    return { content: "(empty directory)" };
  }

  const limitedEntries = limitCountedOutput(entries, limit);
  const lines = limitedEntries.items.map(formatLsEntry);
  if (limitedEntries.truncated) {
    const guidance =
      limit >= MAX_LS_LIMIT
        ? "Narrow the path to see more."
        : "Narrow the path or increase limit to see more.";
    lines.push(
      `[ls output truncated: showing first ${limitedEntries.items.length} entries. ${guidance}]`,
    );
  }
  return {
    content: lines.join("\n"),
    ...(limitedEntries.truncated ? { sourceTruncated: true } : {}),
  };
}

function formatLsEntry(entry: LsEntry): string {
  const name = hasUnsafeEntryNameChars(entry.name)
    ? escapeUnsafeEntryName(entry.name)
    : entry.name;
  return entry.isDirectory ? `${name}/` : name;
}

function escapeUnsafeEntryName(name: string): string {
  return JSON.stringify(name)
    .split(NEXT_LINE)
    .join("\\u0085")
    .split(LINE_SEPARATOR)
    .join("\\u2028")
    .split(PARAGRAPH_SEPARATOR)
    .join("\\u2029");
}

function hasUnsafeEntryNameChars(name: string): boolean {
  for (let index = 0; index < name.length; index++) {
    const code = name.charCodeAt(index);
    if (
      code <= 0x1f ||
      code === 0x7f ||
      code === 0x85 ||
      code === 0x2028 ||
      code === 0x2029
    ) {
      return true;
    }
  }
  return false;
}

function sortLsEntries(entries: readonly LsEntry[]): LsEntry[] {
  return [...entries].sort((left, right) => {
    if (left.isDirectory !== right.isDirectory) {
      return left.isDirectory ? -1 : 1;
    }
    if (left.name < right.name) return -1;
    if (left.name > right.name) return 1;
    // a single directory cannot contain duplicate entry names.
    return 0;
  });
}

export function executeLs(
  workspace: string,
  options: LsOptions = {},
): ToolResult {
  const limit = normalizeLimit(options.limit);
  const requestedDisplayPath = options.path ?? ".";
  const { workspacePath, requestedPath, targetPath } = resolveWorkspaceTarget(
    workspace,
    requestedDisplayPath,
    "ls",
  );

  if (
    hasIgnoredPathSegment(workspacePath, requestedPath) ||
    hasIgnoredPathSegment(workspacePath, targetPath)
  ) {
    throw new KeelError(
      "tool_path_ignored",
      `ls failed: ignored path: ${requestedDisplayPath}`,
      "This path is excluded by project policy. List a different directory or omit the path to list the workspace root.",
    );
  }

  const projectIgnorePolicy = createProjectIgnorePolicy(
    workspacePath,
    options.hiddenPaths,
  );
  const targetStat = statSync(targetPath);
  const targetIsDirectory = targetStat.isDirectory();
  if (
    options.path !== undefined &&
    (projectIgnorePolicy.isIgnored(requestedPath, targetIsDirectory) ||
      projectIgnorePolicy.isIgnored(targetPath, targetIsDirectory))
  ) {
    throw new KeelError(
      "tool_path_ignored",
      `ls failed: ignored path: ${requestedDisplayPath}`,
      "This path is excluded by project .gitignore. List a different path or omit the path parameter.",
    );
  }
  if (!targetIsDirectory) {
    throw new KeelError(
      "tool_not_directory",
      `ls failed: not a directory: ${requestedDisplayPath}`,
      "Use a workspace directory as the ls path, or omit path to list the workspace root.",
    );
  }

  const entries: LsEntry[] = [];
  for (const dirent of readdirSync(targetPath, { withFileTypes: true })) {
    const requestedEntryPath = join(requestedPath, dirent.name);
    const targetEntryPath = join(targetPath, dirent.name);
    if (
      hasIgnoredPathSegment(workspacePath, requestedEntryPath) ||
      hasIgnoredPathSegment(workspacePath, targetEntryPath)
    ) {
      continue;
    }

    let realEntryPath: string;
    try {
      realEntryPath = realpathSync(targetEntryPath);
    } catch {
      continue;
    }
    if (
      !isInsideWorkspace(workspacePath, realEntryPath) ||
      hasIgnoredPathSegment(workspacePath, realEntryPath)
    ) {
      continue;
    }

    const entryStat = statSync(realEntryPath);
    const isDirectory = entryStat.isDirectory();
    if (!isDirectory && !entryStat.isFile()) {
      continue;
    }
    if (
      projectIgnorePolicy.isIgnored(requestedEntryPath, isDirectory) ||
      projectIgnorePolicy.isIgnored(realEntryPath, isDirectory)
    ) {
      continue;
    }

    entries.push({ name: dirent.name, isDirectory });
  }

  return formatLsOutput(sortLsEntries(entries), limit);
}
