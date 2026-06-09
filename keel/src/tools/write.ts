import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { KeelError } from "../core/error.ts";
import { recordLastCreateCheckpoint } from "../core/git.ts";
import { createProjectIgnorePolicy } from "./project-ignore.ts";
import type { ToolResult } from "./types.ts";
import {
  isInsideWorkspace,
  resolveWorkspaceCreateTarget,
} from "./workspace-path.ts";

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function ignoredPathError(filePath: string): KeelError {
  return new KeelError(
    "tool_path_ignored",
    `write failed: ignored path: ${filePath}`,
    "This file is excluded by project .gitignore. Choose a different file path that is not ignored.",
  );
}

export function executeWrite(
  workspace: string,
  filePath: string,
  content: string,
): ToolResult {
  const { workspacePath, targetPath, parentPath } =
    resolveWorkspaceCreateTarget(workspace, filePath, "write");

  try {
    mkdirSync(parentPath, { recursive: true });
  } catch (error) {
    if (
      isErrnoException(error) &&
      (error.code === "EEXIST" || error.code === "ENOTDIR")
    ) {
      throw new KeelError(
        "tool_not_directory",
        `write failed: parent path is not a directory: ${filePath}`,
        "The parent path is a file, not a directory. Choose a different path.",
      );
    }
    throw error;
  }

  const parentRealPath = realpathSync(parentPath);
  if (!isInsideWorkspace(workspacePath, parentRealPath)) {
    throw new KeelError(
      "tool_path_outside_workspace",
      `write failed: path is outside the workspace: ${filePath}`,
      `Use a workspace-relative path. The current workspace root is: ${workspacePath}`,
    );
  }

  const projectIgnorePolicy = createProjectIgnorePolicy(workspacePath);
  const realTargetPath = resolve(parentRealPath, basename(targetPath));
  if (projectIgnorePolicy.isIgnored(realTargetPath, false)) {
    throw ignoredPathError(filePath);
  }

  try {
    writeFileSync(targetPath, content, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (isErrnoException(error) && error.code === "EEXIST") {
      throw new KeelError(
        "tool_file_exists",
        `write failed: file already exists: ${filePath}`,
        `Use edit to modify the existing file instead of write, or choose a different file name.`,
      );
    }
    if (isErrnoException(error) && error.code === "ENOTDIR") {
      throw new KeelError(
        "tool_not_directory",
        `write failed: parent path is not a directory: ${filePath}`,
        "The parent path is a file, not a directory. Choose a different path.",
      );
    }
    throw error;
  }

  recordLastCreateCheckpoint({
    workspace: workspacePath,
    filePath: targetPath,
    afterContent: content,
  });

  return { content: `Wrote ${filePath}` };
}
