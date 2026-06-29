import { execFileSync } from "node:child_process";
import type { Stats } from "node:fs";
import {
  closeSync,
  existsSync,
  fchmodSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import { z } from "zod";
import { KeelError } from "./error.ts";
import { debugLog } from "./logger.ts";

export interface RecordLastEditCheckpointOptions {
  readonly workspace: string;
  readonly filePath: string;
  readonly beforeContent: string;
  readonly afterContent: string;
}

export interface RecordLastCreateCheckpointOptions {
  readonly workspace: string;
  readonly filePath: string;
  readonly afterContent: string;
}

export interface RecordLastDeleteCheckpointOptions {
  readonly workspace: string;
  readonly filePath: string;
  readonly beforeContent: string;
  readonly mode: number;
}

export type RecordLastBatchCheckpointOperation =
  | {
      readonly operation: "edit";
      readonly filePath: string;
      readonly beforeContent: string;
      readonly afterContent: string;
    }
  | {
      readonly operation: "create";
      readonly filePath: string;
      readonly afterContent: string;
    }
  | {
      readonly operation: "delete";
      readonly filePath: string;
      readonly beforeContent: string;
      readonly mode: number;
    };

export interface RecordLastBatchCheckpointOptions {
  readonly workspace: string;
  readonly operations: readonly RecordLastBatchCheckpointOperation[];
}

export interface RecordLastEditCheckpointResult {
  readonly written: boolean;
}

export type RestoreLastEditCheckpointResult =
  | {
      readonly status: "restored";
      readonly restoredLabel: string;
    }
  | {
      readonly status: "none";
      readonly message: string;
    }
  | {
      readonly status: "blocked";
      readonly filePath: string;
      readonly message: string;
    };

interface GitWorkspace {
  readonly root: string;
  readonly checkpointPath: string;
}

const CHECKPOINT_METADATA_PATH = "keel/last-edit-checkpoint.json";
const NO_UNDO_CHECKPOINT_MESSAGE =
  "No earlier checkpoints. Ask me to undo more, or use git to reset.";

const gitOutputSchema = z
  .string()
  .transform((value) => value.trim())
  .pipe(z.string().min(1));

const editCheckpointSchema = z
  .object({
    version: z.literal(1),
    gitRoot: z.string().min(1),
    relativePath: z.string().min(1),
    beforeContent: z.string(),
    afterContent: z.string(),
    createdAt: z.string().min(1),
  })
  .strict()
  .transform((checkpoint) => ({
    ...checkpoint,
    operation: "edit" as const,
  }));

const createCheckpointSchema = z
  .object({
    version: z.literal(2),
    operation: z.literal("create"),
    gitRoot: z.string().min(1),
    relativePath: z.string().min(1),
    afterContent: z.string(),
    createdAt: z.string().min(1),
  })
  .strict();

const deleteCheckpointSchema = z
  .object({
    version: z.literal(4),
    operation: z.literal("delete"),
    gitRoot: z.string().min(1),
    relativePath: z.string().min(1),
    beforeContent: z.string(),
    mode: z.number().int().min(0).max(0o7777),
    createdAt: z.string().min(1),
  })
  .strict();

const batchCheckpointOperationSchema = z.union([
  z
    .object({
      operation: z.literal("edit"),
      relativePath: z.string().min(1),
      beforeContent: z.string(),
      afterContent: z.string(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("create"),
      relativePath: z.string().min(1),
      afterContent: z.string(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("delete"),
      relativePath: z.string().min(1),
      beforeContent: z.string(),
      mode: z.number().int().min(0).max(0o7777),
    })
    .strict(),
]);

const batchCheckpointSchema = z
  .object({
    version: z.literal(3),
    operation: z.literal("batch"),
    gitRoot: z.string().min(1),
    operations: z.array(batchCheckpointOperationSchema).min(1),
    createdAt: z.string().min(1),
  })
  .strict();

const checkpointSchema = z.union([
  editCheckpointSchema,
  createCheckpointSchema,
  deleteCheckpointSchema,
  batchCheckpointSchema,
]);

type LastEditCheckpoint = z.infer<typeof checkpointSchema>;
type PersistedCheckpoint = z.input<typeof checkpointSchema>;
type PersistedBatchCheckpointOperation = z.input<
  typeof batchCheckpointOperationSchema
>;

function gitOutput(workspace: string, args: readonly string[]): string | null {
  try {
    const output = execFileSync("git", [...args], {
      cwd: workspace,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return gitOutputSchema.parse(output);
  } catch {
    return null;
  }
}

function isInside(parent: string, child: string): boolean {
  const childFromParent = relative(parent, child);
  return (
    childFromParent === "" ||
    (!childFromParent.startsWith("..") && !isAbsolute(childFromParent))
  );
}

function normalizeRelativePath(root: string, filePath: string): string | null {
  const absolutePath = realpathIfPossible(filePath);
  if (absolutePath === null) return null;
  if (!isInside(root, absolutePath)) return null;
  const relativePath = relative(root, absolutePath);
  if (relativePath === "") return null;
  return relativePath.split(sep).join("/");
}

function normalizeDeletedRelativePath(
  root: string,
  filePath: string,
): string | null {
  const parentPath = realpathIfPossible(dirname(filePath));
  if (parentPath === null) return null;
  const absolutePath = resolve(parentPath, basename(filePath));
  if (!isInside(root, absolutePath)) return null;
  const relativePath = relative(root, absolutePath);
  if (relativePath === "") return null;
  return relativePath.split(sep).join("/");
}

function resolveCheckpointPath(workspace: string): string | null {
  return gitOutput(workspace, [
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    CHECKPOINT_METADATA_PATH,
  ]);
}

function findGitWorkspace(workspace: string): GitWorkspace | null {
  const rootOutput = gitOutput(workspace, ["rev-parse", "--show-toplevel"]);
  if (rootOutput === null) return null;
  const root = realpathSync(rootOutput);

  const checkpointPath = resolveCheckpointPath(workspace);
  if (checkpointPath === null) return null;

  return { root, checkpointPath };
}

function writeCheckpoint(
  checkpointPath: string,
  checkpoint: PersistedCheckpoint,
): void {
  mkdirSync(dirname(checkpointPath), { recursive: true });
  writeFileSync(checkpointPath, `${JSON.stringify(checkpoint)}\n`, "utf8");
}

function readCheckpoint(checkpointPath: string): LastEditCheckpoint {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(checkpointPath, "utf8"));
  } catch {
    throw new KeelError(
      "tool_unavailable",
      "undo failed: checkpoint is invalid",
    );
  }

  const result = checkpointSchema.safeParse(parsed);
  if (!result.success) {
    throw new KeelError(
      "tool_unavailable",
      "undo failed: checkpoint is invalid",
    );
  }
  return result.data;
}

function readFileIfPossible(filePath: string): string | null {
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function realpathIfPossible(filePath: string): string | null {
  try {
    return realpathSync(filePath);
  } catch {
    return null;
  }
}

function lstatIfPossible(filePath: string): Stats | null {
  try {
    return lstatSync(filePath);
  } catch {
    return null;
  }
}

function skippedCheckpointRecord(
  options: { readonly workspace: string; readonly filePath: string },
  error: string,
): RecordLastEditCheckpointResult {
  debugLog(
    `undo checkpoint write skipped: workspace=${options.workspace} filePath=${options.filePath} error=${error}`,
  );
  return { written: false };
}

function skippedBatchCheckpointRecord(
  options: RecordLastBatchCheckpointOptions,
  error: string,
): RecordLastEditCheckpointResult {
  debugLog(
    `undo checkpoint write skipped: workspace=${options.workspace} operations=${options.operations.length} error=${error}`,
  );
  return { written: false };
}

export function recordLastEditCheckpoint(
  options: RecordLastEditCheckpointOptions,
): RecordLastEditCheckpointResult {
  try {
    const gitWorkspace = findGitWorkspace(options.workspace);
    if (gitWorkspace === null) {
      return skippedCheckpointRecord(options, "git workspace unavailable");
    }

    const relativePath = normalizeRelativePath(
      gitWorkspace.root,
      options.filePath,
    );
    if (relativePath === null) {
      return skippedCheckpointRecord(
        options,
        "file path unavailable or outside git root",
      );
    }

    writeCheckpoint(gitWorkspace.checkpointPath, {
      version: 1,
      gitRoot: gitWorkspace.root,
      relativePath,
      beforeContent: options.beforeContent,
      afterContent: options.afterContent,
      createdAt: new Date().toISOString(),
    });

    return { written: true };
  } catch (error) {
    return skippedCheckpointRecord(options, String(error));
  }
}

export function recordLastCreateCheckpoint(
  options: RecordLastCreateCheckpointOptions,
): RecordLastEditCheckpointResult {
  try {
    const gitWorkspace = findGitWorkspace(options.workspace);
    if (gitWorkspace === null) {
      return skippedCheckpointRecord(options, "git workspace unavailable");
    }

    const relativePath = normalizeRelativePath(
      gitWorkspace.root,
      options.filePath,
    );
    if (relativePath === null) {
      return skippedCheckpointRecord(
        options,
        "file path unavailable or outside git root",
      );
    }

    writeCheckpoint(gitWorkspace.checkpointPath, {
      version: 2,
      operation: "create",
      gitRoot: gitWorkspace.root,
      relativePath,
      afterContent: options.afterContent,
      createdAt: new Date().toISOString(),
    });

    return { written: true };
  } catch (error) {
    return skippedCheckpointRecord(options, String(error));
  }
}

export function recordLastDeleteCheckpoint(
  options: RecordLastDeleteCheckpointOptions,
): RecordLastEditCheckpointResult {
  try {
    const gitWorkspace = findGitWorkspace(options.workspace);
    if (gitWorkspace === null) {
      return skippedCheckpointRecord(options, "git workspace unavailable");
    }

    const relativePath = normalizeDeletedRelativePath(
      gitWorkspace.root,
      options.filePath,
    );
    if (relativePath === null) {
      return skippedCheckpointRecord(
        options,
        "file path unavailable or outside git root",
      );
    }

    writeCheckpoint(gitWorkspace.checkpointPath, {
      version: 4,
      operation: "delete",
      gitRoot: gitWorkspace.root,
      relativePath,
      beforeContent: options.beforeContent,
      mode: options.mode,
      createdAt: new Date().toISOString(),
    });

    return { written: true };
  } catch (error) {
    return skippedCheckpointRecord(options, String(error));
  }
}

export function recordLastBatchCheckpoint(
  options: RecordLastBatchCheckpointOptions,
): RecordLastEditCheckpointResult {
  try {
    const gitWorkspace = findGitWorkspace(options.workspace);
    if (gitWorkspace === null) {
      return skippedBatchCheckpointRecord(options, "git workspace unavailable");
    }

    const operations: PersistedBatchCheckpointOperation[] = [];
    for (const operation of options.operations) {
      const relativePath =
        operation.operation === "delete"
          ? normalizeDeletedRelativePath(gitWorkspace.root, operation.filePath)
          : normalizeRelativePath(gitWorkspace.root, operation.filePath);
      if (relativePath === null) {
        return skippedBatchCheckpointRecord(
          options,
          "file path unavailable or outside git root",
        );
      }

      if (operation.operation === "edit") {
        operations.push({
          operation: "edit",
          relativePath,
          beforeContent: operation.beforeContent,
          afterContent: operation.afterContent,
        });
      } else if (operation.operation === "delete") {
        operations.push({
          operation: "delete",
          relativePath,
          beforeContent: operation.beforeContent,
          mode: operation.mode,
        });
      } else {
        operations.push({
          operation: "create",
          relativePath,
          afterContent: operation.afterContent,
        });
      }
    }

    if (operations.length === 0) {
      return skippedBatchCheckpointRecord(options, "empty batch checkpoint");
    }

    writeCheckpoint(gitWorkspace.checkpointPath, {
      version: 3,
      operation: "batch",
      gitRoot: gitWorkspace.root,
      operations,
      createdAt: new Date().toISOString(),
    });

    return { written: true };
  } catch (error) {
    /* v8 ignore next 1: checkpoint writes can fail from filesystem races or permissions. */
    return skippedBatchCheckpointRecord(options, String(error));
  }
}

function mergeTaskCheckpointOperations(
  existing: RecordLastBatchCheckpointOperation,
  next: RecordLastBatchCheckpointOperation,
): RecordLastBatchCheckpointOperation | null {
  if (existing.operation === "create") {
    if (next.operation === "delete") return null;
    return {
      operation: "create",
      filePath: existing.filePath,
      afterContent: next.afterContent,
    };
  }

  if (existing.operation === "delete") {
    if (next.operation === "delete") return existing;
    return {
      operation: "edit",
      filePath: existing.filePath,
      beforeContent: existing.beforeContent,
      afterContent: next.afterContent,
    };
  }

  if (next.operation === "delete") {
    return {
      operation: "delete",
      filePath: existing.filePath,
      beforeContent: existing.beforeContent,
      mode: next.mode,
    };
  }

  return {
    operation: "edit",
    filePath: existing.filePath,
    beforeContent: existing.beforeContent,
    afterContent: next.afterContent,
  };
}

function coalesceTaskCheckpointOperations(
  checkpointOperations: readonly RecordLastBatchCheckpointOperation[],
): readonly RecordLastBatchCheckpointOperation[] {
  const operationByPath = new Map<string, RecordLastBatchCheckpointOperation>();

  for (const operation of checkpointOperations) {
    const existing = operationByPath.get(operation.filePath);
    if (existing === undefined) {
      operationByPath.set(operation.filePath, operation);
      continue;
    }

    const merged = mergeTaskCheckpointOperations(existing, operation);
    if (merged === null) {
      operationByPath.delete(operation.filePath);
    } else {
      operationByPath.set(operation.filePath, merged);
    }
  }

  return [...operationByPath.values()];
}

export function recordLastTaskCheckpoint(
  options: RecordLastBatchCheckpointOptions,
): RecordLastEditCheckpointResult {
  const operations = coalesceTaskCheckpointOperations(options.operations);
  if (operations.length === 0) {
    return skippedBatchCheckpointRecord(options, "empty task checkpoint");
  }

  if (operations.length === 1) {
    for (const operation of operations) {
      if (operation.operation === "create") {
        return recordLastCreateCheckpoint({
          workspace: options.workspace,
          filePath: operation.filePath,
          afterContent: operation.afterContent,
        });
      }
      if (operation.operation === "delete") {
        return recordLastDeleteCheckpoint({
          workspace: options.workspace,
          filePath: operation.filePath,
          beforeContent: operation.beforeContent,
          mode: operation.mode,
        });
      }
      return recordLastEditCheckpoint({
        workspace: options.workspace,
        filePath: operation.filePath,
        beforeContent: operation.beforeContent,
        afterContent: operation.afterContent,
      });
    }
  }

  return recordLastBatchCheckpoint({
    workspace: options.workspace,
    operations,
  });
}

function blockedRestore(
  checkpoint: {
    readonly relativePath: string;
  },
  reason = "Refusing to overwrite user changes.",
): RestoreLastEditCheckpointResult {
  return {
    status: "blocked",
    filePath: checkpoint.relativePath,
    message: `Cannot undo ${checkpoint.relativePath}: ${reason}`,
  };
}

type BatchCheckpoint = Extract<
  LastEditCheckpoint,
  { readonly operation: "batch" }
>;

type ResolvedBatchRestoreOperation =
  | {
      readonly operation: "edit";
      readonly restorePath: string;
      readonly relativePath: string;
      readonly beforeContent: string;
      readonly afterContent: string;
    }
  | {
      readonly operation: "create";
      readonly filePath: string;
      readonly relativePath: string;
      readonly exists: false;
      readonly afterContent: string;
    }
  | {
      readonly operation: "create";
      readonly filePath: string;
      readonly relativePath: string;
      readonly exists: true;
      readonly afterContent: string;
      readonly mode: number;
    }
  | {
      readonly operation: "delete";
      readonly filePath: string;
      readonly relativePath: string;
      readonly beforeContent: string;
      readonly mode: number;
    };

function checkpointTargetPath(gitRoot: string, relativePath: string): string {
  const filePath = resolve(gitRoot, relativePath);
  if (!isInside(gitRoot, filePath)) {
    throw new KeelError(
      "tool_unavailable",
      "undo failed: checkpoint is invalid",
    );
  }
  return filePath;
}

function validateBatchRestoreOperation(
  gitRoot: string,
  operation: BatchCheckpoint["operations"][number],
): ResolvedBatchRestoreOperation | RestoreLastEditCheckpointResult {
  const filePath = checkpointTargetPath(gitRoot, operation.relativePath);
  if (operation.operation === "delete") {
    if (lstatIfPossible(filePath) !== null) {
      return blockedRestore(operation);
    }
    const parentPath = realpathIfPossible(dirname(filePath));
    if (parentPath === null || !isInside(gitRoot, parentPath)) {
      return blockedRestore(operation);
    }
    return {
      operation: "delete",
      filePath,
      relativePath: operation.relativePath,
      beforeContent: operation.beforeContent,
      mode: operation.mode,
    };
  }

  if (operation.operation === "create") {
    const targetStat = lstatIfPossible(filePath);
    if (targetStat === null) {
      return {
        operation: "create",
        filePath,
        relativePath: operation.relativePath,
        exists: false,
        afterContent: operation.afterContent,
      };
    }
    if (targetStat.isSymbolicLink()) {
      return blockedRestore(operation);
    }
    const restorePath = realpathIfPossible(filePath);
    /* v8 ignore next 3: symlinks are blocked above; this guards post-validation path races. */
    if (restorePath === null || !isInside(gitRoot, restorePath)) {
      return blockedRestore(operation);
    }
    const currentContent = readFileIfPossible(restorePath);
    if (currentContent !== operation.afterContent) {
      return blockedRestore(operation);
    }
    return {
      operation: "create",
      filePath,
      relativePath: operation.relativePath,
      exists: true,
      afterContent: operation.afterContent,
      mode: targetStat.mode & 0o7777,
    };
  }

  const restorePath = realpathIfPossible(filePath);
  if (restorePath === null || !isInside(gitRoot, restorePath)) {
    return blockedRestore(operation);
  }
  const currentContent = readFileIfPossible(restorePath);
  if (currentContent !== operation.afterContent) {
    return blockedRestore(operation);
  }
  return {
    operation: "edit",
    restorePath,
    relativePath: operation.relativePath,
    beforeContent: operation.beforeContent,
    afterContent: operation.afterContent,
  };
}

function isRestoreResult(
  value: ResolvedBatchRestoreOperation | RestoreLastEditCheckpointResult,
): value is RestoreLastEditCheckpointResult {
  return "status" in value;
}

function restoreDeletedFile(
  filePath: string,
  beforeContent: string,
  mode: number,
): boolean {
  let fileDescriptor: number | null = null;
  let created = false;
  try {
    fileDescriptor = openSync(filePath, "wx", mode);
    created = true;
    writeFileSync(fileDescriptor, beforeContent, "utf8");
    fchmodSync(fileDescriptor, mode);
    closeSync(fileDescriptor);
    fileDescriptor = null;
    return true;
  } catch {
    if (fileDescriptor !== null) {
      try {
        closeSync(fileDescriptor);
      } catch {
        // The descriptor may already have been closed by the failing operation.
      }
    }
    if (created) {
      try {
        rmSync(filePath, { force: true });
      } catch {
        // The checkpoint is preserved so the user can retry or inspect manually.
      }
    }
    return false;
  }
}

type AppliedBatchRestoreOperation =
  | {
      readonly operation: "edit";
      readonly restorePath: string;
      readonly afterContent: string;
    }
  | {
      readonly operation: "create";
      readonly filePath: string;
      readonly afterContent: string;
      readonly mode: number;
    }
  | {
      readonly operation: "delete";
      readonly filePath: string;
    };

function rollbackBatchRestore(
  operations: readonly AppliedBatchRestoreOperation[],
): void {
  for (const operation of operations.toReversed()) {
    try {
      if (operation.operation === "edit") {
        writeFileSync(operation.restorePath, operation.afterContent, "utf8");
      } else if (operation.operation === "create") {
        writeFileSync(operation.filePath, operation.afterContent, {
          encoding: "utf8",
          mode: operation.mode,
        });
      } else {
        rmSync(operation.filePath, { force: true });
      }
    } catch {
      // Best-effort rollback: the checkpoint is preserved so the user can retry.
    }
  }
}

function blockedBatchRestore(
  applied: readonly AppliedBatchRestoreOperation[],
  operation: { readonly relativePath: string },
  reason?: string,
): RestoreLastEditCheckpointResult {
  rollbackBatchRestore(applied);
  return blockedRestore(operation, reason);
}

function restoreBatchCheckpoint(
  checkpoint: BatchCheckpoint,
  gitWorkspace: GitWorkspace,
): RestoreLastEditCheckpointResult {
  const operations: ResolvedBatchRestoreOperation[] = [];
  for (const operation of checkpoint.operations) {
    const validated = validateBatchRestoreOperation(
      gitWorkspace.root,
      operation,
    );
    if (isRestoreResult(validated)) return validated;
    operations.push(validated);
  }

  const applied: AppliedBatchRestoreOperation[] = [];
  for (const operation of operations.toReversed()) {
    if (operation.operation === "create") {
      if (operation.exists) {
        try {
          rmSync(operation.filePath);
          applied.push({
            operation: "create",
            filePath: operation.filePath,
            afterContent: operation.afterContent,
            mode: operation.mode,
          });
        } catch {
          return blockedBatchRestore(
            applied,
            operation,
            "Could not restore file.",
          );
        }
      }
    } else if (operation.operation === "delete") {
      if (
        !restoreDeletedFile(
          operation.filePath,
          operation.beforeContent,
          operation.mode,
        )
      ) {
        return blockedBatchRestore(applied, operation);
      }
      applied.push({ operation: "delete", filePath: operation.filePath });
    } else {
      try {
        writeFileSync(operation.restorePath, operation.beforeContent, "utf8");
        applied.push({
          operation: "edit",
          restorePath: operation.restorePath,
          afterContent: operation.afterContent,
        });
      } catch {
        return blockedBatchRestore(
          [
            ...applied,
            {
              operation: "edit",
              restorePath: operation.restorePath,
              afterContent: operation.afterContent,
            },
          ],
          operation,
          "Could not restore file.",
        );
      }
    }
  }
  rmSync(gitWorkspace.checkpointPath, { force: true });
  return {
    status: "restored",
    restoredLabel: `${checkpoint.operations.length} files`,
  };
}

export function restoreLastEditCheckpoint(
  workspace: string,
): RestoreLastEditCheckpointResult {
  const gitWorkspace = findGitWorkspace(workspace);
  if (gitWorkspace === null || !existsSync(gitWorkspace.checkpointPath)) {
    return { status: "none", message: NO_UNDO_CHECKPOINT_MESSAGE };
  }

  const checkpoint = readCheckpoint(gitWorkspace.checkpointPath);
  if (checkpoint.gitRoot !== gitWorkspace.root) {
    return { status: "none", message: NO_UNDO_CHECKPOINT_MESSAGE };
  }

  if (checkpoint.operation === "batch") {
    return restoreBatchCheckpoint(checkpoint, gitWorkspace);
  }

  const filePath = checkpointTargetPath(
    gitWorkspace.root,
    checkpoint.relativePath,
  );

  if (checkpoint.operation === "create") {
    const targetStat = lstatIfPossible(filePath);
    if (targetStat === null) {
      rmSync(gitWorkspace.checkpointPath, { force: true });
      return {
        status: "restored",
        restoredLabel: checkpoint.relativePath,
      };
    }

    if (targetStat.isSymbolicLink()) {
      return blockedRestore(checkpoint);
    }

    const restorePath = realpathIfPossible(filePath);
    if (restorePath === null || !isInside(gitWorkspace.root, restorePath)) {
      return blockedRestore(checkpoint);
    }

    const currentContent = readFileIfPossible(restorePath);
    if (currentContent !== checkpoint.afterContent) {
      return blockedRestore(checkpoint);
    }

    rmSync(filePath);
    rmSync(gitWorkspace.checkpointPath, { force: true });
    return {
      status: "restored",
      restoredLabel: checkpoint.relativePath,
    };
  }

  if (checkpoint.operation === "delete") {
    if (lstatIfPossible(filePath) !== null) {
      return blockedRestore(checkpoint);
    }
    const parentPath = realpathIfPossible(dirname(filePath));
    if (parentPath === null || !isInside(gitWorkspace.root, parentPath)) {
      return blockedRestore(checkpoint);
    }

    if (
      !restoreDeletedFile(filePath, checkpoint.beforeContent, checkpoint.mode)
    ) {
      return blockedRestore(checkpoint);
    }
    rmSync(gitWorkspace.checkpointPath, { force: true });
    return {
      status: "restored",
      restoredLabel: checkpoint.relativePath,
    };
  }

  const restorePath = realpathIfPossible(filePath);
  if (restorePath === null || !isInside(gitWorkspace.root, restorePath)) {
    return blockedRestore(checkpoint);
  }

  const currentContent = readFileIfPossible(restorePath);
  if (currentContent !== checkpoint.afterContent) {
    return blockedRestore(checkpoint);
  }

  writeFileSync(restorePath, checkpoint.beforeContent, "utf8");
  rmSync(gitWorkspace.checkpointPath, { force: true });
  return {
    status: "restored",
    restoredLabel: checkpoint.relativePath,
  };
}
