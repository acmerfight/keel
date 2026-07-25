import type { PathLike, Stats } from "node:fs";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
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
    readonly statSync: (path: PathLike) => Stats;
    readonly writeFileSync: () => never;
  }>,
) {
  const actualFs = await vi.importActual<FsModule>("node:fs");
  vi.resetModules();
  vi.doMock("node:fs", () => ({ ...actualFs, ...overrides }));
  return import("../../../src/cli/session-store.ts");
}

describe("Session Lock Filesystem Races", () => {
  afterEach(() => {
    vi.doUnmock("node:fs");
    vi.resetModules();
  });

  test(`Given an ownerless lock disappears from inspection after acquisition detects it,
    When the user acquires that session lock,
    Then acquisition fails closed with the inspection error`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-session-lock-race-"));
    const lockPath = join(home, "sessions", "inspection-race", "active.lock");
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
    const lockPath = join(home, "sessions", "owner-write-race", "active.lock");
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
});
