import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
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

interface TestMcpServer {
  readonly url: string;
  readonly close: () => Promise<void>;
}

interface CountingTestMcpServer extends TestMcpServer {
  readonly requestCount: () => number;
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
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a reachable Streamable HTTP MCP server,
    When the user adds it and checks its status,
    Then Keel persists it and shows bounded modern discovery`, async () => {
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
      await rm(home, { recursive: true, force: true });
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
      await rm(home, { recursive: true, force: true });
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
      await rm(home, { recursive: true, force: true });
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
      await rm(home, { recursive: true, force: true });
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
      await rm(home, { recursive: true, force: true });
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
      await rm(home, { recursive: true, force: true });
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
        "provider tools: 1 usable, 1 quarantined, 0 validation-widened\n",
      );
      expect(doctor.stdout()).toContain("quarantined tools:\n");
      expect(doctor.stdout()).toContain("provider-quarantined tools:\n");
      expect(doctor.stdout()).toContain(
        "- search: inputSchema.properties.query.$ref requires bounded local reference compilation",
      );
      expect(doctor.stdout()).toContain(`- ${invalidName}: `);
      expect(doctor.stdout()).toContain("- malformed: ");
      expect(doctor.stdout()).not.toContain("Search safely");
      expect(
        doctor
          .stdout()
          .split("\n")
          .filter((line) => line.startsWith("- ")),
      ).toHaveLength(11);
    } finally {
      await server.close();
      await rm(home, { recursive: true, force: true });
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
      await rm(home, { recursive: true, force: true });
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
      await rm(home, { recursive: true, force: true });
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
      await rm(home, { recursive: true, force: true });
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
      await rm(home, { recursive: true, force: true });
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
      await rm(home, { recursive: true, force: true });
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
      await rm(home, { recursive: true, force: true });
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
      await rm(home, { recursive: true, force: true });
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
        await rm(home, { recursive: true, force: true });
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
      await rm(home, { recursive: true, force: true });
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
      await rm(home, { recursive: true, force: true });
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
      await rm(home, { recursive: true, force: true });
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
    } finally {
      await firstServer.close();
      await secondServer.close();
      await rm(home, { recursive: true, force: true });
    }
  });
});
