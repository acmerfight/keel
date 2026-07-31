import {
  AuthorizationServerMismatchError,
  InsufficientScopeError,
  IssuerMismatchError,
  OAuthClientFlowError,
  OAuthError,
  SdkError,
  SdkErrorCode,
  StreamableHTTPClientTransport,
  UnauthorizedError,
} from "@modelcontextprotocol/client";
import { z } from "zod";
import { connectMcpServer, createMcpSdkClient } from "./discovery.ts";
import {
  createMcpPolicyFetch,
  McpNetworkPolicyError,
  preflightMcpOAuthBrowserTarget,
  validateMcpServerUrl,
} from "./network.ts";
import {
  createMcpBearerAuthProvider,
  createMcpOAuthLoginProvider,
  deleteMcpOAuthCredentials,
  McpOAuthCredentialError,
  type McpOAuthServerEndpoint,
  type McpPreRegisteredClient,
  type McpSecretBackend,
} from "./oauth.ts";

const MCP_OAUTH_PROBE_TIMEOUT_MS = 10_000;
const wrappedCauseSchema = z
  .object({
    cause: z.unknown(),
  })
  .passthrough();

export class McpOAuthLoginError extends Error {}

function expectedNestedLoginError(error: unknown): Error | null {
  let current = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (
      current instanceof McpOAuthCredentialError ||
      current instanceof McpOAuthLoginError ||
      current instanceof McpNetworkPolicyError ||
      current instanceof IssuerMismatchError ||
      current instanceof AuthorizationServerMismatchError ||
      current instanceof InsufficientScopeError ||
      (SdkError.isInstance(current) &&
        current.code === SdkErrorCode.ClientHttpForbidden)
    ) {
      return current;
    }
    const wrapped = SdkError.isInstance(current)
      ? wrappedCauseSchema.safeParse(current.data)
      : wrappedCauseSchema.safeParse(current);
    if (!wrapped.success) return null;
    current = wrapped.data.cause;
  }
  /* v8 ignore next -- bounds traversal of adversarial third-party error cause chains. */
  return null;
}

function normalizedLoginError(error: unknown): Error {
  const expected = expectedNestedLoginError(error);
  if (expected instanceof InsufficientScopeError) {
    return new McpOAuthLoginError(
      "Error: MCP authorization scope remains insufficient. Verify the server's required OAuth scopes and try again.",
    );
  }
  if (
    SdkError.isInstance(expected) &&
    expected.code === SdkErrorCode.ClientHttpForbidden
  ) {
    return new McpOAuthLoginError(
      "Error: MCP authorization was rejected with HTTP 403. Verify the required OAuth scopes and server access policy before trying again.",
    );
  }
  if (
    expected instanceof IssuerMismatchError ||
    expected instanceof AuthorizationServerMismatchError
  ) {
    return new McpOAuthLoginError(
      "Error: MCP authorization callback issuer validation failed.",
    );
  }
  if (expected !== null) return expected;
  if (
    error instanceof OAuthClientFlowError ||
    error instanceof OAuthError ||
    SdkError.isInstance(error) ||
    UnauthorizedError.isInstance(error) ||
    error instanceof TypeError ||
    error instanceof SyntaxError
  ) {
    return new McpOAuthLoginError(
      "Error: MCP authorization server did not complete a valid OAuth flow.",
    );
  }
  /* v8 ignore next 3 -- SDK and injected adapters reject Error objects; retain a safe fallback for nonconforming third-party throws. */
  return error instanceof Error
    ? error
    : new McpOAuthLoginError("Error: MCP authorization failed.");
}

export async function authorizeMcpServer(options: {
  readonly server: McpOAuthServerEndpoint;
  readonly backend: McpSecretBackend;
  readonly refreshLockRoot: string;
  readonly redirectUrl: string;
  readonly state: string;
  readonly startedAt: number;
  readonly preRegisteredClient: McpPreRegisteredClient | null;
  readonly now: () => number;
  readonly openExternalUrl: (url: URL) => Promise<void>;
  readonly waitForCallback: () => Promise<URLSearchParams>;
  readonly isCurrentAndEnabled: () => Promise<boolean>;
  readonly signal: AbortSignal;
}): Promise<void> {
  const ensureAvailable = async (): Promise<void> => {
    if (!(await options.isCurrentAndEnabled())) {
      throw new McpOAuthLoginError(
        "Error: MCP server was disabled, removed, or changed during authorization.",
      );
    }
  };
  await ensureAvailable();
  const validated = validateMcpServerUrl(
    options.server.url,
    options.server.allowPrivateNetwork,
  );
  const network = createMcpPolicyFetch(validated);
  const provider = createMcpOAuthLoginProvider({
    server: options.server,
    backend: options.backend,
    refreshLockRoot: options.refreshLockRoot,
    isCurrentAndEnabled: async () => await options.isCurrentAndEnabled(),
    redirectUrl: options.redirectUrl,
    openAuthorizationUrl: async (authorizationUrl) => {
      await preflightMcpOAuthBrowserTarget(authorizationUrl, validated);
      await ensureAvailable();
      try {
        await options.openExternalUrl(authorizationUrl);
      } catch {
        await ensureAvailable();
        throw new McpOAuthLoginError(
          "Error: MCP authorization could not open the system browser.",
        );
      }
    },
    preRegisteredClient: options.preRegisteredClient,
    now: options.now,
  });
  const transport = new StreamableHTTPClientTransport(validated.url, {
    authProvider: provider,
    fetch: network.fetch,
  });
  const client = createMcpSdkClient();
  let flowFinished = false;
  try {
    await ensureAvailable();
    await provider.beginFlow(options.state, options.startedAt);
    let redirected = false;
    try {
      await client.connect(transport, {
        timeout: MCP_OAUTH_PROBE_TIMEOUT_MS,
        signal: options.signal,
      });
      await client.listTools(undefined, {
        timeout: MCP_OAUTH_PROBE_TIMEOUT_MS,
        cacheMode: "bypass",
        signal: options.signal,
      });
    } catch (error) {
      if (!UnauthorizedError.isInstance(error)) throw error;
      redirected = true;
    }
    if (redirected) {
      const callbackParams = await options.waitForCallback();
      await ensureAvailable();
      await provider.validateCallbackState(callbackParams);
      await ensureAvailable();
      await transport.finishAuth(callbackParams);
    }
    await ensureAvailable();
    await provider.finishFlow();
    flowFinished = true;
  } catch (error) {
    throw normalizedLoginError(error);
  } finally {
    if (!flowFinished) {
      await Promise.allSettled([provider.abortFlow()]);
      if (!(await options.isCurrentAndEnabled().catch(() => false))) {
        await Promise.allSettled([
          deleteMcpOAuthCredentials(
            options.server,
            options.backend,
            options.refreshLockRoot,
          ),
        ]);
      }
    }
    await Promise.allSettled([client.close(), network.close()]);
  }

  let connection: Awaited<ReturnType<typeof connectMcpServer>> | null = null;
  try {
    connection = await connectMcpServer(
      options.server,
      options.signal,
      createMcpBearerAuthProvider({
        server: options.server,
        backend: options.backend,
        refreshLockRoot: options.refreshLockRoot,
        isCurrentAndEnabled: async () => await options.isCurrentAndEnabled(),
      }),
    );
    await connection.listCatalog(options.signal);
    await ensureAvailable();
  } catch (error) {
    if (!(await options.isCurrentAndEnabled().catch(() => false))) {
      await Promise.allSettled([
        deleteMcpOAuthCredentials(
          options.server,
          options.backend,
          options.refreshLockRoot,
        ),
      ]);
    }
    throw normalizedLoginError(error);
  } finally {
    await Promise.allSettled(connection === null ? [] : [connection.close()]);
  }
}
