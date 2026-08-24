import { randomUUID } from "node:crypto";
import type {
  OAuthClientInformationContext,
  OAuthClientMetadata,
  OAuthClientProvider,
  OAuthDiscoveryState,
  StoredOAuthClientInformation,
  StoredOAuthTokens,
} from "@modelcontextprotocol/client";
import { validateClientMetadataUrl } from "@modelcontextprotocol/client";
import { MCP_CIMD_CLIENT_ID, type McpCimdRedirectUri } from "../cimd.ts";
import {
  credentialError,
  issuerRevocationMetadata,
  type McpOAuthServerEndpoint,
  McpOAuthServerUnavailableError,
  type McpSecretBackend,
  OAuthCredentialStore,
  replaceIssuerValue,
  storedOAuthClientInformationSchema,
  storedOAuthDiscoveryStateSchema,
  storedOAuthTokensSchema,
} from "./credential-store.ts";

const MCP_OAUTH_FLOW_LIFETIME_MS = 2 * 60 * 1000;

export interface McpPreRegisteredClient {
  readonly clientId: string;
  readonly clientSecret: string | null;
}

export interface McpOAuthLoginProvider extends OAuthClientProvider {
  readonly state: () => Promise<string>;
  readonly saveClientInformation: (
    clientInformation: StoredOAuthClientInformation,
    context?: OAuthClientInformationContext,
  ) => Promise<void>;
  readonly saveTokens: (
    tokens: StoredOAuthTokens,
    context?: OAuthClientInformationContext,
  ) => Promise<void>;
  readonly saveDiscoveryState: (state: OAuthDiscoveryState) => Promise<void>;
  readonly discoveryState: () => Promise<OAuthDiscoveryState | undefined>;
  readonly beginFlow: (state: string, startedAt: number) => Promise<void>;
  readonly validateCallbackState: (
    callbackParams: URLSearchParams,
  ) => Promise<void>;
  readonly finishFlow: () => Promise<void>;
  readonly abortFlow: () => Promise<void>;
}

function contextIssuer(
  context: OAuthClientInformationContext | undefined,
): string {
  if (context === undefined) {
    credentialError("SDK omitted the authorization issuer binding");
  }
  return context.issuer;
}

function requireIssuerMatch(
  valueIssuer: string | undefined,
  contextIssuerValue: string,
): void {
  if (
    valueIssuer !== undefined &&
    new URL(valueIssuer).href !== new URL(contextIssuerValue).href
  ) {
    credentialError("refused credentials with a mismatched issuer binding");
  }
}

function sameClientIdentity(
  left: StoredOAuthClientInformation,
  right: StoredOAuthClientInformation,
): boolean {
  return (
    left.client_id === right.client_id &&
    (left.client_secret ?? null) === (right.client_secret ?? null)
  );
}

function withoutRefreshToken(tokens: StoredOAuthTokens): StoredOAuthTokens {
  const accessOnly = { ...tokens };
  delete accessOnly.refresh_token;
  return accessOnly;
}

class KeelMcpOAuthProvider implements McpOAuthLoginProvider {
  readonly clientMetadataUrl = MCP_CIMD_CLIENT_ID;
  readonly redirectUrl: McpCimdRedirectUri;
  readonly clientMetadata: OAuthClientMetadata;
  private readonly store: OAuthCredentialStore;
  private readonly openAuthorizationUrl: (url: URL) => Promise<void>;
  private readonly preRegisteredClient: McpPreRegisteredClient | null;
  private readonly resource: string;
  private readonly now: () => number;

  constructor(options: {
    readonly server: McpOAuthServerEndpoint;
    readonly backend: McpSecretBackend;
    readonly refreshLockRoot: string;
    readonly validateRefreshLockRoot?: (() => void) | undefined;
    readonly isCurrentAndEnabled: (
      server: McpOAuthServerEndpoint,
    ) => boolean | Promise<boolean>;
    readonly redirectUrl: McpCimdRedirectUri;
    readonly openAuthorizationUrl: (url: URL) => Promise<void>;
    readonly preRegisteredClient: McpPreRegisteredClient | null;
    readonly now: () => number;
  }) {
    this.redirectUrl = options.redirectUrl;
    this.store = new OAuthCredentialStore({
      server: options.server,
      backend: options.backend,
      refreshLockRoot: options.refreshLockRoot,
      validateRefreshLockRoot: options.validateRefreshLockRoot,
      mutationGuard: async () => {
        if (!(await options.isCurrentAndEnabled(options.server))) {
          throw new McpOAuthServerUnavailableError(
            "Error: MCP server is disabled, removed, or no longer matches this authorization session.",
          );
        }
      },
    });
    this.openAuthorizationUrl = options.openAuthorizationUrl;
    this.preRegisteredClient = options.preRegisteredClient;
    this.resource = new URL(options.server.url).href;
    this.now = options.now;
    validateClientMetadataUrl(this.clientMetadataUrl);
    this.clientMetadata = {
      redirect_uris: [options.redirectUrl],
      client_name: "Keel",
      client_uri: "https://github.com/acmerfight/keel",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method:
        options.preRegisteredClient?.clientSecret === null ||
        options.preRegisteredClient === null
          ? "none"
          : "client_secret_basic",
    };
  }

  async beginFlow(state: string, startedAt: number): Promise<void> {
    await this.store.update((record) => {
      return {
        next: {
          ...record,
          flow: {
            status: "awaiting-callback",
            state,
            resource: record.resource,
            expectedIssuer: null,
            clientId: null,
            redirectUri: this.redirectUrl,
            codeVerifier: null,
            startedAt,
            expiresAt: startedAt + MCP_OAUTH_FLOW_LIFETIME_MS,
          },
        },
        result: undefined,
      };
    });
  }

  async state(): Promise<string> {
    const flow = (await this.store.load()).flow;
    if (flow.status !== "awaiting-callback") {
      credentialError("has no pending login state");
    }
    return flow.state;
  }

  async clientInformation(
    context?: OAuthClientInformationContext,
  ): Promise<StoredOAuthClientInformation | undefined> {
    const issuer = contextIssuer(context);
    if (this.preRegisteredClient !== null) {
      const explicit: StoredOAuthClientInformation = {
        client_id: this.preRegisteredClient.clientId,
        ...(this.preRegisteredClient.clientSecret === null
          ? {}
          : { client_secret: this.preRegisteredClient.clientSecret }),
        issuer,
      };
      await this.saveClientInformation(explicit, context);
      return explicit;
    }
    return await this.store.update((record) => {
      const stored = record.credentials.find(
        (entry) => entry.issuer === issuer,
      );
      if (stored !== undefined) {
        return {
          next:
            record.flow.status === "awaiting-callback"
              ? {
                  ...record,
                  flow: {
                    ...record.flow,
                    expectedIssuer: issuer,
                    clientId: stored.client.client_id,
                  },
                }
              : null,
          result: stored.client,
        };
      }
      if (
        record.discovery?.authorizationServerMetadata
          ?.client_id_metadata_document_supported !== true &&
        record.discovery?.authorizationServerMetadata?.registration_endpoint ===
          undefined
      ) {
        credentialError(
          "server has no reusable client and does not advertise dynamic registration; configure a pre-registered client",
        );
      }
      return { next: null, result: undefined };
    });
  }

  async saveClientInformation(
    clientInformation: StoredOAuthClientInformation,
    context?: OAuthClientInformationContext,
  ): Promise<void> {
    const issuer = contextIssuer(context);
    requireIssuerMatch(clientInformation.issuer, issuer);
    const value = storedOAuthClientInformationSchema.parse({
      ...clientInformation,
      issuer,
    });
    await this.store.update((record) => {
      const existing = record.credentials.find(
        (credentials) => credentials.issuer === issuer,
      );
      const identityMatches =
        existing !== undefined && sameClientIdentity(existing.client, value);
      return {
        next: {
          ...record,
          activeAuthorization:
            record.activeAuthorization?.issuer === issuer && !identityMatches
              ? null
              : record.activeAuthorization,
          credentials: replaceIssuerValue(record.credentials, {
            issuer,
            client: value,
            tokens: identityMatches ? existing.tokens : null,
            revocation: issuerRevocationMetadata(record.discovery, issuer),
          }),
          flow:
            record.flow.status === "awaiting-callback"
              ? {
                  ...record.flow,
                  expectedIssuer: issuer,
                  clientId: value.client_id,
                }
              : record.flow,
        },
        result: undefined,
      };
    });
  }

  async tokens(
    context?: OAuthClientInformationContext,
  ): Promise<StoredOAuthTokens | undefined> {
    const record = await this.store.load();
    const issuer =
      context?.issuer ?? record.activeAuthorization?.issuer ?? null;
    if (issuer === null) return undefined;
    const stored = record.credentials.find(
      (entry) => entry.issuer === issuer,
    )?.tokens;
    if (stored === null) return undefined;
    if (stored === undefined) return undefined;
    // The login provider never exposes refresh_token to the SDK. Request-time
    // refresh is owned by KeelMcpBearerAuthProvider so the read-refresh-write
    // transaction is serialized and rotating credentials are published first.
    return withoutRefreshToken(stored);
  }

  async saveTokens(
    tokens: StoredOAuthTokens,
    context?: OAuthClientInformationContext,
  ): Promise<void> {
    const issuer = contextIssuer(context);
    requireIssuerMatch(tokens.issuer, issuer);
    const value = storedOAuthTokensSchema.parse({ ...tokens, issuer });
    await this.store.update((record) => {
      const credentials = record.credentials.find(
        (entry) => entry.issuer === issuer,
      );
      if (credentials === undefined) {
        credentialError("refused tokens without an issuer-bound OAuth client");
      }
      if (
        record.flow.status === "callback-consumed" &&
        (new URL(record.flow.expectedIssuer).href !== new URL(issuer).href ||
          record.flow.clientId !== credentials.client.client_id)
      ) {
        credentialError(
          "refused tokens from a different callback issuer or client",
        );
      }
      return {
        next: {
          ...record,
          activeAuthorization: {
            issuer,
            clientId: credentials.client.client_id,
            grantId:
              record.flow.status === "callback-consumed"
                ? randomUUID()
                : (record.activeAuthorization?.grantId ?? randomUUID()),
          },
          credentials: replaceIssuerValue(record.credentials, {
            ...credentials,
            tokens: value,
          }),
        },
        result: undefined,
      };
    });
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    await this.openAuthorizationUrl(authorizationUrl);
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    await this.store.update((record) => {
      if (record.flow.status !== "awaiting-callback") {
        credentialError("has no pending login for the PKCE verifier");
      }
      return {
        next: {
          ...record,
          flow: { ...record.flow, codeVerifier },
        },
        result: undefined,
      };
    });
  }

  async codeVerifier(): Promise<string> {
    const flow = (await this.store.load()).flow;
    if (flow.status === "callback-consumed") return flow.codeVerifier;
    if (flow.status !== "awaiting-callback" || flow.codeVerifier === null) {
      credentialError("has no PKCE verifier for the pending login");
    }
    return flow.codeVerifier;
  }

  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    const discovery = storedOAuthDiscoveryStateSchema.parse(state);
    if (
      discovery.resourceMetadata !== undefined &&
      new URL(discovery.resourceMetadata.resource).href !== this.resource
    ) {
      credentialError("refused discovery bound to a different resource");
    }
    await this.store.update((record) => {
      const expectedIssuer =
        discovery.authorizationServerMetadata?.issuer ??
        discovery.authorizationServerUrl;
      if (
        record.flow.status === "callback-consumed" &&
        new URL(record.flow.expectedIssuer).href !==
          new URL(expectedIssuer).href
      ) {
        credentialError("refused discovery from a different callback issuer");
      }
      return {
        next: {
          ...record,
          discovery,
          credentials: record.credentials.map((credentials) =>
            new URL(credentials.issuer).href === new URL(expectedIssuer).href
              ? {
                  ...credentials,
                  revocation: issuerRevocationMetadata(
                    discovery,
                    credentials.issuer,
                  ),
                }
              : credentials,
          ),
          flow:
            record.flow.status === "awaiting-callback"
              ? { ...record.flow, expectedIssuer }
              : record.flow,
        },
        result: undefined,
      };
    });
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    return (await this.store.load()).discovery ?? undefined;
  }

  async validateCallbackState(callbackParams: URLSearchParams): Promise<void> {
    await this.store.update((record) => {
      const flow = record.flow;
      if (flow.status !== "awaiting-callback") {
        credentialError("received a callback without a pending login");
      }
      if (this.now() >= flow.expiresAt) {
        credentialError("rejected an expired callback state");
      }
      const state = callbackParams.get("state");
      if (state === null || state !== flow.state) {
        credentialError("rejected a callback with an invalid state binding");
      }
      if (
        flow.codeVerifier === null ||
        flow.expectedIssuer === null ||
        flow.clientId === null
      ) {
        credentialError("callback flow is missing a bound OAuth value");
      }
      return {
        next: {
          ...record,
          flow: {
            status: "callback-consumed",
            resource: flow.resource,
            expectedIssuer: flow.expectedIssuer,
            clientId: flow.clientId,
            redirectUri: flow.redirectUri,
            codeVerifier: flow.codeVerifier,
            startedAt: flow.startedAt,
            expiresAt: flow.expiresAt,
          },
        },
        result: undefined,
      };
    });
  }

  async finishFlow(): Promise<void> {
    await this.store.update((record) => ({
      next: { ...record, flow: { status: "idle" } },
      result: undefined,
    }));
  }

  async abortFlow(): Promise<void> {
    await this.store.update((record) => ({
      next:
        record.flow.status === "idle"
          ? null
          : { ...record, flow: { status: "idle" } },
      result: undefined,
    }));
  }
}

export function createMcpOAuthLoginProvider(options: {
  readonly server: McpOAuthServerEndpoint;
  readonly backend: McpSecretBackend;
  readonly refreshLockRoot: string;
  readonly validateRefreshLockRoot?: (() => void) | undefined;
  readonly isCurrentAndEnabled: (
    server: McpOAuthServerEndpoint,
  ) => boolean | Promise<boolean>;
  readonly redirectUrl: McpCimdRedirectUri;
  readonly openAuthorizationUrl: (url: URL) => Promise<void>;
  readonly preRegisteredClient: McpPreRegisteredClient | null;
  readonly now: () => number;
}): McpOAuthLoginProvider {
  return new KeelMcpOAuthProvider(options);
}
