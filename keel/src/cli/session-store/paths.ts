import { homedir } from "node:os";
import { join } from "node:path";
import { sessionStoreError } from "./errors.ts";
import {
  SESSION_ID_PATTERN,
  SESSION_LOCK_OWNER_FILE_NAME,
  SESSION_LOCKS_DIRECTORY_NAME,
  type SessionStoreRuntime,
} from "./model.ts";

export function sessionHome(runtime: Pick<SessionStoreRuntime, "env">): string {
  return runtime.env("KEEL_HOME") ?? join(homedir(), ".keel");
}

function validateSessionId(sessionId: string): void {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    sessionStoreError(
      `Error: invalid session id "${sessionId}". Use letters, numbers, dots, dashes, or underscores.`,
    );
  }
  if (sessionId === "." || sessionId === ".." || sessionId.includes("..")) {
    sessionStoreError(
      `Error: invalid session id "${sessionId}". Use a simple session name without path traversal.`,
    );
  }
}

export type SessionStorageLocation = "active" | "archived";

export function sessionRootPath(
  runtime: Pick<SessionStoreRuntime, "env">,
  location: SessionStorageLocation,
): string {
  return join(
    sessionHome(runtime),
    location === "active" ? "sessions" : "archived-sessions",
  );
}

export function sessionDirectoryPath(
  runtime: SessionStoreRuntime,
  sessionId: string,
  location: SessionStorageLocation,
): string {
  validateSessionId(sessionId);
  return join(sessionRootPath(runtime, location), sessionId);
}

export function sessionFilePathAtLocation(
  runtime: SessionStoreRuntime,
  sessionId: string,
  location: SessionStorageLocation,
): string {
  return join(
    sessionDirectoryPath(runtime, sessionId, location),
    "ledger.jsonl",
  );
}

export function sessionFilePath(
  runtime: SessionStoreRuntime,
  sessionId: string,
): string {
  return sessionFilePathAtLocation(runtime, sessionId, "active");
}

export function sessionLockPath(
  runtime: SessionStoreRuntime,
  sessionId: string,
): string {
  validateSessionId(sessionId);
  return join(sessionHome(runtime), SESSION_LOCKS_DIRECTORY_NAME, sessionId);
}

export function sessionLockOwnerPath(lockPath: string): string {
  return join(lockPath, SESSION_LOCK_OWNER_FILE_NAME);
}
