import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  linkSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { debugLog } from "../core/logger.ts";
import {
  type FileIdentity,
  fileIdentityFromStats,
  sameFileIdentity,
} from "./workspace-path.ts";

export interface AtomicWriteTextFileOptions {
  readonly mode: number;
  readonly rollbackMode?: number;
  readonly beforeAccess?: () => void;
  readonly beforeWrite?: (tempPath: string, fd: number) => void;
  readonly beforePublish?: () => void;
  readonly afterPublish?: (targetPath: string, identity: FileIdentity) => void;
  readonly validateReplacement?: (targetPath: string, fd: number) => void;
  readonly rollbackOnPublishFailure: AtomicReplacementRollback;
  readonly cleanupPathsByIdentity?: (
    identity: FileIdentity,
  ) => readonly string[];
}

export interface AtomicCreateTextFileOptions {
  readonly mode?: number;
  readonly beforeAccess?: () => void;
  readonly beforeWrite?: (tempPath: string, fd: number) => void;
  readonly beforePublish?: () => void;
  readonly afterPublish?: (targetPath: string, identity: FileIdentity) => void;
  readonly cleanupPathsByIdentity?: (
    identity: FileIdentity,
  ) => readonly string[];
}

export interface AtomicReplacementRollback {
  readonly beforeContent: string;
  readonly afterContent: string;
}

export interface AtomicWriteResult {
  readonly identity: FileIdentity;
}

function syncDirectoryBestEffort(path: string): void {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    fsyncSync(fd);
  } catch {
    // Directory fsync is a durability improvement, but not portable enough to
    // turn an otherwise successful rename into a user-visible edit failure.
  } finally {
    /* v8 ignore next 3: directory fsync may be unsupported before fd assignment. */
    if (fd !== null) {
      closeSync(fd);
    }
  }
}

function assertWritableTargetAtReplacementTime(
  targetPath: string,
  validateReplacement?: (targetPath: string, fd: number) => void,
): void {
  const fd = openSync(targetPath, constants.O_RDWR | constants.O_NONBLOCK);
  try {
    validateReplacement?.(targetPath, fd);
  } finally {
    closeSync(fd);
  }
}

function assertOpenedFileMatchesPath(fd: number, path: string): void {
  const openedStat = fstatSync(fd);
  const pathStat = statSync(path);
  if (
    !sameFileIdentity(
      fileIdentityFromStats(openedStat),
      fileIdentityFromStats(pathStat),
    )
  ) {
    /* v8 ignore next 1: this protects against a temp-file identity race after open. */
    throw new Error(`opened temp file no longer matches path: ${path}`);
  }
}

function cleanupTempBestEffort(
  cleanupPath: string,
  identity: FileIdentity | null,
  cleanupPathsByIdentity?: (identity: FileIdentity) => readonly string[],
): void {
  rmSync(cleanupPath, { force: true });
  if (identity === null || cleanupPathsByIdentity === undefined) return;
  for (const path of cleanupPathsByIdentity(identity)) {
    rmSync(path, { force: true });
  }
}

function removePathByIdentityBestEffort(
  targetPath: string,
  identity: FileIdentity,
): void {
  try {
    if (
      sameFileIdentity(fileIdentityFromStats(statSync(targetPath)), identity)
    ) {
      rmSync(targetPath, { force: true });
    }
  } catch {
    // Best-effort rollback only removes the exact file Keel just published.
  }
}

export function restoreTextFileByIdentityBestEffort(
  targetPath: string,
  identity: FileIdentity,
  rollback: AtomicReplacementRollback,
  mode: number,
): void {
  let fd: number | null = null;
  try {
    fd = openSync(
      targetPath,
      constants.O_RDWR | constants.O_NONBLOCK | constants.O_NOFOLLOW,
    );
    if (
      !sameFileIdentity(fileIdentityFromStats(fstatSync(fd)), identity) ||
      readFileSync(fd, "utf8") !== rollback.afterContent
    ) {
      return;
    }
    ftruncateSync(fd, 0);
    const rollbackContent = Buffer.from(rollback.beforeContent);
    let writeOffset = 0;
    while (writeOffset < rollbackContent.length) {
      const bytesWritten = writeSync(
        fd,
        rollbackContent,
        writeOffset,
        rollbackContent.length - writeOffset,
        writeOffset,
      );
      /* v8 ignore next 3: a blocking regular-file write returning zero requires an OS fault; this guard prevents an infinite loop. */
      if (bytesWritten === 0) {
        throw new Error("atomic rollback write made no progress");
      }
      writeOffset += bytesWritten;
    }
    fchmodSync(fd, mode);
    fsyncSync(fd);
  } catch {
    // Best-effort rollback must not hide the original boundary failure.
  } finally {
    /* v8 ignore next 3: restore can fail before fd assignment when a concurrent process removes or replaces the target. */
    if (fd !== null) {
      closeSync(fd);
    }
  }
}

export function writeTextFileAtomically(
  targetPath: string,
  content: string,
  options: AtomicWriteTextFileOptions,
): AtomicWriteResult {
  const parentPath = dirname(targetPath);
  const tempPath = join(
    parentPath,
    `.keel-edit-${process.pid}-${Date.now()}-${crypto.randomUUID()}.tmp`,
  );

  let fd: number | null = null;
  let cleanupPath = tempPath;
  let identity: FileIdentity | null = null;
  let published = false;
  try {
    options.beforeAccess?.();
    fd = openSync(tempPath, "wx", options.mode);
    identity = fileIdentityFromStats(fstatSync(fd));
    const openedTempPath = realpathSync(tempPath);
    assertOpenedFileMatchesPath(fd, openedTempPath);
    cleanupPath = openedTempPath;
    options.beforeWrite?.(openedTempPath, fd);
    fchmodSync(fd, options.mode);
    writeFileSync(fd, content, "utf8");
    // Some filesystems clear special mode bits during writes; restore the
    // original mode immediately before syncing the replacement file.
    fchmodSync(fd, options.mode);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    assertWritableTargetAtReplacementTime(
      targetPath,
      options.validateReplacement,
    );
    options.beforePublish?.();
    renameSync(tempPath, targetPath);
    published = true;
    /* v8 ignore next 3: identity is assigned immediately after successful temp open. */
    if (identity === null) {
      throw new Error("atomic write identity invariant violated");
    }
    try {
      options.afterPublish?.(targetPath, identity);
    } catch (error) {
      restoreTextFileByIdentityBestEffort(
        targetPath,
        identity,
        options.rollbackOnPublishFailure,
        options.rollbackMode ?? options.mode,
      );
      throw error;
    }
    syncDirectoryBestEffort(parentPath);
    return { identity };
  } catch (error) {
    /* v8 ignore next 3: write/fsync failures after opening the temp file require OS faults; open-failure cleanup is covered through edit. */
    if (fd !== null) {
      closeSync(fd);
    }
    if (!published) {
      cleanupTempBestEffort(
        cleanupPath,
        identity,
        options.cleanupPathsByIdentity,
      );
    }
    throw error;
  }
}

export function createTextFileAtomically(
  targetPath: string,
  content: string,
  options: AtomicCreateTextFileOptions = {},
): AtomicWriteResult {
  const parentPath = dirname(targetPath);
  const tempPath = join(
    parentPath,
    `.keel-write-${process.pid}-${Date.now()}-${crypto.randomUUID()}.tmp`,
  );

  let fd: number | null = null;
  let cleanupPath = tempPath;
  let identity: FileIdentity | null = null;
  let published = false;
  const mode = options.mode;
  try {
    options.beforeAccess?.();
    fd = openSync(tempPath, "wx", mode ?? 0o666);
    identity = fileIdentityFromStats(fstatSync(fd));
    const openedTempPath = realpathSync(tempPath);
    assertOpenedFileMatchesPath(fd, openedTempPath);
    cleanupPath = openedTempPath;
    options.beforeWrite?.(openedTempPath, fd);
    if (mode !== undefined) {
      fchmodSync(fd, mode);
    }
    writeFileSync(fd, content, "utf8");
    if (mode !== undefined) {
      fchmodSync(fd, mode);
    }
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    // Hard-link publish preserves no-clobber create semantics; rename would
    // atomically replace an existing target.
    options.beforePublish?.();
    linkSync(tempPath, targetPath);
    published = true;
    /* v8 ignore next 3: identity is assigned immediately after successful temp open. */
    if (identity === null) {
      throw new Error("atomic create identity invariant violated");
    }
    options.afterPublish?.(targetPath, identity);
  } catch (error) {
    if (fd !== null) {
      closeSync(fd);
    }
    if (published && identity !== null) {
      removePathByIdentityBestEffort(targetPath, identity);
    }
    cleanupTempBestEffort(
      cleanupPath,
      identity,
      options.cleanupPathsByIdentity,
    );
    throw error;
  }

  try {
    rmSync(cleanupPath, { force: true });
  } catch (error) {
    debugLog(
      `write temp cleanup failed: targetPath=${targetPath} tempPath=${tempPath} error=${String(error)}`,
    );
  }
  syncDirectoryBestEffort(parentPath);
  /* v8 ignore next 3: identity is assigned immediately after successful temp open. */
  if (identity === null) {
    throw new Error("atomic create identity invariant violated");
  }
  return { identity };
}
