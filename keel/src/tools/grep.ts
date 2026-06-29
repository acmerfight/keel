import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { KeelError } from "../core/error.ts";
import {
  displayPath,
  hasIgnoredPathSegment,
  ignoredDirectoryGlobArgs,
  normalizeRipgrepPath,
  workspaceRootIgnoreArgsForTarget,
} from "./file-search.ts";
import { CountOutputLimit } from "./output-limit.ts";
import { createProjectIgnorePolicy } from "./project-ignore.ts";
import { runRipgrepProcess } from "./ripgrep-process.ts";
import type { ToolResult } from "./types.ts";
import { resolveWorkspaceTarget } from "./workspace-path.ts";

const MAX_GREP_MATCHES = 50;

const DEFAULT_RIPGREP_TIMEOUT_MS = 20_000;
const MAX_SNIPPET_CHARS = 240;
const RIPGREP_INACCESSIBLE_WARNING =
  "[grep warning: some paths were inaccessible and skipped]";

export interface GrepOptions {
  readonly path?: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

interface RipgrepMatch {
  readonly path: string;
  readonly pathEncoding: "text" | "bytes";
  readonly lineNumber: number;
  readonly line: string;
}

interface GrepToolResult extends ToolResult {
  readonly matchTargetPaths: readonly string[];
  readonly inspectionTargetPaths: readonly string[];
}

const ripgrepTextLineSchema = z.object({
  text: z.string(),
});

const ripgrepBytesLineSchema = z.object({
  bytes: z.string(),
});

const ripgrepTextOrBytesSchema = z.union([
  ripgrepTextLineSchema,
  ripgrepBytesLineSchema,
]);

const ripgrepMatchSchema = z.object({
  type: z.literal("match"),
  data: z.object({
    path: ripgrepTextOrBytesSchema,
    lines: ripgrepTextOrBytesSchema,
    line_number: z.number().int().positive(),
  }),
});

type RipgrepTextOrBytes = z.infer<typeof ripgrepTextOrBytesSchema>;

function truncateLineForDisplay(line: string): string {
  let codePointCount = 0;
  let endIndex = 0;
  for (const char of line) {
    if (codePointCount === MAX_SNIPPET_CHARS) {
      return `${line.slice(0, endIndex)}...`;
    }
    endIndex += char.length;
    codePointCount++;
  }
  return line;
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

  const path = ripgrepTextOrBytes(result.data.data.path);
  return {
    path: path.text,
    pathEncoding: path.encoding,
    lineNumber: result.data.data.line_number,
    line: ripgrepTextOrBytes(result.data.data.lines).text.replace(/\r?\n$/, ""),
  };
}

function ripgrepTextOrBytes(value: RipgrepTextOrBytes): {
  readonly text: string;
  readonly encoding: "text" | "bytes";
} {
  if ("text" in value) {
    return { text: value.text, encoding: "text" };
  }
  return {
    text: Buffer.from(value.bytes, "base64").toString("utf8"),
    encoding: "bytes",
  };
}

function formatGrepResult(
  pattern: string,
  matches: readonly {
    readonly output: string;
    readonly targetPath?: string;
  }[],
  options: {
    readonly truncated: boolean;
    readonly partial: boolean;
  },
): GrepToolResult {
  if (matches.length === 0) {
    return {
      content: [
        `No matches found for "${pattern}"`,
        ...(options.partial ? [RIPGREP_INACCESSIBLE_WARNING] : []),
      ].join("\n"),
      matchTargetPaths: [],
      inspectionTargetPaths: [],
    };
  }

  const output = matches.map((match) => match.output);

  if (options.truncated) {
    output.push(
      `[grep output truncated: showing first ${matches.length} matches]`,
    );
  }
  if (options.partial) {
    output.push(RIPGREP_INACCESSIBLE_WARNING);
  }

  return {
    content: output.join("\n"),
    matchTargetPaths: matches.flatMap((match) =>
      match.targetPath === undefined ? [] : [match.targetPath],
    ),
    inspectionTargetPaths: matches.flatMap((match) =>
      match.targetPath === undefined ? [] : [match.targetPath],
    ),
  };
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
    ...ignoredDirectoryGlobArgs(),
    "--",
    pattern,
    targetPath,
  ];
}

function resolveGrepMatchTargetPath(
  workspacePath: string,
  absoluteMatchPath: string,
): string | null {
  try {
    return resolveWorkspaceTarget(workspacePath, absoluteMatchPath, "grep")
      .targetPath;
  } catch {
    return null;
  }
}

async function runRipgrep(
  workspacePath: string,
  targetPath: string,
  pattern: string,
  signal?: AbortSignal,
  timeoutMs: number = DEFAULT_RIPGREP_TIMEOUT_MS,
): Promise<GrepToolResult> {
  const matches = new CountOutputLimit<{
    readonly output: string;
    readonly targetPath?: string;
  }>(MAX_GREP_MATCHES);
  const projectIgnorePolicy = createProjectIgnorePolicy(workspacePath);

  const result = await runRipgrepProcess({
    toolName: "grep",
    workspacePath,
    args: ripgrepArgs(workspacePath, pattern, targetPath),
    ...(signal !== undefined ? { signal } : {}),
    timeoutMs,
    onStdoutLine: (line, stopRipgrep) => {
      const match = parseRipgrepMatch(line);
      if (match === null) return;

      const absoluteMatchPath = isAbsolute(match.path)
        ? resolve(match.path)
        : resolve(workspacePath, match.path);
      if (projectIgnorePolicy.isIgnored(absoluteMatchPath, false)) return;
      const matchTargetPath = resolveGrepMatchTargetPath(
        workspacePath,
        absoluteMatchPath,
      );
      if (matchTargetPath === null && match.pathEncoding === "text") return;

      const matchPath = normalizeRipgrepPath(workspacePath, match.path);
      const appended = matches.append({
        output: `${matchPath}:${match.lineNumber}:${truncateLineForDisplay(match.line)}`,
        ...(matchTargetPath !== null ? { targetPath: matchTargetPath } : {}),
      });
      if (!appended) stopRipgrep();
    },
  });

  const limitedMatches = matches.capture();
  if (limitedMatches.truncated) {
    return formatGrepResult(pattern, limitedMatches.items, {
      truncated: true,
      partial: false,
    });
  }

  if (result.code === 0 || result.code === 1) {
    return formatGrepResult(pattern, limitedMatches.items, {
      truncated: false,
      partial: false,
    });
  }

  if (result.code === 2 && result.stderr.trim() === "") {
    return formatGrepResult(pattern, limitedMatches.items, {
      truncated: false,
      partial: true,
    });
  }

  // Multi-line patterns are rejected before ripgrep runs and per-file I/O
  // errors are suppressed by --no-messages, so a non-zero exit here is a genuine
  // ripgrep failure (like a missing binary or a timeout), not an LLM input
  // mistake. It stays fatal, consistent with the other environment errors.
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
): Promise<GrepToolResult> {
  if (pattern === "") {
    throw new KeelError(
      "tool_empty_pattern",
      "grep failed: pattern is empty",
      "Provide a non-empty search pattern.",
    );
  }

  if (/[\r\n]/.test(pattern)) {
    throw new KeelError(
      "tool_invalid_pattern",
      "grep failed: pattern spans multiple lines",
      "grep matches literal text within a single line. Remove newlines from the pattern and search for a unique single-line substring; read the file to inspect multi-line context.",
    );
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
      "This path is excluded by project policy. Search in a different directory or omit the path to search the whole workspace.",
    );
  }

  const targetStat = statSync(targetPath);
  const targetIsDirectory = targetStat.isDirectory();
  if (!targetStat.isDirectory() && !targetStat.isFile()) {
    throw new KeelError(
      "tool_not_file",
      `grep failed: not a file or directory: ${requestedPath}`,
      "The path is neither a file nor a directory. Verify the path exists.",
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
        "This file is excluded by project .gitignore. Search in a different path or omit the path parameter.",
      );
    }
  }

  const result = await runRipgrep(
    workspacePath,
    displayPath(workspacePath, targetPath),
    pattern,
    options.signal,
    options.timeoutMs,
  );
  return {
    ...result,
    inspectionTargetPaths: [targetPath, ...result.matchTargetPaths],
  };
}
