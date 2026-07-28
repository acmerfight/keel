import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { toNodeHandler } from "@modelcontextprotocol/node";
import {
  createMcpHandler,
  legacyStatelessFallback,
  McpServer,
} from "@modelcontextprotocol/server";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { runCliMain } from "../../../src/cli/index.ts";
import type { McpSecretBackend } from "../../../src/mcp/oauth.ts";
import {
  requestWithMessagesSchema,
  requestWithToolsSchema,
  runReportSchema,
} from "../../../src/testing/cli-main-schemas.ts";
import { createRuntime } from "../../../src/testing/cli-runtime-fixtures.ts";
import {
  close,
  getPort,
  listen,
  sseTextReplyWithUsage,
  sseToolCall,
  sseToolFinish,
} from "../../../src/testing/provider-sse-fixtures.ts";
import { startOAuthMcpServer } from "../../fixtures/mcp-oauth.ts";

interface TestMcpServer {
  readonly url: string;
  readonly calls: () => readonly string[];
  readonly close: () => Promise<void>;
}

async function startMcpToolServer(
  protocolEra: "modern" | "legacy",
): Promise<TestMcpServer> {
  const calls: string[] = [];
  const createServerInstance = () => {
    const server = new McpServer(
      { name: "keel-agent-test", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    server.registerTool(
      "search",
      {
        description: "Search the remote test catalog",
        inputSchema: z.object({ query: z.string() }),
      },
      async ({ query }) => {
        calls.push(query);
        return {
          content: [{ type: "text", text: `remote result for ${query}` }],
          structuredContent: { query, matches: 1 },
        };
      },
    );
    return server;
  };
  const transport =
    protocolEra === "modern"
      ? (() => {
          const handler = createMcpHandler(createServerInstance);
          return {
            nodeHandler: toNodeHandler(handler),
            close: async () => {
              await handler.close?.();
            },
          };
        })()
      : (() => {
          const handler = legacyStatelessFallback(createServerInstance);
          return {
            nodeHandler: toNodeHandler({ fetch: handler }),
            close: async () => {},
          };
        })();
  const server = createServer((request, response) => {
    void transport.nodeHandler(
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
    calls: () => [...calls],
    close: async () => {
      await transport.close();
      await close(server);
    },
  };
}

async function startUnionMcpToolServer(): Promise<TestMcpServer> {
  const calls: string[] = [];
  const handler = createMcpHandler(() => {
    const server = new McpServer(
      { name: "keel-union-agent-test", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    server.registerTool(
      "ask_question",
      {
        description: "Ask about one or more repositories",
        inputSchema: z.object({
          repoName: z.union([z.string(), z.array(z.string())]),
          question: z.string().max(200),
        }),
      },
      async ({ question, repoName }) => {
        const repositories =
          typeof repoName === "string" ? [repoName] : repoName;
        calls.push(...repositories);
        return {
          content: [
            {
              type: "text",
              text: `answered ${question} for ${repositories.join(", ")}`,
            },
          ],
        };
      },
    );
    return server;
  });
  const server = createServer((request, response) => {
    void toNodeHandler(handler)(
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
    calls: () => [...calls],
    close: async () => {
      await handler.close?.();
      await close(server);
    },
  };
}

function mcpAgentProvider(capturedBodies: unknown[]): Server {
  return createServer((request, response) => {
    if (request.url !== "/chat/completions") {
      response.writeHead(404);
      response.end();
      return;
    }

    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      capturedBodies.push(JSON.parse(body));
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      if (capturedBodies.length === 1) {
        response.write(
          sseToolCall("call_mcp_search", "mcp_search", {
            query: "search",
            server: "catalog",
            toolName: "search",
          }),
        );
        response.write(sseToolFinish());
        response.write("data: [DONE]\n\n");
        response.end();
        return;
      }
      if (capturedBodies.length === 2) {
        response.write(
          sseToolCall("call_remote_search", "mcp__catalog__search", {
            query: "otters",
          }),
        );
        response.write(sseToolFinish());
        response.write("data: [DONE]\n\n");
        response.end();
        return;
      }
      response.end(sseTextReplyWithUsage("Found one remote match."));
    });
  });
}

describe("CLI Main - MCP agent tools", () => {
  test(`Given a remote MCP tool accepts one repository or a repository list,
    When the user asks Keel to call it with multiple repositories,
    Then the selected provider receives the union schema and the approved remote call succeeds`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-mcp-union-home-"));
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-mcp-union-workspace-"),
    );
    const mcp = await startUnionMcpToolServer();
    const add = createRuntime(["mcp", "add", mcp.url, "--name", "catalog"], {
      env: { KEEL_HOME: home },
    });
    expect(await runCliMain(add.runtime), add.stderr()).toBe(0);

    const capturedBodies: unknown[] = [];
    const provider = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        capturedBodies.push(JSON.parse(body));
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        if (capturedBodies.length === 1) {
          response.write(
            sseToolCall("find_union_tool", "mcp_search", {
              query: "repository question",
              server: "catalog",
              toolName: "ask_question",
            }),
          );
          response.end(`${sseToolFinish()}data: [DONE]\n\n`);
          return;
        }
        if (capturedBodies.length === 2) {
          response.write(
            sseToolCall(
              "ask_multiple_repositories",
              "mcp__catalog__ask_question",
              {
                repoName: ["acmerfight/keel", "openai/codex"],
                question: "How do their tool schemas differ?",
              },
            ),
          );
          response.end(`${sseToolFinish()}data: [DONE]\n\n`);
          return;
        }
        response.end(sseTextReplyWithUsage("Compared both repositories."));
      });
    });
    await listen(provider);
    const input = new PassThrough();
    let approvalAnswered = false;
    const run = createRuntime(["compare both repositories through MCP"], {
      cwd: workspace,
      env: {
        DEEPSEEK_API_KEY: "test-key",
        DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(provider)}`,
        KEEL_HOME: home,
      },
      input,
      inputIsTTY: true,
      onStderr: (text) => {
        if (text.includes("Approve MCP tool call?") && !approvalAnswered) {
          approvalAnswered = true;
          input.end("y\n");
        }
      },
    });

    try {
      // When
      const exitCode = await runCliMain(run.runtime);

      // Then
      expect(exitCode, run.stderr()).toBe(0);
      expect(run.stdout()).toBe("Compared both repositories.\n");
      expect(mcp.calls()).toEqual(["acmerfight/keel", "openai/codex"]);
      const request = z
        .object({
          tools: z.array(
            z
              .object({
                function: z
                  .object({
                    name: z.string(),
                    parameters: z.json(),
                  })
                  .passthrough(),
              })
              .passthrough(),
          ),
        })
        .passthrough()
        .parse(capturedBodies[1]);
      const tool = request.tools.find(
        (candidate) => candidate.function.name === "mcp__catalog__ask_question",
      );
      const parameters = z
        .object({
          properties: z.object({
            repoName: z.object({
              anyOf: z.array(z.json()),
            }),
          }),
        })
        .passthrough()
        .parse(tool?.function.parameters);
      expect(parameters.properties.repoName.anyOf).toEqual([
        { type: "string" },
        { type: "array", items: { type: "string" } },
      ]);
    } finally {
      input.end();
      await close(provider);
      await mcp.close();
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test.each(["modern", "legacy"] as const)(
    `Given an unauthenticated %s Streamable HTTP MCP server is configured,
    When the user asks Keel to use its tool and approves the exact remote call,
    Then Keel progressively exposes, invokes, and returns the external result`,
    async (protocolEra) => {
      // Given
      const home = await mkdtemp(join(tmpdir(), "keel-mcp-agent-home-"));
      const workspace = await mkdtemp(
        join(tmpdir(), "keel-mcp-agent-workspace-"),
      );
      const mcp = await startMcpToolServer(protocolEra);
      const add = createRuntime(["mcp", "add", mcp.url, "--name", "catalog"], {
        env: { KEEL_HOME: home },
      });
      const addExitCode = await runCliMain(add.runtime);
      expect(addExitCode).toBe(0);
      expect(add.stdout()).toContain(`protocol: ${protocolEra}`);

      const capturedBodies: unknown[] = [];
      const provider = mcpAgentProvider(capturedBodies);
      await listen(provider);
      const input = new PassThrough();
      let approvalAnswered = false;
      const run = createRuntime(["use the catalog MCP to search for otters"], {
        cwd: workspace,
        env: {
          DEEPSEEK_API_KEY: "test-key",
          DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(provider)}`,
          KEEL_HOME: home,
        },
        input,
        inputIsTTY: true,
        onStderr: (text) => {
          if (text.includes("Approve MCP tool call?") && !approvalAnswered) {
            approvalAnswered = true;
            input.write("y\n");
            input.end();
          }
        },
      });

      try {
        // When
        const exitCode = await runCliMain(run.runtime);

        // Then
        expect(exitCode, run.stderr()).toBe(0);
        expect(run.stdout()).toBe("Found one remote match.\n");
        expect(run.stderr()).toContain("Approve MCP tool call?\n");
        expect(run.stderr()).toContain(`origin: ${new URL(mcp.url).origin}\n`);
        expect(run.stderr()).toContain("tool: catalog/search\n");
        expect(run.stderr()).toContain('arguments: {"query":"otters"}\n');
        expect(mcp.calls()).toEqual(["otters"]);

        const firstRequest = requestWithToolsSchema.parse(capturedBodies[0]);
        expect(
          firstRequest.tools?.map((tool) => tool.function?.name),
        ).toContain("mcp_search");
        expect(
          firstRequest.tools?.map((tool) => tool.function?.name),
        ).not.toContain("mcp__catalog__search");

        const secondRequest = requestWithToolsSchema.parse(capturedBodies[1]);
        expect(
          secondRequest.tools?.map((tool) => tool.function?.name),
        ).toContain("mcp__catalog__search");

        const thirdRequest = requestWithMessagesSchema.parse(capturedBodies[2]);
        expect(thirdRequest.messages).toContainEqual({
          role: "tool",
          tool_call_id: "call_remote_search",
          content: expect.stringContaining("remote result for otters"),
        });
      } finally {
        input.end();
        await close(provider);
        await mcp.close();
        await rm(workspace, { recursive: true, force: true });
        await rm(home, { recursive: true, force: true });
      }
    },
  );

  test(`Given the user logged in and the protected MCP server rejects the expired access token,
    When Keel discovers and invokes one approved remote tool,
    Then Keel refreshes once, every request reads the published credential dynamically, and no token reaches the model`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-mcp-auth-agent-home-"));
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-mcp-auth-agent-workspace-"),
    );
    const mcp = await startOAuthMcpServer({ refreshResponse: "rotate" });
    const secretEntries = new Map<string, string>();
    const secretKey = (service: string, account: string) =>
      `${service}\0${account}`;
    let credentialReads = 0;
    const secretBackend: McpSecretBackend = {
      getPassword: async (service, account) => {
        credentialReads += 1;
        return secretEntries.get(secretKey(service, account)) ?? null;
      },
      setPassword: async (service, account, password) => {
        secretEntries.set(secretKey(service, account), password);
      },
      deletePassword: async (service, account) =>
        secretEntries.delete(secretKey(service, account)),
    };
    const add = createRuntime(["mcp", "add", mcp.url, "--name", "catalog"], {
      env: { KEEL_HOME: home },
    });
    expect(await runCliMain(add.runtime)).toBe(0);
    const login = createRuntime(["mcp", "login", "catalog"], {
      env: { KEEL_HOME: home },
      mcpSecretBackend: secretBackend,
      openExternalUrl: mcp.openAuthorizationUrl,
    });
    expect(await runCliMain(login.runtime), login.stderr()).toBe(0);
    const readsAfterLogin = credentialReads;
    mcp.expireAccessToken();

    const capturedBodies: unknown[] = [];
    const provider = mcpAgentProvider(capturedBodies);
    await listen(provider);
    const input = new PassThrough();
    const reportPath = join(workspace, "authenticated-report.json");
    let approvalAnswered = false;
    const run = createRuntime(
      ["--report", reportPath, "search the protected catalog for otters"],
      {
        cwd: workspace,
        env: {
          DEEPSEEK_API_KEY: "test-key",
          DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(provider)}`,
          KEEL_HOME: home,
        },
        input,
        inputIsTTY: true,
        mcpSecretBackend: secretBackend,
        onStderr: (text) => {
          if (text.includes("Approve MCP tool call?") && !approvalAnswered) {
            approvalAnswered = true;
            input.end("y\n");
          }
        },
      },
    );

    try {
      // When
      const exitCode = await runCliMain(run.runtime);

      // Then
      expect(exitCode, run.stderr()).toBe(0);
      expect(run.stdout()).toBe("Found one remote match.\n");
      expect(mcp.calls()).toEqual(["otters"]);
      expect(credentialReads - readsAfterLogin).toBeGreaterThan(2);
      expect(mcp.tokenRequests().map((request) => request.grantType)).toEqual([
        "authorization_code",
        "refresh_token",
      ]);
      expect(JSON.stringify(capturedBodies)).not.toContain(mcp.accessToken);
      expect(JSON.stringify(capturedBodies)).not.toContain(
        mcp.refreshedAccessToken,
      );
      expect(run.stdout()).not.toContain(mcp.accessToken);
      expect(run.stderr()).not.toContain(mcp.accessToken);
      expect(await readFile(reportPath, "utf8")).not.toContain(mcp.accessToken);
      expect(await readFile(reportPath, "utf8")).not.toContain(
        mcp.refreshedAccessToken,
      );
    } finally {
      input.end();
      await close(provider);
      await mcp.close();
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a non-interactive run has no exact saved MCP approval,
    When the provider searches and attempts a valid remote call,
    Then Keel fails the call closed without dispatching it`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-mcp-headless-home-"));
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-mcp-headless-workspace-"),
    );
    const mcp = await startMcpToolServer("modern");
    const add = createRuntime(["mcp", "add", mcp.url, "--name", "catalog"], {
      env: { KEEL_HOME: home },
    });
    expect(await runCliMain(add.runtime)).toBe(0);
    const capturedBodies: unknown[] = [];
    const provider = mcpAgentProvider(capturedBodies);
    await listen(provider);
    const run = createRuntime(["search remotely"], {
      cwd: workspace,
      env: {
        DEEPSEEK_API_KEY: "test-key",
        DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(provider)}`,
        KEEL_HOME: home,
      },
      inputIsTTY: false,
    });

    try {
      // When
      const exitCode = await runCliMain(run.runtime);

      // Then
      expect(exitCode, run.stderr()).toBe(0);
      expect(mcp.calls()).toEqual([]);
      expect(run.stderr()).not.toContain("Approve MCP tool call?");
      const recoveryRequest = requestWithMessagesSchema.parse(
        capturedBodies[2],
      );
      expect(recoveryRequest.messages).toContainEqual({
        role: "tool",
        tool_call_id: "call_remote_search",
        content: expect.stringContaining("non-TTY one-shot runs fail closed"),
      });
    } finally {
      await close(provider);
      await mcp.close();
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given one model turn requests the same MCP tool with three different arguments,
    When the user approves every exact remote call,
    Then Keel dispatches all three calls and returns every result to the model`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-mcp-batch-home-"));
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-mcp-batch-workspace-"),
    );
    const mcp = await startMcpToolServer("modern");
    const add = createRuntime(["mcp", "add", mcp.url, "--name", "catalog"], {
      env: { KEEL_HOME: home },
    });
    expect(await runCliMain(add.runtime)).toBe(0);

    const capturedBodies: unknown[] = [];
    const provider = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        capturedBodies.push(JSON.parse(body));
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        if (capturedBodies.length === 1) {
          response.write(
            sseToolCall("search_batch", "mcp_search", {
              query: "search",
              server: "catalog",
              toolName: "search",
            }),
          );
          response.end(`${sseToolFinish()}data: [DONE]\n\n`);
          return;
        }
        if (capturedBodies.length === 2) {
          response.write(
            sseToolCall(
              "remote_alpha",
              "mcp__catalog__search",
              { query: "alpha" },
              { index: 0 },
            ),
          );
          response.write(
            sseToolCall(
              "remote_beta",
              "mcp__catalog__search",
              { query: "beta" },
              { index: 1 },
            ),
          );
          response.write(
            sseToolCall(
              "remote_gamma",
              "mcp__catalog__search",
              { query: "gamma" },
              { index: 2 },
            ),
          );
          response.end(`${sseToolFinish()}data: [DONE]\n\n`);
          return;
        }
        response.end(sseTextReplyWithUsage("Found three remote matches."));
      });
    });
    await listen(provider);
    const input = new PassThrough();
    let approvals = 0;
    const run = createRuntime(["search three remote queries"], {
      cwd: workspace,
      env: {
        DEEPSEEK_API_KEY: "test-key",
        DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(provider)}`,
        KEEL_HOME: home,
      },
      input,
      inputIsTTY: true,
      onStderr: (text) => {
        if (text.includes("Approve MCP tool call?")) {
          approvals += 1;
          input.write("y\n");
          if (approvals === 3) {
            input.end();
          }
        }
      },
    });

    try {
      // When
      const exitCode = await runCliMain(run.runtime);

      // Then
      expect(exitCode, run.stderr()).toBe(0);
      expect(run.stdout()).toBe("Found three remote matches.\n");
      expect(approvals).toBe(3);
      expect(mcp.calls()).toEqual(["alpha", "beta", "gamma"]);
      const resultRequest = requestWithMessagesSchema.parse(capturedBodies[2]);
      for (const [toolCallId, query] of [
        ["remote_alpha", "alpha"],
        ["remote_beta", "beta"],
        ["remote_gamma", "gamma"],
      ] as const) {
        expect(resultRequest.messages).toContainEqual({
          role: "tool",
          tool_call_id: toolCallId,
          content: expect.stringContaining(`remote result for ${query}`),
        });
      }
    } finally {
      input.end();
      await close(provider);
      await mcp.close();
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given the model calls an MCP name that is absent from the current exposure snapshot,
    When a non-interactive user requests a run report,
    Then Keel returns stale-call recovery to the model and persists the completed run`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-mcp-stale-home-"));
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-mcp-stale-workspace-"),
    );
    const reportPath = join(workspace, "report.json");
    const mcp = await startMcpToolServer("modern");
    const add = createRuntime(["mcp", "add", mcp.url, "--name", "catalog"], {
      env: { KEEL_HOME: home },
    });
    expect(await runCliMain(add.runtime)).toBe(0);

    const capturedBodies: unknown[] = [];
    const provider = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        capturedBodies.push(JSON.parse(body));
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        if (capturedBodies.length === 1) {
          response.write(
            sseToolCall("stale_remote", "mcp__catalog__removed", {
              query: "otters",
            }),
          );
          response.end(`${sseToolFinish()}data: [DONE]\n\n`);
          return;
        }
        response.end(
          sseTextReplyWithUsage("Recovered after the stale MCP call."),
        );
      });
    });
    await listen(provider);
    const run = createRuntime(
      ["--report", reportPath, "use the cached remote search"],
      {
        cwd: workspace,
        env: {
          DEEPSEEK_API_KEY: "test-key",
          DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(provider)}`,
          KEEL_HOME: home,
        },
        inputIsTTY: false,
      },
    );

    try {
      // When
      const exitCode = await runCliMain(run.runtime);

      // Then
      expect(exitCode, run.stderr()).toBe(0);
      expect(run.stdout()).toBe("Recovered after the stale MCP call.\n");
      expect(run.stderr()).not.toContain("provider protocol");
      expect(mcp.calls()).toEqual([]);
      const recoveryRequest = requestWithMessagesSchema.parse(
        capturedBodies[1],
      );
      expect(recoveryRequest.messages).toContainEqual({
        role: "tool",
        tool_call_id: "stale_remote",
        content: expect.stringContaining("Search again before retrying"),
      });
      const report = runReportSchema.parse(
        JSON.parse(await readFile(reportPath, "utf8")),
      );
      expect(report.stopReason).toBe("completed");
    } finally {
      await close(provider);
      await mcp.close();
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given an interactive session loads a configured MCP server,
    When the model searches and the user approves the exact call in steering input,
    Then approval mode is restored and the session can exit normally`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-mcp-interactive-home-"));
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-mcp-interactive-workspace-"),
    );
    const mcp = await startMcpToolServer("modern");
    const add = createRuntime(["mcp", "add", mcp.url, "--name", "catalog"], {
      env: { KEEL_HOME: home },
    });
    expect(await runCliMain(add.runtime)).toBe(0);
    const capturedBodies: unknown[] = [];
    const provider = mcpAgentProvider(capturedBodies);
    await listen(provider);
    const input = new PassThrough();
    input.write("search remotely\n");
    let approvalAnswered = false;
    let exitQueued = false;
    const run = createRuntime([], {
      cwd: workspace,
      env: {
        DEEPSEEK_API_KEY: "test-key",
        DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(provider)}`,
        KEEL_HOME: home,
      },
      input,
      inputIsTTY: true,
      stderrIsTTY: false,
      onStderr: (text) => {
        if (text.includes("Approve MCP tool call?") && !approvalAnswered) {
          approvalAnswered = true;
          input.write("yes\n");
        }
      },
      onStdout: (text) => {
        if (text.includes("Found one remote match.") && !exitQueued) {
          exitQueued = true;
          input.end("/exit\n");
        }
      },
    });

    try {
      // When
      const exitCode = await runCliMain(run.runtime);

      // Then
      expect(exitCode, run.stderr()).toBe(0);
      expect(approvalAnswered).toBe(true);
      expect(exitQueued).toBe(true);
      expect(run.stdout()).toContain("Found one remote match.");
      expect(mcp.calls()).toEqual(["otters"]);

      const nonTtyInput = new PassThrough();
      nonTtyInput.end("/exit\n");
      const nonTty = createRuntime(["--ephemeral"], {
        cwd: workspace,
        env: {
          KEEL_HOME: home,
          KEEL_PROVIDER: "fake",
          KEEL_FORCE_INTERACTIVE: "1",
        },
        input: nonTtyInput,
        inputIsTTY: false,
      });
      expect(await runCliMain(nonTty.runtime)).toBe(0);
    } finally {
      input.end();
      await close(provider);
      await mcp.close();
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given interactive startup finds an invalid MCP config,
    When the CLI loads external configuration,
    Then it reports the normalized config error before starting a session`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-mcp-invalid-home-"));
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-mcp-invalid-workspace-"),
    );
    await writeFile(join(home, "mcp.json"), "{\n", "utf8");
    const run = createRuntime([], {
      cwd: workspace,
      env: {
        KEEL_HOME: home,
        KEEL_PROVIDER: "fake",
        KEEL_FORCE_INTERACTIVE: "1",
      },
      input: new PassThrough(),
    });

    try {
      // When
      const exitCode = await runCliMain(run.runtime);

      // Then
      expect(exitCode).toBe(1);
      expect(run.stderr()).toContain("cannot read MCP config");
      expect(run.stderr()).toContain("invalid JSON");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });
});
