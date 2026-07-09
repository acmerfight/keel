import { describe, expect, test } from "vitest";
import {
  close,
  createServer,
  expectRipgrepDiagnostics,
  getPort,
  listen,
  runCli,
} from "./fixtures.ts";

describe("CLI Doctor", () => {
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
});
