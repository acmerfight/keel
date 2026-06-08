import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";
import { KeelError } from "../core/error.ts";
import { createProjectIgnorePolicy } from "./project-ignore.ts";
import { resolveRipgrep } from "./ripgrep.ts";
import type { ToolResult } from "./types.ts";
import { resolveWorkspaceTarget } from "./workspace-path.ts";

export const MAX_GREP_MATCHES = 50;

const DEFAULT_RIPGREP_TIMEOUT_MS = 20_000;
const RIPGREP_KILL_GRACE_MS = 1_000;
const MAX_SNIPPET_CHARS = 240;
const RIPGREP_INACCESSIBLE_WARNING =
  "[grep warning: some paths were inaccessible and skipped]";
const IGNORED_DIRECTORIES = new Set([
  ".git",
  "coverage",
  "dist",
  "node_modules",
]);

export interface GrepOptions {
  readonly path?: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

interface RipgrepMatch {
  readonly path: string;
  readonly lineNumber: number;
  readonly line: string;
}

interface RipgrepProcessOptions {
  readonly workspacePath: string;
  readonly args: readonly string[];
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
  readonly onStdoutLine: (line: string, stopRipgrep: () => void) => void;
}

interface RipgrepProcessResult {
  readonly code: number | null;
  readonly stderr: string;
}

const ripgrepMatchSchema = z.object({
  type: z.literal("match"),
  data: z.object({
    path: z.object({
      text: z.string(),
    }),
    lines: z.object({
      text: z.string(),
    }),
    line_number: z.number().int().positive(),
  }),
});

function displayPath(workspacePath: string, targetPath: string): string {
  const workspaceRelativePath = relative(workspacePath, targetPath);
  if (workspaceRelativePath === "") return ".";
  return workspaceRelativePath.split(sep).join("/");
}

function snippet(line: string): string {
  if (line.length <= MAX_SNIPPET_CHARS) return line;
  return `${line.slice(0, MAX_SNIPPET_CHARS)}...`;
}

function parseRipgrepMatch(line: string): RipgrepMatch | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }

  const result = ripgrepMatchSchema.safeParse(parsed);
  if (!result.success) return null;

  return {
    path: result.data.data.path.text,
    lineNumber: result.data.data.line_number,
    line: result.data.data.lines.text.replace(/\r?\n$/, ""),
  };
}

function hasIgnoredPathSegment(
  workspacePath: string,
  targetPath: string,
): boolean {
  const workspaceRelativePath = relative(workspacePath, targetPath);
  if (workspaceRelativePath === "") return false;
  return workspaceRelativePath
    .split(sep)
    .some((segment) => IGNORED_DIRECTORIES.has(segment));
}

function ignoredGlobArgs(): string[] {
  return [...IGNORED_DIRECTORIES].flatMap((directory) => [
    "--glob",
    `!**/${directory}/**`,
  ]);
}

function workspaceRootIgnoreArgsForTarget(
  workspacePath: string,
  targetPath: string,
): string[] {
  if (targetPath === ".") return [];

  // Subdirectory targets do not automatically inherit the workspace root
  // .gitignore when --no-ignore-parent is set, so pass it explicitly.
  const ignorePath = join(workspacePath, ".gitignore");
  if (!existsSync(ignorePath)) return [];
  return ["--ignore-file", ignorePath];
}

function normalizeRipgrepPath(
  workspacePath: string,
  ripgrepPath: string,
): string {
  const absolutePath = isAbsolute(ripgrepPath)
    ? resolve(ripgrepPath)
    : resolve(workspacePath, ripgrepPath);
  return displayPath(workspacePath, absolutePath);
}

function formatGrepResult(
  pattern: string,
  matches: readonly string[],
  options: {
    readonly truncated: boolean;
    readonly partial: boolean;
  },
): ToolResult {
  const output = [...matches];

  if (options.truncated) {
    output.push(
      `[grep output truncated: showing first ${matches.length} matches]`,
    );
  }
  if (options.partial) {
    output.push(RIPGREP_INACCESSIBLE_WARNING);
  }

  if (output.length === 0 || (matches.length === 0 && options.partial)) {
    return {
      content: [
        `No matches found for "${pattern}"`,
        ...(options.partial ? [RIPGREP_INACCESSIBLE_WARNING] : []),
      ].join("\n"),
    };
  }

  return { content: output.join("\n") };
}

function ripgrepArgs(
  workspacePath: string,
  pattern: string,
  targetPath: string,
): string[] {
  return [
    "--no-config",
    "--json",
    "--fixed-strings",
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
    ...ignoredGlobArgs(),
    "--",
    pattern,
    targetPath,
  ];
}

async function runRipgrepProcess(
  options: RipgrepProcessOptions,
): Promise<RipgrepProcessResult> {
  const ripgrep = await resolveRipgrep();

  return new Promise<RipgrepProcessResult>((resolveResult, rejectResult) => {
    let settled = false;
    let stderr = "";

    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      callback();
    };

    const child = spawn(ripgrep.path, options.args, {
      cwd: options.workspacePath,
      stdio: ["ignore", "pipe", "pipe"],
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });

    if (child.stdout === null || child.stderr === null) {
      child.kill();
      settle(() => {
        rejectResult(
          new KeelError(
            "tool_unavailable",
            "grep failed: ripgrep streams are unavailable",
          ),
        );
      });
      return;
    }

    const stdout = createInterface({ input: child.stdout });
    let timeout: NodeJS.Timeout | undefined;
    let forceKillTimeout: NodeJS.Timeout | undefined;
    let stdoutClosed = false;
    const closeStdout = () => {
      if (stdoutClosed) return;
      stdoutClosed = true;
      stdout.close();
    };
    const clearSearchTimeout = () => {
      if (timeout === undefined) return;
      clearTimeout(timeout);
      timeout = undefined;
    };
    const cleanup = () => {
      clearSearchTimeout();
      if (forceKillTimeout !== undefined) {
        clearTimeout(forceKillTimeout);
        forceKillTimeout = undefined;
      }
      closeStdout();
    };
    const stopRipgrep = () => {
      child.kill("SIGTERM");
      if (forceKillTimeout !== undefined) return;
      forceKillTimeout = setTimeout(() => {
        child.kill("SIGKILL");
      }, RIPGREP_KILL_GRACE_MS);
    };
    timeout = setTimeout(() => {
      stopRipgrep();
      clearSearchTimeout();
      closeStdout();
      settle(() => {
        rejectResult(
          new KeelError(
            "tool_unavailable",
            `grep failed: ripgrep timed out after ${options.timeoutMs}ms`,
          ),
        );
      });
    }, options.timeoutMs);

    stdout.on("line", (line) => {
      options.onStdoutLine(line, stopRipgrep);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", (error: NodeJS.ErrnoException) => {
      cleanup();
      settle(() => {
        if (error.code === "ENOENT") {
          rejectResult(
            new KeelError(
              "tool_unavailable",
              `grep failed: bundled ripgrep is not available (${ripgrep.provider})`,
            ),
          );
          return;
        }
        rejectResult(error);
      });
    });

    child.on("close", (code) => {
      cleanup();
      settle(() => {
        resolveResult({ code, stderr });
      });
    });
  });
}

async function runRipgrep(
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
    workspacePath,
    args: ripgrepArgs(workspacePath, pattern, targetPath),
    ...(signal !== undefined ? { signal } : {}),
    timeoutMs,
    onStdoutLine: (line, stopRipgrep) => {
      if (matches.length >= MAX_GREP_MATCHES) return;

      const match = parseRipgrepMatch(line);
      if (match === null) return;

      const absoluteMatchPath = isAbsolute(match.path)
        ? resolve(match.path)
        : resolve(workspacePath, match.path);
      if (projectIgnorePolicy.isIgnored(absoluteMatchPath, false)) return;

      const matchPath = normalizeRipgrepPath(workspacePath, match.path);
      matches.push(`${matchPath}:${match.lineNumber}:${snippet(match.line)}`);

      if (matches.length >= MAX_GREP_MATCHES) {
        killedForLimit = true;
        stopRipgrep();
      }
    },
  });

  if (killedForLimit) {
    return formatGrepResult(pattern, matches, {
      truncated: true,
      partial: false,
    });
  }

  if (result.code === 0 || result.code === 1) {
    return formatGrepResult(pattern, matches, {
      truncated: false,
      partial: false,
    });
  }

  if (result.code === 2 && result.stderr.trim() === "") {
    return formatGrepResult(pattern, matches, {
      truncated: false,
      partial: true,
    });
  }

  throw new KeelError(
    "tool_unavailable",
    `grep failed: ripgrep exited with code ${result.code ?? "unknown"}${
      result.stderr.trim() ? `: ${result.stderr.trim()}` : ""
    }`,
  );
}

export async function executeGrep(
  workspace: string,
  pattern: string,
  options: GrepOptions = {},
): Promise<ToolResult> {
  if (pattern === "") {
    throw new KeelError("tool_empty_pattern", "grep failed: pattern is empty");
  }

  const requestedDisplayPath = options.path ?? ".";
  const { workspacePath, requestedPath, targetPath } = resolveWorkspaceTarget(
    workspace,
    requestedDisplayPath,
    "grep",
  );
  if (
    hasIgnoredPathSegment(workspacePath, requestedPath) ||
    hasIgnoredPathSegment(workspacePath, targetPath)
  ) {
    throw new KeelError(
      "tool_path_ignored",
      `grep failed: ignored path: ${requestedDisplayPath}`,
    );
  }

  const targetStat = statSync(targetPath);
  const targetIsDirectory = targetStat.isDirectory();
  if (!targetStat.isDirectory() && !targetStat.isFile()) {
    throw new KeelError(
      "tool_not_file",
      `grep failed: not a file or directory: ${requestedPath}`,
    );
  }
  if (options.path !== undefined) {
    const projectIgnorePolicy = createProjectIgnorePolicy(workspacePath);
    if (
      projectIgnorePolicy.isIgnored(requestedPath, targetIsDirectory) ||
      projectIgnorePolicy.isIgnored(targetPath, targetIsDirectory)
    ) {
      throw new KeelError(
        "tool_path_ignored",
        `grep failed: ignored path: ${requestedDisplayPath}`,
      );
    }
  }

  return await runRipgrep(
    workspacePath,
    displayPath(workspacePath, targetPath),
    pattern,
    options.signal,
    options.timeoutMs,
  );
}
