import { createServer } from "node:http";
import { toNodeHandler } from "@modelcontextprotocol/node";
import {
  createMcpHandler,
  fromJsonSchema,
  type JsonSchemaType,
  McpServer,
} from "@modelcontextprotocol/server";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import type { McpServerConfig } from "../../src/cli/mcp-config.ts";
import {
  buildMcpCatalog,
  connectMcpServer,
  type McpConnection,
  type McpJsonValue,
} from "../../src/mcp/discovery.ts";
import {
  compileMcpProviderInputSchema,
  MCP_LOCAL_REFERENCE_CYCLE_SCAN_LIMITS,
  MCP_PROVIDER_SCHEMA_REFERENCE_LIMITS,
  mcpProviderSchemaTarget,
  scanMcpDegenerateLocalReferenceCycle,
} from "../../src/mcp/provider-schema.ts";
import { createMcpRuntime } from "../../src/mcp/runtime.ts";
import type {
  McpConnectionFactory,
  McpPermissionPolicy,
  McpToolFilterPolicy,
  McpToolRuntimeResult,
} from "../../src/mcp/runtime-types.ts";
import {
  close,
  getPort,
  listen,
} from "../../src/testing/provider-sse-fixtures.ts";
import type { McpToolCall } from "../../src/tools/tool-call.ts";

interface TestMcpServer {
  readonly url: string;
  readonly calls: () => number;
  readonly parameterHeaders: () => readonly string[];
  readonly close: () => Promise<void>;
}

type McpWireToolResult = Awaited<ReturnType<McpConnection["callTool"]>>;
type IdentifiedMcpToolRuntimeResult = Extract<
  McpToolRuntimeResult,
  { readonly identity: "identified" }
>;

function expectIdentifiedMcpResult(
  result: McpToolRuntimeResult,
): asserts result is IdentifiedMcpToolRuntimeResult {
  expect(result.identity).toBe("identified");
  if (result.identity !== "identified") {
    throw new Error("expected an identified MCP tool result");
  }
}

const testServerConfig: McpServerConfig = {
  id: "catalog",
  url: "https://catalog.example/mcp",
  allowPrivateNetwork: false,
  authenticationRequired: false,
  toolFilter: { allow: null, deny: [] },
};
const testSchemaTarget = mcpProviderSchemaTarget(
  "deepseek",
  "deepseek-v4-flash",
);

const allowPermission: McpPermissionPolicy = {
  review: () => ({ type: "allow" }),
};

async function fakeCatalog(
  tools: readonly {
    readonly name: string;
    readonly description?: string;
    readonly inputSchema: McpJsonValue;
    readonly outputSchema?: McpJsonValue;
  }[],
) {
  return await buildMcpCatalog(tools, "modern");
}

function fakeConnectionFactory(options: {
  readonly catalogs: readonly Awaited<ReturnType<typeof fakeCatalog>>[];
  readonly callTool?: (
    toolName: string,
    arguments_: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
  ) => Promise<McpWireToolResult>;
}) {
  let connectCalls = 0;
  let listCalls = 0;
  let callCalls = 0;
  let closeCalls = 0;
  const connection: McpConnection = {
    protocolEra: "modern",
    protocolVersion: "2026-07-28",
    serverIdentity: "fake@1.0.0",
    listCatalog: async () => {
      const catalog =
        options.catalogs[Math.min(listCalls, options.catalogs.length - 1)];
      listCalls++;
      if (catalog === undefined) {
        throw new Error("fake catalog is unavailable");
      }
      return catalog;
    },
    callTool: async (tool, arguments_, signal) => {
      callCalls++;
      return (
        (await options.callTool?.(
          tool.descriptor.name,
          arguments_,
          signal,
        )) ?? {
          content: [{ type: "text", text: "ok" }],
        }
      );
    },
    close: async () => {
      closeCalls++;
    },
  };
  const factory: McpConnectionFactory = {
    connect: async () => {
      connectCalls++;
      return connection;
    },
  };
  return {
    factory,
    connectCalls: () => connectCalls,
    listCalls: () => listCalls,
    callCalls: () => callCalls,
    closeCalls: () => closeCalls,
  };
}

function runtimeWithFactory(options: {
  readonly connectionFactory: McpConnectionFactory;
  readonly permission?: McpPermissionPolicy;
  readonly filter?: McpToolFilterPolicy;
  readonly now?: () => number;
}) {
  return createMcpRuntime({
    servers: [testServerConfig],
    connectionFactory: options.connectionFactory,
    permission: options.permission ?? allowPermission,
    schemaTarget: testSchemaTarget,
    ...(options.filter !== undefined ? { filter: options.filter } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
  });
}

async function activateExactSearch(
  runtime: ReturnType<typeof createMcpRuntime>,
): Promise<McpToolCall> {
  await runtime.search(
    { query: "unrelated", server: "catalog", tool: "search" },
    new AbortController().signal,
  );
  return exposedToolCall(runtime);
}

async function startMcpToolServer(): Promise<TestMcpServer> {
  let calls = 0;
  const parameterHeaders: string[] = [];
  const tenantHeaderProperty = {
    type: "string",
    "x-mcp-header": "X-Tenant",
  } as const;
  const headerInputSchema = {
    type: "object",
    properties: {
      tenant: tenantHeaderProperty,
    },
    required: ["tenant"],
    additionalProperties: false,
  } satisfies JsonSchemaType;
  const handler = createMcpHandler(() => {
    const server = new McpServer(
      { name: "keel-runtime-test", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    server.registerTool(
      "search",
      {
        description: "Search the remote catalog",
        inputSchema: z.object({ query: z.string() }),
      },
      async ({ query }) => {
        calls++;
        return {
          content: [{ type: "text", text: `result for ${query}` }],
        };
      },
    );
    server.registerTool(
      "header_echo",
      {
        description: "Echo one header-bound argument",
        inputSchema: fromJsonSchema<{ tenant: string }>(headerInputSchema),
      },
      async ({ tenant }) => {
        calls++;
        return {
          content: [{ type: "text", text: `tenant ${tenant}` }],
        };
      },
    );
    return server;
  });
  const nodeHandler = toNodeHandler(handler);
  const server = createServer((request, response) => {
    const parameterHeader = request.headers["mcp-param-x-tenant"];
    if (typeof parameterHeader === "string") {
      parameterHeaders.push(parameterHeader);
    }
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
  await listen(server);
  return {
    url: `http://127.0.0.1:${getPort(server)}/mcp`,
    calls: () => calls,
    parameterHeaders: () => [...parameterHeaders],
    close: async () => {
      await handler.close?.();
      await close(server);
    },
  };
}

function exposedToolCall(
  runtime: ReturnType<typeof createMcpRuntime>,
): McpToolCall {
  const definition = runtime.exposureSnapshot().tools[0];
  if (definition === undefined) {
    throw new Error("expected one exposed MCP tool");
  }
  return {
    kind: "mcp",
    id: "mcp_call_1",
    tool: definition.modelName,
    reference: definition.reference,
    arguments: { query: "otters" },
  };
}

describe("MCP runtime", () => {
  test(`Given a typed MCP invocation has no identity in the frozen exposure snapshot,
    When runtime handles the unresolved invocation,
    Then it returns recovery without connecting, approving, or dispatching`, async () => {
    // Given
    const fake = fakeConnectionFactory({ catalogs: [] });
    let approvals = 0;
    const runtime = runtimeWithFactory({
      connectionFactory: fake.factory,
      permission: {
        review: () => {
          approvals++;
          return { type: "allow" };
        },
      },
    });

    try {
      // When
      const result = await runtime.execute(
        {
          kind: "mcp_unresolved",
          id: "remote_stale",
          tool: "mcp__catalog__removed",
          arguments: { query: "otters" },
        },
        new AbortController().signal,
      );

      // Then
      expect(result).toEqual({
        identity: "unidentified",
        content:
          "MCP tool call rejected: its name is not present in the current exposure snapshot. Search again before retrying.",
        ok: false,
      });
      expect(fake.connectCalls()).toBe(0);
      expect(fake.listCalls()).toBe(0);
      expect(fake.callCalls()).toBe(0);
      expect(approvals).toBe(0);
    } finally {
      await runtime.close();
    }
  });

  test(`Given a modern MCP tool binds a primitive argument with x-mcp-header,
    When the model activates and invokes the lowered provider tool,
    Then the original descriptor still delivers the matching MCP parameter header`, async () => {
    // Given
    const server = await startMcpToolServer();
    const runtime = createMcpRuntime({
      servers: [
        {
          id: "catalog",
          url: server.url,
          allowPrivateNetwork: true,
          authenticationRequired: false,
          toolFilter: { allow: null, deny: [] },
        },
      ],
      connectionFactory: { connect: connectMcpServer },
      permission: allowPermission,
      schemaTarget: testSchemaTarget,
    });
    const signal = new AbortController().signal;

    try {
      await runtime.search(
        {
          query: "header",
          server: "catalog",
          tool: "header_echo",
        },
        signal,
      );
      const definition = runtime.exposureSnapshot().tools[0];
      if (definition === undefined) {
        throw new Error("expected x-mcp-header tool to be active");
      }

      // When
      const result = await runtime.execute(
        {
          kind: "mcp",
          id: "call_header_echo",
          tool: definition.modelName,
          reference: definition.reference,
          arguments: { tenant: "acme" },
        },
        signal,
      );

      // Then
      expect(result.ok, result.content).toBe(true);
      expect(server.parameterHeaders()).toEqual(["acme"]);
    } finally {
      await runtime.close();
      await server.close();
    }
  });

  test(`Given a tool was exposed and the current policy changes before dispatch,
    When the model invokes the frozen tool reference,
    Then execution rechecks the typed filter and does not approve or call it`, async () => {
    // Given
    const server = await startMcpToolServer();
    let allowed = true;
    let approvals = 0;
    const runtime = createMcpRuntime({
      servers: [
        {
          id: "catalog",
          url: server.url,
          allowPrivateNetwork: true,
          authenticationRequired: false,
          toolFilter: { allow: null, deny: [] },
        },
      ],
      connectionFactory: { connect: connectMcpServer },
      filter: {
        allows: () => allowed,
      },
      permission: {
        review: () => {
          approvals++;
          return { type: "allow" };
        },
      },
      schemaTarget: testSchemaTarget,
    });
    const signal = new AbortController().signal;

    try {
      await runtime.search(
        { query: "search", server: "catalog", tool: "search" },
        signal,
      );
      const toolCall = exposedToolCall(runtime);

      // When
      allowed = false;
      const result = await runtime.execute(toolCall, signal);

      // Then
      expect(runtime.exposureSnapshot().tools).toEqual([]);
      expect(result.ok).toBe(false);
      expect(result.content).toContain("current tool filter denies");
      expectIdentifiedMcpResult(result);
      expect(result.preserved).toMatchObject({
        origin: "external",
        trustedEvidence: false,
        value: { error: "MCP tool denied by current filter" },
      });
      expect(approvals).toBe(0);
      expect(server.calls()).toBe(0);
    } finally {
      await runtime.close();
      await server.close();
    }
  });

  test(`Given a configured raw tool appears in both allow and deny filters,
    When discovery evaluates the catalog,
    Then deny wins and the tool never enters the exposure snapshot`, async () => {
    // Given
    const catalog = await fakeCatalog([
      {
        name: "search",
        inputSchema: { type: "object", properties: {} },
      },
    ]);
    const fake = fakeConnectionFactory({ catalogs: [catalog] });
    const runtime = createMcpRuntime({
      servers: [
        {
          ...testServerConfig,
          toolFilter: { allow: ["search"], deny: ["search"] },
        },
      ],
      connectionFactory: fake.factory,
      permission: allowPermission,
      schemaTarget: testSchemaTarget,
    });

    try {
      // When
      const searchResult = await runtime.search(
        { query: "search" },
        new AbortController().signal,
      );

      // Then
      expect(runtime.exposureSnapshot().tools).toEqual([]);
      expect(searchResult.content).toContain(
        "1 discovered, 0 catalog-quarantined, 1 provider-usable",
      );
      expect(searchResult.content).toContain("1 filtered");
    } finally {
      await runtime.close();
    }
  });

  test(`Given policy changes while an exposed call is awaiting user approval,
    When approval returns allow,
    Then execution rechecks the current filter immediately before dispatch`, async () => {
    // Given
    const catalog = await fakeCatalog([
      {
        name: "search",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      },
    ]);
    const fake = fakeConnectionFactory({ catalogs: [catalog] });
    let allowed = true;
    let approvals = 0;
    const runtime = runtimeWithFactory({
      connectionFactory: fake.factory,
      filter: { allows: () => allowed },
      permission: {
        review: () => {
          approvals++;
          allowed = false;
          return { type: "allow" };
        },
      },
    });

    try {
      const toolCall = await activateExactSearch(runtime);

      // When
      const result = await runtime.execute(
        toolCall,
        new AbortController().signal,
      );

      // Then
      expect(approvals).toBe(1);
      expect(fake.callCalls()).toBe(0);
      expect(result.ok).toBe(false);
      expect(result.content).toContain("current tool filter denies");
    } finally {
      await runtime.close();
    }
  });

  test(`Given a catalog descriptor changes while an exposed call awaits approval,
    When the user allows the old frozen reference,
    Then execution rejects it before dispatch and requires a new search`, async () => {
    // Given
    const firstCatalog = await fakeCatalog([
      {
        name: "search",
        description: "Search version one",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      },
    ]);
    const secondCatalog = await fakeCatalog([
      {
        name: "search",
        description: "Search version two",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      },
    ]);
    const fake = fakeConnectionFactory({
      catalogs: [firstCatalog, secondCatalog],
    });
    const approvalStarted = Promise.withResolvers<void>();
    const approvalFinished = Promise.withResolvers<void>();
    const runtime = runtimeWithFactory({
      connectionFactory: fake.factory,
      permission: {
        review: async () => {
          approvalStarted.resolve();
          await approvalFinished.promise;
          return { type: "allow" };
        },
      },
    });
    const signal = new AbortController().signal;

    try {
      const toolCall = await activateExactSearch(runtime);
      const execution = runtime.execute(toolCall, signal);
      await approvalStarted.promise;

      // When
      await runtime.search(
        {
          query: "search",
          server: "catalog",
          tool: "search",
          refresh: true,
        },
        signal,
      );
      approvalFinished.resolve();
      const result = await execution;

      // Then
      expect(fake.callCalls()).toBe(0);
      expect(result.ok).toBe(false);
      expect(result.content).toContain("changed during approval");
    } finally {
      approvalFinished.resolve();
      await runtime.close();
    }
  });

  test(`Given concurrent searches target one idle logical server,
    When discovery starts at the same time,
    Then the owner shares one connection and one catalog generation`, async () => {
    // Given
    const catalog = await fakeCatalog([
      {
        name: "search",
        description: "Search the catalog",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      },
    ]);
    const fake = fakeConnectionFactory({ catalogs: [catalog] });
    const runtime = runtimeWithFactory({
      connectionFactory: fake.factory,
    });
    const signal = new AbortController().signal;

    try {
      // When
      await Promise.all([
        runtime.search({ query: "search" }, signal),
        runtime.search({ query: "search" }, signal),
      ]);

      // Then
      expect(fake.connectCalls()).toBe(1);
      expect(fake.listCalls()).toBe(1);
      expect(runtime.exposureSnapshot().tools).toHaveLength(1);
    } finally {
      await runtime.close();
    }
    expect(fake.closeCalls()).toBe(1);
  });

  test(`Given a large catalog has one exact tool that lexical search would miss,
    When the model requests exact server and raw-tool filters,
    Then Keel activates only that schema instead of injecting all 1,000`, async () => {
    // Given
    const catalog = await fakeCatalog(
      Array.from({ length: 1_000 }, (_, index) => ({
        name: `capability-${index}`,
        description: `Remote capability number ${index}`,
        inputSchema: {
          type: "object",
          properties: { value: { type: "string" } },
        },
      })),
    );
    const fake = fakeConnectionFactory({ catalogs: [catalog] });
    const runtime = runtimeWithFactory({
      connectionFactory: fake.factory,
    });

    try {
      // When
      const searchResult = await runtime.search(
        {
          query: "words absent from the descriptor",
          server: "catalog",
          tool: "capability-999",
        },
        new AbortController().signal,
      );

      // Then
      expect(runtime.exposureSnapshot().tools).toHaveLength(1);
      expect(runtime.exposureSnapshot().tools[0]?.reference.rawToolName).toBe(
        "capability-999",
      );
      expect(searchResult.content).toContain("1000 discovered");
      expect(searchResult.content).toContain("1 active");
    } finally {
      await runtime.close();
    }
  });

  test(`Given one tool uses a non-null union beside a simple tool,
    When the catalog is searched,
    Then both schemas remain provider-usable`, async () => {
    // Given
    const catalog = await fakeCatalog([
      {
        name: "ambiguous",
        inputSchema: {
          type: "object",
          properties: {
            choice: {
              anyOf: [
                { type: "string", enum: ["left"] },
                { type: "string", enum: ["right"] },
              ],
            },
          },
          required: ["choice"],
        },
      },
      {
        name: "search",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      },
    ]);
    const fake = fakeConnectionFactory({ catalogs: [catalog] });
    const runtime = runtimeWithFactory({
      connectionFactory: fake.factory,
    });

    try {
      // When
      const searchResult = await runtime.search(
        { query: "anything", server: "catalog", limit: 10 },
        new AbortController().signal,
      );

      // Then
      expect(
        runtime
          .exposureSnapshot()
          .tools.map((tool) => tool.reference.rawToolName),
      ).toEqual(["ambiguous", "search"]);
      expect(searchResult.content).not.toContain("Provider schema quarantine:");
      expect(searchResult.content).toContain("2 discovered");
      expect(searchResult.content).toContain("2 provider-usable");
      expect(searchResult.content).toContain("2 active");
    } finally {
      await runtime.close();
    }
  });

  test(`Given two raw identities normalize to the same provider-visible base name,
    When both tools are activated,
    Then deterministic digest suffixes keep routing identities distinct`, async () => {
    // Given
    const catalog = await fakeCatalog([
      {
        name: "search-items",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "search_items",
        inputSchema: { type: "object", properties: {} },
      },
    ]);
    const fake = fakeConnectionFactory({ catalogs: [catalog] });
    const runtime = runtimeWithFactory({
      connectionFactory: fake.factory,
    });

    try {
      // When
      await runtime.search(
        { query: "unused", server: "catalog", limit: 10 },
        new AbortController().signal,
      );
      const exposed = runtime.exposureSnapshot().tools;

      // Then
      expect(exposed).toHaveLength(2);
      expect(new Set(exposed.map((tool) => tool.modelName)).size).toBe(2);
      expect(exposed.every((tool) => tool.modelName.length <= 64)).toBe(true);
      expect(exposed.map((tool) => tool.reference.rawToolName).sort()).toEqual([
        "search-items",
        "search_items",
      ]);
    } finally {
      await runtime.close();
    }
  });

  test(`Given a catalog refresh changes a selected descriptor,
    When the old frozen reference and the refreshed exposure are inspected,
    Then only the next snapshot changes and stale execution is rejected`, async () => {
    // Given
    const firstCatalog = await fakeCatalog([
      {
        name: "search",
        description: "Search version one",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      },
    ]);
    const secondCatalog = await fakeCatalog([
      {
        name: "search",
        description: "Search version two",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            limit: { type: "integer" },
          },
          required: ["query"],
        },
      },
    ]);
    let approvals = 0;
    const fake = fakeConnectionFactory({
      catalogs: [firstCatalog, secondCatalog],
    });
    const runtime = runtimeWithFactory({
      connectionFactory: fake.factory,
      permission: {
        review: () => {
          approvals++;
          return { type: "allow" };
        },
      },
    });
    const signal = new AbortController().signal;

    try {
      await runtime.search(
        { query: "search", server: "catalog", tool: "search" },
        signal,
      );
      const firstSnapshot = runtime.exposureSnapshot();
      const oldCall = exposedToolCall(runtime);

      // When
      await runtime.search(
        {
          query: "search",
          server: "catalog",
          tool: "search",
          refresh: true,
        },
        signal,
      );
      const secondSnapshot = runtime.exposureSnapshot();
      const staleResult = await runtime.execute(oldCall, signal);

      // Then
      expect(firstSnapshot.tools[0]?.description).toContain("version one");
      expect(firstSnapshot.tools[0]?.reference).toEqual(oldCall.reference);
      expect(secondSnapshot.tools[0]?.description).toContain("version two");
      expect(secondSnapshot.snapshotId).not.toBe(firstSnapshot.snapshotId);
      expect(staleResult.ok).toBe(false);
      expect(staleResult.content).toContain("changed after exposure");
      expect(approvals).toBe(0);
      expect(fake.callCalls()).toBe(0);
    } finally {
      await runtime.close();
    }
  });

  test(`Given active MCP tools are visible to one provider target,
    When a later turn switches to another provider model,
    Then Keel recompiles the active schema snapshot without requiring another search`, async () => {
    // Given
    const catalog = await fakeCatalog([
      {
        name: "ask_question",
        description: "Ask about repositories",
        inputSchema: {
          type: "object",
          properties: {
            repoName: {
              anyOf: [
                { type: "string" },
                { type: "array", items: { type: "string" } },
              ],
            },
          },
          required: ["repoName"],
          additionalProperties: false,
        },
      },
    ]);
    const fake = fakeConnectionFactory({ catalogs: [catalog] });
    const runtime = runtimeWithFactory({ connectionFactory: fake.factory });
    const signal = new AbortController().signal;

    try {
      await runtime.search(
        {
          query: "repositories",
          server: "catalog",
          tool: "ask_question",
        },
        signal,
      );

      // When
      await runtime.prepareTurn(
        mcpProviderSchemaTarget("kimi", "kimi-k2.6"),
        signal,
      );

      // Then
      expect(fake.listCalls()).toBe(1);
      expect(runtime.exposureSnapshot().tools).toHaveLength(1);
      expect(runtime.exposureSnapshot().tools[0]?.parameters).toEqual({
        type: "object",
        properties: {
          repoName: {
            anyOf: [
              { type: "string" },
              { type: "array", items: { type: "string" } },
            ],
          },
        },
        required: ["repoName"],
        additionalProperties: false,
      });
    } finally {
      await runtime.close();
    }
  });

  test(`Given an active catalog reaches its five-minute TTL,
    When the next turn is prepared,
    Then refresh is atomic and changed tools require a new search snapshot`, async () => {
    // Given
    const firstCatalog = await fakeCatalog([
      {
        name: "search",
        description: "Before TTL refresh",
        inputSchema: { type: "object", properties: {} },
      },
    ]);
    const secondCatalog = await fakeCatalog([
      {
        name: "search",
        description: "After TTL refresh",
        inputSchema: { type: "object", properties: {} },
      },
    ]);
    let now = 0;
    const fake = fakeConnectionFactory({
      catalogs: [firstCatalog, secondCatalog],
    });
    const runtime = runtimeWithFactory({
      connectionFactory: fake.factory,
      now: () => now,
    });
    const signal = new AbortController().signal;

    try {
      await runtime.search(
        { query: "search", server: "catalog", tool: "search" },
        signal,
      );
      const originalSnapshot = runtime.exposureSnapshot();

      // When
      now = 5 * 60 * 1_000;
      await runtime.prepareTurn(testSchemaTarget, signal);

      // Then
      expect(fake.listCalls()).toBe(2);
      expect(originalSnapshot.tools[0]?.description).toContain(
        "Before TTL refresh",
      );
      expect(runtime.exposureSnapshot().tools).toEqual([]);

      await runtime.search(
        { query: "search", server: "catalog", tool: "search" },
        signal,
      );
      expect(runtime.exposureSnapshot().tools[0]?.description).toContain(
        "After TTL refresh",
      );
    } finally {
      await runtime.close();
    }
  });

  test(`Given an active catalog expires and its TTL refresh fails,
    When the next turn is prepared,
    Then the expired generation is closed and cannot remain exposed or execute`, async () => {
    // Given
    const catalog = await fakeCatalog([
      {
        name: "search",
        description: "Expired descriptor",
        inputSchema: { type: "object", properties: {} },
      },
    ]);
    let now = 0;
    let listCalls = 0;
    let callCalls = 0;
    let closeCalls = 0;
    const connection: McpConnection = {
      protocolEra: "modern",
      protocolVersion: "2026-07-28",
      serverIdentity: "fake@1.0.0",
      listCatalog: async () => {
        listCalls++;
        if (listCalls > 1) {
          throw new Error("refresh unavailable");
        }
        return catalog;
      },
      callTool: async () => {
        callCalls++;
        return { content: [{ type: "text", text: "unexpected" }] };
      },
      close: async () => {
        closeCalls++;
      },
    };
    const runtime = runtimeWithFactory({
      connectionFactory: {
        connect: async () => connection,
      },
      now: () => now,
    });
    const signal = new AbortController().signal;

    try {
      await runtime.search(
        { query: "search", server: "catalog", tool: "search" },
        signal,
      );
      const expiredCall = exposedToolCall(runtime);

      // When
      now = 5 * 60 * 1_000;
      await runtime.prepareTurn(testSchemaTarget, signal);
      const execution = await runtime.execute(expiredCall, signal);

      // Then
      expect(runtime.exposureSnapshot().tools).toEqual([]);
      expect(execution.ok).toBe(false);
      expect(execution.content).toContain("changed after exposure");
      expect(callCalls).toBe(0);
      expect(closeCalls).toBe(1);
    } finally {
      await runtime.close();
    }
  });

  test(`Given a model supplies arguments rejected by the server's original schema,
    When execution reaches the external boundary,
    Then validation fails before approval or dispatch`, async () => {
    // Given
    const catalog = await fakeCatalog([
      {
        name: "search",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
          additionalProperties: false,
        },
      },
    ]);
    let approvals = 0;
    const fake = fakeConnectionFactory({ catalogs: [catalog] });
    const runtime = runtimeWithFactory({
      connectionFactory: fake.factory,
      permission: {
        review: () => {
          approvals++;
          return { type: "allow" };
        },
      },
    });
    const signal = new AbortController().signal;

    try {
      const exposed = await activateExactSearch(runtime);
      const invalidCall: McpToolCall = {
        ...exposed,
        arguments: { query: 42 },
      };

      // When
      const result = await runtime.execute(invalidCall, signal);

      // Then
      expect(result.ok).toBe(false);
      expect(result.content).toContain("original server JSON Schema");
      expect(approvals).toBe(0);
      expect(fake.callCalls()).toBe(0);
    } finally {
      await runtime.close();
    }
  });

  test(`Given a draft-07 MCP tool receives arguments rejected by its original schema,
    When execution reaches the external boundary,
    Then draft-07 validation fails before approval or dispatch`, async () => {
    // Given
    const catalog = await fakeCatalog([
      {
        name: "search",
        inputSchema: {
          $schema: "http://json-schema.org/draft-07/schema",
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
          additionalProperties: false,
        },
      },
    ]);
    let approvals = 0;
    const fake = fakeConnectionFactory({ catalogs: [catalog] });
    const runtime = runtimeWithFactory({
      connectionFactory: fake.factory,
      permission: {
        review: () => {
          approvals++;
          return { type: "allow" };
        },
      },
    });
    const signal = new AbortController().signal;

    try {
      const exposed = await activateExactSearch(runtime);
      const invalidCall: McpToolCall = {
        ...exposed,
        arguments: { query: 42 },
      };

      // When
      const result = await runtime.execute(invalidCall, signal);

      // Then
      expect(result.ok).toBe(false);
      expect(result.content).toContain("original server JSON Schema");
      expect(approvals).toBe(0);
      expect(fake.callCalls()).toBe(0);
    } finally {
      await runtime.close();
    }
  });

  test(`Given draft-07 tools reuse one schema identifier with different constraints,
    When the catalog builds their original validators,
    Then both ambiguous tools are quarantined before execution`, async () => {
    // Given
    const catalog = await fakeCatalog([
      {
        name: "optional_ticket",
        inputSchema: {
          $schema: "http://json-schema.org/draft-07/schema#",
          $id: "https://schemas.example.test/tool-input",
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
      {
        name: "required_ticket",
        inputSchema: {
          $schema: "http://json-schema.org/draft-07/schema#",
          $id: "https://schemas.example.test/tool-input#",
          type: "object",
          properties: {
            ticket: { type: "string", minLength: 1 },
          },
          required: ["ticket"],
          additionalProperties: false,
        },
      },
      {
        name: "required_project",
        inputSchema: {
          $schema: "http://json-schema.org/draft-07/schema#",
          $id: "https://schemas.example.test/tool-input#/",
          type: "object",
          properties: {
            project: { type: "string", minLength: 1 },
          },
          required: ["project"],
          additionalProperties: false,
        },
      },
    ]);
    // When / Then
    expect(catalog.tools).toEqual([]);
    expect(catalog.summary).toMatchObject({
      total: 3,
      valid: 0,
      quarantined: 3,
      issues: [
        {
          tool: "optional_ticket",
          reason: expect.stringContaining("conflicting JSON Schema identifier"),
        },
        {
          tool: "required_ticket",
          reason: expect.stringContaining("conflicting JSON Schema identifier"),
        },
        {
          tool: "required_project",
          reason: expect.stringContaining("conflicting JSON Schema identifier"),
        },
      ],
    });
  });

  test(`Given draft-07 tools reuse one schema identifier with identical constraints,
    When the catalog builds their original validators,
    Then both unambiguous tools remain usable`, async () => {
    // Given
    const inputSchema: McpJsonValue = {
      $schema: "http://json-schema.org/draft-07/schema#",
      $id: "https://schemas.example.test/shared-input",
      type: "object",
      properties: {
        ticket: { type: "string", minLength: 1 },
      },
      required: ["ticket"],
      additionalProperties: false,
    };

    // When
    const catalog = await fakeCatalog([
      { name: "read_ticket", inputSchema },
      { name: "update_ticket", inputSchema },
    ]);

    // Then
    expect(catalog.summary).toMatchObject({
      total: 2,
      valid: 2,
      quarantined: 0,
      issues: [],
    });
    expect(catalog.tools.map((tool) => tool.descriptor.name)).toEqual([
      "read_ticket",
      "update_ticket",
    ]);
  });

  test(`Given an MCP tool declares an invalid output JSON Schema,
    When the catalog compiles its original validators,
    Then the tool is quarantined before it can be exposed`, async () => {
    // Given / When
    const catalog = await fakeCatalog([
      {
        name: "invalid_output",
        inputSchema: { type: "object", properties: {} },
        outputSchema: {
          type: "object",
          properties: {
            result: { type: "not-a-json-schema-type" },
          },
        },
      },
    ]);

    // Then
    expect(catalog.tools).toEqual([]);
    expect(catalog.summary).toMatchObject({
      total: 1,
      valid: 0,
      quarantined: 1,
      issues: [
        {
          tool: "invalid_output",
          reason: expect.stringContaining("invalid JSON Schema"),
        },
      ],
    });
  });

  test(`Given an MCP tool explicitly uses JSON Schema 2020-12 tuple semantics,
    When the catalog validates tool arguments,
    Then the 2020-12 validator accepts the prefix and rejects extra items`, async () => {
    // Given
    const catalog = await fakeCatalog([
      {
        name: "tuple",
        inputSchema: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          properties: {
            values: {
              type: "array",
              prefixItems: [{ type: "string" }],
              items: false,
            },
          },
          required: ["values"],
          additionalProperties: false,
        },
      },
    ]);
    const tuple = catalog.tools[0];
    if (tuple === undefined) {
      throw new Error("expected tuple in the MCP catalog");
    }

    // When
    const validIssues = await tuple.validateArguments({ values: ["keel"] });
    const extraIssues = await tuple.validateArguments({
      values: ["keel", "extra"],
    });

    // Then
    expect(validIssues).toEqual([]);
    expect(extraIssues).not.toEqual([]);
  });

  test(`Given approval fails closed for an otherwise valid external call,
    When the frozen reference is executed,
    Then the server is never dispatched`, async () => {
    // Given
    const catalog = await fakeCatalog([
      {
        name: "search",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      },
    ]);
    const fake = fakeConnectionFactory({ catalogs: [catalog] });
    const runtime = runtimeWithFactory({
      connectionFactory: fake.factory,
      permission: {
        review: () => ({ type: "deny", message: "headless fail closed" }),
      },
    });

    try {
      const result = await runtime.execute(
        await activateExactSearch(runtime),
        new AbortController().signal,
      );

      // Then
      expect(result.ok).toBe(false);
      expect(result.content).toContain("headless fail closed");
      expect(fake.callCalls()).toBe(0);
    } finally {
      await runtime.close();
    }
  });

  test(`Given transport failure occurs after one external dispatch,
    When execution settles the call,
    Then it reports an uncertain outcome and never retries`, async () => {
    // Given
    const catalog = await fakeCatalog([
      {
        name: "search",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      },
    ]);
    const fake = fakeConnectionFactory({
      catalogs: [catalog],
      callTool: async () => {
        throw new Error(
          "connection reset at https://catalog.example/mcp?token=topsecret Authorization: Bearer live-secret-token-270",
        );
      },
    });
    const runtime = runtimeWithFactory({
      connectionFactory: fake.factory,
    });

    try {
      // When
      const result = await runtime.execute(
        await activateExactSearch(runtime),
        new AbortController().signal,
      );

      // Then
      expect(result.ok).toBe(false);
      expect(result.content).toContain("outcome is uncertain");
      expect(result.content).toContain("did not retry");
      expect(result.content).not.toContain("topsecret");
      expect(result.content).not.toContain("live-secret-token-270");
      expect(fake.callCalls()).toBe(1);
    } finally {
      await runtime.close();
    }
  });

  test(`Given cancellation reaches a call after dispatch begins,
    When the transport aborts,
    Then the same signal is forwarded and the mutation outcome remains explicit`, async () => {
    // Given
    const catalog = await fakeCatalog([
      {
        name: "search",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      },
    ]);
    const controller = new AbortController();
    let receivedSignal: AbortSignal | null = null;
    const fake = fakeConnectionFactory({
      catalogs: [catalog],
      callTool: async (_toolName, _arguments, signal) => {
        receivedSignal = signal;
        controller.abort(new Error("user interrupted"));
        throw controller.signal.reason;
      },
    });
    const runtime = runtimeWithFactory({
      connectionFactory: fake.factory,
    });
    const toolCall = await activateExactSearch(runtime);

    try {
      // When
      const result = await runtime.execute(toolCall, controller.signal);

      // Then
      expect(receivedSignal).toBe(controller.signal);
      expect(result.ok).toBe(false);
      expect(result.content).toContain("outcome is uncertain");
      expect(fake.callCalls()).toBe(1);
    } finally {
      await runtime.close();
    }
  });

  test(`Given a remote tool declares an output schema but returns invalid structured data,
    When the call result crosses the SDK adapter boundary,
    Then Keel preserves the response but marks it as an external execution failure`, async () => {
    // Given
    const catalog = await fakeCatalog([
      {
        name: "search",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
        outputSchema: {
          type: "object",
          properties: { matches: { type: "integer" } },
          required: ["matches"],
        },
      },
    ]);
    const invalidResult: McpWireToolResult = {
      content: [{ type: "text", text: "server claimed success" }],
      structuredContent: { matches: "one" },
    };
    const fake = fakeConnectionFactory({
      catalogs: [catalog],
      callTool: async () => invalidResult,
    });
    const runtime = runtimeWithFactory({
      connectionFactory: fake.factory,
    });

    try {
      // When
      const result = await runtime.execute(
        await activateExactSearch(runtime),
        new AbortController().signal,
      );

      // Then
      expect(result.ok).toBe(false);
      expect(result.content).toContain("declared MCP output schema");
      expectIdentifiedMcpResult(result);
      expect(result.preserved.value).toEqual(invalidResult);
      expect(fake.callCalls()).toBe(1);
    } finally {
      await runtime.close();
    }
  });

  test(`Given a remote tool returns structured data accepted by its declared output schema,
    When the SDK validator crosses the execution boundary,
    Then the call remains successful with no synthetic validation issues`, async () => {
    // Given
    const catalog = await fakeCatalog([
      {
        name: "search",
        inputSchema: { type: "object", properties: {} },
        outputSchema: {
          type: "object",
          properties: { matches: { type: "integer" } },
          required: ["matches"],
        },
      },
    ]);
    const fake = fakeConnectionFactory({
      catalogs: [catalog],
      callTool: async () => ({
        content: [],
        structuredContent: { matches: 1 },
      }),
    });
    const runtime = runtimeWithFactory({ connectionFactory: fake.factory });

    try {
      // When
      const result = await runtime.execute(
        await activateExactSearch(runtime),
        new AbortController().signal,
      );

      // Then
      expect(result.ok).toBe(true);
      expect(result.content).toContain('"matches":1');
    } finally {
      await runtime.close();
    }
  });

  test(`Given mainstream MCP schemas combine unions, type arrays, literal domains, validation constraints, and dynamic maps,
    When the current provider compiles and invokes the tool,
    Then structural meaning reaches the model while the original schema remains the dispatch authority`, async () => {
    // Given
    const catalog = await fakeCatalog([
      {
        name: "mainstream",
        inputSchema: {
          type: "object",
          properties: {
            repoName: {
              anyOf: [
                { type: "string" },
                { type: "array", items: { type: "string" } },
              ],
            },
            labels: {
              type: "array",
              items: {
                oneOf: [
                  { type: "string" },
                  {
                    type: "object",
                    properties: { name: { type: "string" } },
                    required: ["name"],
                    additionalProperties: false,
                  },
                ],
              },
            },
            skip: { type: ["integer", "null"] },
            confirmed: { type: "boolean", enum: [true] },
            mode: { const: "read" },
            metadata: {
              type: "object",
              propertyNames: { pattern: "^[a-z]+$" },
              minProperties: 1,
              maxProperties: 3,
              additionalProperties: { type: "string" },
            },
            slug: {
              type: "string",
              minLength: 3,
              maxLength: 20,
              pattern: "^[a-z]+$",
            },
            limit: { type: "integer", exclusiveMinimum: 0 },
            tags: {
              type: "array",
              items: { type: "string" },
              contains: { const: "mcp" },
              minItems: 1,
              uniqueItems: true,
            },
          },
          required: [
            "repoName",
            "labels",
            "skip",
            "confirmed",
            "mode",
            "metadata",
            "slug",
            "limit",
            "tags",
          ],
          additionalProperties: false,
        },
      },
    ]);
    const fake = fakeConnectionFactory({ catalogs: [catalog] });
    const runtime = runtimeWithFactory({ connectionFactory: fake.factory });
    const signal = new AbortController().signal;

    try {
      const search = await runtime.search(
        { query: "unused", server: "catalog", tool: "mainstream" },
        signal,
      );
      const exposed = exposedToolCall(runtime);

      // When
      const invalid = await runtime.execute(
        {
          ...exposed,
          arguments: {
            repoName: ["acmerfight/keel"],
            labels: [{ name: "bug" }],
            skip: null,
            confirmed: true,
            mode: "read",
            metadata: { team: "harness" },
            slug: "UP",
            limit: 0,
            tags: [],
          },
        },
        signal,
      );
      const valid = await runtime.execute(
        {
          ...exposed,
          arguments: {
            repoName: ["acmerfight/keel"],
            labels: [{ name: "bug" }],
            skip: null,
            confirmed: true,
            mode: "read",
            metadata: { team: "harness" },
            slug: "keel",
            limit: 1,
            tags: ["mcp"],
          },
        },
        signal,
      );

      // Then
      expect(runtime.exposureSnapshot().tools[0]?.parameters).toEqual({
        type: "object",
        properties: {
          repoName: {
            anyOf: [
              { type: "string" },
              { type: "array", items: { type: "string" } },
            ],
          },
          labels: {
            type: "array",
            items: {
              oneOf: [
                { type: "string" },
                {
                  type: "object",
                  properties: { name: { type: "string" } },
                  required: ["name"],
                  additionalProperties: false,
                },
              ],
            },
          },
          skip: { type: ["integer", "null"] },
          confirmed: { type: "boolean", enum: [true] },
          mode: { const: "read" },
          metadata: {
            type: "object",
            additionalProperties: { type: "string" },
          },
          slug: { type: "string" },
          limit: { type: "integer" },
          tags: { type: "array", items: { type: "string" } },
        },
        required: [
          "repoName",
          "labels",
          "skip",
          "confirmed",
          "mode",
          "metadata",
          "slug",
          "limit",
          "tags",
        ],
        additionalProperties: false,
      });
      expect(search.content).toContain(
        "1 provider-usable for deepseek/deepseek-v4-flash",
      );
      expect(search.content).toContain("Provider schema validation widening:");
      expect(invalid.ok).toBe(false);
      expect(invalid.content).toContain("original server JSON Schema");
      expect(valid.ok).toBe(true);
      expect(fake.callCalls()).toBe(1);
    } finally {
      await runtime.close();
    }
  });

  test(`Given oneOf branches can overlap after provider-only validation constraints are omitted,
    When the provider compiler widens the schema,
    Then it lowers exclusivity to anyOf while original oneOf validation still gates dispatch`, async () => {
    // Given
    const catalog = await fakeCatalog([
      {
        name: "exclusive_choice",
        inputSchema: {
          type: "object",
          properties: {
            "value.oneOf[0]": {
              type: "string",
              maxLength: 3,
            },
            "value.oneOf[1]": {
              type: "string",
              minLength: 2,
            },
            value: {
              oneOf: [
                { type: "string", maxLength: 3 },
                { type: "string", minLength: 2 },
              ],
            },
          },
          required: ["value"],
          additionalProperties: false,
        },
      },
    ]);
    const fake = fakeConnectionFactory({ catalogs: [catalog] });
    const runtime = runtimeWithFactory({ connectionFactory: fake.factory });
    const signal = new AbortController().signal;

    try {
      const search = await runtime.search(
        {
          query: "unused",
          server: "catalog",
          tool: "exclusive_choice",
        },
        signal,
      );
      const exposed = exposedToolCall(runtime);

      // When
      const overlapping = await runtime.execute(
        { ...exposed, arguments: { value: "ab" } },
        signal,
      );
      const exclusive = await runtime.execute(
        { ...exposed, arguments: { value: "" } },
        signal,
      );

      // Then
      expect(runtime.exposureSnapshot().tools[0]?.parameters).toEqual({
        type: "object",
        properties: {
          "value.oneOf[0]": { type: "string" },
          "value.oneOf[1]": { type: "string" },
          value: {
            anyOf: [{ type: "string" }, { type: "string" }],
          },
        },
        required: ["value"],
        additionalProperties: false,
      });
      expect(search.content).toContain(
        "lowered inputSchema.properties.value.oneOf to anyOf",
      );
      expect(overlapping.ok).toBe(false);
      expect(overlapping.content).toContain("original server JSON Schema");
      expect(exclusive.ok).toBe(true);
      expect(fake.callCalls()).toBe(1);
    } finally {
      await runtime.close();
    }
  });

  test.each([
    [
      "successful empty",
      { content: [] },
      true,
      "returned no model-visible content",
    ],
    [
      "empty protocol error",
      { content: [], isError: true },
      false,
      "reported an error without model-visible content",
    ],
    [
      "blank text block",
      { content: [{ type: "text", text: "" }] },
      true,
      "returned no model-visible content",
    ],
  ] satisfies readonly [string, McpWireToolResult, boolean, string][])(
    `Given a remote tool returns a %s result,
    When the total result adapter handles zero content blocks,
    Then a non-empty provider-valid tool message is produced`,
    async (_caseName, wireResult, expectedOk, expectedContent) => {
      // Given
      const catalog = await fakeCatalog([
        {
          name: "search",
          inputSchema: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
          },
        },
      ]);
      const fake = fakeConnectionFactory({
        catalogs: [catalog],
        callTool: async () => wireResult,
      });
      const runtime = runtimeWithFactory({
        connectionFactory: fake.factory,
      });

      try {
        // When
        const result = await runtime.execute(
          await activateExactSearch(runtime),
          new AbortController().signal,
        );

        // Then
        expect(result.ok).toBe(expectedOk);
        expect(result.content).toContain(expectedContent);
        expect(result.content.length).toBeGreaterThan(0);
      } finally {
        await runtime.close();
      }
    },
  );

  test(`Given an MCP result contains text, structured data, media, and private metadata,
    When it is adapted for the agent,
    Then model text is bounded separately while the complete rich result is preserved for an artifact`, async () => {
    // Given
    const catalog = await fakeCatalog([
      {
        name: "search",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      },
    ]);
    const richResult: McpWireToolResult = {
      content: [
        { type: "text", text: "visible text" },
        {
          type: "image",
          data: "aGVsbG8=",
          mimeType: "image/png",
        },
        {
          type: "audio",
          data: "aGVsbG8=",
          mimeType: "audio/wav",
        },
        {
          type: "resource_link",
          uri: "https://catalog.example/result/1",
          name: "result",
        },
        {
          type: "resource",
          resource: {
            uri: "https://catalog.example/result/1.txt",
            text: "embedded resource",
          },
        },
      ],
      structuredContent: { matches: 1 },
      _meta: { privateWidgetState: "must-not-enter-model-text" },
    };
    const fake = fakeConnectionFactory({
      catalogs: [catalog],
      callTool: async () => richResult,
    });
    const runtime = runtimeWithFactory({
      connectionFactory: fake.factory,
    });

    try {
      // When
      const result = await runtime.execute(
        await activateExactSearch(runtime),
        new AbortController().signal,
      );

      // Then
      expect(result.ok).toBe(true);
      expect(result.content).toContain("visible text");
      expect(result.content).toContain('{"matches":1}');
      expect(result.content).toContain("image, audio, resource_link, resource");
      expect(result.content).not.toContain("privateWidgetState");
      expect(result.content).not.toContain("must-not-enter-model-text");
      expectIdentifiedMcpResult(result);
      expect(result.preserved.value).toEqual(richResult);
      expect(result.artifact?.content).toBe(JSON.stringify(richResult));
    } finally {
      await runtime.close();
    }
  });

  test(`Given private MCP metadata exceeds the bounded in-memory evidence record,
    When the rich result is adapted,
    Then the audit effect keeps a digest summary and the full JSON is routed to the artifact boundary`, async () => {
    // Given
    const catalog = await fakeCatalog([
      {
        name: "search",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      },
    ]);
    const largeResult: McpWireToolResult = {
      content: [{ type: "text", text: "small visible result" }],
      _meta: { privateState: "x".repeat(300_000) },
    };
    const fake = fakeConnectionFactory({
      catalogs: [catalog],
      callTool: async () => largeResult,
    });
    const runtime = runtimeWithFactory({
      connectionFactory: fake.factory,
    });

    try {
      // When
      const result = await runtime.execute(
        await activateExactSearch(runtime),
        new AbortController().signal,
      );

      // Then
      expect(result.content).toBe("small visible result");
      expectIdentifiedMcpResult(result);
      expect(result.preserved.valueTruncated).toBe(true);
      expect(result.preserved.value).toMatchObject({
        error: "MCP result exceeded the preserved evidence limit",
      });
      expect(result.preserved.valueBytes).toBeGreaterThan(300_000);
      expect(result.preserved.valueSha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(result.artifact?.content).toBe(JSON.stringify(largeResult));
    } finally {
      await runtime.close();
    }
  });

  test(`Given MCP tools have degenerate local reference loops and another has structural recursion,
    When catalog validation compiles their original schemas,
    Then only the degenerate loops are quarantined with precise reference-cycle diagnostics`, async () => {
    // Given
    const depthBoundaryDefinitions: Record<string, { readonly $ref: string }> =
      {};
    for (
      let index = 0;
      index < MCP_PROVIDER_SCHEMA_REFERENCE_LIMITS.maxDepth;
      index += 1
    ) {
      depthBoundaryDefinitions[`c${index}`] = {
        $ref: `#/$defs/c${(index + 1) % MCP_PROVIDER_SCHEMA_REFERENCE_LIMITS.maxDepth}`,
      };
    }
    const tools = [
      {
        name: "degenerate_cycle",
        inputSchema: {
          type: "object",
          const: { $ref: "#/$defs/A" },
          properties: { issue: { $ref: "#/$defs/A" } },
          $defs: {
            A: { $ref: "#/$defs/B" },
            B: { $ref: "#/$defs/A" },
          },
        },
      },
      {
        name: "degenerate_output_cycle",
        inputSchema: { type: "object" },
        outputSchema: {
          type: "object",
          properties: { result: { $ref: "#/$defs/c0" } },
          $defs: depthBoundaryDefinitions,
        },
      },
      {
        name: "structural_recursion",
        inputSchema: {
          type: "object",
          properties: { node: { $ref: "#/$defs/Node" } },
          $defs: {
            Node: {
              type: "object",
              properties: { child: { $ref: "#/$defs/Node" } },
            },
          },
        },
      },
    ];

    // When
    const catalog = await fakeCatalog(tools);

    // Then
    expect(catalog.summary).toMatchObject({
      total: 3,
      valid: 1,
      quarantined: 2,
      issues: [
        {
          tool: "degenerate_cycle",
          reason:
            'invalid JSON Schema: local $ref chain forms a cycle through "#/$defs/A" after 2 unique references at inputSchema.properties.issue.$ref',
        },
        {
          tool: "degenerate_output_cycle",
          reason:
            'invalid JSON Schema: local $ref chain forms a cycle through "#/$defs/c0" after 16 unique references at outputSchema.properties.result.$ref',
        },
      ],
    });
    for (const issue of catalog.summary.issues) {
      expect(issue.reason).not.toContain("Maximum call stack size exceeded");
    }
    expect(catalog.tools.map((tool) => tool.descriptor.name)).toEqual([
      "structural_recursion",
    ]);
  });

  test(`Given ref-shaped data appears outside schema positions and schema positions are mixed,
    When degenerate local reference diagnosis scans the typed schema,
    Then it follows only schema-bearing keywords and returns null when no loop exists`, () => {
    // Given
    const schemaWithoutCycle = {
      type: "object",
      properties: {
        unresolved: { $ref: "#/$defs/Missing" },
      },
      patternProperties: [],
      allOf: {},
      additionalProperties: true,
      items: [{ type: "string" }],
    };
    const schemaWithComposedCycle = {
      type: "object",
      const: { $ref: "#/$defs/A" },
      allOf: [{ $ref: "#/$defs/A" }],
      $defs: {
        A: { $ref: "#/$defs/B" },
        B: { $ref: "#/$defs/A" },
      },
    };

    // When
    const noCycle = scanMcpDegenerateLocalReferenceCycle(
      schemaWithoutCycle,
      "inputSchema",
      MCP_LOCAL_REFERENCE_CYCLE_SCAN_LIMITS,
    );
    const composedCycle = scanMcpDegenerateLocalReferenceCycle(
      schemaWithComposedCycle,
      "outputSchema",
      MCP_LOCAL_REFERENCE_CYCLE_SCAN_LIMITS,
    );

    // Then
    expect(noCycle).toEqual({ status: "not-found" });
    expect(composedCycle).toEqual({
      status: "cycle",
      diagnostic:
        'local $ref chain forms a cycle through "#/$defs/A" after 2 unique references at outputSchema.allOf[0].$ref',
    });
  });

  test(`Given degenerate reference diagnosis reaches either typed scan budget,
    When it scans an untrusted schema,
    Then it returns budget-exceeded without constructing a partial cycle diagnostic`, () => {
    // Given
    const referenceChain = {
      type: "object",
      properties: { value: { $ref: "#/$defs/A" } },
      $defs: {
        A: { $ref: "#/$defs/B" },
        B: { $ref: "#/$defs/A" },
      },
    };
    const nestedSchemaNodes = {
      type: "object",
      properties: { value: { type: "string" } },
    };

    // When
    const referenceBudget = scanMcpDegenerateLocalReferenceCycle(
      referenceChain,
      "inputSchema",
      {
        maxReferenceSteps: 1,
        maxScannedSchemaNodes: 16,
      },
    );
    const nodeBudget = scanMcpDegenerateLocalReferenceCycle(
      nestedSchemaNodes,
      "outputSchema",
      {
        maxReferenceSteps: 16,
        maxScannedSchemaNodes: 1,
      },
    );

    // Then
    expect(referenceBudget).toEqual({ status: "budget-exceeded" });
    expect(nodeBudget).toEqual({ status: "budget-exceeded" });
  });

  test(`Given provider schema lowering receives malformed JSON Schema values,
    When it compiles at the MCP boundary,
    Then each invalid structural branch returns a precise fail-closed diagnostic`, () => {
    // Given
    const cases = [
      [
        "invalid type array",
        {
          type: "object",
          properties: { value: { type: ["string", "void"] } },
        },
        "inputSchema.properties.value.type must contain supported JSON Schema types",
      ],
      [
        "invalid scalar type",
        { type: "object", properties: { value: { type: "void" } } },
        "inputSchema.properties.value.type must be a supported JSON Schema type",
      ],
      [
        "invalid oneOf branch",
        {
          type: "object",
          properties: { value: { oneOf: [{ type: "string" }, true] } },
        },
        "inputSchema.properties.value.oneOf[1] must be a JSON Schema object",
      ],
      [
        "non-object root type",
        { type: "array", items: { type: "string" } },
        "inputSchema.type must be object for an MCP tool input schema",
      ],
      [
        "non-object properties",
        { type: "object", properties: [] },
        "inputSchema.properties must be a JSON Schema object",
      ],
      [
        "invalid required entries",
        { type: "object", properties: {}, required: ["value", 1] },
        "inputSchema.required must contain only strings",
      ],
      [
        "invalid additionalProperties schema",
        { type: "object", additionalProperties: [] },
        "inputSchema.additionalProperties must be a JSON Schema object",
      ],
      [
        "invalid enum container",
        { type: "object", properties: { value: { enum: "left" } } },
        "inputSchema.properties.value.enum must be an array",
      ],
      [
        "invalid const value",
        { type: "object", const: undefined },
        "inputSchema.const must be a JSON value",
      ],
      [
        "invalid minimum",
        {
          type: "object",
          properties: { value: { type: "number", minimum: "one" } },
        },
        "inputSchema.properties.value.minimum must be numeric",
      ],
      [
        "invalid maximum",
        {
          type: "object",
          properties: { value: { type: "number", maximum: "ten" } },
        },
        "inputSchema.properties.value.maximum must be numeric",
      ],
    ] satisfies readonly [string, unknown, string][];

    for (const [_caseName, inputSchema, reason] of cases) {
      // When
      const result = compileMcpProviderInputSchema(inputSchema, {
        target: testSchemaTarget,
        referenceLimits: MCP_PROVIDER_SCHEMA_REFERENCE_LIMITS,
      });

      // Then
      expect(result).toEqual({ ok: false, reason });
    }
  });

  test(`Given provider schema lowering receives schema-valued maps and overlapping widened oneOf branches,
    When it compiles the provider projection,
    Then map value schemas are preserved and unsafe exclusivity is rejected with a diagnostic`, () => {
    // When
    const implicitRootObject = compileMcpProviderInputSchema(
      { properties: { query: { type: "string" } } },
      {
        target: testSchemaTarget,
        referenceLimits: MCP_PROVIDER_SCHEMA_REFERENCE_LIMITS,
      },
    );
    const dynamicMap = compileMcpProviderInputSchema(
      {
        type: "object",
        properties: {
          metadata: {
            type: "object",
            additionalProperties: { type: "string" },
          },
        },
        required: ["metadata"],
      },
      {
        target: testSchemaTarget,
        referenceLimits: MCP_PROVIDER_SCHEMA_REFERENCE_LIMITS,
      },
    );
    const unsafeComposition = compileMcpProviderInputSchema(
      {
        type: "object",
        properties: {
          value: {
            anyOf: [{ type: "number" }],
            oneOf: [
              { type: "string", maxLength: 3 },
              { type: "string", minLength: 2 },
            ],
          },
        },
      },
      {
        target: testSchemaTarget,
        referenceLimits: MCP_PROVIDER_SCHEMA_REFERENCE_LIMITS,
      },
    );

    // Then
    expect(implicitRootObject).toMatchObject({
      ok: true,
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: [],
      },
    });
    expect(dynamicMap).toMatchObject({
      ok: true,
      parameters: {
        properties: {
          metadata: {
            type: "object",
            additionalProperties: { type: "string" },
          },
        },
      },
    });
    expect(unsafeComposition).toEqual({
      ok: false,
      reason:
        "inputSchema.properties.value combines anyOf with a validation-widened oneOf and cannot be safely projected",
    });
  });

  test(`Given GitHub, Sentry, and Notion-shaped schemas use repeated local definitions,
    When provider schema lowering resolves their nested references,
    Then the provider projection preserves every supported structural position`, () => {
    // Given
    const schema = {
      type: "object",
      properties: {
        issue: {
          $ref: "#/$defs/Issue~1Payload",
          description: "Issue payload",
        },
        relatedIssues: {
          type: "array",
          items: { $ref: "#/$defs/Issue~1Payload" },
        },
        event: {
          oneOf: [{ $ref: "#/definitions/Event" }, { type: "null" }],
        },
        metadata: {
          type: "object",
          additionalProperties: { $ref: "#/$defs/MetadataValue" },
        },
        selectedLabel: { $ref: "#/$defs/Label/oneOf/1" },
      },
      required: ["issue"],
      additionalProperties: false,
      $defs: {
        "Issue/Payload": {
          type: "object",
          properties: {
            title: { type: "string" },
            labels: {
              type: "array",
              items: {
                anyOf: [{ $ref: "#/$defs/Label" }, { type: "null" }],
              },
            },
          },
          required: ["title"],
          additionalProperties: false,
        },
        Label: {
          oneOf: [{ const: "bug" }, { const: "feature" }],
        },
        MetadataValue: {
          anyOf: [{ type: "string" }, { type: "number" }],
        },
      },
      definitions: {
        Event: {
          type: "object",
          properties: {
            id: { type: "string" },
          },
          required: ["id"],
        },
      },
    };

    // When
    const result = compileMcpProviderInputSchema(schema, {
      target: testSchemaTarget,
      referenceLimits: MCP_PROVIDER_SCHEMA_REFERENCE_LIMITS,
    });

    // Then
    expect(result).toEqual({
      ok: true,
      fidelity: "exact",
      parameters: {
        type: "object",
        properties: {
          issue: {
            type: "object",
            description: "Issue payload",
            properties: {
              title: { type: "string" },
              labels: {
                type: "array",
                items: {
                  anyOf: [
                    {
                      oneOf: [{ const: "bug" }, { const: "feature" }],
                    },
                    { type: "null" },
                  ],
                },
              },
            },
            required: ["title"],
            additionalProperties: false,
          },
          relatedIssues: {
            type: "array",
            items: {
              type: "object",
              properties: {
                title: { type: "string" },
                labels: {
                  type: "array",
                  items: {
                    anyOf: [
                      {
                        oneOf: [{ const: "bug" }, { const: "feature" }],
                      },
                      { type: "null" },
                    ],
                  },
                },
              },
              required: ["title"],
              additionalProperties: false,
            },
          },
          event: {
            oneOf: [
              {
                type: "object",
                properties: { id: { type: "string" } },
                required: ["id"],
              },
              { type: "null" },
            ],
          },
          metadata: {
            type: "object",
            additionalProperties: {
              anyOf: [{ type: "string" }, { type: "number" }],
            },
          },
          selectedLabel: { const: "feature" },
        },
        required: ["issue"],
        additionalProperties: false,
      },
      validationWideningDiagnostics: [],
    });
  });

  test(`Given URI fragments use percent encoding and JSON Pointer escaping,
    When provider schema lowering resolves local references,
    Then percent decoding happens before pointer token interpretation`, () => {
    // Given
    const schema = {
      type: "object",
      properties: {
        percentEncodedSlash: { $ref: "#/$defs/a%2Fb" },
        pointerEscapedSlash: { $ref: "#/$defs/a~1b" },
        percentEncodedTilde: { $ref: "#/$defs/x%7E1y" },
        pointerEscapedTilde: { $ref: "#/$defs/x~01y" },
      },
      $defs: {
        a: { b: { type: "string" } },
        "a/b": { type: "integer" },
        "x/y": { type: "boolean" },
        "x~1y": { type: "number" },
      },
    };

    // When
    const result = compileMcpProviderInputSchema(schema, {
      target: testSchemaTarget,
      referenceLimits: MCP_PROVIDER_SCHEMA_REFERENCE_LIMITS,
    });

    // Then
    expect(result).toMatchObject({
      ok: true,
      parameters: {
        properties: {
          percentEncodedSlash: { type: "string" },
          pointerEscapedSlash: { type: "integer" },
          percentEncodedTilde: { type: "boolean" },
          pointerEscapedTilde: { type: "number" },
        },
      },
    });
  });

  test(`Given local schema references exceed an explicit expansion bound,
    When provider schema lowering resolves the reference,
    Then it fails closed with the bound that was exceeded`, () => {
    // Given
    const cases = [
      {
        schema: {
          type: "object",
          properties: { value: { $ref: "#/$defs/A" } },
          $defs: {
            A: { $ref: "#/$defs/B" },
            B: { type: "string" },
          },
        },
        referenceLimits: {
          maxDepth: 1,
          maxExpandedNodes: 1_024,
          maxExpandedBytes: 64 * 1_024,
        },
        diagnostic: "exceeds the local reference depth limit of 1",
      },
      {
        schema: {
          type: "object",
          properties: { value: { $ref: "#/$defs/Container" } },
          $defs: {
            Container: {
              type: "object",
              properties: { child: { type: "string" } },
            },
          },
        },
        referenceLimits: {
          maxDepth: 16,
          maxExpandedNodes: 1,
          maxExpandedBytes: 64 * 1_024,
        },
        diagnostic: "exceeds the expanded schema node limit of 1",
      },
      {
        schema: {
          type: "object",
          properties: { value: { $ref: "#/$defs/Value" } },
          $defs: {
            Value: { type: "string", description: "expanded value" },
          },
        },
        referenceLimits: {
          maxDepth: 16,
          maxExpandedNodes: 1_024,
          maxExpandedBytes: 1,
        },
        diagnostic: "exceeds the expanded schema byte limit of 1",
      },
      {
        schema: {
          type: "object",
          properties: {
            first: { $ref: "#/$defs/Container" },
            second: { $ref: "#/$defs/Container" },
          },
          $defs: {
            Container: {
              type: "object",
              properties: { child: { type: "string" } },
            },
          },
        },
        referenceLimits: {
          maxDepth: 16,
          maxExpandedNodes: 3,
          maxExpandedBytes: 64 * 1_024,
        },
        diagnostic:
          'inputSchema.properties.second.$ref("#/$defs/Container").properties.child exceeds the expanded schema node limit of 3',
      },
      {
        schema: {
          type: "object",
          properties: {
            first: { $ref: "#/$defs/Value" },
            second: { $ref: "#/$defs/Value" },
          },
          $defs: {
            Value: { type: "string", description: "repeated value" },
          },
        },
        referenceLimits: {
          maxDepth: 16,
          maxExpandedNodes: 1_024,
          maxExpandedBytes: 60,
        },
        diagnostic:
          "inputSchema.properties.second.$ref exceeds the expanded schema byte limit of 60",
      },
    ];

    for (const testCase of cases) {
      // When
      const result = compileMcpProviderInputSchema(testCase.schema, {
        target: testSchemaTarget,
        referenceLimits: testCase.referenceLimits,
      });

      // Then
      expect(result).toMatchObject({
        ok: false,
        reason: expect.stringContaining(testCase.diagnostic),
      });
    }
  });

  test(`Given local references exceed the production depth, node, or byte limit,
    When provider schema lowering uses the shipped reference limits,
    Then each expansion bomb is rejected by its production bound`, () => {
    // Given
    const depthDefinitions: Record<string, McpJsonValue> = {};
    for (
      let index = 0;
      index <= MCP_PROVIDER_SCHEMA_REFERENCE_LIMITS.maxDepth;
      index += 1
    ) {
      depthDefinitions[`Level${index}`] =
        index === MCP_PROVIDER_SCHEMA_REFERENCE_LIMITS.maxDepth
          ? { type: "string" }
          : { $ref: `#/$defs/Level${index + 1}` };
    }
    const nodeProperties = Object.fromEntries(
      Array.from(
        { length: MCP_PROVIDER_SCHEMA_REFERENCE_LIMITS.maxExpandedNodes },
        (_, index) => [`value${index}`, { const: null }],
      ),
    );
    const repeatedEnum = Array.from(
      { length: 512 },
      (_, index) => `${index}-${"x".repeat(64)}`,
    );
    const cases = [
      {
        schema: {
          type: "object",
          properties: { value: { $ref: "#/$defs/Level0" } },
          $defs: depthDefinitions,
        },
        diagnostic: `exceeds the local reference depth limit of ${MCP_PROVIDER_SCHEMA_REFERENCE_LIMITS.maxDepth}`,
      },
      {
        schema: {
          type: "object",
          properties: { value: { $ref: "#/$defs/Container" } },
          $defs: {
            Container: {
              type: "object",
              properties: nodeProperties,
            },
          },
        },
        diagnostic: `exceeds the expanded schema node limit of ${MCP_PROVIDER_SCHEMA_REFERENCE_LIMITS.maxExpandedNodes}`,
      },
      {
        schema: {
          type: "object",
          properties: {
            first: { $ref: "#/$defs/Value" },
            second: { $ref: "#/$defs/Value" },
          },
          $defs: {
            Value: {
              type: "string",
              enum: repeatedEnum,
            },
          },
        },
        diagnostic: `exceeds the expanded schema byte limit of ${MCP_PROVIDER_SCHEMA_REFERENCE_LIMITS.maxExpandedBytes}`,
      },
    ];

    for (const testCase of cases) {
      // When
      const result = compileMcpProviderInputSchema(testCase.schema, {
        target: testSchemaTarget,
        referenceLimits: MCP_PROVIDER_SCHEMA_REFERENCE_LIMITS,
      });

      // Then
      expect(result).toMatchObject({
        ok: false,
        reason: expect.stringContaining(testCase.diagnostic),
      });
    }
  });

  test(`Given a tool publishes an unsafe or unresolvable schema reference,
    When provider schema lowering parses the external boundary,
    Then it rejects the reference without network or filesystem resolution`, () => {
    // Given
    const cases = [
      {
        reference: 42,
        definitions: {},
        diagnostic: "$ref must be a string",
      },
      {
        reference: "https://schemas.example/Issue.json",
        definitions: {},
        diagnostic: "$ref must be a same-document JSON Pointer",
      },
      {
        reference: "file:///tmp/Issue.json",
        definitions: {},
        diagnostic: "$ref must be a same-document JSON Pointer",
      },
      {
        reference: "#Issue",
        definitions: {},
        diagnostic: "$ref must be a same-document JSON Pointer",
      },
      {
        reference: "#/$defs/Missing",
        definitions: {},
        diagnostic: 'cannot resolve local reference "#/$defs/Missing"',
      },
      {
        reference: "#/$defs/%ZZ",
        definitions: {},
        diagnostic: "$ref contains invalid percent encoding",
      },
      {
        reference: "#/$defs/Bad~2Escape",
        definitions: {},
        diagnostic: "$ref contains an invalid JSON Pointer escape",
      },
      {
        reference: "#/$defs/__proto__",
        definitions: {},
        diagnostic: 'cannot resolve local reference "#/$defs/__proto__"',
      },
      ...["constructor", "toString", "valueOf", "hasOwnProperty"].map(
        (propertyName) => ({
          reference: `#/$defs/${propertyName}`,
          definitions: {},
          diagnostic: `cannot resolve local reference "#/$defs/${propertyName}"`,
        }),
      ),
      {
        reference: "#/$defs/Choice/oneOf/not-an-index",
        definitions: {
          Choice: {
            oneOf: [{ const: "left" }, { const: "right" }],
          },
        },
        diagnostic:
          'cannot resolve local reference "#/$defs/Choice/oneOf/not-an-index"',
      },
      {
        reference: "#/$defs/Choice/oneOf/9",
        definitions: {
          Choice: {
            oneOf: [{ const: "left" }, { const: "right" }],
          },
        },
        diagnostic: 'cannot resolve local reference "#/$defs/Choice/oneOf/9"',
      },
      {
        reference: "#/$defs/Value/type/child",
        definitions: {
          Value: { type: "string" },
        },
        diagnostic: 'cannot resolve local reference "#/$defs/Value/type/child"',
      },
    ];

    for (const testCase of cases) {
      // When
      const result = compileMcpProviderInputSchema(
        {
          type: "object",
          properties: { issue: { $ref: testCase.reference } },
          $defs: testCase.definitions,
        },
        {
          target: testSchemaTarget,
          referenceLimits: MCP_PROVIDER_SCHEMA_REFERENCE_LIMITS,
        },
      );

      // Then
      expect(result).toMatchObject({
        ok: false,
        reason: expect.stringContaining(testCase.diagnostic),
      });
    }

    const cycle = compileMcpProviderInputSchema(
      {
        type: "object",
        properties: { issue: { $ref: "#/$defs/Issue" } },
        $defs: { Issue: { $ref: "#/$defs/Issue" } },
      },
      {
        target: testSchemaTarget,
        referenceLimits: MCP_PROVIDER_SCHEMA_REFERENCE_LIMITS,
      },
    );
    const structuralSibling = compileMcpProviderInputSchema(
      {
        type: "object",
        properties: {
          issue: {
            $ref: "#/$defs/Issue",
            type: "string",
          },
        },
        $defs: { Issue: { type: "string" } },
      },
      {
        target: testSchemaTarget,
        referenceLimits: MCP_PROVIDER_SCHEMA_REFERENCE_LIMITS,
      },
    );
    const validationSibling = compileMcpProviderInputSchema(
      {
        type: "object",
        properties: {
          issue: {
            $ref: "#/$defs/Issue",
            minLength: 3,
          },
        },
        $defs: { Issue: { type: "string" } },
      },
      {
        target: testSchemaTarget,
        referenceLimits: MCP_PROVIDER_SCHEMA_REFERENCE_LIMITS,
      },
    );
    const unknownStructuralSibling = compileMcpProviderInputSchema(
      {
        type: "object",
        properties: {
          issue: {
            $ref: "#/$defs/Issue",
            allOf: [{ type: "string" }],
          },
        },
        $defs: { Issue: { type: "string" } },
      },
      {
        target: testSchemaTarget,
        referenceLimits: MCP_PROVIDER_SCHEMA_REFERENCE_LIMITS,
      },
    );
    const rootReference = compileMcpProviderInputSchema(
      {
        type: "object",
        properties: { self: { $ref: "#" } },
      },
      {
        target: testSchemaTarget,
        referenceLimits: MCP_PROVIDER_SCHEMA_REFERENCE_LIMITS,
      },
    );
    const invalidRoot = compileMcpProviderInputSchema(null, {
      target: testSchemaTarget,
      referenceLimits: MCP_PROVIDER_SCHEMA_REFERENCE_LIMITS,
    });
    const strippedProtoDefinitionReference = compileMcpProviderInputSchema(
      JSON.parse(
        '{"type":"object","properties":{"issue":{"$ref":"#/$defs/__proto__"}},"$defs":{"__proto__":{"type":"string"}}}',
      ),
      {
        target: testSchemaTarget,
        referenceLimits: MCP_PROVIDER_SCHEMA_REFERENCE_LIMITS,
      },
    );
    const definedConstructorReference = compileMcpProviderInputSchema(
      {
        type: "object",
        properties: { issue: { $ref: "#/$defs/constructor" } },
        $defs: { constructor: { type: "string" } },
      },
      {
        target: testSchemaTarget,
        referenceLimits: MCP_PROVIDER_SCHEMA_REFERENCE_LIMITS,
      },
    );
    expect(cycle).toMatchObject({
      ok: false,
      reason: expect.stringContaining("forms a cycle through"),
    });
    expect(structuralSibling).toMatchObject({
      ok: false,
      reason: expect.stringContaining(
        "type cannot be safely combined with $ref",
      ),
    });
    expect(validationSibling).toEqual({
      ok: true,
      fidelity: "validation-widened",
      parameters: {
        type: "object",
        properties: { issue: { type: "string" } },
        required: [],
      },
      validationWideningDiagnostics: [
        "omitted inputSchema.properties.issue.minLength",
      ],
    });
    expect(unknownStructuralSibling).toMatchObject({
      ok: false,
      reason: expect.stringContaining(
        "allOf changes structure and is not supported",
      ),
    });
    expect(rootReference).toMatchObject({
      ok: false,
      reason: expect.stringContaining('forms a cycle through "#"'),
    });
    expect(invalidRoot).toEqual({
      ok: false,
      reason: "inputSchema must be a JSON Schema object",
    });
    expect(strippedProtoDefinitionReference).toEqual({
      ok: false,
      reason:
        'inputSchema.properties.issue.$ref cannot resolve local reference "#/$defs/__proto__"',
    });
    expect(definedConstructorReference).toMatchObject({
      ok: true,
      parameters: {
        properties: { issue: { type: "string" } },
      },
    });
  });

  test(`Given a referenced MCP input keeps a validation-only constraint,
    When the model calls the provider-visible projection with invalid arguments,
    Then the untouched original schema rejects dispatch before approval`, async () => {
    // Given
    const catalog = await fakeCatalog([
      {
        name: "create_issue",
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
                title: { type: "string", minLength: 3 },
              },
              required: ["title"],
              additionalProperties: false,
            },
          },
          additionalProperties: false,
        },
      },
    ]);
    let approvals = 0;
    const fake = fakeConnectionFactory({ catalogs: [catalog] });
    const runtime = runtimeWithFactory({
      connectionFactory: fake.factory,
      permission: {
        review: () => {
          approvals++;
          return { type: "allow" };
        },
      },
    });
    const signal = new AbortController().signal;

    try {
      await runtime.search(
        {
          query: "issue",
          server: "catalog",
          tool: "create_issue",
        },
        signal,
      );
      const exposed = exposedToolCall(runtime);

      // When
      const result = await runtime.execute(
        {
          ...exposed,
          arguments: { issue: { title: "x" } },
        },
        signal,
      );

      // Then
      expect(runtime.exposureSnapshot().tools[0]?.parameters).toEqual({
        type: "object",
        properties: {
          issue: {
            type: "object",
            properties: { title: { type: "string" } },
            required: ["title"],
            additionalProperties: false,
          },
        },
        required: ["issue"],
        additionalProperties: false,
      });
      expect(result.ok).toBe(false);
      expect(result.content).toContain("original server JSON Schema");
      expect(approvals).toBe(0);
      expect(fake.callCalls()).toBe(0);
    } finally {
      await runtime.close();
    }
  });

  test(`Given missing and external references appear beside a valid MCP tool,
    When the catalog is searched,
    Then original-schema compilation quarantines only the invalid tools`, async () => {
    // Given
    const catalog = await fakeCatalog([
      {
        name: "missing",
        inputSchema: {
          type: "object",
          properties: { issue: { $ref: "#/$defs/Missing" } },
        },
      },
      {
        name: "external",
        inputSchema: {
          type: "object",
          properties: {
            issue: { $ref: "https://schemas.example/Issue.json" },
          },
        },
      },
      {
        name: "valid",
        inputSchema: {
          type: "object",
          properties: { issue: { type: "string" } },
        },
      },
    ]);
    const fake = fakeConnectionFactory({ catalogs: [catalog] });
    const runtime = runtimeWithFactory({ connectionFactory: fake.factory });

    try {
      // When
      const result = await runtime.search(
        {
          query: "valid",
          server: "catalog",
          limit: 10,
        },
        new AbortController().signal,
      );

      // Then
      expect(
        runtime
          .exposureSnapshot()
          .tools.map((tool) => tool.reference.rawToolName),
      ).toEqual(["valid"]);
      expect(result.content).toContain("3 discovered");
      expect(result.content).toContain("2 catalog-quarantined");
      expect(result.content).toContain("1 provider-usable");
      expect(result.content).toContain(
        "can't resolve reference #/$defs/Missing",
      );
      expect(result.content).toContain(
        "can't resolve reference https://schemas.example/Issue.json",
      );
    } finally {
      await runtime.close();
    }
  });

  test(`Given modern MCP tools use the JSON Schema forms supported by the provider boundary,
    When Keel lowers their schemas for model exposure,
    Then every supported primitive and nested form keeps its bounded annotations`, async () => {
    // Given
    const catalog = await fakeCatalog([
      {
        name: "schema_matrix",
        description: "Schema\u0000 matrix",
        inputSchema: {
          type: "object",
          description: "Root\u0007 description",
          properties: {
            plain: { type: "string", "x-mcp-header": "X-Plain" },
            labeled: { type: "string", description: "Labeled" },
            choice: {
              type: "string",
              enum: ["left", "right"],
              description: "Choice",
            },
            plainChoice: { type: "string", enum: ["only"] },
            count: {
              type: "integer",
              minimum: 1,
              maximum: 10,
              description: "Count",
            },
            enabled: { type: "boolean", description: "Enabled" },
            flag: { type: "boolean" },
            tags: {
              type: "array",
              items: { type: "string" },
              description: "Tags",
            },
            plainTags: {
              type: "array",
              items: { type: "string" },
            },
            nested: {
              type: "object",
              properties: { name: { type: "string" } },
              required: ["name"],
              description: "Nested",
            },
            emptyObject: { type: "object" },
          },
          required: ["plain", "choice", "count"],
          additionalProperties: false,
          title: "Annotations remain non-semantic",
        },
      },
    ]);
    const fake = fakeConnectionFactory({ catalogs: [catalog] });
    const runtime = runtimeWithFactory({ connectionFactory: fake.factory });

    try {
      // When
      const result = await runtime.search(
        {
          query: "unused",
          server: "catalog",
          tool: "schema_matrix",
        },
        new AbortController().signal,
      );

      // Then
      expect(result.ok).toBe(true);
      expect(result.content).not.toContain("\u0000");
      expect(result.content).not.toContain("\u0007");
      expect(runtime.exposureSnapshot().tools[0]?.parameters).toEqual({
        type: "object",
        description: "Root description",
        properties: {
          plain: { type: "string" },
          labeled: { type: "string", description: "Labeled" },
          choice: {
            type: "string",
            enum: ["left", "right"],
            description: "Choice",
          },
          plainChoice: { type: "string", enum: ["only"] },
          count: {
            type: "integer",
            minimum: 1,
            maximum: 10,
            description: "Count",
          },
          enabled: { type: "boolean", description: "Enabled" },
          flag: { type: "boolean" },
          tags: {
            type: "array",
            items: { type: "string" },
            description: "Tags",
          },
          plainTags: {
            type: "array",
            items: { type: "string" },
          },
          nested: {
            type: "object",
            properties: { name: { type: "string" } },
            required: ["name"],
            description: "Nested",
          },
          emptyObject: { type: "object" },
        },
        required: ["plain", "choice", "count"],
        additionalProperties: false,
      });
    } finally {
      await runtime.close();
    }
  });

  test(`Given a Linear-shaped draft-07 schema uses bounded numbers, string length, and nullable strings,
    When Keel exposes the tool and validates a call,
    Then the provider gets a safe projection while the original constraints still gate dispatch`, async () => {
    // Given
    const catalog = await fakeCatalog([
      {
        name: "list_issues",
        inputSchema: {
          $schema: "http://json-schema.org/draft-07/schema#",
          type: "object",
          properties: {
            limit: {
              type: "number",
              maximum: 250,
              description: "Max results",
            },
            urlOrId: {
              type: "string",
              minLength: 1,
              description: "Issue URL or ID",
            },
            assignee: {
              description: "User ID, name, email, or me",
              anyOf: [{ type: "string" }, { type: "null" }],
            },
            parentId: {
              anyOf: [{ type: "null" }, { type: "string" }],
            },
          },
          required: ["urlOrId"],
          additionalProperties: false,
        },
      },
    ]);
    let approvals = 0;
    const fake = fakeConnectionFactory({ catalogs: [catalog] });
    const runtime = runtimeWithFactory({
      connectionFactory: fake.factory,
      permission: {
        review: () => {
          approvals++;
          return { type: "allow" };
        },
      },
    });
    const signal = new AbortController().signal;

    try {
      await runtime.search(
        {
          query: "issues",
          server: "catalog",
          tool: "list_issues",
          limit: 1,
        },
        signal,
      );
      const exposed = exposedToolCall(runtime);

      // When
      const result = await runtime.execute(
        {
          ...exposed,
          arguments: { limit: 50, urlOrId: "", assignee: null },
        },
        signal,
      );
      const validResult = await runtime.execute(
        {
          ...exposed,
          arguments: { limit: 50, urlOrId: "LIN-1", assignee: null },
        },
        signal,
      );

      // Then
      expect(runtime.exposureSnapshot().tools[0]?.parameters).toEqual({
        type: "object",
        properties: {
          limit: {
            type: "number",
            maximum: 250,
            description: "Max results",
          },
          urlOrId: {
            type: "string",
            description: "Issue URL or ID",
          },
          assignee: {
            anyOf: [{ type: "string" }, { type: "null" }],
            description: "User ID, name, email, or me",
          },
          parentId: {
            anyOf: [{ type: "null" }, { type: "string" }],
          },
        },
        required: ["urlOrId"],
        additionalProperties: false,
      });
      expect(result.ok).toBe(false);
      expect(result.content).toContain("original server JSON Schema");
      expect(validResult.ok).toBe(true);
      expect(approvals).toBe(1);
      expect(fake.callCalls()).toBe(1);
    } finally {
      await runtime.close();
    }
  });

  test.each([
    [
      "a non-object root",
      { type: "string" },
      "schema.type must be object when present",
    ],
    [
      "an empty composition",
      { type: "object", properties: {}, anyOf: [] },
      "anyOf must contain at least one JSON Schema branch",
    ],
    [
      "a nullable composition with an invalid branch",
      {
        type: "object",
        properties: { value: { anyOf: [{ type: "null" }, true] } },
      },
      "anyOf[1] must be a JSON Schema object",
    ],
    [
      "a nullable composition with an inexpressible value branch",
      {
        type: "object",
        properties: {
          value: { anyOf: [{ type: "null" }, { type: "array" }] },
        },
      },
      "anyOf[1].items is required",
    ],
    [
      "a non-object property schema",
      { type: "object", properties: { value: true } },
      "properties.value must be a JSON Schema object",
    ],
    [
      "a non-string enum container",
      {
        type: "object",
        properties: { value: { type: "string", enum: "left" } },
      },
      'enum value must be ["array"]',
    ],
    [
      "a non-numeric minimum",
      {
        type: "object",
        properties: { value: { type: "integer", minimum: "one" } },
      },
      'minimum value must be ["number"]',
    ],
    [
      "a non-numeric maximum",
      {
        type: "object",
        properties: { value: { type: "integer", maximum: "ten" } },
      },
      'maximum value must be ["number"]',
    ],
    [
      "an array without items",
      { type: "object", properties: { value: { type: "array" } } },
      "items is required",
    ],
    [
      "an array with an invalid item schema",
      {
        type: "object",
        properties: { value: { type: "array", items: true } },
      },
      "items must be a JSON Schema object",
    ],
    [
      "a cyclic local reference",
      {
        type: "object",
        properties: { node: { $ref: "#/$defs/Node" } },
        $defs: {
          Node: {
            type: "object",
            properties: { next: { $ref: "#/$defs/Node" } },
          },
        },
      },
      "forms a cycle through",
    ],
    [
      "a non-object properties map",
      { type: "object", properties: [] },
      "expected record, received array",
    ],
    [
      "a non-array required list",
      { type: "object", properties: {}, required: "value" },
      "expected array, received string",
    ],
    [
      "a mixed required list",
      { type: "object", properties: {}, required: ["value", 1] },
      "expected string, received number",
    ],
  ] satisfies readonly [string, McpJsonValue, string][])(
    `Given an MCP tool declares %s,
    When provider schema lowering runs,
    Then only that tool is quarantined with a precise diagnostic`,
    async (_caseName, inputSchema, expectedDiagnostic) => {
      // Given
      const catalog = await fakeCatalog([
        { name: "invalid", inputSchema },
        {
          name: "valid",
          inputSchema: { type: "object", properties: {} },
        },
      ]);
      const fake = fakeConnectionFactory({ catalogs: [catalog] });
      const runtime = runtimeWithFactory({ connectionFactory: fake.factory });

      try {
        // When
        const result = await runtime.search(
          { query: "unused", server: "catalog", tool: "invalid" },
          new AbortController().signal,
        );

        // Then
        expect(runtime.exposureSnapshot().tools).toEqual([]);
        expect(result.content).toContain(expectedDiagnostic);
      } finally {
        await runtime.close();
      }
    },
  );

  test(`Given search metadata spans names, descriptions, server ids, limits, and schema budgets,
    When lexical and exact searches activate capabilities,
    Then ranking is deterministic and every omission is reported`, async () => {
    // Given
    const largeProperties = Object.fromEntries(
      Array.from({ length: 750 }, (_, index) => [
        `property_${index}_${"x".repeat(40)}`,
        { type: "string" },
      ]),
    );
    const catalog = await fakeCatalog([
      {
        name: "exact",
        description: "first description match",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "name-otter",
        description: "other",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "description-match",
        description: "otter lookup",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "budget-heavy-a",
        description: "budget heavy",
        inputSchema: {
          type: "object",
          properties: largeProperties,
        },
      },
      {
        name: "budget-heavy-b",
        description: "budget heavy",
        inputSchema: {
          type: "object",
          properties: largeProperties,
        },
      },
    ]);
    const fake = fakeConnectionFactory({ catalogs: [catalog] });
    const runtime = runtimeWithFactory({ connectionFactory: fake.factory });
    const signal = new AbortController().signal;

    try {
      const exact = await runtime.search({ query: "exact" }, signal);
      expect(exact.content).toContain("catalog/exact");
      const toolOnly = await runtime.search(
        { query: "unused", tool: "exact" },
        signal,
      );
      expect(toolOnly.content).toContain("catalog/exact");

      const lexical = await runtime.search({ query: "otter" }, signal);
      expect(
        runtime
          .exposureSnapshot()
          .tools.map((tool) => tool.reference.rawToolName),
      ).toEqual(["name-otter", "description-match"]);
      expect(lexical.ok).toBe(true);
      const byServer = await runtime.search({ query: "catalog" }, signal);
      expect(byServer.content).toContain("catalog/name-otter");
      const limited = await runtime.search(
        { query: "description", limit: 1 },
        signal,
      );
      expect(limited.content).toContain("Omitted");

      // When
      const bounded = await runtime.search(
        { query: "budget heavy", limit: 1 },
        signal,
      );

      // Then
      expect(runtime.exposureSnapshot().tools).toHaveLength(0);
      expect(bounded.content).toContain("Omitted 2 matching tools");
      expect(bounded.content).toContain("2 tools exceeded");
    } finally {
      await runtime.close();
    }
  });

  test(`Given discovery fails, is cancelled, or is requested after shutdown,
    When the runtime resolves those lifecycle boundaries,
    Then it fails closed, redacts diagnostics, and closes partial connections once`, async () => {
    // Given
    let closes = 0;
    const connection: McpConnection = {
      protocolEra: "modern",
      protocolVersion: "2026-07-28",
      serverIdentity: null,
      listCatalog: async () => {
        throw new Error(
          "bad\u0007 endpoint https://user:secret@example.com/mcp?token=hidden http://%",
        );
      },
      callTool: async () => ({ content: [] }),
      close: async () => {
        closes++;
      },
    };
    const runtime = runtimeWithFactory({
      connectionFactory: { connect: async () => connection },
    });

    // When
    const failed = await runtime.search(
      { query: "anything" },
      new AbortController().signal,
    );
    await runtime.close();
    await runtime.close();
    const stopped = await runtime.search(
      { query: "anything" },
      new AbortController().signal,
    );

    // Then
    expect(failed.ok).toBe(false);
    expect(failed.content).toContain(
      "Server unavailable: catalog: bad endpoint https://example.com/mcp",
    );
    expect(failed.content).toContain("<redacted-url>");
    expect(failed.content).not.toContain("secret");
    expect(failed.content).not.toContain("hidden");
    expect(stopped).toEqual({
      ok: false,
      content: "MCP search failed: the MCP runtime is stopped.",
    });
    expect(closes).toBe(1);
  });

  test(`Given a server advertises duplicate raw tool names,
    When catalog construction resolves routing identities,
    Then every ambiguous duplicate is quarantined with one bounded issue`, async () => {
    // Given / When
    const catalog = await fakeCatalog([
      {
        name: "duplicate",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "duplicate",
        inputSchema: { type: "object", properties: {} },
      },
    ]);
    const fake = fakeConnectionFactory({ catalogs: [catalog] });
    const runtime = runtimeWithFactory({ connectionFactory: fake.factory });

    try {
      const result = await runtime.search(
        { query: "duplicate" },
        new AbortController().signal,
      );

      // Then
      expect(result.content).toContain(
        "Catalog quarantine: catalog/duplicate: duplicate raw tool name",
      );
      expect(runtime.exposureSnapshot().tools).toEqual([]);
    } finally {
      await runtime.close();
    }
  });

  test(`Given an already-aborted request and an in-flight shared discovery request,
    When cancellation reaches the owner wait boundary,
    Then callers stop promptly without converting typed abort reasons`, async () => {
    // Given
    const catalog = await fakeCatalog([
      {
        name: "search",
        inputSchema: { type: "object", properties: {} },
      },
    ]);
    const pending =
      Promise.withResolvers<Awaited<ReturnType<typeof fakeCatalog>>>();
    let closes = 0;
    const connection: McpConnection = {
      protocolEra: "modern",
      protocolVersion: "2026-07-28",
      serverIdentity: null,
      listCatalog: async () => await pending.promise,
      callTool: async () => ({ content: [] }),
      close: async () => {
        closes++;
      },
    };
    const runtime = runtimeWithFactory({
      connectionFactory: { connect: async () => connection },
    });
    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    const duringWait = new AbortController();
    const waiting = runtime.search({ query: "search" }, duringWait.signal);

    // When / Then
    await expect(
      runtime.search({ query: "search" }, alreadyAborted.signal),
    ).resolves.toMatchObject({ ok: false });
    duringWait.abort(new Error("typed cancellation"));
    await expect(waiting).resolves.toMatchObject({ ok: false });

    pending.resolve(catalog);
    await runtime.close();
    expect(closes).toBe(1);
  });

  test(`Given a manual refresh returns an unchanged catalog generation,
    When a previously exposed reference is invoked,
    Then the typed reference remains current and dispatch succeeds`, async () => {
    // Given
    const catalog = await fakeCatalog([
      {
        name: "search",
        inputSchema: { type: "object", properties: {} },
      },
    ]);
    const fake = fakeConnectionFactory({ catalogs: [catalog, catalog] });
    const runtime = runtimeWithFactory({ connectionFactory: fake.factory });
    const signal = new AbortController().signal;

    try {
      const original = await activateExactSearch(runtime);

      // When
      await runtime.search(
        {
          query: "search",
          server: "catalog",
          tool: "search",
          refresh: true,
        },
        signal,
      );
      const result = await runtime.execute(original, signal);

      // Then
      expect(result.ok).toBe(true);
      expect(fake.listCalls()).toBe(2);
      expect(fake.callCalls()).toBe(1);
    } finally {
      await runtime.close();
    }
  });

  test(`Given a configured allow-list admits one raw tool,
    When discovery applies the typed policy,
    Then that allow-list branch activates exactly the admitted capability`, async () => {
    // Given
    const catalog = await fakeCatalog([
      {
        name: "search",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "blocked",
        inputSchema: { type: "object", properties: {} },
      },
    ]);
    const fake = fakeConnectionFactory({ catalogs: [catalog] });
    const runtime = createMcpRuntime({
      servers: [
        {
          ...testServerConfig,
          toolFilter: { allow: ["search"], deny: [] },
        },
      ],
      connectionFactory: fake.factory,
      permission: allowPermission,
      schemaTarget: testSchemaTarget,
    });

    try {
      // When
      await runtime.search(
        { query: "unused", server: "catalog", tool: "search" },
        new AbortController().signal,
      );

      // Then
      expect(
        runtime
          .exposureSnapshot()
          .tools.map((tool) => tool.reference.rawToolName),
      ).toEqual(["search"]);
    } finally {
      await runtime.close();
    }
  });

  test(`Given a reference names no descriptor in its otherwise current catalog generation,
    When execution resolves that forged external identity,
    Then the owner rejects it as stale before approval`, async () => {
    // Given
    const catalog = await fakeCatalog([
      {
        name: "search",
        inputSchema: { type: "object", properties: {} },
      },
    ]);
    const fake = fakeConnectionFactory({ catalogs: [catalog] });
    const runtime = runtimeWithFactory({ connectionFactory: fake.factory });

    try {
      const call = await activateExactSearch(runtime);

      // When
      const result = await runtime.execute(
        {
          ...call,
          reference: { ...call.reference, rawToolName: "missing" },
        },
        new AbortController().signal,
      );

      // Then
      expect(result.ok).toBe(false);
      expect(result.content).toContain("changed after exposure");
      expect(fake.callCalls()).toBe(0);
    } finally {
      await runtime.close();
    }
  });

  test(`Given approval aborts a request with a non-Error reason,
    When dispatch reaches its final cancellation gate,
    Then the runtime throws a standard AbortError without calling the server`, async () => {
    // Given
    const catalog = await fakeCatalog([
      {
        name: "search",
        inputSchema: { type: "object", properties: {} },
      },
    ]);
    const controller = new AbortController();
    const fake = fakeConnectionFactory({ catalogs: [catalog] });
    const runtime = runtimeWithFactory({
      connectionFactory: fake.factory,
      permission: {
        review: () => {
          controller.abort("plain cancellation reason");
          return { type: "allow" };
        },
      },
    });

    try {
      const call = await activateExactSearch(runtime);

      // When / Then
      await expect(
        runtime.execute(call, controller.signal),
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(fake.callCalls()).toBe(0);
    } finally {
      await runtime.close();
    }
  });

  test(`Given cancellation wins while an expired catalog refresh fails,
    When turn preparation handles the refresh boundary,
    Then the original typed cancellation reason is propagated`, async () => {
    // Given
    const catalog = await fakeCatalog([
      {
        name: "search",
        inputSchema: { type: "object", properties: {} },
      },
    ]);
    let now = 0;
    let lists = 0;
    const controller = new AbortController();
    const cancellation = new Error("cancel refresh");
    const connection: McpConnection = {
      protocolEra: "modern",
      protocolVersion: "2026-07-28",
      serverIdentity: null,
      listCatalog: async () => {
        lists++;
        if (lists === 1) return catalog;
        controller.abort(cancellation);
        throw new Error("transport settled after cancellation");
      },
      callTool: async () => ({ content: [] }),
      close: async () => {},
    };
    const runtime = runtimeWithFactory({
      connectionFactory: { connect: async () => connection },
      now: () => now,
    });

    try {
      await runtime.search({ query: "search" }, new AbortController().signal);
      now = 5 * 60 * 1_000;

      // When / Then
      await expect(
        runtime.prepareTurn(testSchemaTarget, controller.signal),
      ).rejects.toBe(cancellation);
    } finally {
      await runtime.close();
    }
  });

  test(`Given two logical servers expose equally scored tools,
    When discovery builds the shared catalog and active snapshot,
    Then server and raw-tool ordering are deterministic`, async () => {
    // Given
    const aCatalog = await fakeCatalog([
      {
        name: "zeta",
        description: "shared match",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "alpha",
        description: "shared match",
        inputSchema: { type: "object", properties: {} },
      },
    ]);
    const bCatalog = await fakeCatalog([
      {
        name: "middle",
        description: "shared match",
        inputSchema: { type: "object", properties: {} },
      },
    ]);
    const runtime = createMcpRuntime({
      servers: [
        {
          ...testServerConfig,
          id: "b-server",
          url: "https://b.example/mcp",
        },
        {
          ...testServerConfig,
          id: "a-server",
          url: "https://a.example/mcp",
        },
      ],
      connectionFactory: {
        connect: async (server) => ({
          protocolEra: "modern",
          protocolVersion: "2026-07-28",
          serverIdentity: null,
          listCatalog: async () =>
            server.url.includes("a.example") ? aCatalog : bCatalog,
          callTool: async () => ({ content: [] }),
          close: async () => {},
        }),
      },
      permission: allowPermission,
      schemaTarget: testSchemaTarget,
    });

    try {
      // When
      await runtime.search(
        { query: "shared match", limit: 10 },
        new AbortController().signal,
      );

      // Then
      expect(
        runtime
          .exposureSnapshot()
          .tools.map(
            (tool) =>
              `${tool.reference.serverId}/${tool.reference.rawToolName}`,
          ),
      ).toEqual(["a-server/alpha", "a-server/zeta", "b-server/middle"]);
    } finally {
      await runtime.close();
    }
  });
});
