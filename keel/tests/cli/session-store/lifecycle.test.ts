import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  archiveSessionStore,
  createSessionStore,
  ensureSessionCanBeCreated,
  SessionStoreError,
  unarchiveSessionStore,
} from "../../../src/cli/session-store.ts";
import { runtime } from "../../../src/testing/session-store-fixtures.ts";

describe("Session Store Lifecycle", () => {
  test(`Given the archived sessions root is a symbolic link,
    When the user archives a saved session,
    Then the lifecycle owner rejects the root without moving state outside KEEL_HOME`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const outside = await mkdtemp(join(tmpdir(), "keel-session-outside-"));
    const sessionId = "linked-archive-root";
    const session = createSessionStore({
      sessionId,
      workspace,
      runtime: runtime(home),
    });
    const ledger = await readFile(session.filePath);
    await symlink(outside, join(home, "archived-sessions"), "dir");

    try {
      // When / Then
      expect(() =>
        archiveSessionStore({
          sessionId,
          workspace,
          runtime: runtime(home, 1),
        }),
      ).toThrow(SessionStoreError);
      expect(await readFile(session.filePath)).toEqual(ledger);
      await expect(
        readFile(join(outside, sessionId, "ledger.jsonl")),
      ).rejects.toThrow();
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test(`Given the requested active session does not exist,
    When the user archives that identity,
    Then the lifecycle owner reports the missing source and releases its lock`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));

    try {
      // When / Then
      expect(() =>
        archiveSessionStore({
          sessionId: "missing",
          workspace,
          runtime: runtime(home),
        }),
      ).toThrow(
        `Error: cannot archive session "missing": session ledger not found at ${join(home, "sessions", "missing", "ledger.jsonl")}.`,
      );
      await expect(
        readFile(join(home, "session-locks", "missing", "owner.json")),
      ).rejects.toThrow();
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given active and archived storage already contain the same session id,
    When the active session is archived,
    Then the lifecycle owner rejects the collision without overwriting either side`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const sessionId = "collision";
    const active = createSessionStore({
      sessionId,
      workspace,
      runtime: runtime(home),
    });
    const archivedDirectory = join(home, "archived-sessions", sessionId);
    const archivedMarker = join(archivedDirectory, "marker.txt");
    await mkdir(archivedDirectory, { recursive: true });
    await writeFile(archivedMarker, "do not overwrite\n", "utf8");
    const activeLedger = await readFile(active.filePath);

    try {
      // When / Then
      expect(() =>
        archiveSessionStore({
          sessionId,
          workspace,
          runtime: runtime(home, 1),
        }),
      ).toThrow(SessionStoreError);
      expect(await readFile(active.filePath)).toEqual(activeLedger);
      expect(await readFile(archivedMarker, "utf8")).toBe("do not overwrite\n");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a session id belongs to an archived session,
    When a new saved session requests that id,
    Then creation fails until the original session is unarchived`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const sessionId = "reserved-identity";
    createSessionStore({
      sessionId,
      workspace,
      runtime: runtime(home),
    });
    archiveSessionStore({
      sessionId,
      workspace,
      runtime: runtime(home, 1),
    });

    try {
      // When / Then
      expect(() =>
        ensureSessionCanBeCreated({
          sessionId,
          runtime: runtime(home, 2),
        }),
      ).toThrow(
        `Error: session "${sessionId}" is archived. Run keel sessions unarchive ${sessionId} or choose another session id.`,
      );

      unarchiveSessionStore({
        sessionId,
        workspace,
        runtime: runtime(home, 3),
      });
      expect(() =>
        ensureSessionCanBeCreated({
          sessionId,
          runtime: runtime(home, 4),
        }),
      ).toThrow(SessionStoreError);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a saved session belongs to another workspace,
    When the current workspace tries to archive it,
    Then the lifecycle owner rejects the move and preserves the active session`, async () => {
    // Given
    const sessionWorkspace = await mkdtemp(
      join(tmpdir(), "keel-session-workspace-"),
    );
    const currentWorkspace = await mkdtemp(
      join(tmpdir(), "keel-session-workspace-"),
    );
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const sessionId = "other-workspace";
    const session = createSessionStore({
      sessionId,
      workspace: sessionWorkspace,
      runtime: runtime(home),
    });
    const activeLedger = await readFile(session.filePath);

    try {
      // When / Then
      expect(() =>
        archiveSessionStore({
          sessionId,
          workspace: currentWorkspace,
          runtime: runtime(home, 1),
        }),
      ).toThrow(SessionStoreError);
      expect(await readFile(session.filePath)).toEqual(activeLedger);
      await expect(
        readFile(join(home, "archived-sessions", sessionId, "ledger.jsonl")),
      ).rejects.toThrow();
    } finally {
      await rm(sessionWorkspace, { recursive: true, force: true });
      await rm(currentWorkspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given archived storage cannot be inspected,
    When the user archives a saved session,
    Then the lifecycle owner fails closed before moving the active directory`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const sessionId = "blocked-destination";
    const session = createSessionStore({
      sessionId,
      workspace,
      runtime: runtime(home),
    });
    const activeLedger = await readFile(session.filePath);
    await writeFile(join(home, "archived-sessions"), "not a directory\n");

    try {
      // When / Then
      expect(() =>
        archiveSessionStore({
          sessionId,
          workspace,
          runtime: runtime(home, 1),
        }),
      ).toThrow(SessionStoreError);
      expect(await readFile(session.filePath)).toEqual(activeLedger);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given the active session directory cannot be renamed,
    When the user archives that session,
    Then the lifecycle owner reports the move failure without losing the ledger`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const sessionId = "blocked-move";
    const session = createSessionStore({
      sessionId,
      workspace,
      runtime: runtime(home),
    });
    const activeLedger = await readFile(session.filePath);
    const activeRoot = join(home, "sessions");
    await chmod(activeRoot, 0o500);

    try {
      // When / Then
      expect(() =>
        archiveSessionStore({
          sessionId,
          workspace,
          runtime: runtime(home, 1),
        }),
      ).toThrow(SessionStoreError);
      expect(await readFile(session.filePath)).toEqual(activeLedger);
    } finally {
      await chmod(activeRoot, 0o700);
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });
});
