import { createHash } from "node:crypto";
import type {
  AuthProvider,
  OAuthClientInformationContext,
  OAuthClientMetadata,
  OAuthClientProvider,
  OAuthDiscoveryState,
  StoredOAuthClientInformation,
  StoredOAuthTokens,
} from "@modelcontextprotocol/client";
import { z } from "zod";
import type { McpServerEndpoint } from "./discovery.ts";

const MCP_OAUTH_SECRET_SERVICE = "Keel MCP OAuth";
const MCP_OAUTH_SECRET_SCHEMA_VERSION = 1;
const MCP_OAUTH_MAX_ISSUERS = 16;
const MCP_OAUTH_MAX_SECRET_BYTES = 1024 * 1024;
const MCP_OAUTH_FLOW_LIFETIME_MS = 2 * 60 * 1000;

const oauthTokensSchema = z
  .object({
    access_token: z.string().min(1),
    id_token: z.string().min(1).optional(),
    token_type: z.string().min(1),
    expires_in: z.number().nonnegative().optional(),
    scope: z.string().optional(),
    refresh_token: z.string().min(1).optional(),
    issuer: z.string().url(),
  })
  .strict();
const oauthClientInformationSchema = z
  .looseObject({
    client_id: z.string().min(1),
    client_secret: z.string().min(1).optional(),
    client_id_issued_at: z.number().nonnegative().optional(),
    client_secret_expires_at: z.number().nonnegative().optional(),
    issuer: z.string().url(),
    redirect_uris: z.array(z.string().url()).optional(),
    token_endpoint_auth_method: z.string().optional(),
    grant_types: z.array(z.string()).optional(),
    response_types: z.array(z.string()).optional(),
    client_name: z.string().optional(),
    client_uri: z.string().url().optional(),
    scope: z.string().optional(),
  })
  .catchall(z.json());
const storedOAuthTokensSchema = z.custom<StoredOAuthTokens>(
  (value) => oauthTokensSchema.safeParse(value).success,
);
const storedOAuthClientInformationSchema =
  z.custom<StoredOAuthClientInformation>(
    (value) => oauthClientInformationSchema.safeParse(value).success,
  );
const oauthAuthorizationServerMetadataSchema = z
  .looseObject({
    issuer: z.string().url(),
    authorization_endpoint: z.string().url(),
    token_endpoint: z.string().url(),
    registration_endpoint: z.string().url().optional(),
    scopes_supported: z.array(z.string()).optional(),
    response_types_supported: z.array(z.string()),
    response_modes_supported: z.array(z.string()).optional(),
    grant_types_supported: z.array(z.string()).optional(),
    token_endpoint_auth_methods_supported: z.array(z.string()).optional(),
    code_challenge_methods_supported: z.array(z.string()).optional(),
    client_id_metadata_document_supported: z.boolean().optional(),
    authorization_response_iss_parameter_supported: z.boolean().optional(),
  })
  .catchall(z.json());
const oauthProtectedResourceMetadataSchema = z
  .looseObject({
    resource: z.string().url(),
    authorization_servers: z.array(z.string().url()).optional(),
    jwks_uri: z.string().url().optional(),
    scopes_supported: z.array(z.string()).optional(),
    bearer_methods_supported: z.array(z.string()).optional(),
  })
  .catchall(z.json());
const oauthDiscoveryStateSchema = z
  .object({
    authorizationServerUrl: z.string().url(),
    resourceMetadataUrl: z.string().url().optional(),
    authorizationServerMetadata:
      oauthAuthorizationServerMetadataSchema.optional(),
    resourceMetadata: oauthProtectedResourceMetadataSchema.optional(),
  })
  .strict();
const storedOAuthDiscoveryStateSchema = z.custom<OAuthDiscoveryState>(
  (value) => oauthDiscoveryStateSchema.safeParse(value).success,
);
const issuerCredentialsSchema = z
  .object({
    issuer: z.string().url(),
    client: storedOAuthClientInformationSchema,
    tokens: storedOAuthTokensSchema.nullable(),
  })
  .strict()
  .superRefine((credentials, context) => {
    if (
      credentials.client.issuer !== credentials.issuer ||
      (credentials.tokens !== null &&
        credentials.tokens.issuer !== credentials.issuer)
    ) {
      context.addIssue({
        code: "custom",
        message: "credential issuer bindings must match",
      });
    }
  });
const activeAuthorizationSchema = z
  .object({
    issuer: z.string().url(),
    clientId: z.string().min(1),
  })
  .strict();
const oauthFlowSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("idle") }).strict(),
  z
    .object({
      status: z.literal("awaiting-callback"),
      state: z.string().min(32),
      resource: z.string().url(),
      expectedIssuer: z.string().url().nullable(),
      clientId: z.string().min(1).nullable(),
      redirectUri: z.string().url(),
      codeVerifier: z.string().min(43).nullable(),
      startedAt: z.number().int().nonnegative(),
      expiresAt: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      status: z.literal("callback-consumed"),
      resource: z.string().url(),
      expectedIssuer: z.string().url(),
      clientId: z.string().min(1),
      redirectUri: z.string().url(),
      codeVerifier: z.string().min(43),
      startedAt: z.number().int().nonnegative(),
      expiresAt: z.number().int().positive(),
    })
    .strict(),
]);
const oauthCredentialRecordSchema = z
  .object({
    schemaVersion: z.literal(MCP_OAUTH_SECRET_SCHEMA_VERSION),
    resource: z.string().url(),
    activeAuthorization: activeAuthorizationSchema.nullable(),
    credentials: z.array(issuerCredentialsSchema).max(MCP_OAUTH_MAX_ISSUERS),
    discovery: storedOAuthDiscoveryStateSchema.nullable(),
    flow: oauthFlowSchema,
  })
  .strict()
  .superRefine((record, context) => {
    const activeAuthorization = record.activeAuthorization;
    if (activeAuthorization === null) return;
    const active = record.credentials.find(
      (credentials) =>
        credentials.issuer === activeAuthorization.issuer &&
        credentials.client.client_id === activeAuthorization.clientId &&
        credentials.tokens !== null,
    );
    if (active === undefined) {
      context.addIssue({
        code: "custom",
        path: ["activeAuthorization"],
        message: "active authorization must identify stored client tokens",
      });
    }
  });

type OAuthCredentialRecord = z.infer<typeof oauthCredentialRecordSchema>;

export interface McpSecretBackend {
  readonly getPassword: (
    service: string,
    account: string,
  ) => Promise<string | null>;
  readonly setPassword: (
    service: string,
    account: string,
    password: string,
  ) => Promise<void>;
  readonly deletePassword: (
    service: string,
    account: string,
  ) => Promise<boolean>;
}

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

export class McpOAuthCredentialError extends Error {}
export class McpOAuthAuthenticationRequiredError extends McpOAuthCredentialError {}
class McpOAuthCredentialUnavailableError extends McpOAuthCredentialError {}

function emptyRecord(resource: string): OAuthCredentialRecord {
  return {
    schemaVersion: MCP_OAUTH_SECRET_SCHEMA_VERSION,
    resource,
    activeAuthorization: null,
    credentials: [],
    discovery: null,
    flow: { status: "idle" },
  };
}

function credentialAccount(resource: string): string {
  return createHash("sha256").update(resource).digest("hex");
}

function credentialError(message: string): never {
  throw new McpOAuthCredentialError(`Error: MCP authorization ${message}.`);
}

function unavailableCredentialError(message: string): never {
  throw new McpOAuthCredentialUnavailableError(
    `Error: MCP authorization ${message}.`,
  );
}

class OAuthCredentialStore {
  private readonly account: string;
  private readonly backend: McpSecretBackend;
  private readonly resource: string;

  constructor(server: McpServerEndpoint, backend: McpSecretBackend) {
    this.resource = new URL(server.url).href;
    this.account = credentialAccount(this.resource);
    this.backend = backend;
  }

  async load(): Promise<OAuthCredentialRecord> {
    let serialized: string | null;
    try {
      serialized = await this.backend.getPassword(
        MCP_OAUTH_SECRET_SERVICE,
        this.account,
      );
    } catch {
      unavailableCredentialError(
        "requires an available OS credential store; secure credential access failed",
      );
    }
    if (serialized === null) return emptyRecord(this.resource);
    if (Buffer.byteLength(serialized, "utf8") > MCP_OAUTH_MAX_SECRET_BYTES) {
      credentialError("credential record exceeds the safe size limit");
    }
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(serialized);
    } catch {
      credentialError("credential record is invalid JSON");
    }
    const parsed = oauthCredentialRecordSchema.safeParse(parsedJson);
    if (!parsed.success) {
      credentialError("credential record does not match the current schema");
    }
    if (parsed.data.resource !== this.resource) {
      credentialError("credential record is bound to a different resource");
    }
    return parsed.data;
  }

  async save(record: OAuthCredentialRecord): Promise<void> {
    const parsed = oauthCredentialRecordSchema.safeParse(record);
    /* v8 ignore next 3 -- private callers construct the precise record type; external stored records are validated by load(). */
    if (!parsed.success || parsed.data.resource !== this.resource) {
      credentialError("refused to store an invalid credential record");
    }
    try {
      await this.backend.setPassword(
        MCP_OAUTH_SECRET_SERVICE,
        this.account,
        JSON.stringify(parsed.data),
      );
    } catch {
      unavailableCredentialError(
        "requires an available OS credential store; secure credential storage failed",
      );
    }
  }

  async delete(): Promise<boolean> {
    try {
      return await this.backend.deletePassword(
        MCP_OAUTH_SECRET_SERVICE,
        this.account,
      );
    } catch {
      unavailableCredentialError(
        "requires an available OS credential store; secure credential removal failed",
      );
    }
  }
}

function replaceIssuerValue<T extends { readonly issuer: string }>(
  entries: readonly T[],
  next: T,
): T[] {
  const retained = entries.filter((entry) => entry.issuer !== next.issuer);
  if (retained.length >= MCP_OAUTH_MAX_ISSUERS) {
    credentialError(
      `supports at most ${MCP_OAUTH_MAX_ISSUERS} authorization issuers per resource`,
    );
  }
  return [...retained, next];
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
  readonly redirectUrl: string;
  readonly clientMetadata: OAuthClientMetadata;
  private readonly store: OAuthCredentialStore;
  private readonly openAuthorizationUrl: (url: URL) => Promise<void>;
  private readonly preRegisteredClient: McpPreRegisteredClient | null;
  private readonly resource: string;
  private readonly now: () => number;

  constructor(options: {
    readonly server: McpServerEndpoint;
    readonly backend: McpSecretBackend;
    readonly redirectUrl: string;
    readonly openAuthorizationUrl: (url: URL) => Promise<void>;
    readonly preRegisteredClient: McpPreRegisteredClient | null;
    readonly now: () => number;
  }) {
    this.redirectUrl = options.redirectUrl;
    this.store = new OAuthCredentialStore(options.server, options.backend);
    this.openAuthorizationUrl = options.openAuthorizationUrl;
    this.preRegisteredClient = options.preRegisteredClient;
    this.resource = new URL(options.server.url).href;
    this.now = options.now;
    // CIMD requires a stable, publicly hosted HTTPS metadata document. Keel is
    // pre-release and has no such release artifact yet, so clientMetadataUrl is
    // intentionally omitted and selection continues with pre-registration/DCR.
    this.clientMetadata = {
      redirect_uris: [options.redirectUrl],
      client_name: "Keel",
      client_uri: "https://github.com/acmerfight/keel",
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method:
        options.preRegisteredClient?.clientSecret === null ||
        options.preRegisteredClient === null
          ? "none"
          : "client_secret_basic",
    };
  }

  async beginFlow(state: string, startedAt: number): Promise<void> {
    const record = await this.store.load();
    await this.store.save({
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
    const record = await this.store.load();
    const stored = record.credentials.find((entry) => entry.issuer === issuer);
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
    if (stored !== undefined) {
      if (record.flow.status === "awaiting-callback") {
        await this.store.save({
          ...record,
          flow: {
            ...record.flow,
            expectedIssuer: issuer,
            clientId: stored.client.client_id,
          },
        });
      }
      return stored.client;
    }
    if (
      record.discovery?.authorizationServerMetadata?.registration_endpoint ===
      undefined
    ) {
      credentialError(
        "server has no reusable client and does not advertise dynamic registration; configure a pre-registered client",
      );
    }
    return undefined;
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
    const record = await this.store.load();
    const existing = record.credentials.find(
      (credentials) => credentials.issuer === issuer,
    );
    const identityMatches =
      existing !== undefined && sameClientIdentity(existing.client, value);
    await this.store.save({
      ...record,
      activeAuthorization:
        record.activeAuthorization?.issuer === issuer && !identityMatches
          ? null
          : record.activeAuthorization,
      credentials: replaceIssuerValue(record.credentials, {
        issuer,
        client: value,
        tokens: identityMatches ? existing.tokens : null,
      }),
      flow:
        record.flow.status === "awaiting-callback"
          ? {
              ...record.flow,
              expectedIssuer: issuer,
              clientId: value.client_id,
            }
          : record.flow,
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
    // The SDK automatically refreshes when this method exposes refresh_token.
    // Slice 4 owns the required single-flight and rotation guarantees, so
    // Slice 3 persists refresh credentials but deliberately reauthorizes here.
    return withoutRefreshToken(stored);
  }

  async saveTokens(
    tokens: StoredOAuthTokens,
    context?: OAuthClientInformationContext,
  ): Promise<void> {
    const issuer = contextIssuer(context);
    requireIssuerMatch(tokens.issuer, issuer);
    const value = storedOAuthTokensSchema.parse({ ...tokens, issuer });
    const record = await this.store.load();
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
    await this.store.save({
      ...record,
      activeAuthorization: {
        issuer,
        clientId: credentials.client.client_id,
      },
      credentials: replaceIssuerValue(record.credentials, {
        ...credentials,
        tokens: value,
      }),
    });
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    await this.openAuthorizationUrl(authorizationUrl);
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    const record = await this.store.load();
    if (record.flow.status !== "awaiting-callback") {
      credentialError("has no pending login for the PKCE verifier");
    }
    await this.store.save({
      ...record,
      flow: { ...record.flow, codeVerifier },
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
    const record = await this.store.load();
    const expectedIssuer =
      discovery.authorizationServerMetadata?.issuer ??
      discovery.authorizationServerUrl;
    if (
      record.flow.status === "callback-consumed" &&
      new URL(record.flow.expectedIssuer).href !== new URL(expectedIssuer).href
    ) {
      credentialError("refused discovery from a different callback issuer");
    }
    await this.store.save({
      ...record,
      discovery,
      flow:
        record.flow.status === "awaiting-callback"
          ? { ...record.flow, expectedIssuer }
          : record.flow,
    });
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    return (await this.store.load()).discovery ?? undefined;
  }

  async validateCallbackState(callbackParams: URLSearchParams): Promise<void> {
    const record = await this.store.load();
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
    await this.store.save({
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
    });
  }

  async finishFlow(): Promise<void> {
    const record = await this.store.load();
    await this.store.save({ ...record, flow: { status: "idle" } });
  }

  async abortFlow(): Promise<void> {
    const record = await this.store.load();
    if (record.flow.status === "idle") return;
    await this.store.save({ ...record, flow: { status: "idle" } });
  }
}

export function createMcpOAuthLoginProvider(options: {
  readonly server: McpServerEndpoint;
  readonly backend: McpSecretBackend;
  readonly redirectUrl: string;
  readonly openAuthorizationUrl: (url: URL) => Promise<void>;
  readonly preRegisteredClient: McpPreRegisteredClient | null;
  readonly now: () => number;
}): McpOAuthLoginProvider {
  return new KeelMcpOAuthProvider(options);
}

export function createMcpBearerAuthProvider(
  server: McpServerEndpoint,
  backend: McpSecretBackend,
): AuthProvider {
  const store = new OAuthCredentialStore(server, backend);
  return {
    token: async () => {
      let record: OAuthCredentialRecord;
      try {
        record = await store.load();
      } catch (error) {
        if (error instanceof McpOAuthCredentialUnavailableError) {
          if (server.authenticationRequired) throw error;
          return undefined;
        }
        throw error;
      }
      const active = record.activeAuthorization;
      const accessToken =
        active === null
          ? undefined
          : record.credentials.find(
              (entry) =>
                entry.issuer === active.issuer &&
                entry.client.client_id === active.clientId,
            )?.tokens?.access_token;
      if (accessToken === undefined && server.authenticationRequired) {
        throw new McpOAuthAuthenticationRequiredError(
          "Error: MCP authorization requires an active OAuth credential.",
        );
      }
      return accessToken;
    },
  };
}

export async function deleteMcpOAuthCredentials(
  server: McpServerEndpoint,
  backend: McpSecretBackend,
): Promise<boolean> {
  return await new OAuthCredentialStore(server, backend).delete();
}
