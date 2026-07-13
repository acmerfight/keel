import type { ContextCompactionOptions } from "../agent/context-compaction.ts";
import { type CostModel, ZERO_COST_MODEL } from "../core/cost.ts";
import {
  type ModelMetadata,
  modelCostModel,
  modelMetadata,
} from "../core/model-metadata.ts";
import type { ProviderId } from "../core/provider-id.ts";
import { createDeepseekProvider } from "../llm/providers/deepseek.ts";
import { createKimiProvider } from "../llm/providers/kimi.ts";
import { createQwenProvider } from "../llm/providers/qwen.ts";
import type { LLMProvider } from "../llm/types.ts";
import {
  createCliFakeProvider,
  createInteractiveFakeProvider,
} from "./fake-provider-demo.ts";
import type { InteractiveResolvedProvider } from "./interactive-session.ts";
import { type ModelSource, providerProfile } from "./provider-profiles.ts";
import {
  type ProviderConfigRuntime,
  type ProviderSelection,
  positiveIntegerEnv,
  providerConfigError,
  requireApiKey,
  selectedConfiguredBaseUrlFromProfile,
  selectedModelFromProfile,
  selectedProviderId,
} from "./provider-selection.ts";

function fakeContextCompactionOptions(
  runtime: ProviderConfigRuntime,
): ContextCompactionOptions | undefined {
  const contextWindowTokens = positiveIntegerEnv(
    runtime,
    "KEEL_CONTEXT_WINDOW_TOKENS",
  );
  return contextWindowTokens === undefined
    ? undefined
    : { contextWindowTokens };
}

function contextCompactionOptions(
  runtime: ProviderConfigRuntime,
  metadata: ModelMetadata,
): ContextCompactionOptions | undefined {
  const contextWindowTokens = positiveIntegerEnv(
    runtime,
    "KEEL_CONTEXT_WINDOW_TOKENS",
  );
  if (contextWindowTokens !== undefined) {
    return { contextWindowTokens };
  }
  if (metadata.status === "unknown" || metadata.contextWindowTokens === null) {
    return undefined;
  }
  return { contextWindowTokens: metadata.contextWindowTokens };
}

type ResolvedProviderBase<Cost extends CostModel | null> = {
  readonly provider: LLMProvider;
  readonly costModel: Cost;
} & Omit<InteractiveResolvedProvider, "costModel" | "provider">;

type ResolvedApiProvider<
  Id extends Exclude<InteractiveResolvedProvider["providerId"], "fake">,
> = ResolvedProviderBase<CostModel | null> & {
  readonly providerId: Id;
  readonly modelSource: ModelSource;
};

export type ResolvedProvider =
  | (ResolvedProviderBase<CostModel> & { readonly providerId: "fake" })
  | ResolvedApiProvider<"deepseek">
  | ResolvedApiProvider<"kimi">
  | ResolvedApiProvider<"qwen">;

export interface ProviderSubprocessConfig {
  readonly providerId: ProviderId;
  readonly model: string;
  readonly environment: Readonly<Record<string, string>>;
}

export function resolveProviderSubprocessConfig(
  runtime: ProviderConfigRuntime,
  selection?: ProviderSelection,
): ProviderSubprocessConfig {
  const providerId = selectedProviderId(runtime, selection);
  if (providerId === "fake") {
    return { providerId, model: "fake", environment: {} };
  }

  const profile = providerProfile(providerId);
  const model = selectedModelFromProfile(
    runtime,
    selection,
    providerId,
    profile,
  ).model;
  const baseUrl = selectedConfiguredBaseUrlFromProfile(
    runtime,
    providerId,
    profile,
  ).value;
  const apiKey = requireApiKey(runtime, providerId, profile);
  const apiKeyEnvKey = profile.apiKeyEnvKeys[0];
  /* v8 ignore next 3: every non-fake provider profile requires an API-key env key. */
  if (apiKeyEnvKey === undefined) {
    providerConfigError(
      `Error: provider ${providerId} has no API-key env key.`,
    );
  }
  return {
    providerId,
    model,
    environment: {
      [apiKeyEnvKey]: apiKey,
      [profile.modelEnvKey]: model,
      [profile.baseUrlEnvKey]: baseUrl,
    },
  };
}

export function resolveProvider(
  userMessage: string,
  runtime: ProviderConfigRuntime,
  selection?: ProviderSelection,
): ResolvedProvider {
  const providerId = selectedProviderId(runtime, selection);

  switch (providerId) {
    case "fake": {
      const contextCompaction = fakeContextCompactionOptions(runtime);
      const metadata = modelMetadata("fake", "fake");
      return {
        providerId: "fake",
        provider: createCliFakeProvider(userMessage),
        model: "fake",
        costModel: ZERO_COST_MODEL,
        modelMetadata: metadata,
        ...(contextCompaction !== undefined ? { contextCompaction } : {}),
      };
    }

    case "deepseek": {
      const profile = providerProfile("deepseek");
      const apiKey = requireApiKey(runtime, "deepseek", profile);
      const selected = selectedModelFromProfile(
        runtime,
        selection,
        "deepseek",
        profile,
      );
      const baseUrl = selectedConfiguredBaseUrlFromProfile(
        runtime,
        "deepseek",
        profile,
      );
      const metadata = modelMetadata("deepseek", selected.model);
      const contextCompaction = contextCompactionOptions(runtime, metadata);
      return {
        providerId: "deepseek",
        provider: createDeepseekProvider({
          apiKey,
          baseUrl: baseUrl.value,
          model: selected.model,
        }),
        model: selected.model,
        costModel: modelCostModel("deepseek", selected.model),
        modelSource: selected.source,
        modelMetadata: metadata,
        ...(contextCompaction !== undefined ? { contextCompaction } : {}),
      };
    }

    case "kimi": {
      const profile = providerProfile("kimi");
      const apiKey = requireApiKey(runtime, "kimi", profile);
      const selected = selectedModelFromProfile(
        runtime,
        selection,
        "kimi",
        profile,
      );
      const baseUrl = selectedConfiguredBaseUrlFromProfile(
        runtime,
        "kimi",
        profile,
      );
      const metadata = modelMetadata("kimi", selected.model);
      const contextCompaction = contextCompactionOptions(runtime, metadata);
      return {
        providerId: "kimi",
        provider: createKimiProvider({
          apiKey,
          baseUrl: baseUrl.value,
          model: selected.model,
        }),
        model: selected.model,
        costModel: modelCostModel("kimi", selected.model),
        modelSource: selected.source,
        modelMetadata: metadata,
        ...(contextCompaction !== undefined ? { contextCompaction } : {}),
      };
    }

    case "qwen": {
      const profile = providerProfile("qwen");
      const apiKey = requireApiKey(runtime, "qwen", profile);
      const selected = selectedModelFromProfile(
        runtime,
        selection,
        "qwen",
        profile,
      );
      const baseUrl = selectedConfiguredBaseUrlFromProfile(
        runtime,
        "qwen",
        profile,
      );
      const metadata = modelMetadata("qwen", selected.model);
      const contextCompaction = contextCompactionOptions(runtime, metadata);
      return {
        providerId: "qwen",
        provider: createQwenProvider({
          apiKey,
          baseUrl: baseUrl.value,
          model: selected.model,
        }),
        model: selected.model,
        costModel: modelCostModel("qwen", selected.model),
        modelSource: selected.source,
        modelMetadata: metadata,
        ...(contextCompaction !== undefined ? { contextCompaction } : {}),
      };
    }
  }
}

export function resolveInteractiveProvider(
  userMessage: string,
  runtime: ProviderConfigRuntime,
  selection?: ProviderSelection,
): ResolvedProvider {
  const providerId = selectedProviderId(runtime, selection);
  if (providerId === "fake") {
    const contextCompaction = fakeContextCompactionOptions(runtime);
    const metadata = modelMetadata("fake", "fake");
    return {
      providerId: "fake",
      provider: createInteractiveFakeProvider(),
      model: "fake",
      costModel: ZERO_COST_MODEL,
      modelMetadata: metadata,
      ...(contextCompaction !== undefined ? { contextCompaction } : {}),
    };
  }

  return resolveProvider(userMessage, runtime, selection);
}

function configuredModelLabel(
  resolved: ResolvedApiProvider<"deepseek" | "kimi" | "qwen">,
  fallbackEnvKey: Exclude<ModelSource, "--model" | "default">,
): string {
  if (resolved.modelSource === "default") {
    return `default model "${resolved.model}"`;
  }
  const source = configuredModelSourceLabel(
    resolved.modelSource,
    fallbackEnvKey,
  );
  return `configured ${source}="${resolved.model}"`;
}

function configuredModelSourceLabel(
  source: Exclude<ModelSource, "default">,
  fallbackEnvKey: Exclude<ModelSource, "--model" | "default">,
): string {
  switch (source) {
    case "--model":
      return "--model";
    case "config":
      return "config model";
    case "DEEPSEEK_MODEL":
    case "KIMI_MODEL":
    case "QWEN_MODEL":
      return fallbackEnvKey;
  }
}

export function requireKnownCostModel(resolved: ResolvedProvider): CostModel {
  switch (resolved.providerId) {
    case "fake":
      return resolved.costModel;
    case "deepseek":
      if (resolved.costModel !== null) return resolved.costModel;
      return providerConfigError(
        `Error: cost tracking is only supported for known DeepSeek model pricing; ${configuredModelLabel(resolved, "DEEPSEEK_MODEL")}.`,
      );
    case "kimi":
      if (resolved.costModel !== null) return resolved.costModel;
      return providerConfigError(
        `Error: cost tracking is only supported for Kimi model "kimi-k2.6"; ${configuredModelLabel(resolved, "KIMI_MODEL")}.`,
      );
    case "qwen":
      if (resolved.costModel !== null) return resolved.costModel;
      return providerConfigError(
        `Error: cost tracking is only supported for known Qwen model pricing; ${configuredModelLabel(resolved, "QWEN_MODEL")}.`,
      );
  }
}
