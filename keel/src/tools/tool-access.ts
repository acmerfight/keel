import { realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { type ParsedPatchOperation, parsePatch } from "./apply-patch.ts";
import { isMcpToolInvocation, type ToolCall } from "./tool-call.ts";
import {
  type FileToolName,
  isInsideWorkspace,
  resolveWorkspaceCreateTargetCore,
} from "./workspace-path.ts";

type ToolFileAccessOperation = "read" | "write" | "readwrite" | "search";

interface ToolFileAccess {
  readonly kind: "file";
  readonly operation: ToolFileAccessOperation;
  readonly path: string;
  readonly recursive?: boolean;
}

interface ToolResourceAccessAll {
  readonly kind: "all";
}

type ToolResourceAccess = ToolFileAccess | ToolResourceAccessAll;
export type ToolAccesses = readonly ToolResourceAccess[];

export const ToolAccesses = {
  all(): ToolAccesses {
    return [{ kind: "all" }];
  },

  readFile(path: string): ToolAccesses {
    return [{ kind: "file", operation: "read", path }];
  },

  readTree(path: string): ToolAccesses {
    return [{ kind: "file", operation: "read", path, recursive: true }];
  },

  writeFile(path: string): ToolAccesses {
    return [{ kind: "file", operation: "write", path }];
  },

  writeTree(path: string): ToolAccesses {
    return [{ kind: "file", operation: "write", path, recursive: true }];
  },

  readWriteFile(path: string): ToolAccesses {
    return [{ kind: "file", operation: "readwrite", path }];
  },

  searchTree(path: string): ToolAccesses {
    return [{ kind: "file", operation: "search", path, recursive: true }];
  },

  conflict(left: ToolAccesses, right: ToolAccesses): boolean {
    return left.some((leftAccess) =>
      right.some((rightAccess) =>
        resourceAccessesConflict(leftAccess, rightAccess),
      ),
    );
  },
};

function resourceAccessesConflict(
  left: ToolResourceAccess,
  right: ToolResourceAccess,
): boolean {
  if (left.kind === "all" || right.kind === "all") return true;
  if (!fileOperationsConflict(left.operation, right.operation)) return false;
  return fileAccessesOverlap(left, right);
}

function fileOperationsConflict(
  left: ToolFileAccessOperation,
  right: ToolFileAccessOperation,
): boolean {
  return fileOperationWrites(left) || fileOperationWrites(right);
}

function fileOperationWrites(operation: ToolFileAccessOperation): boolean {
  switch (operation) {
    case "read":
    case "search":
      return false;
    case "write":
    case "readwrite":
      return true;
  }
}

function fileAccessesOverlap(
  left: ToolFileAccess,
  right: ToolFileAccess,
): boolean {
  const leftPath = normalizeAccessPath(left.path);
  const rightPath = normalizeAccessPath(right.path);
  if (leftPath === rightPath) return true;

  const leftPrefix = leftPath.endsWith("/") ? leftPath : `${leftPath}/`;
  const rightPrefix = rightPath.endsWith("/") ? rightPath : `${rightPath}/`;
  return (
    (left.recursive === true && rightPath.startsWith(leftPrefix)) ||
    (right.recursive === true && leftPath.startsWith(rightPrefix))
  );
}

function normalizeAccessPath(path: string): string {
  const normalized = path.replace(/\\/gu, "/").replace(/\/+/gu, "/");
  const folded = normalized.toLowerCase();
  if (folded.length > 1 && folded.endsWith("/")) {
    return folded.slice(0, -1);
  }
  return folded;
}

function requestedAccessPath(
  workspace: string,
  requestedPath: string,
): string | null {
  try {
    const workspacePath = realpathSync(workspace);
    const absoluteRequestedPath = isAbsolute(requestedPath)
      ? resolve(requestedPath)
      : resolve(workspacePath, requestedPath);
    if (!isInsideWorkspace(workspacePath, absoluteRequestedPath)) return null;
    return resolvedAccessPath(workspacePath, absoluteRequestedPath);
  } catch {
    return null;
  }
}

function createAccessPath(
  workspace: string,
  requestedPath: string,
  toolName: Extract<FileToolName, "apply_patch" | "write">,
): string | null {
  try {
    const resolution = resolveWorkspaceCreateTargetCore(
      workspace,
      requestedPath,
      toolName,
    );
    return resolution.ok ? resolution.target.resolvedTargetPath : null;
  } catch {
    return null;
  }
}

function resolvedAccessPath(
  workspacePath: string,
  absoluteRequestedPath: string,
): string | null {
  const unresolvedNames: string[] = [];
  let current = absoluteRequestedPath;

  while (true) {
    try {
      const realPath = realpathSync(current);
      if (unresolvedNames.length > 0 && !statSync(realPath).isDirectory()) {
        return null;
      }
      const path =
        unresolvedNames.length === 0
          ? realPath
          : resolve(realPath, ...unresolvedNames.toReversed());
      return isInsideWorkspace(workspacePath, path) ? path : null;
    } catch {
      const parent = dirname(current);
      unresolvedNames.push(basename(current));
      current = parent;
    }
  }
}

function existingOrRequestedAccessPath(
  workspace: string,
  requestedPath: string,
): string | null {
  return requestedAccessPath(workspace, requestedPath);
}

function scopedSearchPath(
  workspace: string,
  requestedPath: string | undefined,
): string | null {
  return existingOrRequestedAccessPath(workspace, requestedPath ?? ".");
}

function isProjectInstructionPath(path: string): boolean {
  return basename(path) === "AGENTS.md";
}

function isProjectInstructionAccessPath(path: string | null): boolean {
  return path !== null && isProjectInstructionPath(path);
}

function accessForParsedPatchOperation(
  workspace: string,
  operation: ParsedPatchOperation,
): ToolAccesses | null {
  if (isProjectInstructionPath(operation.path)) return null;
  if (operation.kind === "add") {
    const path = createAccessPath(workspace, operation.path, "apply_patch");
    return path === null ? null : ToolAccesses.writeTree(path);
  }
  if (operation.kind === "copy") {
    if (isProjectInstructionPath(operation.sourcePath)) return null;
    const source = existingOrRequestedAccessPath(
      workspace,
      operation.sourcePath,
    );
    if (isProjectInstructionAccessPath(source)) return null;
    if (source === null) return null;
    const destination = createAccessPath(
      workspace,
      operation.path,
      "apply_patch",
    );
    if (destination === null) return null;
    return [
      ...ToolAccesses.readFile(source),
      ...ToolAccesses.writeTree(destination),
    ];
  }
  if (operation.kind === "delete") {
    const path = existingOrRequestedAccessPath(workspace, operation.path);
    if (isProjectInstructionAccessPath(path)) return null;
    return path === null ? null : ToolAccesses.readWriteFile(path);
  }
  const source = existingOrRequestedAccessPath(workspace, operation.path);
  if (isProjectInstructionAccessPath(source)) return null;
  if (source === null) return null;
  if (operation.movePath === null) {
    return ToolAccesses.readWriteFile(source);
  }
  if (isProjectInstructionPath(operation.movePath)) return null;
  const destination = createAccessPath(
    workspace,
    operation.movePath,
    "apply_patch",
  );
  if (destination === null) return null;
  return [
    ...ToolAccesses.readWriteFile(source),
    ...ToolAccesses.writeTree(destination),
  ];
}

function applyPatchAccesses(workspace: string, patch: string): ToolAccesses {
  let operations: readonly ParsedPatchOperation[];
  try {
    operations = parsePatch(patch);
  } catch {
    return ToolAccesses.all();
  }

  const accesses: ToolResourceAccess[] = [];
  for (const operation of operations) {
    const operationAccesses = accessForParsedPatchOperation(
      workspace,
      operation,
    );
    if (operationAccesses === null) return ToolAccesses.all();
    accesses.push(...operationAccesses);
  }
  return accesses;
}

export function toolCallAccesses(
  workspace: string,
  toolCall: ToolCall,
): ToolAccesses {
  if (isMcpToolInvocation(toolCall)) return ToolAccesses.all();
  switch (toolCall.tool) {
    case "delegate":
      return ToolAccesses.readTree(workspace);
    case "agent_list":
    case "agent_wait":
    case "agent_cancel":
    case "update_plan":
    case "update_goal":
    case "memory_add":
    case "memory_forget":
    case "memory_propose":
    case "mcp_search":
    case "skill_resource":
    case "skill_search":
    case "skill":
      return ToolAccesses.all();
    case "read": {
      const path = existingOrRequestedAccessPath(workspace, toolCall.path);
      return path === null ? ToolAccesses.all() : ToolAccesses.readFile(path);
    }
    case "ls": {
      const path = scopedSearchPath(workspace, toolCall.path);
      return path === null ? ToolAccesses.all() : ToolAccesses.readTree(path);
    }
    case "glob": {
      const path = scopedSearchPath(workspace, toolCall.path);
      return path === null ? ToolAccesses.all() : ToolAccesses.searchTree(path);
    }
    case "grep": {
      const path = scopedSearchPath(workspace, toolCall.path);
      return path === null ? ToolAccesses.all() : ToolAccesses.searchTree(path);
    }
    case "git_status":
    case "git_diff": {
      const paths = toolCall.paths ?? ["."];
      const accesses: ToolResourceAccess[] = [];
      for (const requestedPath of paths) {
        const path = scopedSearchPath(workspace, requestedPath);
        if (path === null) return ToolAccesses.all();
        accesses.push(...ToolAccesses.searchTree(path));
      }
      return accesses;
    }
    case "edit": {
      if (isProjectInstructionPath(toolCall.path)) return ToolAccesses.all();
      const path = existingOrRequestedAccessPath(workspace, toolCall.path);
      if (isProjectInstructionAccessPath(path)) return ToolAccesses.all();
      return path === null
        ? ToolAccesses.all()
        : ToolAccesses.readWriteFile(path);
    }
    case "write": {
      if (isProjectInstructionPath(toolCall.path)) return ToolAccesses.all();
      const path = createAccessPath(workspace, toolCall.path, "write");
      return path === null ? ToolAccesses.all() : ToolAccesses.writeTree(path);
    }
    case "apply_patch":
      return applyPatchAccesses(workspace, toolCall.patch);
    case "bash":
      return ToolAccesses.all();
  }
}
