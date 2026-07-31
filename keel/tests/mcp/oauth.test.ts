import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { MCP_CIMD_CALLBACKS } from "../../src/mcp/cimd.ts";
import {
  createMcpOAuthLoginProvider,
  createMcpBearerAuthProvider as createProductionMcpBearerAuthProvider,
  deleteMcpOAuthCredentials,
  McpOAuthAuthenticationRequiredError,
  McpOAuthServerUnavailableError,
  type McpSecretBackend,
  sameMcpAuthorizationIdentity,
} from "../../src/mcp/oauth.ts";

const TEST_SERVER_INCARNATION = "00000000-0000-4000-8000-000000000001";

function createMcpBearerAuthProvider(
  options: Omit<
    Parameters<typeof createProductionMcpBearerAuthProvider>[0],
    "isCurrentAndEnabled" | "server"
  > & {
    readonly server: Omit<
      Parameters<typeof createProductionMcpBearerAuthProvider>[0]["server"],
      "incarnation"
    >;
  },
) {
  return createProductionMcpBearerAuthProvider({
    ...options,
    server: { ...options.server, incarnation: TEST_SERVER_INCARNATION },
    isCurrentAndEnabled: async () => true,
  });
}

const TEST_REFRESH_LOCK_ROOT = join(
  tmpdir(),
  "keel-mcp-oauth-test-refresh-locks",
);

function testSecretBackend(): {
  readonly backend: McpSecretBackend;
  readonly values: () => readonly string[];
  readonly overrideValue: (value: string) => void;
} {
  const entries = new Map<string, string>();
  let override: string | undefined;
  const key = (service: string, account: string) => `${service}\0${account}`;
  return {
    backend: {
      getPassword: async (service, account) =>
        override ?? entries.get(key(service, account)) ?? null,
      setPassword: async (service, account, password) => {
        entries.set(key(service, account), password);
      },
      deletePassword: async (service, account) =>
        entries.delete(key(service, account)),
    },
    values: () => [...entries.values()],
    overrideValue: (value) => {
      override = value;
    },
  };
}

function oauthProvider(options: {
  readonly backend: McpSecretBackend;
  readonly now: () => number;
  readonly client?: {
    readonly clientId: string;
    readonly clientSecret: string | null;
  } | null;
}) {
  return createMcpOAuthLoginProvider({
    server: {
      incarnation: TEST_SERVER_INCARNATION,
      url: "https://resource.example/mcp",
      allowPrivateNetwork: false,
      authenticationRequired: false,
    },
    backend: options.backend,
    refreshLockRoot: TEST_REFRESH_LOCK_ROOT,
    isCurrentAndEnabled: async () => true,
    redirectUrl: MCP_CIMD_CALLBACKS[0].redirectUri,
    openAuthorizationUrl: async () => {},
    preRegisteredClient:
      options.client === undefined
        ? {
            clientId: "pre-registered-client",
            clientSecret: null,
          }
        : options.client,
    now: options.now,
  });
}

async function bindPendingFlow(
  provider: ReturnType<typeof oauthProvider>,
  state: string,
  startedAt: number,
): Promise<void> {
  await provider.beginFlow(state, startedAt);
  await provider.saveDiscoveryState({
    authorizationServerUrl: "https://auth.example",
    authorizationServerMetadata: {
      issuer: "https://auth.example",
      authorization_endpoint: "https://auth.example/authorize",
      token_endpoint: "https://auth.example/token",
      response_types_supported: ["code"],
      code_challenge_methods_supported: ["S256"],
      authorization_response_iss_parameter_supported: true,
    },
    resourceMetadata: {
      resource: "https://resource.example/mcp",
      authorization_servers: ["https://auth.example"],
    },
  });
  await provider.clientInformation({ issuer: "https://auth.example" });
  await provider.saveCodeVerifier("v".repeat(43));
}

async function seedActiveCredential(options: {
  readonly backend: McpSecretBackend;
  readonly refreshToken?: string;
  readonly includeDiscovery?: boolean;
}) {
  const provider = oauthProvider({
    backend: options.backend,
    now: () => 0,
  });
  if (options.includeDiscovery !== false) {
    await provider.saveDiscoveryState({
      authorizationServerUrl: "https://auth.example",
      authorizationServerMetadata: {
        issuer: "https://auth.example",
        authorization_endpoint: "https://auth.example/authorize",
        token_endpoint: "https://auth.example/token",
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        token_endpoint_auth_methods_supported: ["none"],
      },
      resourceMetadata: {
        resource: "https://resource.example/mcp",
        authorization_servers: ["https://auth.example"],
      },
    });
  }
  await provider.saveClientInformation(
    {
      client_id: "pre-registered-client",
      issuer: "https://auth.example",
    },
    { issuer: "https://auth.example" },
  );
  await provider.saveTokens(
    {
      access_token: "expired-access-token",
      token_type: "Bearer",
      scope: "mcp:tools",
      ...(options.refreshToken === undefined
        ? {}
        : { refresh_token: options.refreshToken }),
      issuer: "https://auth.example",
    },
    { issuer: "https://auth.example" },
  );
  return provider;
}

async function captureUnauthorizedResponse(
  bearer: ReturnType<typeof createMcpBearerAuthProvider>,
  token: string,
): Promise<Response> {
  return await bearer.wrapFetch(async () => {
    return new Response(null, { status: 401 });
  })("https://resource.example/mcp", {
    headers: { authorization: `Bearer ${token}` },
  });
}

describe("MCP OAuth flow state", () => {
  test(`Given anonymous and OAuth grant identities,
    When authorization bindings are compared,
    Then identities with different kinds never match`, () => {
    // Given
    const anonymous = { kind: "anonymous" } as const;
    const oauth = {
      kind: "oauth",
      issuer: "https://auth.example",
      clientId: "client",
      grantId: "00000000-0000-4000-8000-000000000001",
    } as const;

    // When / Then
    expect(sameMcpAuthorizationIdentity(anonymous, oauth)).toBe(false);
    expect(sameMcpAuthorizationIdentity(oauth, anonymous)).toBe(false);
  });

  test(`Given bearer identity is requested with unavailable or malformed secure state,
    When authentication is optional or required,
    Then optional unavailability is anonymous while required and malformed state fail closed`, async () => {
    // Given
    const unavailableBackend: McpSecretBackend = {
      getPassword: async () => {
        throw new Error("keyring unavailable");
      },
      setPassword: async () => {},
      deletePassword: async () => false,
    };
    const optional = createMcpBearerAuthProvider({
      server: {
        url: "https://resource.example/mcp",
        allowPrivateNetwork: false,
        authenticationRequired: false,
      },
      backend: unavailableBackend,
      refreshLockRoot: TEST_REFRESH_LOCK_ROOT,
    });
    const required = createMcpBearerAuthProvider({
      server: {
        url: "https://resource.example/mcp",
        allowPrivateNetwork: false,
        authenticationRequired: true,
      },
      backend: unavailableBackend,
      refreshLockRoot: TEST_REFRESH_LOCK_ROOT,
    });
    const malformedSecrets = testSecretBackend();
    malformedSecrets.overrideValue("{");
    const malformed = createMcpBearerAuthProvider({
      server: {
        url: "https://resource.example/mcp",
        allowPrivateNetwork: false,
        authenticationRequired: false,
      },
      backend: malformedSecrets.backend,
      refreshLockRoot: TEST_REFRESH_LOCK_ROOT,
    });

    // When / Then
    await expect(optional.authorizationIdentity()).resolves.toEqual({
      kind: "anonymous",
    });
    await expect(required.authorizationIdentity()).rejects.toThrow(
      "secure credential access failed",
    );
    await expect(malformed.authorizationIdentity()).rejects.toThrow(
      "credential record is invalid JSON",
    );
  });

  test(`Given a runtime server is disabled before credential access,
    When bearer authentication is requested,
    Then lifecycle rejects before reading or refreshing secure state`, async () => {
    // Given
    let reads = 0;
    let refreshRequests = 0;
    const bearer = createProductionMcpBearerAuthProvider({
      server: {
        incarnation: TEST_SERVER_INCARNATION,
        url: "https://resource.example/mcp",
        allowPrivateNetwork: false,
        authenticationRequired: true,
      },
      backend: {
        getPassword: async () => {
          reads++;
          return null;
        },
        setPassword: async () => {},
        deletePassword: async () => false,
      },
      refreshLockRoot: TEST_REFRESH_LOCK_ROOT,
      isCurrentAndEnabled: async () => false,
    });

    // When / Then
    await expect(bearer.token()).rejects.toBeInstanceOf(
      McpOAuthServerUnavailableError,
    );
    const response = await captureUnauthorizedResponse(bearer, "stale-token");
    await expect(
      bearer.onUnauthorized({
        response,
        serverUrl: new URL("https://resource.example/mcp"),
        fetchFn: async () => {
          refreshRequests++;
          return new Response(null, { status: 500 });
        },
      }),
    ).rejects.toBeInstanceOf(McpOAuthServerUnavailableError);
    expect(reads).toBe(0);
    expect(refreshRequests).toBe(0);
  });

  test.each([
    ["oversized", "x".repeat(1024 * 1024 + 1), "safe size limit"],
    ["invalid JSON", "{", "invalid JSON"],
    ["wrong schema", "{}", "current schema"],
    [
      "issuer-inconsistent",
      JSON.stringify({
        schemaVersion: 1,
        resource: "https://resource.example/mcp",
        activeAuthorization: null,
        credentials: [
          {
            issuer: "https://auth.example",
            client: {
              client_id: "client",
              issuer: "https://other-auth.example",
            },
            tokens: null,
          },
        ],
        discovery: null,
        flow: { status: "idle" },
      }),
      "current schema",
    ],
    [
      "active-client-inconsistent",
      JSON.stringify({
        schemaVersion: 1,
        resource: "https://resource.example/mcp",
        activeAuthorization: {
          issuer: "https://auth.example",
          clientId: "missing-client",
        },
        credentials: [],
        discovery: null,
        flow: { status: "idle" },
      }),
      "current schema",
    ],
  ])(
    `Given secure storage contains an %s OAuth credential record,
    When Keel loads it for an MCP request,
    Then external credential data is rejected before use`,
    async (_case, serialized, expectedError) => {
      // Given
      const secrets = testSecretBackend();
      secrets.overrideValue(serialized);
      const provider = oauthProvider({
        backend: secrets.backend,
        now: () => 0,
      });

      // When / Then
      await expect(provider.tokens()).rejects.toThrow(expectedError);
      await expect(
        createMcpBearerAuthProvider({
          server: {
            url: "https://resource.example/mcp",
            allowPrivateNetwork: false,
            authenticationRequired: false,
          },
          backend: secrets.backend,
          refreshLockRoot: TEST_REFRESH_LOCK_ROOT,
        }).token(),
      ).rejects.toThrow(expectedError);
    },
  );

  test(`Given a valid credential record is copied under a different resource,
    When Keel loads it for the configured MCP resource,
    Then the exact resource binding rejects the copied record`, async () => {
    // Given
    const secrets = testSecretBackend();
    const provider = oauthProvider({
      backend: secrets.backend,
      now: () => 0,
    });
    await provider.beginFlow("s".repeat(43), 0);
    const copied = secrets
      .values()
      .join("")
      .replace(
        "https://resource.example/mcp",
        "https://other-resource.example/mcp",
      );
    secrets.overrideValue(copied);

    // When / Then
    await expect(provider.state()).rejects.toThrow("different resource");
  });

  test(`Given the secure credential backend refuses writes or deletion,
    When OAuth state is created or removed,
    Then Keel fails closed with operation-specific diagnostics`, async () => {
    // Given
    const unavailable: McpSecretBackend = {
      getPassword: async () => null,
      setPassword: async () => {
        throw new Error("storage unavailable");
      },
      deletePassword: async () => {
        throw new Error("storage unavailable");
      },
    };
    const provider = oauthProvider({ backend: unavailable, now: () => 0 });

    // When / Then
    await expect(provider.beginFlow("s".repeat(43), 0)).rejects.toThrow(
      "secure credential storage failed",
    );
    await expect(
      deleteMcpOAuthCredentials(
        {
          incarnation: TEST_SERVER_INCARNATION,
          url: "https://resource.example/mcp",
          allowPrivateNetwork: false,
          authenticationRequired: false,
        },
        unavailable,
        TEST_REFRESH_LOCK_ROOT,
      ),
    ).rejects.toThrow("secure credential removal failed");
  });

  test(`Given concurrent lifecycle commands remove one MCP credential,
    When both deletion attempts target the same resource,
    Then the OAuth refresh lock serializes secure backend mutation`, async () => {
    // Given
    const refreshLockRoot = join(
      tmpdir(),
      `keel-mcp-delete-lock-${randomUUID()}`,
    );
    let activeDeletions = 0;
    let maximumActiveDeletions = 0;
    const backend: McpSecretBackend = {
      getPassword: async () => null,
      setPassword: async () => {},
      deletePassword: async () => {
        activeDeletions += 1;
        maximumActiveDeletions = Math.max(
          maximumActiveDeletions,
          activeDeletions,
        );
        await new Promise((resolve) => setTimeout(resolve, 25));
        activeDeletions -= 1;
        return true;
      },
    };
    const server = {
      incarnation: TEST_SERVER_INCARNATION,
      url: "https://resource.example/mcp",
      allowPrivateNetwork: false,
      authenticationRequired: true,
    };

    try {
      // When
      await Promise.all([
        deleteMcpOAuthCredentials(server, backend, refreshLockRoot),
        deleteMcpOAuthCredentials(server, backend, refreshLockRoot),
      ]);

      // Then
      expect(maximumActiveDeletions).toBe(1);
    } finally {
      await rm(refreshLockRoot, { recursive: true, force: true });
    }
  });

  test(`Given a removed server and its replacement use the same resource URL,
    When stale cleanup targets the removed incarnation,
    Then the replacement incarnation keeps its independent credential`, async () => {
    // Given
    const secrets = testSecretBackend();
    const refreshLockRoot = join(
      tmpdir(),
      `keel-mcp-incarnation-credentials-${randomUUID()}`,
    );
    const replacement = {
      incarnation: "00000000-0000-4000-8000-000000000022",
      url: "https://resource.example/mcp",
      allowPrivateNetwork: false,
      authenticationRequired: true,
    };
    const replacementLogin = createMcpOAuthLoginProvider({
      server: replacement,
      backend: secrets.backend,
      refreshLockRoot,
      isCurrentAndEnabled: async () => true,
      redirectUrl: MCP_CIMD_CALLBACKS[0].redirectUri,
      openAuthorizationUrl: async () => {},
      preRegisteredClient: {
        clientId: "replacement-client",
        clientSecret: null,
      },
      now: () => 0,
    });
    await replacementLogin.saveClientInformation(
      {
        client_id: "replacement-client",
        issuer: "https://auth.example",
      },
      { issuer: "https://auth.example" },
    );
    await replacementLogin.saveTokens(
      {
        access_token: "replacement-access-token",
        token_type: "Bearer",
        issuer: "https://auth.example",
      },
      { issuer: "https://auth.example" },
    );

    try {
      // When
      await deleteMcpOAuthCredentials(
        {
          ...replacement,
          incarnation: "00000000-0000-4000-8000-000000000011",
        },
        secrets.backend,
        refreshLockRoot,
      );

      // Then
      const bearer = createProductionMcpBearerAuthProvider({
        server: replacement,
        backend: secrets.backend,
        refreshLockRoot,
        isCurrentAndEnabled: async () => true,
      });
      await expect(bearer.token()).resolves.toBe("replacement-access-token");
    } finally {
      await rm(refreshLockRoot, { recursive: true, force: true });
    }
  });

  test(`Given the SDK omits or changes an authorization issuer context,
    When Keel receives client or token credentials,
    Then the typed issuer-bound store refuses them`, async () => {
    // Given
    const provider = oauthProvider({
      backend: testSecretBackend().backend,
      now: () => 0,
    });

    // When / Then
    await expect(provider.clientInformation()).rejects.toThrow(
      "omitted the authorization issuer binding",
    );
    await expect(
      provider.saveClientInformation(
        {
          client_id: "wrong-issuer-client",
          issuer: "https://attacker.example",
        },
        { issuer: "https://auth.example" },
      ),
    ).rejects.toThrow("mismatched issuer binding");
    await expect(
      provider.saveTokens(
        {
          access_token: "wrong-issuer-token",
          token_type: "Bearer",
          issuer: "https://attacker.example",
        },
        { issuer: "https://auth.example" },
      ),
    ).rejects.toThrow("mismatched issuer binding");
    await expect(
      oauthProvider({
        backend: testSecretBackend().backend,
        now: () => 0,
      }).saveTokens(
        {
          access_token: "unbound-token",
          token_type: "Bearer",
          issuer: "https://auth.example",
        },
        { issuer: "https://auth.example" },
      ),
    ).rejects.toThrow("without an issuer-bound OAuth client");
  });

  test(`Given one resource has the maximum number of issuer-bound clients,
    When another authorization issuer is added,
    Then Keel rejects the bounded credential record before storage`, async () => {
    // Given
    const provider = oauthProvider({
      backend: testSecretBackend().backend,
      now: () => 0,
    });
    for (let index = 0; index < 16; index += 1) {
      const issuer = `https://auth-${index}.example`;
      await provider.saveClientInformation(
        { client_id: `client-${index}`, issuer },
        { issuer },
      );
    }

    // When / Then
    await expect(
      provider.saveClientInformation(
        {
          client_id: "client-over-limit",
          issuer: "https://auth-over-limit.example",
        },
        { issuer: "https://auth-over-limit.example" },
      ),
    ).rejects.toThrow("at most 16 authorization issuers");
  });

  test(`Given no login or token is active,
    When OAuth provider state and bearer credentials are requested,
    Then typed idle state returns no token and rejects pending-flow operations`, async () => {
    // Given
    const secrets = testSecretBackend();
    const provider = oauthProvider({
      backend: secrets.backend,
      now: () => 0,
    });
    const bearer = createMcpBearerAuthProvider({
      server: {
        url: "https://resource.example/mcp",
        allowPrivateNetwork: false,
        authenticationRequired: false,
      },
      backend: secrets.backend,
      refreshLockRoot: TEST_REFRESH_LOCK_ROOT,
    });

    // When / Then
    await expect(provider.tokens()).resolves.toBeUndefined();
    await expect(
      provider.tokens({ issuer: "https://unknown-auth.example" }),
    ).resolves.toBeUndefined();
    await expect(bearer.token()).resolves.toBeUndefined();
    await expect(provider.state()).rejects.toThrow("no pending login");
    await expect(provider.saveCodeVerifier("v".repeat(43))).rejects.toThrow(
      "no pending login",
    );
    await expect(provider.codeVerifier()).rejects.toThrow("no PKCE verifier");
    await expect(provider.abortFlow()).resolves.toBeUndefined();
    await provider.beginFlow("s".repeat(43), 0);
    await expect(provider.codeVerifier()).rejects.toThrow("no PKCE verifier");
    await provider.abortFlow();
    await provider.saveDiscoveryState({
      authorizationServerUrl: "https://auth.example",
    });
    await expect(provider.discoveryState()).resolves.toMatchObject({
      authorizationServerUrl: "https://auth.example",
    });
  });

  test(`Given issuer-bound access and refresh tokens are securely persisted,
    When the explicit-login provider loads credentials for a new browser flow,
    Then it preserves the refresh token at rest while withholding it from the login orchestrator`, async () => {
    // Given
    const secrets = testSecretBackend();
    const provider = oauthProvider({
      backend: secrets.backend,
      now: () => 0,
    });
    await provider.saveClientInformation(
      {
        client_id: "pre-registered-client",
        issuer: "https://auth.example",
      },
      { issuer: "https://auth.example" },
    );
    await provider.saveTokens(
      {
        access_token: "expired-access-token",
        refresh_token: "stored-refresh-token",
        token_type: "Bearer",
        issuer: "https://auth.example",
      },
      { issuer: "https://auth.example" },
    );

    // When
    const loaded = await provider.tokens({ issuer: "https://auth.example" });

    // Then
    expect(loaded).toEqual({
      access_token: "expired-access-token",
      token_type: "Bearer",
      issuer: "https://auth.example",
    });
    expect(secrets.values().join("\n")).toContain("stored-refresh-token");
  });

  test(`Given a user authorizes the same issuer and OAuth client again,
    When the replacement token becomes active,
    Then Keel assigns a new authorization grant identity for approval binding`, async () => {
    // Given
    const secrets = testSecretBackend();
    const provider = await seedActiveCredential({
      backend: secrets.backend,
      refreshToken: "stored-refresh-token",
    });
    const bearer = createMcpBearerAuthProvider({
      server: {
        url: "https://resource.example/mcp",
        allowPrivateNetwork: false,
        authenticationRequired: true,
      },
      backend: secrets.backend,
      refreshLockRoot: TEST_REFRESH_LOCK_ROOT,
    });
    const firstIdentity = await bearer.authorizationIdentity();
    const state = "s".repeat(43);
    await bindPendingFlow(provider, state, 1_000);
    await provider.validateCallbackState(
      new URLSearchParams({ code: "replacement-code", state }),
    );

    // When
    await provider.saveTokens(
      {
        access_token: "replacement-access-token",
        refresh_token: "replacement-refresh-token",
        token_type: "Bearer",
        issuer: "https://auth.example",
      },
      { issuer: "https://auth.example" },
    );
    const secondIdentity = await bearer.authorizationIdentity();

    // Then
    expect(firstIdentity).toMatchObject({
      kind: "oauth",
      issuer: "https://auth.example",
      clientId: "pre-registered-client",
    });
    expect(secondIdentity).toMatchObject({
      kind: "oauth",
      issuer: "https://auth.example",
      clientId: "pre-registered-client",
    });
    expect(secondIdentity).not.toEqual(firstIdentity);
  });

  test(`Given an MCP call pins the approved OAuth grant through authenticated dispatch,
    When a concurrent login replaces that grant after an initial 401,
    Then token acquisition and the transport retry fail before using the replacement grant`, async () => {
    // Given
    const secrets = testSecretBackend();
    const login = await seedActiveCredential({
      backend: secrets.backend,
      refreshToken: "first-refresh-token",
    });
    const bearer = createMcpBearerAuthProvider({
      server: {
        url: "https://resource.example/mcp",
        allowPrivateNetwork: false,
        authenticationRequired: true,
      },
      backend: secrets.backend,
      refreshLockRoot: TEST_REFRESH_LOCK_ROOT,
    });
    const approvedIdentity = await bearer.authorizationIdentity();

    // When / Then
    await bearer.withAuthorizationIdentity(approvedIdentity, async () => {
      await expect(bearer.token()).resolves.toBe("expired-access-token");
      const rejected = await captureUnauthorizedResponse(
        bearer,
        "expired-access-token",
      );
      const state = "r".repeat(43);
      await bindPendingFlow(login, state, 0);
      await login.validateCallbackState(
        new URLSearchParams({ code: "replacement-code", state }),
      );
      await login.saveTokens(
        {
          access_token: "expired-access-token",
          refresh_token: "replacement-refresh-token",
          token_type: "Bearer",
          issuer: "https://auth.example",
        },
        { issuer: "https://auth.example" },
      );
      let refreshRequests = 0;
      await expect(
        bearer.onUnauthorized({
          response: rejected,
          serverUrl: new URL("https://resource.example/mcp"),
          fetchFn: async () => {
            refreshRequests++;
            return new Response(null, { status: 500 });
          },
        }),
      ).rejects.toThrow(
        "changed authorization identity before authenticated dispatch",
      );
      expect(refreshRequests).toBe(0);
      await expect(bearer.token()).rejects.toThrow(
        "changed authorization identity before authenticated dispatch",
      );
    });
  });

  test(`Given DCR client A and its token are stored for an issuer,
    When the user explicitly logs in with pre-registered client B,
    Then client B takes precedence and client A's token becomes unreachable`, async () => {
    // Given
    const secrets = testSecretBackend();
    const discovered = oauthProvider({
      backend: secrets.backend,
      now: () => 0,
      client: null,
    });
    await discovered.saveClientInformation(
      { client_id: "dcr-client-a", issuer: "https://auth.example" },
      { issuer: "https://auth.example" },
    );
    await discovered.saveTokens(
      {
        access_token: "client-a-access-token",
        token_type: "Bearer",
        issuer: "https://auth.example",
      },
      { issuer: "https://auth.example" },
    );
    const explicit = oauthProvider({
      backend: secrets.backend,
      now: () => 0,
      client: {
        clientId: "pre-registered-client-b",
        clientSecret: null,
      },
    });

    // When
    const selected = await explicit.clientInformation({
      issuer: "https://auth.example",
    });

    // Then
    expect(selected?.client_id).toBe("pre-registered-client-b");
    await expect(
      explicit.tokens({ issuer: "https://auth.example" }),
    ).resolves.toBeUndefined();
    await expect(
      createMcpBearerAuthProvider({
        server: {
          url: "https://resource.example/mcp",
          allowPrivateNetwork: false,
          authenticationRequired: false,
        },
        backend: secrets.backend,
        refreshLockRoot: TEST_REFRESH_LOCK_ROOT,
      }).token(),
    ).resolves.toBeUndefined();
  });

  test(`Given a server has an active issuer/client-bound authorization,
    When its secure credential backend becomes unavailable,
    Then token lookup fails closed instead of silently downgrading the account to anonymous`, async () => {
    // Given
    const secrets = testSecretBackend();
    let unavailable = false;
    const backend: McpSecretBackend = {
      getPassword: async (service, account) => {
        if (unavailable) throw new Error("credential service unavailable");
        return await secrets.backend.getPassword(service, account);
      },
      setPassword: async (service, account, password) => {
        await secrets.backend.setPassword(service, account, password);
      },
      deletePassword: async (service, account) =>
        await secrets.backend.deletePassword(service, account),
    };
    const provider = oauthProvider({
      backend,
      now: () => 0,
      client: null,
    });
    await provider.saveClientInformation(
      { client_id: "authenticated-client", issuer: "https://auth.example" },
      { issuer: "https://auth.example" },
    );
    await provider.saveTokens(
      {
        access_token: "authenticated-token",
        token_type: "Bearer",
        issuer: "https://auth.example",
      },
      { issuer: "https://auth.example" },
    );
    const bearer = createMcpBearerAuthProvider({
      server: {
        url: "https://resource.example/mcp",
        allowPrivateNetwork: false,
        authenticationRequired: true,
      },
      backend,
      refreshLockRoot: TEST_REFRESH_LOCK_ROOT,
    });
    await expect(bearer.token()).resolves.toBe("authenticated-token");

    // When
    unavailable = true;

    // Then
    await expect(bearer.token()).rejects.toThrow(
      "secure credential access failed",
    );
  });

  test(`Given a server is marked as requiring authentication but secure storage has no active credential,
    When a request resolves its bearer token,
    Then token lookup fails closed instead of silently downgrading the request to anonymous`, async () => {
    // Given
    const bearer = createMcpBearerAuthProvider({
      server: {
        url: "https://resource.example/mcp",
        allowPrivateNetwork: false,
        authenticationRequired: true,
      },
      backend: testSecretBackend().backend,
      refreshLockRoot: TEST_REFRESH_LOCK_ROOT,
    });

    // When / Then
    await expect(bearer.token()).rejects.toBeInstanceOf(
      McpOAuthAuthenticationRequiredError,
    );
  });

  test(`Given another process publishes a new credential after this request receives a 401,
    When the stale request enters the serialized refresh transaction,
    Then Keel adopts the published credential without submitting the rejected refresh token`, async () => {
    // Given
    const secrets = testSecretBackend();
    const stored = await seedActiveCredential({
      backend: secrets.backend,
      refreshToken: "old-refresh-token",
    });
    const bearer = createMcpBearerAuthProvider({
      server: {
        url: "https://resource.example/mcp",
        allowPrivateNetwork: false,
        authenticationRequired: true,
      },
      backend: secrets.backend,
      refreshLockRoot: TEST_REFRESH_LOCK_ROOT,
    });
    const response = await captureUnauthorizedResponse(
      bearer,
      "expired-access-token",
    );
    await stored.saveTokens(
      {
        access_token: "peer-access-token",
        refresh_token: "peer-refresh-token",
        token_type: "Bearer",
        scope: "mcp:tools",
        issuer: "https://auth.example",
      },
      { issuer: "https://auth.example" },
    );
    let refreshRequests = 0;

    // When
    await bearer.onUnauthorized({
      response,
      serverUrl: new URL("https://resource.example/mcp"),
      fetchFn: async () => {
        refreshRequests += 1;
        throw new Error("refresh should not be requested");
      },
    });

    // Then
    await expect(bearer.token()).resolves.toBe("peer-access-token");
    expect(refreshRequests).toBe(0);
  });

  test(`Given a token refresh is in flight when its MCP server is disabled,
    When the authorization server returns rotated credentials,
    Then lifecycle is rechecked and the rotation is not persisted`, async () => {
    // Given
    const secrets = testSecretBackend();
    await seedActiveCredential({
      backend: secrets.backend,
      refreshToken: "old-refresh-token",
    });
    let enabled = true;
    const bearer = createProductionMcpBearerAuthProvider({
      server: {
        incarnation: TEST_SERVER_INCARNATION,
        url: "https://resource.example/mcp",
        allowPrivateNetwork: false,
        authenticationRequired: true,
      },
      backend: secrets.backend,
      refreshLockRoot: join(
        tmpdir(),
        `keel-mcp-refresh-disable-${randomUUID()}`,
      ),
      isCurrentAndEnabled: async () => enabled,
    });
    const response = await captureUnauthorizedResponse(
      bearer,
      "expired-access-token",
    );
    const refreshRequested = Promise.withResolvers<void>();
    const finishRefresh = Promise.withResolvers<void>();
    const refresh = bearer.onUnauthorized({
      response,
      serverUrl: new URL("https://resource.example/mcp"),
      fetchFn: async () => {
        refreshRequested.resolve();
        await finishRefresh.promise;
        return Response.json({
          access_token: "rotated-access-token",
          refresh_token: "rotated-refresh-token",
          token_type: "Bearer",
        });
      },
    });
    await refreshRequested.promise;

    // When
    enabled = false;
    finishRefresh.resolve();

    // Then
    await expect(refresh).rejects.toBeInstanceOf(
      McpOAuthServerUnavailableError,
    );
    expect(secrets.values().join("\n")).toContain("old-refresh-token");
    expect(secrets.values().join("\n")).not.toContain("rotated-refresh-token");
  });

  test(`Given refresh holds the credential transaction while login updates flow state,
    When rotated tokens publish before the login mutation acquires the lock,
    Then the login rereads and preserves both the rotation and its new flow`, async () => {
    // Given
    const secrets = testSecretBackend();
    const login = await seedActiveCredential({
      backend: secrets.backend,
      refreshToken: "old-refresh-token",
    });
    const bearer = createMcpBearerAuthProvider({
      server: {
        url: "https://resource.example/mcp",
        allowPrivateNetwork: false,
        authenticationRequired: true,
      },
      backend: secrets.backend,
      refreshLockRoot: TEST_REFRESH_LOCK_ROOT,
    });
    const response = await captureUnauthorizedResponse(
      bearer,
      "expired-access-token",
    );
    const refreshRequested = Promise.withResolvers<void>();
    const finishRefresh = Promise.withResolvers<void>();
    const refresh = bearer.onUnauthorized({
      response,
      serverUrl: new URL("https://resource.example/mcp"),
      fetchFn: async () => {
        refreshRequested.resolve();
        await finishRefresh.promise;
        return Response.json({
          access_token: "rotated-access-token",
          refresh_token: "rotated-refresh-token",
          token_type: "Bearer",
        });
      },
    });
    await refreshRequested.promise;
    const beginFlow = login.beginFlow("s".repeat(43), 10);

    // When
    finishRefresh.resolve();
    await Promise.all([refresh, beginFlow]);

    // Then
    await expect(bearer.token()).resolves.toBe("rotated-access-token");
    await expect(login.state()).resolves.toBe("s".repeat(43));
    expect(secrets.values().join("\n")).toContain("rotated-refresh-token");
  });

  test(`Given two isolated Keel homes use the same MCP resource URL,
    When both credentials receive a 401 concurrently,
    Then each credential owns an independent in-process refresh transaction`, async () => {
    // Given
    const firstSecrets = testSecretBackend();
    const secondSecrets = testSecretBackend();
    await Promise.all([
      seedActiveCredential({
        backend: firstSecrets.backend,
        refreshToken: "first-refresh-token",
      }),
      seedActiveCredential({
        backend: secondSecrets.backend,
        refreshToken: "second-refresh-token",
      }),
    ]);
    const firstRoot = join(
      tmpdir(),
      `keel-mcp-first-refresh-root-${randomUUID()}`,
    );
    const secondRoot = join(
      tmpdir(),
      `keel-mcp-second-refresh-root-${randomUUID()}`,
    );
    const server = {
      url: "https://resource.example/mcp",
      allowPrivateNetwork: false,
      authenticationRequired: true,
    };
    const firstBearer = createMcpBearerAuthProvider({
      server,
      backend: firstSecrets.backend,
      refreshLockRoot: firstRoot,
    });
    const secondBearer = createMcpBearerAuthProvider({
      server,
      backend: secondSecrets.backend,
      refreshLockRoot: secondRoot,
    });
    const [firstResponse, secondResponse] = await Promise.all([
      captureUnauthorizedResponse(firstBearer, "expired-access-token"),
      captureUnauthorizedResponse(secondBearer, "expired-access-token"),
    ]);
    let firstRefreshes = 0;
    let secondRefreshes = 0;
    const refreshResponse = (accessToken: string, refreshToken: string) =>
      Response.json({
        access_token: accessToken,
        refresh_token: refreshToken,
        token_type: "Bearer",
      });

    try {
      // When
      await Promise.all([
        firstBearer.onUnauthorized({
          response: firstResponse,
          serverUrl: new URL(server.url),
          fetchFn: async () => {
            firstRefreshes += 1;
            return refreshResponse(
              "first-refreshed-access-token",
              "first-rotated-refresh-token",
            );
          },
        }),
        secondBearer.onUnauthorized({
          response: secondResponse,
          serverUrl: new URL(server.url),
          fetchFn: async () => {
            secondRefreshes += 1;
            return refreshResponse(
              "second-refreshed-access-token",
              "second-rotated-refresh-token",
            );
          },
        }),
      ]);

      // Then
      expect(firstRefreshes).toBe(1);
      expect(secondRefreshes).toBe(1);
      await expect(firstBearer.token()).resolves.toBe(
        "first-refreshed-access-token",
      );
      await expect(secondBearer.token()).resolves.toBe(
        "second-refreshed-access-token",
      );
    } finally {
      await Promise.all([
        rm(firstRoot, { recursive: true, force: true }),
        rm(secondRoot, { recursive: true, force: true }),
      ]);
    }
  });

  test(`Given a rejected request has no active credential or no refresh token,
    When Keel handles its typed 401 context,
    Then it requires login and tombstones any unusable access-only credential`, async () => {
    // Given
    const emptySecrets = testSecretBackend();
    const emptyBearer = createMcpBearerAuthProvider({
      server: {
        url: "https://resource.example/mcp",
        allowPrivateNetwork: false,
        authenticationRequired: true,
      },
      backend: emptySecrets.backend,
      refreshLockRoot: TEST_REFRESH_LOCK_ROOT,
    });
    const emptyResponse = await captureUnauthorizedResponse(
      emptyBearer,
      "unbound-access-token",
    );
    const accessOnlySecrets = testSecretBackend();
    await seedActiveCredential({ backend: accessOnlySecrets.backend });
    const accessOnlyBearer = createMcpBearerAuthProvider({
      server: {
        url: "https://resource.example/mcp",
        allowPrivateNetwork: false,
        authenticationRequired: true,
      },
      backend: accessOnlySecrets.backend,
      refreshLockRoot: TEST_REFRESH_LOCK_ROOT,
    });
    const accessOnlyResponse = await captureUnauthorizedResponse(
      accessOnlyBearer,
      "expired-access-token",
    );
    const contextFetch = async () => {
      throw new Error("refresh should not be requested");
    };

    // When / Then
    await expect(
      emptyBearer.onUnauthorized({
        response: emptyResponse,
        serverUrl: new URL("https://resource.example/mcp"),
        fetchFn: contextFetch,
      }),
    ).rejects.toBeInstanceOf(McpOAuthAuthenticationRequiredError);
    await expect(
      accessOnlyBearer.onUnauthorized({
        response: accessOnlyResponse,
        serverUrl: new URL("https://resource.example/mcp"),
        fetchFn: contextFetch,
      }),
    ).rejects.toBeInstanceOf(McpOAuthAuthenticationRequiredError);
    await expect(accessOnlyBearer.token()).rejects.toBeInstanceOf(
      McpOAuthAuthenticationRequiredError,
    );
  });

  test(`Given refresh metadata is missing or the token endpoint returns a typed non-auth failure,
    When a rejected request attempts recovery,
    Then Keel fails without converting either problem into needs-auth`, async () => {
    // Given
    const missingMetadataSecrets = testSecretBackend();
    await seedActiveCredential({
      backend: missingMetadataSecrets.backend,
      refreshToken: "refresh-token",
      includeDiscovery: false,
    });
    const missingMetadataBearer = createMcpBearerAuthProvider({
      server: {
        url: "https://resource.example/mcp",
        allowPrivateNetwork: false,
        authenticationRequired: true,
      },
      backend: missingMetadataSecrets.backend,
      refreshLockRoot: TEST_REFRESH_LOCK_ROOT,
    });
    const missingMetadataResponse = await captureUnauthorizedResponse(
      missingMetadataBearer,
      "expired-access-token",
    );
    const serverFailureSecrets = testSecretBackend();
    await seedActiveCredential({
      backend: serverFailureSecrets.backend,
      refreshToken: "refresh-token",
    });
    const serverFailureBearer = createMcpBearerAuthProvider({
      server: {
        url: "https://resource.example/mcp",
        allowPrivateNetwork: false,
        authenticationRequired: true,
      },
      backend: serverFailureSecrets.backend,
      refreshLockRoot: TEST_REFRESH_LOCK_ROOT,
    });
    const serverFailureResponse = await captureUnauthorizedResponse(
      serverFailureBearer,
      "expired-access-token",
    );

    // When / Then
    await expect(
      missingMetadataBearer.onUnauthorized({
        response: missingMetadataResponse,
        serverUrl: new URL("https://resource.example/mcp"),
        fetchFn: async () => new Response(),
      }),
    ).rejects.toThrow("no matching authorization-server discovery state");
    await expect(
      serverFailureBearer.onUnauthorized({
        response: serverFailureResponse,
        serverUrl: new URL("https://resource.example/mcp"),
        fetchFn: async () =>
          Response.json(
            {
              error: "server_error",
              error_description: "authorization server unavailable",
            },
            { status: 503 },
          ),
      }),
    ).rejects.toThrow();
    await expect(serverFailureBearer.token()).resolves.toBe(
      "expired-access-token",
    );
  });

  test(`Given bearer lookup is optional and credential storage is unavailable,
    When a request resolves authentication and the fetch wrapper sees non-bearer shapes,
    Then typed optional state remains anonymous without inventing a rejected credential`, async () => {
    // Given
    const bearer = createMcpBearerAuthProvider({
      server: {
        url: "https://resource.example/mcp",
        allowPrivateNetwork: false,
        authenticationRequired: false,
      },
      backend: {
        getPassword: async () => {
          throw new Error("optional credential storage unavailable");
        },
        setPassword: async () => {},
        deletePassword: async () => false,
      },
      refreshLockRoot: TEST_REFRESH_LOCK_ROOT,
    });
    const wrapped = bearer.wrapFetch(
      async () => new Response(null, { status: 200 }),
    );

    // When / Then
    await expect(bearer.token()).resolves.toBeUndefined();
    await expect(
      wrapped("https://resource.example/mcp"),
    ).resolves.toHaveProperty("status", 200);
    await expect(
      wrapped("https://resource.example/mcp", {
        headers: { authorization: "Basic not-a-bearer" },
      }),
    ).resolves.toHaveProperty("status", 200);
    await expect(
      wrapped("https://resource.example/mcp", { headers: {} }),
    ).resolves.toHaveProperty("status", 200);
  });

  test(`Given a reusable issuer-bound client was stored by an earlier login,
    When a new flow reaches the same issuer,
    Then Keel reuses it while binding the new callback before code exchange`, async () => {
    // Given
    const secrets = testSecretBackend();
    const provider = oauthProvider({
      backend: secrets.backend,
      now: () => 1_001,
      client: null,
    });
    await provider.saveClientInformation(
      {
        client_id: "reusable-client",
        issuer: "https://auth.example",
      },
      { issuer: "https://auth.example" },
    );
    const state = "s".repeat(43);
    await provider.beginFlow(state, 1_000);
    await provider.saveDiscoveryState({
      authorizationServerUrl: "https://auth.example",
      authorizationServerMetadata: {
        issuer: "https://auth.example",
        authorization_endpoint: "https://auth.example/authorize",
        token_endpoint: "https://auth.example/token",
        response_types_supported: ["code"],
      },
    });

    // When
    const client = await provider.clientInformation({
      issuer: "https://auth.example",
    });
    await provider.saveCodeVerifier("v".repeat(43));

    // Then
    expect(client?.client_id).toBe("reusable-client");
    await expect(
      provider.validateCallbackState(
        new URLSearchParams({ code: "code", state }),
      ),
    ).resolves.toBeUndefined();
  });

  test(`Given a callback arrives before discovery, client, and PKCE bindings exist,
    When its state otherwise matches,
    Then Keel rejects the incomplete flow before code exchange`, async () => {
    // Given
    const provider = oauthProvider({
      backend: testSecretBackend().backend,
      now: () => 1_001,
    });
    const state = "s".repeat(43);
    await provider.beginFlow(state, 1_000);

    // When / Then
    await expect(
      provider.validateCallbackState(
        new URLSearchParams({ code: "code", state }),
      ),
    ).rejects.toThrow("missing a bound OAuth value");
  });

  test(`Given callback state has been consumed for one issuer,
    When token or discovery data changes that issuer before completion,
    Then Keel rejects both substitutions`, async () => {
    // Given
    const provider = oauthProvider({
      backend: testSecretBackend().backend,
      now: () => 1_001,
    });
    const state = "s".repeat(43);
    await provider.saveClientInformation(
      {
        client_id: "other-client",
        issuer: "https://other-auth.example",
      },
      { issuer: "https://other-auth.example" },
    );
    await bindPendingFlow(provider, state, 1_000);
    await provider.validateCallbackState(
      new URLSearchParams({ code: "code", state }),
    );

    // When / Then
    await expect(
      provider.saveTokens(
        {
          access_token: "substituted-token",
          token_type: "Bearer",
          issuer: "https://other-auth.example",
        },
        { issuer: "https://other-auth.example" },
      ),
    ).rejects.toThrow("different callback issuer");
    await expect(
      provider.saveDiscoveryState({
        authorizationServerUrl: "https://other-auth.example",
      }),
    ).rejects.toThrow("different callback issuer");
  });

  test(`Given a fully issuer/resource/client-bound pending OAuth flow,
    When the matching callback state is validated,
    Then state is consumed before code exchange while the bound PKCE verifier remains available`, async () => {
    // Given
    const secrets = testSecretBackend();
    const provider = oauthProvider({
      backend: secrets.backend,
      now: () => 1_001,
    });
    const state = "s".repeat(43);
    await bindPendingFlow(provider, state, 1_000);
    const params = new URLSearchParams({
      code: "authorization-code",
      state,
      iss: "https://auth.example",
    });

    // When
    await expect(provider.codeVerifier()).resolves.toBe("v".repeat(43));
    await provider.validateCallbackState(params);

    // Then
    await expect(provider.codeVerifier()).resolves.toBe("v".repeat(43));
    await expect(provider.validateCallbackState(params)).rejects.toThrow(
      "without a pending login",
    );
    expect(secrets.values().join("\n")).not.toContain(state);
  });

  test.each([
    ["missing", new URLSearchParams({ code: "code" })],
    ["wrong", new URLSearchParams({ code: "code", state: "x".repeat(43) })],
  ])(
    `Given a pending OAuth flow receives %s state,
    When Keel validates the callback before code exchange,
    Then it rejects the callback without consuming the valid pending state`,
    async (_case, params) => {
      // Given
      const secrets = testSecretBackend();
      const provider = oauthProvider({
        backend: secrets.backend,
        now: () => 1_001,
      });
      const state = "s".repeat(43);
      await bindPendingFlow(provider, state, 1_000);

      // When / Then
      await expect(provider.validateCallbackState(params)).rejects.toThrow(
        "invalid state binding",
      );
      await expect(provider.state()).resolves.toBe(state);
    },
  );

  test(`Given a callback arrives at the exact flow expiry,
    When Keel validates its otherwise correct state,
    Then it rejects the expired flow before code exchange`, async () => {
    // Given
    const secrets = testSecretBackend();
    const startedAt = 1_000;
    const provider = oauthProvider({
      backend: secrets.backend,
      now: () => startedAt + 2 * 60 * 1000,
    });
    const state = "s".repeat(43);
    await bindPendingFlow(provider, state, startedAt);

    // When / Then
    await expect(
      provider.validateCallbackState(
        new URLSearchParams({ code: "code", state }),
      ),
    ).rejects.toThrow("expired callback state");
  });

  test(`Given discovery metadata names a different protected resource,
    When Keel tries to persist it for a login,
    Then the resource-bound credential record rejects it`, async () => {
    // Given
    const secrets = testSecretBackend();
    const provider = oauthProvider({
      backend: secrets.backend,
      now: () => 0,
    });
    await provider.beginFlow("s".repeat(43), 0);

    // When / Then
    await expect(
      provider.saveDiscoveryState({
        authorizationServerUrl: "https://auth.example",
        resourceMetadata: {
          resource: "https://other.example/mcp",
        },
      }),
    ).rejects.toThrow("different resource");
  });
});
