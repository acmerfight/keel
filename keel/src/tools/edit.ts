import { readFileSync, statSync, writeFileSync } from "node:fs";
import { KeelError } from "../core/error.ts";
import { createProjectIgnorePolicy } from "./project-ignore.ts";
import type { ToolResult } from "./types.ts";
import { resolveWorkspaceTarget } from "./workspace-path.ts";

export function executeEdit(
  workspace: string,
  filePath: string,
  oldString: string,
  newString: string,
): ToolResult {
  if (oldString === "") {
    throw new KeelError(
      "tool_empty_old_string",
      "edit failed: old string is empty",
    );
  }

  const { workspacePath, requestedPath, targetPath } = resolveWorkspaceTarget(
    workspace,
    filePath,
    "edit",
  );

  const targetStat = statSync(targetPath);
  const targetIsDirectory = targetStat.isDirectory();
  const projectIgnorePolicy = createProjectIgnorePolicy(workspacePath);
  if (
    projectIgnorePolicy.isIgnored(requestedPath, targetIsDirectory) ||
    projectIgnorePolicy.isIgnored(targetPath, targetIsDirectory)
  ) {
    throw new KeelError(
      "tool_path_ignored",
      `edit failed: ignored path: ${filePath}`,
    );
  }

  const content = readFileSync(targetPath, "utf8");
  const firstMatch = content.indexOf(oldString);
  if (firstMatch < 0) {
    throw new KeelError(
      "tool_old_string_not_found",
      `edit failed: old string not found in ${filePath}`,
    );
  }

  const secondMatch = content.indexOf(oldString, firstMatch + oldString.length);
  if (secondMatch >= 0) {
    throw new KeelError(
      "tool_old_string_not_unique",
      `edit failed: old string is not unique in ${filePath}`,
    );
  }

  const updated =
    content.slice(0, firstMatch) +
    newString +
    content.slice(firstMatch + oldString.length);
  writeFileSync(targetPath, updated, "utf8");

  return { content: `Edited ${filePath}` };
}
