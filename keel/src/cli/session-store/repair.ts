import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  fsyncSync,
  openSync,
  renameSync,
  rmSync,
  truncateSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { errorMessage } from "../../core/error.ts";
import { sessionStoreError } from "./errors.ts";
import { inspectSessionLedgerTail } from "./ledger.ts";
import type { SessionState, SessionStoreRuntime } from "./model.ts";
import { sessionFilePath } from "./paths.ts";
import { resumeSessionStore, validateSessionLedgerPrefix } from "./store.ts";

export type SessionRepairResult =
  | {
      readonly status: "unchanged";
      readonly session: SessionState;
    }
  | {
      readonly status: "repaired";
      readonly session: SessionState;
      readonly droppedBytes: number;
      readonly backupPath: string;
    };

function fsyncPath(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function fsyncDirectoryBestEffort(path: string): void {
  try {
    fsyncPath(path);
  } catch {
    // Some supported filesystems do not allow opening or syncing directories.
  }
}

function repairTimestamp(runtime: SessionStoreRuntime): string {
  return new Date(runtime.now())
    .toISOString()
    .replaceAll(":", "-")
    .replace(".", "-");
}

function preserveAndReplaceLedger(options: {
  readonly filePath: string;
  readonly retainedBytes: number;
  readonly runtime: SessionStoreRuntime;
}): string {
  const directory = dirname(options.filePath);
  const timestamp = repairTimestamp(options.runtime);
  const backupPath = join(directory, `ledger.backup-${timestamp}.jsonl`);
  const replacementPath = join(directory, `ledger.repair-${timestamp}.tmp`);
  let replacementCreated = false;
  try {
    copyFileSync(options.filePath, replacementPath, constants.COPYFILE_EXCL);
    replacementCreated = true;
    chmodSync(replacementPath, 0o600);
    truncateSync(replacementPath, options.retainedBytes);
    fsyncPath(replacementPath);

    copyFileSync(options.filePath, backupPath, constants.COPYFILE_EXCL);
    chmodSync(backupPath, 0o600);
    fsyncPath(backupPath);
    fsyncDirectoryBestEffort(directory);

    renameSync(replacementPath, options.filePath);
    fsyncDirectoryBestEffort(directory);
    return backupPath;
  } catch (error) {
    if (replacementCreated) {
      rmSync(replacementPath, { force: true });
    }
    sessionStoreError(
      `Error: cannot repair session ledger ${options.filePath}: ${errorMessage(error)}`,
    );
  }
}

export function repairSessionStore(options: {
  readonly sessionId: string;
  readonly workspace: string;
  readonly runtime: SessionStoreRuntime;
  readonly strategy: "truncate-incomplete-tail";
}): SessionRepairResult {
  const filePath = sessionFilePath(options.runtime, options.sessionId);
  const tail = inspectSessionLedgerTail(filePath);
  if (tail.kind === "complete" || tail.kind === "valid_unterminated_record") {
    return {
      status: "unchanged",
      session: resumeSessionStore({
        sessionId: options.sessionId,
        workspace: options.workspace,
        runtime: options.runtime,
      }),
    };
  }

  const session = validateSessionLedgerPrefix({
    sessionId: options.sessionId,
    workspace: options.workspace,
    runtime: options.runtime,
    retainedBytes: tail.retainedBytes,
  });
  const backupPath = preserveAndReplaceLedger({
    filePath,
    retainedBytes: tail.retainedBytes,
    runtime: options.runtime,
  });
  return {
    status: "repaired",
    session,
    droppedBytes: tail.droppedBytes,
    backupPath,
  };
}
