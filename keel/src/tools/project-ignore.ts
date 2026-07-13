import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import ignore from "ignore";

type IgnoreMatcher = ReturnType<typeof ignore>;

export interface ProjectIgnorePolicy {
  readonly isIgnored: (
    targetPath: string,
    targetIsDirectory: boolean,
  ) => boolean;
}

function isHiddenPath(
  targetPath: string,
  hiddenPaths: readonly string[],
): boolean {
  const absoluteTargetPath = resolve(targetPath);
  return hiddenPaths.some((hiddenPath) => {
    const relativePath = relative(resolve(hiddenPath), absoluteTargetPath);
    return (
      relativePath === "" ||
      (!relativePath.startsWith(`..${sep}`) &&
        relativePath !== ".." &&
        !isAbsolute(relativePath))
    );
  });
}

function pathForIgnoreFile(
  basePath: string,
  targetPath: string,
): string | null {
  const relativePath = relative(basePath, targetPath);
  if (relativePath === "") return null;
  return relativePath.split(sep).join("/");
}

function ignoreFileDirectories(
  workspacePath: string,
  targetPath: string,
): readonly string[] {
  const deepestDirectory =
    targetPath === workspacePath ? workspacePath : dirname(targetPath);
  const relativeDirectory = relative(workspacePath, deepestDirectory);
  const directories = [workspacePath];
  if (relativeDirectory === "") return directories;

  let currentDirectory = workspacePath;
  for (const segment of relativeDirectory.split(sep)) {
    currentDirectory = join(currentDirectory, segment);
    directories.push(currentDirectory);
  }
  return directories;
}

function ancestorDirectoryIgnorePaths(
  basePath: string,
  targetPath: string,
  targetIsDirectory: boolean,
): readonly string[] {
  const deepestDirectory = targetIsDirectory ? targetPath : dirname(targetPath);
  const relativeDirectory = relative(basePath, deepestDirectory);
  if (relativeDirectory === "") return [];

  const paths: string[] = [];
  let currentPath = "";
  for (const segment of relativeDirectory.split(sep)) {
    currentPath = currentPath === "" ? segment : `${currentPath}/${segment}`;
    paths.push(`${currentPath}/`);
  }
  return paths;
}

export function createProjectIgnorePolicy(
  workspacePath: string,
  hiddenPaths: readonly string[] = [],
): ProjectIgnorePolicy {
  const matchers = new Map<string, IgnoreMatcher | null>();

  const matcherForDirectory = (directory: string): IgnoreMatcher | null => {
    const cached = matchers.get(directory);
    if (cached !== undefined) return cached;

    const ignorePath = join(directory, ".gitignore");
    if (!existsSync(ignorePath)) {
      matchers.set(directory, null);
      return null;
    }

    const matcher = ignore().add(readFileSync(ignorePath, "utf8"));
    matchers.set(directory, matcher);
    return matcher;
  };

  return {
    isIgnored: (targetPath: string, targetIsDirectory: boolean): boolean => {
      if (isHiddenPath(targetPath, hiddenPaths)) return true;
      let ignored = false;

      for (const directory of ignoreFileDirectories(
        workspacePath,
        targetPath,
      )) {
        const matcher = matcherForDirectory(directory);
        if (matcher === null) continue;

        for (const ancestorPath of ancestorDirectoryIgnorePaths(
          directory,
          targetPath,
          targetIsDirectory,
        )) {
          if (matcher.test(ancestorPath).ignored) return true;
        }

        const targetIgnorePath = pathForIgnoreFile(directory, targetPath);
        if (targetIgnorePath === null) continue;

        const targetResult = matcher.test(
          targetIsDirectory ? `${targetIgnorePath}/` : targetIgnorePath,
        );
        if (targetResult.ignored) ignored = true;
        if (targetResult.unignored) ignored = false;
      }

      return ignored;
    },
  };
}
