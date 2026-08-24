import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { errorMessage } from "../core/error.ts";
import {
  ensurePrivateDirectory,
  PrivateStateError,
} from "../core/private-state.ts";

const MCP_OAUTH_REFRESH_LOCK_WAIT_MS = 25;
// Keep lock acquisition bounded, but longer than the 30-second token request
// so contenders can adopt a healthy leader's durable refresh result.
const MCP_OAUTH_REFRESH_LOCK_TIMEOUT_MS = 60_000;
const MCP_OAUTH_REFRESH_OWNERLESS_STALE_MS = 30_000;
const MCP_OAUTH_REFRESH_REMOTE_STALE_MS = 2 * 60 * 1000;

const refreshLockOwnerSchema = z
  .object({
    pid: z.number().int().positive(),
    hostname: z.string().min(1),
    token: z.string().uuid(),
    createdAt: z.number().int().nonnegative(),
  })
  .strict();

type RefreshLockOwner = z.infer<typeof refreshLockOwnerSchema>;

type RefreshLockRead =
  | { readonly status: "valid"; readonly owner: RefreshLockOwner }
  | { readonly status: "missing" }
  | { readonly status: "malformed" }
  | { readonly status: "failed"; readonly error: string };

type RefreshLockRoot = {
  readonly root: string;
  readonly validateRoot?: (() => void) | undefined;
};

export class McpOAuthRefreshLockError extends Error {}

function hasNodeErrorCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code === code
  );
}

function refreshLockError(message: string): never {
  throw new McpOAuthRefreshLockError(`Error: MCP authorization ${message}.`);
}

function validateRefreshLockRoot(options: RefreshLockRoot): void {
  try {
    options.validateRoot?.();
    ensurePrivateDirectory(options.root, "MCP OAuth refresh lock root");
  } catch (error) {
    if (error instanceof PrivateStateError) {
      throw new McpOAuthRefreshLockError(error.message);
    }
    throw error;
  }
}

function lockPath(root: string, credentialId: string): string {
  return join(root, `${credentialId}.lock`);
}

function ownerPath(path: string): string {
  return join(path, "owner.json");
}

async function readOwner(path: string): Promise<RefreshLockRead> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(ownerPath(path), "utf8"));
  } catch (error) {
    if (hasNodeErrorCode(error, "ENOENT")) return { status: "missing" };
    if (error instanceof SyntaxError) return { status: "malformed" };
    return { status: "failed", error: errorMessage(error) };
  }
  const parsed = refreshLockOwnerSchema.safeParse(raw);
  return parsed.success
    ? { status: "valid", owner: parsed.data }
    : { status: "malformed" };
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !hasNodeErrorCode(error, "ESRCH");
  }
}

async function lockAge(path: string, now: number): Promise<number> {
  try {
    return Math.max(0, now - (await stat(path)).mtimeMs);
  } catch (error) {
    /* v8 ignore start -- requires a filesystem race or injected stat fault between owner inspection and age lookup; both paths fail closed or retry. */
    if (hasNodeErrorCode(error, "ENOENT")) return 0;
    refreshLockError(`cannot inspect the refresh lock: ${errorMessage(error)}`);
    /* v8 ignore stop */
  }
}

async function lockIsStale(
  path: string,
  ownerRead: RefreshLockRead,
  now: number,
): Promise<boolean> {
  if (ownerRead.status === "failed") {
    refreshLockError(`cannot read the refresh lock: ${ownerRead.error}`);
  }
  if (ownerRead.status === "valid") {
    if (ownerRead.owner.hostname === hostname()) {
      return !processIsAlive(ownerRead.owner.pid);
    }
    return now - ownerRead.owner.createdAt >= MCP_OAUTH_REFRESH_REMOTE_STALE_MS;
  }
  return (await lockAge(path, now)) >= MCP_OAUTH_REFRESH_OWNERLESS_STALE_MS;
}

async function moveLockForRemoval(
  rootOptions: RefreshLockRoot,
  path: string,
): Promise<boolean> {
  validateRefreshLockRoot(rootOptions);
  const reclaimedRoot = join(rootOptions.root, ".reclaimed");
  const reclaimedPath = join(reclaimedRoot, randomUUID());
  try {
    await mkdir(reclaimedRoot, { recursive: true, mode: 0o700 });
    validateRefreshLockRoot(rootOptions);
    await rename(path, reclaimedPath);
  } catch (error) {
    /* v8 ignore next -- requires another process to remove the same stale generation between inspection and atomic rename; the acquisition loop safely retries. */
    if (hasNodeErrorCode(error, "ENOENT")) return false;
    refreshLockError(`cannot reclaim the refresh lock: ${errorMessage(error)}`);
  }
  try {
    await rm(reclaimedPath, { recursive: true, force: true });
  } catch (error) {
    /* v8 ignore next 3 -- requires an injected filesystem deletion fault after a successful atomic rename; surface it rather than hiding lock cleanup failure. */
    refreshLockError(
      `cannot remove the reclaimed refresh lock: ${errorMessage(error)}`,
    );
  }
  return true;
}

async function releaseLock(
  rootOptions: RefreshLockRoot,
  path: string,
  token: string,
): Promise<void> {
  validateRefreshLockRoot(rootOptions);
  const ownerRead = await readOwner(path);
  if (ownerRead.status !== "valid" || ownerRead.owner.token !== token) return;
  await moveLockForRemoval(rootOptions, path);
}

async function waitForLock(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, MCP_OAUTH_REFRESH_LOCK_WAIT_MS);
  });
}

export async function withMcpOAuthRefreshLock<Result>(options: {
  readonly root: string;
  readonly validateRoot?: (() => void) | undefined;
  readonly credentialId: string;
  readonly action: () => Promise<Result>;
}): Promise<Result> {
  const rootOptions: RefreshLockRoot = options;
  const path = lockPath(options.root, options.credentialId);
  const token = randomUUID();
  const deadline = Date.now() + MCP_OAUTH_REFRESH_LOCK_TIMEOUT_MS;

  for (;;) {
    validateRefreshLockRoot(rootOptions);
    try {
      await mkdir(path, { mode: 0o700 });
    } catch (error) {
      if (hasNodeErrorCode(error, "EEXIST")) {
        const ownerRead = await readOwner(path);
        if (await lockIsStale(path, ownerRead, Date.now())) {
          await moveLockForRemoval(rootOptions, path);
          continue;
        }
        if (Date.now() >= deadline) {
          refreshLockError(
            "refresh is busy in another Keel process; retry after it finishes",
          );
        }
        await waitForLock();
        continue;
      }
      refreshLockError(
        `cannot acquire the refresh lock: ${errorMessage(error)}`,
      );
    }

    validateRefreshLockRoot(rootOptions);
    try {
      await writeFile(
        ownerPath(path),
        `${JSON.stringify({
          pid: process.pid,
          hostname: hostname(),
          token,
          createdAt: Date.now(),
        })}\n`,
        { encoding: "utf8", mode: 0o600, flag: "wx" },
      );
    } catch (error) {
      /* v8 ignore start -- requires an external filesystem mutation between exclusive directory creation and its immediate owner-file write. */
      await moveLockForRemoval(rootOptions, path);
      refreshLockError(
        `cannot initialize the refresh lock: ${errorMessage(error)}`,
      );
      /* v8 ignore stop */
    }

    validateRefreshLockRoot(rootOptions);
    try {
      return await options.action();
    } finally {
      await releaseLock(rootOptions, path, token);
    }
  }
}
