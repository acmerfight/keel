import { isProviderId, type ProviderId } from "../core/provider-id.ts";
import {
  type BaseUrlSource,
  type ModelSource,
  missingProviderApiKeyMessage,
  type ProviderProfile,
} from "./provider-profiles.ts";
import {
  ProviderUserConfigError,
  readOptionalUserProviderConfig,
  readProviderAuthApiKey,
} from "./provider-user-config.ts";

export interface ProviderConfigRuntime {
  readonly env: (key: string) => string | undefined;
}

export interface ProviderSelection {
  readonly providerId?: ProviderId;
  readonly model?: string;
}

export type ProviderSource =
  | "--provider"
  | "KEEL_PROVIDER"
  | "config"
  | "default";

type ApiKeySource =
  | { readonly type: "env"; readonly envKey: string }
  | { readonly type: "auth"; readonly providerId: ProviderId };

export interface SelectedApiKey {
  readonly apiKey: string;
  readonly source: ApiKeySource;
}

export interface SelectedBaseUrl {
  readonly value: string;
  readonly source: BaseUrlSource;
}

type PositiveIntegerEnv =
  | { readonly status: "unset" }
  | { readonly status: "valid"; readonly value: number }
  | { readonly status: "invalid"; readonly message: string };

export class ProviderConfigError extends Error {}

export function providerConfigError(message: string): never {
  throw new ProviderConfigError(message);
}

export function readPositiveIntegerEnv(
  runtime: ProviderConfigRuntime,
  key: string,
): PositiveIntegerEnv {
  const value = runtime.env(key);
  if (value === undefined || value === "") {
    return { status: "unset" };
  }
  const parsed = Number.parseInt(value, 10);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed <= 0 ||
    String(parsed) !== value
  ) {
    return {
      status: "invalid",
      message: `${key} must be a positive integer`,
    };
  }
  return { status: "valid", value: parsed };
}

export function positiveIntegerEnv(
  runtime: ProviderConfigRuntime,
  key: string,
): number | undefined {
  const result = readPositiveIntegerEnv(runtime, key);
  switch (result.status) {
    case "unset":
      return undefined;
    case "valid":
      return result.value;
    case "invalid":
      providerConfigError(`Error: ${result.message}.`);
  }
}

export function selectedProvider(
  runtime: ProviderConfigRuntime,
  selection: ProviderSelection | undefined,
): { readonly providerId: ProviderId; readonly source: ProviderSource } {
  if (selection?.providerId !== undefined) {
    return { providerId: selection.providerId, source: "--provider" };
  }
  const configuredProviderId = runtime.env("KEEL_PROVIDER");
  if (configuredProviderId === undefined) {
    const config = userProviderConfig(runtime);
    if (config !== null) {
      return { providerId: config.providerId, source: "config" };
    }
    return { providerId: "deepseek", source: "default" };
  }
  if (isProviderId(configuredProviderId)) {
    return { providerId: configuredProviderId, source: "KEEL_PROVIDER" };
  }
  providerConfigError(`Error: unknown provider "${configuredProviderId}"`);
}

function userProviderConfig(runtime: ProviderConfigRuntime) {
  try {
    return readOptionalUserProviderConfig(runtime);
  } catch (error) {
    // user config readers throw ProviderUserConfigError for expected failures.
    if (error instanceof ProviderUserConfigError) {
      providerConfigError(error.message);
    }
    // unexpected non-config errors should escape to the caller.
    throw error;
  }
}

function providerAuthApiKey(
  runtime: ProviderConfigRuntime,
  providerId: ProviderId,
): string | null {
  try {
    return readProviderAuthApiKey(runtime, providerId);
  } catch (error) {
    // user auth readers throw ProviderUserConfigError for expected failures.
    if (error instanceof ProviderUserConfigError) {
      providerConfigError(error.message);
    }
    // unexpected non-config errors should escape to the caller.
    throw error;
  }
}

export function selectedProviderId(
  runtime: ProviderConfigRuntime,
  selection: ProviderSelection | undefined,
): ProviderId {
  return selectedProvider(runtime, selection).providerId;
}

function selectedModel(
  runtime: ProviderConfigRuntime,
  selection: ProviderSelection | undefined,
  providerId: ProviderId,
  envKey: Exclude<ModelSource, "--model" | "config" | "default">,
  defaultModel: string,
): { readonly model: string; readonly source: ModelSource } {
  if (selection?.model !== undefined) {
    return { model: selection.model, source: "--model" };
  }
  const envModel = runtime.env(envKey);
  if (envModel !== undefined) {
    return { model: envModel, source: envKey };
  }
  const config = userProviderConfig(runtime);
  if (config?.providerId === providerId && config.model !== undefined) {
    return { model: config.model, source: "config" };
  }
  return { model: defaultModel, source: "default" };
}

export function selectedModelFromProfile(
  runtime: ProviderConfigRuntime,
  selection: ProviderSelection | undefined,
  providerId: ProviderId,
  profile: ProviderProfile,
): { readonly model: string; readonly source: ModelSource } {
  if (profile.modelEnvKey === undefined) {
    return { model: profile.defaultModel, source: "default" };
  }
  return selectedModel(
    runtime,
    selection,
    providerId,
    profile.modelEnvKey,
    profile.defaultModel,
  );
}

export function selectedBaseUrlFromProfile(
  runtime: ProviderConfigRuntime,
  providerId: ProviderId,
  profile: ProviderProfile,
):
  | { readonly status: "none" }
  | ({ readonly status: "configured" } & SelectedBaseUrl) {
  if (profile.baseUrlEnvKey === undefined) {
    return { status: "none" };
  }
  return {
    status: "configured",
    ...selectedConfiguredBaseUrlFromProfile(runtime, providerId, profile),
  };
}

export function selectedConfiguredBaseUrlFromProfile(
  runtime: ProviderConfigRuntime,
  providerId: ProviderId,
  profile: {
    readonly baseUrlEnvKey: Exclude<BaseUrlSource, "config" | "default">;
    readonly defaultBaseUrl: string;
  },
): SelectedBaseUrl {
  const envBaseUrl = runtime.env(profile.baseUrlEnvKey);
  if (envBaseUrl !== undefined) {
    return {
      value: envBaseUrl,
      source: profile.baseUrlEnvKey,
    };
  }

  const config = userProviderConfig(runtime);
  if (config?.providerId === providerId && config.baseUrl !== undefined) {
    return { value: config.baseUrl, source: "config" };
  }

  return {
    value: profile.defaultBaseUrl,
    source: "default",
  };
}

export function requireApiKey(
  runtime: ProviderConfigRuntime,
  providerId: ProviderId,
  profile: ProviderProfile,
): string {
  const selected = selectedApiKey(runtime, providerId, profile);
  if (selected !== null) {
    return selected.apiKey;
  }
  providerConfigError(missingProviderApiKeyMessage(providerId));
}

function usableApiKey(value: string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

export function selectedApiKey(
  runtime: ProviderConfigRuntime,
  providerId: ProviderId,
  profile: ProviderProfile,
): SelectedApiKey | null {
  for (const envKey of profile.apiKeyEnvKeys) {
    const value = usableApiKey(runtime.env(envKey));
    if (value !== null) {
      return { apiKey: value, source: { type: "env", envKey } };
    }
  }
  const authApiKey = usableApiKey(providerAuthApiKey(runtime, providerId));
  if (authApiKey !== null) {
    return { apiKey: authApiKey, source: { type: "auth", providerId } };
  }
  return null;
}
