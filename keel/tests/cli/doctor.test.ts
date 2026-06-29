import { createServer } from "node:http";
import type { Server } from "node:net";
import { describe, expect, test, vi } from "vitest";
import {
  capabilityNames,
  readProviderModelsDiagnostic,
  runDoctor,
} from "../../src/cli/doctor.ts";
import { runCli } from "../../src/testing/cli-harness.ts";

type ExecFileCallback = (
  error: Error | null,
  stdout: string,
  stderr: string,
) => void;

async function withMockedExecFile<T>(
  execFile: (callback: ExecFileCallback) => void,
  action: (doctor: typeof import("../../src/cli/doctor.ts")) => Promise<T>,
): Promise<T> {
  vi.resetModules();
  vi.doMock("node:child_process", () => ({
    execFile: vi.fn(
      (
        _path: string,
        _args: readonly string[],
        _options: unknown,
        callback: ExecFileCallback,
      ) => {
        execFile(callback);
        return { kill: vi.fn() };
      },
    ),
  }));

  try {
    const doctor = await import("../../src/cli/doctor.ts");
    return await action(doctor);
  } finally {
    vi.doUnmock("node:child_process");
    vi.resetModules();
  }
}

function expectRipgrepDiagnostics(stdout: string): void {
  expect(stdout).toContain("Keel doctor\n");
  expect(stdout).toContain("ripgrep: ok (vscode-ripgrep)");
  expect(stdout).toContain("ripgrep path:");
  expect(stdout).toMatch(/^ripgrep version: ripgrep\s+\S+/m);
}

function runtimeWithEnv(env: Record<string, string>) {
  return {
    env: (key: string) => env[key],
  };
}

async function readOkRipgrepDiagnostic() {
  return {
    provider: "vscode-ripgrep",
    path: "/test/rg",
    version: "ripgrep 1.0.0",
  };
}

function getPort(server: Server): number {
  const addr = server.address();
  if (addr === null || typeof addr === "string") {
    throw new Error("Server not listening on a TCP port");
  }
  return addr.port;
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error !== undefined) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

describe("CLI Doctor", () => {
  test(`Given model metadata has no advertised capabilities,
    When doctor formats the capability list,
    Then it reports none`, () => {
    // Given / When
    const formatted = capabilityNames({
      textInput: false,
      toolCalls: false,
      reasoning: false,
    });

    // Then
    expect(formatted).toBe("none");
  });

  test(`Given Qwen is selected by doctor flags,
    When user runs the offline doctor command,
    Then the CLI rejects credentials and query text before calling the provider`, async () => {
    // Given
    const apiKeySecret = "test-api-key-secret-that-must-not-print";
    const baseUrlSecret = "test-base-url-secret-that-must-not-print";
    const env = {
      KEEL_PROVIDER: "fake",
      DASHSCOPE_API_KEY: apiKeySecret,
      QWEN_BASE_URL: `https://user:${baseUrlSecret}@example.test/v1?api_key=${baseUrlSecret}#${baseUrlSecret}`,
      KEEL_CONTEXT_WINDOW_TOKENS: "8192",
    };

    // When
    const result = await runCli(
      [
        "--doctor",
        "--offline",
        "--provider",
        "qwen",
        "--model",
        "qwen3.7-plus",
      ],
      { env },
    );

    // Then
    expect(result.exitCode).toBe(1);
    expectRipgrepDiagnostics(result.stdout);
    expect(result.stdout).toContain("provider: qwen (source: --provider)");
    expect(result.stdout).toContain("model: qwen3.7-plus (source: --model)");
    expect(result.stdout).toContain("api key: present (DASHSCOPE_API_KEY)");
    expect(result.stdout).toContain(
      "base url: https://example.test/v1 (source: QWEN_BASE_URL)",
    );
    expect(result.stdout).toContain(
      "context window: 8192 tokens (source: KEEL_CONTEXT_WINDOW_TOKENS)",
    );
    expect(result.stdout).toContain("cost model: known");
    expect(result.stdout).toContain(
      "error: base URL must not include credentials, query, or fragment",
    );
    expect(result.stdout).toContain(
      "provider auth: skipped (local provider diagnostics failed)",
    );
    expect(result.stdout).not.toContain(apiKeySecret);
    expect(result.stdout).not.toContain(baseUrlSecret);
    expect(result.stdout).not.toContain("user:");
    expect(result.stdout).not.toContain("api_key=");
    expect(result.stderr).toBe("");
  });

  test(`Given DeepSeek has an API key and reachable base URL,
    When user runs the doctor command,
    Then the CLI validates provider auth online without printing the secret`, async () => {
    // Given
    const apiKeySecret = "test-deepseek-secret-that-must-not-print";
    const capturedRequests: {
      readonly method: string | undefined;
      readonly url: string | undefined;
      readonly authorization: string | undefined;
      readonly accept: string | undefined;
    }[] = [];
    const server = createServer((req, res) => {
      capturedRequests.push({
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization,
        accept: req.headers.accept,
      });
      if (req.method !== "GET" || req.url !== "/models") {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [] }));
    });
    await listen(server);

    try {
      const result = await runCli(["--doctor", "--provider", "deepseek"], {
        env: {
          DEEPSEEK_API_KEY: apiKeySecret,
          DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
        },
      });

      // Then
      expect(result.exitCode).toBe(0);
      expectRipgrepDiagnostics(result.stdout);
      expect(result.stdout).toContain(
        "provider: deepseek (source: --provider)",
      );
      expect(result.stdout).toContain("api key: present (DEEPSEEK_API_KEY)");
      expect(result.stdout).toContain("provider auth: ok (GET /models)");
      expect(result.stdout).not.toContain(apiKeySecret);
      expect(result.stderr).toBe("");
      expect(capturedRequests).toEqual([
        {
          method: "GET",
          url: "/models",
          authorization: `Bearer ${apiKeySecret}`,
          accept: "application/json",
        },
      ]);
    } finally {
      await close(server);
    }
  });

  test(`Given the selected provider rejects the API key,
    When user runs the doctor command,
    Then the CLI reports the auth failure before a run starts`, async () => {
    // Given
    const upstreamStatusSecret = "upstream-status-secret";
    const server = createServer((_req, res) => {
      res.statusMessage = upstreamStatusSecret;
      res.writeHead(401);
      res.end(JSON.stringify({ error: "invalid key" }));
    });
    await listen(server);

    try {
      // When
      const result = await runCli(["--doctor", "--provider", "deepseek"], {
        env: {
          DEEPSEEK_API_KEY: "test-bad-key",
          DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
        },
      });

      // Then
      expect(result.exitCode).toBe(1);
      expectRipgrepDiagnostics(result.stdout);
      expect(result.stdout).toContain(
        "provider: deepseek (source: --provider)",
      );
      expect(result.stdout).toContain("provider auth: failed (HTTP 401)");
      expect(result.stdout).not.toContain(upstreamStatusSecret);
      expect(result.stderr).toBe("");
    } finally {
      await close(server);
    }
  });

  test(`Given the selected provider has an invalid base URL,
    When user runs the online doctor command,
    Then the CLI reports the local provider config failure without printing URL secrets`, async () => {
    // Given
    const baseUrlSecret = "doctor-url-secret";

    // When
    const result = await runCli(["--doctor", "--provider", "deepseek"], {
      env: {
        DEEPSEEK_API_KEY: "test-key",
        DEEPSEEK_BASE_URL: `not a url with ${baseUrlSecret}`,
      },
    });

    // Then
    expect(result.exitCode).toBe(1);
    expectRipgrepDiagnostics(result.stdout);
    expect(result.stdout).toContain("provider: deepseek (source: --provider)");
    expect(result.stdout).toContain(
      "base url: <unparseable URL> (source: DEEPSEEK_BASE_URL)",
    );
    expect(result.stdout).toContain("error: invalid base URL");
    expect(result.stdout).toContain(
      "provider auth: skipped (local provider diagnostics failed)",
    );
    expect(result.stdout).not.toContain(baseUrlSecret);
    expect(result.stderr).toBe("");
  });

  test(`Given the selected provider base URL includes credentials or query text,
    When user runs the online doctor command,
    Then the CLI reports the local provider config failure without printing URL secrets`, async () => {
    // Given
    const userSecret = "doctor-user-secret";
    const querySecret = "doctor-query-secret";

    // When
    const result = await runCli(["--doctor", "--provider", "deepseek"], {
      env: {
        DEEPSEEK_API_KEY: "test-key",
        DEEPSEEK_BASE_URL: `https://user:${userSecret}@example.test/v1?api_key=${querySecret}#${querySecret}`,
      },
    });

    // Then
    expect(result.exitCode).toBe(1);
    expectRipgrepDiagnostics(result.stdout);
    expect(result.stdout).toContain("provider: deepseek (source: --provider)");
    expect(result.stdout).toContain(
      "base url: https://example.test/v1 (source: DEEPSEEK_BASE_URL)",
    );
    expect(result.stdout).toContain(
      "error: base URL must not include credentials, query, or fragment",
    );
    expect(result.stdout).toContain(
      "provider auth: skipped (local provider diagnostics failed)",
    );
    expect(result.stdout).not.toContain(userSecret);
    expect(result.stdout).not.toContain(querySecret);
    expect(result.stderr).toBe("");
  });

  test(`Given offline doctor receives a provider base URL with an unsupported scheme,
    When user runs the doctor command,
    Then the CLI rejects the local provider config before reporting readiness`, async () => {
    // Given
    const env = {
      DEEPSEEK_API_KEY: "test-key",
      DEEPSEEK_BASE_URL: "ftp://example.test/v1",
    };

    // When
    const result = await runCli(
      ["--doctor", "--offline", "--provider", "deepseek"],
      {
        env,
      },
    );

    // Then
    expect(result.exitCode).toBe(1);
    expectRipgrepDiagnostics(result.stdout);
    expect(result.stdout).toContain("provider: deepseek (source: --provider)");
    expect(result.stdout).toContain(
      "base url: ftp://example.test/v1 (source: DEEPSEEK_BASE_URL)",
    );
    expect(result.stdout).toContain("error: base URL must use http or https");
    expect(result.stdout).toContain(
      "provider auth: skipped (local provider diagnostics failed)",
    );
    expect(result.stderr).toBe("");
  });

  test(`Given the selected provider cannot be reached,
    When user runs the online doctor command,
    Then the CLI reports a provider auth network failure`, async () => {
    // Given
    const server = createServer((req) => {
      req.socket.destroy();
    });
    await listen(server);

    try {
      // When
      const result = await runCli(["--doctor", "--provider", "deepseek"], {
        env: {
          DEEPSEEK_API_KEY: "test-key",
          DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
        },
      });

      // Then
      expect(result.exitCode).toBe(1);
      expectRipgrepDiagnostics(result.stdout);
      expect(result.stdout).toContain(
        "provider auth: failed (network request failed)",
      );
      expect(result.stderr).toBe("");
    } finally {
      await close(server);
    }
  });

  test(`Given the selected provider returns a non-models response,
    When user runs the online doctor command,
    Then the CLI reports the invalid provider auth response`, async () => {
    // Given
    const server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ object: "not-a-model-list" }));
    });
    await listen(server);

    try {
      // When
      const result = await runCli(["--doctor", "--provider", "deepseek"], {
        env: {
          DEEPSEEK_API_KEY: "test-key",
          DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
        },
      });

      // Then
      expect(result.exitCode).toBe(1);
      expectRipgrepDiagnostics(result.stdout);
      expect(result.stdout).toContain(
        "provider auth: failed (invalid /models response)",
      );
      expect(result.stderr).toBe("");
    } finally {
      await close(server);
    }
  });

  test(`Given doctor runs offline for a real provider,
    When provider config is locally valid,
    Then provider auth is skipped without calling the network diagnostic`, async () => {
    // Given / When
    const result = await runDoctor({
      runtime: runtimeWithEnv({
        DEEPSEEK_API_KEY: "test-key",
        DEEPSEEK_BASE_URL: "https://api.deepseek.com",
      }),
      selection: { providerId: "deepseek" },
      onlineMode: "offline",
      readProviderOnlineDiagnostic: async () => {
        throw new Error("provider auth should not run in offline mode");
      },
      readRipgrepDiagnostic: readOkRipgrepDiagnostic,
    });

    // Then
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("provider: deepseek (source: --provider)");
    expect(result.stdout).toContain("provider auth: skipped (--offline)");
    expect(result.stderr).toBe("");
  });

  test(`Given doctor receives a failed online auth diagnostic,
    When provider config is locally valid,
    Then doctor exits nonzero with the auth failure`, async () => {
    // Given / When
    const result = await runDoctor({
      runtime: runtimeWithEnv({
        DEEPSEEK_API_KEY: "test-key",
        DEEPSEEK_BASE_URL: "https://api.deepseek.com",
      }),
      selection: { providerId: "deepseek" },
      onlineMode: "online",
      readProviderOnlineDiagnostic: async (request) => {
        expect(request).toEqual({
          baseUrl: "https://api.deepseek.com",
          apiKey: "test-key",
        });
        return { status: "failed", message: "HTTP 401" };
      },
      readRipgrepDiagnostic: readOkRipgrepDiagnostic,
    });

    // Then
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("provider auth: failed (HTTP 401)");
    expect(result.stderr).toBe("");
  });

  test(`Given doctor receives a successful online auth diagnostic,
    When provider config is locally valid,
    Then doctor reports provider auth ok`, async () => {
    // Given / When
    const result = await runDoctor({
      runtime: runtimeWithEnv({
        DEEPSEEK_API_KEY: "test-key",
        DEEPSEEK_BASE_URL: "https://api.deepseek.com",
      }),
      selection: { providerId: "deepseek" },
      onlineMode: "online",
      readProviderOnlineDiagnostic: async () => ({
        status: "ok",
        method: "GET",
        path: "/models",
      }),
      readRipgrepDiagnostic: readOkRipgrepDiagnostic,
    });

    // Then
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("provider auth: ok (GET /models)");
    expect(result.stderr).toBe("");
  });

  test(`Given the API key source changes after local diagnostics,
    When doctor reads provider config and then prepares auth,
    Then provider auth fails with a coherent changed-key diagnostic`, async () => {
    // Given
    let apiKeyReads = 0;
    const runtime = {
      env: (key: string) => {
        if (key === "DEEPSEEK_API_KEY") {
          apiKeyReads++;
          return apiKeyReads === 1 ? "test-key" : "";
        }
        if (key === "DEEPSEEK_BASE_URL") {
          return "https://api.deepseek.com";
        }
        return undefined;
      },
    };

    // When
    const result = await runDoctor({
      runtime,
      selection: { providerId: "deepseek" },
      onlineMode: "online",
      readProviderOnlineDiagnostic: async () => {
        throw new Error("provider auth should not run without a stable key");
      },
      readRipgrepDiagnostic: readOkRipgrepDiagnostic,
    });

    // Then
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("api key: present (DEEPSEEK_API_KEY)");
    expect(result.stdout).toContain(
      "provider auth: failed (API key changed before auth probe)",
    );
    expect(result.stderr).toBe("");
  });

  test(`Given doctor has invalid local provider diagnostics,
    When online mode is enabled,
    Then provider auth is skipped before the network diagnostic`, async () => {
    // Given / When
    const result = await runDoctor({
      runtime: runtimeWithEnv({
        KEEL_CONTEXT_WINDOW_TOKENS: "12px",
      }),
      selection: { providerId: "fake" },
      onlineMode: "online",
      readProviderOnlineDiagnostic: async () => {
        throw new Error("provider auth should not run after local errors");
      },
      readRipgrepDiagnostic: readOkRipgrepDiagnostic,
    });

    // Then
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain(
      "provider auth: skipped (local provider diagnostics failed)",
    );
    expect(result.stderr).toBe("");
  });

  test(`Given a models endpoint accepts the auth probe,
    When provider online diagnostics run,
    Then it sends bearer GET requests for base URLs with or without a trailing slash`, async () => {
    // Given
    const capturedRequests: {
      readonly method: string | undefined;
      readonly url: string | undefined;
      readonly authorization: string | undefined;
      readonly accept: string | undefined;
    }[] = [];
    const server = createServer((req, res) => {
      capturedRequests.push({
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization,
        accept: req.headers.accept,
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [] }));
    });
    await listen(server);

    try {
      // When
      const result = await readProviderModelsDiagnostic({
        baseUrl: `http://127.0.0.1:${getPort(server)}/v1/`,
        apiKey: "test-key",
      });
      const resultWithoutTrailingSlash = await readProviderModelsDiagnostic({
        baseUrl: `http://127.0.0.1:${getPort(server)}/v1`,
        apiKey: "test-key",
      });

      // Then
      expect(result).toEqual({ status: "ok", method: "GET", path: "/models" });
      expect(resultWithoutTrailingSlash).toEqual({
        status: "ok",
        method: "GET",
        path: "/models",
      });
      expect(capturedRequests).toEqual([
        {
          method: "GET",
          url: "/v1/models",
          authorization: "Bearer test-key",
          accept: "application/json",
        },
        {
          method: "GET",
          url: "/v1/models",
          authorization: "Bearer test-key",
          accept: "application/json",
        },
      ]);
    } finally {
      await close(server);
    }
  });

  test(`Given a models endpoint returns an HTTP failure with server text,
    When provider online diagnostics run,
    Then it reports only the status code`, async () => {
    // Given
    const upstreamStatusSecret = "upstream-status-secret";
    const server = createServer((_req, res) => {
      res.statusMessage = upstreamStatusSecret;
      res.writeHead(403);
      res.end();
    });
    await listen(server);

    try {
      // When
      const result = await readProviderModelsDiagnostic({
        baseUrl: `http://127.0.0.1:${getPort(server)}`,
        apiKey: "test-key",
      });

      // Then
      expect(result).toEqual({ status: "failed", message: "HTTP 403" });
      expect(JSON.stringify(result)).not.toContain(upstreamStatusSecret);
    } finally {
      await close(server);
    }
  });

  test(`Given provider online diagnostics receive unsupported base URL text,
    When the models probe is prepared,
    Then it fails without echoing the URL text`, async () => {
    // Given / When / Then
    await expect(
      readProviderModelsDiagnostic({
        baseUrl: "not a url with secret-token",
        apiKey: "test-key",
      }),
    ).resolves.toEqual({ status: "failed", message: "invalid base URL" });
  });

  test(`Given provider online diagnostics receive URL credentials or query text,
    When the models probe is prepared,
    Then it fails without echoing the secret-bearing URL parts`, async () => {
    // Given / When
    const result = await readProviderModelsDiagnostic({
      baseUrl:
        "https://user:password-secret@example.test/v1?api_key=query-secret#fragment-secret",
      apiKey: "test-key",
    });

    // Then
    expect(result).toEqual({
      status: "failed",
      message: "base URL must not include credentials, query, or fragment",
    });
    expect(JSON.stringify(result)).not.toContain("password-secret");
    expect(JSON.stringify(result)).not.toContain("query-secret");
    expect(JSON.stringify(result)).not.toContain("fragment-secret");
  });

  test(`Given the models endpoint closes the connection,
    When provider online diagnostics run,
    Then it reports a network request failure`, async () => {
    // Given
    const server = createServer((req) => {
      req.socket.destroy();
    });
    await listen(server);

    try {
      // When
      const result = await readProviderModelsDiagnostic({
        baseUrl: `http://127.0.0.1:${getPort(server)}`,
        apiKey: "test-key",
      });

      // Then
      expect(result).toEqual({
        status: "failed",
        message: "network request failed",
      });
    } finally {
      await close(server);
    }
  });

  test(`Given the models endpoint returns invalid JSON,
    When provider online diagnostics run,
    Then it reports an invalid models response`, async () => {
    // Given
    const server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("not json");
    });
    await listen(server);

    try {
      // When
      const result = await readProviderModelsDiagnostic({
        baseUrl: `http://127.0.0.1:${getPort(server)}`,
        apiKey: "test-key",
      });

      // Then
      expect(result).toEqual({
        status: "failed",
        message: "invalid /models response",
      });
    } finally {
      await close(server);
    }
  });

  test(`Given the models endpoint returns a non-list JSON shape,
    When provider online diagnostics run,
    Then it reports an invalid models response`, async () => {
    // Given
    const server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ object: "not-a-model-list" }));
    });
    await listen(server);

    try {
      // When
      const result = await readProviderModelsDiagnostic({
        baseUrl: `http://127.0.0.1:${getPort(server)}`,
        apiKey: "test-key",
      });

      // Then
      expect(result).toEqual({
        status: "failed",
        message: "invalid /models response",
      });
    } finally {
      await close(server);
    }
  });

  test(`Given the selected real provider is missing its API key,
    When user runs the doctor command,
    Then the CLI reports the missing env var without printing a secret`, async () => {
    // Given
    const env = {
      KEEL_PROVIDER: "deepseek",
      DEEPSEEK_API_KEY: "",
    };

    // When
    const result = await runCli(["--doctor"], { env });

    // Then
    expect(result.exitCode).toBe(1);
    expectRipgrepDiagnostics(result.stdout);
    expect(result.stdout).toContain(
      "provider: deepseek (source: KEEL_PROVIDER)",
    );
    expect(result.stdout).toContain(
      "model: deepseek-v4-flash (source: default)",
    );
    expect(result.stdout).toContain(
      "api key: missing (expected DEEPSEEK_API_KEY)",
    );
    expect(result.stdout).toContain(
      "base url: https://api.deepseek.com (source: default)",
    );
    expect(result.stdout).toContain(
      "context window: 1000000 tokens (source: registry)",
    );
    expect(result.stdout).toContain("model metadata: registry");
    expect(result.stdout).toContain("max output: 384000 tokens");
    expect(result.stdout).toContain(
      "model capabilities: text-input, tool-calls, reasoning",
    );
    expect(result.stdout).toContain("cost model: known");
    expect(result.stdout).toContain("provider auth: skipped (missing API key)");
    expect(result.stderr).toBe("");
  });

  test(`Given the fake provider is selected,
    When user runs the doctor command,
    Then the CLI reports that no provider secret is required`, async () => {
    // Given
    const args: readonly string[] = ["--doctor", "--provider=fake"];

    // When
    const result = await runCli(args);

    // Then
    expect(result.exitCode).toBe(0);
    expectRipgrepDiagnostics(result.stdout);
    expect(result.stdout).toContain("provider: fake (source: --provider)");
    expect(result.stdout).toContain("model: fake (source: default)");
    expect(result.stdout).toContain("api key: not required");
    expect(result.stdout).toContain("base url: none");
    expect(result.stdout).toContain("context window: disabled");
    expect(result.stdout).toContain("cost model: known");
    expect(result.stdout).toContain("provider auth: skipped (not required)");
    expect(result.stderr).toBe("");
  });

  test(`Given Kimi is configured with an unknown priced model,
    When user runs the doctor command,
    Then the CLI warns that cost tracking is unavailable without failing provider readiness`, async () => {
    // Given
    const server = createServer((req, res) => {
      if (req.method !== "GET" || req.url !== "/v1/models") {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [] }));
    });
    await listen(server);
    const env = {
      KEEL_PROVIDER: "kimi",
      KIMI_API_KEY: "test-kimi-secret",
      KIMI_MODEL: "kimi-next",
      KIMI_BASE_URL: `http://127.0.0.1:${getPort(server)}/v1`,
    };

    try {
      // When
      const result = await runCli(["--doctor"], { env });

      // Then
      expect(result.exitCode).toBe(0);
      expectRipgrepDiagnostics(result.stdout);
      expect(result.stdout).toContain("provider: kimi (source: KEEL_PROVIDER)");
      expect(result.stdout).toContain("model: kimi-next (source: KIMI_MODEL)");
      expect(result.stdout).toContain("api key: present (KIMI_API_KEY)");
      expect(result.stdout).toContain(
        `base url: http://127.0.0.1:${getPort(server)}/v1 (source: KIMI_BASE_URL)`,
      );
      expect(result.stdout).toContain("cost model: unknown");
      expect(result.stdout).toContain(
        "warning: cost tracking is unavailable for model kimi-next",
      );
      expect(result.stdout).toContain("provider auth: ok (GET /models)");
      expect(result.stdout).not.toContain("test-kimi-secret");
      expect(result.stderr).toBe("");
    } finally {
      await close(server);
    }
  });

  test(`Given the context window env is invalid,
    When user runs the doctor command,
    Then the CLI reports the invalid provider setting before a run starts`, async () => {
    // Given
    const env = {
      KEEL_CONTEXT_WINDOW_TOKENS: "12px",
    };

    // When
    const result = await runCli(["--doctor", "--provider=fake"], { env });

    // Then
    expect(result.exitCode).toBe(1);
    expectRipgrepDiagnostics(result.stdout);
    expect(result.stdout).toContain("provider: fake (source: --provider)");
    expect(result.stdout).toContain(
      "context window: invalid (source: KEEL_CONTEXT_WINDOW_TOKENS)",
    );
    expect(result.stdout).toContain(
      "error: KEEL_CONTEXT_WINDOW_TOKENS must be a positive integer",
    );
    expect(result.stdout).toContain(
      "provider auth: skipped (local provider diagnostics failed)",
    );
    expect(result.stderr).toBe("");
  });

  test(`Given an invalid provider flag is passed to doctor,
    When user runs the doctor command,
    Then the CLI exits with the provider option validation error`, async () => {
    // Given
    const args: readonly string[] = ["--doctor", "--provider", "anthropic"];

    // When
    const result = await runCli(args);

    // Then
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "Error: --provider must be one of: fake, deepseek, kimi, qwen.\n",
    );
  });

  test(`Given bundled ripgrep diagnostics fail,
    When doctor runs,
    Then it reports the ripgrep failure and still reports provider diagnostics`, async () => {
    // Given
    const runtime = {
      env: () => undefined,
    };

    // When
    const result = await runDoctor({
      runtime,
      selection: { providerId: "fake" },
      onlineMode: "online",
      readProviderOnlineDiagnostic: async () => {
        throw new Error("provider auth should not run for fake");
      },
      readRipgrepDiagnostic: async () => {
        throw "ripgrep exploded";
      },
    });

    // Then
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("Keel doctor\n");
    expect(result.stdout).toContain("provider: fake (source: --provider)");
    expect(result.stderr).toBe("ripgrep: failed: ripgrep exploded\n");
  });

  test(`Given bundled ripgrep diagnostics fail with an Error,
    When doctor runs,
    Then it reports the error message and still reports provider diagnostics`, async () => {
    // Given
    const runtime = {
      env: () => undefined,
    };

    // When
    const result = await runDoctor({
      runtime,
      selection: { providerId: "fake" },
      onlineMode: "online",
      readProviderOnlineDiagnostic: async () => {
        throw new Error("provider auth should not run for fake");
      },
      readRipgrepDiagnostic: async () => {
        throw new Error("ripgrep missing");
      },
    });

    // Then
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("Keel doctor\n");
    expect(result.stdout).toContain("provider: fake (source: --provider)");
    expect(result.stderr).toBe("ripgrep: failed: ripgrep missing\n");
  });

  test(`Given provider diagnostics fail with a non-Error value,
    When doctor runs,
    Then it reports the provider failure text`, async () => {
    // Given
    const runtime = {
      env: () => {
        throw "provider env unavailable";
      },
    };

    // When
    const result = await runDoctor({
      runtime,
      onlineMode: "online",
      readProviderOnlineDiagnostic: async () => {
        throw new Error("provider auth should not run after config failure");
      },
      readRipgrepDiagnostic: async () => ({
        provider: "vscode-ripgrep",
        path: "/test/rg",
        version: "ripgrep 1.0.0",
      }),
    });

    // Then
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("ripgrep: ok (vscode-ripgrep)");
    expect(result.stdout).toContain("provider: failed");
    expect(result.stderr).toBe("provider env unavailable\n");
  });

  test(`Given the bundled ripgrep version command fails with stderr,
    When doctor reads the bundled ripgrep diagnostic,
    Then it reports the stderr detail as the tool failure`, async () => {
    // Given / When / Then
    await withMockedExecFile(
      (callback) => {
        callback(new Error("spawn failed"), "", "permission denied\n");
      },
      async ({ readBundledRipgrepDiagnostic }) => {
        await expect(readBundledRipgrepDiagnostic()).rejects.toMatchObject({
          name: "KeelError",
          code: "tool_unavailable",
          message:
            "grep failed: bundled ripgrep version check failed: permission denied",
        });
      },
    );
  });

  test(`Given the bundled ripgrep version command fails without stderr,
    When doctor reads the bundled ripgrep diagnostic,
    Then it reports the process error as the tool failure`, async () => {
    // Given / When / Then
    await withMockedExecFile(
      (callback) => {
        callback(new Error("spawn ENOENT"), "", "");
      },
      async ({ readBundledRipgrepDiagnostic }) => {
        await expect(readBundledRipgrepDiagnostic()).rejects.toMatchObject({
          name: "KeelError",
          code: "tool_unavailable",
          message:
            "grep failed: bundled ripgrep version check failed: spawn ENOENT",
        });
      },
    );
  });

  test(`Given the bundled ripgrep version command returns invalid stdout,
    When doctor reads the bundled ripgrep diagnostic,
    Then it reports the invalid version output as a tool failure`, async () => {
    // Given / When / Then
    await withMockedExecFile(
      (callback) => {
        callback(null, "not ripgrep\n", "");
      },
      async ({ readBundledRipgrepDiagnostic }) => {
        await expect(readBundledRipgrepDiagnostic()).rejects.toMatchObject({
          name: "KeelError",
          code: "tool_unavailable",
          message:
            "grep failed: bundled ripgrep returned invalid version output",
        });
      },
    );
  });
});
