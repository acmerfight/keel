import { join } from "node:path";
import { privateStateDirectoryPath } from "../core/private-state.ts";
import { connectMcpServer } from "../mcp/discovery.ts";
import {
  createMcpBearerAuthProvider,
  type McpAuthorizationIdentity,
  type McpRuntimeAuthProvider,
} from "../mcp/oauth.ts";
import type {
  McpConnectionFactory,
  McpLifecyclePolicy,
  McpRuntimeServer,
} from "../mcp/runtime-types.ts";
import { isMcpServerCurrentAndEnabled, listMcpServers } from "./mcp-config.ts";
import type { CliRuntime } from "./runtime.ts";

export function mcpOAuthRefreshLockRoot(
  runtime: Pick<CliRuntime, "env">,
): string {
  return join(
    privateStateDirectoryPath(runtime, [], "KEEL_HOME"),
    "mcp",
    "oauth-refresh-locks",
  );
}

export function validateMcpOAuthRefreshLockRoot(
  runtime: Pick<CliRuntime, "env">,
): void {
  mcpOAuthRefreshLockRoot(runtime);
}

export function createCliMcpAuthProvider(
  runtime: Pick<CliRuntime, "env" | "mcpSecretBackend">,
  server: McpRuntimeServer,
  fixedAuthorizationIdentity?: McpAuthorizationIdentity,
): McpRuntimeAuthProvider {
  return createMcpBearerAuthProvider({
    server,
    backend: runtime.mcpSecretBackend,
    refreshLockRoot: mcpOAuthRefreshLockRoot(runtime),
    validateRefreshLockRoot: () => validateMcpOAuthRefreshLockRoot(runtime),
    isCurrentAndEnabled: async () =>
      await isMcpServerCurrentAndEnabled(runtime, server),
    ...(fixedAuthorizationIdentity === undefined
      ? {}
      : { fixedAuthorizationIdentity }),
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
  fixedAuthorizationIdentity?: McpAuthorizationIdentity,
): McpConnectionFactory {
  return {
    connect: async (server, signal) =>
      await connectMcpServer(
        server,
        signal,
        createCliMcpAuthProvider(runtime, server, fixedAuthorizationIdentity),
      ),
  };
}
