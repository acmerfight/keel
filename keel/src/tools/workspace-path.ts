import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { KeelError } from "../core/error.ts";

type FileToolName = "edit" | "grep" | "read";

export interface WorkspaceTarget {
  readonly workspacePath: string;
  readonly requestedPath: string;
  readonly targetPath: string;
}

function isInsideWorkspace(workspace: string, target: string): boolean {
  const targetFromWorkspace = relative(workspace, target);
  return (
    targetFromWorkspace === "" ||
    (!targetFromWorkspace.startsWith("..") && !isAbsolute(targetFromWorkspace))
  );
}

function outsideWorkspaceError(
  toolName: FileToolName,
  requestedPath: string,
): KeelError {
  return new KeelError(
    "tool_path_outside_workspace",
    `${toolName} failed: path is outside the workspace: ${requestedPath}`,
  );
}

export function resolveWorkspaceTarget(
  workspace: string,
  requestedPath: string,
  toolName: FileToolName,
): WorkspaceTarget {
  const workspacePath = realpathSync(workspace);
  const workspaceInputPath = resolve(workspace);
  const absoluteRequestedPath = isAbsolute(requestedPath)
    ? resolve(requestedPath)
    : resolve(workspacePath, requestedPath);

  if (
    !isInsideWorkspace(workspacePath, absoluteRequestedPath) &&
    !isInsideWorkspace(workspaceInputPath, absoluteRequestedPath)
  ) {
    throw outsideWorkspaceError(toolName, requestedPath);
  }

  if (!existsSync(absoluteRequestedPath)) {
    throw new KeelError(
      "tool_file_not_found",
      `${toolName} failed: file not found: ${requestedPath}`,
    );
  }

  const targetPath = realpathSync(absoluteRequestedPath);
  if (!isInsideWorkspace(workspacePath, targetPath)) {
    throw outsideWorkspaceError(toolName, requestedPath);
  }

  return { workspacePath, requestedPath: absoluteRequestedPath, targetPath };
}
