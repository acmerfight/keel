import { describe, expect, test } from "vitest";
import type { ProviderConfigRuntime } from "../../src/cli/provider-config.ts";
import {
  ProviderConfigError,
  resolveInteractiveProvider,
  resolveProvider,
} from "../../src/cli/provider-config.ts";

function runtime(env: Record<string, string>): ProviderConfigRuntime {
  return {
    env: (key) => env[key],
  };
}

describe("Provider Config", () => {
  test(`Given the fake provider uses default config,
    When provider config is resolved,
    Then context compaction is not enabled`, () => {
    // Given
    const env = {
      KEEL_PROVIDER: "fake",
    };

    // When
    const resolved = resolveProvider("Hello", runtime(env));

    // Then
    expect(resolved.providerId).toBe("fake");
    expect(resolved.contextCompaction).toBeUndefined();
  });

  test(`Given a real provider uses default config,
    When provider config is resolved,
    Then context compaction uses the default provider window`, () => {
    // Given
    const env = {
      KEEL_PROVIDER: "deepseek",
      DEEPSEEK_API_KEY: "test-key",
    };

    // When
    const resolved = resolveProvider("Hello", runtime(env));

    // Then
    expect(resolved.providerId).toBe("deepseek");
    expect(resolved.contextCompaction).toEqual({
      contextWindowTokens: 256_000,
    });
  });

  test(`Given the context window token env is set,
    When provider config is resolved,
    Then the configured value overrides the provider default`, () => {
    // Given
    const env = {
      KEEL_PROVIDER: "fake",
      KEEL_CONTEXT_WINDOW_TOKENS: "4096",
    };

    // When
    const resolved = resolveProvider("Hello", runtime(env));

    // Then
    expect(resolved.providerId).toBe("fake");
    expect(resolved.contextCompaction).toEqual({
      contextWindowTokens: 4096,
    });
  });

  test(`Given the interactive fake provider has context window env set,
    When interactive provider config is resolved,
    Then context compaction uses the configured value`, () => {
    // Given
    const env = {
      KEEL_PROVIDER: "fake",
      KEEL_CONTEXT_WINDOW_TOKENS: "4096",
    };

    // When
    const resolved = resolveInteractiveProvider("Hello", runtime(env));

    // Then
    expect(resolved.providerId).toBe("fake");
    expect(resolved.contextCompaction).toEqual({
      contextWindowTokens: 4096,
    });
  });

  test(`Given the context window token env is empty,
    When provider config is resolved,
    Then it is treated as unset`, () => {
    // Given
    const env = {
      KEEL_PROVIDER: "fake",
      KEEL_CONTEXT_WINDOW_TOKENS: "",
    };

    // When
    const resolved = resolveProvider("Hello", runtime(env));

    // Then
    expect(resolved.providerId).toBe("fake");
    expect(resolved.contextCompaction).toBeUndefined();
  });

  test(`Given the context window token env is invalid,
    When provider config is resolved,
    Then a provider config error explains the expected value`, () => {
    // Given
    const env = {
      KEEL_PROVIDER: "fake",
      KEEL_CONTEXT_WINDOW_TOKENS: "12px",
    };

    // When / Then
    expect(() => resolveProvider("Hello", runtime(env))).toThrow(
      ProviderConfigError,
    );
    expect(() => resolveProvider("Hello", runtime(env))).toThrow(
      "Error: KEEL_CONTEXT_WINDOW_TOKENS must be a positive integer.",
    );
  });

  test(`Given the context window token env is non-positive,
    When provider config is resolved,
    Then a provider config error explains the expected value`, () => {
    // Given
    const env = {
      KEEL_PROVIDER: "fake",
      KEEL_CONTEXT_WINDOW_TOKENS: "0",
    };

    // When / Then
    expect(() => resolveProvider("Hello", runtime(env))).toThrow(
      "Error: KEEL_CONTEXT_WINDOW_TOKENS must be a positive integer.",
    );
  });
});
