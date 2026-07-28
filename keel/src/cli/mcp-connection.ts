import { join } from "node:path";
import type { McpServerEndpoint } from "../mcp/discovery.ts";
import { connectMcpServer } from "../mcp/discovery.ts";
import {
  createMcpBearerAuthProvider,
  type McpRuntimeAuthProvider,
} from "../mcp/oauth.ts";
import type { McpConnectionFactory } from "../mcp/runtime-types.ts";
import type { CliRuntime } from "./runtime.ts";
import { sessionHome } from "./session-store.ts";

export function mcpOAuthRefreshLockRoot(
  runtime: Pick<CliRuntime, "env">,
): string {
  return join(sessionHome(runtime), "mcp", "oauth-refresh-locks");
}

export function createCliMcpAuthProvider(
  runtime: Pick<CliRuntime, "env" | "mcpSecretBackend">,
  server: McpServerEndpoint,
): McpRuntimeAuthProvider {
  return createMcpBearerAuthProvider({
    server,
    backend: runtime.mcpSecretBackend,
    refreshLockRoot: mcpOAuthRefreshLockRoot(runtime),
  });
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
