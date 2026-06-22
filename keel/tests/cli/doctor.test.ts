import { describe, expect, test } from "vitest";
import { runDoctor } from "../../src/cli/doctor.ts";
import { runCli } from "../../src/testing/cli-harness.ts";

function expectRipgrepDiagnostics(stdout: string): void {
  expect(stdout).toContain("Keel doctor\n");
  expect(stdout).toContain("ripgrep: ok (vscode-ripgrep)");
  expect(stdout).toContain("ripgrep path:");
  expect(stdout).toMatch(/^ripgrep version: ripgrep\s+\S+/m);
}

describe("CLI Doctor", () => {
  test(`Given Qwen is selected by doctor flags,
    When user runs the doctor command,
    Then the CLI reports the selected provider config without calling the provider`, async () => {
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
      ["--doctor", "--provider", "qwen", "--model", "qwen3.7-plus"],
      { env },
    );

    // Then
    expect(result.exitCode).toBe(0);
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
    expect(result.stdout).not.toContain(apiKeySecret);
    expect(result.stdout).not.toContain(baseUrlSecret);
    expect(result.stdout).not.toContain("user:");
    expect(result.stdout).not.toContain("api_key=");
    expect(result.stderr).toBe("");
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
      "context window: 256000 tokens (source: default)",
    );
    expect(result.stdout).toContain("cost model: known");
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
    expect(result.stderr).toBe("");
  });

  test(`Given Kimi is configured with an unknown priced model,
    When user runs the doctor command,
    Then the CLI warns that cost tracking is unavailable without failing provider readiness`, async () => {
    // Given
    const env = {
      KEEL_PROVIDER: "kimi",
      KIMI_API_KEY: "test-kimi-secret",
      KIMI_MODEL: "kimi-next",
      KIMI_BASE_URL: "http://127.0.0.1:9",
    };

    // When
    const result = await runCli(["--doctor"], { env });

    // Then
    expect(result.exitCode).toBe(0);
    expectRipgrepDiagnostics(result.stdout);
    expect(result.stdout).toContain("provider: kimi (source: KEEL_PROVIDER)");
    expect(result.stdout).toContain("model: kimi-next (source: KIMI_MODEL)");
    expect(result.stdout).toContain("api key: present (KIMI_API_KEY)");
    expect(result.stdout).toContain(
      "base url: http://127.0.0.1:9 (source: KIMI_BASE_URL)",
    );
    expect(result.stdout).toContain("cost model: unknown");
    expect(result.stdout).toContain(
      "warning: cost tracking is unavailable for model kimi-next",
    );
    expect(result.stdout).not.toContain("test-kimi-secret");
    expect(result.stderr).toBe("");
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
});
