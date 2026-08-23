import { mkdtemp, readdir, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toNodeHandler } from "@modelcontextprotocol/node";
import {
  createMcpHandler,
  legacyStatelessFallback,
  McpServer,
} from "@modelcontextprotocol/server";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { runCliMain } from "../../../src/cli/index.ts";
import { runMcpCommand } from "../../../src/cli/mcp-command.ts";
import {
  connectMcpServer,
  discoverMcpServer,
} from "../../../src/mcp/discovery.ts";
import { mcpProviderSchemaTarget } from "../../../src/mcp/provider-schema.ts";
import { createRuntime } from "../../../src/testing/cli-runtime-fixtures.ts";
import { removeTemporaryDirectory } from "../../../src/testing/temporary-directory.ts";

interface TestMcpServer {
  readonly url: string;
  readonly close: () => Promise<void>;
}

interface CountingTestMcpServer extends TestMcpServer {
  readonly requestCount: () => number;
}

interface LifecyclePendingTestMcpServer extends TestMcpServer {
  readonly secondCatalogRequest: Promise<void>;
  readonly secondCatalogAborted: Promise<void>;
}

interface TestMcpFetchHandler {
  readonly fetch: (request: Request) => Promise<Response>;
  readonly close?: () => Promise<void>;
}

const jsonRpcRequestSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    id: z.union([z.string(), z.number()]).optional(),
    method: z.string(),
  })
  .passthrough();

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
  });
}

function nestedSchema(depth: number): unknown {
  let schema: unknown = { type: "string" };
  for (let level = 0; level < depth; level += 1) {
    schema = {
      type: "object",
      properties: { nested: schema },
    };
  }
  return schema;
}

function degenerateReferenceCycleSchema(referenceCount: number): unknown {
  const definitions: Record<string, { readonly $ref: string }> = {};
  for (let index = 0; index < referenceCount; index += 1) {
    definitions[`c${index}`] = {
      $ref: `#/$defs/c${(index + 1) % referenceCount}`,
    };
  }
  return {
    type: "object",
    properties: { value: { $ref: "#/$defs/c0" } },
    $defs: definitions,
  };
}

async function startMcpServer(
  handler: TestMcpFetchHandler,
): Promise<TestMcpServer> {
  const nodeHandler = toNodeHandler(handler);
  const server = createServer((request, response) => {
    void nodeHandler(
      {
        headers: request.headers,
        ...(request.method !== undefined ? { method: request.method } : {}),
        ...(request.url !== undefined ? { url: request.url } : {}),
        [Symbol.asyncIterator]: () => request[Symbol.asyncIterator](),
      },
      response,
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("MCP test server did not bind a TCP port");
  }

  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    close: async () => {
      await handler.close?.();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) {
            resolve();
            return;
          }
          reject(error);
        });
      });
    },
  };
}

function buildCatalogServer(): McpServer {
  const server = new McpServer(
    { name: "keel-test-server", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  server.registerTool(
    "search",
    {
      description: "Search the test catalog",
      inputSchema: z.object({ query: z.string() }),
    },
    async ({ query }) => ({
      content: [{ type: "text", text: `result for ${query}` }],
    }),
  );
  return server;
}

async function startModernMcpServer(): Promise<TestMcpServer> {
  const handler = createMcpHandler(() => {
    return buildCatalogServer();
  });
  return await startMcpServer(handler);
}

async function startCountingModernMcpServer(): Promise<CountingTestMcpServer> {
  let requests = 0;
  const handler = createMcpHandler(() => {
    return buildCatalogServer();
  });
  const server = await startMcpServer({
    fetch: async (request) => {
      requests += 1;
      return await handler.fetch(request);
    },
    close: handler.close,
  });
  return { ...server, requestCount: () => requests };
}

async function startLegacyMcpServer(): Promise<TestMcpServer> {
  const legacy = legacyStatelessFallback(() => buildCatalogServer());
  return await startMcpServer({ fetch: legacy });
}

async function startUnauthorizedMcpServer(): Promise<CountingTestMcpServer> {
  let requests = 0;
  const server = await startMcpServer({
    fetch: async () => {
      requests += 1;
      return new Response(null, {
        status: 401,
        headers: {
          "www-authenticate":
            'Bearer resource_metadata="https://auth.example/.well-known/oauth-protected-resource"',
        },
      });
    },
  });
  return { ...server, requestCount: () => requests };
}

async function startRejectedMcpServer(
  status: 403 | 503,
): Promise<CountingTestMcpServer> {
  let requests = 0;
  const server = await startMcpServer({
    fetch: async () => {
      requests += 1;
      return new Response(
        status === 403 ? "access denied" : "temporarily unavailable",
        { status },
      );
    },
  });
  return { ...server, requestCount: () => requests };
}

async function startInsufficientScopeMcpServer(
  requiredScope: string | null = "mcp:tools",
): Promise<CountingTestMcpServer> {
  let requests = 0;
  const server = await startMcpServer({
    fetch: async () => {
      requests += 1;
      const challenge =
        requiredScope === null
          ? 'Bearer error="insufficient_scope"'
          : `Bearer error="insufficient_scope", scope="${requiredScope}"`;
      return new Response("scope upgrade required", {
        status: 403,
        headers: {
          "www-authenticate": challenge,
        },
      });
    },
  });
  return { ...server, requestCount: () => requests };
}

async function startLegacyRawServer(
  listTools: (
    requestId: string | number | undefined,
    requestNumber: number,
  ) => Response,
): Promise<TestMcpServer> {
  let listRequests = 0;
  return await startMcpServer({
    fetch: async (request) => {
      const parsed = jsonRpcRequestSchema.parse(await request.json());
      if (parsed.method === "server/discover") {
        return jsonResponse({
          jsonrpc: "2.0",
          id: parsed.id,
          error: { code: -32601, message: "Method not found" },
        });
      }
      if (parsed.method === "initialize") {
        return jsonResponse({
          jsonrpc: "2.0",
          id: parsed.id,
          result: {
            protocolVersion: "2025-11-25",
            capabilities: { tools: {} },
            serverInfo: { name: "raw-catalog", version: "1.0.0" },
          },
        });
      }
      if (parsed.method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }
      if (parsed.method === "tools/list") {
        listRequests += 1;
        return listTools(parsed.id, listRequests);
      }
      return jsonResponse({
        jsonrpc: "2.0",
        id: parsed.id,
        error: { code: -32601, message: "Method not found" },
      });
    },
  });
}

async function startLegacyRawCatalogServer(
  tools: readonly unknown[],
  nextCursor?: string,
): Promise<TestMcpServer> {
  return await startLegacyRawServer((requestId) =>
    jsonResponse({
      jsonrpc: "2.0",
      id: requestId,
      result: {
        tools,
        ...(nextCursor !== undefined ? { nextCursor } : {}),
      },
    }),
  );
}

async function startAnonymousModernMcpServer(): Promise<TestMcpServer> {
  return await startMcpServer({
    fetch: async (request) => {
      const parsed = jsonRpcRequestSchema.parse(await request.json());
      if (parsed.method === "server/discover") {
        return jsonResponse({
          jsonrpc: "2.0",
          id: parsed.id,
          result: {
            supportedVersions: ["2026-07-28"],
            capabilities: {},
            ttlMs: 0,
            cacheScope: "private",
          },
        });
      }
      return jsonResponse({
        jsonrpc: "2.0",
        id: parsed.id,
        error: { code: -32601, message: "Method not found" },
      });
    },
  });
}

async function startModernRawCatalogServer(
  tools: readonly unknown[],
): Promise<TestMcpServer> {
  return await startMcpServer({
    fetch: async (request) => {
      const parsed = jsonRpcRequestSchema.parse(await request.json());
      if (parsed.method === "server/discover") {
        return jsonResponse({
          jsonrpc: "2.0",
          id: parsed.id,
          result: {
            supportedVersions: ["2026-07-28"],
            capabilities: { tools: {} },
            ttlMs: 0,
            cacheScope: "private",
          },
        });
      }
      if (parsed.method === "tools/list") {
        return jsonResponse({
          jsonrpc: "2.0",
          id: parsed.id,
          result: {
            resultType: "complete",
            ttlMs: 0,
            cacheScope: "private",
            tools,
          },
        });
      }
      return jsonResponse({
        jsonrpc: "2.0",
        id: parsed.id,
        error: { code: -32601, message: "Method not found" },
      });
    },
  });
}

async function startLifecyclePendingMcpServer(): Promise<LifecyclePendingTestMcpServer> {
  let catalogRequests = 0;
  const secondCatalogRequest = Promise.withResolvers<void>();
  const secondCatalogAborted = Promise.withResolvers<void>();
  const server = await startMcpServer({
    fetch: async (request) => {
      const parsed = jsonRpcRequestSchema.parse(await request.json());
      if (parsed.method === "server/discover") {
        return jsonResponse({
          jsonrpc: "2.0",
          id: parsed.id,
          result: {
            supportedVersions: ["2026-07-28"],
            capabilities: { tools: {} },
            ttlMs: 0,
            cacheScope: "private",
          },
        });
      }
      if (parsed.method === "tools/list") {
        catalogRequests += 1;
        if (catalogRequests === 1) {
          return jsonResponse({
            jsonrpc: "2.0",
            id: parsed.id,
            result: {
              resultType: "complete",
              ttlMs: 0,
              cacheScope: "private",
              tools: [],
            },
          });
        }
        secondCatalogRequest.resolve();
        await new Promise<void>((resolve) => {
          if (request.signal.aborted) {
            resolve();
            return;
          }
          request.signal.addEventListener("abort", () => resolve(), {
            once: true,
          });
        });
        secondCatalogAborted.resolve();
        return new Response(null, { status: 499 });
      }
      return jsonResponse({
        jsonrpc: "2.0",
        id: parsed.id,
        error: { code: -32601, message: "Method not found" },
      });
    },
  });
  return {
    ...server,
    secondCatalogRequest: secondCatalogRequest.promise,
    secondCatalogAborted: secondCatalogAborted.promise,
  };
}

async function startLateUnauthorizedMcpServer(): Promise<TestMcpServer> {
  return await startLegacyRawServer(
    () =>
      new Response(null, {
        status: 401,
        headers: {
          "www-authenticate":
            'Bearer resource_metadata="https://auth.example/.well-known/oauth-protected-resource"',
        },
      }),
  );
}

async function startUnboundedPaginationServer(): Promise<TestMcpServer> {
  return await startLegacyRawServer((requestId, requestNumber) =>
    jsonResponse({
      jsonrpc: "2.0",
      id: requestId,
      result: {
        tools: [],
        nextCursor: `cursor-${requestNumber}`,
      },
    }),
  );
}

async function startByteLimitPaginationServer(
  tools: readonly unknown[],
): Promise<TestMcpServer> {
  const pageSize = 16;
  return await startLegacyRawServer((requestId, requestNumber) => {
    const start = (requestNumber - 1) * pageSize;
    const page = tools.slice(start, start + pageSize);
    const hasNext = start + page.length < tools.length;
    return jsonResponse({
      jsonrpc: "2.0",
      id: requestId,
      result: {
        tools: page,
        ...(hasNext ? { nextCursor: `cursor-${requestNumber}` } : {}),
      },
    });
  });
}

async function startCatalogErrorServer(
  message: string,
): Promise<TestMcpServer> {
  return await startLegacyRawServer(
    () =>
      new Response(message, {
        status: 500,
        headers: { "content-type": "text/plain" },
      }),
  );
}

describe("CLI Main - MCP", () => {
  test(`Given an unexpected implementation fault escapes an MCP operation,
    When the command boundary handles it,
    Then it preserves the original typed error for the outer CLI boundary`, async () => {
    // Given
    const failure = new Error("unexpected MCP implementation fault");
    const fixture = createRuntime([]);
    const runtime = {
      ...fixture.runtime,
      env: () => {
        throw failure;
      },
    };

    // When / Then
    await expect(
      runMcpCommand({ command: "mcp", mode: "list" }, runtime),
    ).rejects.toBe(failure);
  });

  test(`Given no MCP servers are configured,
    When the user lists, checks status, or runs doctor,
    Then every read-only command reports the empty state successfully`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-mcp-empty-home-"));

    try {
      for (const args of [
        ["mcp", "list"],
        ["mcp", "status"],
        ["mcp", "doctor"],
      ]) {
        // When
        const command = createRuntime(args, {
          env: { KEEL_HOME: home },
        });
        const exitCode = await runCliMain(command.runtime);

        // Then
        expect(exitCode).toBe(0);
        expect(command.stdout()).toBe("No MCP servers configured.\n");
        expect(command.stderr()).toBe("");
      }
    } finally {
      await removeTemporaryDirectory(home);
    }
  });

  test(`Given a reachable Streamable HTTP MCP server,
    When the user adds it and checks its status and diagnostics,
    Then Keel persists it and every command shows bounded modern discovery`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-mcp-home-"));
    const server = await startModernMcpServer();
    const add = createRuntime(
      [
        "mcp",
        "add",
        server.url,
        "--name",
        "catalog",
        "--allow-tool",
        "search",
        "--deny-tool",
        "delete",
      ],
      {
        env: { KEEL_HOME: home },
      },
    );

    try {
      // When
      const addExitCode = await runCliMain(add.runtime);
      const status = createRuntime(["mcp", "status", "catalog"], {
        env: { KEEL_HOME: home },
      });
      const statusExitCode = await runCliMain(status.runtime);
      const doctor = createRuntime(["mcp", "doctor", "catalog"], {
        env: { KEEL_HOME: home },
      });
      const doctorExitCode = await runCliMain(doctor.runtime);
      const list = createRuntime(["mcp", "list"], {
        env: { KEEL_HOME: home },
      });
      const listExitCode = await runCliMain(list.runtime);

      // Then
      expect(addExitCode).toBe(0);
      expect(add.stderr()).toBe("");
      expect(add.stdout()).toContain('Added MCP server "catalog".\n');
      expect(statusExitCode).toBe(0);
      expect(status.stderr()).toBe("");
      expect(status.stdout()).toContain("MCP server: catalog\n");
      expect(status.stdout()).toContain(
        `origin: ${new URL(server.url).origin}\n`,
      );
      expect(status.stdout()).toContain(`endpoint: ${server.url}\n`);
      expect(status.stdout()).toContain("status: ready\n");
      expect(status.stdout()).toContain("protocol: modern (2026-07-28)\n");
      expect(doctorExitCode).toBe(0);
      expect(doctor.stderr()).toBe("");
      expect(doctor.stdout()).toContain("status: ready\n");
      expect(doctor.stdout()).toContain("protocol: modern (2026-07-28)\n");
      expect(status.stdout()).toContain(
        "tools: 1 catalog-valid, 0 catalog-quarantined, 1 total\n",
      );
      expect(status.stdout()).toContain(
        "provider: deepseek/deepseek-v4-flash\n",
      );
      expect(status.stdout()).toContain(
        "provider tools: 1 usable, 0 quarantined, 0 validation-widened\n",
      );
      expect(status.stdout()).toMatch(/catalog: sha256:[a-f0-9]{64}\n/u);
      expect(status.stdout()).not.toContain("Search the test catalog");
      expect(listExitCode).toBe(0);
      expect(list.stdout()).toContain(
        "allow tools: search; deny tools: delete",
      );
      if (process.platform !== "win32") {
        expect((await stat(join(home, "mcp.json"))).mode & 0o777).toBe(0o600);
        expect((await stat(home)).mode & 0o777).toBe(0o700);
      }
    } finally {
      await server.close();
      await removeTemporaryDirectory(home);
    }
  });

  test(`Given an enabled MCP server,
    When the user disables, enables, and removes it,
    Then lifecycle commands are idempotent and disabled or removed servers never connect`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-mcp-lifecycle-home-"));
    const server = await startCountingModernMcpServer();
    const add = createRuntime(["mcp", "add", server.url, "--name", "catalog"], {
      env: { KEEL_HOME: home },
    });

    try {
      expect(await runCliMain(add.runtime)).toBe(0);
      const requestsAfterAdd = server.requestCount();

      // When
      const disable = createRuntime(["mcp", "disable", "catalog"], {
        env: { KEEL_HOME: home },
      });
      const disableAgain = createRuntime(["mcp", "disable", "catalog"], {
        env: { KEEL_HOME: home },
      });
      const disabledStatus = createRuntime(["mcp", "status", "catalog"], {
        env: { KEEL_HOME: home },
      });
      const disabledList = createRuntime(["mcp", "list"], {
        env: { KEEL_HOME: home },
      });
      const enable = createRuntime(["mcp", "enable", "catalog"], {
        env: { KEEL_HOME: home },
      });
      const enableAgain = createRuntime(["mcp", "enable", "catalog"], {
        env: { KEEL_HOME: home },
      });
      const enabledStatus = createRuntime(["mcp", "status", "catalog"], {
        env: { KEEL_HOME: home },
      });
      const remove = createRuntime(["mcp", "remove", "catalog"], {
        env: { KEEL_HOME: home },
      });
      const removeAgain = createRuntime(["mcp", "remove", "catalog"], {
        env: { KEEL_HOME: home },
      });
      const removedList = createRuntime(["mcp", "list"], {
        env: { KEEL_HOME: home },
      });

      // Then
      expect(await runCliMain(disable.runtime)).toBe(0);
      expect(disable.stdout()).toBe('Disabled MCP server "catalog".\n');
      expect(await runCliMain(disableAgain.runtime)).toBe(0);
      expect(disableAgain.stdout()).toBe(
        'MCP server "catalog" is already disabled.\n',
      );
      expect(await runCliMain(disabledStatus.runtime)).toBe(0);
      expect(disabledStatus.stdout()).toContain("enabled: false\n");
      expect(disabledStatus.stdout()).toContain("status: disabled\n");
      expect(await runCliMain(disabledList.runtime)).toBe(0);
      expect(disabledList.stdout()).toContain(
        `catalog: ${server.url} (disabled)\n`,
      );
      expect(server.requestCount()).toBe(requestsAfterAdd);

      expect(await runCliMain(enable.runtime)).toBe(0);
      expect(enable.stdout()).toBe('Enabled MCP server "catalog".\n');
      expect(await runCliMain(enableAgain.runtime)).toBe(0);
      expect(enableAgain.stdout()).toBe(
        'MCP server "catalog" is already enabled.\n',
      );
      expect(await runCliMain(enabledStatus.runtime)).toBe(0);
      expect(enabledStatus.stdout()).toContain("enabled: true\n");
      expect(enabledStatus.stdout()).toContain("status: ready\n");
      expect(server.requestCount()).toBeGreaterThan(requestsAfterAdd);
      const requestsAfterEnabledStatus = server.requestCount();

      expect(await runCliMain(remove.runtime)).toBe(0);
      expect(remove.stdout()).toBe('Removed MCP server "catalog".\n');
      expect(await runCliMain(removeAgain.runtime)).toBe(0);
      expect(removeAgain.stdout()).toBe(
        'MCP server "catalog" is already removed.\n',
      );
      expect(await runCliMain(removedList.runtime)).toBe(0);
      expect(removedList.stdout()).toBe("No MCP servers configured.\n");
      expect(server.requestCount()).toBe(requestsAfterEnabledStatus);
      expect(disable.stderr()).toBe("");
      expect(disableAgain.stderr()).toBe("");
      expect(disabledStatus.stderr()).toBe("");
      expect(disabledList.stderr()).toBe("");
      expect(enable.stderr()).toBe("");
      expect(enableAgain.stderr()).toBe("");
      expect(enabledStatus.stderr()).toBe("");
      expect(remove.stderr()).toBe("");
      expect(removeAgain.stderr()).toBe("");
      expect(removedList.stderr()).toBe("");
    } finally {
      await server.close();
      await removeTemporaryDirectory(home);
    }
  });

  test(`Given status is waiting for an MCP catalog,
    When the configured server is disabled concurrently,
    Then the lifecycle change aborts discovery before returning its final status`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-mcp-status-race-"));
    const server = await startLifecyclePendingMcpServer();
    const add = createRuntime(["mcp", "add", server.url, "--name", "catalog"], {
      env: { KEEL_HOME: home },
    });

    try {
      expect(await runCliMain(add.runtime)).toBe(0);
      const status = createRuntime(["mcp", "status", "catalog"], {
        env: { KEEL_HOME: home },
      });
      const statusRun = runCliMain(status.runtime);
      await server.secondCatalogRequest;
      const disable = createRuntime(["mcp", "disable", "catalog"], {
        env: { KEEL_HOME: home },
      });

      // When
      expect(await runCliMain(disable.runtime)).toBe(0);
      const exitCode = await statusRun;

      // Then
      expect(exitCode).toBe(0);
      await expect(server.secondCatalogAborted).resolves.toBeUndefined();
      expect(status.stdout()).toContain("status: failed\n");
      expect(status.stdout()).toContain("disabled, removed, or changed");
      expect(disable.stdout()).toBe('Disabled MCP server "catalog".\n');
      expect(status.stderr()).toBe("");
      expect(disable.stderr()).toBe("");
    } finally {
      await server.close();
      await removeTemporaryDirectory(home);
    }
  });

  test(`Given an unauthenticated MCP server is reachable while the OS credential store is unavailable,
    When the user adds the public server,
    Then optional token lookup does not regress anonymous MCP use`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-mcp-public-no-keyring-"));
    const server = await startModernMcpServer();
    const unavailable = {
      getPassword: async () => {
        throw new Error("credential service unavailable");
      },
      setPassword: async () => {
        throw new Error("credential service unavailable");
      },
      deletePassword: async () => {
        throw new Error("credential service unavailable");
      },
    };
    const add = createRuntime(["mcp", "add", server.url, "--name", "public"], {
      env: { KEEL_HOME: home },
      mcpSecretBackend: unavailable,
    });

    try {
      // When
      const exitCode = await runCliMain(add.runtime);

      // Then
      expect(exitCode).toBe(0);
      expect(add.stderr()).toBe("");
      expect(add.stdout()).toContain("status: ready\n");
    } finally {
      await server.close();
      await removeTemporaryDirectory(home);
    }
  });

  test(`Given a 2025-era Streamable HTTP MCP server,
    When the user adds it,
    Then Keel falls back from discovery and reports the negotiated legacy era`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-mcp-legacy-home-"));
    const server = await startLegacyMcpServer();
    const add = createRuntime(["mcp", "add", server.url, "--name", "legacy"], {
      env: { KEEL_HOME: home },
    });

    try {
      // When
      const exitCode = await runCliMain(add.runtime);

      // Then
      expect(exitCode).toBe(0);
      expect(add.stderr()).toBe("");
      expect(add.stdout()).toContain("status: ready\n");
      expect(add.stdout()).toContain("protocol: legacy (2025-11-25)\n");
      expect(add.stdout()).toContain(
        "tools: 1 catalog-valid, 0 catalog-quarantined, 1 total\n",
      );
    } finally {
      await server.close();
      await removeTemporaryDirectory(home);
    }
  });

  test(`Given a modern server omits its optional identity and tools capability,
    When the user adds it without an explicit name,
    Then Keel derives the id and reports an anonymous empty catalog`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-mcp-anonymous-home-"));
    const server = await startAnonymousModernMcpServer();
    const add = createRuntime(
      ["mcp", "add", server.url, "--allow-private-network"],
      {
        env: { KEEL_HOME: home },
      },
    );

    try {
      // When
      const exitCode = await runCliMain(add.runtime);
      const list = createRuntime(["mcp", "list"], {
        env: { KEEL_HOME: home },
      });
      const listExitCode = await runCliMain(list.runtime);
      const direct = await discoverMcpServer({
        server: {
          url: server.url,
          allowPrivateNetwork: true,
          authenticationRequired: false,
        },
        now: () => Date.now(),
        authProvider: null,
        schemaTarget: mcpProviderSchemaTarget("deepseek", "deepseek-v4-flash"),
        signal: new AbortController().signal,
      });

      // Then
      expect(exitCode).toBe(0);
      expect(listExitCode).toBe(0);
      expect(direct.status).toBe("ready");
      expect(add.stderr()).toBe("");
      expect(add.stdout()).toContain('Added MCP server "127".\n');
      expect(add.stdout()).toContain("server identity: anonymous\n");
      expect(add.stdout()).toContain(
        "tools: 0 catalog-valid, 0 catalog-quarantined, 0 total\n",
      );
      expect(list.stdout()).toContain(
        `127: ${server.url} (private network allowed)\n`,
      );
    } finally {
      await server.close();
      await removeTemporaryDirectory(home);
    }
  });

  test(`Given a remote MCP server requires authorization,
    When the user adds it before logging in,
    Then Keel preserves the server and reports needs-auth without protocol fallback`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-mcp-auth-home-"));
    const server = await startUnauthorizedMcpServer();
    const add = createRuntime(
      ["mcp", "add", server.url, "--name", "protected"],
      { env: { KEEL_HOME: home } },
    );

    try {
      // When
      const exitCode = await runCliMain(add.runtime);

      // Then
      expect(exitCode, add.stdout()).toBe(0);
      expect(add.stderr()).toBe("");
      expect(add.stdout()).toContain("status: needs-auth\n");
      expect(add.stdout()).toContain("authorization: required\n");
      expect(add.stdout()).not.toContain("protocol: legacy");
      expect(server.requestCount()).toBe(1);
      expect((await readdir(home)).sort()).toEqual(["mcp.json"]);
    } finally {
      await server.close();
      await removeTemporaryDirectory(home);
    }
  });

  test(`Given a modern MCP server is temporarily unavailable,
    When the user adds it,
    Then Keel reports the server failure without falling back to the legacy protocol`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-mcp-unavailable-home-"));
    const server = await startRejectedMcpServer(503);
    const add = createRuntime(
      ["mcp", "add", server.url, "--name", "unavailable"],
      { env: { KEEL_HOME: home } },
    );

    try {
      // When
      const exitCode = await runCliMain(add.runtime);

      // Then
      expect(exitCode).toBe(1);
      expect(add.stderr()).toBe("");
      expect(add.stdout()).toContain("status: failed\n");
      expect(add.stdout()).toContain("HTTP 503");
      expect(add.stdout()).not.toContain("protocol: legacy");
      expect(server.requestCount()).toBe(1);
    } finally {
      await server.close();
      await removeTemporaryDirectory(home);
    }
  });

  test(`Given a modern MCP server denies access,
    When the user adds it,
    Then Keel reports the typed authorization denial without falling back to the legacy protocol`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-mcp-forbidden-home-"));
    const server = await startRejectedMcpServer(403);
    const add = createRuntime(
      ["mcp", "add", server.url, "--name", "forbidden"],
      { env: { KEEL_HOME: home } },
    );

    try {
      // When
      const exitCode = await runCliMain(add.runtime);

      // Then
      expect(exitCode).toBe(1);
      expect(add.stderr()).toBe("");
      expect(add.stdout()).toContain("status: failed\n");
      expect(add.stdout()).toContain("HTTP 403");
      expect(add.stdout()).not.toContain("protocol: legacy");
      expect(server.requestCount()).toBe(1);
    } finally {
      await server.close();
      await removeTemporaryDirectory(home);
    }
  });

  test(`Given a modern MCP server requires broader authorization scope,
    When the user adds it,
    Then Keel reports the required scope without falling back to the legacy protocol`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-mcp-scope-home-"));
    const server = await startInsufficientScopeMcpServer();
    const add = createRuntime(
      ["mcp", "add", server.url, "--name", "scope-required"],
      { env: { KEEL_HOME: home } },
    );

    try {
      // When
      const exitCode = await runCliMain(add.runtime);

      // Then
      expect(exitCode).toBe(1);
      expect(add.stderr()).toBe("");
      expect(add.stdout()).toContain("status: failed\n");
      expect(add.stdout()).toContain("authorization: insufficient-scope\n");
      expect(add.stdout()).toContain("required scope: mcp:tools\n");
      expect(add.stdout()).not.toContain("protocol: legacy");
      expect(server.requestCount()).toBe(1);
    } finally {
      await server.close();
      await removeTemporaryDirectory(home);
    }
  });

  test(`Given a configured MCP server requires broader authorization scope,
    When the user checks MCP status and doctor,
    Then Keel reports an actionable step-up authorization diagnostic`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-mcp-status-scope-home-"));
    const server = await startInsufficientScopeMcpServer();
    const add = createRuntime(
      ["mcp", "add", server.url, "--name", "scope-required"],
      { env: { KEEL_HOME: home } },
    );

    try {
      expect(await runCliMain(add.runtime), add.stdout()).toBe(1);
      const status = createRuntime(["mcp", "status", "scope-required"], {
        env: { KEEL_HOME: home },
      });
      const doctor = createRuntime(["mcp", "doctor", "scope-required"], {
        env: { KEEL_HOME: home },
      });

      // When
      const statusExitCode = await runCliMain(status.runtime);
      const doctorExitCode = await runCliMain(doctor.runtime);

      // Then
      expect(statusExitCode).toBe(0);
      expect(doctorExitCode).toBe(1);
      expect(status.stderr()).toBe("");
      expect(doctor.stderr()).toBe("");
      for (const output of [status.stdout(), doctor.stdout()]) {
        expect(output).toContain("status: failed\n");
        expect(output).toContain("authorization: insufficient-scope\n");
        expect(output).toContain("required scope: mcp:tools\n");
        expect(output).toContain(
          'action: run keel mcp login "scope-required" to authorize with the required scope',
        );
        expect(output).not.toContain("HTTP 403");
        expect(output).not.toContain("catalog failure");
      }
      expect(server.requestCount()).toBe(3);
    } finally {
      await server.close();
      await removeTemporaryDirectory(home);
    }
  });

  test(`Given a configured MCP server omits the required scope hint,
    When the user checks MCP status,
    Then Keel reports step-up authorization without inventing a scope`, async () => {
    // Given
    const home = await mkdtemp(
      join(tmpdir(), "keel-mcp-status-scope-unknown-home-"),
    );
    const server = await startInsufficientScopeMcpServer(null);
    const add = createRuntime(
      ["mcp", "add", server.url, "--name", "scope-unknown"],
      { env: { KEEL_HOME: home } },
    );

    try {
      expect(await runCliMain(add.runtime), add.stdout()).toBe(1);
      const status = createRuntime(["mcp", "status", "scope-unknown"], {
        env: { KEEL_HOME: home },
      });

      // When
      const statusExitCode = await runCliMain(status.runtime);

      // Then
      expect(statusExitCode).toBe(0);
      expect(status.stderr()).toBe("");
      expect(status.stdout()).toContain("authorization: insufficient-scope\n");
      expect(status.stdout()).toContain("required scope: unknown\n");
      expect(status.stdout()).not.toContain("mcp:tools");
      expect(server.requestCount()).toBe(2);
    } finally {
      await server.close();
      await removeTemporaryDirectory(home);
    }
  });

  test(`Given authorization becomes required during tools/list,
    When discovery has already initialized the server,
    Then Keel reports needs-auth instead of a protocol or catalog failure`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-mcp-late-auth-home-"));
    const server = await startLateUnauthorizedMcpServer();
    const add = createRuntime(
      ["mcp", "add", server.url, "--name", "late-protected"],
      { env: { KEEL_HOME: home } },
    );

    try {
      // When
      const exitCode = await runCliMain(add.runtime);

      // Then
      expect(exitCode).toBe(0);
      expect(add.stderr()).toBe("");
      expect(add.stdout()).toContain("status: needs-auth\n");
      expect(add.stdout()).toContain("authorization: required\n");
      expect(add.stdout()).not.toContain("status: failed");
    } finally {
      await server.close();
      await removeTemporaryDirectory(home);
    }
  });

  test(`Given an MCP server publishes a tool schema with a local definition reference,
    When the user runs MCP doctor,
    Then Keel reports the referenced tool as provider-usable`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-mcp-local-ref-home-"));
    const server = await startModernRawCatalogServer([
      {
        name: "create_issue",
        description: "Create an issue",
        inputSchema: {
          type: "object",
          properties: {
            issue: { $ref: "#/$defs/Issue" },
          },
          required: ["issue"],
          $defs: {
            Issue: {
              type: "object",
              properties: {
                title: { type: "string" },
                labels: {
                  type: "array",
                  items: { type: "string" },
                },
              },
              required: ["title"],
              additionalProperties: false,
            },
          },
          additionalProperties: false,
        },
      },
    ]);
    const add = createRuntime(["mcp", "add", server.url, "--name", "github"], {
      env: { KEEL_HOME: home },
    });

    try {
      expect(await runCliMain(add.runtime), add.stdout()).toBe(0);

      // When
      const doctor = createRuntime(["mcp", "doctor", "github"], {
        env: { KEEL_HOME: home },
      });
      const exitCode = await runCliMain(doctor.runtime);

      // Then
      expect(exitCode, doctor.stdout()).toBe(0);
      expect(doctor.stderr()).toBe("");
      expect(doctor.stdout()).toContain(
        "provider tools: 1 usable, 0 quarantined, 0 validation-widened\n",
      );
      expect(doctor.stdout()).not.toContain("provider-quarantined tools:");
    } finally {
      await server.close();
      await removeTemporaryDirectory(home);
    }
  });

  test(`Given an MCP server publishes short and oversized local reference loops beside a valid tool,
    When the user runs MCP doctor,
    Then Keel isolates both bad tools with complete bounded diagnostics`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-mcp-ref-cycle-home-"));
    const server = await startModernRawCatalogServer([
      {
        name: "qa_tool",
        inputSchema: {
          type: "object",
          properties: { issue: { $ref: "#/$defs/A" } },
          $defs: {
            A: { $ref: "#/$defs/B" },
            B: { $ref: "#/$defs/A" },
          },
        },
      },
      {
        name: "healthy_tool",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
        },
      },
      {
        name: "oversized_cycle",
        inputSchema: degenerateReferenceCycleSchema(1_000),
      },
    ]);
    const add = createRuntime(["mcp", "add", server.url, "--name", "cycles"], {
      env: { KEEL_HOME: home },
    });

    try {
      expect(await runCliMain(add.runtime), add.stdout()).toBe(0);

      // When
      const doctor = createRuntime(["mcp", "doctor", "cycles"], {
        env: { KEEL_HOME: home },
      });
      const exitCode = await runCliMain(doctor.runtime);

      // Then
      expect(exitCode, doctor.stdout()).toBe(1);
      expect(doctor.stderr()).toBe("");
      expect(doctor.stdout()).toContain(
        "tools: 1 catalog-valid, 2 catalog-quarantined, 3 total\n",
      );
      expect(doctor.stdout()).toContain(
        '- qa_tool: invalid JSON Schema: local $ref chain forms a cycle through "#/$defs/A" after 2 unique references at inputSchema.properties.issue.$ref\n',
      );
      expect(doctor.stdout()).toContain(
        "- oversized_cycle: invalid JSON Schema: Maximum call stack size exceeded\n",
      );
      expect(doctor.stdout()).not.toContain(
        "- oversized_cycle: invalid JSON Schema: inputSchema.properties.value.$ref",
      );
      expect(doctor.stdout()).toContain(
        "provider tools: 1 usable, 0 quarantined, 0 validation-widened\n",
      );
    } finally {
      await server.close();
      await removeTemporaryDirectory(home);
    }
  });

  test(`Given one discovered tool has an invalid descriptor,
    When the user runs MCP doctor,
    Then Keel keeps the valid tool and diagnoses only the quarantined tool`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-mcp-schema-home-"));
    const invalidName = "x".repeat(129);
    const invalidTools = [
      {
        name: "search",
        description: "Search safely",
        inputSchema: {
          type: "object",
          properties: { query: { $ref: "#/$defs/query" } },
          $defs: { query: { type: "string" } },
        },
        outputSchema: {
          type: "object",
          properties: { result: { type: "string" } },
        },
      },
      {
        name: "report",
        inputSchema: { type: "object" },
      },
      {
        name: invalidName,
        inputSchema: { type: "object" },
      },
      {
        name: "malformed",
        inputSchema: {
          type: "object",
          required: "query",
        },
      },
      {
        name: "wrong-root-type",
        inputSchema: { type: "array" },
      },
      "not-an-object",
      {
        name: "\n".repeat(129),
        inputSchema: { type: "object" },
      },
      {
        name: "oversized",
        description: "d".repeat(65 * 1024),
        inputSchema: { type: "object" },
      },
      {
        name: "invalid-output",
        inputSchema: { type: "object" },
        outputSchema: { type: "array" },
      },
      {
        name: "too-deep",
        inputSchema: nestedSchema(40),
      },
      {
        name: "invalid-pattern",
        inputSchema: {
          type: "object",
          properties: {
            value: {
              type: "string",
              pattern: "[",
            },
          },
        },
      },
      ...Array.from({ length: 3 }, (_, index) => ({
        name: `${index}-${"z".repeat(129)}`,
        inputSchema: { type: "object" },
      })),
    ];
    const server = await startLegacyRawCatalogServer(invalidTools);
    const add = createRuntime(["mcp", "add", server.url, "--name", "mixed"], {
      env: { KEEL_HOME: home },
    });

    try {
      await runCliMain(add.runtime);

      // When
      const doctor = createRuntime(["mcp", "doctor", "mixed"], {
        env: { KEEL_HOME: home },
      });
      const exitCode = await runCliMain(doctor.runtime);

      // Then
      expect(exitCode).toBe(1);
      expect(doctor.stderr()).toBe("");
      expect(doctor.stdout()).toContain(
        "tools: 2 catalog-valid, 12 catalog-quarantined, 14 total\n",
      );
      expect(doctor.stdout()).toContain(
        "provider tools: 2 usable, 0 quarantined, 0 validation-widened\n",
      );
      expect(doctor.stdout()).toContain("quarantined tools:\n");
      expect(doctor.stdout()).not.toContain("provider-quarantined tools:\n");
      expect(doctor.stdout()).toContain(`- ${invalidName}: `);
      expect(doctor.stdout()).toContain("- malformed: ");
      expect(doctor.stdout()).not.toContain("Search safely");
      expect(
        doctor
          .stdout()
          .split("\n")
          .filter((line) => line.startsWith("- ")),
      ).toHaveLength(10);
    } finally {
      await server.close();
      await removeTemporaryDirectory(home);
    }
  });

  test(`Given a remote MCP server publishes draft-07 tool schemas,
    When the user runs MCP doctor,
    Then Keel reports the tools as usable`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-mcp-draft-07-home-"));
    const server = await startLegacyRawCatalogServer([
      {
        name: "search_issues",
        description: "Search Linear issues",
        inputSchema: {
          $schema: "http://json-schema.org/draft-07/schema",
          type: "object",
          properties: {
            query: { type: "string", minLength: 1 },
          },
          required: ["query"],
          additionalProperties: false,
        },
      },
    ]);
    const add = createRuntime(["mcp", "add", server.url, "--name", "linear"], {
      env: { KEEL_HOME: home },
    });

    try {
      expect(await runCliMain(add.runtime), add.stdout()).toBe(0);

      // When
      const doctor = createRuntime(["mcp", "doctor", "linear"], {
        env: { KEEL_HOME: home },
      });
      const exitCode = await runCliMain(doctor.runtime);

      // Then
      expect(exitCode, doctor.stdout()).toBe(0);
      expect(doctor.stderr()).toBe("");
      expect(doctor.stdout()).toContain(
        "tools: 1 catalog-valid, 0 catalog-quarantined, 1 total\n",
      );
      expect(doctor.stdout()).toContain(
        "provider tools: 1 usable, 0 quarantined, 1 validation-widened\n",
      );
      expect(doctor.stdout()).not.toContain("quarantined tools:");
      expect(doctor.stdout()).toContain("validation-widened tools:\n");
      expect(doctor.stdout()).toContain(
        "- search_issues: omitted inputSchema.properties.query.minLength",
      );
    } finally {
      await server.close();
      await removeTemporaryDirectory(home);
    }
  });

  test(`Given modern HTTP tools contain valid and invalid x-mcp-header declarations,
    When the user runs MCP doctor,
    Then Keel keeps valid header tools and quarantines every unsafe declaration`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-mcp-header-home-"));
    const tool = (
      name: string,
      inputSchema: Record<string, unknown>,
    ): Record<string, unknown> => ({ name, inputSchema });
    const server = await startModernRawCatalogServer([
      {
        ...tool("plain", {
          type: "object",
          properties: { unconstrained: true },
          allOf: [{ type: "object" }],
        }),
        outputSchema: {
          type: "array",
          items: { type: "string" },
        },
      },
      tool("valid-header", {
        type: "object",
        properties: {
          tenant: {
            type: "string",
            "x-mcp-header": "X-Tenant",
          },
        },
      }),
      tool("root-header", {
        type: "object",
        "x-mcp-header": "X-Root",
      }),
      tool("items-header", {
        type: "object",
        properties: {
          values: {
            type: "array",
            items: {
              type: "string",
              "x-mcp-header": "X-Item",
            },
          },
        },
      }),
      tool("numeric-header", {
        type: "object",
        properties: {
          tenant: {
            type: "string",
            "x-mcp-header": 42,
          },
        },
      }),
      tool("empty-header", {
        type: "object",
        properties: {
          tenant: {
            type: "string",
            "x-mcp-header": "",
          },
        },
      }),
      tool("invalid-token", {
        type: "object",
        properties: {
          tenant: {
            type: "string",
            "x-mcp-header": "X Tenant",
          },
        },
      }),
      tool("missing-type", {
        type: "object",
        properties: {
          tenant: {
            "x-mcp-header": "X-Tenant",
          },
        },
      }),
      tool("object-type", {
        type: "object",
        properties: {
          tenant: {
            type: "object",
            "x-mcp-header": "X-Tenant",
          },
        },
      }),
      tool("duplicate-header", {
        type: "object",
        properties: {
          first: {
            type: "string",
            "x-mcp-header": "X-Tenant",
          },
          second: {
            type: "boolean",
            "x-mcp-header": "x-tenant",
          },
        },
      }),
      tool("defs-header", {
        type: "object",
        $defs: {
          tenant: {
            type: "string",
            "x-mcp-header": "X-Tenant",
          },
        },
      }),
      tool("one-of-header", {
        type: "object",
        oneOf: [
          {
            type: "object",
            properties: {
              tenant: {
                type: "string",
                "x-mcp-header": "X-Tenant",
              },
            },
          },
        ],
      }),
      tool("not-header", {
        type: "object",
        not: {
          type: "object",
          properties: {
            tenant: {
              type: "string",
              "x-mcp-header": "X-Tenant",
            },
          },
        },
      }),
    ]);
    const add = createRuntime(["mcp", "add", server.url, "--name", "headers"], {
      env: { KEEL_HOME: home },
    });

    try {
      await runCliMain(add.runtime);

      // When
      const doctor = createRuntime(["mcp", "doctor", "headers"], {
        env: { KEEL_HOME: home },
      });
      const exitCode = await runCliMain(doctor.runtime);

      // Then
      expect(exitCode).toBe(1);
      expect(doctor.stderr()).toBe("");
      expect(doctor.stdout()).toContain(
        "tools: 2 catalog-valid, 11 catalog-quarantined, 13 total\n",
      );
      expect(doctor.stdout()).toContain("- root-header: invalid x-mcp-header");
      expect(doctor.stdout()).toContain(
        "- duplicate-header: invalid x-mcp-header",
      );
    } finally {
      await server.close();
      await removeTemporaryDirectory(home);
    }
  });

  test(`Given tools/list repeats a pagination cursor,
    When the user adds the server,
    Then discovery fails with a bounded loop diagnostic instead of accepting a partial catalog`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-mcp-cursor-home-"));
    const server = await startLegacyRawCatalogServer(
      [{ name: "search", inputSchema: { type: "object" } }],
      "repeated",
    );
    const add = createRuntime(["mcp", "add", server.url, "--name", "looping"], {
      env: { KEEL_HOME: home },
    });

    try {
      // When
      const exitCode = await runCliMain(add.runtime);

      // Then
      expect(exitCode).toBe(1);
      expect(add.stderr()).toBe("");
      expect(add.stdout()).toContain("status: failed\n");
      expect(add.stdout()).toContain(
        "tools/list pagination repeated cursor after page 2",
      );
    } finally {
      await server.close();
      await removeTemporaryDirectory(home);
    }
  });

  test(`Given tools/list emits a fresh cursor forever,
    When discovery reaches the page budget,
    Then it fails rather than retaining a partial catalog`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-mcp-pages-home-"));
    const server = await startUnboundedPaginationServer();
    const add = createRuntime(["mcp", "add", server.url, "--name", "endless"], {
      env: { KEEL_HOME: home },
    });

    try {
      // When
      const exitCode = await runCliMain(add.runtime);

      // Then
      expect(exitCode).toBe(1);
      expect(add.stderr()).toBe("");
      expect(add.stdout()).toContain("tools/list exceeded 64 pages");
    } finally {
      await server.close();
      await removeTemporaryDirectory(home);
    }
  });

  test(`Given an MCP error contains credentialed and malformed URLs,
    When discovery formats the failure,
    Then diagnostics redact URL credentials, queries, and malformed targets`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-mcp-error-home-"));
    const server = await startCatalogErrorServer(
      "see https://user:password@example.com/path?token=hidden and http://[",
    );
    const add = createRuntime(
      ["mcp", "add", server.url, "--name", "erroring"],
      { env: { KEEL_HOME: home } },
    );

    try {
      // When
      const exitCode = await runCliMain(add.runtime);

      // Then
      expect(exitCode).toBe(1);
      expect(add.stderr()).toBe("");
      expect(add.stdout()).toContain("https://example.com/path");
      expect(add.stdout()).toContain("<redacted-url>");
      expect(add.stdout()).not.toContain("user:password");
      expect(add.stdout()).not.toContain("token=hidden");
    } finally {
      await server.close();
      await removeTemporaryDirectory(home);
    }
  });

  test(`Given a catalog exceeds the configured tool limit,
    When the user adds the server,
    Then discovery fails before retaining the oversized catalog`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-mcp-limit-home-"));
    const tools = Array.from({ length: 1_001 }, (_, index) => ({
      name: `tool-${index}`,
      inputSchema: { type: "object" },
    }));
    const server = await startByteLimitPaginationServer(tools);
    const add = createRuntime(
      ["mcp", "add", server.url, "--name", "oversized"],
      { env: { KEEL_HOME: home } },
    );

    try {
      // When
      const exitCode = await runCliMain(add.runtime);

      // Then
      expect(exitCode).toBe(1);
      expect(add.stderr()).toBe("");
      expect(add.stdout()).toContain("status: failed\n");
      expect(add.stdout()).toContain("catalog contains more than 1000 tools");
    } finally {
      await server.close();
      await removeTemporaryDirectory(home);
    }
  });

  test(`Given a catalog stays within the tool-count limit but exceeds the byte budget,
    When discovery reads the oversized descriptors,
    Then it fails before retaining the partial catalog`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-mcp-byte-limit-home-"));
    const tools = Array.from({ length: 1_000 }, (_, index) => ({
      name: `tool-${index}`,
      description: "d".repeat(8_400),
      inputSchema: { type: "object" },
    }));
    const server = await startByteLimitPaginationServer(tools);
    const add = createRuntime(
      ["mcp", "add", server.url, "--name", "oversized-bytes"],
      { env: { KEEL_HOME: home } },
    );

    try {
      // When
      const exitCode = await runCliMain(add.runtime);

      // Then
      expect(exitCode).toBe(1);
      expect(add.stdout()).toContain(
        "catalog descriptors exceed 8388608 bytes",
      );
    } finally {
      await server.close();
      await removeTemporaryDirectory(home);
    }
  });

  test(`Given a connected MCP adapter is closed more than once,
    When cleanup is requested repeatedly,
    Then the SDK client and network transport close idempotently`, async () => {
    // Given
    const server = await startModernMcpServer();

    try {
      const connection = await connectMcpServer({
        url: server.url,
        allowPrivateNetwork: true,
        authenticationRequired: false,
      });

      // When / Then
      await expect(connection.close()).resolves.toBeUndefined();
      await expect(connection.close()).resolves.toBeUndefined();
    } finally {
      await server.close();
    }
  });

  test(`Given an unauthenticated MCP connection is handed an OAuth-bound dispatch identity,
    When a tool call is attempted,
    Then the adapter rejects before sending the mismatched authenticated call`, async () => {
    // Given
    const server = await startModernMcpServer();
    const connection = await connectMcpServer({
      url: server.url,
      allowPrivateNetwork: true,
      authenticationRequired: false,
    });

    try {
      const tool = (await connection.listCatalog()).tools[0];
      if (tool === undefined) throw new Error("expected one MCP test tool");

      // When / Then
      await expect(
        connection.callTool(
          tool,
          { query: "otters" },
          {
            kind: "oauth",
            issuer: "https://auth.example",
            clientId: "client",
            grantId: "00000000-0000-4000-8000-000000000001",
          },
          new AbortController().signal,
        ),
      ).rejects.toThrow(
        "authorization identity is unavailable for authenticated dispatch",
      );
    } finally {
      await connection.close();
      await server.close();
    }
  });

  test.each([
    ["http://example.com/mcp", "MCP server URLs must use HTTPS", "not-present"],
    [
      "https://user:top-secret@example.com/mcp",
      "MCP server URLs must not contain credentials",
      "top-secret",
    ],
    [
      "https://example.com/mcp#private-fragment",
      "MCP server URLs must not contain fragments",
      "private-fragment",
    ],
    ["file:///tmp/mcp.sock", "MCP server URLs must use HTTPS", "not-present"],
  ])(
    `Given disallowed MCP endpoint %s,
    When the user adds it,
    Then Keel rejects it before persistence or network access`,
    async (endpoint, expectedError, secret) => {
      // Given
      const home = await mkdtemp(join(tmpdir(), "keel-mcp-url-home-"));
      const add = createRuntime(["mcp", "add", endpoint, "--name", "unsafe"], {
        env: { KEEL_HOME: home },
      });

      try {
        // When
        const exitCode = await runCliMain(add.runtime);

        // Then
        expect(exitCode).toBe(1);
        expect(add.stdout()).toBe("");
        expect(add.stderr()).toContain(expectedError);
        expect(add.stderr()).not.toContain(secret);
        expect(await readdir(home)).toEqual([]);
      } finally {
        await removeTemporaryDirectory(home);
      }
    },
  );

  test(`Given a configured endpoint has a query component,
    When add and list render diagnostics,
    Then the query value is not exposed in terminal output`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-mcp-redact-home-"));
    const server = await startModernMcpServer();
    const endpoint = `${server.url}?tenant=private-value`;
    const add = createRuntime(["mcp", "add", endpoint, "--name", "redacted"], {
      env: { KEEL_HOME: home },
    });

    try {
      // When
      const addExitCode = await runCliMain(add.runtime);
      const list = createRuntime(["mcp", "list"], {
        env: { KEEL_HOME: home },
      });
      const listExitCode = await runCliMain(list.runtime);
      const status = createRuntime(["mcp", "status"], {
        env: { KEEL_HOME: home },
      });
      await runCliMain(status.runtime);

      // Then
      expect(addExitCode).toBe(0);
      expect(listExitCode).toBe(0);
      expect(add.stdout()).toContain(`endpoint: ${server.url}?<redacted>\n`);
      expect(list.stdout()).toContain(`redacted: ${server.url}?<redacted>\n`);
      expect(add.stdout()).not.toContain("private-value");
      expect(list.stdout()).not.toContain("private-value");
    } finally {
      await server.close();
      await removeTemporaryDirectory(home);
    }
  });

  test(`Given the persisted MCP config is malformed,
    When the user lists servers,
    Then Keel rejects the external data instead of trusting its TypeScript shape`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-mcp-config-home-"));
    await writeFile(
      join(home, "mcp.json"),
      '{"schemaVersion":1,"servers":"invalid"}\n',
      "utf8",
    );
    const list = createRuntime(["mcp", "list"], {
      env: { KEEL_HOME: home },
    });

    try {
      // When
      const exitCode = await runCliMain(list.runtime);

      // Then
      expect(exitCode).toBe(1);
      expect(list.stdout()).toBe("");
      expect(list.stderr()).toContain("cannot read MCP config");
    } finally {
      await removeTemporaryDirectory(home);
    }
  });

  test(`Given a loopback MCP server redirects to cloud metadata,
    When the user adds it,
    Then Keel persists the explicit server but rejects the unapproved origin before connection`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-mcp-redirect-home-"));
    const server = await startMcpServer({
      fetch: async () =>
        new Response(null, {
          status: 307,
          headers: {
            location: "https://169.254.169.254/latest/meta-data/",
          },
        }),
    });
    const add = createRuntime(
      ["mcp", "add", server.url, "--name", "redirecting"],
      { env: { KEEL_HOME: home } },
    );

    try {
      // When
      const exitCode = await runCliMain(add.runtime);
      const list = createRuntime(["mcp", "list"], {
        env: { KEEL_HOME: home },
      });
      const listExitCode = await runCliMain(list.runtime);

      // Then
      expect(exitCode).toBe(1);
      expect(add.stderr()).toBe("");
      expect(add.stdout()).toContain("status: failed\n");
      expect(add.stdout()).toContain(
        "cross-origin MCP redirect rejected because the destination was not approved",
      );
      expect(listExitCode).toBe(0);
      expect(list.stdout()).toContain(`redirecting: ${server.url}\n`);
    } finally {
      await server.close();
      await removeTemporaryDirectory(home);
    }
  });

  test(`Given two users add different MCP servers concurrently,
    When both configuration mutations finish,
    Then the serialized config retains both servers`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-mcp-race-home-"));
    const firstServer = await startModernMcpServer();
    const secondServer = await startModernMcpServer();
    const first = createRuntime(
      ["mcp", "add", firstServer.url, "--name", "first"],
      { env: { KEEL_HOME: home } },
    );
    const second = createRuntime(
      ["mcp", "add", secondServer.url, "--name", "second"],
      { env: { KEEL_HOME: home } },
    );

    try {
      // When
      const [firstExitCode, secondExitCode] = await Promise.all([
        runCliMain(first.runtime),
        runCliMain(second.runtime),
      ]);
      const list = createRuntime(["mcp", "list"], {
        env: { KEEL_HOME: home },
      });
      const listExitCode = await runCliMain(list.runtime);
      const status = createRuntime(["mcp", "status"], {
        env: { KEEL_HOME: home },
      });
      const statusExitCode = await runCliMain(status.runtime);

      // Then
      expect(firstExitCode).toBe(0);
      expect(secondExitCode).toBe(0);
      expect(listExitCode).toBe(0);
      expect(statusExitCode).toBe(0);
      expect(list.stderr()).toBe("");
      expect(list.stdout()).toContain(`first: ${firstServer.url}\n`);
      expect(list.stdout()).toContain(`second: ${secondServer.url}\n`);
      expect(status.stdout()).toContain("MCP server: first\n");
      expect(status.stdout()).toContain("\n\nMCP server: second\n");

      const disableSecond = createRuntime(["mcp", "disable", "second"], {
        env: { KEEL_HOME: home },
      });
      expect(await runCliMain(disableSecond.runtime)).toBe(0);
      const disabledStatus = createRuntime(["mcp", "status"], {
        env: { KEEL_HOME: home },
      });
      expect(await runCliMain(disabledStatus.runtime)).toBe(0);
      expect(disabledStatus.stdout()).toContain("\n\nMCP server: second\n");
      expect(disabledStatus.stdout()).toContain("status: disabled\n");
    } finally {
      await firstServer.close();
      await secondServer.close();
      await removeTemporaryDirectory(home);
    }
  });
});
