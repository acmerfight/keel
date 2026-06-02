import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { ToolResult } from "./types.ts";

function isInsideWorkspace(workspace: string, target: string): boolean {
  const targetFromWorkspace = relative(workspace, target);
  return (
    targetFromWorkspace === "" ||
    (!targetFromWorkspace.startsWith("..") && !isAbsolute(targetFromWorkspace))
  );
}

export function executeEdit(
  workspace: string,
  filePath: string,
  oldString: string,
  newString: string,
): ToolResult {
  if (oldString === "") {
    throw new Error("edit failed: old string is empty");
  }

  const workspacePath = realpathSync(workspace);
  const requestedPath = isAbsolute(filePath)
    ? resolve(filePath)
    : resolve(workspacePath, filePath);
  if (!existsSync(requestedPath)) {
    throw new Error(`edit failed: file not found: ${filePath}`);
  }

  const targetPath = realpathSync(requestedPath);

  if (!isInsideWorkspace(workspacePath, targetPath)) {
    throw new Error(`edit failed: path is outside the workspace: ${filePath}`);
  }

  const content = readFileSync(targetPath, "utf8");
  const firstMatch = content.indexOf(oldString);
  if (firstMatch < 0) {
    throw new Error(`edit failed: old string not found in ${filePath}`);
  }

  const secondMatch = content.indexOf(oldString, firstMatch + oldString.length);
  if (secondMatch >= 0) {
    throw new Error(`edit failed: old string is not unique in ${filePath}`);
  }

  const updated =
    content.slice(0, firstMatch) +
    newString +
    content.slice(firstMatch + oldString.length);
  writeFileSync(targetPath, updated, "utf8");

  return { content: `Edited ${filePath}` };
}
