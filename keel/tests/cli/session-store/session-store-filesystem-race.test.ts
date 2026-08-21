import type { PathLike, Stats } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { runtime } from "../../../src/testing/session-store-fixtures.ts";

type FsModule = typeof import("node:fs");

class TestNodeError extends Error implements NodeJS.ErrnoException {
  readonly code: string;

  constructor(code: string, operation: string) {
    super(`${code} during ${operation}`);
    this.code = code;
  }
}

async function importSessionStoreWithFs(
  overrides: Partial<{
    readonly openSync: (path: PathLike) => never;
    readonly readSync: () => number;
    readonly rmdirSync: (path: PathLike) => void;
    readonly statSync: (path: PathLike) => Stats;
    readonly writeFileSync: () => never;
  }>,
) {
  const actualFs = await vi.importActual<FsModule>("node:fs");
  vi.resetModules();
  vi.doMock("node:fs", () => ({ ...actualFs, ...overrides }));
  return import("../../../src/cli/session-store.ts");
}

describe("Session Store Filesystem Races", () => {
  afterEach(() => {
    vi.doUnmock("node:fs");
    vi.resetModules();
  });

  test(`Given a session ledger disappears after its size is inspected,
    When the ledger reader opens the file,
    Then it reports the missing-ledger contract`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-session-ledger-race-"));
    const sessionId = "disappearing-ledger";
    const ledgerPath = join(home, "sessions", sessionId, "ledger.jsonl");
    await mkdir(join(home, "sessions", sessionId), { recursive: true });
    await writeFile(ledgerPath, "{}\n", "utf8");
    const sessionStore = await importSessionStoreWithFs({
      openSync: () => {
        throw new TestNodeError("ENOENT", "open");
      },
    });

    try {
      // When / Then
      expect(() =>
        sessionStore.resumeSessionStore({
          sessionId,
          workspace: home,
          runtime: runtime(home),
        }),
      ).toThrow(`session ledger not found at ${ledgerPath}`);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a session ledger is truncated after its size is inspected,
    When the ledger reader reaches an early EOF,
    Then it reports the incomplete read instead of parsing partial data`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-session-ledger-race-"));
    const sessionId = "truncated-ledger";
    const ledgerPath = join(home, "sessions", sessionId, "ledger.jsonl");
    await mkdir(join(home, "sessions", sessionId), { recursive: true });
    await writeFile(ledgerPath, "{}\n", "utf8");
    const sessionStore = await importSessionStoreWithFs({
      readSync: () => 0,
    });

    try {
      // When / Then
      expect(() =>
        sessionStore.resumeSessionStore({
          sessionId,
          workspace: home,
          runtime: runtime(home),
        }),
      ).toThrow(
        `cannot read session ledger ${ledgerPath}: unexpected end of file`,
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given an ownerless lock becomes inaccessible after acquisition detects it,
    When the user acquires that session lock,
    Then acquisition fails closed with the inspection error`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-session-lock-race-"));
    const lockPath = join(home, "session-locks", "inspection-race");
    await mkdir(lockPath, { recursive: true });
    const actualFs = await vi.importActual<FsModule>("node:fs");
    const sessionStore = await importSessionStoreWithFs({
      statSync: (path) => {
        if (String(path) === lockPath) {
          throw new TestNodeError("EACCES", "stat");
        }
        return actualFs.statSync(path);
      },
    });

    try {
      // When / Then
      expect(() =>
        sessionStore.acquireSessionLock({
          sessionId: "inspection-race",
          runtime: runtime(home),
        }),
      ).toThrow(`cannot inspect session lock ${lockPath}: EACCES during stat`);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given owner metadata cannot be written after creating a lock directory,
    When the user acquires that session lock,
    Then acquisition removes the partial lock and reports the write failure`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-session-lock-race-"));
    const lockPath = join(home, "session-locks", "owner-write-race");
    const sessionStore = await importSessionStoreWithFs({
      writeFileSync: () => {
        throw new TestNodeError("EACCES", "write");
      },
    });

    try {
      // When / Then
      expect(() =>
        sessionStore.acquireSessionLock({
          sessionId: "owner-write-race",
          runtime: runtime(home),
        }),
      ).toThrow(`cannot write session lock ${lockPath}: EACCES during write`);
      await expect(stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given another process replaces a partial lock before owner writing fails,
    When the original acquisition handles that failure,
    Then it preserves the successor's valid lock`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-session-lock-race-"));
    const lockPath = join(home, "session-locks", "owner-replacement");
    const ownerPath = join(lockPath, "owner.json");
    const successorOwner = `${JSON.stringify({
      pid: 999_999_999,
      token: "successor",
      createdAt: "1970-01-01T00:00:00.000Z",
    })}\n`;
    const actualFs = await vi.importActual<FsModule>("node:fs");
    const sessionStore = await importSessionStoreWithFs({
      writeFileSync: () => {
        actualFs.rmSync(lockPath, { recursive: true, force: true });
        actualFs.mkdirSync(lockPath, { mode: 0o700 });
        actualFs.writeFileSync(ownerPath, successorOwner, {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        });
        throw new TestNodeError("EACCES", "write");
      },
    });

    try {
      // When / Then
      expect(() =>
        sessionStore.acquireSessionLock({
          sessionId: "owner-replacement",
          runtime: runtime(home),
        }),
      ).toThrow(`cannot write session lock ${lockPath}: EACCES during write`);
      await expect(readFile(ownerPath, "utf8")).resolves.toBe(successorOwner);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a partial lock cannot be removed after owner writing fails,
    When the original acquisition handles that failure,
    Then it reports the cleanup failure and leaves the lock fail-closed`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-session-lock-race-"));
    const lockPath = join(home, "session-locks", "cleanup-blocked");
    const actualFs = await vi.importActual<FsModule>("node:fs");
    const sessionStore = await importSessionStoreWithFs({
      writeFileSync: () => {
        throw new TestNodeError("EIO", "write");
      },
      rmdirSync: (path) => {
        if (String(path) === lockPath) {
          throw new TestNodeError("EACCES", "rmdir");
        }
        actualFs.rmdirSync(path);
      },
    });

    try {
      // When / Then
      expect(() =>
        sessionStore.acquireSessionLock({
          sessionId: "cleanup-blocked",
          runtime: runtime(home),
        }),
      ).toThrow(
        `cannot remove incomplete session lock ${lockPath}: EACCES during rmdir`,
      );
      await expect(stat(lockPath)).resolves.toBeDefined();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
