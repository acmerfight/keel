import { existsSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const IGNORED_DIRECTORIES: ReadonlySet<string> = new Set([
  ".git",
  "coverage",
  "dist",
  "node_modules",
]);

export function displayPath(workspacePath: string, targetPath: string): string {
  const workspaceRelativePath = relative(workspacePath, targetPath);
  if (workspaceRelativePath === "") return ".";
  return workspaceRelativePath.split(sep).join("/");
}

export function hasIgnoredPathSegment(
  workspacePath: string,
  targetPath: string,
): boolean {
  const workspaceRelativePath = relative(workspacePath, targetPath);
  if (workspaceRelativePath === "") return false;
  return workspaceRelativePath
    .split(sep)
    .some((segment) => IGNORED_DIRECTORIES.has(segment));
}

export function ignoredDirectoryGlobArgs(): string[] {
  return [...IGNORED_DIRECTORIES].flatMap((directory) => [
    "--glob",
    `!**/${directory}/**`,
  ]);
}

export function workspaceRootIgnoreArgsForTarget(
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

export function normalizeRipgrepPath(
  workspacePath: string,
  ripgrepPath: string,
): string {
  const absolutePath = isAbsolute(ripgrepPath)
    ? resolve(ripgrepPath)
    : resolve(workspacePath, ripgrepPath);
  return displayPath(workspacePath, absolutePath);
}
