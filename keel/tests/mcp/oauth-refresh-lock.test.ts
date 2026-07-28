import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import {
  McpOAuthRefreshLockError,
  withMcpOAuthRefreshLock,
} from "../../src/mcp/oauth-refresh-lock.ts";

function runLockProcess(options: {
  readonly root: string;
  readonly credentialId: string;
  readonly tracePath: string;
  readonly label: string;
  readonly holdMs: number;
}): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--experimental-strip-types",
        join(process.cwd(), "tests/fixtures/mcp-oauth-refresh-lock.ts"),
        options.root,
        options.credentialId,
        options.tracePath,
        options.label,
        String(options.holdMs),
      ],
      {
        cwd: process.cwd(),
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `refresh-lock fixture exited with code ${String(code)} signal ${String(signal)}: ${stderr}`,
        ),
      );
    });
  });
}

async function exitedProcessId(): Promise<number> {
  const child = spawn(process.execPath, ["--eval", "process.exit(0)"], {
    stdio: "ignore",
  });
  const pid = child.pid;
  if (pid === undefined) {
    throw new Error("dead-process fixture did not receive a pid");
  }
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", () => {
      resolve();
    });
  });
  return pid;
}

function lockDirectory(root: string, credentialId: string): string {
  return join(root, `${credentialId}.lock`);
}

async function createOwner(options: {
  readonly root: string;
  readonly credentialId: string;
  readonly pid: number;
  readonly ownerHostname: string;
  readonly createdAt: number;
}): Promise<string> {
  const path = lockDirectory(options.root, options.credentialId);
  await mkdir(path, { recursive: true });
  await writeFile(
    join(path, "owner.json"),
    JSON.stringify({
      pid: options.pid,
      hostname: options.ownerHostname,
      token: randomUUID(),
      createdAt: options.createdAt,
    }),
  );
  return path;
}

describe("MCP OAuth refresh lock", () => {
  test(`Given two Keel processes refresh the same credential,
    When their critical sections overlap in wall-clock time,
    Then the filesystem lock serializes them across process boundaries`, async () => {
    // Given
    const actualRoot = join(tmpdir(), `keel-mcp-refresh-lock-${randomUUID()}`);
    const tracePath = join(tmpdir(), `keel-mcp-refresh-trace-${randomUUID()}`);
    const options = {
      root: actualRoot,
      credentialId: "shared-credential",
      tracePath,
      holdMs: 100,
    };

    try {
      // When
      await Promise.all([
        runLockProcess({ ...options, label: "a" }),
        runLockProcess({ ...options, label: "b" }),
      ]);

      // Then
      const trace = (await readFile(tracePath, "utf8")).trim().split("\n");
      expect(
        [
          ["a:start", "a:end", "b:start", "b:end"],
          ["b:start", "b:end", "a:start", "a:end"],
        ].map((value) => JSON.stringify(value)),
      ).toContain(JSON.stringify(trace));
    } finally {
      await rm(actualRoot, { recursive: true, force: true });
      await rm(tracePath, { force: true });
    }
  });

  test.each([
    ["dead local process", "valid-local"],
    ["stale remote process", "valid-remote"],
    ["ownerless lock", "missing"],
    ["malformed owner JSON", "malformed-json"],
    ["invalid owner schema", "malformed-schema"],
  ])(
    `Given a refresh lock belongs to a %s,
    When a new transaction encounters it after its stale boundary,
    Then Keel reclaims the stale generation and completes safely`,
    async (_case, ownerKind) => {
      // Given
      const root = join(
        tmpdir(),
        `keel-mcp-stale-refresh-lock-${randomUUID()}`,
      );
      const credentialId = "stale-credential";
      const path = lockDirectory(root, credentialId);
      const staleAt = Date.now() - 3 * 60 * 1000;
      if (ownerKind === "valid-local") {
        await createOwner({
          root,
          credentialId,
          pid: await exitedProcessId(),
          ownerHostname: hostname(),
          createdAt: Date.now(),
        });
      } else if (ownerKind === "valid-remote") {
        await createOwner({
          root,
          credentialId,
          pid: 1,
          ownerHostname: "other-host.example",
          createdAt: staleAt,
        });
      } else {
        await mkdir(path, { recursive: true });
        if (ownerKind === "malformed-json") {
          await writeFile(join(path, "owner.json"), "{");
        } else if (ownerKind === "malformed-schema") {
          await writeFile(join(path, "owner.json"), "{}");
        }
        await utimes(path, staleAt / 1000, staleAt / 1000);
      }

      try {
        // When
        const result = await withMcpOAuthRefreshLock({
          root,
          credentialId,
          action: async () => "completed",
        });

        // Then
        expect(result).toBe("completed");
        await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  test(`Given another live owner releases a recent refresh lock,
    When a waiter is contending for the same credential,
    Then it waits and acquires the next lock generation`, async () => {
    // Given
    const root = join(tmpdir(), `keel-mcp-live-lock-${randomUUID()}`);
    const credentialId = "live-credential";
    const path = await createOwner({
      root,
      credentialId,
      pid: process.pid,
      ownerHostname: hostname(),
      createdAt: Date.now(),
    });
    const releaseOwner = setTimeout(() => {
      void rm(path, { recursive: true, force: true });
    }, 75);

    try {
      // When
      const result = await withMcpOAuthRefreshLock({
        root,
        credentialId,
        action: async () => "adopted",
      });

      // Then
      expect(result).toBe("adopted");
    } finally {
      clearTimeout(releaseOwner);
      await rm(root, { recursive: true, force: true });
    }
  });

  test(`Given a refresh lock path is not a readable lock directory,
    When Keel inspects the contended credential,
    Then it fails closed with a lock-read diagnostic`, async () => {
    // Given
    const root = join(tmpdir(), `keel-mcp-unreadable-lock-${randomUUID()}`);
    const credentialId = "unreadable-credential";
    await mkdir(root, { recursive: true });
    await writeFile(lockDirectory(root, credentialId), "not-a-directory");

    try {
      // When / Then
      await expect(
        withMcpOAuthRefreshLock({
          root,
          credentialId,
          action: async () => "unexpected",
        }),
      ).rejects.toThrow("cannot read the refresh lock");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test(`Given a stale lock cannot be moved into the reclaim namespace,
    When Keel attempts safe generation replacement,
    Then it fails closed without running the refresh action`, async () => {
    // Given
    const root = join(tmpdir(), `keel-mcp-unreclaimable-lock-${randomUUID()}`);
    const credentialId = "unreclaimable-credential";
    await createOwner({
      root,
      credentialId,
      pid: await exitedProcessId(),
      ownerHostname: hostname(),
      createdAt: Date.now(),
    });
    await writeFile(join(root, ".reclaimed"), "not-a-directory");
    let actionRan = false;

    try {
      // When / Then
      await expect(
        withMcpOAuthRefreshLock({
          root,
          credentialId,
          action: async () => {
            actionRan = true;
          },
        }),
      ).rejects.toThrow("cannot reclaim the refresh lock");
      expect(actionRan).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test(`Given the protected refresh action fails,
    When the transaction unwinds,
    Then Keel releases its owned lock without hiding the original failure`, async () => {
    // Given
    const root = join(tmpdir(), `keel-mcp-action-lock-${randomUUID()}`);
    const credentialId = "failing-credential";

    try {
      // When / Then
      await expect(
        withMcpOAuthRefreshLock({
          root,
          credentialId,
          action: async () => {
            throw new Error("refresh failed");
          },
        }),
      ).rejects.toThrow("refresh failed");
      await expect(
        stat(lockDirectory(root, credentialId)),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test(`Given a lock owner token changes while an action is running,
    When the older generation releases,
    Then it does not delete the replacement generation`, async () => {
    // Given
    const root = join(tmpdir(), `keel-mcp-replaced-lock-${randomUUID()}`);
    const credentialId = "replaced-credential";
    const path = lockDirectory(root, credentialId);

    try {
      // When
      await withMcpOAuthRefreshLock({
        root,
        credentialId,
        action: async () => {
          await writeFile(
            join(path, "owner.json"),
            JSON.stringify({
              pid: process.pid,
              hostname: hostname(),
              token: randomUUID(),
              createdAt: Date.now(),
            }),
          );
        },
      });

      // Then
      await expect(stat(path)).resolves.toBeDefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test(`Given a live owner never releases the refresh lock,
    When the bounded wait expires,
    Then Keel fails closed instead of refreshing without coordination`, async () => {
    // Given
    vi.useFakeTimers();
    const root = join(tmpdir(), `keel-mcp-timeout-lock-${randomUUID()}`);
    const credentialId = "busy-credential";
    await createOwner({
      root,
      credentialId,
      pid: process.pid,
      ownerHostname: hostname(),
      createdAt: Date.now(),
    });

    try {
      // When
      const result = withMcpOAuthRefreshLock({
        root,
        credentialId,
        action: async () => "unexpected",
      });
      await vi.advanceTimersByTimeAsync(60_025);

      // Then
      await expect(result).rejects.toBeInstanceOf(McpOAuthRefreshLockError);
      await expect(result).rejects.toThrow(
        "refresh is busy in another Keel process",
      );
    } finally {
      vi.useRealTimers();
      await rm(root, { recursive: true, force: true });
    }
  });
});
