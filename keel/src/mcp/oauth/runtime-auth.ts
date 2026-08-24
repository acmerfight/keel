import { AsyncLocalStorage } from "node:async_hooks";
import { join } from "node:path";
import type { AuthProvider, FetchLike } from "@modelcontextprotocol/client";
import {
  OAuthError,
  OAuthErrorCode,
  refreshAuthorization,
  UnauthorizedError,
} from "@modelcontextprotocol/client";
import { withMcpOAuthRefreshLock } from "../oauth-refresh-lock.ts";
import {
  credentialError,
  type IssuerCredentials,
  McpOAuthCredentialError,
  McpOAuthCredentialUnavailableError,
  type McpOAuthServerEndpoint,
  McpOAuthServerUnavailableError,
  type McpSecretBackend,
  type OAuthCredentialRecord,
  OAuthCredentialStore,
  type OAuthIssuerGrant,
  replaceIssuerValue,
  storedOAuthTokensSchema,
} from "./credential-store.ts";

const MCP_OAUTH_REFRESH_TIMEOUT_MS = 30_000;
type UnauthorizedHandler = NonNullable<AuthProvider["onUnauthorized"]>;
type UnauthorizedContext = Parameters<UnauthorizedHandler>[0];

export type McpAuthorizationIdentity =
  | { readonly kind: "anonymous" }
  | {
      readonly kind: "oauth";
      readonly issuer: string;
      readonly clientId: string;
      readonly grantId: string;
    };

export function sameMcpAuthorizationIdentity(
  left: McpAuthorizationIdentity,
  right: McpAuthorizationIdentity,
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "anonymous" || right.kind === "anonymous") return true;
  return (
    left.issuer === right.issuer &&
    left.clientId === right.clientId &&
    left.grantId === right.grantId
  );
}

export interface McpRuntimeAuthProvider extends AuthProvider {
  readonly authorizationIdentity: () => Promise<McpAuthorizationIdentity>;
  readonly withAuthorizationIdentity: <Result>(
    expected: McpAuthorizationIdentity,
    action: () => Promise<Result>,
  ) => Promise<Result>;
  readonly wrapFetch: (fetchFn: FetchLike) => FetchLike;
  readonly onUnauthorized: UnauthorizedHandler;
}

export class McpOAuthAuthenticationRequiredError extends McpOAuthCredentialError {}

export function isMcpAuthenticationRequiredError(error: unknown): boolean {
  return (
    UnauthorizedError.isInstance(error) ||
    error instanceof McpOAuthAuthenticationRequiredError
  );
}

const activeRefreshes = new Map<string, Promise<void>>();

function activeCredentials(
  record: OAuthCredentialRecord,
): OAuthIssuerGrant | null {
  const active = record.activeAuthorization;
  if (active === null) return null;
  /* v8 ignore next -- parsed credential records guarantee that an active binding identifies one stored non-null token entry. */
  return (
    record.credentials.find(
      (entry): entry is OAuthIssuerGrant =>
        entry.issuer === active.issuer &&
        entry.client.client_id === active.clientId &&
        entry.tokens !== null,
    ) ?? null
  );
}

function authorizationIdentity(
  record: OAuthCredentialRecord,
): McpAuthorizationIdentity {
  const active = record.activeAuthorization;
  return active === null
    ? { kind: "anonymous" }
    : {
        kind: "oauth",
        issuer: active.issuer,
        clientId: active.clientId,
        grantId: active.grantId,
      };
}

function authorizationBearerToken(
  init: Parameters<FetchLike>[1],
): string | null {
  const headers = new Headers(init?.headers);
  const authorization = headers.get("authorization");
  if (authorization === null) return null;
  const match = /^Bearer ([^\s]+)$/iu.exec(authorization);
  return match?.[1] ?? null;
}

function refreshFetch(fetchFn: FetchLike): FetchLike {
  return async (input, init) => {
    const timeout = AbortSignal.timeout(MCP_OAUTH_REFRESH_TIMEOUT_MS);
    /* v8 ignore next -- stable SDK v2 currently omits a token-request signal; retain composition for future SDK cancellation support. */
    const signal =
      init?.signal === undefined || init.signal === null
        ? timeout
        : AbortSignal.any([init.signal, timeout]);
    return await fetchFn(input, { ...init, signal });
  };
}

async function deactivateRejectedCredentials(
  store: OAuthCredentialStore,
  record: OAuthCredentialRecord,
  credentials: IssuerCredentials,
): Promise<void> {
  await store.saveUnderLock({
    ...record,
    activeAuthorization: null,
    credentials: replaceIssuerValue(record.credentials, {
      ...credentials,
      tokens: null,
    }),
  });
}

function authenticationRequired(message: string): never {
  throw new McpOAuthAuthenticationRequiredError(
    `Error: MCP authorization ${message}. Run keel mcp login to authorize again.`,
  );
}

function requireAuthorizationIdentity(
  record: OAuthCredentialRecord,
  expected: McpAuthorizationIdentity | null,
): void {
  if (
    expected !== null &&
    !sameMcpAuthorizationIdentity(expected, authorizationIdentity(record))
  ) {
    authenticationRequired(
      "changed authorization identity before authenticated dispatch",
    );
  }
}

async function refreshRejectedCredential(options: {
  readonly store: OAuthCredentialStore;
  readonly refreshLockRoot: string;
  readonly validateRefreshLockRoot?: (() => void) | undefined;
  readonly rejectedAccessToken: string;
  readonly expectedAuthorizationIdentity: McpAuthorizationIdentity | null;
  readonly fetchFn: FetchLike;
  readonly ensureAvailable: () => Promise<void>;
}): Promise<void> {
  await withMcpOAuthRefreshLock({
    root: options.refreshLockRoot,
    validateRoot: options.validateRefreshLockRoot,
    credentialId: options.store.credentialId(),
    action: async () => {
      await options.ensureAvailable();
      const record = await options.store.load();
      requireAuthorizationIdentity(
        record,
        options.expectedAuthorizationIdentity,
      );
      const credentials = activeCredentials(record);
      if (credentials === null) {
        authenticationRequired("requires an active OAuth credential");
      }
      if (credentials.tokens.access_token !== options.rejectedAccessToken) {
        return;
      }
      const refreshToken = credentials.tokens.refresh_token;
      if (refreshToken === undefined) {
        await deactivateRejectedCredentials(options.store, record, credentials);
        authenticationRequired("has no usable refresh credential");
      }
      const discovery = record.discovery;
      const metadata = discovery?.authorizationServerMetadata;
      if (
        discovery === null ||
        metadata === undefined ||
        new URL(metadata.issuer).href !== new URL(credentials.issuer).href
      ) {
        credentialError(
          "credential record has no matching authorization-server discovery state for refresh",
        );
      }
      let refreshed: Awaited<ReturnType<typeof refreshAuthorization>>;
      try {
        refreshed = await refreshAuthorization(
          discovery.authorizationServerUrl,
          {
            metadata,
            clientInformation: credentials.client,
            refreshToken,
            resource: new URL(record.resource),
            fetchFn: refreshFetch(options.fetchFn),
          },
        );
      } catch (error) {
        if (
          error instanceof OAuthError &&
          error.code === OAuthErrorCode.InvalidGrant
        ) {
          await options.ensureAvailable();
          await deactivateRejectedCredentials(
            options.store,
            record,
            credentials,
          );
          authenticationRequired("refresh credential was rejected");
        }
        throw error;
      }
      // The stable SDK preserves an omitted refresh_token. Keel additionally
      // preserves scope because RFC 6749 allows refresh responses to omit it.
      const value = storedOAuthTokensSchema.parse({
        ...refreshed,
        ...(refreshed.scope === undefined &&
        credentials.tokens.scope !== undefined
          ? { scope: credentials.tokens.scope }
          : {}),
        issuer: credentials.issuer,
      });
      await options.ensureAvailable();
      await options.store.saveUnderLock({
        ...record,
        credentials: replaceIssuerValue(record.credentials, {
          ...credentials,
          tokens: value,
        }),
      });
    },
  });
}

async function singleFlightRefresh(
  credentialId: string,
  action: () => Promise<void>,
): Promise<void> {
  const pending = activeRefreshes.get(credentialId);
  if (pending !== undefined) {
    await pending;
    return;
  }
  const operation = action();
  activeRefreshes.set(credentialId, operation);
  try {
    await operation;
  } finally {
    activeRefreshes.delete(credentialId);
  }
}

class KeelMcpBearerAuthProvider implements McpRuntimeAuthProvider {
  private readonly server: McpOAuthServerEndpoint;
  private readonly store: OAuthCredentialStore;
  private readonly refreshLockRoot: string;
  private readonly validateRefreshLockRoot: (() => void) | undefined;
  private readonly isCurrentAndEnabled: (
    server: McpOAuthServerEndpoint,
  ) => boolean | Promise<boolean>;
  private readonly rejectedTokens = new WeakMap<Response, string>();
  private readonly expectedAuthorization =
    new AsyncLocalStorage<McpAuthorizationIdentity>();
  private readonly fixedAuthorizationIdentity:
    | McpAuthorizationIdentity
    | undefined;

  constructor(options: {
    readonly server: McpOAuthServerEndpoint;
    readonly backend: McpSecretBackend;
    readonly refreshLockRoot: string;
    readonly validateRefreshLockRoot?: (() => void) | undefined;
    readonly isCurrentAndEnabled: (
      server: McpOAuthServerEndpoint,
    ) => boolean | Promise<boolean>;
    readonly fixedAuthorizationIdentity?: McpAuthorizationIdentity;
  }) {
    this.server = options.server;
    this.store = new OAuthCredentialStore({
      server: options.server,
      backend: options.backend,
      refreshLockRoot: options.refreshLockRoot,
      validateRefreshLockRoot: options.validateRefreshLockRoot,
      mutationGuard: null,
    });
    this.refreshLockRoot = options.refreshLockRoot;
    this.validateRefreshLockRoot = options.validateRefreshLockRoot;
    this.isCurrentAndEnabled = options.isCurrentAndEnabled;
    this.fixedAuthorizationIdentity = options.fixedAuthorizationIdentity;
  }

  private async ensureAvailable(): Promise<void> {
    if (!(await this.isCurrentAndEnabled(this.server))) {
      throw new McpOAuthServerUnavailableError(
        "Error: MCP server is disabled, removed, or no longer matches this authorization session.",
      );
    }
  }

  async token(): Promise<string | undefined> {
    await this.ensureAvailable();
    let record: OAuthCredentialRecord;
    try {
      record = await this.store.load();
    } catch (error) {
      if (error instanceof McpOAuthCredentialUnavailableError) {
        if (this.server.authenticationRequired) throw error;
        return undefined;
      }
      throw error;
    }
    requireAuthorizationIdentity(
      record,
      this.expectedAuthorization.getStore() ??
        this.fixedAuthorizationIdentity ??
        null,
    );
    const accessToken = activeCredentials(record)?.tokens.access_token;
    if (accessToken === undefined && this.server.authenticationRequired) {
      throw new McpOAuthAuthenticationRequiredError(
        "Error: MCP authorization requires an active OAuth credential.",
      );
    }
    return accessToken;
  }

  async authorizationIdentity(): Promise<McpAuthorizationIdentity> {
    await this.ensureAvailable();
    let record: OAuthCredentialRecord;
    try {
      record = await this.store.load();
    } catch (error) {
      if (error instanceof McpOAuthCredentialUnavailableError) {
        if (this.server.authenticationRequired) throw error;
        return { kind: "anonymous" };
      }
      throw error;
    }
    const identity = authorizationIdentity(record);
    const expected = this.fixedAuthorizationIdentity;
    if (
      expected !== undefined &&
      !sameMcpAuthorizationIdentity(expected, identity)
    ) {
      throw new McpOAuthCredentialUnavailableError(
        "Error: MCP authorization identity changed after capability admission.",
      );
    }
    return identity;
  }

  async withAuthorizationIdentity<Result>(
    expected: McpAuthorizationIdentity,
    action: () => Promise<Result>,
  ): Promise<Result> {
    if (
      this.fixedAuthorizationIdentity !== undefined &&
      !sameMcpAuthorizationIdentity(this.fixedAuthorizationIdentity, expected)
    ) {
      throw new McpOAuthCredentialUnavailableError(
        "Error: MCP authorization identity changed after capability admission.",
      );
    }
    return await this.expectedAuthorization.run(expected, action);
  }

  wrapFetch(fetchFn: FetchLike): FetchLike {
    return async (input, init) => {
      const accessToken = authorizationBearerToken(init);
      const response = await fetchFn(input, init);
      if (response.status === 401 && accessToken !== null) {
        this.rejectedTokens.set(response, accessToken);
      }
      return response;
    };
  }

  async onUnauthorized(context: UnauthorizedContext): Promise<void> {
    await this.ensureAvailable();
    const rejectedAccessToken = this.rejectedTokens.get(context.response);
    if (rejectedAccessToken === undefined) {
      authenticationRequired("requires login before retrying this request");
    }
    const credentialId = this.store.credentialId();
    const refreshIdentity = join(this.refreshLockRoot, credentialId);
    await singleFlightRefresh(refreshIdentity, async () => {
      await refreshRejectedCredential({
        store: this.store,
        refreshLockRoot: this.refreshLockRoot,
        validateRefreshLockRoot: this.validateRefreshLockRoot,
        rejectedAccessToken,
        expectedAuthorizationIdentity:
          this.expectedAuthorization.getStore() ??
          this.fixedAuthorizationIdentity ??
          null,
        fetchFn: context.fetchFn,
        ensureAvailable: async () => await this.ensureAvailable(),
      });
    });
  }
}

export function createMcpBearerAuthProvider(options: {
  readonly server: McpOAuthServerEndpoint;
  readonly backend: McpSecretBackend;
  readonly refreshLockRoot: string;
  readonly validateRefreshLockRoot?: (() => void) | undefined;
  readonly isCurrentAndEnabled: (
    server: McpOAuthServerEndpoint,
  ) => boolean | Promise<boolean>;
  readonly fixedAuthorizationIdentity?: McpAuthorizationIdentity;
}): McpRuntimeAuthProvider {
  return new KeelMcpBearerAuthProvider(options);
}
