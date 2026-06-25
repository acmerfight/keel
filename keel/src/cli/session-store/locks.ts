import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { errorMessage } from "../../core/error.ts";
import { hasNodeErrorCode, sessionStoreError } from "./errors.ts";
import type { SessionLock, SessionStoreRuntime } from "./model.ts";
import {
  sessionFilePath,
  sessionLockOwnerPath,
  sessionLockPath,
} from "./paths.ts";
import { isoTimestamp } from "./runtime.ts";

const sessionLockOwnerSchema = z
  .object({
    pid: z.number().int().positive(),
    token: z.string(),
    createdAt: z.string(),
  })
  .strict();

type SessionLockOwner = z.infer<typeof sessionLockOwnerSchema>;

function readSessionLockOwner(lockPath: string): SessionLockOwner | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(sessionLockOwnerPath(lockPath), "utf8"));
  } catch {
    return null;
  }
  const parsed = sessionLockOwnerSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !hasNodeErrorCode(error, "ESRCH");
  }
}

function removeStaleSessionLock(lockPath: string): boolean {
  const owner = readSessionLockOwner(lockPath);
  if (owner === null || processIsAlive(owner.pid)) {
    return false;
  }
  try {
    rmSync(lockPath, { recursive: true, force: true });
    return true;
  } catch (error) {
    sessionStoreError(
      `Error: cannot remove stale session lock ${lockPath}: ${errorMessage(error)}`,
    );
  }
}

function releaseSessionLock(lockPath: string, token: string): void {
  const owner = readSessionLockOwner(lockPath);
  if (owner === null || owner.token !== token) {
    return;
  }
  try {
    rmSync(lockPath, { recursive: true, force: true });
  } catch (error) {
    sessionStoreError(
      `Error: cannot release session lock ${lockPath}: ${errorMessage(error)}`,
    );
  }
}

export function acquireSessionLock(options: {
  readonly sessionId: string;
  readonly runtime: SessionStoreRuntime;
}): SessionLock {
  const lockPath = sessionLockPath(options.runtime, options.sessionId);
  const token = randomUUID();
  for (;;) {
    try {
      mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
      mkdirSync(lockPath, { mode: 0o700 });
    } catch (error) {
      if (hasNodeErrorCode(error, "EEXIST")) {
        if (removeStaleSessionLock(lockPath)) {
          continue;
        }
        sessionStoreError(
          `Error: session "${options.sessionId}" is already active. Stop the other Keel process before using it again.`,
        );
      }
      sessionStoreError(
        `Error: cannot acquire session lock ${lockPath}: ${errorMessage(error)}`,
      );
    }

    try {
      writeFileSync(
        sessionLockOwnerPath(lockPath),
        `${JSON.stringify({
          pid: process.pid,
          token,
          createdAt: isoTimestamp(options.runtime),
        })}\n`,
        { encoding: "utf8", flag: "wx", mode: 0o600 },
      );
    } catch (error) {
      /* v8 ignore next 3: requires a filesystem race after the lock directory is created; mkdir and release failures are covered with real filesystem cases. */
      rmSync(lockPath, { recursive: true, force: true });
      /* v8 ignore next 3: same post-mkdir owner-write race as above. */
      sessionStoreError(
        `Error: cannot write session lock ${lockPath}: ${errorMessage(error)}`,
      );
    }

    return {
      lockPath,
      release: () => {
        releaseSessionLock(lockPath, token);
      },
    };
  }
}

export function ensureSessionCanBeCreated(options: {
  readonly sessionId: string;
  readonly runtime: SessionStoreRuntime;
}): void {
  const filePath = sessionFilePath(options.runtime, options.sessionId);
  try {
    statSync(filePath);
  } catch (error) {
    if (hasNodeErrorCode(error, "ENOENT")) {
      return;
    }
    sessionStoreError(
      `Error: cannot inspect session ledger ${filePath}: ${errorMessage(error)}`,
    );
  }
  sessionStoreError(
    `Error: session "${options.sessionId}" already exists. Use --resume ${options.sessionId} to continue it.`,
  );
}
