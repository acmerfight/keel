import { createHash } from "node:crypto";
import type {
  OAuthDiscoveryState,
  StoredOAuthClientInformation,
  StoredOAuthTokens,
} from "@modelcontextprotocol/client";
import { z } from "zod";
import type { McpServerEndpoint } from "../discovery.ts";
import { withMcpOAuthRefreshLock } from "../oauth-refresh-lock.ts";

const MCP_OAUTH_SECRET_SERVICE = "Keel MCP OAuth";
const MCP_OAUTH_SECRET_SCHEMA_VERSION = 4;
const MCP_OAUTH_MAX_ISSUERS = 16;
const MCP_OAUTH_MAX_SECRET_BYTES = 1024 * 1024;

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
export const storedOAuthTokensSchema = z.custom<StoredOAuthTokens>(
  (value) => oauthTokensSchema.safeParse(value).success,
);
export const storedOAuthClientInformationSchema =
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
    revocation_endpoint: z.string().url().optional(),
    revocation_endpoint_auth_methods_supported: z.array(z.string()).optional(),
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
export type StoredOAuthDiscoveryState = OAuthDiscoveryState &
  z.infer<typeof oauthDiscoveryStateSchema>;
export const storedOAuthDiscoveryStateSchema =
  z.custom<StoredOAuthDiscoveryState>(
    (value) => oauthDiscoveryStateSchema.safeParse(value).success,
  );
const oauthRevocationMetadataSchema = z
  .object({
    endpoint: z.string().url(),
    authMethods: z.array(z.string()).optional(),
  })
  .strict();
const issuerCredentialsSchema = z
  .object({
    issuer: z.string().url(),
    client: storedOAuthClientInformationSchema,
    tokens: storedOAuthTokensSchema.nullable(),
    revocation: oauthRevocationMetadataSchema.nullable(),
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
    grantId: z.uuid(),
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
    incarnation: z.uuid(),
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

export type OAuthCredentialRecord = z.infer<typeof oauthCredentialRecordSchema>;
export type IssuerCredentials = z.infer<typeof issuerCredentialsSchema>;
export type OAuthIssuerGrant = IssuerCredentials & {
  readonly tokens: NonNullable<IssuerCredentials["tokens"]>;
};
export type RevocableOAuthIssuerGrant = OAuthIssuerGrant & {
  readonly revocation: NonNullable<IssuerCredentials["revocation"]>;
};
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

export class McpOAuthCredentialError extends Error {}
export class McpOAuthServerUnavailableError extends McpOAuthCredentialError {}
export class McpOAuthCredentialUnavailableError extends McpOAuthCredentialError {}

function emptyRecord(
  resource: string,
  incarnation: string,
): OAuthCredentialRecord {
  return {
    schemaVersion: MCP_OAUTH_SECRET_SCHEMA_VERSION,
    incarnation,
    resource,
    activeAuthorization: null,
    credentials: [],
    discovery: null,
    flow: { status: "idle" },
  };
}

export interface McpOAuthServerEndpoint extends McpServerEndpoint {
  readonly incarnation: string;
}

export function credentialAccount(server: McpOAuthServerEndpoint): string {
  return createHash("sha256")
    .update(server.incarnation)
    .update("\0")
    .update(new URL(server.url).href)
    .digest("hex");
}

export function credentialError(message: string): never {
  throw new McpOAuthCredentialError(`Error: MCP authorization ${message}.`);
}

function unavailableCredentialError(message: string): never {
  throw new McpOAuthCredentialUnavailableError(
    `Error: MCP authorization ${message}.`,
  );
}

export class OAuthCredentialStore {
  private readonly account: string;
  private readonly backend: McpSecretBackend;
  private readonly incarnation: string;
  private readonly mutationGuard: (() => Promise<void>) | null;
  private readonly refreshLockRoot: string;
  private readonly validateRefreshLockRoot: (() => void) | undefined;
  private readonly resource: string;

  constructor(options: {
    readonly server: McpOAuthServerEndpoint;
    readonly backend: McpSecretBackend;
    readonly refreshLockRoot: string;
    readonly validateRefreshLockRoot?: (() => void) | undefined;
    readonly mutationGuard: (() => Promise<void>) | null;
  }) {
    const { server } = options;
    this.resource = new URL(server.url).href;
    this.incarnation = server.incarnation;
    this.account = credentialAccount(server);
    this.backend = options.backend;
    this.refreshLockRoot = options.refreshLockRoot;
    this.validateRefreshLockRoot = options.validateRefreshLockRoot;
    this.mutationGuard = options.mutationGuard;
  }

  credentialId(): string {
    return this.account;
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
    if (serialized === null) {
      return emptyRecord(this.resource, this.incarnation);
    }
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
    if (
      parsed.data.resource !== this.resource ||
      parsed.data.incarnation !== this.incarnation
    ) {
      credentialError("credential record is bound to a different resource");
    }
    return parsed.data;
  }

  async update<Result>(
    action: (record: OAuthCredentialRecord) =>
      | {
          readonly next: OAuthCredentialRecord | null;
          readonly result: Result;
        }
      | Promise<{
          readonly next: OAuthCredentialRecord | null;
          readonly result: Result;
        }>,
  ): Promise<Result> {
    return await withMcpOAuthRefreshLock({
      root: this.refreshLockRoot,
      validateRoot: this.validateRefreshLockRoot,
      credentialId: this.credentialId(),
      action: async () => {
        await this.mutationGuard?.();
        const mutation = await action(await this.load());
        if (mutation.next !== null) {
          await this.saveUnderLock(mutation.next);
        }
        return mutation.result;
      },
    });
  }

  async saveUnderLock(record: OAuthCredentialRecord): Promise<void> {
    const parsed = oauthCredentialRecordSchema.safeParse(record);
    /* v8 ignore next 3 -- private callers construct the precise record type; external stored records are validated by load(). */
    if (
      !parsed.success ||
      parsed.data.resource !== this.resource ||
      parsed.data.incarnation !== this.incarnation
    ) {
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
    return await withMcpOAuthRefreshLock({
      root: this.refreshLockRoot,
      validateRoot: this.validateRefreshLockRoot,
      credentialId: this.credentialId(),
      action: async () => await this.deleteUnderLock(),
    });
  }

  async deleteUnderLock(): Promise<boolean> {
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

export function replaceIssuerValue<T extends { readonly issuer: string }>(
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

export function issuerRevocationMetadata(
  discovery: StoredOAuthDiscoveryState | null,
  issuer: string,
): z.infer<typeof oauthRevocationMetadataSchema> | null {
  const metadata = discovery?.authorizationServerMetadata;
  if (
    metadata === undefined ||
    metadata.revocation_endpoint === undefined ||
    new URL(metadata.issuer).href !== new URL(issuer).href
  ) {
    return null;
  }
  return {
    endpoint: metadata.revocation_endpoint,
    ...(metadata.revocation_endpoint_auth_methods_supported === undefined
      ? {}
      : {
          authMethods: [...metadata.revocation_endpoint_auth_methods_supported],
        }),
  };
}
