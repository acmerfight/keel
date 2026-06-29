import { KeelError } from "../core/error.ts";
import {
  type RecordLastBatchCheckpointOperation,
  recordLastCreateCheckpoint,
} from "../core/git.ts";
import { createTextFileAtomically } from "./atomic-write.ts";
import { createProjectIgnorePolicy } from "./project-ignore.ts";
import type { ProjectInstructionVisibilityState } from "./scoped-project-instructions.ts";
import type { ToolResult } from "./types.ts";
import {
  assertWorkspaceFileIdentityAtAccess,
  assertWorkspaceOpenTargetAtAccess,
  createWorkspaceParentDirectories,
  type FileIdentity,
  findWorkspacePathsByIdentity,
  resolveWorkspaceCreateTarget,
  resolveWorkspaceCreateTargetAtAccess,
  rollbackWorkspaceParentDirectoriesBestEffort,
} from "./workspace-path.ts";

interface WriteToolResult extends ToolResult {
  readonly targetPath: string;
  readonly checkpointOperation: RecordLastBatchCheckpointOperation;
}

interface WriteToolOptions {
  readonly projectInstructions?: ProjectInstructionVisibilityState;
}

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
  options: WriteToolOptions = {},
): WriteToolResult {
  const { workspacePath, targetPath, resolvedTargetPath, parentPath } =
    resolveWorkspaceCreateTarget(workspace, filePath, "write");
  options.projectInstructions?.assertMutationAllowed([
    targetPath,
    resolvedTargetPath,
  ]);

  const createdParentDirectories = createWorkspaceParentDirectories({
    workspacePath,
    parentPath,
    toolName: "write",
    requestedPath: filePath,
  });

  try {
    const projectIgnorePolicy = createProjectIgnorePolicy(workspacePath);
    const realTargetPath = resolveWorkspaceCreateTargetAtAccess({
      workspacePath,
      parentPath,
      targetPath,
      toolName: "write",
      requestedPath: filePath,
    });
    if (projectIgnorePolicy.isIgnored(realTargetPath, false)) {
      throw ignoredPathError(filePath);
    }
    options.projectInstructions?.assertMutationAllowed([realTargetPath]);

    const validateTargetAtAccess = (): string => {
      const accessTargetPath = resolveWorkspaceCreateTargetAtAccess({
        workspacePath,
        parentPath,
        targetPath,
        toolName: "write",
        requestedPath: filePath,
      });
      if (projectIgnorePolicy.isIgnored(accessTargetPath, false)) {
        throw ignoredPathError(filePath);
      }
      options.projectInstructions?.assertMutationAllowed([accessTargetPath]);
      return accessTargetPath;
    };
    const validateOpenedTempAtAccess = (tempPath: string, fd: number): void => {
      assertWorkspaceOpenTargetAtAccess({
        fd,
        workspacePath,
        targetPath: tempPath,
        toolName: "write",
        requestedPath: filePath,
      });
    };
    let publishedTargetPath = realTargetPath;
    const validatePublishedTargetAtAccess = (
      publishedPath: string,
      identity: FileIdentity,
    ): void => {
      const accessTargetPath = assertWorkspaceFileIdentityAtAccess({
        identity,
        workspacePath,
        targetPath: publishedPath,
        toolName: "write",
        requestedPath: filePath,
      });
      if (projectIgnorePolicy.isIgnored(accessTargetPath, false)) {
        throw ignoredPathError(filePath);
      }
      options.projectInstructions?.assertMutationAllowed([accessTargetPath]);
      publishedTargetPath = accessTargetPath;
    };

    createTextFileAtomically(realTargetPath, content, {
      beforeAccess: validateTargetAtAccess,
      beforeWrite: validateOpenedTempAtAccess,
      beforePublish: validateTargetAtAccess,
      afterPublish: validatePublishedTargetAtAccess,
      cleanupPathsByIdentity: (identity) =>
        findWorkspacePathsByIdentity(workspacePath, identity),
    });

    const createdPath = publishedTargetPath;
    recordLastCreateCheckpoint({
      workspace: workspacePath,
      filePath: createdPath,
      afterContent: content,
    });

    return {
      content: `Wrote ${filePath}`,
      targetPath: createdPath,
      checkpointOperation: {
        operation: "create",
        filePath: createdPath,
        afterContent: content,
      },
    };
  } catch (error) {
    rollbackWorkspaceParentDirectoriesBestEffort(createdParentDirectories);
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
}
