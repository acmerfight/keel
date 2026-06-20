import { describe, expect, test } from "vitest";
import type {
  ProviderConfigRuntime,
  ResolvedProvider,
} from "../../src/cli/provider-config.ts";
import {
  ProviderConfigError,
  requireKnownCostModel,
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

  test(`Given a real provider has context window env set,
    When provider config is resolved,
    Then context compaction uses the configured window`, () => {
    // Given
    const env = {
      KEEL_PROVIDER: "deepseek",
      DEEPSEEK_API_KEY: "test-key",
      KEEL_CONTEXT_WINDOW_TOKENS: "4096",
    };

    // When
    const resolved = resolveProvider("Hello", runtime(env));

    // Then
    expect(resolved.providerId).toBe("deepseek");
    expect(resolved.contextCompaction).toEqual({
      contextWindowTokens: 4096,
    });
  });

  test(`Given provider and model are selected by CLI options,
    When provider config is resolved,
    Then the options override provider env`, () => {
    // Given
    const env = {
      KEEL_PROVIDER: "fake",
      DASHSCOPE_API_KEY: "test-key",
    };

    // When
    const resolved = resolveProvider("Hello", runtime(env), {
      providerId: "qwen",
      model: "qwen3.7-plus",
    });

    // Then
    expect(resolved.providerId).toBe("qwen");
    expect(resolved.model).toBe("qwen3.7-plus");
    expect(requireKnownCostModel(resolved)).not.toBeNull();
  });

  test(`Given Kimi uses the default priced model,
    When cost tracking requires known pricing,
    Then provider config returns the Kimi cost model`, () => {
    // Given
    const env = {
      KEEL_PROVIDER: "kimi",
      KIMI_API_KEY: "test-key",
    };
    const resolved = resolveProvider("Hello", runtime(env));

    // When
    const costModel = requireKnownCostModel(resolved);

    // Then
    expect(resolved.providerId).toBe("kimi");
    expect(resolved.model).toBe("kimi-k2.6");
    expect(costModel).not.toBeNull();
  });

  test(`Given DeepSeek model env selects unknown pricing,
    When cost tracking requires known pricing,
    Then provider config fails closed with the configured env name`, () => {
    // Given
    const env = {
      KEEL_PROVIDER: "deepseek",
      DEEPSEEK_API_KEY: "test-key",
      DEEPSEEK_MODEL: "deepseek-unknown",
    };
    const resolved = resolveProvider("Hello", runtime(env));

    // When / Then
    expect(resolved.providerId).toBe("deepseek");
    expect(resolved.model).toBe("deepseek-unknown");
    expect(() => requireKnownCostModel(resolved)).toThrow(ProviderConfigError);
    expect(() => requireKnownCostModel(resolved)).toThrow(
      'Error: cost tracking is only supported for known DeepSeek model pricing; configured DEEPSEEK_MODEL="deepseek-unknown".',
    );
  });

  test(`Given a default-selected model has unknown pricing,
    When cost tracking requires known pricing,
    Then provider config labels it as the default model`, () => {
    // Given
    const resolved = {
      providerId: "deepseek",
      provider: {
        id: "deepseek",
        async *stream() {},
      },
      model: "deepseek-future-default",
      costModel: null,
      contextCompaction: { contextWindowTokens: 256_000 },
      modelSource: "default",
    } satisfies ResolvedProvider;

    // When / Then
    expect(() => requireKnownCostModel(resolved)).toThrow(ProviderConfigError);
    expect(() => requireKnownCostModel(resolved)).toThrow(
      'Error: cost tracking is only supported for known DeepSeek model pricing; default model "deepseek-future-default".',
    );
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

  test(`Given the interactive fake provider receives no user messages,
    When it streams a reply,
    Then it uses the empty remembered fallback`, async () => {
    // Given
    const resolved = resolveInteractiveProvider(
      "Hello",
      runtime({ KEEL_PROVIDER: "fake" }),
    );
    const abortController = new AbortController();

    // When
    let text: string | undefined;
    for await (const event of resolved.provider.stream({
      systemPrompt: "",
      messages: [],
      signal: abortController.signal,
    })) {
      if (event.type === "text") {
        text = event.text;
      }
    }

    // Then
    expect(text).toBe("Remembered: ");
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
