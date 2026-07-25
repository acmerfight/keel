import {
  type Dirent,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  type Stats,
  statSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { KeelError } from "../core/error.ts";
import { createProjectIgnorePolicy } from "./project-ignore.ts";

export type FileToolName =
  | "apply_patch"
  | "edit"
  | "glob"
  | "grep"
  | "ls"
  | "read"
  | "write";

export interface WorkspaceTarget {
  readonly workspacePath: string;
  readonly requestedPath: string;
  readonly targetPath: string;
}

export interface WorkspaceCreateTarget {
  readonly workspacePath: string;
  readonly requestedPath: string;
  readonly targetPath: string;
  readonly resolvedTargetPath: string;
  readonly parentPath: string;
}

export type WorkspaceCreateTargetResolution =
  | {
      readonly ok: true;
      readonly target: WorkspaceCreateTarget;
    }
  | {
      readonly ok: false;
      readonly error: KeelError;
    };

export interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
}

interface WorkspaceAccessTargetInput {
  readonly workspacePath: string;
  readonly targetPath: string;
  readonly toolName: FileToolName;
  readonly requestedPath: string;
}

interface WorkspaceOpenTargetInput extends WorkspaceAccessTargetInput {
  readonly fd: number;
}

interface WorkspaceIdentityTargetInput extends WorkspaceAccessTargetInput {
  readonly identity: FileIdentity;
}

interface WorkspaceCreateTargetAccessInput extends WorkspaceAccessTargetInput {
  readonly parentPath: string;
}

interface WorkspaceParentDirectoriesInput {
  readonly workspacePath: string;
  readonly parentPath: string;
  readonly toolName: FileToolName;
  readonly requestedPath: string;
}

export function isInsideWorkspace(workspace: string, target: string): boolean {
  const targetFromWorkspace = relative(workspace, target);
  return (
    targetFromWorkspace === "" ||
    (!targetFromWorkspace.startsWith("..") && !isAbsolute(targetFromWorkspace))
  );
}

export function assertWorkspaceTargetAtAccess(
  input: WorkspaceAccessTargetInput,
): string {
  const targetRealPath = realpathSync(input.targetPath);
  if (!isInsideWorkspace(input.workspacePath, targetRealPath)) {
    throw outsideWorkspaceError(input.toolName, input.requestedPath);
  }
  return targetRealPath;
}

export function sameFileIdentity(
  left: FileIdentity,
  right: FileIdentity,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

export function fileIdentityFromStats(stat: Stats): FileIdentity {
  return { dev: stat.dev, ino: stat.ino };
}

export function findWorkspacePathsByIdentity(
  workspacePath: string,
  identity: FileIdentity,
): readonly string[] {
  const found: string[] = [];
  const pending = [workspacePath];
  for (const directory of pending) {
    let entries: Dirent<string>[];
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const entryPath = join(directory, entry.name);
      let entryStat: ReturnType<typeof lstatSync>;
      try {
        entryStat = lstatSync(entryPath);
      } catch {
        continue;
      }
      if (entryStat.isSymbolicLink()) continue;
      if (sameFileIdentity(fileIdentityFromStats(entryStat), identity)) {
        found.push(entryPath);
      }
      if (entryStat.isDirectory()) pending.push(entryPath);
    }
  }
  return found;
}

export function assertWorkspaceOpenTargetAtAccess(
  input: WorkspaceOpenTargetInput,
): string {
  const targetRealPath = assertWorkspaceTargetAtAccess(input);
  const targetStat = statSync(targetRealPath);
  const openedStat = fstatSync(input.fd);
  if (!openedStat.isFile() || !targetStat.isFile()) {
    throw unsupportedPathTypeError(input.toolName, input.requestedPath);
  }
  if (
    !sameFileIdentity(
      fileIdentityFromStats(openedStat),
      fileIdentityFromStats(targetStat),
    )
  ) {
    throw outsideWorkspaceError(input.toolName, input.requestedPath);
  }
  return targetRealPath;
}

export function assertWorkspaceFileIdentityAtAccess(
  input: WorkspaceIdentityTargetInput,
): string {
  const targetRealPath = assertWorkspaceTargetAtAccess(input);
  const targetStat = statSync(targetRealPath);
  if (!targetStat.isFile()) {
    throw unsupportedPathTypeError(input.toolName, input.requestedPath);
  }
  if (!sameFileIdentity(fileIdentityFromStats(targetStat), input.identity)) {
    throw outsideWorkspaceError(input.toolName, input.requestedPath);
  }
  return targetRealPath;
}

export function resolveWorkspaceCreateTargetAtAccess(
  input: WorkspaceCreateTargetAccessInput,
): string {
  const parentRealPath = realpathSync(input.parentPath);
  if (!isInsideWorkspace(input.workspacePath, parentRealPath)) {
    throw outsideWorkspaceError(input.toolName, input.requestedPath);
  }
  return resolve(parentRealPath, basename(input.targetPath));
}

function workspaceParentSegments(
  input: WorkspaceParentDirectoriesInput,
): readonly string[] {
  const parentFromWorkspace = relative(input.workspacePath, input.parentPath);
  if (parentFromWorkspace === "") return [];
  /* v8 ignore next 3: resolveWorkspaceCreateTarget constrains parentPath before parent creation. */
  if (parentFromWorkspace.startsWith("..") || isAbsolute(parentFromWorkspace)) {
    throw outsideWorkspaceError(input.toolName, input.requestedPath);
  }
  return parentFromWorkspace.split(sep).filter((segment) => segment !== "");
}

function childEntryExistsForParentCreate(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

function createChildDirectory(
  path: string,
  input: WorkspaceParentDirectoriesInput,
): boolean {
  try {
    mkdirSync(path);
    return true;
  } catch (error) {
    if (isErrnoException(error) && error.code === "EEXIST") return false;
    if (isErrnoException(error) && error.code === "ENOTDIR") {
      throw notDirectoryError(input.toolName, input.requestedPath);
    }
    throw error;
  }
}

function childDirectoryRealPath(
  path: string,
  input: WorkspaceParentDirectoriesInput,
): string {
  try {
    const realPath = realpathSync(path);
    if (!isInsideWorkspace(input.workspacePath, realPath)) {
      throw outsideWorkspaceError(input.toolName, input.requestedPath);
    }
    const stat = statSync(realPath);
    if (!stat.isDirectory()) {
      throw notDirectoryError(input.toolName, input.requestedPath);
    }
    return realPath;
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOTDIR") {
      throw notDirectoryError(input.toolName, input.requestedPath);
    }
    throw error;
  }
}

export function createWorkspaceParentDirectories(
  input: WorkspaceParentDirectoriesInput,
): readonly string[] {
  const segments = workspaceParentSegments(input);
  const createdDirectories: string[] = [];
  let currentPath = input.workspacePath;
  try {
    for (const segment of segments) {
      const childPath = join(currentPath, segment);
      let createdDirectory = false;
      if (!childEntryExistsForParentCreate(childPath)) {
        createdDirectory = createChildDirectory(childPath, input);
      }
      if (createdDirectory) {
        createdDirectories.push(childPath);
      }
      currentPath = childDirectoryRealPath(childPath, input);
    }
  } catch (error) {
    rollbackWorkspaceParentDirectoriesBestEffort(createdDirectories);
    throw error;
  }
  return createdDirectories;
}

export function rollbackWorkspaceParentDirectoriesBestEffort(
  createdDirectories: readonly string[],
): void {
  for (const directory of createdDirectories.toReversed()) {
    try {
      rmdirSync(directory);
    } catch {
      // Concurrent content or path replacement makes this directory unowned.
    }
  }
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

function unsupportedPathTypeError(
  toolName: FileToolName,
  requestedPath: string,
): KeelError {
  if (toolName === "glob" || toolName === "ls") {
    return new KeelError(
      "tool_not_directory",
      `${toolName} failed: not a directory: ${requestedPath}`,
      "Use a workspace directory path.",
    );
  }
  if (toolName === "grep") {
    return new KeelError(
      "tool_not_file",
      `grep failed: not a file or directory: ${requestedPath}`,
      "The path is neither a file nor a directory. Verify the path exists.",
    );
  }
  return new KeelError(
    "tool_not_file",
    `${toolName} failed: unsupported file type: ${requestedPath}`,
    "Use a regular file or directory path inside the workspace.",
  );
}

function assertSupportedWorkspaceEntry(
  targetPath: string,
  toolName: FileToolName,
  requestedPath: string,
): void {
  const targetStat = statSync(targetPath);
  if (!targetStat.isFile() && !targetStat.isDirectory()) {
    throw unsupportedPathTypeError(toolName, requestedPath);
  }
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
    if (projectIgnorePolicy.isIgnored(absoluteRequestedPath, true)) {
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
  assertSupportedWorkspaceEntry(targetPath, toolName, requestedPath);

  return { workspacePath, requestedPath: absoluteRequestedPath, targetPath };
}

function ignoredCreatePath(
  projectIgnorePolicy: ReturnType<typeof createProjectIgnorePolicy>,
  path: string,
): boolean {
  return (
    projectIgnorePolicy.isIgnored(path, false) ||
    projectIgnorePolicy.isIgnored(path, true)
  );
}

function resolveWorkspaceCreateTargetUnsafe(
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
    ignoredCreatePath(projectIgnorePolicy, absoluteRequestedPath)
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
  const targetFromExistingAncestor = relative(
    existingAncestorPath,
    absoluteRequestedPath,
  );
  const resolvedTargetPath = resolve(
    existingAncestorRealPath,
    targetFromExistingAncestor,
  );
  if (ignoredCreatePath(projectIgnorePolicy, resolvedTargetPath)) {
    throw ignoredPathError(toolName, requestedPath);
  }

  return {
    workspacePath,
    requestedPath: absoluteRequestedPath,
    targetPath: absoluteRequestedPath,
    resolvedTargetPath,
    parentPath,
  };
}

export function resolveWorkspaceCreateTargetCore(
  workspace: string,
  requestedPath: string,
  toolName: FileToolName,
): WorkspaceCreateTargetResolution {
  try {
    return {
      ok: true,
      target: resolveWorkspaceCreateTargetUnsafe(
        workspace,
        requestedPath,
        toolName,
      ),
    };
  } catch (error) {
    if (error instanceof KeelError) return { ok: false, error };
    throw error;
  }
}

export function resolveWorkspaceCreateTarget(
  workspace: string,
  requestedPath: string,
  toolName: FileToolName,
): WorkspaceCreateTarget {
  const resolution = resolveWorkspaceCreateTargetCore(
    workspace,
    requestedPath,
    toolName,
  );
  if (!resolution.ok) throw resolution.error;
  return resolution.target;
}
