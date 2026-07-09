import { describe, expect, test } from "vitest";
import { capabilityNames } from "../../../src/cli/doctor.ts";
import {
  close,
  createServer,
  getPort,
  KeelError,
  listen,
  readOkRipgrepDiagnostic,
  readProviderModelsDiagnostic,
  runDoctor,
  runtimeWithEnv,
} from "./fixtures.ts";

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

  test(`Given bundled ripgrep diagnostics fail with version-check detail,
    When doctor runs,
    Then the user-visible doctor report includes the sanitized ripgrep failure`, async () => {
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
        throw new KeelError(
          "tool_unavailable",
          "grep failed: bundled ripgrep version check failed: permission denied",
        );
      },
    });

    // Then
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("Keel doctor\n");
    expect(result.stdout).toContain("provider: fake (source: --provider)");
    expect(result.stderr).toBe(
      "ripgrep: failed: grep failed: bundled ripgrep version check failed: permission denied\n",
    );
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
});
