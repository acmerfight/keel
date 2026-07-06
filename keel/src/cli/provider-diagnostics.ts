import {
  type ModelCapabilities,
  type ModelMetadata,
  modelCostModel,
  modelMetadata,
} from "../core/model-metadata.ts";
import type { ProviderId } from "../core/provider-id.ts";
import {
  type BaseUrlSource,
  type ModelSource,
  type ProviderProfile,
  providerProfile,
} from "./provider-profiles.ts";
import {
  type ProviderConfigRuntime,
  type ProviderSelection,
  type ProviderSource,
  readPositiveIntegerEnv,
  selectedApiKey,
  selectedBaseUrlFromProfile,
  selectedModelFromProfile,
  selectedProvider,
} from "./provider-selection.ts";

type ContextWindowSource = "KEEL_CONTEXT_WINDOW_TOKENS" | "registry";

interface ProviderDiagnosticIssue {
  readonly severity: "error" | "warning";
  readonly message: string;
}

type BaseUrlValidationMessage =
  | "invalid base URL"
  | "base URL must use http or https"
  | "base URL must not include credentials, query, or fragment";
const PROVIDER_BASE_URL_PROTOCOLS: ReadonlySet<string> = new Set([
  "http:",
  "https:",
]);

export type ProviderBaseUrlValidation =
  | { readonly status: "valid"; readonly url: URL }
  | {
      readonly status: "invalid";
      readonly message: BaseUrlValidationMessage;
    };

export type ApiKeyDiagnostic =
  | {
      readonly status: "not-required";
      readonly expectedEnvKeys: readonly string[];
    }
  | {
      readonly status: "present";
      readonly expectedEnvKeys: readonly string[];
      readonly source:
        | { readonly type: "env"; readonly envKey: string }
        | { readonly type: "auth"; readonly providerId: ProviderId };
    }
  | {
      readonly status: "missing";
      readonly expectedEnvKeys: readonly string[];
    };

export type BaseUrlDiagnostic =
  | { readonly status: "none" }
  | {
      readonly status: "configured";
      readonly value: string;
      readonly source: BaseUrlSource;
    };

export function validateProviderBaseUrl(
  value: string,
): ProviderBaseUrlValidation {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { status: "invalid", message: "invalid base URL" };
  }

  if (!PROVIDER_BASE_URL_PROTOCOLS.has(url.protocol)) {
    return { status: "invalid", message: "base URL must use http or https" };
  }

  if (
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    return {
      status: "invalid",
      message: "base URL must not include credentials, query, or fragment",
    };
  }

  return { status: "valid", url };
}

export type ContextWindowDiagnostic =
  | { readonly status: "disabled" }
  | { readonly status: "unknown" }
  | {
      readonly status: "enabled";
      readonly tokens: number;
      readonly source: ContextWindowSource;
    }
  | {
      readonly status: "invalid";
      readonly source: "KEEL_CONTEXT_WINDOW_TOKENS";
      readonly message: string;
    };

export type ModelMetadataDiagnostic =
  | {
      readonly status: "known";
      readonly source: "registry";
      readonly maxOutputTokens: number | null;
      readonly capabilities: ModelCapabilities;
      readonly lastVerified: string;
    }
  | { readonly status: "unknown" };

export interface ProviderConfigDiagnostic {
  readonly providerId: ProviderId;
  readonly providerSource: ProviderSource;
  readonly model: string;
  readonly modelSource: ModelSource;
  readonly apiKey: ApiKeyDiagnostic;
  readonly baseUrl: BaseUrlDiagnostic;
  readonly contextWindow: ContextWindowDiagnostic;
  readonly modelMetadata: ModelMetadataDiagnostic;
  readonly costModel: "known" | "unknown";
  readonly issues: readonly ProviderDiagnosticIssue[];
}

function inspectApiKey(
  runtime: ProviderConfigRuntime,
  providerId: ProviderId,
  profile: ProviderProfile,
): ApiKeyDiagnostic {
  if (profile.apiKeyEnvKeys.length === 0) {
    return { status: "not-required", expectedEnvKeys: [] };
  }

  const apiKey = selectedApiKey(runtime, providerId, profile);
  if (apiKey !== null) {
    return {
      status: "present",
      expectedEnvKeys: profile.apiKeyEnvKeys,
      source: apiKey.source,
    };
  }

  return { status: "missing", expectedEnvKeys: profile.apiKeyEnvKeys };
}

function inspectBaseUrl(
  runtime: ProviderConfigRuntime,
  providerId: ProviderId,
  profile: ProviderProfile,
): BaseUrlDiagnostic {
  return selectedBaseUrlFromProfile(runtime, providerId, profile);
}

function inspectContextWindow(
  runtime: ProviderConfigRuntime,
  metadata: ModelMetadata,
): ContextWindowDiagnostic {
  const configured = readPositiveIntegerEnv(
    runtime,
    "KEEL_CONTEXT_WINDOW_TOKENS",
  );
  switch (configured.status) {
    case "valid":
      return {
        status: "enabled",
        tokens: configured.value,
        source: "KEEL_CONTEXT_WINDOW_TOKENS",
      };
    case "invalid":
      return {
        status: "invalid",
        source: "KEEL_CONTEXT_WINDOW_TOKENS",
        message: configured.message,
      };
    case "unset":
      break;
  }

  if (metadata.status === "unknown") {
    return { status: "unknown" };
  }
  if (metadata.contextWindowTokens === null) {
    return { status: "disabled" };
  }
  return {
    status: "enabled",
    tokens: metadata.contextWindowTokens,
    source: "registry",
  };
}

function inspectModelMetadata(
  metadata: ModelMetadata,
): ModelMetadataDiagnostic {
  if (metadata.status === "unknown") {
    return { status: "unknown" };
  }
  return {
    status: "known",
    source: metadata.source,
    maxOutputTokens: metadata.maxOutputTokens,
    capabilities: metadata.capabilities,
    lastVerified: metadata.lastVerified,
  };
}

function apiKeyLabel(apiKey: ApiKeyDiagnostic): string {
  return apiKey.expectedEnvKeys.join(" or ");
}

export function inspectProviderConfig(
  runtime: ProviderConfigRuntime,
  selection?: ProviderSelection,
): ProviderConfigDiagnostic {
  const provider = selectedProvider(runtime, selection);
  const profile = providerProfile(provider.providerId);
  const selected = selectedModelFromProfile(
    runtime,
    selection,
    provider.providerId,
    profile,
  );
  const apiKey = inspectApiKey(runtime, provider.providerId, profile);
  const metadata = modelMetadata(provider.providerId, selected.model);
  const baseUrl = inspectBaseUrl(runtime, provider.providerId, profile);
  const contextWindow = inspectContextWindow(runtime, metadata);
  const costModel =
    modelCostModel(provider.providerId, selected.model) === null
      ? "unknown"
      : "known";
  const issues: ProviderDiagnosticIssue[] = [];

  if (apiKey.status === "missing") {
    issues.push({
      severity: "error",
      message: `missing API key: expected ${apiKeyLabel(apiKey)}`,
    });
  }

  if (baseUrl.status === "configured") {
    const validation = validateProviderBaseUrl(baseUrl.value);
    if (validation.status === "invalid") {
      issues.push({
        severity: "error",
        message: validation.message,
      });
    }
  }

  if (contextWindow.status === "invalid") {
    issues.push({
      severity: "error",
      message: contextWindow.message,
    });
  }

  if (metadata.status === "unknown") {
    issues.push({
      severity: "warning",
      message: `model metadata is unavailable for ${provider.providerId}/${selected.model}; context window and capabilities are unknown`,
    });
  }

  if (costModel === "unknown") {
    issues.push({
      severity: "warning",
      message: `cost tracking is unavailable for model ${selected.model}`,
    });
  }

  return {
    providerId: provider.providerId,
    providerSource: provider.source,
    model: selected.model,
    modelSource: selected.source,
    apiKey,
    baseUrl,
    contextWindow,
    modelMetadata: inspectModelMetadata(metadata),
    costModel,
    issues,
  };
}

export function providerDiagnosticApiKey(
  runtime: ProviderConfigRuntime,
  diagnostic: ProviderConfigDiagnostic,
): string | null {
  const apiKey = selectedApiKey(
    runtime,
    diagnostic.providerId,
    providerProfile(diagnostic.providerId),
  );
  return apiKey?.apiKey ?? null;
}
