import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { runtime } from "../../../src/testing/session-store-fixtures.ts";

class TestNodeError extends Error implements NodeJS.ErrnoException {
  readonly code: string;

  constructor(code: string) {
    super(`${code} during rmdir`);
    this.code = code;
  }
}

function nodeError(code: string): NodeJS.ErrnoException {
  return new TestNodeError(code);
}

async function importSessionStoreWithSessionDirectoryRemovalError(options: {
  readonly home: string;
  readonly sessionId: string;
  readonly code: string;
}) {
  const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
  const blockedPath = join(options.home, "sessions", options.sessionId);
  const rmdirSync: typeof actualFs.rmdirSync = (path, rmdirOptions) => {
    if (path === blockedPath) {
      throw nodeError(options.code);
    }
    return actualFs.rmdirSync(path, rmdirOptions);
  };

  vi.resetModules();
  vi.doMock("node:fs", () => ({
    ...actualFs,
    rmdirSync,
  }));
  return import("../../../src/cli/session-store.ts");
}

describe("Session Lock Release Cleanup", () => {
  afterEach(() => {
    vi.doUnmock("node:fs");
    vi.resetModules();
  });

  test.each([
    {
      code: "ENOENT",
      label: "already removed session directory",
    },
    {
      code: "EEXIST",
      label: "non-empty session directory on platforms that report EEXIST",
    },
  ])(`Given a $label race occurs after releasing a lock,
    When the session lock is released,
    Then cleanup ignores the benign empty-directory removal race`, async (testCase) => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const sessionStore =
      await importSessionStoreWithSessionDirectoryRemovalError({
        home,
        sessionId: "benign-release-cleanup",
        code: testCase.code,
      });

    try {
      const lock = sessionStore.acquireSessionLock({
        sessionId: "benign-release-cleanup",
        runtime: runtime(home),
      });

      // When / Then
      expect(() => {
        lock.release();
      }).not.toThrow();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given empty session directory cleanup fails after releasing a lock,
    When the session lock is released,
    Then release fails closed with a session store error`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const sessionStore =
      await importSessionStoreWithSessionDirectoryRemovalError({
        home,
        sessionId: "blocked-release-cleanup",
        code: "EACCES",
      });

    try {
      const lock = sessionStore.acquireSessionLock({
        sessionId: "blocked-release-cleanup",
        runtime: runtime(home),
      });

      // When / Then
      expect(() => {
        lock.release();
      }).toThrow(sessionStore.SessionStoreError);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
