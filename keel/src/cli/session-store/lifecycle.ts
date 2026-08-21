import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  realpathSync,
  renameSync,
  statSync,
} from "node:fs";
import { errorMessage } from "../../core/error.ts";
import { readSessionHeaderAtLocation } from "./catalog.ts";
import {
  formatNestedSessionStoreError,
  hasNodeErrorCode,
  SessionStoreError,
  sessionStoreError,
} from "./errors.ts";
import { acquireSessionLock } from "./locks.ts";
import type { SessionHeaderRecord, SessionStoreRuntime } from "./model.ts";
import {
  type SessionStorageLocation,
  sessionDirectoryPath,
  sessionHome,
  sessionRootPath,
} from "./paths.ts";

type SessionLifecycleOperation = "archive" | "unarchive";

function fsyncDirectoryBestEffort(path: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    fsyncSync(fd);
  } catch {
    // Some supported filesystems do not allow opening or syncing directories.
  } finally {
    /* v8 ignore next 3 -- the descriptor exists only after a successful open; directory-open failure requires OS fault injection. */
    if (fd !== undefined) {
      closeSync(fd);
    }
  }
}

function ensureDestinationDoesNotExist(options: {
  readonly sessionId: string;
  readonly destinationDirectory: string;
  readonly destination: SessionStorageLocation;
}): void {
  try {
    statSync(options.destinationDirectory);
  } catch (error) {
    if (hasNodeErrorCode(error, "ENOENT")) {
      return;
    }
    sessionStoreError(
      `Error: cannot inspect ${options.destination} session ${options.destinationDirectory}: ${errorMessage(error)}`,
    );
  }
  sessionStoreError(
    `Error: session "${options.sessionId}" already exists in ${options.destination} sessions. No files were changed.`,
  );
}

function validateSourceSession(options: {
  readonly operation: SessionLifecycleOperation;
  readonly source: SessionStorageLocation;
  readonly sessionId: string;
  readonly workspace: string;
  readonly runtime: SessionStoreRuntime;
}): void {
  let header: SessionHeaderRecord;
  try {
    header = readSessionHeaderAtLocation({
      sessionId: options.sessionId,
      runtime: options.runtime,
      location: options.source,
    });
  } catch (error) {
    /* v8 ignore else -- supported catalog faults are normalized to SessionStoreError; preserve unexpected fault identity for the outer CLI boundary. */
    if (error instanceof SessionStoreError) {
      sessionStoreError(
        `Error: cannot ${options.operation} session "${options.sessionId}": ${formatNestedSessionStoreError(error)}`,
      );
    }
    /* v8 ignore next -- unexpected faults are handled by the outer CLI runtime boundary. */
    throw error;
  }
  const workspace = realpathSync(options.workspace);
  if (header.workspace !== workspace) {
    sessionStoreError(
      `Error: cannot ${options.operation} session "${options.sessionId}": session workspace is ${header.workspace}, not ${workspace}.`,
    );
  }
}

function moveSessionDirectory(options: {
  readonly operation: SessionLifecycleOperation;
  readonly source: SessionStorageLocation;
  readonly destination: SessionStorageLocation;
  readonly sessionId: string;
  readonly workspace: string;
  readonly runtime: SessionStoreRuntime;
}): void {
  const lock = acquireSessionLock({
    sessionId: options.sessionId,
    runtime: options.runtime,
  });
  try {
    const sourceDirectory = sessionDirectoryPath(
      options.runtime,
      options.sessionId,
      options.source,
    );
    const destinationDirectory = sessionDirectoryPath(
      options.runtime,
      options.sessionId,
      options.destination,
    );
    ensureDestinationDoesNotExist({
      sessionId: options.sessionId,
      destinationDirectory,
      destination: options.destination,
    });
    validateSourceSession(options);
    const sourceRoot = sessionRootPath(options.runtime, options.source);
    const destinationRoot = sessionRootPath(
      options.runtime,
      options.destination,
    );
    try {
      mkdirSync(destinationRoot, { recursive: true, mode: 0o700 });
      renameSync(sourceDirectory, destinationDirectory);
    } catch (error) {
      sessionStoreError(
        `Error: cannot ${options.operation} session "${options.sessionId}": ${errorMessage(error)}`,
      );
    }
    fsyncDirectoryBestEffort(sourceRoot);
    fsyncDirectoryBestEffort(destinationRoot);
    fsyncDirectoryBestEffort(sessionHome(options.runtime));
  } finally {
    lock.release();
  }
}

export function archiveSessionStore(options: {
  readonly sessionId: string;
  readonly workspace: string;
  readonly runtime: SessionStoreRuntime;
}): void {
  moveSessionDirectory({
    ...options,
    operation: "archive",
    source: "active",
    destination: "archived",
  });
}

export function unarchiveSessionStore(options: {
  readonly sessionId: string;
  readonly workspace: string;
  readonly runtime: SessionStoreRuntime;
}): void {
  moveSessionDirectory({
    ...options,
    operation: "unarchive",
    source: "archived",
    destination: "active",
  });
}
