import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  acquireSessionLock,
  createSessionStore,
  ensureSessionCanBeCreated,
  persistSessionMessages,
  resumeSessionStore,
  SessionStoreError,
} from "../../../src/cli/session-store.ts";
import {
  headerLine,
  runtime,
} from "../../../src/testing/session-store-fixtures.ts";

describe("Session Store Locks And Validation", () => {
  test(`Given a session id already exists,
    When a user starts the same named session again,
    Then creation fails instead of overwriting the transcript`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));

    try {
      createSessionStore({
        sessionId: "existing",
        workspace,
        runtime: runtime(home),
      });

      // When / Then
      expect(() =>
        createSessionStore({
          sessionId: "existing",
          workspace,
          runtime: runtime(home, 1),
        }),
      ).toThrow(SessionStoreError);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a session ledger already exists,
    When a user checks whether the name can be created,
    Then the store reports that the session should be resumed instead`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));

    try {
      createSessionStore({
        sessionId: "existing-check",
        workspace,
        runtime: runtime(home),
      });

      // When / Then
      expect(() =>
        ensureSessionCanBeCreated({
          sessionId: "existing-check",
          runtime: runtime(home),
        }),
      ).toThrow(SessionStoreError);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a session lock is already held,
    When the same session lock is acquired again,
    Then it fails closed until the original lock is released`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const firstLock = acquireSessionLock({
      sessionId: "active",
      runtime: runtime(home),
    });

    try {
      // When / Then
      expect(() =>
        acquireSessionLock({
          sessionId: "active",
          runtime: runtime(home, 1),
        }),
      ).toThrow(SessionStoreError);
    } finally {
      firstLock.release();
    }

    try {
      // Then
      const secondLock = acquireSessionLock({
        sessionId: "active",
        runtime: runtime(home, 2),
      });
      secondLock.release();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a previous process left a stale session lock,
    When the same session lock is acquired again,
    Then the store recovers the stale lock and acquires a fresh one`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const lockPath = join(home, "sessions", "stale", "active.lock");
    await mkdir(lockPath, { recursive: true });
    await writeFile(
      join(lockPath, "owner.json"),
      `${JSON.stringify({
        pid: 999_999_999,
        token: "stale",
        createdAt: "1970-01-01T00:00:00.000Z",
      })}\n`,
      "utf8",
    );

    try {
      // When
      const lock = acquireSessionLock({
        sessionId: "stale",
        runtime: runtime(home, 1),
      });

      // Then
      expect(lock.lockPath).toBe(lockPath);
      expect(() =>
        acquireSessionLock({
          sessionId: "stale",
          runtime: runtime(home, 2),
        }),
      ).toThrow(SessionStoreError);
      lock.release();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a previous session lock PID was reused by another process,
    When the same session lock is acquired again,
    Then the store recovers the stale lock using the owner process identity`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const lockPath = join(home, "sessions", "reused-pid", "active.lock");
    await mkdir(lockPath, { recursive: true });
    await writeFile(
      join(lockPath, "owner.json"),
      `${JSON.stringify({
        pid: process.pid,
        token: "stale",
        createdAt: "1970-01-01T00:00:00.000Z",
        hostname: hostname(),
        processStartTime: "not-current-process-start-time",
      })}\n`,
      "utf8",
    );

    try {
      // When
      const lock = acquireSessionLock({
        sessionId: "reused-pid",
        runtime: runtime(home, 1),
      });

      // Then
      expect(lock.lockPath).toBe(lockPath);
      expect(() =>
        acquireSessionLock({
          sessionId: "reused-pid",
          runtime: runtime(home, 2),
        }),
      ).toThrow(SessionStoreError);
      lock.release();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given an identified session lock owner process has exited,
    When the same session lock is acquired again,
    Then the store recovers the stale lock`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const lockPath = join(home, "sessions", "identified-stale", "active.lock");
    await mkdir(lockPath, { recursive: true });
    await writeFile(
      join(lockPath, "owner.json"),
      `${JSON.stringify({
        pid: 999_999_999,
        token: "stale",
        createdAt: "1970-01-01T00:00:00.000Z",
        hostname: hostname(),
        processStartTime: "old-process-start-time",
      })}\n`,
      "utf8",
    );

    try {
      // When
      const lock = acquireSessionLock({
        sessionId: "identified-stale",
        runtime: runtime(home, 1),
      });

      // Then
      expect(lock.lockPath).toBe(lockPath);
      lock.release();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a session lock owner belongs to another host,
    When the same session lock is acquired again,
    Then the store fails closed instead of reclaiming it locally`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const lockPath = join(home, "sessions", "foreign-host", "active.lock");
    await mkdir(lockPath, { recursive: true });
    await writeFile(
      join(lockPath, "owner.json"),
      `${JSON.stringify({
        pid: process.pid,
        token: "foreign-host",
        createdAt: "1970-01-01T00:00:00.000Z",
        hostname: `other-${hostname()}`,
        processStartTime: "not-current-process-start-time",
      })}\n`,
      "utf8",
    );

    try {
      // When / Then
      expect(() =>
        acquireSessionLock({
          sessionId: "foreign-host",
          runtime: runtime(home, 1),
        }),
      ).toThrow(SessionStoreError);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given the session home blocks lock directory creation,
    When a user starts a named session,
    Then lock acquisition fails closed`, async () => {
    // Given
    const homeParent = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const home = join(homeParent, "not-a-directory");
    await writeFile(home, "file");

    try {
      // When / Then
      expect(() =>
        acquireSessionLock({
          sessionId: "lock-blocked",
          runtime: runtime(home),
        }),
      ).toThrow(SessionStoreError);
    } finally {
      await rm(homeParent, { recursive: true, force: true });
    }
  });

  test(`Given a stale session lock cannot be removed,
    When the same session lock is acquired again,
    Then lock acquisition fails closed`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const sessionPath = join(home, "sessions", "stale-blocked");
    const lockPath = join(sessionPath, "active.lock");
    await mkdir(lockPath, { recursive: true });
    await writeFile(
      join(lockPath, "owner.json"),
      `${JSON.stringify({
        pid: 999_999_999,
        token: "stale",
        createdAt: "1970-01-01T00:00:00.000Z",
      })}\n`,
      "utf8",
    );
    await chmod(sessionPath, 0o500);

    try {
      // When / Then
      expect(() =>
        acquireSessionLock({
          sessionId: "stale-blocked",
          runtime: runtime(home, 1),
        }),
      ).toThrow(SessionStoreError);
    } finally {
      await chmod(sessionPath, 0o700);
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a fresh session lock has no owner record,
    When the same session lock is acquired again,
    Then the store treats the lock as active during owner creation`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const lockPath = join(
      home,
      "sessions",
      "fresh-missing-owner",
      "active.lock",
    );
    await mkdir(lockPath, { recursive: true });

    try {
      // When / Then
      expect(() =>
        acquireSessionLock({
          sessionId: "fresh-missing-owner",
          runtime: runtime(home, 1),
        }),
      ).toThrow(SessionStoreError);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a stale session lock has no owner record,
    When the same session lock is acquired again,
    Then the store recovers the abandoned lock and acquires a fresh one`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const lockPath = join(home, "sessions", "missing-owner", "active.lock");
    await mkdir(lockPath, { recursive: true });
    const staleTime = new Date(0);
    await utimes(lockPath, staleTime, staleTime);

    try {
      // When
      const lock = acquireSessionLock({
        sessionId: "missing-owner",
        runtime: runtime(home, 1),
      });

      // Then
      expect(lock.lockPath).toBe(lockPath);
      expect(() =>
        acquireSessionLock({
          sessionId: "missing-owner",
          runtime: runtime(home, 2),
        }),
      ).toThrow(SessionStoreError);
      lock.release();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a stale session lock owner record cannot be read,
    When the same session lock is acquired again,
    Then lock acquisition fails closed instead of reclaiming it`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const lockPath = join(home, "sessions", "unreadable-owner", "active.lock");
    await mkdir(lockPath, { recursive: true });
    await mkdir(join(lockPath, "owner.json"));
    const staleTime = new Date(0);
    await utimes(lockPath, staleTime, staleTime);

    try {
      // When / Then
      expect(() =>
        acquireSessionLock({
          sessionId: "unreadable-owner",
          runtime: runtime(home, 1),
        }),
      ).toThrow(SessionStoreError);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a stale session lock has a malformed owner record,
    When the same session lock is acquired again,
    Then the store recovers the abandoned lock and acquires a fresh one`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const lockPath = join(home, "sessions", "bad-owner", "active.lock");
    await mkdir(lockPath, { recursive: true });
    await writeFile(join(lockPath, "owner.json"), "{not-json", "utf8");
    const staleTime = new Date(0);
    await utimes(lockPath, staleTime, staleTime);

    try {
      // When
      const lock = acquireSessionLock({
        sessionId: "bad-owner",
        runtime: runtime(home, 1),
      });

      // Then
      expect(lock.lockPath).toBe(lockPath);
      expect(() =>
        acquireSessionLock({
          sessionId: "bad-owner",
          runtime: runtime(home, 2),
        }),
      ).toThrow(SessionStoreError);
      lock.release();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a stale session lock has a structurally invalid owner record,
    When the same session lock is acquired again,
    Then the store recovers the abandoned lock and acquires a fresh one`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const lockPath = join(home, "sessions", "invalid-owner", "active.lock");
    await mkdir(lockPath, { recursive: true });
    await writeFile(
      join(lockPath, "owner.json"),
      `${JSON.stringify({
        pid: "not-a-number",
        token: "invalid",
        createdAt: "1970-01-01T00:00:00.000Z",
      })}\n`,
      "utf8",
    );
    const staleTime = new Date(0);
    await utimes(lockPath, staleTime, staleTime);

    try {
      // When
      const lock = acquireSessionLock({
        sessionId: "invalid-owner",
        runtime: runtime(home, 1),
      });

      // Then
      expect(lock.lockPath).toBe(lockPath);
      expect(() =>
        acquireSessionLock({
          sessionId: "invalid-owner",
          runtime: runtime(home, 2),
        }),
      ).toThrow(SessionStoreError);
      lock.release();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a session lock cannot be released,
    When the active lock is released,
    Then release fails closed`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const sessionPath = join(home, "sessions", "release-blocked");
    const lock = acquireSessionLock({
      sessionId: "release-blocked",
      runtime: runtime(home),
    });
    await chmod(sessionPath, 0o500);

    try {
      // When / Then
      expect(() => {
        lock.release();
      }).toThrow(SessionStoreError);
    } finally {
      await chmod(sessionPath, 0o700);
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a session lock owner no longer matches the lock token,
    When the active lock is released,
    Then the owner lock is left in place`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const lock = acquireSessionLock({
      sessionId: "token-mismatch",
      runtime: runtime(home),
    });
    const lockPath = join(home, "sessions", "token-mismatch", "active.lock");
    await writeFile(
      join(lockPath, "owner.json"),
      `${JSON.stringify({
        pid: process.pid,
        token: "different-token",
        createdAt: "1970-01-01T00:00:00.000Z",
      })}\n`,
      "utf8",
    );

    try {
      // When
      lock.release();

      // Then
      expect(() =>
        acquireSessionLock({
          sessionId: "token-mismatch",
          runtime: runtime(home, 1),
        }),
      ).toThrow(SessionStoreError);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given KEEL_HOME is not configured,
    When a user checks whether a fresh session name can be created,
    Then the default session home is accepted without creating a ledger`, () => {
    // Given
    const sessionId = `default-home-${randomUUID()}`;
    const defaultRuntime = {
      env: () => undefined,
      now: () => 0,
    };

    // When / Then
    expect(() =>
      ensureSessionCanBeCreated({
        sessionId,
        runtime: defaultRuntime,
      }),
    ).not.toThrow();
  });

  test(`Given a session id contains path traversal,
    When a user starts that session,
    Then the id is rejected before writing files`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));

    try {
      // When / Then
      expect(() =>
        createSessionStore({
          sessionId: "../escape",
          workspace,
          runtime: runtime(home),
        }),
      ).toThrow(SessionStoreError);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a session id contains a parent-directory marker,
    When a user starts that session,
    Then the id is rejected before resolving a ledger path`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));

    try {
      // When / Then
      expect(() =>
        createSessionStore({
          sessionId: "bad..id",
          workspace,
          runtime: runtime(home),
        }),
      ).toThrow(SessionStoreError);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a session ledger cannot be inspected,
    When a user starts that named session,
    Then the store fails closed before the turn starts`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    await mkdir(join(home, "sessions"), { recursive: true });
    await writeFile(join(home, "sessions", "blocked"), "not a directory");

    try {
      // When / Then
      expect(() =>
        ensureSessionCanBeCreated({
          sessionId: "blocked",
          runtime: runtime(home),
        }),
      ).toThrow(SessionStoreError);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a session does not exist,
    When a user resumes it,
    Then resume fails closed before returning messages`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));

    try {
      // When / Then
      expect(() =>
        resumeSessionStore({
          sessionId: "missing",
          workspace,
          runtime: runtime(home),
        }),
      ).toThrow(SessionStoreError);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given the session home blocks directory creation,
    When a user starts a named session,
    Then creating the ledger fails closed`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const homeParent = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const home = join(homeParent, "not-a-directory");
    await writeFile(home, "file");

    try {
      // When / Then
      expect(() =>
        createSessionStore({
          sessionId: "cannot-create",
          workspace,
          runtime: runtime(home),
        }),
      ).toThrow(SessionStoreError);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(homeParent, { recursive: true, force: true });
    }
  });

  test(`Given the session ledger is replaced by a directory after creation,
    When persistence appends another completed turn,
    Then writing fails closed with a session-store error`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));

    try {
      const session = createSessionStore({
        sessionId: "write-blocked",
        workspace,
        runtime: runtime(home),
      });
      await rm(session.filePath, { force: true });
      await mkdir(session.filePath);

      // When / Then
      expect(() =>
        persistSessionMessages({
          session,
          previousMessages: [],
          currentMessages: [{ role: "user", content: "hello" }],
          runtime: runtime(home, 1),
          reason: "turn",
        }),
      ).toThrow(SessionStoreError);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a session ledger path is not a readable file,
    When a user resumes it,
    Then resume fails closed with a session-load error`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    await mkdir(join(home, "sessions", "directory-ledger", "ledger.jsonl"), {
      recursive: true,
    });

    try {
      // When / Then
      expect(() =>
        resumeSessionStore({
          sessionId: "directory-ledger",
          workspace,
          runtime: runtime(home),
        }),
      ).toThrow(SessionStoreError);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a persisted session belongs to another workspace,
    When the user resumes it from the current workspace,
    Then resume fails closed with a workspace mismatch`, async () => {
    // Given
    const originalWorkspace = await mkdtemp(
      join(tmpdir(), "keel-session-workspace-"),
    );
    const currentWorkspace = await mkdtemp(
      join(tmpdir(), "keel-session-workspace-"),
    );
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    await mkdir(join(home, "sessions", "wrong-workspace"), {
      recursive: true,
    });
    await writeFile(
      join(home, "sessions", "wrong-workspace", "ledger.jsonl"),
      `${headerLine("wrong-workspace", originalWorkspace)}\n`,
      "utf8",
    );

    try {
      // When / Then
      expect(() =>
        resumeSessionStore({
          sessionId: "wrong-workspace",
          workspace: currentWorkspace,
          runtime: runtime(home),
        }),
      ).toThrow(SessionStoreError);
    } finally {
      await rm(originalWorkspace, { recursive: true, force: true });
      await rm(currentWorkspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a ledger header belongs to a different session id,
    When the user resumes the requested session,
    Then resume fails closed before replaying records`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    await mkdir(join(home, "sessions", "requested"), { recursive: true });
    await writeFile(
      join(home, "sessions", "requested", "ledger.jsonl"),
      `${headerLine("other", workspace)}\n`,
      "utf8",
    );

    try {
      // When / Then
      expect(() =>
        resumeSessionStore({
          sessionId: "requested",
          workspace,
          runtime: runtime(home),
        }),
      ).toThrow(SessionStoreError);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a ledger has no session header,
    When the user resumes it,
    Then resume fails closed before replaying append records`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    await mkdir(join(home, "sessions", "no-header"), { recursive: true });
    await writeFile(
      join(home, "sessions", "no-header", "ledger.jsonl"),
      `${JSON.stringify({
        schemaVersion: 4,
        type: "append",
        timestamp: "1970-01-01T00:00:00.000Z",
        reason: "turn",
        messages: [{ role: "user", content: "hello" }],
      })}\n`,
      "utf8",
    );

    try {
      // When / Then
      expect(() =>
        resumeSessionStore({
          sessionId: "no-header",
          workspace,
          runtime: runtime(home),
        }),
      ).toThrow(SessionStoreError);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a session ledger file is empty,
    When the user resumes it,
    Then resume fails closed before returning an empty transcript`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    await mkdir(join(home, "sessions", "empty-ledger"), { recursive: true });
    await writeFile(
      join(home, "sessions", "empty-ledger", "ledger.jsonl"),
      "",
      "utf8",
    );

    try {
      // When / Then
      expect(() =>
        resumeSessionStore({
          sessionId: "empty-ledger",
          workspace,
          runtime: runtime(home),
        }),
      ).toThrow(SessionStoreError);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a ledger repeats the session header,
    When the user resumes it,
    Then resume fails closed before returning duplicate history`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    await mkdir(join(home, "sessions", "duplicate-header"), {
      recursive: true,
    });
    await writeFile(
      join(home, "sessions", "duplicate-header", "ledger.jsonl"),
      [
        headerLine("duplicate-header", workspace),
        headerLine("duplicate-header", workspace),
      ].join("\n"),
      "utf8",
    );

    try {
      // When / Then
      expect(() =>
        resumeSessionStore({
          sessionId: "duplicate-header",
          workspace,
          runtime: runtime(home),
        }),
      ).toThrow(SessionStoreError);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a persisted session contains malformed JSONL,
    When the session is resumed,
    Then it fails closed with a session-load error`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const malformedLines = [headerLine("broken", workspace), "{not-json"];
    const malformedLedger = malformedLines.join("\n");
    await mkdir(join(home, "sessions", "broken"), { recursive: true });
    await writeFile(
      join(home, "sessions", "broken", "ledger.jsonl"),
      malformedLedger,
      "utf8",
    );

    try {
      // When / Then
      expect(() =>
        resumeSessionStore({
          sessionId: "broken",
          workspace,
          runtime: runtime(home),
        }),
      ).toThrow(SessionStoreError);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given the session ledger path cannot be inspected,
    When the session is resumed,
    Then the store fails closed before reading ledger bytes`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    await mkdir(join(home, "sessions"), { recursive: true });
    await writeFile(join(home, "sessions", "blocked"), "not a directory");

    try {
      // When
      let resumeError: unknown;
      try {
        resumeSessionStore({
          sessionId: "blocked",
          workspace,
          runtime: runtime(home),
        });
      } catch (error) {
        resumeError = error;
      }

      // Then
      expect(resumeError).toBeInstanceOf(SessionStoreError);
      if (!(resumeError instanceof Error)) {
        throw new Error("Expected resume to throw an Error");
      }
      expect(resumeError.message).toContain(
        'Error: cannot resume session "blocked": cannot inspect session ledger',
      );
      expect(resumeError.message).not.toContain("cannot read session ledger");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given the session ledger path is a directory,
    When the session is resumed,
    Then the store reports that the ledger cannot be read`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    await mkdir(join(home, "sessions", "directory-ledger", "ledger.jsonl"), {
      recursive: true,
    });

    try {
      // When
      let resumeError: unknown;
      try {
        resumeSessionStore({
          sessionId: "directory-ledger",
          workspace,
          runtime: runtime(home),
        });
      } catch (error) {
        resumeError = error;
      }

      // Then
      expect(resumeError).toBeInstanceOf(SessionStoreError);
      if (!(resumeError instanceof Error)) {
        throw new Error("Expected resume to throw an Error");
      }
      expect(resumeError.message).toContain(
        'Error: cannot resume session "directory-ledger": cannot read session ledger',
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });
});
