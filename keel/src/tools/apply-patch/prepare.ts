import { fstatSync, statSync } from "node:fs";
import { KeelError } from "../../core/error.ts";
import { normalizeLineEndings } from "../edit-match.ts";
import { createProjectIgnorePolicy } from "../project-ignore.ts";
import { readEditableTextFileWithMetadata } from "../text-file.ts";
import {
  assertWorkspaceOpenTargetAtAccess,
  assertWorkspaceTargetAtAccess,
  fileIdentityFromStats,
  resolveWorkspaceCreateTarget,
  resolveWorkspaceTarget,
} from "../workspace-path.ts";
import {
  assertPatchReadRevision,
  fileTooLargeError,
  MAX_PATCH_EDIT_FILE_BYTES,
  patchError,
} from "./errors.ts";
import { uniquePaths } from "./filesystem.ts";
import { addFileContent, applyUpdateHunks, withUtf8Bom } from "./hunks.ts";
import type {
  ExecuteApplyPatchOptions,
  GitRegularFileMode,
  ParsedPatchModeChange,
  ParsedPatchOperation,
  PreparedPatchModeChange,
  PreparedPatchOperation,
  ValidatedUpdateTarget,
} from "./model.ts";

function gitRegularFileModeFromFileMode(mode: number): GitRegularFileMode {
  return (mode & 0o111) === 0 ? 0o644 : 0o755;
}

function formatGitRegularFileMode(mode: GitRegularFileMode): string {
  return mode === 0o755 ? "100755" : "100644";
}

function assertExpectedGitRegularFileMode(
  displayPath: string,
  actualMode: number,
  expectedMode: GitRegularFileMode,
): void {
  const actualGitMode = gitRegularFileModeFromFileMode(actualMode);
  if (actualGitMode === expectedMode) return;
  throw patchError(
    "tool_patch_hunk_not_found",
    `apply_patch failed: expected file mode ${formatGitRegularFileMode(expectedMode)} for ${displayPath}`,
    `Use read(path: "${displayPath}") to inspect the current file, then regenerate the diff from the current file mode.`,
  );
}

function preparedModeChange(
  displayPath: string,
  openedMode: number,
  modeChange: ParsedPatchModeChange | null,
): PreparedPatchModeChange | null {
  if (modeChange === null) return null;
  assertExpectedGitRegularFileMode(displayPath, openedMode, modeChange.oldMode);
  return {
    beforeMode: openedMode,
    afterMode: modeChange.newMode,
  };
}

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
  const projectIgnorePolicy = createProjectIgnorePolicy(workspacePath);
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
        const openedStat = fstatSync(fd);
        return {
          targetPath: openedTargetPath,
          metadata: {
            mode: openedStat.mode & 0o7777,
            identity: fileIdentityFromStats(openedStat),
          },
        };
      },
    },
  );
  assertPatchReadRevision(
    options.readBeforeEdit,
    file.targetPath,
    operation.path,
    file.fileRevision,
  );
  const updated = applyUpdateHunks(
    operation.path,
    file.content,
    operation.hunks,
  );
  const modeChange = preparedModeChange(
    operation.path,
    file.openedMetadata.mode,
    operation.modeChange,
  );
  const writeMode = modeChange?.afterMode ?? file.openedMetadata.mode;
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
      fileRevision: file.fileRevision,
      beforeContent: withUtf8Bom(file.content, file.hasUtf8Bom),
      afterContent: withUtf8Bom(updated, file.hasUtf8Bom),
      mode: writeMode,
      rollbackMode: file.openedMetadata.mode,
      modeChange,
      targetIdentity: file.openedMetadata.identity,
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
    fileRevision: file.fileRevision,
    beforeContent: withUtf8Bom(file.content, file.hasUtf8Bom),
    afterContent: withUtf8Bom(updated, file.hasUtf8Bom),
    mode: writeMode,
    rollbackMode: file.openedMetadata.mode,
    modeChange,
  };
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
  const projectIgnorePolicy = createProjectIgnorePolicy(workspacePath);
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
        const openedStat = fstatSync(fd);
        return {
          targetPath: openedTargetPath,
          metadata: {
            mode: openedStat.mode & 0o7777,
            identity: fileIdentityFromStats(openedStat),
          },
        };
      },
    },
  );
  assertPatchReadRevision(
    options.readBeforeEdit,
    file.targetPath,
    operation.path,
    file.fileRevision,
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
  if (operation.mode !== null) {
    assertExpectedGitRegularFileMode(
      operation.path,
      file.openedMetadata.mode,
      operation.mode,
    );
  }

  return {
    kind: "delete",
    path: operation.path,
    workspacePath,
    targetPath: file.targetPath,
    fileRevision: file.fileRevision,
    beforeContent: withUtf8Bom(file.content, file.hasUtf8Bom),
    mode: file.openedMetadata.mode,
    targetIdentity: file.openedMetadata.identity,
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
    mode: operation.mode,
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
  const projectIgnorePolicy = createProjectIgnorePolicy(workspacePath);
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
        const openedStat = fstatSync(fd);
        return {
          targetPath: openedTargetPath,
          metadata: {
            mode: openedStat.mode & 0o7777,
            identity: fileIdentityFromStats(openedStat),
          },
        };
      },
    },
  );
  assertPatchReadRevision(
    options.readBeforeEdit,
    file.targetPath,
    operation.sourcePath,
    file.fileRevision,
  );
  const updated = applyUpdateHunks(
    operation.sourcePath,
    file.content,
    operation.hunks,
  );
  const modeChange = preparedModeChange(
    operation.sourcePath,
    file.openedMetadata.mode,
    operation.modeChange,
  );
  const writeMode = modeChange?.afterMode ?? file.openedMetadata.mode;
  const destination = resolveWorkspaceCreateTarget(
    workspace,
    operation.path,
    "apply_patch",
  );
  return {
    kind: "copy",
    sourcePath: operation.sourcePath,
    sourceTargetPath: file.targetPath,
    sourceFileRevision: file.fileRevision,
    sourceIdentity: file.openedMetadata.identity,
    path: operation.path,
    workspacePath: destination.workspacePath,
    targetPath: destination.targetPath,
    resolvedTargetPath: destination.resolvedTargetPath,
    parentPath: destination.parentPath,
    afterContent: withUtf8Bom(updated, file.hasUtf8Bom),
    mode: writeMode,
    modeChange,
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
