import { spawn } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";
import { KeelError } from "../core/error.ts";
import { resolveRipgrep } from "./ripgrep.ts";
import type { ToolResult } from "./types.ts";

export const MAX_GREP_MATCHES = 50;

const DEFAULT_RIPGREP_TIMEOUT_MS = 20_000;
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

function isInsideWorkspace(workspace: string, target: string): boolean {
  const targetFromWorkspace = relative(workspace, target);
  return (
    targetFromWorkspace === "" ||
    (!targetFromWorkspace.startsWith("..") && !isAbsolute(targetFromWorkspace))
  );
}

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

function ripgrepArgs(pattern: string, targetPath: string): string[] {
  return [
    "--no-config",
    "--json",
    "--fixed-strings",
    "--hidden",
    "--no-messages",
    "--no-require-git",
    ...ignoredGlobArgs(),
    "--",
    pattern,
    targetPath,
  ];
}

async function runRipgrep(
  workspacePath: string,
  targetPath: string,
  pattern: string,
  signal?: AbortSignal,
  timeoutMs: number = DEFAULT_RIPGREP_TIMEOUT_MS,
): Promise<ToolResult> {
  const ripgrep = await resolveRipgrep();

  return new Promise<ToolResult>((resolveResult, rejectResult) => {
    let settled = false;
    let killedForLimit = false;
    let stderr = "";
    const matches: string[] = [];

    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      callback();
    };

    const child = spawn(ripgrep.path, ripgrepArgs(pattern, targetPath), {
      cwd: workspacePath,
      stdio: ["ignore", "pipe", "pipe"],
      ...(signal !== undefined ? { signal } : {}),
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
    const cleanup = () => {
      if (timeout !== undefined) clearTimeout(timeout);
      stdout.close();
    };
    timeout = setTimeout(() => {
      child.kill();
      cleanup();
      settle(() => {
        rejectResult(
          new KeelError(
            "tool_unavailable",
            `grep failed: ripgrep timed out after ${timeoutMs}ms`,
          ),
        );
      });
    }, timeoutMs);

    stdout.on("line", (line) => {
      if (matches.length >= MAX_GREP_MATCHES) return;

      const match = parseRipgrepMatch(line);
      if (match === null) return;

      const matchPath = normalizeRipgrepPath(workspacePath, match.path);
      matches.push(`${matchPath}:${match.lineNumber}:${snippet(match.line)}`);

      if (matches.length >= MAX_GREP_MATCHES) {
        killedForLimit = true;
        child.kill();
      }
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
        if (killedForLimit) {
          resolveResult(
            formatGrepResult(pattern, matches, {
              truncated: true,
              partial: false,
            }),
          );
          return;
        }

        if (code === 0 || code === 1) {
          resolveResult(
            formatGrepResult(pattern, matches, {
              truncated: false,
              partial: false,
            }),
          );
          return;
        }

        if (code === 2 && stderr.trim() === "") {
          resolveResult(
            formatGrepResult(pattern, matches, {
              truncated: false,
              partial: true,
            }),
          );
          return;
        }

        rejectResult(
          new KeelError(
            "tool_unavailable",
            `grep failed: ripgrep exited with code ${code ?? "unknown"}${
              stderr.trim() ? `: ${stderr.trim()}` : ""
            }`,
          ),
        );
      });
    });
  });
}

export async function executeGrep(
  workspace: string,
  pattern: string,
  options: GrepOptions = {},
): Promise<ToolResult> {
  if (pattern === "") {
    throw new KeelError("tool_empty_pattern", "grep failed: pattern is empty");
  }

  const workspacePath = realpathSync(workspace);
  const requestedPath = options.path ?? ".";
  const absoluteRequestedPath = isAbsolute(requestedPath)
    ? resolve(requestedPath)
    : resolve(workspacePath, requestedPath);

  if (!existsSync(absoluteRequestedPath)) {
    throw new KeelError(
      "tool_file_not_found",
      `grep failed: file not found: ${requestedPath}`,
    );
  }

  const targetPath = realpathSync(absoluteRequestedPath);
  if (!isInsideWorkspace(workspacePath, targetPath)) {
    throw new KeelError(
      "tool_path_outside_workspace",
      `grep failed: path is outside the workspace: ${requestedPath}`,
    );
  }
  if (hasIgnoredPathSegment(workspacePath, targetPath)) {
    throw new KeelError(
      "tool_path_ignored",
      `grep failed: ignored path: ${requestedPath}`,
    );
  }

  const targetStat = statSync(targetPath);
  if (!targetStat.isDirectory() && !targetStat.isFile()) {
    throw new KeelError(
      "tool_not_file",
      `grep failed: not a file or directory: ${requestedPath}`,
    );
  }

  return await runRipgrep(
    workspacePath,
    displayPath(workspacePath, targetPath),
    pattern,
    options.signal,
    options.timeoutMs,
  );
}
