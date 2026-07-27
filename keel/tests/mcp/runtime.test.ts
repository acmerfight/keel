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
import { createMcpRuntime } from "../../src/mcp/runtime.ts";
import type {
  McpConnectionFactory,
  McpPermissionPolicy,
  McpToolFilterPolicy,
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

const testServerConfig: McpServerConfig = {
  id: "catalog",
  url: "https://catalog.example/mcp",
  allowPrivateNetwork: false,
  toolFilter: { allow: null, deny: [] },
};

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
          toolFilter: { allow: null, deny: [] },
        },
      ],
      connectionFactory: { connect: connectMcpServer },
      permission: allowPermission,
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
        "1 discovered, 0 quarantined, 1 filtered",
      );
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

  test(`Given one tool uses provider-inexpressible schema semantics beside a valid tool,
    When the catalog is searched,
    Then only the affected schema is quarantined with a diagnostic`, async () => {
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
      ).toEqual(["search"]);
      expect(searchResult.content).toContain(
        "Provider schema quarantine: catalog/ambiguous",
      );
      expect(searchResult.content).toContain("2 discovered");
      expect(searchResult.content).toContain("1 active");
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
      await runtime.prepareTurn(signal);

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
      await runtime.prepareTurn(signal);
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
      expect(result.preserved.value).toEqual(invalidResult);
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
});
