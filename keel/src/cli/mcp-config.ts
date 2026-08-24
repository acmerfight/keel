import { randomUUID } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { open, rm, stat } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { errorMessage } from "../core/error.ts";
import {
  ensurePrivateStateDirectory,
  PrivateStateError,
  privateStateDirectoryPath,
  privateStatePath,
  readPrivateStateFile,
  replacePrivateStateFile,
} from "../core/private-state.ts";

const MCP_CONFIG_SCHEMA_VERSION = 4;
const MCP_CONFIG_MAX_BYTES = 1024 * 1024;
const MCP_CONFIG_MAX_SERVERS = 128;
const MCP_CONFIG_LOCK_TIMEOUT_MS = 5_000;
const MCP_CONFIG_STALE_LOCK_MS = 30_000;
const MCP_SERVER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const MCP_SERVER_LIFECYCLE_POLL_MS = 50;
const MCP_TOOL_FILTER_MAX_ENTRIES = 256;
const mcpToolFilterNameSchema = z.string().min(1).max(128);
const mcpToolFilterSchema = z
  .object({
    allow: z
      .array(mcpToolFilterNameSchema)
      .max(MCP_TOOL_FILTER_MAX_ENTRIES)
      .nullable(),
    deny: z.array(mcpToolFilterNameSchema).max(MCP_TOOL_FILTER_MAX_ENTRIES),
  })
  .strict()
  .superRefine((filter, context) => {
    for (const [field, names] of [
      ["allow", filter.allow ?? []],
      ["deny", filter.deny],
    ] as const) {
      const seen = new Set<string>();
      for (const [index, name] of names.entries()) {
        if (seen.has(name)) {
          context.addIssue({
            code: "custom",
            path: [field, index],
            message: `duplicate MCP tool filter "${name}"`,
          });
        }
        seen.add(name);
      }
    }
  });

const mcpServerConfigSchema = z
  .object({
    id: z.string().regex(MCP_SERVER_ID_PATTERN),
    incarnation: z.uuid(),
    url: z.url().transform((raw) => new URL(raw).href),
    enabled: z.boolean(),
    allowPrivateNetwork: z.boolean(),
    authenticationRequired: z.boolean(),
    toolFilter: mcpToolFilterSchema,
  })
  .strict();
const mcpConfigFileSchema = z
  .object({
    schemaVersion: z.literal(MCP_CONFIG_SCHEMA_VERSION),
    servers: z.array(mcpServerConfigSchema).max(MCP_CONFIG_MAX_SERVERS),
  })
  .strict()
  .superRefine((file, context) => {
    const ids = new Set<string>();
    const urls = new Set<string>();
    for (const [index, server] of file.servers.entries()) {
      if (ids.has(server.id)) {
        context.addIssue({
          code: "custom",
          path: ["servers", index, "id"],
          message: `duplicate MCP server id "${server.id}"`,
        });
      }
      ids.add(server.id);
      if (urls.has(server.url)) {
        context.addIssue({
          code: "custom",
          path: ["servers", index, "url"],
          message: "duplicate MCP endpoint",
        });
      }
      urls.add(server.url);
    }
  });

export type McpServerConfig = z.infer<typeof mcpServerConfigSchema>;
export type NewMcpServerConfig = Omit<McpServerConfig, "incarnation">;
type McpServerIdentity = Pick<
  McpServerConfig,
  "id" | "incarnation" | "url" | "allowPrivateNetwork"
>;
type McpConfigFile = z.infer<typeof mcpConfigFileSchema>;

interface McpConfigRuntime {
  readonly env: (key: string) => string | undefined;
}

export class McpConfigError extends Error {}

function configError(message: string): never {
  throw new McpConfigError(message);
}

function hasNodeErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function mcpStateHome(runtime: McpConfigRuntime, ensure = false): string {
  try {
    return ensure
      ? ensurePrivateStateDirectory(runtime, [], "KEEL_HOME")
      : privateStateDirectoryPath(runtime, [], "KEEL_HOME");
  } catch (error) {
    if (error instanceof PrivateStateError) {
      configError(error.message);
    }
    throw error;
  }
}

function configPath(runtime: McpConfigRuntime): string {
  return privateStatePath(runtime, ["mcp.json"]);
}

function configLockPath(runtime: McpConfigRuntime): string {
  return privateStatePath(runtime, [".mcp-config.lock"]);
}

async function readMcpConfigFile(
  runtime: McpConfigRuntime,
): Promise<McpConfigFile> {
  const filePath = configPath(runtime);
  let raw: string | null;
  try {
    mcpStateHome(runtime);
    raw = readPrivateStateFile({
      runtime,
      segments: ["mcp.json"],
      label: "MCP config",
    });
  } catch (error) {
    configError(
      `Error: cannot read MCP config ${filePath}: ${errorMessage(error)}`,
    );
  }
  if (raw === null) {
    return { schemaVersion: MCP_CONFIG_SCHEMA_VERSION, servers: [] };
  }
  if (Buffer.byteLength(raw, "utf8") > MCP_CONFIG_MAX_BYTES) {
    configError(
      `Error: cannot read MCP config ${filePath}: file exceeds ${MCP_CONFIG_MAX_BYTES} bytes.`,
    );
  }
  return parseMcpConfigFile(raw, filePath);
}

function parseMcpConfigFile(raw: string, filePath: string): McpConfigFile {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    configError(`Error: cannot read MCP config ${filePath}: invalid JSON.`);
  }
  const parsed = mcpConfigFileSchema.safeParse(json);
  if (!parsed.success) {
    configError(
      `Error: cannot read MCP config ${filePath}: ${parsed.error.message}.`,
    );
  }
  return parsed.data;
}

function readMcpConfigFileSync(runtime: McpConfigRuntime): McpConfigFile {
  const filePath = configPath(runtime);
  let raw: string | null;
  try {
    mcpStateHome(runtime);
    raw = readPrivateStateFile({
      runtime,
      segments: ["mcp.json"],
      label: "MCP config",
    });
  } catch (error) {
    configError(
      `Error: cannot read MCP config ${filePath}: ${errorMessage(error)}`,
    );
  }
  if (raw === null) {
    return { schemaVersion: MCP_CONFIG_SCHEMA_VERSION, servers: [] };
  }
  if (Buffer.byteLength(raw, "utf8") > MCP_CONFIG_MAX_BYTES) {
    configError(
      `Error: cannot read MCP config ${filePath}: file exceeds ${MCP_CONFIG_MAX_BYTES} bytes.`,
    );
  }
  return parseMcpConfigFile(raw, filePath);
}

async function writeMcpConfigFile(
  runtime: McpConfigRuntime,
  file: McpConfigFile,
): Promise<void> {
  const filePath = configPath(runtime);
  try {
    replacePrivateStateFile({
      runtime,
      segments: ["mcp.json"],
      label: "MCP config",
      content: `${JSON.stringify(file, null, 2)}\n`,
    });
  } catch (error) {
    configError(
      `Error: cannot write MCP config ${filePath}: ${errorMessage(error)}`,
    );
  }
}

async function waitForConfigLock(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 25));
}

async function removeStaleLock(lockPath: string): Promise<boolean> {
  try {
    const lockStat = await stat(lockPath);
    if (Date.now() - lockStat.mtimeMs <= MCP_CONFIG_STALE_LOCK_MS) {
      return false;
    }
    await rm(lockPath, { force: true });
    return true;
  } catch (error) {
    /* v8 ignore start -- ENOENT requires another process to remove the lock between this process's open and stat calls. */
    if (hasNodeErrorCode(error, "ENOENT")) return true;
    /* v8 ignore stop */
    configError(
      `Error: cannot inspect MCP config lock ${lockPath}: ${errorMessage(error)}`,
    );
  }
}

async function acquireConfigLock(
  runtime: McpConfigRuntime,
): Promise<FileHandle> {
  const lockPath = configLockPath(runtime);
  const deadline = Date.now() + MCP_CONFIG_LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      mcpStateHome(runtime);
      return await open(lockPath, "wx", 0o600);
    } catch (error) {
      /* v8 ignore next 4 -- open faults other than contention require OS permission/device failure injection and are normalized for the CLI. */
      if (!hasNodeErrorCode(error, "EEXIST")) {
        configError(
          `Error: cannot lock MCP config ${lockPath}: ${errorMessage(error)}`,
        );
      }
      if (await removeStaleLock(lockPath)) continue;
      if (Date.now() >= deadline) {
        configError(`Error: MCP config is busy: ${lockPath}.`);
      }
      await waitForConfigLock();
    }
  }
}

async function withConfigLock<T>(
  runtime: McpConfigRuntime,
  action: () => Promise<T>,
): Promise<T> {
  mcpStateHome(runtime, true);
  const lockPath = configLockPath(runtime);
  const lockHandle = await acquireConfigLock(runtime);
  try {
    return await action();
  } finally {
    await lockHandle.close();
    await rm(lockPath, { force: true });
  }
}

export function validateMcpServerId(id: string): void {
  if (!MCP_SERVER_ID_PATTERN.test(id)) {
    configError(
      "Error: invalid MCP server id. Use 1-64 lowercase letters, numbers, dots, dashes, or underscores.",
    );
  }
}

export function deriveMcpServerId(url: URL): string {
  const hostname = url.hostname.toLowerCase();
  const firstLabel = hostname.replace(/\..*$/u, "");
  const derived = firstLabel.replace(/[^a-z0-9._-]+/gu, "-");
  if (MCP_SERVER_ID_PATTERN.test(derived)) return derived;
  configError(
    `Error: cannot derive an MCP server id from "${hostname}"; pass --name <id>.`,
  );
}

export async function listMcpServers(
  runtime: McpConfigRuntime,
): Promise<readonly McpServerConfig[]> {
  return (await readMcpConfigFile(runtime)).servers;
}

export async function listEnabledMcpServers(
  runtime: McpConfigRuntime,
): Promise<readonly McpServerConfig[]> {
  return (await readMcpConfigFile(runtime)).servers.filter(
    (server) => server.enabled,
  );
}

export function listMcpServersSync(
  runtime: McpConfigRuntime,
): readonly McpServerConfig[] {
  return readMcpConfigFileSync(runtime).servers;
}

export function listEnabledMcpServersSync(
  runtime: McpConfigRuntime,
): readonly McpServerConfig[] {
  return readMcpConfigFileSync(runtime).servers.filter(
    (server) => server.enabled,
  );
}

export async function findMcpServer(
  runtime: McpConfigRuntime,
  serverId: string,
): Promise<McpServerConfig> {
  validateMcpServerId(serverId);
  const server = (await readMcpConfigFile(runtime)).servers.find(
    (candidate) => candidate.id === serverId,
  );
  if (server === undefined) {
    configError(`Error: MCP server "${serverId}" is not configured.`);
  }
  return server;
}

function sameMcpServerIdentity(
  left: McpServerIdentity,
  right: McpServerIdentity,
): boolean {
  return (
    left.id === right.id &&
    left.incarnation === right.incarnation &&
    left.url === right.url &&
    left.allowPrivateNetwork === right.allowPrivateNetwork
  );
}

export async function isMcpServerCurrentAndEnabled(
  runtime: McpConfigRuntime,
  expected: McpServerIdentity,
): Promise<boolean> {
  return await withConfigLock(runtime, async () => {
    return mcpServerIsCurrentAndEnabled(
      (await readMcpConfigFile(runtime)).servers,
      expected,
    );
  });
}

function mcpServerIsCurrentAndEnabled(
  servers: readonly McpServerConfig[],
  expected: McpServerIdentity,
): boolean {
  const current = servers.find((candidate) => candidate.id === expected.id);
  return current?.enabled === true && sameMcpServerIdentity(current, expected);
}

export interface McpServerLifecycleMonitor {
  readonly signal: AbortSignal;
  readonly close: () => Promise<void>;
}

export function monitorMcpServerLifecycle(
  runtime: McpConfigRuntime,
  expected: McpServerIdentity,
  parentSignal: AbortSignal,
): McpServerLifecycleMonitor {
  const controller = new AbortController();
  const signal = AbortSignal.any([parentSignal, controller.signal]);
  const done = (async () => {
    try {
      while (!signal.aborted) {
        if (
          !mcpServerIsCurrentAndEnabled(
            (await readMcpConfigFile(runtime)).servers,
            expected,
          )
        ) {
          controller.abort(
            new McpConfigError(
              `Error: MCP server "${expected.id}" was disabled, removed, or changed.`,
            ),
          );
          return;
        }
        await delay(MCP_SERVER_LIFECYCLE_POLL_MS, undefined, { signal });
      }
    } catch (error) {
      if (signal.aborted) return;
      controller.abort(error);
    }
  })();
  return {
    signal,
    close: async () => {
      controller.abort();
      await done;
    },
  };
}

export async function addMcpServer(
  runtime: McpConfigRuntime,
  server: NewMcpServerConfig,
): Promise<McpServerConfig> {
  validateMcpServerId(server.id);
  return await withConfigLock(runtime, async () => {
    const file = await readMcpConfigFile(runtime);
    if (file.servers.length >= MCP_CONFIG_MAX_SERVERS) {
      configError(
        `Error: MCP config supports at most ${MCP_CONFIG_MAX_SERVERS} servers.`,
      );
    }
    if (file.servers.some((candidate) => candidate.id === server.id)) {
      configError(`Error: MCP server "${server.id}" is already configured.`);
    }
    if (file.servers.some((candidate) => candidate.url === server.url)) {
      configError("Error: MCP endpoint is already configured.");
    }
    const configured: McpServerConfig = {
      ...server,
      incarnation: randomUUID(),
    };
    await writeMcpConfigFile(runtime, {
      schemaVersion: MCP_CONFIG_SCHEMA_VERSION,
      servers: [...file.servers, configured].sort((left, right) =>
        left.id.localeCompare(right.id),
      ),
    });
    return configured;
  });
}

export async function setMcpServerAuthenticationRequired(
  runtime: McpConfigRuntime,
  expected: McpServerConfig,
  authenticationRequired: boolean,
): Promise<void> {
  validateMcpServerId(expected.id);
  await withConfigLock(runtime, async () => {
    const file = await readMcpConfigFile(runtime);
    const server = file.servers.find(
      (candidate) => candidate.id === expected.id,
    );
    if (server === undefined) {
      configError(`Error: MCP server "${expected.id}" is not configured.`);
    }
    if (!sameMcpServerIdentity(server, expected)) {
      configError(
        `Error: MCP server "${expected.id}" changed during the command; retry it.`,
      );
    }
    if (server.authenticationRequired === authenticationRequired) return;
    await writeMcpConfigFile(runtime, {
      ...file,
      servers: file.servers.map((candidate) =>
        candidate.id === expected.id
          ? { ...candidate, authenticationRequired }
          : candidate,
      ),
    });
  });
}

export async function setMcpServerEnabled(
  runtime: McpConfigRuntime,
  expected: McpServerConfig,
  enabled: boolean,
): Promise<boolean> {
  validateMcpServerId(expected.id);
  return await withConfigLock(runtime, async () => {
    const file = await readMcpConfigFile(runtime);
    const server = file.servers.find(
      (candidate) => candidate.id === expected.id,
    );
    if (server === undefined) {
      configError(`Error: MCP server "${expected.id}" is not configured.`);
    }
    if (!sameMcpServerIdentity(server, expected)) {
      configError(
        `Error: MCP server "${expected.id}" changed during the command; retry it.`,
      );
    }
    if (server.enabled === enabled) return false;
    await writeMcpConfigFile(runtime, {
      ...file,
      servers: file.servers.map((candidate) =>
        candidate.id === expected.id ? { ...candidate, enabled } : candidate,
      ),
    });
    return true;
  });
}

export async function removeMcpServer(
  runtime: McpConfigRuntime,
  expected: McpServerConfig,
  removeCredentials: (server: McpServerConfig) => Promise<void>,
): Promise<boolean> {
  validateMcpServerId(expected.id);
  const server = await withConfigLock(runtime, async () => {
    return (await readMcpConfigFile(runtime)).servers.find(
      (candidate) => candidate.id === expected.id,
    );
  });
  if (server === undefined) return false;
  if (!sameMcpServerIdentity(server, expected)) {
    configError(
      `Error: MCP server "${expected.id}" changed while it was being removed; retry the command.`,
    );
  }

  await removeCredentials(server);
  return await withConfigLock(runtime, async () => {
    const file = await readMcpConfigFile(runtime);
    const current = file.servers.find(
      (candidate) => candidate.id === expected.id,
    );
    if (current === undefined) return true;
    if (!sameMcpServerIdentity(current, server)) {
      configError(
        `Error: MCP server "${expected.id}" changed while it was being removed; retry the command.`,
      );
    }
    await writeMcpConfigFile(runtime, {
      ...file,
      servers: file.servers.filter((candidate) => candidate.id !== expected.id),
    });
    return true;
  });
}
