import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { KeelError } from "../core/error.ts";
import type { ToolResult } from "./types.ts";

export const MAX_GREP_MATCHES = 50;

const BINARY_SAMPLE_BYTES = 4096;
const MAX_SNIPPET_CHARS = 240;
const IGNORED_DIRECTORIES = new Set([
  ".git",
  "coverage",
  "dist",
  "node_modules",
]);
const BINARY_EXTENSIONS = new Set([
  ".7z",
  ".a",
  ".aac",
  ".apk",
  ".avif",
  ".avi",
  ".bin",
  ".bmp",
  ".bz2",
  ".class",
  ".dat",
  ".db",
  ".dll",
  ".dmg",
  ".doc",
  ".docx",
  ".dylib",
  ".eot",
  ".exe",
  ".flac",
  ".gif",
  ".gz",
  ".heic",
  ".heif",
  ".ico",
  ".iso",
  ".jar",
  ".jpeg",
  ".jpg",
  ".lib",
  ".m4a",
  ".m4v",
  ".mkv",
  ".mov",
  ".mp3",
  ".mp4",
  ".mpeg",
  ".mpg",
  ".o",
  ".obj",
  ".odt",
  ".ods",
  ".odp",
  ".ogg",
  ".ogv",
  ".otf",
  ".pdf",
  ".png",
  ".ppt",
  ".pptx",
  ".pyc",
  ".pyo",
  ".rar",
  ".so",
  ".sqlite",
  ".sqlite3",
  ".tar",
  ".tgz",
  ".tif",
  ".tiff",
  ".ttf",
  ".war",
  ".wav",
  ".webm",
  ".webp",
  ".woff",
  ".woff2",
  ".zip",
]);

export interface GrepOptions {
  readonly path?: string;
}

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

function hasBinaryControlBytes(bytes: Uint8Array): boolean {
  for (const byte of bytes) {
    if (byte === 0) return true;
    if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) return true;
  }
  return false;
}

function isBinaryFile(filePath: string, content: Uint8Array): boolean {
  if (BINARY_EXTENSIONS.has(extname(filePath).toLowerCase())) return true;
  return hasBinaryControlBytes(content.subarray(0, BINARY_SAMPLE_BYTES));
}

function snippet(line: string): string {
  if (line.length <= MAX_SNIPPET_CHARS) return line;
  return `${line.slice(0, MAX_SNIPPET_CHARS)}...`;
}

export function executeGrep(
  workspace: string,
  pattern: string,
  options: GrepOptions = {},
): ToolResult {
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

  const matches: string[] = [];
  let totalMatches = 0;
  const visitedDirectories = new Set<string>();
  const visitedFiles = new Set<string>();

  const addMatch = (filePath: string, lineNumber: number, line: string) => {
    totalMatches++;
    if (matches.length < MAX_GREP_MATCHES) {
      matches.push(
        `${displayPath(workspacePath, filePath)}:${lineNumber}:${snippet(line)}`,
      );
    }
  };

  const searchFile = (filePath: string) => {
    if (visitedFiles.has(filePath)) return;
    visitedFiles.add(filePath);

    const content = readFileSync(filePath);
    if (isBinaryFile(filePath, content)) return;

    for (const [index, line] of content
      .toString("utf8")
      .split(/\r?\n/)
      .entries()) {
      if (line.includes(pattern)) {
        addMatch(filePath, index + 1, line);
      }
    }
  };

  const searchDirectory = (directoryPath: string) => {
    if (visitedDirectories.has(directoryPath)) return;
    visitedDirectories.add(directoryPath);

    const entries = readdirSync(directoryPath, { withFileTypes: true }).sort(
      (left, right) => left.name.localeCompare(right.name),
    );

    for (const entry of entries) {
      if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) {
        continue;
      }

      const entryPath = join(directoryPath, entry.name);
      let resolvedEntryPath: string;
      try {
        resolvedEntryPath = realpathSync(entryPath);
      } catch {
        continue;
      }
      if (!isInsideWorkspace(workspacePath, resolvedEntryPath)) {
        continue;
      }

      const entryStat = statSync(resolvedEntryPath);
      if (entryStat.isDirectory()) {
        searchDirectory(resolvedEntryPath);
        continue;
      }
      if (entryStat.isFile()) {
        searchFile(resolvedEntryPath);
      }
    }
  };

  const targetStat = statSync(targetPath);
  if (targetStat.isDirectory()) {
    searchDirectory(targetPath);
  } else if (targetStat.isFile()) {
    searchFile(targetPath);
  } else {
    throw new KeelError(
      "tool_not_file",
      `grep failed: not a file or directory: ${requestedPath}`,
    );
  }

  if (totalMatches === 0) {
    return { content: `No matches found for "${pattern}"` };
  }

  if (totalMatches > matches.length) {
    matches.push(
      `[grep output truncated: showing ${matches.length} of ${totalMatches} matches]`,
    );
  }

  return { content: matches.join("\n") };
}
