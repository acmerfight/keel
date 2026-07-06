import { homedir } from "node:os";
import { join } from "node:path";
import { sessionStoreError } from "./errors.ts";
import {
  SESSION_ID_PATTERN,
  SESSION_LOCK_DIRECTORY_NAME,
  SESSION_LOCK_OWNER_FILE_NAME,
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

function sessionDirectoryPath(
  runtime: SessionStoreRuntime,
  sessionId: string,
): string {
  validateSessionId(sessionId);
  return join(sessionHome(runtime), "sessions", sessionId);
}

export function sessionFilePath(
  runtime: SessionStoreRuntime,
  sessionId: string,
): string {
  return join(sessionDirectoryPath(runtime, sessionId), "ledger.jsonl");
}

export function sessionLockPath(
  runtime: SessionStoreRuntime,
  sessionId: string,
): string {
  return join(
    sessionDirectoryPath(runtime, sessionId),
    SESSION_LOCK_DIRECTORY_NAME,
  );
}

export function sessionLockOwnerPath(lockPath: string): string {
  return join(lockPath, SESSION_LOCK_OWNER_FILE_NAME);
}
