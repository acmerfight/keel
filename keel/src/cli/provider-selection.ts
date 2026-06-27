import { isProviderId, type ProviderId } from "../core/provider-id.ts";
import type { ModelSource, ProviderProfile } from "./provider-profiles.ts";

export interface ProviderConfigRuntime {
  readonly env: (key: string) => string | undefined;
}

export interface ProviderSelection {
  readonly providerId?: ProviderId;
  readonly model?: string;
}

export type ProviderSource = "--provider" | "KEEL_PROVIDER" | "default";

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
    return { providerId: "deepseek", source: "default" };
  }
  if (isProviderId(configuredProviderId)) {
    return { providerId: configuredProviderId, source: "KEEL_PROVIDER" };
  }
  providerConfigError(`Error: unknown provider "${configuredProviderId}"`);
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
  envKey: Exclude<ModelSource, "--model" | "default">,
  defaultModel: string,
): { readonly model: string; readonly source: ModelSource } {
  if (selection?.model !== undefined) {
    return { model: selection.model, source: "--model" };
  }
  const envModel = runtime.env(envKey);
  if (envModel !== undefined) {
    return { model: envModel, source: envKey };
  }
  return { model: defaultModel, source: "default" };
}

export function selectedModelFromProfile(
  runtime: ProviderConfigRuntime,
  selection: ProviderSelection | undefined,
  profile: ProviderProfile,
): { readonly model: string; readonly source: ModelSource } {
  if (profile.modelEnvKey === undefined) {
    return { model: profile.defaultModel, source: "default" };
  }
  return selectedModel(
    runtime,
    selection,
    profile.modelEnvKey,
    profile.defaultModel,
  );
}

export function selectPresentApiKeyEnvKey(
  runtime: ProviderConfigRuntime,
  envKeys: readonly string[],
): string | null {
  for (const envKey of envKeys) {
    const value = runtime.env(envKey);
    if (value !== undefined && value !== "") {
      return envKey;
    }
  }
  return null;
}

export function requireApiKey(
  runtime: ProviderConfigRuntime,
  profile: ProviderProfile,
): string {
  for (const envKey of profile.apiKeyEnvKeys) {
    const value = runtime.env(envKey);
    if (value !== undefined && value !== "") {
      return value;
    }
  }
  providerConfigError(profile.missingApiKeyMessage);
}
