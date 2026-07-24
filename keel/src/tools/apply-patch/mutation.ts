import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  rmSync,
} from "node:fs";
import { KeelError } from "../../core/error.ts";
import {
  type AtomicWriteResult,
  createTextFileAtomically,
  writeTextFileAtomically,
} from "../atomic-write.ts";
import {
  createFileRevisionAccumulator,
  type FileRevision,
} from "../file-revision.ts";
import { createProjectIgnorePolicy } from "../project-ignore.ts";
import type { ProjectInstructionVisibilityState } from "../scoped-project-instructions.ts";
import {
  assertWorkspaceFileIdentityAtAccess,
  assertWorkspaceOpenTargetAtAccess,
  assertWorkspaceTargetAtAccess,
  createWorkspaceParentDirectories,
  type FileIdentity,
  findWorkspacePathsByIdentity,
  resolveWorkspaceCreateTargetAtAccess,
  rollbackWorkspaceParentDirectoriesBestEffort,
  sameFileIdentity,
} from "../workspace-path.ts";
import { assertPreparedFileRevision } from "./errors.ts";
import {
  changedTargetError,
  isErrnoException,
  pathHasIdentity,
  readFileIfPossible,
} from "./filesystem.ts";
import type {
  AppliedPatchOperation,
  ExecuteApplyPatchOptions,
  PreparedPatchOperation,
} from "./model.ts";

type RevisionBoundSourceOperation = Extract<
  PreparedPatchOperation,
  { readonly kind: "copy" | "delete" | "move" }
>;
const REVISION_CHUNK_BYTES = 64 * 1024;

function fileRevisionFromDescriptor(fd: number): FileRevision {
  const revision = createFileRevisionAccumulator();
  const chunk = Buffer.allocUnsafe(REVISION_CHUNK_BYTES);
  let position = 0;
  while (true) {
    const bytesRead = readSync(fd, chunk, 0, chunk.length, position);
    if (bytesRead === 0) return revision.finish();
    revision.update(chunk.subarray(0, bytesRead));
    position += bytesRead;
  }
}

function sourceRevision(operation: RevisionBoundSourceOperation): FileRevision {
  return operation.kind === "copy"
    ? operation.sourceFileRevision
    : operation.fileRevision;
}

function sourceTargetPath(operation: RevisionBoundSourceOperation): string {
  return operation.kind === "copy"
    ? operation.sourceTargetPath
    : operation.targetPath;
}

function sourceDisplayPath(operation: RevisionBoundSourceOperation): string {
  return operation.kind === "copy" ? operation.sourcePath : operation.path;
}

function sourceIdentity(operation: RevisionBoundSourceOperation): FileIdentity {
  return operation.kind === "copy"
    ? operation.sourceIdentity
    : operation.targetIdentity;
}

function changedSourceError(
  operation: RevisionBoundSourceOperation,
): KeelError {
  if (operation.kind !== "copy") return changedTargetError(operation);
  return new KeelError(
    "tool_path_outside_workspace",
    `apply_patch failed: path changed outside the verified workspace target: ${operation.sourcePath}`,
    "Retry after ensuring the target path remains stable within the workspace.",
  );
}

function assertSourceRevisionCurrent(
  operation: RevisionBoundSourceOperation,
  options: ExecuteApplyPatchOptions,
): void {
  const targetPath = sourceTargetPath(operation);
  const displayPath = sourceDisplayPath(operation);
  let fd: number;
  try {
    fd = openSync(targetPath, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch {
    throw changedSourceError(operation);
  }
  try {
    if (!sameFileIdentity(fstatSync(fd), sourceIdentity(operation))) {
      throw changedSourceError(operation);
    }
    assertPreparedFileRevision(
      options.readBeforeEdit,
      targetPath,
      displayPath,
      sourceRevision(operation),
      fileRevisionFromDescriptor(fd),
    );
  } finally {
    closeSync(fd);
  }
}

function validateCreateTargetAfterMkdir(
  operation:
    | Extract<PreparedPatchOperation, { readonly kind: "add" | "copy" }>
    | {
        readonly workspacePath: string;
        readonly parentPath: string;
        readonly targetPath: string;
        readonly path: string;
      },
  projectInstructions: ProjectInstructionVisibilityState | undefined,
): string {
  const realTargetPath = resolveWorkspaceCreateTargetAtAccess({
    workspacePath: operation.workspacePath,
    parentPath: operation.parentPath,
    targetPath: operation.targetPath,
    toolName: "apply_patch",
    requestedPath: operation.path,
  });
  const projectIgnorePolicy = createProjectIgnorePolicy(
    operation.workspacePath,
  );
  if (projectIgnorePolicy.isIgnored(realTargetPath, false)) {
    throw new KeelError(
      "tool_path_ignored",
      `apply_patch failed: ignored path: ${operation.path}`,
      "This file is excluded by project .gitignore. Choose a different file that is not ignored.",
    );
  }
  projectInstructions?.assertMutationAllowed([realTargetPath]);
  return realTargetPath;
}

export function applyPreparedOperation(
  operation: PreparedPatchOperation,
  options: ExecuteApplyPatchOptions,
): AppliedPatchOperation {
  if (operation.kind === "add" || operation.kind === "copy") {
    if (operation.kind === "copy") {
      assertSourceRevisionCurrent(operation, options);
    }
    const createdParentDirectories = createWorkspaceParentDirectories({
      workspacePath: operation.workspacePath,
      parentPath: operation.parentPath,
      toolName: "apply_patch",
      requestedPath: operation.path,
    });
    try {
      const realTargetPath = validateCreateTargetAfterMkdir(
        operation,
        options.projectInstructions,
      );
      const validateTargetAtAccess = (): void => {
        validateCreateTargetAfterMkdir(operation, options.projectInstructions);
      };
      const validateOpenedTempAtAccess = (
        tempPath: string,
        fd: number,
      ): void => {
        assertWorkspaceOpenTargetAtAccess({
          fd,
          workspacePath: operation.workspacePath,
          targetPath: tempPath,
          toolName: "apply_patch",
          requestedPath: operation.path,
        });
      };
      let publishedTargetPath = realTargetPath;
      const validatePublishedTargetAtAccess = (
        publishedPath: string,
        identity: FileIdentity,
      ): void => {
        const accessTargetPath = assertWorkspaceFileIdentityAtAccess({
          identity,
          workspacePath: operation.workspacePath,
          targetPath: publishedPath,
          toolName: "apply_patch",
          requestedPath: operation.path,
        });
        const projectIgnorePolicy = createProjectIgnorePolicy(
          operation.workspacePath,
        );
        if (projectIgnorePolicy.isIgnored(accessTargetPath, false)) {
          throw new KeelError(
            "tool_path_ignored",
            `apply_patch failed: ignored path: ${operation.path}`,
            "This file is excluded by project .gitignore. Choose a different file that is not ignored.",
          );
        }
        options.projectInstructions?.assertMutationAllowed([accessTargetPath]);
        publishedTargetPath = accessTargetPath;
      };
      const createOptions =
        operation.kind === "copy"
          ? {
              mode: operation.mode,
            }
          : operation.mode === null
            ? {}
            : { mode: operation.mode };
      const validateBeforePublish =
        operation.kind === "copy"
          ? (): void => {
              validateTargetAtAccess();
              assertSourceRevisionCurrent(operation, options);
            }
          : validateTargetAtAccess;
      const result = createTextFileAtomically(
        realTargetPath,
        operation.afterContent,
        {
          ...createOptions,
          beforeAccess: validateTargetAtAccess,
          beforeWrite: validateOpenedTempAtAccess,
          beforePublish: validateBeforePublish,
          afterPublish: validatePublishedTargetAtAccess,
          cleanupPathsByIdentity: (identity) =>
            findWorkspacePathsByIdentity(operation.workspacePath, identity),
        },
      );
      return {
        ...operation,
        targetPath: publishedTargetPath,
        appliedIdentity: result.identity,
        createdParentDirectories,
      };
    } catch (error) {
      rollbackWorkspaceParentDirectoriesBestEffort(createdParentDirectories);
      if (isErrnoException(error) && error.code === "EEXIST") {
        throw new KeelError(
          "tool_file_exists",
          `apply_patch failed: file already exists: ${operation.path}`,
          operation.kind === "copy"
            ? "Read the existing file and use an Update File hunk instead of copying over it."
            : "Read the existing file and use an Update File hunk instead of Add File.",
        );
      }
      throw error;
    }
  }

  const projectIgnorePolicy = createProjectIgnorePolicy(
    operation.workspacePath,
  );
  if (operation.kind === "move") {
    assertSourceRevisionCurrent(operation, options);
    const createdDestinationParentDirectories =
      createWorkspaceParentDirectories({
        workspacePath: operation.workspacePath,
        parentPath: operation.destinationParentPath,
        toolName: "apply_patch",
        requestedPath: operation.movePath,
      });
    try {
      const destinationCreateTarget = {
        workspacePath: operation.workspacePath,
        parentPath: operation.destinationParentPath,
        targetPath: operation.destinationTargetPath,
        path: operation.movePath,
      };
      const realDestinationPath = validateCreateTargetAfterMkdir(
        destinationCreateTarget,
        options.projectInstructions,
      );
      const validateDestinationAtAccess = (): void => {
        validateCreateTargetAfterMkdir(
          destinationCreateTarget,
          options.projectInstructions,
        );
      };
      const validateOpenedTempAtAccess = (
        tempPath: string,
        fd: number,
      ): void => {
        assertWorkspaceOpenTargetAtAccess({
          fd,
          workspacePath: operation.workspacePath,
          targetPath: tempPath,
          toolName: "apply_patch",
          requestedPath: operation.movePath,
        });
      };
      let publishedDestinationPath = realDestinationPath;
      const validatePublishedDestinationAtAccess = (
        publishedPath: string,
        identity: FileIdentity,
      ): void => {
        const accessTargetPath = assertWorkspaceFileIdentityAtAccess({
          identity,
          workspacePath: operation.workspacePath,
          targetPath: publishedPath,
          toolName: "apply_patch",
          requestedPath: operation.movePath,
        });
        if (projectIgnorePolicy.isIgnored(accessTargetPath, false)) {
          throw new KeelError(
            "tool_path_ignored",
            `apply_patch failed: ignored path: ${operation.movePath}`,
            "This file is excluded by project .gitignore. Choose a different file that is not ignored.",
          );
        }
        options.projectInstructions?.assertMutationAllowed([accessTargetPath]);
        publishedDestinationPath = accessTargetPath;
      };
      let result: AtomicWriteResult;
      try {
        result = createTextFileAtomically(
          realDestinationPath,
          operation.afterContent,
          {
            mode: operation.mode,
            beforeAccess: validateDestinationAtAccess,
            beforeWrite: validateOpenedTempAtAccess,
            beforePublish: () => {
              validateDestinationAtAccess();
              assertSourceRevisionCurrent(operation, options);
            },
            afterPublish: validatePublishedDestinationAtAccess,
            cleanupPathsByIdentity: (identity) =>
              findWorkspacePathsByIdentity(operation.workspacePath, identity),
          },
        );
      } catch (error) {
        if (isErrnoException(error) && error.code === "EEXIST") {
          throw new KeelError(
            "tool_file_exists",
            `apply_patch failed: file already exists: ${operation.movePath}`,
            "Read the existing file and use an Update File hunk instead of moving over it.",
          );
        }
        throw error;
      }

      try {
        const accessTargetPath = assertWorkspaceTargetAtAccess({
          workspacePath: operation.workspacePath,
          targetPath: operation.targetPath,
          toolName: "apply_patch",
          requestedPath: operation.path,
        });
        if (projectIgnorePolicy.isIgnored(accessTargetPath, false)) {
          throw new KeelError(
            "tool_path_ignored",
            `apply_patch failed: ignored path: ${operation.path}`,
            "This file is excluded by project .gitignore. Choose a different file that is not ignored.",
          );
        }
        options.projectInstructions?.assertMutationAllowed([accessTargetPath]);
        if (!pathHasIdentity(accessTargetPath, operation.targetIdentity)) {
          throw changedTargetError(operation);
        }
        assertSourceRevisionCurrent(operation, options);
        rmSync(accessTargetPath);
        return {
          ...operation,
          targetPath: accessTargetPath,
          destinationTargetPath: publishedDestinationPath,
          destinationIdentity: result.identity,
          createdDestinationParentDirectories,
        };
      } catch (error) {
        if (
          pathHasIdentity(publishedDestinationPath, result.identity) &&
          readFileIfPossible(publishedDestinationPath) ===
            operation.afterContent
        ) {
          rmSync(publishedDestinationPath, { force: true });
        }
        throw error;
      }
    } catch (error) {
      rollbackWorkspaceParentDirectoriesBestEffort(
        createdDestinationParentDirectories,
      );
      throw error;
    }
  }

  if (operation.kind === "delete") {
    const accessTargetPath = assertWorkspaceTargetAtAccess({
      workspacePath: operation.workspacePath,
      targetPath: operation.targetPath,
      toolName: "apply_patch",
      requestedPath: operation.path,
    });
    if (projectIgnorePolicy.isIgnored(accessTargetPath, false)) {
      throw new KeelError(
        "tool_path_ignored",
        `apply_patch failed: ignored path: ${operation.path}`,
        "This file is excluded by project .gitignore. Choose a different file that is not ignored.",
      );
    }
    options.projectInstructions?.assertMutationAllowed([accessTargetPath]);
    if (!pathHasIdentity(accessTargetPath, operation.targetIdentity)) {
      throw changedTargetError(operation);
    }
    assertSourceRevisionCurrent(operation, options);
    rmSync(accessTargetPath);
    return {
      ...operation,
      targetPath: accessTargetPath,
      appliedIdentity: operation.targetIdentity,
    };
  }

  const validateTargetAtAccess = (): string => {
    const accessTargetPath = assertWorkspaceTargetAtAccess({
      workspacePath: operation.workspacePath,
      targetPath: operation.targetPath,
      toolName: "apply_patch",
      requestedPath: operation.path,
    });
    if (projectIgnorePolicy.isIgnored(accessTargetPath, false)) {
      throw new KeelError(
        "tool_path_ignored",
        `apply_patch failed: ignored path: ${operation.path}`,
        "This file is excluded by project .gitignore. Choose a different file that is not ignored.",
      );
    }
    return accessTargetPath;
  };
  const validateOpenedTempAtAccess = (tempPath: string, fd: number): void => {
    assertWorkspaceOpenTargetAtAccess({
      fd,
      workspacePath: operation.workspacePath,
      targetPath: tempPath,
      toolName: "apply_patch",
      requestedPath: operation.path,
    });
  };
  let publishedTargetPath = operation.targetPath;
  const validatePublishedTargetAtAccess = (
    publishedPath: string,
    identity: FileIdentity,
  ): void => {
    const accessTargetPath = assertWorkspaceFileIdentityAtAccess({
      identity,
      workspacePath: operation.workspacePath,
      targetPath: publishedPath,
      toolName: "apply_patch",
      requestedPath: operation.path,
    });
    if (projectIgnorePolicy.isIgnored(accessTargetPath, false)) {
      throw new KeelError(
        "tool_path_ignored",
        `apply_patch failed: ignored path: ${operation.path}`,
        "This file is excluded by project .gitignore. Choose a different file that is not ignored.",
      );
    }
    publishedTargetPath = accessTargetPath;
  };
  const result = writeTextFileAtomically(
    operation.targetPath,
    operation.afterContent,
    {
      mode: operation.mode,
      rollbackMode: operation.rollbackMode,
      beforeAccess: validateTargetAtAccess,
      beforeWrite: validateOpenedTempAtAccess,
      beforePublish: validateTargetAtAccess,
      afterPublish: validatePublishedTargetAtAccess,
      validateReplacement: (replacementPath, fd) => {
        validateOpenedTempAtAccess(replacementPath, fd);
        assertPreparedFileRevision(
          options.readBeforeEdit,
          replacementPath,
          operation.path,
          operation.fileRevision,
          fileRevisionFromDescriptor(fd),
        );
      },
      rollbackOnPublishFailure: {
        beforeContent: operation.beforeContent,
        afterContent: operation.afterContent,
      },
      cleanupPathsByIdentity: (identity) =>
        findWorkspacePathsByIdentity(operation.workspacePath, identity),
    },
  );
  return {
    ...operation,
    targetPath: publishedTargetPath,
    appliedIdentity: result.identity,
  };
}

export function verifyAppliedOperation(
  operation: AppliedPatchOperation,
): AppliedPatchOperation {
  if (operation.kind === "move") {
    if (pathHasIdentity(operation.targetPath, operation.targetIdentity)) {
      throw changedTargetError(operation);
    }
    const finalDestinationPath = assertWorkspaceTargetAtAccess({
      workspacePath: operation.workspacePath,
      targetPath: operation.destinationTargetPath,
      toolName: "apply_patch",
      requestedPath: operation.movePath,
    });
    if (!pathHasIdentity(finalDestinationPath, operation.destinationIdentity)) {
      throw changedTargetError(operation);
    }
    return { ...operation, destinationTargetPath: finalDestinationPath };
  }

  if (operation.kind === "delete") {
    if (pathHasIdentity(operation.targetPath, operation.appliedIdentity)) {
      throw changedTargetError(operation);
    }
    return operation;
  }

  const finalTargetPath = assertWorkspaceTargetAtAccess({
    workspacePath: operation.workspacePath,
    targetPath: operation.targetPath,
    toolName: "apply_patch",
    requestedPath: operation.path,
  });
  if (!pathHasIdentity(finalTargetPath, operation.appliedIdentity)) {
    throw changedTargetError(operation);
  }
  return { ...operation, targetPath: finalTargetPath };
}
