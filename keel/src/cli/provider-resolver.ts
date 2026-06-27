import type { ContextCompactionOptions } from "../agent/context-compaction.ts";
import { type CostModel, ZERO_COST_MODEL } from "../core/cost.ts";
import {
  type ModelMetadata,
  modelCostModel,
  modelMetadata,
} from "../core/model-metadata.ts";
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

type ResolvedProviderBase<
  Id extends InteractiveResolvedProvider["providerId"],
  Cost extends CostModel | null,
> = InteractiveResolvedProvider & {
  readonly providerId: Id;
  readonly provider: LLMProvider;
  readonly costModel: Cost;
  readonly modelSource?: ModelSource;
};

export type ResolvedProvider =
  | ResolvedProviderBase<"fake", CostModel>
  | ResolvedProviderBase<"deepseek", CostModel | null>
  | ResolvedProviderBase<"kimi", CostModel | null>
  | ResolvedProviderBase<"qwen", CostModel | null>;

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
      const apiKey = requireApiKey(runtime, profile);
      const selected = selectedModelFromProfile(runtime, selection, profile);
      const metadata = modelMetadata("deepseek", selected.model);
      const contextCompaction = contextCompactionOptions(runtime, metadata);
      return {
        providerId: "deepseek",
        provider: createDeepseekProvider({
          apiKey,
          baseUrl: runtime.env(profile.baseUrlEnvKey) ?? profile.defaultBaseUrl,
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
      const apiKey = requireApiKey(runtime, profile);
      const selected = selectedModelFromProfile(runtime, selection, profile);
      const metadata = modelMetadata("kimi", selected.model);
      const contextCompaction = contextCompactionOptions(runtime, metadata);
      return {
        providerId: "kimi",
        provider: createKimiProvider({
          apiKey,
          baseUrl: runtime.env(profile.baseUrlEnvKey) ?? profile.defaultBaseUrl,
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
      const apiKey = requireApiKey(runtime, profile);
      const selected = selectedModelFromProfile(runtime, selection, profile);
      const metadata = modelMetadata("qwen", selected.model);
      const contextCompaction = contextCompactionOptions(runtime, metadata);
      return {
        providerId: "qwen",
        provider: createQwenProvider({
          apiKey,
          baseUrl: runtime.env(profile.baseUrlEnvKey) ?? profile.defaultBaseUrl,
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
  resolved: ResolvedProvider,
  fallbackEnvKey: Exclude<ModelSource, "--model" | "default">,
): string {
  if (resolved.modelSource === "default") {
    return `default model "${resolved.model}"`;
  }
  const source =
    resolved.modelSource === "--model" ? "--model" : fallbackEnvKey;
  return `configured ${source}="${resolved.model}"`;
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
