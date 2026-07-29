import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  close,
  getPort,
  listen,
} from "../../src/testing/provider-sse-fixtures.ts";

const registrationRequestSchema = z
  .object({
    redirect_uris: z.array(z.string().url()).min(1),
    token_endpoint_auth_method: z.string().optional(),
  })
  .passthrough();
const jsonRpcRequestSchema = z
  .object({
    method: z.string(),
  })
  .passthrough();

export interface OAuthAuthorizationRequest {
  readonly clientId: string;
  readonly codeChallenge: string;
  readonly codeChallengeMethod: string;
  readonly redirectUri: string;
  readonly resource: string;
  readonly state: string;
}

export interface OAuthTokenRequest {
  readonly authorization: string | null;
  readonly clientId: string;
  readonly code: string;
  readonly codeVerifier: string;
  readonly grantType: string;
  readonly refreshToken: string;
  readonly redirectUri: string;
  readonly resource: string;
}

export interface TestOAuthMcpServer {
  readonly url: string;
  readonly accessToken: string;
  readonly refreshedAccessToken: string;
  readonly authorizationRequests: () => readonly OAuthAuthorizationRequest[];
  readonly registrationRequests: () => number;
  readonly tokenRequests: () => readonly OAuthTokenRequest[];
  readonly calls: () => readonly string[];
  readonly authenticatedMcpRequest: Promise<void>;
  readonly releaseAuthenticatedMcpResponse: () => void;
  readonly expireAccessToken: () => void;
  readonly openAuthorizationUrl: (url: URL) => Promise<void>;
  readonly close: () => Promise<void>;
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function base64UrlSha256(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

export async function startOAuthMcpServer(
  options: {
    readonly registration?: "dcr" | "none";
    readonly callbackState?: "valid" | "missing" | "wrong";
    readonly callbackIssuer?: "valid" | "missing" | "mismatch";
    readonly tokenEndpointAuthMethod?: "none" | "client_secret_basic";
    readonly authChallenge?: "connect" | "tools-list";
    readonly authentication?: "required" | "optional";
    readonly tokenResponse?: "valid" | "malformed";
    readonly authenticatedMcpResponse?: "valid" | "server-error" | "pending";
    readonly refreshResponse?:
      | "rotate"
      | "omit-refresh-token-and-scope"
      | "invalid-grant";
    readonly refreshDelayMs?: number;
  } = {},
): Promise<TestOAuthMcpServer> {
  const accessToken = "keel-mcp-oauth-test-access-token";
  const refreshedAccessToken = "keel-mcp-oauth-test-refreshed-access-token";
  const refreshToken = "keel-mcp-oauth-test-refresh-token";
  const rotatedRefreshToken = "keel-mcp-oauth-test-rotated-refresh-token";
  const authorizationCode = "keel-mcp-oauth-test-code";
  const authorizationRequests: OAuthAuthorizationRequest[] = [];
  const tokenRequests: OAuthTokenRequest[] = [];
  const calls: string[] = [];
  let registrationRequests = 0;
  let origin = "";
  let resourceUrl = "";
  let acceptedAccessToken = accessToken;
  const authenticatedMcpRequest = Promise.withResolvers<void>();
  const authenticatedMcpResponse = Promise.withResolvers<void>();

  const mcpHandler = createMcpHandler(() => {
    const mcp = new McpServer(
      { name: "keel-oauth-test", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    mcp.registerTool(
      "search",
      {
        description: "Search the protected catalog",
        inputSchema: z.object({ query: z.string() }),
      },
      async ({ query }) => {
        calls.push(query);
        return {
          content: [{ type: "text", text: `protected result for ${query}` }],
        };
      },
    );
    return mcp;
  });

  const handler = toNodeHandler({
    fetch: async (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/.well-known/oauth-protected-resource") {
        return jsonResponse({
          resource: resourceUrl,
          authorization_servers: [origin],
          scopes_supported: ["mcp:tools"],
        });
      }
      if (
        url.pathname === "/.well-known/oauth-authorization-server" ||
        url.pathname === "/.well-known/openid-configuration"
      ) {
        return jsonResponse({
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          ...(options.registration === "none"
            ? {}
            : { registration_endpoint: `${origin}/register` }),
          response_types_supported: ["code"],
          grant_types_supported:
            options.refreshResponse === undefined
              ? ["authorization_code"]
              : ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: [
            options.tokenEndpointAuthMethod ?? "none",
          ],
          authorization_response_iss_parameter_supported: true,
          scopes_supported: ["mcp:tools"],
        });
      }
      if (url.pathname === "/register" && request.method === "POST") {
        registrationRequests += 1;
        if (options.registration === "none") {
          return new Response(null, { status: 404 });
        }
        const registration = registrationRequestSchema.parse(
          await request.json(),
        );
        return jsonResponse(
          {
            client_id: "keel-oauth-test-client",
            redirect_uris: registration.redirect_uris,
            token_endpoint_auth_method:
              registration.token_endpoint_auth_method ?? "none",
          },
          201,
        );
      }
      if (url.pathname === "/authorize" && request.method === "GET") {
        const authorization: OAuthAuthorizationRequest = {
          clientId: url.searchParams.get("client_id") ?? "",
          codeChallenge: url.searchParams.get("code_challenge") ?? "",
          codeChallengeMethod:
            url.searchParams.get("code_challenge_method") ?? "",
          redirectUri: url.searchParams.get("redirect_uri") ?? "",
          resource: url.searchParams.get("resource") ?? "",
          state: url.searchParams.get("state") ?? "",
        };
        authorizationRequests.push(authorization);
        const callback = new URL(authorization.redirectUri);
        callback.searchParams.set("code", authorizationCode);
        if (options.callbackState !== "missing") {
          callback.searchParams.set(
            "state",
            options.callbackState === "wrong"
              ? "wrong-state-value".repeat(3)
              : authorization.state,
          );
        }
        if (options.callbackIssuer !== "missing") {
          callback.searchParams.set(
            "iss",
            options.callbackIssuer === "mismatch"
              ? "https://attacker.example"
              : origin,
          );
        }
        return new Response(null, {
          status: 302,
          headers: { location: callback.href },
        });
      }
      if (url.pathname === "/token" && request.method === "POST") {
        const body = new URLSearchParams(await request.text());
        const tokenRequest: OAuthTokenRequest = {
          authorization: request.headers.get("authorization"),
          clientId: body.get("client_id") ?? "",
          code: body.get("code") ?? "",
          codeVerifier: body.get("code_verifier") ?? "",
          grantType: body.get("grant_type") ?? "",
          refreshToken: body.get("refresh_token") ?? "",
          redirectUri: body.get("redirect_uri") ?? "",
          resource: body.get("resource") ?? "",
        };
        tokenRequests.push(tokenRequest);
        if (tokenRequest.grantType === "refresh_token") {
          if (options.refreshDelayMs !== undefined) {
            await new Promise<void>((resolve) => {
              setTimeout(resolve, options.refreshDelayMs);
            });
          }
          if (
            options.refreshResponse === "invalid-grant" ||
            tokenRequest.refreshToken !== refreshToken
          ) {
            return jsonResponse({ error: "invalid_grant" }, 400);
          }
          acceptedAccessToken = refreshedAccessToken;
          return jsonResponse({
            access_token: refreshedAccessToken,
            token_type: "Bearer",
            ...(options.refreshResponse === "omit-refresh-token-and-scope"
              ? {}
              : {
                  refresh_token: rotatedRefreshToken,
                  scope: "mcp:tools",
                }),
          });
        }
        const authorization = authorizationRequests.at(-1);
        if (
          authorization === undefined ||
          tokenRequest.code !== authorizationCode ||
          base64UrlSha256(tokenRequest.codeVerifier) !==
            authorization.codeChallenge
        ) {
          return jsonResponse({ error: "invalid_grant" }, 400);
        }
        if (options.tokenResponse === "malformed") {
          return new Response("{", {
            headers: { "content-type": "application/json" },
          });
        }
        return jsonResponse({
          access_token: accessToken,
          token_type: "Bearer",
          scope: "mcp:tools",
          ...(options.refreshResponse === undefined
            ? {}
            : { refresh_token: refreshToken }),
        });
      }
      if (url.pathname === "/mcp") {
        const authenticated =
          request.headers.get("authorization") ===
          `Bearer ${acceptedAccessToken}`;
        if (!authenticated && options.authentication !== "optional") {
          const requestMessage = jsonRpcRequestSchema.safeParse(
            await request.clone().json(),
          );
          if (
            options.authChallenge !== "tools-list" ||
            (requestMessage.success &&
              requestMessage.data.method === "tools/list")
          ) {
            return new Response(null, {
              status: 401,
              headers: {
                "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
              },
            });
          }
        }
        if (
          authenticated &&
          options.authenticatedMcpResponse === "server-error"
        ) {
          return new Response(null, { status: 500 });
        }
        if (authenticated) {
          authenticatedMcpRequest.resolve();
          if (options.authenticatedMcpResponse === "pending") {
            await authenticatedMcpResponse.promise;
          }
        }
        return await mcpHandler.fetch(request);
      }
      return new Response(null, { status: 404 });
    },
  });
  const server = createServer((request, response) => {
    void handler(
      {
        headers: request.headers,
        ...(request.method !== undefined ? { method: request.method } : {}),
        ...(request.url !== undefined ? { url: request.url } : {}),
        [Symbol.asyncIterator]: () => request[Symbol.asyncIterator](),
      },
      response,
    );
  });
  await listen(server);
  origin = `http://127.0.0.1:${getPort(server)}`;
  resourceUrl = `${origin}/mcp`;

  return {
    url: resourceUrl,
    accessToken,
    refreshedAccessToken,
    authorizationRequests: () => [...authorizationRequests],
    registrationRequests: () => registrationRequests,
    tokenRequests: () => [...tokenRequests],
    calls: () => [...calls],
    authenticatedMcpRequest: authenticatedMcpRequest.promise,
    releaseAuthenticatedMcpResponse: () => {
      authenticatedMcpResponse.resolve();
    },
    expireAccessToken: () => {
      acceptedAccessToken = "expired";
    },
    openAuthorizationUrl: async (url) => {
      const response = await fetch(url, { redirect: "follow" });
      await response.text();
    },
    close: async () => {
      await mcpHandler.close?.();
      await close(server);
    },
  };
}
