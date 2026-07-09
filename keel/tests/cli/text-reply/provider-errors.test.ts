import { describe, expect, test } from "vitest";
import { runCli } from "./fixtures.ts";

describe("CLI Text Reply", () => {
  test(`Given no provider API key and no demo provider,
    When user runs the CLI,
    Then the CLI exits with an error message`, async () => {
    // Given — no DEEPSEEK_API_KEY, no KEEL_PROVIDER=fake
    const env = {
      KEEL_PROVIDER: "deepseek",
      DEEPSEEK_API_KEY: "",
    };

    // When
    const result = await runCli(["hello"], env);

    // Then
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/api key/i);
  });

  test(`Given Kimi is configured without an API key,
    When user runs the CLI,
    Then the CLI exits with Kimi setup guidance`, async () => {
    // Given
    const env = {
      KEEL_PROVIDER: "kimi",
      KIMI_API_KEY: "",
    };

    // When
    const result = await runCli(["hello"], env);

    // Then
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Error: missing API key for kimi.");
    expect(result.stderr).toContain(
      "Set KIMI_API_KEY for this run, or store it:",
    );
    expect(result.stderr).toContain(
      "  printf '%s\\n' \"$KIMI_API_KEY\" | keel auth login kimi --with-api-key",
    );
    expect(result.stderr).toContain("  keel config set-provider kimi");
    expect(result.stderr).toContain("  keel --doctor");
  });

  test(`Given Qwen is configured without an API key,
    When user runs the CLI,
    Then the CLI exits with Qwen setup guidance`, async () => {
    // Given
    const env = {
      KEEL_PROVIDER: "qwen",
      DASHSCOPE_API_KEY: "",
    };

    // When
    const result = await runCli(["hello"], env);

    // Then
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Error: missing API key for qwen.");
    expect(result.stderr).toContain(
      "Set DASHSCOPE_API_KEY or QWEN_API_KEY for this run, or store it:",
    );
    expect(result.stderr).toContain(
      `  printf '%s\\n' "\${DASHSCOPE_API_KEY:-$QWEN_API_KEY}" | keel auth login qwen --with-api-key`,
    );
    expect(result.stderr).toContain("  keel config set-provider qwen");
    expect(result.stderr).toContain("  keel --doctor");
    expect(result.stderr).toContain(
      "Qwen default endpoint is https://dashscope-intl.aliyuncs.com/compatible-mode/v1; set QWEN_BASE_URL if your key belongs to China region or a workspace-scoped DashScope endpoint.",
    );
  });

  test(`Given Kimi is configured with an unsupported cost model,
    When user runs the CLI with a max cost,
    Then the CLI rejects cost tracking before contacting the provider`, async () => {
    // Given
    const env = {
      KEEL_PROVIDER: "kimi",
      KIMI_API_KEY: "test-key",
      KIMI_MODEL: "kimi-k2.5",
    };

    // When
    const result = await runCli(["--max-cost", "1", "hello"], env);

    // Then
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      'Error: cost tracking is only supported for Kimi model "kimi-k2.6"; configured KIMI_MODEL="kimi-k2.5".\n',
    );
  });

  test(`Given Qwen is configured with an unknown cost model,
    When user runs the CLI with a max cost,
    Then the CLI rejects cost tracking before contacting the provider`, async () => {
    // Given
    const env = {
      KEEL_PROVIDER: "qwen",
      DASHSCOPE_API_KEY: "test-key",
      QWEN_MODEL: "qwen-unknown",
    };

    // When
    const result = await runCli(["--max-cost", "1", "hello"], env);

    // Then
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      'Error: cost tracking is only supported for known Qwen model pricing; configured QWEN_MODEL="qwen-unknown".\n',
    );
  });

  test(`Given an unknown provider is configured,
    When user runs the CLI,
    Then the CLI exits with a provider configuration error`, async () => {
    // Given
    const env = { KEEL_PROVIDER: "unknown" };

    // When
    const result = await runCli(["hello"], env);

    // Then
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toBe('Error: unknown provider "unknown"\n');
  });
});
