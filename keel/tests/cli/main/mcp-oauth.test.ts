import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, test, vi } from "vitest";
import { runCliMain } from "../../../src/cli/index.ts";
import { listMcpServers } from "../../../src/cli/mcp-config.ts";
import type { McpSecretBackend } from "../../../src/mcp/oauth.ts";
import { createRuntime } from "../../../src/testing/cli-runtime-fixtures.ts";
import { startOAuthMcpServer } from "../../fixtures/mcp-oauth.ts";

function createSecretBackend(): {
  readonly backend: McpSecretBackend;
  readonly entries: ReadonlyMap<string, string>;
  readonly failDeletesAfterEffect: (message: string) => void;
  readonly failWrites: (message: string) => void;
} {
  const entries = new Map<string, string>();
  let deleteFailure: string | null = null;
  let writeFailure: string | null = null;
  const key = (service: string, account: string) => `${service}\0${account}`;
  return {
    backend: {
      getPassword: async (service, account) =>
        entries.get(key(service, account)) ?? null,
      setPassword: async (service, account, password) => {
        if (writeFailure !== null) throw new Error(writeFailure);
        entries.set(key(service, account), password);
      },
      deletePassword: async (service, account) => {
        const deleted = entries.delete(key(service, account));
        if (deleteFailure !== null) throw new Error(deleteFailure);
        return deleted;
      },
    },
    entries,
    failDeletesAfterEffect: (message) => {
      deleteFailure = message;
    },
    failWrites: (message) => {
      writeFailure = message;
    },
  };
}

type OAuthMcpServerOptions = NonNullable<
  Parameters<typeof startOAuthMcpServer>[0]
>;

async function loggedInRefreshableMcp(options: OAuthMcpServerOptions) {
  const home = await mkdtemp(join(tmpdir(), "keel-mcp-refresh-home-"));
  const mcp = await startOAuthMcpServer(options);
  const secrets = createSecretBackend();
  const add = createRuntime(["mcp", "add", mcp.url, "--name", "refreshable"], {
    env: { KEEL_HOME: home },
  });
  expect(
    await runCliMain(add.runtime),
    [add.stdout(), add.stderr()].join("\n"),
  ).toBe(0);
  const login = createRuntime(["mcp", "login", "refreshable"], {
    env: { KEEL_HOME: home },
    mcpSecretBackend: secrets.backend,
    openExternalUrl: mcp.openAuthorizationUrl,
  });
  expect(await runCliMain(login.runtime), login.stderr()).toBe(0);
  return { home, mcp, secrets, login };
}

const invalidCallbackCases: readonly {
  readonly caseName: string;
  readonly serverOptions: NonNullable<
    Parameters<typeof startOAuthMcpServer>[0]
  >;
  readonly expectedError: string;
}[] = [
  {
    caseName: "missing state",
    serverOptions: { callbackState: "missing" },
    expectedError: "invalid state",
  },
  {
    caseName: "wrong state",
    serverOptions: { callbackState: "wrong" },
    expectedError: "invalid state",
  },
  {
    caseName: "missing required issuer",
    serverOptions: { callbackIssuer: "missing" },
    expectedError: "callback issuer validation failed",
  },
  {
    caseName: "mismatched issuer",
    serverOptions: { callbackIssuer: "mismatch" },
    expectedError: "callback issuer validation failed",
  },
];

describe("CLI Main - MCP OAuth", () => {
  test(`Given an OAuth MCP server is disabled before login,
    When the user attempts authorization,
    Then Keel rejects the command before opening a browser or creating credentials`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-mcp-disabled-login-"));
    const mcp = await startOAuthMcpServer();
    const secrets = createSecretBackend();
    const add = createRuntime(["mcp", "add", mcp.url, "--name", "protected"], {
      env: { KEEL_HOME: home },
    });

    try {
      expect(await runCliMain(add.runtime)).toBe(0);
      const disable = createRuntime(["mcp", "disable", "protected"], {
        env: { KEEL_HOME: home },
      });
      expect(await runCliMain(disable.runtime)).toBe(0);
      let browserOpened = false;
      const login = createRuntime(["mcp", "login", "protected"], {
        env: { KEEL_HOME: home },
        mcpSecretBackend: secrets.backend,
        openExternalUrl: async () => {
          browserOpened = true;
        },
      });

      // When
      const exitCode = await runCliMain(login.runtime);

      // Then
      expect(exitCode).toBe(1);
      expect(login.stdout()).toBe("");
      expect(login.stderr()).toContain('MCP server "protected" is disabled');
      expect(browserOpened).toBe(false);
      expect(mcp.authorizationRequests()).toEqual([]);
      expect(mcp.tokenRequests()).toEqual([]);
      expect(secrets.entries.size).toBe(0);
    } finally {
      await mcp.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given an OAuth server is disabled after login begins but before its callback is consumed,
    When authorization redirects back to Keel,
    Then no token exchange or durable credential survives the lifecycle change`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-mcp-login-race-"));
    const mcp = await startOAuthMcpServer();
    const secrets = createSecretBackend();
    secrets.failDeletesAfterEffect("credential cleanup unavailable");
    const add = createRuntime(["mcp", "add", mcp.url, "--name", "protected"], {
      env: { KEEL_HOME: home },
    });

    try {
      expect(await runCliMain(add.runtime)).toBe(0);
      const login = createRuntime(["mcp", "login", "protected"], {
        env: { KEEL_HOME: home },
        mcpSecretBackend: secrets.backend,
        openExternalUrl: async (url) => {
          const disable = createRuntime(["mcp", "disable", "protected"], {
            env: { KEEL_HOME: home },
          });
          expect(await runCliMain(disable.runtime)).toBe(0);
          await mcp.openAuthorizationUrl(url);
        },
      });

      // When
      const exitCode = await runCliMain(login.runtime);

      // Then
      expect(exitCode).toBe(1);
      expect(login.stderr()).toMatch(
        /disabled, removed, or changed|callback was cancelled/u,
      );
      expect(login.stderr()).not.toContain("credential cleanup unavailable");
      expect(mcp.tokenRequests()).toEqual([]);
      expect(secrets.entries.size).toBe(0);
      await expect(listMcpServers({ env: login.runtime.env })).resolves.toEqual(
        [expect.objectContaining({ id: "protected", enabled: false })],
      );
    } finally {
      await mcp.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given MCP login is waiting without an authorization callback,
    When another command disables the configured server,
    Then login settles only after its loopback listener is closed`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-mcp-login-disable-"));
    const mcp = await startOAuthMcpServer();
    const secrets = createSecretBackend();
    const add = createRuntime(["mcp", "add", mcp.url, "--name", "protected"], {
      env: { KEEL_HOME: home },
    });
    const authorizationOpened = Promise.withResolvers<URL>();

    try {
      expect(await runCliMain(add.runtime)).toBe(0);
      const login = createRuntime(["mcp", "login", "protected"], {
        env: { KEEL_HOME: home },
        mcpSecretBackend: secrets.backend,
        openExternalUrl: async (url) => {
          authorizationOpened.resolve(url);
        },
      });
      const loginRun = runCliMain(login.runtime);
      const authorizationUrl = new URL(await authorizationOpened.promise);
      const redirectUrl = authorizationUrl.searchParams.get("redirect_uri");
      if (redirectUrl === null) {
        throw new Error("MCP authorization URL omitted redirect_uri");
      }
      const disable = createRuntime(["mcp", "disable", "protected"], {
        env: { KEEL_HOME: home },
      });

      // When
      expect(await runCliMain(disable.runtime)).toBe(0);
      const exitCode = await loginRun;

      // Then
      expect(exitCode).toBe(1);
      expect(login.stderr()).toContain("callback was cancelled");
      await expect(
        fetch(redirectUrl, { signal: AbortSignal.timeout(1_000) }),
      ).rejects.toThrow();
      expect(mcp.tokenRequests()).toEqual([]);
      expect(secrets.entries.size).toBe(0);
    } finally {
      await mcp.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a disabled MCP server has durable OAuth credentials,
    When the user removes the server twice,
    Then Keel deletes credentials and configuration exactly once`, async () => {
    // Given
    const fixture = await loggedInRefreshableMcp({
      refreshResponse: "rotate",
    });

    try {
      expect(fixture.secrets.entries.size).toBe(1);
      const disable = createRuntime(["mcp", "disable", "refreshable"], {
        env: { KEEL_HOME: fixture.home },
        mcpSecretBackend: fixture.secrets.backend,
      });
      expect(await runCliMain(disable.runtime)).toBe(0);
      const remove = createRuntime(["mcp", "remove", "refreshable"], {
        env: { KEEL_HOME: fixture.home },
        mcpSecretBackend: fixture.secrets.backend,
      });
      const removeAgain = createRuntime(["mcp", "remove", "refreshable"], {
        env: { KEEL_HOME: fixture.home },
        mcpSecretBackend: fixture.secrets.backend,
      });

      // When
      const removeExitCode = await runCliMain(remove.runtime);
      const removeAgainExitCode = await runCliMain(removeAgain.runtime);

      // Then
      expect(removeExitCode, remove.stderr()).toBe(0);
      expect(remove.stdout()).toBe('Removed MCP server "refreshable".\n');
      expect(removeAgainExitCode, removeAgain.stderr()).toBe(0);
      expect(removeAgain.stdout()).toBe(
        'MCP server "refreshable" is already removed.\n',
      );
      expect(fixture.secrets.entries.size).toBe(0);
      await expect(listMcpServers(remove.runtime)).resolves.toEqual([]);
    } finally {
      await fixture.mcp.close();
      await rm(fixture.home, { recursive: true, force: true });
    }
  });

  test(`Given a logged-in MCP server rejects an expired access token,
    When the user checks server status,
    Then Keel refreshes the credential once and reports the protected server ready`, async () => {
    // Given
    const { home, mcp, secrets, login } = await loggedInRefreshableMcp({
      refreshResponse: "rotate",
    });

    try {
      mcp.expireAccessToken();
      const status = createRuntime(["mcp", "status", "refreshable"], {
        env: { KEEL_HOME: home },
        mcpSecretBackend: secrets.backend,
      });

      // When
      const exitCode = await runCliMain(status.runtime);

      // Then
      expect(exitCode, status.stderr()).toBe(0);
      expect(status.stdout()).toContain("status: ready\n");
      expect(mcp.tokenRequests().map((request) => request.grantType)).toEqual([
        "authorization_code",
        "refresh_token",
      ]);
      const visibleOutput = [
        login.stdout(),
        login.stderr(),
        status.stdout(),
        status.stderr(),
      ].join("\n");
      expect(visibleOutput).not.toContain(mcp.accessToken);
      expect(visibleOutput).not.toContain(mcp.refreshedAccessToken);
    } finally {
      await mcp.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a refresh response omits the optional refresh token and scope,
    When the access token expires again,
    Then Keel preserves the prior values and refreshes the authenticated session again`, async () => {
    // Given
    const { home, mcp, secrets } = await loggedInRefreshableMcp({
      refreshResponse: "omit-refresh-token-and-scope",
    });

    try {
      mcp.expireAccessToken();
      const firstStatus = createRuntime(["mcp", "status", "refreshable"], {
        env: { KEEL_HOME: home },
        mcpSecretBackend: secrets.backend,
      });
      expect(await runCliMain(firstStatus.runtime), firstStatus.stderr()).toBe(
        0,
      );
      expect(firstStatus.stdout()).toContain("status: ready\n");
      const firstRefresh = mcp.tokenRequests()[1];
      expect(firstRefresh?.grantType).toBe("refresh_token");
      expect([...secrets.entries.values()].join("\n")).toContain(
        `"refresh_token":"${firstRefresh?.refreshToken}"`,
      );
      expect([...secrets.entries.values()].join("\n")).toContain(
        '"scope":"mcp:tools"',
      );
      mcp.expireAccessToken();
      const secondStatus = createRuntime(["mcp", "status", "refreshable"], {
        env: { KEEL_HOME: home },
        mcpSecretBackend: secrets.backend,
      });

      // When
      const exitCode = await runCliMain(secondStatus.runtime);

      // Then
      expect(exitCode, secondStatus.stderr()).toBe(0);
      expect(secondStatus.stdout()).toContain("status: ready\n");
      expect(mcp.tokenRequests().map((request) => request.grantType)).toEqual([
        "authorization_code",
        "refresh_token",
        "refresh_token",
      ]);
      expect(mcp.tokenRequests()[2]?.refreshToken).toBe(
        firstRefresh?.refreshToken,
      );
    } finally {
      await mcp.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given concurrent MCP status checks reject the same expired credential,
    When they recover in parallel,
    Then they share one refresh transaction and all adopt the published credential`, async () => {
    // Given
    const { home, mcp, secrets } = await loggedInRefreshableMcp({
      refreshResponse: "rotate",
      refreshDelayMs: 100,
    });

    try {
      mcp.expireAccessToken();
      const statuses = Array.from({ length: 4 }, () =>
        createRuntime(["mcp", "status", "refreshable"], {
          env: { KEEL_HOME: home },
          mcpSecretBackend: secrets.backend,
        }),
      );

      // When
      const exitCodes = await Promise.all(
        statuses.map(async (status) => await runCliMain(status.runtime)),
      );

      // Then
      expect(exitCodes).toEqual([0, 0, 0, 0]);
      for (const status of statuses) {
        expect(status.stdout()).toContain("status: ready\n");
      }
      expect(mcp.tokenRequests().map((request) => request.grantType)).toEqual([
        "authorization_code",
        "refresh_token",
      ]);
    } finally {
      await mcp.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given the authorization server rejects a stored refresh credential,
    When status retries authentication,
    Then Keel clears the unusable credential and reports needs-auth without retrying it again`, async () => {
    // Given
    const { home, mcp, secrets } = await loggedInRefreshableMcp({
      refreshResponse: "invalid-grant",
    });

    try {
      mcp.expireAccessToken();
      const firstStatus = createRuntime(["mcp", "status", "refreshable"], {
        env: { KEEL_HOME: home },
        mcpSecretBackend: secrets.backend,
      });

      // When
      const firstExitCode = await runCliMain(firstStatus.runtime);
      const secondStatus = createRuntime(["mcp", "status", "refreshable"], {
        env: { KEEL_HOME: home },
        mcpSecretBackend: secrets.backend,
      });
      const secondExitCode = await runCliMain(secondStatus.runtime);

      // Then
      expect(firstExitCode, firstStatus.stderr()).toBe(0);
      expect(secondExitCode, secondStatus.stderr()).toBe(0);
      expect(firstStatus.stdout()).toContain("status: needs-auth\n");
      expect(secondStatus.stdout()).toContain("status: needs-auth\n");
      expect(mcp.tokenRequests().map((request) => request.grantType)).toEqual([
        "authorization_code",
        "refresh_token",
      ]);
      expect([...secrets.entries.values()].join("\n")).not.toContain(
        mcp.accessToken,
      );
    } finally {
      await mcp.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a refresh succeeds but secure credential publication fails,
    When status recovers from a 401,
    Then Keel reports a failed server and never exposes the unpublished access token`, async () => {
    // Given
    const { home, mcp, secrets } = await loggedInRefreshableMcp({
      refreshResponse: "rotate",
    });

    try {
      mcp.expireAccessToken();
      secrets.failWrites("credential publication unavailable");
      const status = createRuntime(["mcp", "status", "refreshable"], {
        env: { KEEL_HOME: home },
        mcpSecretBackend: secrets.backend,
      });

      // When
      const exitCode = await runCliMain(status.runtime);

      // Then
      expect(exitCode, status.stderr()).toBe(0);
      expect(status.stdout()).toContain("status: failed\n");
      expect(status.stdout()).toContain("secure credential storage failed");
      expect(status.stdout()).not.toContain(mcp.refreshedAccessToken);
      expect(mcp.tokenRequests().map((request) => request.grantType)).toEqual([
        "authorization_code",
        "refresh_token",
      ]);
    } finally {
      await mcp.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given the cross-process refresh lock cannot be created,
    When an expired credential receives a 401,
    Then Keel fails closed before submitting the rotating refresh token`, async () => {
    // Given
    const { home, mcp, secrets } = await loggedInRefreshableMcp({
      refreshResponse: "rotate",
    });

    try {
      mcp.expireAccessToken();
      await rm(join(home, "mcp"), { recursive: true, force: true });
      await writeFile(join(home, "mcp"), "blocked");
      const status = createRuntime(["mcp", "status", "refreshable"], {
        env: { KEEL_HOME: home },
        mcpSecretBackend: secrets.backend,
      });

      // When
      const exitCode = await runCliMain(status.runtime);

      // Then
      expect(exitCode, status.stderr()).toBe(0);
      expect(status.stdout()).toContain("status: failed\n");
      expect(status.stdout()).toContain("refresh lock");
      expect(mcp.tokenRequests().map((request) => request.grantType)).toEqual([
        "authorization_code",
      ]);
    } finally {
      await mcp.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a protected Streamable HTTP MCP server advertises OAuth discovery and DCR,
    When the user logs in through the loopback PKCE callback and later logs out,
    Then Keel binds and stores authorization securely, authenticates status dynamically, and removes it`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-mcp-oauth-home-"));
    const mcp = await startOAuthMcpServer();
    const secrets = createSecretBackend();
    const add = createRuntime(["mcp", "add", mcp.url, "--name", "protected"], {
      env: { KEEL_HOME: home },
    });

    try {
      expect(await runCliMain(add.runtime)).toBe(0);
      expect(add.stdout()).toContain("status: needs-auth\n");

      const loginFixture = createRuntime(["mcp", "login", "protected"], {
        env: { KEEL_HOME: home },
      });
      const loginRuntime = {
        ...loginFixture.runtime,
        mcpSecretBackend: secrets.backend,
        openExternalUrl: mcp.openAuthorizationUrl,
      };

      // When
      const loginExitCode = await runCliMain(loginRuntime);
      const authenticationRequiredAfterLogin = (
        await listMcpServers(loginRuntime)
      )[0]?.authenticationRequired;
      const statusFixture = createRuntime(["mcp", "status", "protected"], {
        env: { KEEL_HOME: home },
      });
      const statusExitCode = await runCliMain({
        ...statusFixture.runtime,
        mcpSecretBackend: secrets.backend,
        openExternalUrl: mcp.openAuthorizationUrl,
      });
      const logoutFixture = createRuntime(["mcp", "logout", "protected"], {
        env: { KEEL_HOME: home },
      });
      const logoutExitCode = await runCliMain({
        ...logoutFixture.runtime,
        mcpSecretBackend: secrets.backend,
        openExternalUrl: mcp.openAuthorizationUrl,
      });

      // Then
      expect(loginExitCode, loginFixture.stderr()).toBe(0);
      expect(authenticationRequiredAfterLogin).toBe(true);
      expect(loginFixture.stdout()).toContain(
        'Logged in to MCP server "protected".\n',
      );
      expect(statusExitCode, statusFixture.stderr()).toBe(0);
      expect(statusFixture.stdout()).toContain("status: ready\n");
      expect(logoutExitCode, logoutFixture.stderr()).toBe(0);
      expect(logoutFixture.stdout()).toBe(
        'Logged out of MCP server "protected".\n',
      );
      expect(
        (await listMcpServers(logoutFixture.runtime))[0]
          ?.authenticationRequired,
      ).toBe(false);
      expect(secrets.entries.size).toBe(0);

      const authorization = mcp.authorizationRequests();
      expect(authorization).toHaveLength(1);
      expect(authorization[0]).toMatchObject({
        clientId: "keel-oauth-test-client",
        codeChallengeMethod: "S256",
        resource: mcp.url,
      });
      expect(authorization[0]?.state).toMatch(/^[A-Za-z0-9_-]{32,}$/u);
      const callback = new URL(authorization[0]?.redirectUri ?? "");
      expect(callback.protocol).toBe("http:");
      expect(callback.hostname).toBe("127.0.0.1");
      expect(callback.port).not.toBe("");
      expect(callback.pathname).toBe("/oauth/callback");

      const token = mcp.tokenRequests();
      expect(token).toHaveLength(1);
      expect(token[0]).toMatchObject({
        clientId: "keel-oauth-test-client",
        code: "keel-mcp-oauth-test-code",
        grantType: "authorization_code",
        redirectUri: authorization[0]?.redirectUri,
        resource: mcp.url,
      });
      expect(token[0]?.codeVerifier).not.toBe("");
      const visibleOutput = [
        loginFixture.stdout(),
        loginFixture.stderr(),
        statusFixture.stdout(),
        statusFixture.stderr(),
        logoutFixture.stdout(),
        logoutFixture.stderr(),
      ].join("\n");
      expect(visibleOutput).not.toContain(mcp.accessToken);
      expect(visibleOutput).not.toContain("keel-mcp-oauth-test-code");
    } finally {
      await mcp.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given an authorization server does not advertise dynamic registration,
    When the user logs in with a pre-registered public client,
    Then Keel uses that issuer-bound client before considering DCR`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-mcp-preregistered-home-"));
    const mcp = await startOAuthMcpServer({ registration: "none" });
    const secrets = createSecretBackend();
    const add = createRuntime(["mcp", "add", mcp.url, "--name", "protected"], {
      env: { KEEL_HOME: home },
    });

    try {
      expect(await runCliMain(add.runtime)).toBe(0);
      const login = createRuntime(
        ["mcp", "login", "protected", "--client-id", "pre-registered-client"],
        {
          env: { KEEL_HOME: home },
          mcpSecretBackend: secrets.backend,
          openExternalUrl: mcp.openAuthorizationUrl,
        },
      );

      // When
      const exitCode = await runCliMain(login.runtime);

      // Then
      expect(exitCode, login.stderr()).toBe(0);
      expect(login.stdout()).toBe('Logged in to MCP server "protected".\n');
      expect(mcp.registrationRequests()).toBe(0);
      expect(mcp.authorizationRequests()[0]?.clientId).toBe(
        "pre-registered-client",
      );
      expect(mcp.tokenRequests()[0]?.clientId).toBe("pre-registered-client");
    } finally {
      await mcp.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given no reusable or pre-registered client exists and DCR is not advertised,
    When the user attempts MCP login,
    Then Keel fails before opening a browser with an actionable registration choice`, async () => {
    // Given
    const home = await mkdtemp(
      join(tmpdir(), "keel-mcp-no-registration-home-"),
    );
    const mcp = await startOAuthMcpServer({ registration: "none" });
    const secrets = createSecretBackend();
    const add = createRuntime(["mcp", "add", mcp.url, "--name", "protected"], {
      env: { KEEL_HOME: home },
    });

    try {
      expect(await runCliMain(add.runtime)).toBe(0);
      const login = createRuntime(["mcp", "login", "protected"], {
        env: { KEEL_HOME: home },
        mcpSecretBackend: secrets.backend,
        openExternalUrl: mcp.openAuthorizationUrl,
      });

      // When
      const exitCode = await runCliMain(login.runtime);

      // Then
      expect(exitCode).toBe(1);
      expect(login.stdout()).toBe("");
      expect(login.stderr()).toContain(
        "does not advertise dynamic registration; configure a pre-registered client",
      );
      expect(mcp.registrationRequests()).toBe(0);
      expect(mcp.authorizationRequests()).toEqual([]);
      expect(mcp.tokenRequests()).toEqual([]);
    } finally {
      await mcp.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a pre-registered confidential OAuth client is required,
    When the user supplies its secret on stdin,
    Then Keel authenticates the token request without placing the secret in arguments or output`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-mcp-client-secret-home-"));
    const mcp = await startOAuthMcpServer({
      registration: "none",
      tokenEndpointAuthMethod: "client_secret_basic",
    });
    const secrets = createSecretBackend();
    const add = createRuntime(["mcp", "add", mcp.url, "--name", "protected"], {
      env: { KEEL_HOME: home },
    });
    const clientSecret = " confidential-client-secret ";
    const input = new PassThrough();
    input.setEncoding("utf8");
    input.end(`${clientSecret}\r\n`);

    try {
      expect(await runCliMain(add.runtime)).toBe(0);
      const login = createRuntime(
        [
          "mcp",
          "login",
          "protected",
          "--client-id",
          "confidential-client",
          "--with-client-secret",
        ],
        {
          env: { KEEL_HOME: home },
          input,
          mcpSecretBackend: secrets.backend,
          openExternalUrl: mcp.openAuthorizationUrl,
        },
      );

      // When
      const exitCode = await runCliMain(login.runtime);

      // Then
      expect(exitCode, login.stderr()).toBe(0);
      expect(mcp.tokenRequests()[0]?.authorization).toBe(
        `Basic ${Buffer.from(`confidential-client:${clientSecret}`).toString("base64")}`,
      );
      expect(login.stdout()).not.toContain(clientSecret);
      expect(login.stderr()).not.toContain(clientSecret);
    } finally {
      await mcp.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given confidential client input is attached to an echoing terminal,
    When the user requests MCP login with a client secret,
    Then Keel rejects TTY secret entry before reading or opening the browser`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-mcp-tty-secret-home-"));
    const mcp = await startOAuthMcpServer({ registration: "none" });
    const secrets = createSecretBackend();
    const add = createRuntime(["mcp", "add", mcp.url, "--name", "protected"], {
      env: { KEEL_HOME: home },
    });
    const input = new PassThrough();
    input.end();

    try {
      expect(await runCliMain(add.runtime)).toBe(0);
      const login = createRuntime(
        [
          "mcp",
          "login",
          "protected",
          "--client-id",
          "confidential-client",
          "--with-client-secret",
        ],
        {
          env: { KEEL_HOME: home },
          input,
          inputIsTTY: true,
          mcpSecretBackend: secrets.backend,
          openExternalUrl: mcp.openAuthorizationUrl,
        },
      );

      // When
      const exitCode = await runCliMain(login.runtime);

      // Then
      expect(exitCode).toBe(1);
      expect(login.stdout()).toBe("");
      expect(login.stderr()).toContain("client secret must be piped on stdin");
      expect(mcp.authorizationRequests()).toEqual([]);
    } finally {
      await mcp.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a piped confidential client secret exceeds the bounded input limit,
    When the user requests MCP login,
    Then Keel stops reading before discovery or browser authorization`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-mcp-large-secret-home-"));
    const mcp = await startOAuthMcpServer({ registration: "none" });
    const secrets = createSecretBackend();
    const add = createRuntime(["mcp", "add", mcp.url, "--name", "protected"], {
      env: { KEEL_HOME: home },
    });
    const input = new PassThrough();
    input.end("x".repeat(64 * 1024 + 1));

    try {
      expect(await runCliMain(add.runtime)).toBe(0);
      const login = createRuntime(
        [
          "mcp",
          "login",
          "protected",
          "--client-id",
          "confidential-client",
          "--with-client-secret",
        ],
        {
          env: { KEEL_HOME: home },
          input,
          mcpSecretBackend: secrets.backend,
          openExternalUrl: mcp.openAuthorizationUrl,
        },
      );

      // When
      const exitCode = await runCliMain(login.runtime);

      // Then
      expect(exitCode).toBe(1);
      expect(login.stdout()).toBe("");
      expect(login.stderr()).toContain("exceeds 65536 bytes");
      expect(mcp.authorizationRequests()).toEqual([]);
    } finally {
      await mcp.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  test.each([
    ["empty", "\n", "requires a client secret on stdin"],
    [
      "multiple-line",
      "first-secret-line\nsecond-secret-line",
      "requires a single-line client secret on stdin",
    ],
  ])(
    `Given piped confidential client input is %s,
    When the user requests MCP login,
    Then Keel rejects the malformed secret before discovery or browser authorization`,
    async (_case, pipedSecret, expectedError) => {
      // Given
      const home = await mkdtemp(join(tmpdir(), "keel-mcp-invalid-secret-"));
      const mcp = await startOAuthMcpServer({ registration: "none" });
      const secrets = createSecretBackend();
      const add = createRuntime(
        ["mcp", "add", mcp.url, "--name", "protected"],
        { env: { KEEL_HOME: home } },
      );
      const input = new PassThrough();
      input.end(pipedSecret);

      try {
        expect(await runCliMain(add.runtime)).toBe(0);
        const login = createRuntime(
          [
            "mcp",
            "login",
            "protected",
            "--client-id",
            "confidential-client",
            "--with-client-secret",
          ],
          {
            env: { KEEL_HOME: home },
            input,
            mcpSecretBackend: secrets.backend,
            openExternalUrl: mcp.openAuthorizationUrl,
          },
        );

        // When
        const exitCode = await runCliMain(login.runtime);

        // Then
        expect(exitCode).toBe(1);
        expect(login.stdout()).toBe("");
        expect(login.stderr()).toContain(expectedError);
        expect(mcp.authorizationRequests()).toEqual([]);
      } finally {
        await mcp.close();
        await rm(home, { recursive: true, force: true });
      }
    },
  );

  test.each(invalidCallbackCases)(
    `Given an authorization callback has $caseName,
    When the user attempts MCP login,
    Then Keel rejects it before storing or exposing an access token`,
    async ({ serverOptions, expectedError }) => {
      // Given
      const home = await mkdtemp(join(tmpdir(), "keel-mcp-invalid-callback-"));
      const mcp = await startOAuthMcpServer(serverOptions);
      const secrets = createSecretBackend();
      const add = createRuntime(
        ["mcp", "add", mcp.url, "--name", "protected"],
        { env: { KEEL_HOME: home } },
      );

      try {
        expect(await runCliMain(add.runtime)).toBe(0);
        const login = createRuntime(["mcp", "login", "protected"], {
          env: { KEEL_HOME: home },
          mcpSecretBackend: secrets.backend,
          openExternalUrl: mcp.openAuthorizationUrl,
        });

        // When
        const exitCode = await runCliMain(login.runtime);

        // Then
        expect(exitCode).toBe(1);
        expect(login.stdout()).toBe("");
        expect(login.stderr()).toContain(expectedError);
        expect(login.stderr()).not.toContain("attacker.example");
        expect(login.stderr()).not.toContain("keel-mcp-oauth-test-code");
        expect(mcp.tokenRequests()).toEqual([]);
        expect([...secrets.entries.values()].join("\n")).not.toContain(
          mcp.accessToken,
        );
      } finally {
        await mcp.close();
        await rm(home, { recursive: true, force: true });
      }
    },
  );

  test(`Given an authorization server returns malformed token data,
    When the user completes the browser callback,
    Then Keel normalizes the SDK boundary failure without exposing authorization values`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-mcp-malformed-token-"));
    const mcp = await startOAuthMcpServer({ tokenResponse: "malformed" });
    const secrets = createSecretBackend();
    const add = createRuntime(["mcp", "add", mcp.url, "--name", "protected"], {
      env: { KEEL_HOME: home },
    });

    try {
      expect(await runCliMain(add.runtime)).toBe(0);
      const login = createRuntime(["mcp", "login", "protected"], {
        env: { KEEL_HOME: home },
        mcpSecretBackend: secrets.backend,
        openExternalUrl: mcp.openAuthorizationUrl,
      });

      // When
      const exitCode = await runCliMain(login.runtime);

      // Then
      expect(exitCode).toBe(1);
      expect(login.stderr()).toContain("did not complete a valid OAuth flow");
      expect(login.stderr()).not.toContain("keel-mcp-oauth-test-code");
      expect(login.stderr()).not.toContain(mcp.accessToken);
    } finally {
      await mcp.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given OAuth succeeds but the authenticated MCP verification connection fails,
    When login verifies the protected catalog with the stored token,
    Then Keel reports failure instead of claiming the login is usable`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-mcp-auth-verify-failure-"));
    const mcp = await startOAuthMcpServer({
      authenticatedMcpResponse: "server-error",
    });
    const secrets = createSecretBackend();
    const add = createRuntime(["mcp", "add", mcp.url, "--name", "protected"], {
      env: { KEEL_HOME: home },
    });

    try {
      expect(await runCliMain(add.runtime)).toBe(0);
      const login = createRuntime(["mcp", "login", "protected"], {
        env: { KEEL_HOME: home },
        mcpSecretBackend: secrets.backend,
        openExternalUrl: mcp.openAuthorizationUrl,
      });

      // When
      const exitCode = await runCliMain(login.runtime);

      // Then
      expect(exitCode).toBe(1);
      expect(login.stdout()).toBe("");
      expect(login.stderr()).not.toBe("");
      expect(login.stderr()).not.toContain(mcp.accessToken);
      expect(mcp.tokenRequests()).toHaveLength(1);
    } finally {
      await mcp.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given OAuth credentials are stored while authenticated verification is pending,
    When another command disables the server,
    Then login fails and removes the credential before returning`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-mcp-auth-verify-race-"));
    const mcp = await startOAuthMcpServer({
      authenticatedMcpResponse: "pending",
    });
    const secrets = createSecretBackend();
    const add = createRuntime(["mcp", "add", mcp.url, "--name", "protected"], {
      env: { KEEL_HOME: home },
    });

    try {
      expect(await runCliMain(add.runtime)).toBe(0);
      const login = createRuntime(["mcp", "login", "protected"], {
        env: { KEEL_HOME: home },
        mcpSecretBackend: secrets.backend,
        openExternalUrl: mcp.openAuthorizationUrl,
      });
      const loginRun = runCliMain(login.runtime);
      await mcp.authenticatedMcpRequest;
      expect(secrets.entries.size).toBe(1);
      const disable = createRuntime(["mcp", "disable", "protected"], {
        env: { KEEL_HOME: home },
        mcpSecretBackend: secrets.backend,
      });

      // When
      expect(await runCliMain(disable.runtime)).toBe(0);
      mcp.releaseAuthenticatedMcpResponse();
      const exitCode = await loginRun;

      // Then
      expect(exitCode).toBe(1);
      expect(login.stderr()).not.toBe("");
      expect(secrets.entries.size).toBe(0);
    } finally {
      mcp.releaseAuthenticatedMcpResponse();
      await mcp.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given an MCP server accepts anonymous requests and never advertises an OAuth challenge,
    When the user explicitly requests login,
    Then Keel reports that no active credential was established instead of marking anonymous access as authenticated`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-mcp-no-auth-challenge-"));
    const mcp = await startOAuthMcpServer({ authentication: "optional" });
    const secrets = createSecretBackend();
    const add = createRuntime(["mcp", "add", mcp.url, "--name", "public"], {
      env: { KEEL_HOME: home },
    });

    try {
      expect(await runCliMain(add.runtime)).toBe(0);
      const login = createRuntime(["mcp", "login", "public"], {
        env: { KEEL_HOME: home },
        mcpSecretBackend: secrets.backend,
        openExternalUrl: mcp.openAuthorizationUrl,
      });

      // When
      const exitCode = await runCliMain(login.runtime);

      // Then
      expect(exitCode).toBe(1);
      expect(login.stdout()).toBe("");
      expect(login.stderr()).toContain("requires an active OAuth credential");
      expect(mcp.authorizationRequests()).toEqual([]);
      expect(mcp.tokenRequests()).toEqual([]);
    } finally {
      await mcp.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a failed login left an MCP server requiring authentication without an active credential,
    When the user checks its status,
    Then Keel reports needs-auth instead of a server failure`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-mcp-missing-auth-home-"));
    const mcp = await startOAuthMcpServer({ authentication: "optional" });
    const secrets = createSecretBackend();
    const add = createRuntime(["mcp", "add", mcp.url, "--name", "protected"], {
      env: { KEEL_HOME: home },
    });

    try {
      expect(await runCliMain(add.runtime)).toBe(0);
      const login = createRuntime(["mcp", "login", "protected"], {
        env: { KEEL_HOME: home },
        mcpSecretBackend: secrets.backend,
        openExternalUrl: mcp.openAuthorizationUrl,
      });
      expect(await runCliMain(login.runtime)).toBe(1);
      const status = createRuntime(["mcp", "status", "protected"], {
        env: { KEEL_HOME: home },
        mcpSecretBackend: secrets.backend,
      });

      // When
      const exitCode = await runCliMain(status.runtime);

      // Then
      expect(exitCode).toBe(0);
      expect(status.stderr()).toBe("");
      expect(status.stdout()).toContain("status: needs-auth\n");
      expect(status.stdout()).toContain("authorization: required\n");
      expect(status.stdout()).not.toContain("status: failed");
    } finally {
      await mcp.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given MCP login is waiting for the loopback authorization callback,
    When the CLI receives SIGINT,
    Then it aborts OAuth and closes the callback listener`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-mcp-oauth-sigint-"));
    const mcp = await startOAuthMcpServer();
    const secrets = createSecretBackend();
    const add = createRuntime(["mcp", "add", mcp.url, "--name", "protected"], {
      env: { KEEL_HOME: home },
    });
    const sigint: { handler: (() => void) | null } = { handler: null };

    try {
      expect(await runCliMain(add.runtime)).toBe(0);
      const login = createRuntime(["mcp", "login", "protected"], {
        env: { KEEL_HOME: home },
        mcpSecretBackend: secrets.backend,
        openExternalUrl: async () => {},
        onSigint: (handler) => {
          sigint.handler = handler;
        },
        offSigint: (handler) => {
          if (sigint.handler === handler) sigint.handler = null;
        },
      });

      // When
      const run = runCliMain(login.runtime);
      await vi.waitFor(() => {
        expect(sigint.handler).not.toBeNull();
      });
      const handler = sigint.handler;
      if (handler === null) {
        throw new Error("MCP login SIGINT handler was not registered");
      }
      handler();
      const exitCode = await run;

      // Then
      expect(exitCode).toBe(1);
      expect(login.stdout()).toBe("");
      expect(login.stderr()).toContain("callback was cancelled");
      expect(sigint.handler).toBeNull();
      expect(mcp.tokenRequests()).toEqual([]);
    } finally {
      await mcp.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given the OS credential backend is unavailable,
    When the user attempts MCP login,
    Then Keel fails closed before opening a browser and never creates plaintext fallback state`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-mcp-no-keyring-home-"));
    const mcp = await startOAuthMcpServer();
    const add = createRuntime(["mcp", "add", mcp.url, "--name", "protected"], {
      env: { KEEL_HOME: home },
    });
    let browserOpened = false;

    try {
      expect(await runCliMain(add.runtime)).toBe(0);
      const login = createRuntime(["mcp", "login", "protected"], {
        env: { KEEL_HOME: home },
        mcpSecretBackend: {
          getPassword: async () => {
            throw new Error("credential service unavailable");
          },
          setPassword: async () => {
            throw new Error("credential service unavailable");
          },
          deletePassword: async () => {
            throw new Error("credential service unavailable");
          },
        },
        openExternalUrl: async () => {
          browserOpened = true;
        },
      });

      // When
      const exitCode = await runCliMain(login.runtime);

      // Then
      expect(exitCode).toBe(1);
      expect(login.stderr()).toContain(
        "requires an available OS credential store",
      );
      expect(browserOpened).toBe(false);
      expect(mcp.authorizationRequests()).toEqual([]);
    } finally {
      await mcp.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given the system browser command fails with the full authorization URL,
    When MCP login handles that platform error,
    Then state and PKCE query values are not copied into diagnostics`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-mcp-browser-failure-"));
    const mcp = await startOAuthMcpServer();
    const secrets = createSecretBackend();
    const add = createRuntime(["mcp", "add", mcp.url, "--name", "protected"], {
      env: { KEEL_HOME: home },
    });

    try {
      expect(await runCliMain(add.runtime)).toBe(0);
      const login = createRuntime(["mcp", "login", "protected"], {
        env: { KEEL_HOME: home },
        mcpSecretBackend: secrets.backend,
        openExternalUrl: async (url) => {
          throw new Error(`browser failed for ${url.href}`);
        },
      });

      // When
      const exitCode = await runCliMain(login.runtime);

      // Then
      expect(exitCode).toBe(1);
      expect(login.stderr()).toContain("could not open the system browser");
      expect(login.stderr()).not.toContain("code_challenge");
      expect(login.stderr()).not.toContain("client_id");
      expect(login.stderr()).not.toContain("state=");
      expect(mcp.tokenRequests()).toEqual([]);
    } finally {
      await mcp.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a protected MCP server challenges only after initialization during tools/list,
    When the user runs explicit MCP login,
    Then Keel completes OAuth from that late challenge and verifies the protected catalog`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-mcp-late-oauth-home-"));
    const mcp = await startOAuthMcpServer({
      authChallenge: "tools-list",
    });
    const secrets = createSecretBackend();
    const add = createRuntime(["mcp", "add", mcp.url, "--name", "protected"], {
      env: { KEEL_HOME: home },
    });

    try {
      expect(await runCliMain(add.runtime)).toBe(0);
      expect(add.stdout()).toContain("status: needs-auth\n");
      const login = createRuntime(["mcp", "login", "protected"], {
        env: { KEEL_HOME: home },
        mcpSecretBackend: secrets.backend,
        openExternalUrl: mcp.openAuthorizationUrl,
      });

      // When
      const exitCode = await runCliMain(login.runtime);

      // Then
      expect(exitCode, login.stderr()).toBe(0);
      expect(login.stdout()).toBe('Logged in to MCP server "protected".\n');
      expect(mcp.authorizationRequests()).toHaveLength(1);
      expect(mcp.tokenRequests()).toHaveLength(1);
    } finally {
      await mcp.close();
      await rm(home, { recursive: true, force: true });
    }
  });
});
