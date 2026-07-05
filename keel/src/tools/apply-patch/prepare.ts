import { fstatSync, statSync } from "node:fs";
import { KeelError } from "../../core/error.ts";
import { normalizeLineEndings } from "../edit-match.ts";
import { createProjectIgnorePolicy } from "../project-ignore.ts";
import { readEditableTextFileWithMetadata } from "../text-file.ts";
import {
  assertWorkspaceOpenTargetAtAccess,
  assertWorkspaceTargetAtAccess,
  type FileIdentity,
  fileIdentityFromStats,
  resolveWorkspaceCreateTarget,
  resolveWorkspaceTarget,
} from "../workspace-path.ts";
import {
  fileTooLargeError,
  MAX_PATCH_EDIT_FILE_BYTES,
  patchError,
} from "./errors.ts";
import { uniquePaths } from "./filesystem.ts";
import { addFileContent, applyUpdateHunks, withUtf8Bom } from "./hunks.ts";
import type {
  ExecuteApplyPatchOptions,
  ParsedPatchOperation,
  PreparedPatchOperation,
  ValidatedUpdateTarget,
} from "./model.ts";

function validateUpdateTarget(
  workspacePath: string,
  requestedPath: string,
  targetPath: string,
  displayPath: string,
): ValidatedUpdateTarget {
  const accessTargetPath = assertWorkspaceTargetAtAccess({
    workspacePath,
    targetPath,
    toolName: "apply_patch",
    requestedPath: displayPath,
  });
  const targetStat = statSync(accessTargetPath);
  const targetIsDirectory = targetStat.isDirectory();
  const projectIgnorePolicy = createProjectIgnorePolicy(workspacePath);
  if (
    projectIgnorePolicy.isIgnored(requestedPath, targetIsDirectory) ||
    projectIgnorePolicy.isIgnored(accessTargetPath, targetIsDirectory)
  ) {
    throw new KeelError(
      "tool_path_ignored",
      `apply_patch failed: ignored path: ${displayPath}`,
      "This file is excluded by project .gitignore. Choose a different file that is not ignored.",
    );
  }
  if (!targetStat.isFile()) {
    throw new KeelError(
      "tool_not_file",
      `apply_patch failed: not a file: ${displayPath}`,
      "The path is a directory, not a file. Specify a file path inside it.",
    );
  }
  return {
    targetPath: accessTargetPath,
    mode: targetStat.mode & 0o7777,
  };
}

function prepareUpdateOperation(
  workspace: string,
  operation: Extract<ParsedPatchOperation, { readonly kind: "update" }>,
  options: ExecuteApplyPatchOptions,
): PreparedPatchOperation {
  const { workspacePath, requestedPath, targetPath } = resolveWorkspaceTarget(
    workspace,
    operation.path,
    "apply_patch",
  );
  const validatedTarget = validateUpdateTarget(
    workspacePath,
    requestedPath,
    targetPath,
    operation.path,
  );
  if (
    options.readBeforeEdit !== undefined &&
    !options.readBeforeEdit.hasRead(validatedTarget.targetPath)
  ) {
    throw new KeelError(
      "tool_file_not_read",
      `apply_patch failed: file has not been read: ${operation.path}`,
      `Use read(path: "${operation.path}") to view the current file content, then retry apply_patch with hunks copied from the read output.`,
    );
  }

  const projectIgnorePolicy = createProjectIgnorePolicy(workspacePath);
  let openedMode = validatedTarget.mode;
  let targetIdentity: FileIdentity | null = null;
  const needsTargetIdentity = operation.movePath !== null;
  const file = readEditableTextFileWithMetadata(
    validatedTarget.targetPath,
    operation.path,
    {
      command: "apply_patch",
      maxBytes: MAX_PATCH_EDIT_FILE_BYTES,
      tooLargeError: (observedBytes) =>
        fileTooLargeError(operation.path, observedBytes),
      validateOpenedFile: (fd) => {
        const openedTargetPath = assertWorkspaceOpenTargetAtAccess({
          fd,
          workspacePath,
          targetPath: validatedTarget.targetPath,
          toolName: "apply_patch",
          requestedPath: operation.path,
        });
        if (projectIgnorePolicy.isIgnored(openedTargetPath, false)) {
          throw new KeelError(
            "tool_path_ignored",
            `apply_patch failed: ignored path: ${operation.path}`,
            "This file is excluded by project .gitignore. Choose a different file that is not ignored.",
          );
        }
        if (
          options.readBeforeEdit !== undefined &&
          !options.readBeforeEdit.hasRead(openedTargetPath)
        ) {
          throw new KeelError(
            "tool_file_not_read",
            `apply_patch failed: file has not been read: ${operation.path}`,
            `Use read(path: "${operation.path}") to view the current file content, then retry apply_patch with hunks copied from the read output.`,
          );
        }
        const openedStat = fstatSync(fd);
        openedMode = openedStat.mode & 0o7777;
        if (needsTargetIdentity) {
          targetIdentity = fileIdentityFromStats(openedStat);
        }
        return openedTargetPath;
      },
    },
  );
  const updated = applyUpdateHunks(
    operation.path,
    file.content,
    operation.hunks,
  );
  if (operation.movePath !== null) {
    const destination = resolveWorkspaceCreateTarget(
      workspace,
      operation.movePath,
      "apply_patch",
    );
    return {
      kind: "move",
      path: operation.path,
      movePath: operation.movePath,
      workspacePath,
      targetPath: file.targetPath,
      beforeContent: withUtf8Bom(file.content, file.hasUtf8Bom),
      afterContent: withUtf8Bom(updated, file.hasUtf8Bom),
      mode: openedMode,
      targetIdentity: openedFileIdentity(targetIdentity),
      destinationTargetPath: destination.targetPath,
      destinationResolvedTargetPath: destination.resolvedTargetPath,
      destinationParentPath: destination.parentPath,
    };
  }
  return {
    kind: "update",
    path: operation.path,
    workspacePath,
    targetPath: file.targetPath,
    beforeContent: withUtf8Bom(file.content, file.hasUtf8Bom),
    afterContent: withUtf8Bom(updated, file.hasUtf8Bom),
    mode: openedMode,
  };
}

function openedFileIdentity(identity: FileIdentity | null): FileIdentity {
  /* v8 ignore next 3: readEditableTextFileWithMetadata validates the opened fd before returning. */
  if (identity === null) {
    throw new Error("apply_patch opened file identity invariant violated");
  }
  return identity;
}

function prepareDeleteOperation(
  workspace: string,
  operation: Extract<ParsedPatchOperation, { readonly kind: "delete" }>,
  options: ExecuteApplyPatchOptions,
): PreparedPatchOperation {
  const { workspacePath, requestedPath, targetPath } = resolveWorkspaceTarget(
    workspace,
    operation.path,
    "apply_patch",
  );
  const validatedTarget = validateUpdateTarget(
    workspacePath,
    requestedPath,
    targetPath,
    operation.path,
  );
  if (
    options.readBeforeEdit !== undefined &&
    !options.readBeforeEdit.hasRead(validatedTarget.targetPath)
  ) {
    throw new KeelError(
      "tool_file_not_read",
      `apply_patch failed: file has not been read: ${operation.path}`,
      `Use read(path: "${operation.path}") to view the current file content, then retry apply_patch after confirming the file should be deleted.`,
    );
  }

  const projectIgnorePolicy = createProjectIgnorePolicy(workspacePath);
  let openedMode = validatedTarget.mode;
  let targetIdentity: FileIdentity | null = null;
  const file = readEditableTextFileWithMetadata(
    validatedTarget.targetPath,
    operation.path,
    {
      command: "apply_patch",
      maxBytes: MAX_PATCH_EDIT_FILE_BYTES,
      tooLargeError: (observedBytes) =>
        fileTooLargeError(operation.path, observedBytes),
      validateOpenedFile: (fd) => {
        const openedTargetPath = assertWorkspaceOpenTargetAtAccess({
          fd,
          workspacePath,
          targetPath: validatedTarget.targetPath,
          toolName: "apply_patch",
          requestedPath: operation.path,
        });
        if (projectIgnorePolicy.isIgnored(openedTargetPath, false)) {
          throw new KeelError(
            "tool_path_ignored",
            `apply_patch failed: ignored path: ${operation.path}`,
            "This file is excluded by project .gitignore. Choose a different file that is not ignored.",
          );
        }
        if (
          options.readBeforeEdit !== undefined &&
          !options.readBeforeEdit.hasRead(openedTargetPath)
        ) {
          throw new KeelError(
            "tool_file_not_read",
            `apply_patch failed: file has not been read: ${operation.path}`,
            `Use read(path: "${operation.path}") to view the current file content, then retry apply_patch after confirming the file should be deleted.`,
          );
        }
        const openedStat = fstatSync(fd);
        openedMode = openedStat.mode & 0o7777;
        targetIdentity = fileIdentityFromStats(openedStat);
        return openedTargetPath;
      },
    },
  );
  if (
    operation.expectedContent !== null &&
    normalizeLineEndings(file.content) !== operation.expectedContent
  ) {
    throw patchError(
      "tool_patch_hunk_not_found",
      `apply_patch failed: expected lines not found in ${operation.path}`,
      `Use read(path: "${operation.path}") to view the current content, then regenerate the deletion hunk with exact context.`,
    );
  }

  return {
    kind: "delete",
    path: operation.path,
    workspacePath,
    targetPath: file.targetPath,
    beforeContent: withUtf8Bom(file.content, file.hasUtf8Bom),
    mode: openedMode,
    targetIdentity: openedFileIdentity(targetIdentity),
  };
}

function prepareAddOperation(
  workspace: string,
  operation: Extract<ParsedPatchOperation, { readonly kind: "add" }>,
): PreparedPatchOperation {
  const { workspacePath, targetPath, resolvedTargetPath, parentPath } =
    resolveWorkspaceCreateTarget(workspace, operation.path, "apply_patch");
  return {
    kind: "add",
    path: operation.path,
    workspacePath,
    targetPath,
    resolvedTargetPath,
    parentPath,
    afterContent: addFileContent(operation.lines),
  };
}

function prepareCopyOperation(
  workspace: string,
  operation: Extract<ParsedPatchOperation, { readonly kind: "copy" }>,
  options: ExecuteApplyPatchOptions,
): PreparedPatchOperation {
  const { workspacePath, requestedPath, targetPath } = resolveWorkspaceTarget(
    workspace,
    operation.sourcePath,
    "apply_patch",
  );
  const validatedTarget = validateUpdateTarget(
    workspacePath,
    requestedPath,
    targetPath,
    operation.sourcePath,
  );
  if (
    options.readBeforeEdit !== undefined &&
    !options.readBeforeEdit.hasRead(validatedTarget.targetPath)
  ) {
    throw new KeelError(
      "tool_file_not_read",
      `apply_patch failed: file has not been read: ${operation.sourcePath}`,
      `Use read(path: "${operation.sourcePath}") to view the current file content, then retry apply_patch with copy hunks copied from the read output.`,
    );
  }

  const projectIgnorePolicy = createProjectIgnorePolicy(workspacePath);
  let openedMode = validatedTarget.mode;
  const file = readEditableTextFileWithMetadata(
    validatedTarget.targetPath,
    operation.sourcePath,
    {
      command: "apply_patch",
      maxBytes: MAX_PATCH_EDIT_FILE_BYTES,
      tooLargeError: (observedBytes) =>
        fileTooLargeError(operation.sourcePath, observedBytes),
      validateOpenedFile: (fd) => {
        const openedTargetPath = assertWorkspaceOpenTargetAtAccess({
          fd,
          workspacePath,
          targetPath: validatedTarget.targetPath,
          toolName: "apply_patch",
          requestedPath: operation.sourcePath,
        });
        if (projectIgnorePolicy.isIgnored(openedTargetPath, false)) {
          throw new KeelError(
            "tool_path_ignored",
            `apply_patch failed: ignored path: ${operation.sourcePath}`,
            "This file is excluded by project .gitignore. Choose a different file that is not ignored.",
          );
        }
        if (
          options.readBeforeEdit !== undefined &&
          !options.readBeforeEdit.hasRead(openedTargetPath)
        ) {
          throw new KeelError(
            "tool_file_not_read",
            `apply_patch failed: file has not been read: ${operation.sourcePath}`,
            `Use read(path: "${operation.sourcePath}") to view the current file content, then retry apply_patch with copy hunks copied from the read output.`,
          );
        }
        openedMode = fstatSync(fd).mode & 0o7777;
        return openedTargetPath;
      },
    },
  );
  const updated = applyUpdateHunks(
    operation.sourcePath,
    file.content,
    operation.hunks,
  );
  const destination = resolveWorkspaceCreateTarget(
    workspace,
    operation.path,
    "apply_patch",
  );
  return {
    kind: "copy",
    sourcePath: operation.sourcePath,
    path: operation.path,
    workspacePath: destination.workspacePath,
    targetPath: destination.targetPath,
    resolvedTargetPath: destination.resolvedTargetPath,
    parentPath: destination.parentPath,
    afterContent: withUtf8Bom(updated, file.hasUtf8Bom),
    mode: openedMode,
  };
}

export function preparedMutationTargetPaths(
  operation: PreparedPatchOperation,
): readonly string[] {
  if (operation.kind === "add" || operation.kind === "copy") {
    return [operation.targetPath, operation.resolvedTargetPath];
  }
  if (operation.kind === "move") {
    return [
      operation.targetPath,
      operation.destinationTargetPath,
      operation.destinationResolvedTargetPath,
    ];
  }
  return [operation.targetPath];
}

export function preparePatchOperations(
  workspace: string,
  operations: readonly ParsedPatchOperation[],
  options: ExecuteApplyPatchOptions,
): readonly PreparedPatchOperation[] {
  const prepared: PreparedPatchOperation[] = [];
  const targetPaths = new Set<string>();
  for (const operation of operations) {
    const next =
      operation.kind === "add"
        ? prepareAddOperation(workspace, operation)
        : operation.kind === "update"
          ? prepareUpdateOperation(workspace, operation, options)
          : operation.kind === "copy"
            ? prepareCopyOperation(workspace, operation, options)
            : prepareDeleteOperation(workspace, operation, options);
    for (const targetPath of uniquePaths(preparedMutationTargetPaths(next))) {
      if (targetPaths.has(targetPath)) {
        throw patchError(
          "tool_invalid_patch",
          `apply_patch failed: multiple operations target ${operation.path}`,
          "Combine changes for the same file into one patch operation.",
        );
      }
      targetPaths.add(targetPath);
    }
    prepared.push(next);
  }
  return prepared;
}
