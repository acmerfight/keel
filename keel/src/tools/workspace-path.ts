import { existsSync, lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { KeelError } from "../core/error.ts";
import { createProjectIgnorePolicy } from "./project-ignore.ts";

type FileToolName = "edit" | "glob" | "grep" | "read" | "write";

export interface WorkspaceTarget {
  readonly workspacePath: string;
  readonly requestedPath: string;
  readonly targetPath: string;
}

export interface WorkspaceCreateTarget {
  readonly workspacePath: string;
  readonly requestedPath: string;
  readonly targetPath: string;
  readonly parentPath: string;
}

export function isInsideWorkspace(workspace: string, target: string): boolean {
  const targetFromWorkspace = relative(workspace, target);
  return (
    targetFromWorkspace === "" ||
    (!targetFromWorkspace.startsWith("..") && !isAbsolute(targetFromWorkspace))
  );
}

function remapRequestedPath(
  workspacePath: string,
  workspaceLogicalPath: string,
  requestedPath: string,
): string {
  const rawAbsolutePath = isAbsolute(requestedPath)
    ? resolve(requestedPath)
    : resolve(workspacePath, requestedPath);

  if (
    isAbsolute(requestedPath) &&
    !isInsideWorkspace(workspacePath, rawAbsolutePath) &&
    isInsideWorkspace(workspaceLogicalPath, rawAbsolutePath)
  ) {
    return resolve(
      workspacePath,
      relative(workspaceLogicalPath, rawAbsolutePath),
    );
  }

  return rawAbsolutePath;
}

function outsideWorkspaceError(
  toolName: FileToolName,
  requestedPath: string,
): KeelError {
  return new KeelError(
    "tool_path_outside_workspace",
    `${toolName} failed: path is outside the workspace: ${requestedPath}`,
    "Use a workspace-relative path under the current workspace.",
  );
}

function ignoredPathError(
  toolName: FileToolName,
  requestedPath: string,
): KeelError {
  return new KeelError(
    "tool_path_ignored",
    `${toolName} failed: ignored path: ${requestedPath}`,
    "This file is excluded by project .gitignore. Choose a different file that is not ignored.",
  );
}

function fileExistsError(
  toolName: FileToolName,
  requestedPath: string,
): KeelError {
  return new KeelError(
    "tool_file_exists",
    `${toolName} failed: file already exists: ${requestedPath}`,
    "Use edit to modify the existing file instead of write, or choose a different file name.",
  );
}

function notDirectoryError(
  toolName: FileToolName,
  requestedPath: string,
): KeelError {
  return new KeelError(
    "tool_not_directory",
    `${toolName} failed: parent path is not a directory: ${requestedPath}`,
    "The parent path is a file, not a directory. Choose a different path.",
  );
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function pathExistsForCreate(
  targetPath: string,
  toolName: FileToolName,
  requestedPath: string,
): boolean {
  try {
    lstatSync(targetPath);
    return true;
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") return false;
    if (isErrnoException(error) && error.code === "ENOTDIR") {
      throw notDirectoryError(toolName, requestedPath);
    }
    throw error;
  }
}

function deepestExistingAncestor(
  targetPath: string,
  toolName: FileToolName,
  requestedPath: string,
): string {
  let currentPath = targetPath;
  while (!pathExistsForCreate(currentPath, toolName, requestedPath)) {
    currentPath = dirname(currentPath);
  }
  return currentPath;
}

export function resolveWorkspaceTarget(
  workspace: string,
  requestedPath: string,
  toolName: FileToolName,
): WorkspaceTarget {
  const workspacePath = realpathSync(workspace);
  const workspaceLogicalPath = resolve(workspace);
  const absoluteRequestedPath = isAbsolute(requestedPath)
    ? resolve(requestedPath)
    : resolve(workspacePath, requestedPath);

  if (
    !isInsideWorkspace(workspacePath, absoluteRequestedPath) &&
    !isInsideWorkspace(workspaceLogicalPath, absoluteRequestedPath)
  ) {
    throw outsideWorkspaceError(toolName, requestedPath);
  }

  const projectIgnorePolicy = createProjectIgnorePolicy(workspacePath);
  const requestIsWorkspaceRoot = absoluteRequestedPath === workspacePath;
  if (
    !requestIsWorkspaceRoot &&
    projectIgnorePolicy.isIgnored(absoluteRequestedPath, false)
  ) {
    throw ignoredPathError(toolName, requestedPath);
  }

  if (!existsSync(absoluteRequestedPath)) {
    if (
      !requestIsWorkspaceRoot &&
      projectIgnorePolicy.isIgnored(absoluteRequestedPath, true)
    ) {
      throw ignoredPathError(toolName, requestedPath);
    }
    throw new KeelError(
      "tool_file_not_found",
      `${toolName} failed: file not found: ${requestedPath}`,
      "Use grep to search for the content, or check the directory structure to find the correct path.",
    );
  }

  const targetPath = realpathSync(absoluteRequestedPath);
  if (!isInsideWorkspace(workspacePath, targetPath)) {
    throw outsideWorkspaceError(toolName, requestedPath);
  }

  return { workspacePath, requestedPath: absoluteRequestedPath, targetPath };
}

export function resolveWorkspaceCreateTarget(
  workspace: string,
  requestedPath: string,
  toolName: FileToolName,
): WorkspaceCreateTarget {
  const workspacePath = realpathSync(workspace);
  const workspaceLogicalPath = resolve(workspace);
  const absoluteRequestedPath = remapRequestedPath(
    workspacePath,
    workspaceLogicalPath,
    requestedPath,
  );

  if (
    !isInsideWorkspace(workspacePath, absoluteRequestedPath) &&
    !isInsideWorkspace(workspaceLogicalPath, absoluteRequestedPath)
  ) {
    throw outsideWorkspaceError(toolName, requestedPath);
  }

  const projectIgnorePolicy = createProjectIgnorePolicy(workspacePath);
  const requestIsWorkspaceRoot = absoluteRequestedPath === workspacePath;
  if (
    !requestIsWorkspaceRoot &&
    (projectIgnorePolicy.isIgnored(absoluteRequestedPath, false) ||
      projectIgnorePolicy.isIgnored(absoluteRequestedPath, true))
  ) {
    throw ignoredPathError(toolName, requestedPath);
  }

  if (pathExistsForCreate(absoluteRequestedPath, toolName, requestedPath)) {
    throw fileExistsError(toolName, requestedPath);
  }

  const parentPath = dirname(absoluteRequestedPath);
  const existingAncestorPath = deepestExistingAncestor(
    parentPath,
    toolName,
    requestedPath,
  );
  const existingAncestorRealPath = realpathSync(existingAncestorPath);
  if (!isInsideWorkspace(workspacePath, existingAncestorRealPath)) {
    throw outsideWorkspaceError(toolName, requestedPath);
  }
  const existingAncestorStat = lstatSync(existingAncestorRealPath);
  if (!existingAncestorStat.isDirectory()) {
    throw notDirectoryError(toolName, requestedPath);
  }

  return {
    workspacePath,
    requestedPath: absoluteRequestedPath,
    targetPath: absoluteRequestedPath,
    parentPath,
  };
}
