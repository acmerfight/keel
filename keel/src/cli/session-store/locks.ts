import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
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

const legacySessionLockOwnerSchema = z
  .object({
    pid: z.number().int().positive(),
    token: z.string(),
    createdAt: z.string(),
  })
  .strict();

const identifiedSessionLockOwnerSchema = legacySessionLockOwnerSchema.extend({
  hostname: z.string().min(1),
  processStartTime: z.string().min(1),
});

const sessionLockOwnerSchema = z.union([
  identifiedSessionLockOwnerSchema,
  legacySessionLockOwnerSchema,
]);
const linuxProcProcessStartTimeSchema = z.string().regex(/^\d+$/);
const psProcessStartTimeOutputSchema = z.string().min(1);
const PROCESS_IDENTITY_ENV = {
  ...process.env,
  LC_ALL: "C",
  TZ: "UTC",
};

type SessionLockOwner = z.infer<typeof sessionLockOwnerSchema>;
type IdentifiedSessionLockOwner = z.infer<
  typeof identifiedSessionLockOwnerSchema
>;
type SessionLockOwnerRead =
  | {
      readonly status: "valid";
      readonly owner: SessionLockOwner;
    }
  | {
      readonly status: "missing";
    }
  | {
      readonly status: "malformed";
    }
  | {
      readonly status: "read_error";
      readonly message: string;
    };
type ProcessStartTimeRead =
  | {
      readonly status: "found";
      readonly processStartTime: string;
    }
  | {
      readonly status: "not_found";
    }
  | {
      readonly status: "unknown";
    };

// Gives an in-progress lock owner write time to finish before reclaiming a crash-left ownerless directory.
const OWNERLESS_LOCK_RECLAIM_AFTER_MS = 30_000;
let cachedCurrentProcessStartTime: string | undefined;

function readSessionLockOwner(lockPath: string): SessionLockOwnerRead {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(sessionLockOwnerPath(lockPath), "utf8"));
  } catch (error) {
    if (hasNodeErrorCode(error, "ENOENT")) {
      return { status: "missing" };
    }
    if (error instanceof SyntaxError) {
      return { status: "malformed" };
    }
    return { status: "read_error", message: errorMessage(error) };
  }
  const parsed = sessionLockOwnerSchema.safeParse(raw);
  return parsed.success
    ? { status: "valid", owner: parsed.data }
    : { status: "malformed" };
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !hasNodeErrorCode(error, "ESRCH");
  }
}

function parseLinuxProcStatStartTime(stat: string): string | null {
  const commEnd = stat.lastIndexOf(")");
  if (commEnd === -1) {
    return null;
  }

  const fieldsAfterComm = stat
    .slice(commEnd + 1)
    .trim()
    .split(/\s+/);
  const parsed = linuxProcProcessStartTimeSchema.safeParse(fieldsAfterComm[19]);
  return parsed.success ? parsed.data : null;
}

function readLinuxProcProcessStartTime(pid: number): ProcessStartTimeRead {
  try {
    const processStartTime = parseLinuxProcStatStartTime(
      readFileSync(`/proc/${pid}/stat`, "utf8"),
    );
    if (processStartTime !== null) {
      return { status: "found", processStartTime };
    }
  } catch {
    return processIsAlive(pid)
      ? { status: "unknown" }
      : { status: "not_found" };
  }

  return processIsAlive(pid) ? { status: "unknown" } : { status: "not_found" };
}

function readDarwinPsProcessStartTime(pid: number): ProcessStartTimeRead {
  let output: string;
  try {
    output = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
      env: PROCESS_IDENTITY_ENV,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return processIsAlive(pid)
      ? { status: "unknown" }
      : { status: "not_found" };
  }

  const parsed = psProcessStartTimeOutputSchema.safeParse(output.trim());
  if (parsed.success) {
    return { status: "found", processStartTime: parsed.data };
  }
  return processIsAlive(pid) ? { status: "unknown" } : { status: "not_found" };
}

function readProcessStartTime(pid: number): ProcessStartTimeRead {
  if (process.platform === "linux") {
    return readLinuxProcProcessStartTime(pid);
  }
  if (process.platform === "darwin") {
    return readDarwinPsProcessStartTime(pid);
  }
  return processIsAlive(pid) ? { status: "unknown" } : { status: "not_found" };
}

function currentProcessStartTime(): string | null {
  if (cachedCurrentProcessStartTime !== undefined) {
    return cachedCurrentProcessStartTime;
  }
  const processStartTime = readProcessStartTime(process.pid);
  if (processStartTime.status !== "found") {
    return null;
  }
  cachedCurrentProcessStartTime = processStartTime.processStartTime;
  return cachedCurrentProcessStartTime;
}

function hasProcessIdentity(
  owner: SessionLockOwner,
): owner is IdentifiedSessionLockOwner {
  return "hostname" in owner && "processStartTime" in owner;
}

function sessionLockOwnerIsActive(owner: SessionLockOwner): boolean {
  if (!hasProcessIdentity(owner)) {
    return processIsAlive(owner.pid);
  }
  if (owner.hostname !== hostname()) {
    return true;
  }

  const processStartTime = readProcessStartTime(owner.pid);
  if (processStartTime.status === "not_found") {
    return false;
  }
  if (processStartTime.status === "unknown") {
    return true;
  }
  return processStartTime.processStartTime === owner.processStartTime;
}

function ownerlessSessionLockIsStale(lockPath: string): boolean {
  try {
    const stats = statSync(lockPath);
    return Date.now() - stats.mtimeMs >= OWNERLESS_LOCK_RECLAIM_AFTER_MS;
  } catch (error) {
    sessionStoreError(
      `Error: cannot inspect session lock ${lockPath}: ${errorMessage(error)}`,
    );
  }
}

function removeStaleSessionLock(lockPath: string): boolean {
  const ownerRead = readSessionLockOwner(lockPath);
  if (
    ownerRead.status === "valid" &&
    sessionLockOwnerIsActive(ownerRead.owner)
  ) {
    return false;
  }
  if (ownerRead.status === "read_error") {
    sessionStoreError(
      `Error: cannot read session lock owner ${sessionLockOwnerPath(lockPath)}: ${ownerRead.message}`,
    );
  }
  if (
    (ownerRead.status === "missing" || ownerRead.status === "malformed") &&
    !ownerlessSessionLockIsStale(lockPath)
  ) {
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
  const ownerRead = readSessionLockOwner(lockPath);
  if (ownerRead.status !== "valid" || ownerRead.owner.token !== token) {
    return;
  }
  try {
    rmSync(lockPath, { recursive: true, force: true });
  } catch (error) {
    sessionStoreError(
      `Error: cannot release session lock ${lockPath}: ${errorMessage(error)}`,
    );
  }
  removeEmptySessionDirectory(lockPath);
}

function removeEmptySessionDirectory(lockPath: string): void {
  const sessionDirectory = dirname(lockPath);
  try {
    rmdirSync(sessionDirectory);
  } catch (error) {
    if (
      hasNodeErrorCode(error, "ENOENT") ||
      hasNodeErrorCode(error, "ENOTEMPTY") ||
      hasNodeErrorCode(error, "EEXIST")
    ) {
      return;
    }
    sessionStoreError(
      `Error: cannot remove empty session directory ${sessionDirectory}: ${errorMessage(error)}`,
    );
  }
}

export function acquireSessionLock(options: {
  readonly sessionId: string;
  readonly runtime: SessionStoreRuntime;
}): SessionLock {
  const lockPath = sessionLockPath(options.runtime, options.sessionId);
  const token = randomUUID();
  const ownerHostname = hostname();
  const ownerProcessStartTime = currentProcessStartTime();
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
        `${JSON.stringify(
          ownerProcessStartTime === null
            ? {
                pid: process.pid,
                token,
                createdAt: isoTimestamp(options.runtime),
              }
            : {
                pid: process.pid,
                token,
                createdAt: isoTimestamp(options.runtime),
                hostname: ownerHostname,
                processStartTime: ownerProcessStartTime,
              },
        )}\n`,
        { encoding: "utf8", flag: "wx", mode: 0o600 },
      );
    } catch (error) {
      rmSync(lockPath, { recursive: true, force: true });
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
