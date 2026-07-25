import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
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
import { z } from "zod";
import {
  createTextFileAtomically,
  restoreTextFileByIdentityBestEffort,
} from "../tools/atomic-write.ts";
import {
  type FileIdentity,
  fileIdentityFromStats,
  sameFileIdentity,
} from "../tools/workspace-path.ts";
import { KeelError } from "./error.ts";
import { debugLog } from "./logger.ts";
import type { RecordUndoCheckpointResult } from "./undo-protection.ts";

type UndoCheckpointNotWrittenReason = Extract<
  RecordUndoCheckpointResult,
  { readonly written: false }
>["reason"];

export interface RecordLastEditCheckpointOptions {
  readonly workspace: string;
  readonly filePath: string;
  readonly beforeContent: string;
  readonly afterContent: string;
  readonly modeOwnership: EditCheckpointModeOwnership;
}

export type EditCheckpointModeOwnership =
  | { readonly kind: "unowned" }
  | {
      readonly kind: "owned";
      readonly beforeMode: number;
      readonly afterMode: number;
    };

interface PersistedEditCheckpoint {
  readonly version: 1;
  readonly operation: "edit";
  readonly gitRoot: string;
  readonly relativePath: string;
  readonly beforeContent: string;
  readonly afterContent: string;
  readonly modeOwnership: EditCheckpointModeOwnership;
  readonly createdAt: string;
}

interface PersistedBatchEditCheckpointOperation {
  readonly operation: "edit";
  readonly relativePath: string;
  readonly beforeContent: string;
  readonly afterContent: string;
  readonly modeOwnership: EditCheckpointModeOwnership;
}

export interface RecordLastCreateCheckpointOptions {
  readonly workspace: string;
  readonly filePath: string;
  readonly afterContent: string;
  readonly mode?: number;
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
      readonly modeOwnership: EditCheckpointModeOwnership;
    }
  | {
      readonly operation: "create";
      readonly filePath: string;
      readonly afterContent: string;
      readonly mode?: number;
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

export interface UndoCheckpointSummary {
  readonly restoredLabel: string;
}

interface GitWorkspace {
  readonly root: string;
  readonly checkpointPath: string;
}

const CHECKPOINT_METADATA_PATH = "keel/undo-checkpoints.json";
const MAX_UNDO_CHECKPOINTS = 20;
const NO_UNDO_CHECKPOINT_MESSAGE =
  "No earlier checkpoints. Ask me to undo more, or use git to reset.";
// Checkpoints store filesystem mode bits for restore, not only Git regular-file modes.
const checkpointModeSchema = z.number().int().min(0).max(0o7777);

const gitOutputSchema = z
  .string()
  .transform((value) => value.trim())
  .pipe(z.string().min(1));

const editCheckpointFields = {
  version: z.literal(1),
  operation: z.literal("edit"),
  gitRoot: z.string().min(1),
  relativePath: z.string().min(1),
  beforeContent: z.string(),
  afterContent: z.string(),
  createdAt: z.string().min(1),
};
const editCheckpointSchema = z.union([
  z
    .object(editCheckpointFields)
    .strict()
    .transform(
      (checkpoint): PersistedEditCheckpoint => ({
        ...checkpoint,
        modeOwnership: { kind: "unowned" },
      }),
    ),
  z
    .object({
      ...editCheckpointFields,
      beforeMode: checkpointModeSchema,
      afterMode: checkpointModeSchema,
    })
    .strict()
    .transform(
      ({ beforeMode, afterMode, ...checkpoint }): PersistedEditCheckpoint => ({
        ...checkpoint,
        modeOwnership: {
          kind: "owned",
          beforeMode,
          afterMode,
        },
      }),
    ),
]);

const createCheckpointSchema = z
  .object({
    version: z.literal(2),
    operation: z.literal("create"),
    gitRoot: z.string().min(1),
    relativePath: z.string().min(1),
    afterContent: z.string(),
    mode: checkpointModeSchema.optional(),
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
    mode: checkpointModeSchema,
    createdAt: z.string().min(1),
  })
  .strict();

const batchEditCheckpointOperationFields = {
  operation: z.literal("edit"),
  relativePath: z.string().min(1),
  beforeContent: z.string(),
  afterContent: z.string(),
};
const batchEditCheckpointOperationSchema = z.union([
  z
    .object(batchEditCheckpointOperationFields)
    .strict()
    .transform(
      (operation): PersistedBatchEditCheckpointOperation => ({
        ...operation,
        modeOwnership: { kind: "unowned" },
      }),
    ),
  z
    .object({
      ...batchEditCheckpointOperationFields,
      beforeMode: checkpointModeSchema,
      afterMode: checkpointModeSchema,
    })
    .strict()
    .transform(
      ({
        beforeMode,
        afterMode,
        ...operation
      }): PersistedBatchEditCheckpointOperation => ({
        ...operation,
        modeOwnership: {
          kind: "owned",
          beforeMode,
          afterMode,
        },
      }),
    ),
]);

const batchCheckpointOperationSchema = z.union([
  batchEditCheckpointOperationSchema,
  z
    .object({
      operation: z.literal("create"),
      relativePath: z.string().min(1),
      afterContent: z.string(),
      mode: checkpointModeSchema.optional(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("delete"),
      relativePath: z.string().min(1),
      beforeContent: z.string(),
      mode: checkpointModeSchema,
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

const checkpointStackSchema = z
  .object({
    version: z.literal(1),
    checkpoints: z.array(checkpointSchema).max(MAX_UNDO_CHECKPOINTS),
  })
  .strict();

type LastEditCheckpoint = z.infer<typeof checkpointSchema>;
type PersistedCheckpoint = z.infer<typeof checkpointSchema>;
type PersistedBatchCheckpointOperation = z.infer<
  typeof batchCheckpointOperationSchema
>;
type CheckpointForDisk = z.input<typeof checkpointSchema>;
type BatchCheckpointOperationForDisk = z.input<
  typeof batchCheckpointOperationSchema
>;
type PersistedNonCreateBatchCheckpointOperation = Exclude<
  PersistedBatchCheckpointOperation,
  { readonly operation: "create" }
>;
type CoalescableUndoCheckpointOperation =
  | PersistedNonCreateBatchCheckpointOperation
  | {
      readonly operation: "create";
      readonly relativePath: string;
      readonly afterContent: string;
      readonly mode?: number;
      readonly currentMissingAllowed: boolean;
    };
type CoalescedUndoCheckpointOperation =
  | CoalescableUndoCheckpointOperation
  | {
      readonly operation: "expect-missing";
      readonly relativePath: string;
    }
  | {
      readonly operation: "delete-create";
      readonly relativePath: string;
      readonly beforeContent: string;
      readonly afterContent: string;
      readonly mode: number;
      readonly afterMode?: number;
      readonly currentMissingAllowed: boolean;
    };
type UndoCheckpointFileState =
  | { readonly status: "missing" }
  | {
      readonly status: "file";
      readonly content: string;
      readonly mode?: number;
    };
type UndoCheckpointCoalesceResult =
  | {
      readonly status: "ok";
      readonly operations: readonly CoalescedUndoCheckpointOperation[];
    }
  | RestoreLastEditCheckpointResult;

function editModeOwnershipForDisk(
  ownership: EditCheckpointModeOwnership,
):
  | Record<string, never>
  | { readonly beforeMode: number; readonly afterMode: number } {
  return ownership.kind === "unowned"
    ? {}
    : {
        beforeMode: ownership.beforeMode,
        afterMode: ownership.afterMode,
      };
}

function batchCheckpointOperationForDisk(
  operation: PersistedBatchCheckpointOperation,
): BatchCheckpointOperationForDisk {
  if (operation.operation !== "edit") {
    return operation;
  }
  return {
    operation: "edit",
    relativePath: operation.relativePath,
    beforeContent: operation.beforeContent,
    afterContent: operation.afterContent,
    ...editModeOwnershipForDisk(operation.modeOwnership),
  };
}

function checkpointForDisk(checkpoint: PersistedCheckpoint): CheckpointForDisk {
  if (checkpoint.operation === "edit") {
    return {
      version: 1,
      operation: "edit",
      gitRoot: checkpoint.gitRoot,
      relativePath: checkpoint.relativePath,
      beforeContent: checkpoint.beforeContent,
      afterContent: checkpoint.afterContent,
      ...editModeOwnershipForDisk(checkpoint.modeOwnership),
      createdAt: checkpoint.createdAt,
    };
  }
  if (checkpoint.operation === "batch") {
    return {
      ...checkpoint,
      operations: checkpoint.operations.map(batchCheckpointOperationForDisk),
    };
  }
  return checkpoint;
}

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
  checkpoints: readonly PersistedCheckpoint[],
): void {
  mkdirSync(dirname(checkpointPath), { recursive: true });
  const temporaryPath = `${checkpointPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(
      temporaryPath,
      `${JSON.stringify({
        version: 1,
        checkpoints: checkpoints.map(checkpointForDisk),
      })}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
    renameSync(temporaryPath, checkpointPath);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

function invalidCheckpointError(): never {
  throw new KeelError("tool_unavailable", "undo failed: checkpoint is invalid");
}

function readCheckpoints(
  checkpointPath: string,
): readonly LastEditCheckpoint[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(checkpointPath, "utf8"));
  } catch {
    invalidCheckpointError();
  }

  const result = checkpointStackSchema.safeParse(parsed);
  if (!result.success) {
    invalidCheckpointError();
  }
  return result.data.checkpoints;
}

function readExistingCheckpointsForAppend(
  checkpointPath: string,
): readonly LastEditCheckpoint[] {
  if (!existsSync(checkpointPath)) return [];
  try {
    return readCheckpoints(checkpointPath);
  } catch (error) {
    debugLog(
      `undo checkpoint stack reset: path=${checkpointPath} error=${error}`,
    );
    return [];
  }
}

function appendCheckpoint(
  gitWorkspace: GitWorkspace,
  checkpoint: PersistedCheckpoint,
): void {
  const existingCheckpoints = readExistingCheckpointsForAppend(
    gitWorkspace.checkpointPath,
  );
  writeCheckpoint(
    gitWorkspace.checkpointPath,
    [...existingCheckpoints, checkpoint].slice(-MAX_UNDO_CHECKPOINTS),
  );
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

function fileMode(stat: Stats): number {
  return stat.mode & 0o7777;
}

function modeMatches(stat: Stats, expectedMode: number | undefined): boolean {
  return expectedMode === undefined || fileMode(stat) === expectedMode;
}

function editModeBefore(
  ownership: EditCheckpointModeOwnership,
): number | undefined {
  return ownership.kind === "owned" ? ownership.beforeMode : undefined;
}

function editModeAfter(
  ownership: EditCheckpointModeOwnership,
): number | undefined {
  return ownership.kind === "owned" ? ownership.afterMode : undefined;
}

function editModeOwnershipFromKnownBefore(
  beforeMode: number,
  afterMode: number | undefined,
): EditCheckpointModeOwnership {
  return afterMode === undefined
    ? { kind: "unowned" }
    : { kind: "owned", beforeMode, afterMode };
}

function advanceEditModeOwnership(
  ownership: EditCheckpointModeOwnership,
  afterMode: number | undefined,
): EditCheckpointModeOwnership {
  if (ownership.kind === "unowned") {
    return ownership;
  }
  return {
    kind: "owned",
    beforeMode: ownership.beforeMode,
    afterMode: afterMode ?? ownership.afterMode,
  };
}

function modeState(mode: number | undefined): { readonly mode?: number } {
  return mode === undefined ? {} : { mode };
}

function afterModeState(mode: number | undefined): {
  readonly afterMode?: number;
} {
  return mode === undefined ? {} : { afterMode: mode };
}

function skippedCheckpointRecord(
  options: { readonly workspace: string; readonly filePath: string },
  error: string,
  reason: UndoCheckpointNotWrittenReason,
): RecordUndoCheckpointResult {
  debugLog(
    `undo checkpoint write skipped: workspace=${options.workspace} filePath=${options.filePath} error=${error}`,
  );
  return { written: false, reason };
}

function skippedBatchCheckpointRecord(
  options: RecordLastBatchCheckpointOptions,
  error: string,
  reason: UndoCheckpointNotWrittenReason,
): RecordUndoCheckpointResult {
  debugLog(
    `undo checkpoint write skipped: workspace=${options.workspace} operations=${options.operations.length} error=${error}`,
  );
  return { written: false, reason };
}

export function recordLastEditCheckpoint(
  options: RecordLastEditCheckpointOptions,
): RecordUndoCheckpointResult {
  try {
    const gitWorkspace = findGitWorkspace(options.workspace);
    if (gitWorkspace === null) {
      return skippedCheckpointRecord(
        options,
        "git workspace unavailable",
        "git_workspace_unavailable",
      );
    }

    const relativePath = normalizeRelativePath(
      gitWorkspace.root,
      options.filePath,
    );
    if (relativePath === null) {
      return skippedCheckpointRecord(
        options,
        "file path unavailable or outside git root",
        "target_unavailable",
      );
    }

    appendCheckpoint(gitWorkspace, {
      version: 1,
      operation: "edit",
      gitRoot: gitWorkspace.root,
      relativePath,
      beforeContent: options.beforeContent,
      afterContent: options.afterContent,
      modeOwnership: options.modeOwnership,
      createdAt: new Date().toISOString(),
    });

    return { written: true };
  } catch (error) {
    return skippedCheckpointRecord(
      options,
      String(error),
      "checkpoint_write_failed",
    );
  }
}

export function recordLastCreateCheckpoint(
  options: RecordLastCreateCheckpointOptions,
): RecordUndoCheckpointResult {
  try {
    const gitWorkspace = findGitWorkspace(options.workspace);
    if (gitWorkspace === null) {
      return skippedCheckpointRecord(
        options,
        "git workspace unavailable",
        "git_workspace_unavailable",
      );
    }

    const relativePath = normalizeRelativePath(
      gitWorkspace.root,
      options.filePath,
    );
    if (relativePath === null) {
      return skippedCheckpointRecord(
        options,
        "file path unavailable or outside git root",
        "target_unavailable",
      );
    }

    appendCheckpoint(gitWorkspace, {
      version: 2,
      operation: "create",
      gitRoot: gitWorkspace.root,
      relativePath,
      afterContent: options.afterContent,
      ...modeState(options.mode),
      createdAt: new Date().toISOString(),
    });

    return { written: true };
  } catch (error) {
    return skippedCheckpointRecord(
      options,
      String(error),
      "checkpoint_write_failed",
    );
  }
}

export function recordLastDeleteCheckpoint(
  options: RecordLastDeleteCheckpointOptions,
): RecordUndoCheckpointResult {
  try {
    const gitWorkspace = findGitWorkspace(options.workspace);
    if (gitWorkspace === null) {
      return skippedCheckpointRecord(
        options,
        "git workspace unavailable",
        "git_workspace_unavailable",
      );
    }

    const relativePath = normalizeDeletedRelativePath(
      gitWorkspace.root,
      options.filePath,
    );
    if (relativePath === null) {
      return skippedCheckpointRecord(
        options,
        "file path unavailable or outside git root",
        "target_unavailable",
      );
    }

    appendCheckpoint(gitWorkspace, {
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
    return skippedCheckpointRecord(
      options,
      String(error),
      "checkpoint_write_failed",
    );
  }
}

export function recordLastBatchCheckpoint(
  options: RecordLastBatchCheckpointOptions,
): RecordUndoCheckpointResult {
  try {
    const gitWorkspace = findGitWorkspace(options.workspace);
    if (gitWorkspace === null) {
      return skippedBatchCheckpointRecord(
        options,
        "git workspace unavailable",
        "git_workspace_unavailable",
      );
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
          "target_unavailable",
        );
      }

      if (operation.operation === "edit") {
        operations.push({
          operation: "edit",
          relativePath,
          beforeContent: operation.beforeContent,
          afterContent: operation.afterContent,
          modeOwnership: operation.modeOwnership,
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
          ...modeState(operation.mode),
        });
      }
    }

    if (operations.length === 0) {
      return skippedBatchCheckpointRecord(
        options,
        "empty batch checkpoint",
        "no_changes",
      );
    }

    appendCheckpoint(gitWorkspace, {
      version: 3,
      operation: "batch",
      gitRoot: gitWorkspace.root,
      operations,
      createdAt: new Date().toISOString(),
    });

    return { written: true };
  } catch (error) {
    return skippedBatchCheckpointRecord(
      options,
      String(error),
      "checkpoint_write_failed",
    );
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
      ...(next.operation === "edit"
        ? modeState(editModeAfter(next.modeOwnership) ?? existing.mode)
        : modeState(next.mode ?? existing.mode)),
    };
  }

  if (existing.operation === "delete") {
    if (next.operation === "delete") return existing;
    const nextMode =
      next.operation === "edit" ? editModeAfter(next.modeOwnership) : next.mode;
    return {
      operation: "edit",
      filePath: existing.filePath,
      beforeContent: existing.beforeContent,
      afterContent: next.afterContent,
      modeOwnership: editModeOwnershipFromKnownBefore(existing.mode, nextMode),
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
    modeOwnership: advanceEditModeOwnership(
      existing.modeOwnership,
      next.operation === "edit" ? editModeAfter(next.modeOwnership) : next.mode,
    ),
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

function undoCheckpointOperationBeforeState(
  operation: CoalescableUndoCheckpointOperation,
): UndoCheckpointFileState {
  if (operation.operation === "create") return { status: "missing" };
  if (operation.operation === "edit") {
    return {
      status: "file",
      content: operation.beforeContent,
      ...modeState(editModeBefore(operation.modeOwnership)),
    };
  }
  return {
    status: "file",
    content: operation.beforeContent,
    mode: operation.mode,
  };
}

function undoCheckpointOperationAfterState(
  operation: CoalescedUndoCheckpointOperation,
): UndoCheckpointFileState {
  if (operation.operation === "delete") return { status: "missing" };
  if (operation.operation === "create") {
    return {
      status: "file",
      content: operation.afterContent,
      ...modeState(operation.mode),
    };
  }
  if (operation.operation === "delete-create") {
    return {
      status: "file",
      content: operation.afterContent,
      ...modeState(operation.afterMode),
    };
  }
  if (operation.operation === "edit") {
    return {
      status: "file",
      content: operation.afterContent,
      ...modeState(editModeAfter(operation.modeOwnership)),
    };
  }
  return { status: "missing" };
}

function sameUndoCheckpointFileState(
  first: UndoCheckpointFileState,
  second: UndoCheckpointFileState,
): boolean {
  if (first.status === "missing" || second.status === "missing") {
    return first.status === second.status;
  }
  if (first.content !== second.content) return false;
  // Undefined means this checkpoint did not own the file mode; it is a
  // wildcard for continuity, while restore validation still checks owned modes.
  if (first.mode !== undefined && second.mode !== undefined) {
    return first.mode === second.mode;
  }
  return true;
}

function undoCheckpointOperationCanRestoreFromMissing(
  operation: CoalescedUndoCheckpointOperation,
): boolean {
  if (operation.operation === "expect-missing") {
    return true;
  }
  if (operation.operation === "create") return operation.currentMissingAllowed;
  if (operation.operation === "delete-create") {
    return operation.currentMissingAllowed;
  }
  return false;
}

function mergeUndoCheckpointOperations(
  existing: CoalescedUndoCheckpointOperation,
  next: CoalescableUndoCheckpointOperation,
): CoalescedUndoCheckpointOperation | RestoreLastEditCheckpointResult {
  const existingAfterState = undoCheckpointOperationAfterState(existing);
  const nextBeforeState = undoCheckpointOperationBeforeState(next);
  const canContinueFromMissing =
    nextBeforeState.status === "missing" &&
    undoCheckpointOperationCanRestoreFromMissing(existing);
  if (
    !sameUndoCheckpointFileState(existingAfterState, nextBeforeState) &&
    !canContinueFromMissing
  ) {
    return blockedRestore(next);
  }

  if (existing.operation === "expect-missing") {
    /* v8 ignore next 3: continuity rejects non-create operations before this branch. */
    if (next.operation !== "create") {
      invalidCheckpointError();
    }
    return {
      operation: "create",
      relativePath: existing.relativePath,
      afterContent: next.afterContent,
      ...modeState(next.mode),
      currentMissingAllowed: true,
    };
  }

  if (existing.operation === "create") {
    if (next.operation === "delete") {
      return {
        operation: "expect-missing",
        relativePath: existing.relativePath,
      };
    }
    return {
      operation: "create",
      relativePath: existing.relativePath,
      afterContent: next.afterContent,
      ...(next.operation === "edit"
        ? modeState(editModeAfter(next.modeOwnership) ?? existing.mode)
        : modeState(next.mode ?? existing.mode)),
      currentMissingAllowed: next.operation === "create",
    };
  }

  if (existing.operation === "delete") {
    /* v8 ignore next 3: continuity rejects non-create operations after a delete. */
    if (next.operation !== "create") {
      invalidCheckpointError();
    }
    return {
      operation: "delete-create",
      relativePath: existing.relativePath,
      beforeContent: existing.beforeContent,
      afterContent: next.afterContent,
      mode: existing.mode,
      ...afterModeState(next.mode),
      currentMissingAllowed: true,
    };
  }

  if (existing.operation === "delete-create") {
    if (next.operation === "delete") {
      return {
        operation: "delete",
        relativePath: existing.relativePath,
        beforeContent: existing.beforeContent,
        mode: existing.mode,
      };
    }
    if (next.operation === "create") {
      return {
        operation: "delete-create",
        relativePath: existing.relativePath,
        beforeContent: existing.beforeContent,
        afterContent: next.afterContent,
        mode: existing.mode,
        ...afterModeState(next.mode ?? existing.afterMode),
        currentMissingAllowed: true,
      };
    }
    return {
      operation: "delete-create",
      relativePath: existing.relativePath,
      beforeContent: existing.beforeContent,
      afterContent: next.afterContent,
      mode: existing.mode,
      ...afterModeState(
        editModeAfter(next.modeOwnership) ?? existing.afterMode,
      ),
      currentMissingAllowed: false,
    };
  }

  if (next.operation === "delete") {
    return {
      operation: "delete",
      relativePath: existing.relativePath,
      beforeContent: existing.beforeContent,
      mode: next.mode,
    };
  }

  /* v8 ignore next 3: continuity rejects create-after-edit before this merge path. */
  if (next.operation !== "edit") {
    invalidCheckpointError();
  }
  return {
    operation: "edit",
    relativePath: existing.relativePath,
    beforeContent: existing.beforeContent,
    afterContent: next.afterContent,
    modeOwnership: advanceEditModeOwnership(
      existing.modeOwnership,
      editModeAfter(next.modeOwnership),
    ),
  };
}

function coalesceUndoCheckpointOperations(
  checkpointOperations: readonly PersistedBatchCheckpointOperation[],
): UndoCheckpointCoalesceResult {
  const operationByPath = new Map<string, CoalescedUndoCheckpointOperation>();

  for (const operation of checkpointOperations) {
    const coalescedOperation: CoalescableUndoCheckpointOperation =
      operation.operation === "create"
        ? {
            operation: "create",
            relativePath: operation.relativePath,
            afterContent: operation.afterContent,
            ...modeState(operation.mode),
            currentMissingAllowed: true,
          }
        : operation;
    const existing = operationByPath.get(operation.relativePath);
    if (existing === undefined) {
      operationByPath.set(operation.relativePath, coalescedOperation);
      continue;
    }

    const merged = mergeUndoCheckpointOperations(existing, coalescedOperation);
    if ("status" in merged) return merged;
    operationByPath.set(operation.relativePath, merged);
  }

  return { status: "ok", operations: [...operationByPath.values()] };
}

function checkpointForwardOperations(
  checkpoint: LastEditCheckpoint,
): readonly PersistedBatchCheckpointOperation[] {
  if (checkpoint.operation === "batch") return checkpoint.operations;
  if (checkpoint.operation === "edit") {
    return [
      {
        operation: "edit",
        relativePath: checkpoint.relativePath,
        beforeContent: checkpoint.beforeContent,
        afterContent: checkpoint.afterContent,
        modeOwnership: checkpoint.modeOwnership,
      },
    ];
  }
  if (checkpoint.operation === "delete") {
    return [
      {
        operation: "delete",
        relativePath: checkpoint.relativePath,
        beforeContent: checkpoint.beforeContent,
        mode: checkpoint.mode,
      },
    ];
  }
  return [
    {
      operation: "create",
      relativePath: checkpoint.relativePath,
      afterContent: checkpoint.afterContent,
      ...modeState(checkpoint.mode),
    },
  ];
}

export function recordLastTaskCheckpoint(
  options: RecordLastBatchCheckpointOptions,
): RecordUndoCheckpointResult {
  const operations = coalesceTaskCheckpointOperations(options.operations);
  if (operations.length === 0) {
    return skippedBatchCheckpointRecord(
      options,
      "empty task checkpoint",
      "no_changes",
    );
  }

  if (operations.length === 1) {
    for (const operation of operations) {
      if (operation.operation === "create") {
        return recordLastCreateCheckpoint({
          workspace: options.workspace,
          filePath: operation.filePath,
          afterContent: operation.afterContent,
          ...modeState(operation.mode),
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
        modeOwnership: operation.modeOwnership,
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
      readonly restoreMode: number;
      readonly rollbackMode: number;
      readonly identity: FileIdentity;
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
    if (restorePath === null || !isInside(gitRoot, restorePath)) {
      return blockedRestore(operation);
    }
    const currentContent = readFileIfPossible(restorePath);
    if (currentContent !== operation.afterContent) {
      return blockedRestore(operation);
    }
    if (!modeMatches(targetStat, operation.mode)) {
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

  const targetStat = lstatIfPossible(filePath);
  if (targetStat === null || targetStat.isSymbolicLink()) {
    return blockedRestore(operation);
  }
  const restorePath = realpathIfPossible(filePath);
  if (restorePath === null || !isInside(gitRoot, restorePath)) {
    return blockedRestore(operation);
  }
  const currentContent = readFileIfPossible(restorePath);
  if (currentContent !== operation.afterContent) {
    return blockedRestore(operation);
  }
  if (!modeMatches(targetStat, editModeAfter(operation.modeOwnership))) {
    return blockedRestore(operation);
  }
  return {
    operation: "edit",
    restorePath,
    relativePath: operation.relativePath,
    beforeContent: operation.beforeContent,
    afterContent: operation.afterContent,
    restoreMode:
      operation.modeOwnership.kind === "owned"
        ? operation.modeOwnership.beforeMode
        : targetStat.mode & 0o7777,
    rollbackMode:
      operation.modeOwnership.kind === "owned"
        ? operation.modeOwnership.afterMode
        : targetStat.mode & 0o7777,
    identity: fileIdentityFromStats(targetStat),
  };
}

function restoreEditedFile(
  operation: Extract<
    ResolvedBatchRestoreOperation,
    { readonly operation: "edit" }
  >,
): FileIdentity | null {
  let fileDescriptor: number | null = null;
  let mutationStarted = false;
  try {
    fileDescriptor = openSync(
      operation.restorePath,
      constants.O_RDWR | constants.O_NOFOLLOW,
    );
    const openedStat = fstatSync(fileDescriptor);
    const openedIdentity = fileIdentityFromStats(openedStat);
    if (
      !sameFileIdentity(openedIdentity, operation.identity) ||
      !modeMatches(openedStat, operation.rollbackMode) ||
      readFileSync(fileDescriptor, "utf8") !== operation.afterContent
    ) {
      return null;
    }
    mutationStarted = true;
    ftruncateSync(fileDescriptor, 0);
    writeTextToDescriptor(fileDescriptor, operation.beforeContent);
    fchmodSync(fileDescriptor, operation.restoreMode);
    fsyncSync(fileDescriptor);
    if (
      !sameFileIdentity(
        fileIdentityFromStats(lstatSync(operation.restorePath)),
        openedIdentity,
      )
    ) {
      throw new Error("undo target changed during restore");
    }
    return openedIdentity;
  } catch {
    if (fileDescriptor !== null && mutationStarted) {
      try {
        ftruncateSync(fileDescriptor, 0);
        writeTextToDescriptor(fileDescriptor, operation.afterContent);
        fchmodSync(fileDescriptor, operation.rollbackMode);
        fsyncSync(fileDescriptor);
      } catch {
        // Best-effort recovery must not hide the original restore failure.
      }
    }
    return null;
  } finally {
    if (fileDescriptor !== null) {
      try {
        closeSync(fileDescriptor);
      } catch {
        // The descriptor may already have been closed by the failing operation.
      }
    }
  }
}

function writeTextToDescriptor(fileDescriptor: number, content: string): void {
  const contentBuffer = Buffer.from(content);
  let writeOffset = 0;
  while (writeOffset < contentBuffer.length) {
    const bytesWritten = writeSync(
      fileDescriptor,
      contentBuffer,
      writeOffset,
      contentBuffer.length - writeOffset,
      writeOffset,
    );
    if (bytesWritten === 0) {
      throw new Error("undo target write made no progress");
    }
    writeOffset += bytesWritten;
  }
}

function restoreDeletedFile(
  filePath: string,
  beforeContent: string,
  mode: number,
): FileIdentity | null {
  try {
    return createTextFileAtomically(filePath, beforeContent, { mode }).identity;
  } catch {
    return null;
  }
}

function removeFileByIdentityBestEffort(
  filePath: string,
  identity: FileIdentity,
  expectedContent: string,
): void {
  const quarantinePath = join(
    dirname(filePath),
    `.${basename(filePath)}.keel-undo-${process.pid}-${randomUUID()}.tmp`,
  );
  let quarantined = false;
  try {
    renameSync(filePath, quarantinePath);
    quarantined = true;
    if (
      sameFileIdentity(
        fileIdentityFromStats(lstatSync(quarantinePath)),
        identity,
      ) &&
      readFileIfPossible(quarantinePath) === expectedContent
    ) {
      rmSync(quarantinePath, { force: true });
      quarantined = false;
      return;
    }

    linkSync(quarantinePath, filePath);
    rmSync(quarantinePath, { force: true });
    quarantined = false;
  } catch {
    // Preserve the quarantined path if another process claimed the target.
  } finally {
    if (quarantined) {
      debugLog(`undo rollback preserved concurrent file: ${quarantinePath}`);
    }
  }
}

type AppliedBatchRestoreOperation =
  | {
      readonly operation: "edit";
      readonly restorePath: string;
      readonly restoredContent: string;
      readonly afterContent: string;
      readonly rollbackMode: number;
      readonly identity: FileIdentity;
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
      readonly restoredContent: string;
      readonly identity: FileIdentity;
    };

function rollbackBatchRestore(
  operations: readonly AppliedBatchRestoreOperation[],
): void {
  for (const operation of operations.toReversed()) {
    try {
      if (operation.operation === "edit") {
        restoreTextFileByIdentityBestEffort(
          operation.restorePath,
          operation.identity,
          {
            beforeContent: operation.afterContent,
            afterContent: operation.restoredContent,
          },
          operation.rollbackMode,
        );
      } else if (operation.operation === "create") {
        writeFileSync(operation.filePath, operation.afterContent, {
          encoding: "utf8",
          flag: "wx",
          mode: operation.mode,
        });
      } else {
        removeFileByIdentityBestEffort(
          operation.filePath,
          operation.identity,
          operation.restoredContent,
        );
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
  applied: AppliedBatchRestoreOperation[],
): RestoreLastEditCheckpointResult {
  const operations: ResolvedBatchRestoreOperation[] = [];
  for (const operation of checkpoint.operations) {
    const validated = validateBatchRestoreOperation(
      gitWorkspace.root,
      operation,
    );
    if ("status" in validated) return validated;
    operations.push(validated);
  }

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
      const identity = restoreDeletedFile(
        operation.filePath,
        operation.beforeContent,
        operation.mode,
      );
      if (identity === null) {
        return blockedBatchRestore(applied, operation);
      }
      applied.push({
        operation: "delete",
        filePath: operation.filePath,
        restoredContent: operation.beforeContent,
        identity,
      });
    } else {
      const identity = restoreEditedFile(operation);
      if (identity !== null) {
        applied.push({
          operation: "edit",
          restorePath: operation.restorePath,
          restoredContent: operation.beforeContent,
          afterContent: operation.afterContent,
          rollbackMode: operation.rollbackMode,
          identity,
        });
      } else {
        return blockedBatchRestore(
          applied,
          operation,
          "Could not restore file.",
        );
      }
    }
  }
  return {
    status: "restored",
    restoredLabel: `${checkpoint.operations.length} files`,
  };
}

type ResolvedDeleteCreateRestoreOperation =
  | {
      readonly operation: "delete-create";
      readonly filePath: string;
      readonly relativePath: string;
      readonly exists: false;
      readonly beforeContent: string;
      readonly mode: number;
    }
  | {
      readonly operation: "delete-create";
      readonly filePath: string;
      readonly restorePath: string;
      readonly relativePath: string;
      readonly exists: true;
      readonly beforeContent: string;
      readonly afterContent: string;
      readonly mode: number;
      readonly rollbackMode: number;
      readonly identity: FileIdentity;
    };

type ResolvedCoalescedRestoreOperation =
  | ResolvedBatchRestoreOperation
  | ResolvedDeleteCreateRestoreOperation;

function validateCoalescedCreateRestoreOperation(
  gitRoot: string,
  operation: Extract<
    CoalescedUndoCheckpointOperation,
    { readonly operation: "create" }
  >,
): ResolvedBatchRestoreOperation | RestoreLastEditCheckpointResult {
  const filePath = checkpointTargetPath(gitRoot, operation.relativePath);
  const targetStat = lstatIfPossible(filePath);
  if (targetStat === null) {
    if (!operation.currentMissingAllowed) {
      return blockedRestore(operation);
    }
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
  if (restorePath === null || !isInside(gitRoot, restorePath)) {
    return blockedRestore(operation);
  }
  const currentContent = readFileIfPossible(restorePath);
  if (currentContent !== operation.afterContent) {
    return blockedRestore(operation);
  }
  if (!modeMatches(targetStat, operation.mode)) {
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

function validateDeleteCreateRestoreOperation(
  gitRoot: string,
  operation: Extract<
    CoalescedUndoCheckpointOperation,
    { readonly operation: "delete-create" }
  >,
): ResolvedDeleteCreateRestoreOperation | RestoreLastEditCheckpointResult {
  const filePath = checkpointTargetPath(gitRoot, operation.relativePath);
  const targetStat = lstatIfPossible(filePath);
  if (targetStat === null) {
    if (!operation.currentMissingAllowed) {
      return blockedRestore(operation);
    }
    const parentPath = realpathIfPossible(dirname(filePath));
    if (parentPath === null || !isInside(gitRoot, parentPath)) {
      return blockedRestore(operation);
    }
    return {
      operation: "delete-create",
      filePath,
      relativePath: operation.relativePath,
      exists: false,
      beforeContent: operation.beforeContent,
      mode: operation.mode,
    };
  }

  if (targetStat.isSymbolicLink()) {
    return blockedRestore(operation);
  }

  const restorePath = realpathIfPossible(filePath);
  if (restorePath === null || !isInside(gitRoot, restorePath)) {
    return blockedRestore(operation);
  }
  const currentContent = readFileIfPossible(restorePath);
  if (currentContent !== operation.afterContent) {
    return blockedRestore(operation);
  }
  if (!modeMatches(targetStat, operation.afterMode)) {
    return blockedRestore(operation);
  }

  return {
    operation: "delete-create",
    filePath,
    restorePath,
    relativePath: operation.relativePath,
    exists: true,
    beforeContent: operation.beforeContent,
    afterContent: operation.afterContent,
    mode: operation.mode,
    rollbackMode: targetStat.mode & 0o7777,
    identity: fileIdentityFromStats(targetStat),
  };
}

function restoreResolvedCoalescedOperations(
  operations: readonly ResolvedCoalescedRestoreOperation[],
  applied: AppliedBatchRestoreOperation[],
): RestoreLastEditCheckpointResult | null {
  for (const operation of operations.toReversed()) {
    if (operation.operation === "delete-create") {
      if (!operation.exists) {
        const identity = restoreDeletedFile(
          operation.filePath,
          operation.beforeContent,
          operation.mode,
        );
        if (identity === null) {
          return blockedBatchRestore(applied, operation);
        }
        applied.push({
          operation: "delete",
          filePath: operation.filePath,
          restoredContent: operation.beforeContent,
          identity,
        });
        continue;
      }

      const rollbackOperation: AppliedBatchRestoreOperation = {
        operation: "edit",
        restorePath: operation.restorePath,
        restoredContent: operation.beforeContent,
        afterContent: operation.afterContent,
        rollbackMode: operation.rollbackMode,
        identity: operation.identity,
      };
      const identity = restoreEditedFile({
        operation: "edit",
        restorePath: operation.restorePath,
        relativePath: operation.relativePath,
        beforeContent: operation.beforeContent,
        afterContent: operation.afterContent,
        restoreMode: operation.mode,
        rollbackMode: operation.rollbackMode,
        identity: operation.identity,
      });
      if (identity !== null) {
        applied.push(rollbackOperation);
      } else {
        return blockedBatchRestore(
          applied,
          operation,
          "Could not restore file.",
        );
      }
      continue;
    }

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
      const identity = restoreDeletedFile(
        operation.filePath,
        operation.beforeContent,
        operation.mode,
      );
      if (identity === null) {
        return blockedBatchRestore(applied, operation);
      }
      applied.push({
        operation: "delete",
        filePath: operation.filePath,
        restoredContent: operation.beforeContent,
        identity,
      });
    } else {
      const identity = restoreEditedFile(operation);
      if (identity !== null) {
        applied.push({
          operation: "edit",
          restorePath: operation.restorePath,
          restoredContent: operation.beforeContent,
          afterContent: operation.afterContent,
          rollbackMode: operation.rollbackMode,
          identity,
        });
      } else {
        return blockedBatchRestore(
          applied,
          operation,
          "Could not restore file.",
        );
      }
    }
  }
  return null;
}

function restoreCheckpoint(
  checkpoint: LastEditCheckpoint,
  gitWorkspace: GitWorkspace,
  applied: AppliedBatchRestoreOperation[],
): RestoreLastEditCheckpointResult {
  if (checkpoint.operation === "batch") {
    return restoreBatchCheckpoint(checkpoint, gitWorkspace, applied);
  }

  const filePath = checkpointTargetPath(
    gitWorkspace.root,
    checkpoint.relativePath,
  );

  if (checkpoint.operation === "create") {
    const targetStat = lstatIfPossible(filePath);
    if (targetStat === null) {
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
    if (!modeMatches(targetStat, checkpoint.mode)) {
      return blockedRestore(checkpoint);
    }

    rmSync(filePath);
    applied.push({
      operation: "create",
      filePath,
      afterContent: checkpoint.afterContent,
      mode: targetStat.mode & 0o7777,
    });
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

    const identity = restoreDeletedFile(
      filePath,
      checkpoint.beforeContent,
      checkpoint.mode,
    );
    if (identity === null) {
      return blockedRestore(checkpoint);
    }
    applied.push({
      operation: "delete",
      filePath,
      restoredContent: checkpoint.beforeContent,
      identity,
    });
    return {
      status: "restored",
      restoredLabel: checkpoint.relativePath,
    };
  }

  const targetStat = lstatIfPossible(filePath);
  if (targetStat === null || targetStat.isSymbolicLink()) {
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
  if (!modeMatches(targetStat, editModeAfter(checkpoint.modeOwnership))) {
    return blockedRestore(checkpoint);
  }

  const restoreMode =
    checkpoint.modeOwnership.kind === "owned"
      ? checkpoint.modeOwnership.beforeMode
      : targetStat.mode & 0o7777;
  const rollbackMode =
    checkpoint.modeOwnership.kind === "owned"
      ? checkpoint.modeOwnership.afterMode
      : targetStat.mode & 0o7777;
  const identity = restoreEditedFile({
    operation: "edit",
    restorePath,
    relativePath: checkpoint.relativePath,
    beforeContent: checkpoint.beforeContent,
    afterContent: checkpoint.afterContent,
    restoreMode,
    rollbackMode,
    identity: fileIdentityFromStats(targetStat),
  });
  if (identity === null) {
    return blockedRestore(checkpoint, "Could not restore file.");
  }
  applied.push({
    operation: "edit",
    restorePath,
    restoredContent: checkpoint.beforeContent,
    afterContent: checkpoint.afterContent,
    rollbackMode,
    identity,
  });
  return {
    status: "restored",
    restoredLabel: checkpoint.relativePath,
  };
}

function checkpointRestoredLabel(checkpoint: LastEditCheckpoint): string {
  if (checkpoint.operation === "batch") {
    return `${checkpoint.operations.length} files`;
  }
  return checkpoint.relativePath;
}

function selectedCheckpointsRestoredLabel(
  checkpoints: readonly LastEditCheckpoint[],
): string {
  return `${checkpoints.length} checkpoints`;
}

function unavailableUndoCheckpointMessage(checkpointIndex: number): string {
  return `No undo checkpoint ${checkpointIndex}. Run keel /undo --list to choose an available checkpoint.`;
}

function restoreCoalescedUndoCheckpointOperations(
  operations: readonly CoalescedUndoCheckpointOperation[],
  gitWorkspace: GitWorkspace,
  applied: AppliedBatchRestoreOperation[],
): RestoreLastEditCheckpointResult {
  const restoreOperations: ResolvedCoalescedRestoreOperation[] = [];
  for (const operation of operations) {
    if (operation.operation === "expect-missing") {
      const filePath = checkpointTargetPath(
        gitWorkspace.root,
        operation.relativePath,
      );
      if (lstatIfPossible(filePath) !== null) {
        return blockedRestore(operation);
      }
      continue;
    }
    const validated =
      operation.operation === "delete-create"
        ? validateDeleteCreateRestoreOperation(gitWorkspace.root, operation)
        : operation.operation === "create"
          ? validateCoalescedCreateRestoreOperation(
              gitWorkspace.root,
              operation,
            )
          : validateBatchRestoreOperation(gitWorkspace.root, operation);
    if ("status" in validated) return validated;
    restoreOperations.push(validated);
  }

  if (restoreOperations.length === 0) {
    return {
      status: "restored",
      restoredLabel: "0 files",
    };
  }

  const blocked = restoreResolvedCoalescedOperations(
    restoreOperations,
    applied,
  );
  if (blocked !== null) return blocked;
  return {
    status: "restored",
    restoredLabel: `${restoreOperations.length} files`,
  };
}

function readWorkspaceCheckpointStack(
  gitWorkspace: GitWorkspace,
): readonly LastEditCheckpoint[] {
  if (!existsSync(gitWorkspace.checkpointPath)) {
    return [];
  }
  return readCheckpoints(gitWorkspace.checkpointPath);
}

export function listUndoCheckpoints(
  workspace: string,
): readonly UndoCheckpointSummary[] {
  const gitWorkspace = findGitWorkspace(workspace);
  if (gitWorkspace === null) return [];

  return readWorkspaceCheckpointStack(gitWorkspace)
    .toReversed()
    .map((checkpoint) => ({
      restoredLabel: checkpointRestoredLabel(checkpoint),
    }));
}

export function restoreLastEditCheckpoint(
  workspace: string,
): RestoreLastEditCheckpointResult {
  return restoreUndoCheckpointsThrough(workspace, 1);
}

export function restoreUndoCheckpointsThrough(
  workspace: string,
  checkpointIndex: number,
): RestoreLastEditCheckpointResult {
  const gitWorkspace = findGitWorkspace(workspace);
  if (gitWorkspace === null) {
    return { status: "none", message: NO_UNDO_CHECKPOINT_MESSAGE };
  }

  if (!Number.isSafeInteger(checkpointIndex) || checkpointIndex < 1) {
    return {
      status: "none",
      message: unavailableUndoCheckpointMessage(checkpointIndex),
    };
  }

  const checkpoints = readWorkspaceCheckpointStack(gitWorkspace);
  if (checkpoints.length === 0) {
    return { status: "none", message: NO_UNDO_CHECKPOINT_MESSAGE };
  }
  if (checkpointIndex > checkpoints.length) {
    return {
      status: "none",
      message: unavailableUndoCheckpointMessage(checkpointIndex),
    };
  }

  const selectedCheckpoints = checkpoints.slice(-checkpointIndex);
  if (checkpointIndex === 1) {
    const checkpoint = selectedCheckpoints.reduce(
      (_previous, current) => current,
    );
    const applied: AppliedBatchRestoreOperation[] = [];
    const result = restoreCheckpoint(checkpoint, gitWorkspace, applied);
    if (result.status === "restored") {
      try {
        writeCheckpoint(gitWorkspace.checkpointPath, checkpoints.slice(0, -1));
      } catch (error) {
        rollbackBatchRestore(applied);
        throw error;
      }
    }
    return result;
  }

  const checkpointOperations = selectedCheckpoints.flatMap((checkpoint) =>
    checkpointForwardOperations(checkpoint),
  );
  const coalesced = coalesceUndoCheckpointOperations(checkpointOperations);
  if (coalesced.status !== "ok") return coalesced;
  const applied: AppliedBatchRestoreOperation[] = [];
  const result = restoreCoalescedUndoCheckpointOperations(
    coalesced.operations,
    gitWorkspace,
    applied,
  );
  if (result.status === "restored") {
    try {
      writeCheckpoint(
        gitWorkspace.checkpointPath,
        checkpoints.slice(0, -checkpointIndex),
      );
    } catch (error) {
      rollbackBatchRestore(applied);
      throw error;
    }
    return {
      status: "restored",
      restoredLabel: selectedCheckpointsRestoredLabel(selectedCheckpoints),
    };
  }
  return result;
}
