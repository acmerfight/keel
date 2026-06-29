import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  acquireSessionLock,
  SessionStoreError,
} from "../../../src/cli/session-store.ts";
import { runtime } from "../../../src/testing/session-store-fixtures.ts";

const TIMEZONE_ENV = "TZ";
const originalTimezone = process.env[TIMEZONE_ENV];

describe("Session Lock Process Identity Races", () => {
  afterEach(() => {
    vi.doUnmock("node:child_process");
    vi.resetModules();
    if (originalTimezone === undefined) {
      delete process.env[TIMEZONE_ENV];
      return;
    }
    process.env[TIMEZONE_ENV] = originalTimezone;
  });

  test(`Given the current process identity cannot be inspected,
    When a user starts a named session,
    Then the store falls back to a PID-only active lock`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    vi.resetModules();
    vi.doMock("node:child_process", () => ({
      execFileSync: () => {
        throw new Error("ps unavailable");
      },
    }));
    const { acquireSessionLock, SessionStoreError } = await import(
      "../../../src/cli/session-store.ts"
    );

    try {
      // When
      const lock = acquireSessionLock({
        sessionId: "current-identity-unknown",
        runtime: runtime(home),
      });

      // Then
      expect(lock.lockPath).toBe(
        join(home, "sessions", "current-identity-unknown", "active.lock"),
      );
      expect(() =>
        acquireSessionLock({
          sessionId: "current-identity-unknown",
          runtime: runtime(home, 1),
        }),
      ).toThrow(SessionStoreError);
      lock.release();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given an active session lock was created under a different timezone,
    When the same session lock is acquired again,
    Then the store still treats the owner process as active`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    process.env[TIMEZONE_ENV] = "UTC";
    const lock = acquireSessionLock({
      sessionId: "timezone-stable",
      runtime: runtime(home),
    });

    try {
      // When / Then
      process.env[TIMEZONE_ENV] = "Asia/Shanghai";
      expect(() =>
        acquireSessionLock({
          sessionId: "timezone-stable",
          runtime: runtime(home, 1),
        }),
      ).toThrow(SessionStoreError);
    } finally {
      lock.release();
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given an active session lock owner identity cannot be inspected,
    When the same session lock is acquired again,
    Then the store fails closed instead of reclaiming the lock`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const lockPath = join(
      home,
      "sessions",
      "owner-identity-unknown",
      "active.lock",
    );
    await mkdir(lockPath, { recursive: true });
    await writeFile(
      join(lockPath, "owner.json"),
      `${JSON.stringify({
        pid: 1,
        token: "active",
        createdAt: "1970-01-01T00:00:00.000Z",
        hostname: hostname(),
        processStartTime: "old-process-start-time",
      })}\n`,
      "utf8",
    );
    vi.resetModules();
    vi.doMock("node:child_process", () => ({
      execFileSync: (_command: string, args: readonly string[]) => {
        if (args[1] === String(process.pid)) {
          return "current-process-start-time\n";
        }
        throw new Error("ps unavailable");
      },
    }));
    const { acquireSessionLock, SessionStoreError } = await import(
      "../../../src/cli/session-store.ts"
    );

    try {
      // When / Then
      expect(() =>
        acquireSessionLock({
          sessionId: "owner-identity-unknown",
          runtime: runtime(home, 1),
        }),
      ).toThrow(SessionStoreError);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given an active session lock owner has an empty inspected start time,
    When the same session lock is acquired again,
    Then the store fails closed instead of treating the owner as stale`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const lockPath = join(home, "sessions", "owner-start-empty", "active.lock");
    await mkdir(lockPath, { recursive: true });
    await writeFile(
      join(lockPath, "owner.json"),
      `${JSON.stringify({
        pid: 1,
        token: "active",
        createdAt: "1970-01-01T00:00:00.000Z",
        hostname: hostname(),
        processStartTime: "old-process-start-time",
      })}\n`,
      "utf8",
    );
    vi.resetModules();
    vi.doMock("node:child_process", () => ({
      execFileSync: (_command: string, args: readonly string[]) =>
        args[1] === String(process.pid) ? "current-process-start-time\n" : "\n",
    }));
    const { acquireSessionLock, SessionStoreError } = await import(
      "../../../src/cli/session-store.ts"
    );

    try {
      // When / Then
      expect(() =>
        acquireSessionLock({
          sessionId: "owner-start-empty",
          runtime: runtime(home, 1),
        }),
      ).toThrow(SessionStoreError);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given an exited session lock owner has an empty inspected start time,
    When the same session lock is acquired again,
    Then the store recovers the abandoned lock`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const lockPath = join(
      home,
      "sessions",
      "exited-start-empty",
      "active.lock",
    );
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
    vi.resetModules();
    vi.doMock("node:child_process", () => ({
      execFileSync: (_command: string, args: readonly string[]) =>
        args[1] === String(process.pid) ? "current-process-start-time\n" : "\n",
    }));
    const { acquireSessionLock } = await import(
      "../../../src/cli/session-store.ts"
    );

    try {
      // When
      const lock = acquireSessionLock({
        sessionId: "exited-start-empty",
        runtime: runtime(home, 1),
      });

      // Then
      expect(lock.lockPath).toBe(lockPath);
      lock.release();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
