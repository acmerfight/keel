import { randomBytes } from "node:crypto";
import {
  discoverMcpServer,
  type McpDiscoveryStatus,
} from "../mcp/discovery.ts";
import { authorizeMcpServer, McpOAuthLoginError } from "../mcp/login.ts";
import { McpNetworkPolicyError, validateMcpServerUrl } from "../mcp/network.ts";
import {
  deleteMcpOAuthCredentials,
  McpOAuthCredentialError,
  type McpPreRegisteredClient,
} from "../mcp/oauth.ts";
import {
  type McpProviderSchemaTarget,
  mcpProviderSchemaTarget,
} from "../mcp/provider-schema.ts";
import type { CliArgs } from "./args.ts";
import { escapeApprovalText } from "./bash-approval-text.ts";
import {
  addMcpServer,
  deriveMcpServerId,
  findMcpServer,
  listMcpServers,
  McpConfigError,
  type McpServerConfig,
  setMcpServerAuthenticationRequired,
  validateMcpServerId,
} from "./mcp-config.ts";
import {
  createCliMcpAuthProvider,
  mcpOAuthRefreshLockRoot,
} from "./mcp-connection.ts";
import {
  McpOAuthCallbackError,
  startMcpOAuthLoopbackCallback,
} from "./mcp-oauth-loopback.ts";
import {
  providerProfile,
  selectedModelFromProfile,
  selectedProviderId,
} from "./provider-config.ts";
import type { CliRuntime } from "./runtime.ts";

type McpCliArgs = Extract<CliArgs, { readonly command: "mcp" }>;
const MCP_CLIENT_SECRET_MAX_BYTES = 64 * 1024;

function displayMcpEndpoint(raw: string): string {
  const url = new URL(raw);
  const hasQuery = url.search !== "";
  url.search = "";
  return `${url.href}${hasQuery ? "?<redacted>" : ""}`;
}

function displayMcpToolNames(names: readonly string[]): string {
  return names.map(escapeApprovalText).join(", ");
}

function formatReadyStatus(
  server: McpServerConfig,
  status: Extract<McpDiscoveryStatus, { readonly status: "ready" }>,
  includeIssues: boolean,
): string {
  return [
    `MCP server: ${server.id}`,
    `origin: ${new URL(server.url).origin}`,
    `endpoint: ${displayMcpEndpoint(server.url)}`,
    "status: ready",
    `protocol: ${status.protocolEra} (${status.protocolVersion})`,
    `server identity: ${status.serverIdentity ?? "anonymous"}`,
    `tools: ${status.catalog.valid} catalog-valid, ${status.catalog.quarantined} catalog-quarantined, ${status.catalog.total} total`,
    `provider: ${status.provider.target.providerId}/${status.provider.target.model}`,
    `provider tools: ${status.provider.usable} usable, ${status.provider.quarantined} quarantined, ${status.provider.validationWidened} validation-widened`,
    `catalog: sha256:${status.catalog.digest}`,
    `latency: ${status.latencyMs}ms`,
    ...(includeIssues && status.catalog.issues.length > 0
      ? [
          "quarantined tools:",
          ...status.catalog.issues.map(
            (issue) => `- ${issue.tool}: ${issue.reason}`,
          ),
        ]
      : []),
    ...(includeIssues && status.provider.issues.length > 0
      ? [
          "provider-quarantined tools:",
          ...status.provider.issues.map(
            (issue) => `- ${issue.tool}: ${issue.reason}`,
          ),
        ]
      : []),
    ...(includeIssues && status.provider.wideningIssues.length > 0
      ? [
          "validation-widened tools:",
          ...status.provider.wideningIssues.map(
            (issue) => `- ${issue.tool}: ${issue.reason}`,
          ),
        ]
      : []),
  ].join("\n");
}

function formatDiscoveryStatus(
  server: McpServerConfig,
  status: McpDiscoveryStatus,
  includeIssues: boolean,
): string {
  if (status.status === "ready") {
    return formatReadyStatus(server, status, includeIssues);
  }
  const common = [
    `MCP server: ${server.id}`,
    `origin: ${new URL(server.url).origin}`,
    `endpoint: ${displayMcpEndpoint(server.url)}`,
    `status: ${status.status}`,
  ];
  if (status.status === "needs-auth") {
    return [
      ...common,
      "authorization: required",
      `latency: ${status.latencyMs}ms`,
    ].join("\n");
  }
  return [
    ...common,
    `error: ${status.error}`,
    `latency: ${status.latencyMs}ms`,
  ].join("\n");
}

async function selectedServers(
  runtime: CliRuntime,
  serverId: string | undefined,
): Promise<readonly McpServerConfig[]> {
  if (serverId !== undefined) {
    return [await findMcpServer(runtime, serverId)];
  }
  return await listMcpServers(runtime);
}

function selectedMcpSchemaTarget(runtime: CliRuntime): McpProviderSchemaTarget {
  const providerId = selectedProviderId(runtime, undefined);
  const profile = providerProfile(providerId);
  const model = selectedModelFromProfile(
    runtime,
    undefined,
    providerId,
    profile,
  ).model;
  return mcpProviderSchemaTarget(providerId, model);
}

async function writeServerStatuses(
  runtime: CliRuntime,
  servers: readonly McpServerConfig[],
  includeIssues: boolean,
): Promise<readonly McpDiscoveryStatus[]> {
  const statuses: McpDiscoveryStatus[] = [];
  const schemaTarget = selectedMcpSchemaTarget(runtime);
  for (const [index, server] of servers.entries()) {
    const status = await discoverMcpServer({
      server,
      now: runtime.now,
      authProvider: createCliMcpAuthProvider(runtime, server),
      schemaTarget,
    });
    statuses.push(status);
    if (index > 0) runtime.writeStdout("\n");
    runtime.writeStdout(
      `${formatDiscoveryStatus(server, status, includeIssues)}\n`,
    );
  }
  return statuses;
}

async function runMcpAdd(
  cliArgs: Extract<McpCliArgs, { readonly mode: "add" }>,
  runtime: CliRuntime,
): Promise<number> {
  const validated = validateMcpServerUrl(
    cliArgs.url,
    cliArgs.allowPrivateNetwork,
  );
  const id = cliArgs.name ?? deriveMcpServerId(validated.url);
  validateMcpServerId(id);
  const server: McpServerConfig = {
    id,
    url: validated.url.href,
    allowPrivateNetwork: cliArgs.allowPrivateNetwork,
    authenticationRequired: false,
    toolFilter: {
      allow:
        cliArgs.allowTools.length === 0
          ? null
          : [...new Set(cliArgs.allowTools)],
      deny: [...new Set(cliArgs.denyTools)],
    },
  };
  await addMcpServer(runtime, server);
  runtime.writeStdout(`Added MCP server "${id}".\n`);
  const status = await discoverMcpServer({
    server,
    now: runtime.now,
    authProvider: createCliMcpAuthProvider(runtime, server),
    schemaTarget: selectedMcpSchemaTarget(runtime),
  });
  runtime.writeStdout(`${formatDiscoveryStatus(server, status, true)}\n`);
  return status.status === "failed" ? 1 : 0;
}

async function runMcpLogin(
  cliArgs: Extract<McpCliArgs, { readonly mode: "login" }>,
  runtime: CliRuntime,
): Promise<number> {
  const configuredServer = await findMcpServer(runtime, cliArgs.serverId);
  await setMcpServerAuthenticationRequired(runtime, configuredServer.id, true);
  const server: McpServerConfig = {
    ...configuredServer,
    authenticationRequired: true,
  };
  let preRegisteredClient: McpPreRegisteredClient | null = null;
  if (cliArgs.clientRegistration.kind === "pre-registered") {
    let clientSecret: string | null = null;
    if (cliArgs.clientRegistration.withClientSecret) {
      if (runtime.input.isTTY === true) {
        throw new McpOAuthLoginError(
          "Error: MCP authorization client secret must be piped on stdin; TTY input could echo the secret.",
        );
      }
      const chunks: Buffer[] = [];
      let byteLength = 0;
      for await (const chunk of runtime.input) {
        const bytes = Buffer.isBuffer(chunk)
          ? chunk
          : Buffer.from(String(chunk), "utf8");
        byteLength += bytes.length;
        if (byteLength > MCP_CLIENT_SECRET_MAX_BYTES) {
          throw new McpOAuthLoginError(
            `Error: MCP authorization client secret exceeds ${MCP_CLIENT_SECRET_MAX_BYTES} bytes.`,
          );
        }
        chunks.push(bytes);
      }
      const piped = Buffer.concat(chunks, byteLength).toString("utf8");
      clientSecret = piped.endsWith("\r\n")
        ? piped.slice(0, -2)
        : piped.endsWith("\n")
          ? piped.slice(0, -1)
          : piped;
      if (clientSecret === "") {
        throw new McpOAuthLoginError(
          "Error: MCP authorization requires a client secret on stdin.",
        );
      }
      if (/[\r\n]/u.test(clientSecret)) {
        throw new McpOAuthLoginError(
          "Error: MCP authorization requires a single-line client secret on stdin.",
        );
      }
    }
    preRegisteredClient = {
      clientId: cliArgs.clientRegistration.clientId,
      clientSecret,
    };
  }
  const state = randomBytes(32).toString("base64url");
  const callback = await startMcpOAuthLoopbackCallback(state);
  const controller = new AbortController();
  const abort = () => {
    controller.abort();
    void callback.close();
  };
  runtime.onSigint(abort);
  try {
    await authorizeMcpServer({
      server,
      backend: runtime.mcpSecretBackend,
      refreshLockRoot: mcpOAuthRefreshLockRoot(runtime),
      redirectUrl: callback.redirectUrl,
      state,
      startedAt: runtime.now(),
      preRegisteredClient,
      now: runtime.now,
      openExternalUrl: runtime.openExternalUrl,
      waitForCallback: callback.waitForCallback,
      signal: controller.signal,
    });
    runtime.writeStdout(`Logged in to MCP server "${server.id}".\n`);
    return 0;
  } finally {
    runtime.offSigint(abort);
    await callback.close();
  }
}

async function runMcpLogout(
  cliArgs: Extract<McpCliArgs, { readonly mode: "logout" }>,
  runtime: CliRuntime,
): Promise<number> {
  const server = await findMcpServer(runtime, cliArgs.serverId);
  await deleteMcpOAuthCredentials(server, runtime.mcpSecretBackend);
  await setMcpServerAuthenticationRequired(runtime, server.id, false);
  runtime.writeStdout(`Logged out of MCP server "${server.id}".\n`);
  return 0;
}

async function runMcpCommandUnsafe(
  cliArgs: McpCliArgs,
  runtime: CliRuntime,
): Promise<number> {
  if (cliArgs.mode === "add") {
    return await runMcpAdd(cliArgs, runtime);
  }
  if (cliArgs.mode === "list") {
    const servers = await listMcpServers(runtime);
    if (servers.length === 0) {
      runtime.writeStdout("No MCP servers configured.\n");
      return 0;
    }
    runtime.writeStdout(
      `${[
        "MCP servers:",
        ...servers.map((server) => {
          const policies = [
            ...(server.allowPrivateNetwork ? ["private network allowed"] : []),
            ...(server.toolFilter.allow === null
              ? []
              : [
                  `allow tools: ${displayMcpToolNames(server.toolFilter.allow)}`,
                ]),
            ...(server.toolFilter.deny.length === 0
              ? []
              : [`deny tools: ${displayMcpToolNames(server.toolFilter.deny)}`]),
          ];
          return `${server.id}: ${displayMcpEndpoint(server.url)}${policies.length === 0 ? "" : ` (${policies.join("; ")})`}`;
        }),
      ].join("\n")}\n`,
    );
    return 0;
  }
  if (cliArgs.mode === "login") {
    return await runMcpLogin(cliArgs, runtime);
  }
  if (cliArgs.mode === "logout") {
    return await runMcpLogout(cliArgs, runtime);
  }

  const servers = await selectedServers(runtime, cliArgs.serverId);
  if (servers.length === 0) {
    runtime.writeStdout("No MCP servers configured.\n");
    return 0;
  }
  const statuses = await writeServerStatuses(
    runtime,
    servers,
    cliArgs.mode === "doctor",
  );
  return cliArgs.mode === "doctor" &&
    statuses.some(
      (status) =>
        status.status !== "ready" ||
        status.catalog.quarantined > 0 ||
        status.provider.quarantined > 0,
    )
    ? 1
    : 0;
}

export async function runMcpCommand(
  cliArgs: McpCliArgs,
  runtime: CliRuntime,
): Promise<number> {
  try {
    return await runMcpCommandUnsafe(cliArgs, runtime);
  } catch (error) {
    if (
      error instanceof McpConfigError ||
      error instanceof McpNetworkPolicyError ||
      error instanceof McpOAuthCallbackError ||
      error instanceof McpOAuthCredentialError ||
      error instanceof McpOAuthLoginError
    ) {
      runtime.writeStderr(`${error.message}\n`);
      return 1;
    }
    /* v8 ignore next -- unexpected implementation faults must retain their identity for the outer CLI boundary. */
    throw error;
  }
}
