import { describe, expect, test } from "vitest";
import { runCliMain } from "../../../src/cli/index.ts";
import { createRuntime } from "../../../src/testing/cli-runtime-fixtures.ts";

describe("CLI Main - Doctor Command", () => {
  test(`Given the user asks for diagnostics,
    When the CLI main dispatches the doctor command,
    Then it returns the diagnostic result`, async () => {
    // Given
    const fixture = createRuntime(["--doctor", "--provider=fake"]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(0);
    expect(fixture.stdout()).toContain("Keel doctor");
    expect(fixture.stdout()).toContain("provider: fake (source: --provider)");
    expect(fixture.stderr()).toBe("");
  });

  test(`Given Qwen fallback API key env is selected for diagnostics with CLI flags,
    When the CLI main dispatches the doctor command,
    Then it reports the fallback key env, default endpoint, and model metadata`, async () => {
    // Given
    const apiKeySecret = "main-doctor-qwen-fallback-secret";
    const fixture = createRuntime(
      [
        "--doctor",
        "--offline",
        "--provider",
        "qwen",
        "--model",
        "qwen3.7-plus",
      ],
      {
        env: {
          KEEL_PROVIDER: "fake",
          QWEN_API_KEY: apiKeySecret,
        },
      },
    );

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(0);
    expect(fixture.stdout()).toContain("provider: qwen (source: --provider)");
    expect(fixture.stdout()).toContain("model: qwen3.7-plus (source: --model)");
    expect(fixture.stdout()).toContain("api key: present (QWEN_API_KEY)");
    expect(fixture.stdout()).toContain(
      "base url: https://dashscope-intl.aliyuncs.com/compatible-mode/v1 (source: default)",
    );
    expect(fixture.stdout()).toContain(
      "context window: 1000000 tokens (source: registry)",
    );
    expect(fixture.stdout()).toContain("model metadata: registry");
    expect(fixture.stdout()).toContain("model metadata verified: 2026-06-26");
    expect(fixture.stdout()).toContain("max output: 65536 tokens");
    expect(fixture.stdout()).toContain(
      "model capabilities: text-input, tool-calls, reasoning",
    );
    expect(fixture.stdout()).toContain("provider auth: skipped (--offline)");
    expect(fixture.stdout()).not.toContain(apiKeySecret);
    expect(fixture.stderr()).toBe("");
  });

  test(`Given Qwen diagnostics use equals flags with an unparseable base URL,
    When the CLI main dispatches the doctor command,
    Then it rejects the local provider config while preserving the source`, async () => {
    // Given
    const fixture = createRuntime(
      ["--doctor", "--offline", "--provider=qwen", "--model=qwen3.7-plus"],
      {
        env: {
          DASHSCOPE_API_KEY: "test-key",
          QWEN_BASE_URL: "not a url with secret-token",
        },
      },
    );

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toContain("provider: qwen (source: --provider)");
    expect(fixture.stdout()).toContain("model: qwen3.7-plus (source: --model)");
    expect(fixture.stdout()).toContain(
      "base url: <unparseable URL> (source: QWEN_BASE_URL)",
    );
    expect(fixture.stdout()).toContain("error: invalid base URL");
    expect(fixture.stdout()).toContain(
      "provider auth: skipped (local provider diagnostics failed)",
    );
    expect(fixture.stdout()).not.toContain("secret-token");
    expect(fixture.stderr()).toBe("");
  });

  test(`Given diagnostics use a base URL with an unsupported scheme,
    When the CLI main dispatches the offline doctor command,
    Then it rejects the local provider config before reporting readiness`, async () => {
    // Given
    const fixture = createRuntime(
      ["--doctor", "--offline", "--provider=deepseek"],
      {
        env: {
          DEEPSEEK_API_KEY: "test-key",
          DEEPSEEK_BASE_URL: "ftp://example.test/v1",
        },
      },
    );

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toContain(
      "base url: ftp://example.test/v1 (source: DEEPSEEK_BASE_URL)",
    );
    expect(fixture.stdout()).toContain(
      "error: base URL must use http or https",
    );
    expect(fixture.stdout()).toContain(
      "provider auth: skipped (local provider diagnostics failed)",
    );
    expect(fixture.stderr()).toBe("");
  });

  test(`Given offline diagnostics are missing a provider API key,
    When the CLI main dispatches the doctor command,
    Then it reports the missing key as the auth skip reason`, async () => {
    // Given
    const fixture = createRuntime(["--doctor", "--offline"], {
      env: { KEEL_PROVIDER: "deepseek", DEEPSEEK_API_KEY: "" },
    });

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toContain(
      "provider: deepseek (source: KEEL_PROVIDER)",
    );
    expect(fixture.stdout()).toContain(
      "api key: missing (expected DEEPSEEK_API_KEY)",
    );
    expect(fixture.stdout()).toContain(
      "provider auth: skipped (missing API key)",
    );
    expect(fixture.stderr()).toBe("");
  });

  test(`Given a doctor provider flag is missing its value,
    When the CLI main parses the command,
    Then it exits with the provider option validation error`, async () => {
    // Given
    const fixture = createRuntime(["--doctor", "--provider"]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe("Error: --provider requires a value.\n");
  });

  test(`Given a doctor provider equals flag has an empty value,
    When the CLI main parses the command,
    Then it exits with the provider option validation error`, async () => {
    // Given
    const fixture = createRuntime(["--doctor", "--provider="]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe("Error: --provider requires a value.\n");
  });

  test(`Given a doctor model flag is missing its value,
    When the CLI main parses the command,
    Then it exits with the model option validation error`, async () => {
    // Given
    const fixture = createRuntime(["--doctor", "--model"]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe("Error: --model requires a value.\n");
  });

  test(`Given a doctor model equals flag has an empty value,
    When the CLI main parses the command,
    Then it exits with the model option validation error`, async () => {
    // Given
    const fixture = createRuntime(["--doctor", "--model="]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe("Error: --model requires a value.\n");
  });

  test(`Given an unsupported doctor option,
    When the CLI main parses the command,
    Then it exits with the doctor option validation error`, async () => {
    // Given
    const fixture = createRuntime(["--doctor", "--report", "doctor.json"]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe('Error: unknown doctor option "--report"\n');
  });

  test(`Given a selected real provider is missing its API key,
    When the CLI main dispatches the doctor command,
    Then it reports the missing provider setting as a failing diagnostic`, async () => {
    // Given
    const fixture = createRuntime(["--doctor"], {
      env: { KEEL_PROVIDER: "deepseek", DEEPSEEK_API_KEY: "" },
    });

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toContain(
      "provider: deepseek (source: KEEL_PROVIDER)",
    );
    expect(fixture.stdout()).toContain(
      "api key: missing (expected DEEPSEEK_API_KEY)",
    );
    expect(fixture.stdout()).toContain(
      "error: missing API key: expected DEEPSEEK_API_KEY",
    );
    expect(fixture.stderr()).toBe("");
  });

  test(`Given Kimi is configured with unknown pricing,
    When the CLI main dispatches the doctor command,
    Then it reports provider readiness with a cost warning`, async () => {
    // Given
    const fixture = createRuntime(["--doctor", "--offline"], {
      env: {
        KEEL_PROVIDER: "kimi",
        KIMI_API_KEY: "test-key",
        KIMI_MODEL: "kimi-next",
      },
    });

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(0);
    expect(fixture.stdout()).toContain(
      "provider: kimi (source: KEEL_PROVIDER)",
    );
    expect(fixture.stdout()).toContain("model: kimi-next (source: KIMI_MODEL)");
    expect(fixture.stdout()).toContain("cost model: unknown");
    expect(fixture.stdout()).toContain(
      "warning: cost tracking is unavailable for model kimi-next",
    );
    expect(fixture.stdout()).toContain("provider auth: skipped (--offline)");
    expect(fixture.stderr()).toBe("");
  });

  test(`Given the context window env is invalid for diagnostics,
    When the CLI main dispatches the doctor command,
    Then it reports the invalid context setting as a failing diagnostic`, async () => {
    // Given
    const fixture = createRuntime(["--doctor", "--provider=fake"], {
      env: { KEEL_CONTEXT_WINDOW_TOKENS: "12px" },
    });

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toContain(
      "context window: invalid (source: KEEL_CONTEXT_WINDOW_TOKENS)",
    );
    expect(fixture.stdout()).toContain(
      "error: KEEL_CONTEXT_WINDOW_TOKENS must be a positive integer",
    );
    expect(fixture.stderr()).toBe("");
  });

  test(`Given an unknown provider is configured for diagnostics,
    When the CLI main dispatches the doctor command,
    Then it reports the provider configuration failure`, async () => {
    // Given
    const fixture = createRuntime(["--doctor"], {
      env: { KEEL_PROVIDER: "unknown" },
    });

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toContain("provider: failed");
    expect(fixture.stderr()).toBe('Error: unknown provider "unknown"\n');
  });
});
