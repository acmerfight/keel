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
});
