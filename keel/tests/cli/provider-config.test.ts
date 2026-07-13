import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type {
  ProviderConfigRuntime,
  ResolvedProvider,
} from "../../src/cli/provider-config.ts";
import {
  inspectProviderConfig,
  ProviderConfigError,
  providerApiKeySetupLines,
  requireKnownCostModel,
  resolveInteractiveProvider,
  resolveProvider,
  resolveProviderSubprocessConfig,
} from "../../src/cli/provider-config.ts";
import type { LLMEvent } from "../../src/llm/types.ts";

async function collect(stream: AsyncIterable<LLMEvent>): Promise<LLMEvent[]> {
  const events: LLMEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

function runtime(env: Record<string, string>): ProviderConfigRuntime {
  return {
    env: (key) => env[key],
  };
}

describe("Provider Config", () => {
  test(`Given eval provider defaults and credentials are stored under KEEL_HOME,
    When the parent resolves an isolated eval subprocess configuration,
    Then it forwards only the selected provider connection without forwarding KEEL_HOME`, async () => {
    // Given
    const parent = await mkdtemp(join(tmpdir(), "keel-eval-provider-config-"));
    const keelHome = join(parent, "keel-home");
    await mkdir(keelHome, { recursive: true });
    await writeFile(
      join(keelHome, "config.json"),
      JSON.stringify({
        schemaVersion: 1,
        provider: {
          id: "qwen",
          model: "qwen-eval-model",
          baseUrl: "https://qwen.example.test/v1",
        },
      }),
      "utf8",
    );
    await writeFile(
      join(keelHome, "auth.json"),
      JSON.stringify({
        schemaVersion: 1,
        providers: { qwen: { apiKey: "stored-qwen-key" } },
      }),
      "utf8",
    );

    try {
      // When
      const resolved = resolveProviderSubprocessConfig(
        runtime({ KEEL_HOME: keelHome }),
      );

      // Then
      expect(resolved).toEqual({
        providerId: "qwen",
        model: "qwen-eval-model",
        environment: {
          DASHSCOPE_API_KEY: "stored-qwen-key",
          QWEN_BASE_URL: "https://qwen.example.test/v1",
          QWEN_MODEL: "qwen-eval-model",
        },
      });
      expect(resolved.environment).not.toHaveProperty("KEEL_HOME");
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  test(`Given optional provider config lives below a non-directory KEEL_HOME,
    When provider selection falls back to environment credentials,
    Then the missing optional config does not block the default provider`, async () => {
    // Given
    const parent = await mkdtemp(join(tmpdir(), "keel-provider-config-"));
    const blockedHome = join(parent, "blocked-home");
    await writeFile(blockedHome, "not a directory", "utf8");

    try {
      // When
      const resolved = resolveProvider(
        "hello",
        runtime({
          KEEL_HOME: blockedHome,
          DEEPSEEK_API_KEY: "test-key",
        }),
      );

      // Then
      expect(resolved.providerId).toBe("deepseek");
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  test(`Given the fake provider receives the apply patch demo prompt,
    When it streams through the read and patch turns,
    Then it requests apply_patch and reports the final patch reply`, async () => {
    // Given
    const resolved = resolveProvider(
      "apply patch demo",
      runtime({ KEEL_PROVIDER: "fake" }),
    );

    // When
    const readEvents = await collect(
      resolved.provider.stream({
        systemPrompt: "",
        messages: [],
        signal: new AbortController().signal,
      }),
    );
    const patchEvents = await collect(
      resolved.provider.stream({
        systemPrompt: "",
        messages: [
          {
            role: "tool",
            toolCallId: "fake_read_before_patch",
            content: "export const value = 1;\n",
          },
        ],
        signal: new AbortController().signal,
      }),
    );
    const finalEvents = await collect(
      resolved.provider.stream({
        systemPrompt: "",
        messages: [
          {
            role: "tool",
            toolCallId: "fake_apply_patch",
            content: "Applied patch:\nM src.ts\nA docs/note.md",
          },
        ],
        signal: new AbortController().signal,
      }),
    );

    // Then
    expect(readEvents).toContainEqual({
      type: "tool_call",
      id: "fake_read_before_patch",
      tool: "read",
      path: "src.ts",
    });
    expect(patchEvents).toContainEqual({
      type: "tool_call",
      id: "fake_apply_patch",
      tool: "apply_patch",
      patch: [
        "*** Begin Patch",
        "*** Update File: src.ts",
        "@@",
        "-export const value = 1;",
        "+export const value = 2;",
        "*** Add File: docs/note.md",
        "+patched",
        "*** End Patch",
      ].join("\n"),
    });
    expect(finalEvents).toContainEqual({
      type: "text",
      text: "Applied patch",
    });
  });

  test(`Given the fake provider receives the remove demo prompt,
    When it streams through the read and delete-patch turns,
    Then it requests apply_patch with a Delete File operation`, async () => {
    // Given
    const resolved = resolveProvider(
      "remove obsolete.txt",
      runtime({ KEEL_PROVIDER: "fake" }),
    );

    // When
    const readEvents = await collect(
      resolved.provider.stream({
        systemPrompt: "",
        messages: [],
        signal: new AbortController().signal,
      }),
    );
    const patchEvents = await collect(
      resolved.provider.stream({
        systemPrompt: "",
        messages: [
          {
            role: "tool",
            toolCallId: "fake_read_before_patch",
            content: "obsolete\n",
          },
        ],
        signal: new AbortController().signal,
      }),
    );

    // Then
    expect(readEvents).toContainEqual({
      type: "tool_call",
      id: "fake_read_before_patch",
      tool: "read",
      path: "obsolete.txt",
    });
    expect(patchEvents).toContainEqual({
      type: "tool_call",
      id: "fake_apply_patch",
      tool: "apply_patch",
      patch: [
        "*** Begin Patch",
        "*** Delete File: obsolete.txt",
        "*** End Patch",
      ].join("\n"),
    });
  });

  test(`Given the fake provider receives the move demo prompt,
    When it streams through the read and move-patch turns,
    Then it requests apply_patch with a Move to operation`, async () => {
    // Given
    const resolved = resolveProvider(
      "move old.txt to new.txt",
      runtime({ KEEL_PROVIDER: "fake" }),
    );

    // When
    const readEvents = await collect(
      resolved.provider.stream({
        systemPrompt: "",
        messages: [],
        signal: new AbortController().signal,
      }),
    );
    const patchEvents = await collect(
      resolved.provider.stream({
        systemPrompt: "",
        messages: [
          {
            role: "tool",
            toolCallId: "fake_read_before_patch",
            content: "old\n",
          },
        ],
        signal: new AbortController().signal,
      }),
    );

    // Then
    expect(readEvents).toContainEqual({
      type: "tool_call",
      id: "fake_read_before_patch",
      tool: "read",
      path: "old.txt",
    });
    expect(patchEvents).toContainEqual({
      type: "tool_call",
      id: "fake_apply_patch",
      tool: "apply_patch",
      patch: [
        "*** Begin Patch",
        "*** Update File: old.txt",
        "*** Move to: new.txt",
        "*** End Patch",
      ].join("\n"),
    });
  });

  test(`Given the fake provider receives a remove demo without a path,
    When it streams the response,
    Then it falls back to the plain fake reply`, async () => {
    // Given
    const resolved = resolveProvider(
      "remove ",
      runtime({ KEEL_PROVIDER: "fake" }),
    );

    // When
    const events = await collect(
      resolved.provider.stream({
        systemPrompt: "",
        messages: [],
        signal: new AbortController().signal,
      }),
    );

    // Then
    expect(events).toContainEqual({
      type: "text",
      text: "Hello from fake provider.",
    });
  });

  test.each([
    "move old.txt",
    "move  to new.txt",
    "move old.txt to ",
  ])(`Given the fake provider receives an invalid move demo prompt,
    When it streams the response for "%s",
    Then it falls back to the plain fake reply`, async (message) => {
    // Given
    const resolved = resolveProvider(
      message,
      runtime({ KEEL_PROVIDER: "fake" }),
    );

    // When
    const events = await collect(
      resolved.provider.stream({
        systemPrompt: "",
        messages: [],
        signal: new AbortController().signal,
      }),
    );

    // Then
    expect(events).toContainEqual({
      type: "text",
      text: "Hello from fake provider.",
    });
  });

  test(`Given the fake provider cannot read the apply patch demo target,
    When it receives the failed read result,
    Then it returns the tool failure instead of requesting apply_patch`, async () => {
    // Given
    const resolved = resolveProvider(
      "apply patch demo",
      runtime({ KEEL_PROVIDER: "fake" }),
    );
    await collect(
      resolved.provider.stream({
        systemPrompt: "",
        messages: [],
        signal: new AbortController().signal,
      }),
    );

    // When
    const events = await collect(
      resolved.provider.stream({
        systemPrompt: "",
        messages: [
          {
            role: "tool",
            toolCallId: "fake_read_before_patch",
            content: "Tool failed: read failed: file not found: src.ts",
          },
        ],
        signal: new AbortController().signal,
      }),
    );

    // Then
    expect(events).toContainEqual({
      type: "text",
      text: "Tool failed: read failed: file not found: src.ts",
    });
  });

  test(`Given the fake provider receives an apply_patch failure,
    When it streams the final patch turn,
    Then it returns the tool failure text`, async () => {
    // Given
    const resolved = resolveProvider(
      "apply patch demo",
      runtime({ KEEL_PROVIDER: "fake" }),
    );
    await collect(
      resolved.provider.stream({
        systemPrompt: "",
        messages: [],
        signal: new AbortController().signal,
      }),
    );
    await collect(
      resolved.provider.stream({
        systemPrompt: "",
        messages: [
          {
            role: "tool",
            toolCallId: "fake_read_before_patch",
            content: "export const value = 1;\n",
          },
        ],
        signal: new AbortController().signal,
      }),
    );

    // When
    const events = await collect(
      resolved.provider.stream({
        systemPrompt: "",
        messages: [
          {
            role: "tool",
            toolCallId: "fake_apply_patch",
            content:
              "Tool failed: apply_patch failed: expected lines not found",
          },
        ],
        signal: new AbortController().signal,
      }),
    );

    // Then
    expect(events).toContainEqual({
      type: "text",
      text: "Tool failed: apply_patch failed: expected lines not found",
    });
  });

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

  test(`Given provider API key setup lines are formatted,
    When providers have zero, one, or multiple API key env vars,
    Then the shell guidance matches the provider credential contract`, () => {
    // Given / When / Then
    expect(providerApiKeySetupLines("fake")).toEqual([]);
    expect(providerApiKeySetupLines("deepseek")).toEqual([
      "Set DEEPSEEK_API_KEY for this run, or store it:",
      `  printf '%s\\n' "$DEEPSEEK_API_KEY" | keel setup deepseek --with-api-key`,
      "  printf '%s\\n' \"$DEEPSEEK_API_KEY\" | keel auth login deepseek --with-api-key",
      "  keel config set-provider deepseek",
      "  keel --doctor",
    ]);
    expect(providerApiKeySetupLines("qwen")).toEqual([
      "Set DASHSCOPE_API_KEY or QWEN_API_KEY for this run, or store it:",
      `  printf '%s\\n' "\${DASHSCOPE_API_KEY:-$QWEN_API_KEY}" | keel setup qwen --with-api-key`,
      `  printf '%s\\n' "\${DASHSCOPE_API_KEY:-$QWEN_API_KEY}" | keel auth login qwen --with-api-key`,
      "  keel config set-provider qwen",
      "  keel --doctor",
      "Qwen default endpoint is https://dashscope-intl.aliyuncs.com/compatible-mode/v1; set QWEN_BASE_URL if your key belongs to China region or a workspace-scoped DashScope endpoint.",
    ]);
  });

  test(`Given a real provider uses a catalogued default model,
    When provider config is resolved,
    Then context compaction uses the model metadata context window`, () => {
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
      contextWindowTokens: 1_000_000,
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

  test(`Given a real provider has context window env set,
    When provider config diagnostics are inspected,
    Then diagnostics report the configured context window source`, () => {
    // Given
    const env = {
      KEEL_PROVIDER: "deepseek",
      DEEPSEEK_API_KEY: "test-key",
      KEEL_CONTEXT_WINDOW_TOKENS: "4096",
    };

    // When
    const diagnostic = inspectProviderConfig(runtime(env));

    // Then
    expect(diagnostic.providerId).toBe("deepseek");
    expect(diagnostic.contextWindow).toEqual({
      status: "enabled",
      tokens: 4096,
      source: "KEEL_CONTEXT_WINDOW_TOKENS",
    });
    expect(diagnostic.issues).toEqual([]);
  });

  test(`Given a catalogued provider model is selected,
    When provider config diagnostics are inspected,
    Then diagnostics report registry metadata and capabilities`, () => {
    // Given
    const env = {
      KEEL_PROVIDER: "qwen",
      DASHSCOPE_API_KEY: "test-key",
      QWEN_MODEL: "qwen3.7-plus",
    };

    // When
    const diagnostic = inspectProviderConfig(runtime(env));

    // Then
    expect(diagnostic.providerId).toBe("qwen");
    expect(diagnostic.model).toBe("qwen3.7-plus");
    expect(diagnostic.contextWindow).toEqual({
      status: "enabled",
      tokens: 1_000_000,
      source: "registry",
    });
    expect(diagnostic.modelMetadata).toEqual({
      status: "known",
      source: "registry",
      maxOutputTokens: 65_536,
      lastVerified: "2026-06-26",
      capabilities: {
        textInput: true,
        toolCalls: true,
        reasoning: true,
      },
    });
    expect(diagnostic.costModel).toBe("known");
    expect(diagnostic.issues).toEqual([]);
  });

  test(`Given an uncatalogued real provider model is selected,
    When provider config diagnostics are inspected,
    Then diagnostics fail closed on missing context metadata`, () => {
    // Given
    const env = {
      KEEL_PROVIDER: "qwen",
      DASHSCOPE_API_KEY: "test-key",
      QWEN_MODEL: "qwen-future",
    };

    // When
    const diagnostic = inspectProviderConfig(runtime(env));
    const resolved = resolveProvider("Hello", runtime(env));

    // Then
    expect(resolved.providerId).toBe("qwen");
    expect(resolved.contextCompaction).toBeUndefined();
    expect(diagnostic.contextWindow).toEqual({ status: "unknown" });
    expect(diagnostic.modelMetadata).toEqual({ status: "unknown" });
    expect(diagnostic.issues).toEqual([
      {
        severity: "warning",
        message:
          "model metadata is unavailable for qwen/qwen-future; context window and capabilities are unknown",
      },
      {
        severity: "warning",
        message: "cost tracking is unavailable for model qwen-future",
      },
    ]);
  });

  test(`Given an uncatalogued real provider model has an explicit context override,
    When provider config is resolved,
    Then the override supplies the target context window`, () => {
    // Given
    const env = {
      KEEL_PROVIDER: "qwen",
      DASHSCOPE_API_KEY: "test-key",
      QWEN_MODEL: "qwen-future",
      KEEL_CONTEXT_WINDOW_TOKENS: "4096",
    };

    // When
    const resolved = resolveProvider("Hello", runtime(env));
    const diagnostic = inspectProviderConfig(runtime(env));

    // Then
    expect(resolved.providerId).toBe("qwen");
    expect(resolved.contextCompaction).toEqual({
      contextWindowTokens: 4096,
    });
    expect(diagnostic.contextWindow).toEqual({
      status: "enabled",
      tokens: 4096,
      source: "KEEL_CONTEXT_WINDOW_TOKENS",
    });
    expect(diagnostic.modelMetadata).toEqual({ status: "unknown" });
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
      modelSource: "default",
      modelMetadata: { status: "unknown" },
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
