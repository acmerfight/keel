import type {
  ClientAuthMethod,
  OAuthTokenRevocationRequest,
  StoredOAuthClientInformation,
} from "@modelcontextprotocol/client";
import { selectClientAuthMethod } from "@modelcontextprotocol/client";
import { createMcpPolicyFetch, validateMcpServerUrl } from "../network.ts";
import { withMcpOAuthRefreshLock } from "../oauth-refresh-lock.ts";
import {
  credentialAccount,
  credentialError,
  type McpOAuthServerEndpoint,
  type McpSecretBackend,
  type OAuthCredentialRecord,
  OAuthCredentialStore,
  type RevocableOAuthIssuerGrant,
} from "./credential-store.ts";

export async function deleteMcpOAuthCredentials(
  server: McpOAuthServerEndpoint,
  backend: McpSecretBackend,
  refreshLockRoot: string,
): Promise<boolean> {
  const store = new OAuthCredentialStore({
    server,
    backend,
    refreshLockRoot,
    mutationGuard: null,
  });
  return await store.delete();
}

export async function withMcpOAuthCredentialLock<Result>(
  server: McpOAuthServerEndpoint,
  refreshLockRoot: string,
  action: () => Promise<Result>,
): Promise<Result> {
  return await withMcpOAuthRefreshLock({
    root: refreshLockRoot,
    credentialId: credentialAccount(server),
    action,
  });
}

export async function deleteMcpOAuthCredentialsUnderLock(
  server: McpOAuthServerEndpoint,
  backend: McpSecretBackend,
  refreshLockRoot: string,
): Promise<boolean> {
  const store = new OAuthCredentialStore({
    server,
    backend,
    refreshLockRoot,
    mutationGuard: null,
  });
  return await store.deleteUnderLock();
}

function formEncoded(value: string): string {
  const encoded = new URLSearchParams({ value }).toString();
  return encoded.slice("value=".length);
}

function revocationClientSecret(client: StoredOAuthClientInformation): string {
  if (client.client_secret === undefined) {
    credentialError(
      "cannot authenticate grant revocation without a client secret",
    );
  }
  return client.client_secret;
}

function applyRevocationClientAuthentication(
  method: ClientAuthMethod,
  client: StoredOAuthClientInformation,
  headers: Headers,
  body: URLSearchParams,
): void {
  switch (method) {
    case "client_secret_basic": {
      const credentials = `${formEncoded(client.client_id)}:${formEncoded(revocationClientSecret(client))}`;
      headers.set(
        "authorization",
        `Basic ${Buffer.from(credentials).toString("base64")}`,
      );
      return;
    }
    case "client_secret_post":
      body.set("client_id", client.client_id);
      body.set("client_secret", revocationClientSecret(client));
      return;
    case "none":
      body.set("client_id", client.client_id);
      return;
    /* v8 ignore next 5 -- ClientAuthMethod is an exhaustive SDK union; the default keeps future SDK additions compile-time visible. */
    default: {
      const unsupported: never = method;
      throw new Error(
        `Unsupported OAuth client authentication: ${unsupported}`,
      );
    }
  }
}

async function revokeMcpOAuthGrant(
  server: McpOAuthServerEndpoint,
  credentials: RevocableOAuthIssuerGrant,
): Promise<void> {
  const request: OAuthTokenRevocationRequest & {
    readonly token_type_hint: "access_token" | "refresh_token";
  } =
    credentials.tokens.refresh_token === undefined
      ? {
          token: credentials.tokens.access_token,
          token_type_hint: "access_token",
        }
      : {
          token: credentials.tokens.refresh_token,
          token_type_hint: "refresh_token",
        };
  const body = new URLSearchParams({
    token: request.token,
    token_type_hint: request.token_type_hint,
  });
  const headers = new Headers({
    "content-type": "application/x-www-form-urlencoded",
  });
  const supportedAuthMethods = credentials.revocation.authMethods ?? [
    "client_secret_basic",
  ];
  const authMethod = selectClientAuthMethod(
    credentials.client,
    supportedAuthMethods,
  );
  if (
    supportedAuthMethods.length > 0 &&
    !supportedAuthMethods.includes(authMethod)
  ) {
    credentialError(
      "authorization server does not advertise a supported client authentication method for grant revocation",
    );
  }
  applyRevocationClientAuthentication(
    authMethod,
    credentials.client,
    headers,
    body,
  );

  const validated = validateMcpServerUrl(
    server.url,
    server.allowPrivateNetwork,
  );
  // Keel's MCP egress policy deliberately retains the project-wide loopback
  // HTTP development exception; production and cross-origin OAuth targets
  // remain HTTPS-only.
  const network = createMcpPolicyFetch(validated);
  try {
    let response: Response;
    try {
      response = await network.fetch(credentials.revocation.endpoint, {
        method: "POST",
        headers,
        body,
        redirect: "error",
      });
    } catch {
      credentialError("OAuth grant revocation request failed");
    }
    await response.body?.cancel();
    if (response.status !== 200) {
      credentialError(
        `OAuth grant revocation failed with HTTP ${response.status}`,
      );
    }
  } finally {
    await network.close();
  }
}

async function revokeStoredMcpOAuthGrants(
  server: McpOAuthServerEndpoint,
  record: OAuthCredentialRecord,
): Promise<void> {
  const revocable = record.credentials.filter(
    (credentials): credentials is RevocableOAuthIssuerGrant =>
      credentials.tokens !== null && credentials.revocation !== null,
  );
  const results = await Promise.allSettled(
    revocable.map(
      async (credentials) => await revokeMcpOAuthGrant(server, credentials),
    ),
  );
  if (results.some((result) => result.status === "rejected")) {
    credentialError("one or more OAuth grants could not be revoked");
  }
}

export async function revokeAndDeleteMcpOAuthCredentialsUnderLock(
  server: McpOAuthServerEndpoint,
  backend: McpSecretBackend,
  refreshLockRoot: string,
): Promise<"complete" | "remote-revocation-failed"> {
  const store = new OAuthCredentialStore({
    server,
    backend,
    refreshLockRoot,
    mutationGuard: null,
  });
  let result: "complete" | "remote-revocation-failed" = "complete";
  try {
    await revokeStoredMcpOAuthGrants(server, await store.load());
  } catch {
    result = "remote-revocation-failed";
  }
  await store.deleteUnderLock();
  return result;
}
