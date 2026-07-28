import { join } from "node:path";
import { connectMcpServer } from "../mcp/discovery.ts";
import {
  createMcpBearerAuthProvider,
  type McpRuntimeAuthProvider,
} from "../mcp/oauth.ts";
import type {
  McpConnectionFactory,
  McpLifecyclePolicy,
  McpRuntimeServer,
} from "../mcp/runtime-types.ts";
import { isMcpServerCurrentAndEnabled, listMcpServers } from "./mcp-config.ts";
import type { CliRuntime } from "./runtime.ts";
import { sessionHome } from "./session-store.ts";

export function mcpOAuthRefreshLockRoot(
  runtime: Pick<CliRuntime, "env">,
): string {
  return join(sessionHome(runtime), "mcp", "oauth-refresh-locks");
}

export function createCliMcpAuthProvider(
  runtime: Pick<CliRuntime, "env" | "mcpSecretBackend">,
  server: McpRuntimeServer,
): McpRuntimeAuthProvider {
  return createMcpBearerAuthProvider({
    server,
    backend: runtime.mcpSecretBackend,
    refreshLockRoot: mcpOAuthRefreshLockRoot(runtime),
    isCurrentAndEnabled: async () =>
      await isMcpServerCurrentAndEnabled(runtime, server),
  });
}

export function createCliMcpLifecyclePolicy(
  runtime: Pick<CliRuntime, "env">,
): McpLifecyclePolicy {
  return {
    isCurrentAndEnabled: async (server) =>
      await isMcpServerCurrentAndEnabled(runtime, server),
    listCurrent: async () => await listMcpServers(runtime),
  };
}

export function createCliMcpConnectionFactory(
  runtime: Pick<CliRuntime, "env" | "mcpSecretBackend">,
): McpConnectionFactory {
  return {
    connect: async (server, signal) =>
      await connectMcpServer(
        server,
        signal,
        createCliMcpAuthProvider(runtime, server),
      ),
  };
}
