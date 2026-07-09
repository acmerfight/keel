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
  test(`Given the selected real provider is missing its API key,
    When user runs the doctor command,
    Then the CLI reports setup commands without printing a secret`, async () => {
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
    expect(result.stdout).toContain("provider setup:");
    expect(result.stdout).toContain(
      "Set DEEPSEEK_API_KEY for this run, or store it:",
    );
    expect(result.stdout).toContain(
      "  printf '%s\\n' \"$DEEPSEEK_API_KEY\" | keel auth login deepseek --with-api-key",
    );
    expect(result.stdout).toContain("  keel config set-provider deepseek");
    expect(result.stdout).toContain("  keel --doctor");
    expect(result.stdout).toContain("provider auth: skipped (missing API key)");
    expect(result.stderr).toBe("");
  });

  test(`Given the selected real provider has a whitespace-only API key,
    When user runs the doctor command,
    Then the CLI reports setup commands instead of probing auth`, async () => {
    // Given
    const env = {
      KEEL_PROVIDER: "deepseek",
      DEEPSEEK_API_KEY: "   ",
    };

    // When
    const result = await runCli(["--doctor"], { env });

    // Then
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain(
      "api key: missing (expected DEEPSEEK_API_KEY)",
    );
    expect(result.stdout).toContain("provider setup:");
    expect(result.stdout).toContain(
      "Set DEEPSEEK_API_KEY for this run, or store it:",
    );
    expect(result.stdout).toContain(
      "  printf '%s\\n' \"$DEEPSEEK_API_KEY\" | keel auth login deepseek --with-api-key",
    );
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
});
