import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { ToolResult } from "./types.ts";

function isInsideWorkspace(workspace: string, target: string): boolean {
  const targetFromWorkspace = relative(workspace, target);
  return (
    targetFromWorkspace === "" ||
    (!targetFromWorkspace.startsWith("..") && !isAbsolute(targetFromWorkspace))
  );
}

export function executeRead(workspace: string, filePath: string): ToolResult {
  const workspacePath = realpathSync(workspace);
  const requestedPath = isAbsolute(filePath)
    ? resolve(filePath)
    : resolve(workspacePath, filePath);
  if (!existsSync(requestedPath)) {
    throw new Error(`read failed: file not found: ${filePath}`);
  }

  const targetPath = realpathSync(requestedPath);

  if (!isInsideWorkspace(workspacePath, targetPath)) {
    throw new Error(`read failed: path is outside the workspace: ${filePath}`);
  }

  return { content: readFileSync(targetPath, "utf8") };
}
