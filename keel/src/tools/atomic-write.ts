import {
  closeSync,
  fchmodSync,
  fsyncSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export interface AtomicWriteTextFileOptions {
  readonly mode: number;
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

function assertWritableTargetAtReplacementTime(targetPath: string): void {
  const fd = openSync(targetPath, "r+");
  closeSync(fd);
}

export function writeTextFileAtomically(
  targetPath: string,
  content: string,
  options: AtomicWriteTextFileOptions,
): void {
  const parentPath = dirname(targetPath);
  const tempPath = join(
    parentPath,
    `.keel-edit-${process.pid}-${Date.now()}-${crypto.randomUUID()}.tmp`,
  );

  let fd: number | null = null;
  try {
    fd = openSync(tempPath, "wx", options.mode);
    fchmodSync(fd, options.mode);
    writeFileSync(fd, content, "utf8");
    // Some filesystems clear special mode bits during writes; restore the
    // original mode immediately before syncing the replacement file.
    fchmodSync(fd, options.mode);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    assertWritableTargetAtReplacementTime(targetPath);
    renameSync(tempPath, targetPath);
    syncDirectoryBestEffort(parentPath);
  } catch (error) {
    /* v8 ignore next 3: write/fsync failures after opening the temp file require OS faults; open-failure cleanup is covered through edit. */
    if (fd !== null) {
      closeSync(fd);
    }
    rmSync(tempPath, { force: true });
    throw error;
  }
}
