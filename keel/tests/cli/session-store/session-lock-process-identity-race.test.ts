import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  acquireSessionLock,
  SessionStoreError,
} from "../../../src/cli/session-store.ts";
import { runtime } from "../../../src/testing/session-store-fixtures.ts";

const TIMEZONE_ENV = "TZ";
const originalPlatform = process.platform;
const originalTimezone = process.env[TIMEZONE_ENV];

function setProcessPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    configurable: true,
    enumerable: true,
    value: platform,
  });
}

interface ProcStatStub {
  readonly pid: number;
  readonly value: string | Error;
}

function procStatWithStartTime(pid: number, startTime: string): string {
  const fieldsAfterComm = [
    "S",
    "0",
    "0",
    "0",
    "0",
    "0",
    "0",
    "0",
    "0",
    "0",
    "0",
    "0",
    "0",
    "0",
    "0",
    "0",
    "0",
    "0",
    "0",
    startTime,
  ];
  return `${pid} (keel ) proc test) ${fieldsAfterComm.join(" ")}\n`;
}

async function importSessionStoreWithLinuxProcStats(
  procStatStubs: readonly ProcStatStub[],
) {
  const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
  const execFileSync = () => {
    throw new Error("ps should not run on linux");
  };
  vi.resetModules();
  setProcessPlatform("linux");
  vi.doMock("node:child_process", () => ({ execFileSync }));
  vi.doMock("node:fs", () => ({
    ...actualFs,
    readFileSync: (
      path: Parameters<typeof actualFs.readFileSync>[0],
      options?: Parameters<typeof actualFs.readFileSync>[1],
    ) => {
      const stub = procStatStubs.find(
        (candidate) => path === `/proc/${candidate.pid}/stat`,
      );
      if (stub !== undefined) {
        if (stub.value instanceof Error) {
          throw stub.value;
        }
        return stub.value;
      }
      return actualFs.readFileSync(path, options);
    },
  }));
  const sessionStore = await import("../../../src/cli/session-store.ts");
  return sessionStore;
}

async function importSessionStoreWithCurrentLinuxProcStat(
  procStat: string | Error,
) {
  return importSessionStoreWithLinuxProcStats([
    { pid: process.pid, value: procStat },
  ]);
}

describe("Session Lock Process Identity Races", () => {
  afterEach(() => {
    vi.doUnmock("node:child_process");
    vi.doUnmock("node:fs");
    vi.resetModules();
    setProcessPlatform(originalPlatform);
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
    setProcessPlatform("darwin");
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
        join(home, "session-locks", "current-identity-unknown"),
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

  test(`Given Linux proc exposes the current process start time,
    When a user starts a named session with ps unavailable,
    Then the store writes a strong active lock`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const sessionStore = await importSessionStoreWithCurrentLinuxProcStat(
      procStatWithStartTime(process.pid, "424242"),
    );

    try {
      // When
      const lock = sessionStore.acquireSessionLock({
        sessionId: "linux-proc-current",
        runtime: runtime(home),
      });

      // Then
      const owner = await readFile(join(lock.lockPath, "owner.json"), "utf8");
      expect(owner).toContain(`"hostname":"${hostname()}"`);
      expect(owner).toContain('"processStartTime":"424242"');
      lock.release();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given Linux proc cannot inspect the current process,
    When a user starts a named session,
    Then the store falls back to a PID-only active lock`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const sessionStore = await importSessionStoreWithCurrentLinuxProcStat(
      new Error("proc unavailable"),
    );

    try {
      // When
      const lock = sessionStore.acquireSessionLock({
        sessionId: "linux-proc-unavailable",
        runtime: runtime(home),
      });

      // Then
      const owner = await readFile(join(lock.lockPath, "owner.json"), "utf8");
      expect(owner).not.toContain("hostname");
      expect(owner).not.toContain("processStartTime");
      lock.release();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given Linux proc returns a malformed current process stat,
    When a user starts a named session,
    Then the store falls back to a PID-only active lock`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const sessionStore = await importSessionStoreWithCurrentLinuxProcStat(
      "malformed proc stat\n",
    );

    try {
      // When
      const lock = sessionStore.acquireSessionLock({
        sessionId: "linux-proc-malformed",
        runtime: runtime(home),
      });

      // Then
      const owner = await readFile(join(lock.lockPath, "owner.json"), "utf8");
      expect(owner).not.toContain("hostname");
      expect(owner).not.toContain("processStartTime");
      lock.release();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given Linux proc returns a nonnumeric current process start time,
    When a user starts a named session,
    Then the store falls back to a PID-only active lock`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const sessionStore = await importSessionStoreWithCurrentLinuxProcStat(
      procStatWithStartTime(process.pid, "not-a-number"),
    );

    try {
      // When
      const lock = sessionStore.acquireSessionLock({
        sessionId: "linux-proc-nonnumeric",
        runtime: runtime(home),
      });

      // Then
      const owner = await readFile(join(lock.lockPath, "owner.json"), "utf8");
      expect(owner).not.toContain("hostname");
      expect(owner).not.toContain("processStartTime");
      lock.release();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given Linux proc cannot inspect an exited lock owner,
    When the same session lock is acquired again,
    Then the store recovers the abandoned lock`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const lockPath = join(home, "session-locks", "linux-owner-exited");
    const exitedPid = 999_999_999;
    await mkdir(lockPath, { recursive: true });
    await writeFile(
      join(lockPath, "owner.json"),
      `${JSON.stringify({
        pid: exitedPid,
        token: "stale",
        createdAt: "1970-01-01T00:00:00.000Z",
        hostname: hostname(),
        processStartTime: "old-process-start-time",
      })}\n`,
      "utf8",
    );
    const sessionStore = await importSessionStoreWithLinuxProcStats([
      {
        pid: process.pid,
        value: procStatWithStartTime(process.pid, "123456"),
      },
      { pid: exitedPid, value: new Error("proc unavailable") },
    ]);

    try {
      // When
      const lock = sessionStore.acquireSessionLock({
        sessionId: "linux-owner-exited",
        runtime: runtime(home, 1),
      });

      // Then
      expect(lock.lockPath).toBe(lockPath);
      lock.release();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given Linux proc returns malformed stat for an exited lock owner,
    When the same session lock is acquired again,
    Then the store recovers the abandoned lock`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const lockPath = join(home, "session-locks", "linux-owner-malformed");
    const exitedPid = 999_999_999;
    await mkdir(lockPath, { recursive: true });
    await writeFile(
      join(lockPath, "owner.json"),
      `${JSON.stringify({
        pid: exitedPid,
        token: "stale",
        createdAt: "1970-01-01T00:00:00.000Z",
        hostname: hostname(),
        processStartTime: "old-process-start-time",
      })}\n`,
      "utf8",
    );
    const sessionStore = await importSessionStoreWithLinuxProcStats([
      {
        pid: process.pid,
        value: procStatWithStartTime(process.pid, "123456"),
      },
      { pid: exitedPid, value: "malformed proc stat\n" },
    ]);

    try {
      // When
      const lock = sessionStore.acquireSessionLock({
        sessionId: "linux-owner-malformed",
        runtime: runtime(home, 1),
      });

      // Then
      expect(lock.lockPath).toBe(lockPath);
      lock.release();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given the platform has no strong process identity reader,
    When a user starts a named session,
    Then the store falls back to a PID-only active lock`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const execFileSync = () => {
      throw new Error("ps should not run on this platform");
    };
    vi.resetModules();
    setProcessPlatform("win32");
    vi.doMock("node:child_process", () => ({ execFileSync }));
    const { acquireSessionLock } = await import(
      "../../../src/cli/session-store.ts"
    );

    try {
      // When
      const lock = acquireSessionLock({
        sessionId: "unknown-platform",
        runtime: runtime(home),
      });

      // Then
      const owner = await readFile(join(lock.lockPath, "owner.json"), "utf8");
      expect(owner).not.toContain("hostname");
      expect(owner).not.toContain("processStartTime");
      lock.release();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given the platform has no strong process identity reader and the owner exited,
    When the same session lock is acquired again,
    Then the store recovers the abandoned lock`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const lockPath = join(home, "session-locks", "unknown-platform-stale");
    const exitedPid = 999_999_999;
    await mkdir(lockPath, { recursive: true });
    await writeFile(
      join(lockPath, "owner.json"),
      `${JSON.stringify({
        pid: exitedPid,
        token: "stale",
        createdAt: "1970-01-01T00:00:00.000Z",
        hostname: hostname(),
        processStartTime: "old-process-start-time",
      })}\n`,
      "utf8",
    );
    const execFileSync = () => {
      throw new Error("ps should not run on this platform");
    };
    vi.resetModules();
    setProcessPlatform("win32");
    vi.doMock("node:child_process", () => ({ execFileSync }));
    const { acquireSessionLock } = await import(
      "../../../src/cli/session-store.ts"
    );

    try {
      // When
      const lock = acquireSessionLock({
        sessionId: "unknown-platform-stale",
        runtime: runtime(home, 1),
      });

      // Then
      expect(lock.lockPath).toBe(lockPath);
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
    setProcessPlatform("darwin");
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
    const lockPath = join(home, "session-locks", "owner-identity-unknown");
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
    setProcessPlatform("darwin");
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
    const lockPath = join(home, "session-locks", "owner-start-empty");
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
    setProcessPlatform("darwin");
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
    const lockPath = join(home, "session-locks", "exited-start-empty");
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
    setProcessPlatform("darwin");
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
