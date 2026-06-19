import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { KeelError } from "../core/error.ts";
import {
  displayPath,
  hasIgnoredPathSegment,
  ignoredDirectoryGlobArgs,
  normalizeRipgrepPath,
  workspaceRootIgnoreArgsForTarget,
} from "./file-search.ts";
import { createProjectIgnorePolicy } from "./project-ignore.ts";
import { runRipgrepProcess } from "./ripgrep-process.ts";
import type { ToolResult } from "./types.ts";
import { resolveWorkspaceTarget } from "./workspace-path.ts";

const MAX_GLOB_MATCHES = 50;
const DEFAULT_RIPGREP_TIMEOUT_MS = 20_000;

export interface GlobOptions {
  readonly path?: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

function globArgs(
  workspacePath: string,
  pattern: string,
  targetPath: string,
): string[] {
  return [
    "--no-config",
    "--files",
    "--hidden",
    "--no-messages",
    "--no-require-git",
    "--no-ignore-dot",
    "--no-ignore-exclude",
    "--no-ignore-global",
    "--no-ignore-parent",
    ...workspaceRootIgnoreArgsForTarget(workspacePath, targetPath),
    "--sort",
    "path",
    ...ignoredDirectoryGlobArgs(),
    "--glob",
    pattern,
    "--",
    targetPath,
  ];
}

function formatGlobResult(
  pattern: string,
  matches: readonly string[],
  options: { readonly truncated: boolean },
): ToolResult {
  if (matches.length === 0) {
    return { content: `No files found for pattern "${pattern}"` };
  }

  const output = [...matches];
  if (options.truncated) {
    output.push(
      `[glob output truncated: showing first ${matches.length} files. Narrow the pattern or path to see more.]`,
    );
  }
  return { content: output.join("\n") };
}

async function runGlob(
  workspacePath: string,
  targetPath: string,
  pattern: string,
  signal?: AbortSignal,
  timeoutMs: number = DEFAULT_RIPGREP_TIMEOUT_MS,
): Promise<ToolResult> {
  let killedForLimit = false;
  const matches: string[] = [];
  const projectIgnorePolicy = createProjectIgnorePolicy(workspacePath);

  const result = await runRipgrepProcess({
    toolName: "glob",
    workspacePath,
    args: globArgs(workspacePath, pattern, targetPath),
    ...(signal !== undefined ? { signal } : {}),
    timeoutMs,
    onStdoutLine: (line, stopRipgrep) => {
      if (matches.length >= MAX_GLOB_MATCHES) return;

      const absoluteMatchPath = isAbsolute(line)
        ? resolve(line)
        : resolve(workspacePath, line);
      if (projectIgnorePolicy.isIgnored(absoluteMatchPath, false)) return;
      if (hasIgnoredPathSegment(workspacePath, absoluteMatchPath)) return;

      matches.push(normalizeRipgrepPath(workspacePath, line));

      if (matches.length >= MAX_GLOB_MATCHES) {
        killedForLimit = true;
        stopRipgrep();
      }
    },
  });

  if (killedForLimit) {
    return formatGlobResult(pattern, matches, { truncated: true });
  }

  if (result.code === 0 || result.code === 1) {
    return formatGlobResult(pattern, matches, { truncated: false });
  }

  if (result.code === 2 && result.stderr.trim() !== "") {
    throw new KeelError(
      "tool_invalid_pattern",
      `glob failed: invalid pattern: ${pattern}`,
      'Use a valid single-line glob pattern such as "**/*.ts".',
    );
  }

  throw new KeelError(
    "tool_unavailable",
    `glob failed: ripgrep exited with code ${result.code ?? "unknown"}${
      result.stderr.trim() ? `: ${result.stderr.trim()}` : ""
    }`,
  );
}

export async function executeGlob(
  workspace: string,
  pattern: string,
  options: GlobOptions = {},
): Promise<ToolResult> {
  if (pattern === "") {
    throw new KeelError(
      "tool_empty_pattern",
      "glob failed: pattern is empty",
      'Provide a non-empty glob pattern such as "**/*.ts".',
    );
  }

  if (/[\r\n]/.test(pattern)) {
    throw new KeelError(
      "tool_invalid_pattern",
      "glob failed: pattern spans multiple lines",
      'Use a single-line glob pattern such as "**/*.ts".',
    );
  }

  const requestedDisplayPath = options.path ?? ".";
  const { workspacePath, requestedPath, targetPath } = resolveWorkspaceTarget(
    workspace,
    requestedDisplayPath,
    "glob",
  );
  if (
    hasIgnoredPathSegment(workspacePath, requestedPath) ||
    hasIgnoredPathSegment(workspacePath, targetPath)
  ) {
    throw new KeelError(
      "tool_path_ignored",
      `glob failed: ignored path: ${requestedDisplayPath}`,
      "This path is excluded by project policy. Search in a different directory or omit the path to search the whole workspace.",
    );
  }

  const targetStat = statSync(targetPath);
  if (!targetStat.isDirectory()) {
    throw new KeelError(
      "tool_not_directory",
      `glob failed: not a directory: ${requestedDisplayPath}`,
      "Use a workspace directory as the glob path, or omit path to search the workspace root.",
    );
  }
  if (options.path !== undefined) {
    const projectIgnorePolicy = createProjectIgnorePolicy(workspacePath);
    if (
      projectIgnorePolicy.isIgnored(requestedPath, true) ||
      projectIgnorePolicy.isIgnored(targetPath, true)
    ) {
      throw new KeelError(
        "tool_path_ignored",
        `glob failed: ignored path: ${requestedDisplayPath}`,
        "This directory is excluded by project .gitignore. Search in a different path or omit the path parameter.",
      );
    }
  }

  return await runGlob(
    workspacePath,
    displayPath(workspacePath, targetPath),
    pattern,
    options.signal,
    options.timeoutMs,
  );
}
