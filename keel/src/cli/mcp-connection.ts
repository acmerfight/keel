import { connectMcpServer } from "../mcp/discovery.ts";
import { createMcpBearerAuthProvider } from "../mcp/oauth.ts";
import type { McpConnectionFactory } from "../mcp/runtime-types.ts";
import type { CliRuntime } from "./runtime.ts";

export function createCliMcpConnectionFactory(
  runtime: Pick<CliRuntime, "mcpSecretBackend">,
): McpConnectionFactory {
  return {
    connect: async (server, signal) =>
      await connectMcpServer(
        server,
        signal,
        createMcpBearerAuthProvider(server, runtime.mcpSecretBackend),
      ),
  };
}
