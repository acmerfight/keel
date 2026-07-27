import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
import {
  requestWithMessagesSchema,
  requestWithToolsSchema,
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
