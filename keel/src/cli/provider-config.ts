import type { ContextCompactionOptions } from "../agent/context-compaction.ts";
import type { CostModel } from "../core/cost.ts";
import type { ProviderId } from "../core/provider-id.ts";
import {
  createDeepseekProvider,
  deepseekCostModel,
} from "../llm/providers/deepseek.ts";
import { createFakeProvider, fakeResponse } from "../llm/providers/fake.ts";
import {
  createKimiProvider,
  KIMI_K2_6_COST_MODEL,
} from "../llm/providers/kimi.ts";
import { createQwenProvider, qwenCostModel } from "../llm/providers/qwen.ts";
import type { LLMProvider } from "../llm/types.ts";
import type { InteractiveResolvedProvider } from "./interactive-session.ts";

interface CliEditRequest {
  readonly path: string;
  readonly oldText: string;
  readonly newText: string;
}

interface CliWriteRequest {
  readonly path: string;
  readonly content: string;
}

interface CliPatchRequest {
  readonly readPath: string;
  readonly patch: string;
}

export interface ProviderConfigRuntime {
  readonly env: (key: string) => string | undefined;
}

export interface ProviderSelection {
  readonly providerId?: ProviderId;
  readonly model?: string;
}

type ModelSource =
  | "--model"
  | "DEEPSEEK_MODEL"
  | "KIMI_MODEL"
  | "QWEN_MODEL"
  | "default";

type ProviderSource = "--provider" | "KEEL_PROVIDER" | "default";
type BaseUrlSource =
  | "DEEPSEEK_BASE_URL"
  | "KIMI_BASE_URL"
  | "QWEN_BASE_URL"
  | "default";
type ContextWindowSource = "KEEL_CONTEXT_WINDOW_TOKENS" | "default";

type PositiveIntegerEnv =
  | { readonly status: "unset" }
  | { readonly status: "valid"; readonly value: number }
  | { readonly status: "invalid"; readonly message: string };

interface ProviderDiagnosticIssue {
  readonly severity: "error" | "warning";
  readonly message: string;
}

export type ApiKeyDiagnostic =
  | {
      readonly status: "not-required";
      readonly expectedEnvKeys: readonly string[];
    }
  | {
      readonly status: "present";
      readonly expectedEnvKeys: readonly string[];
      readonly presentEnvKey: string;
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

export type ContextWindowDiagnostic =
  | { readonly status: "disabled" }
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

export interface ProviderConfigDiagnostic {
  readonly providerId: ProviderId;
  readonly providerSource: ProviderSource;
  readonly model: string;
  readonly modelSource: ModelSource;
  readonly apiKey: ApiKeyDiagnostic;
  readonly baseUrl: BaseUrlDiagnostic;
  readonly contextWindow: ContextWindowDiagnostic;
  readonly costModel: "known" | "unknown";
  readonly issues: readonly ProviderDiagnosticIssue[];
}

type ResolvedProviderBase<
  Id extends ProviderId,
  Cost extends CostModel | null,
> = InteractiveResolvedProvider & {
  readonly providerId: Id;
  readonly costModel: Cost;
  readonly contextCompaction?: ContextCompactionOptions;
  readonly modelSource?: ModelSource;
};

export type ResolvedProvider =
  | ResolvedProviderBase<"fake", CostModel>
  | ResolvedProviderBase<"deepseek", CostModel | null>
  | ResolvedProviderBase<"kimi", CostModel | null>
  | ResolvedProviderBase<"qwen", CostModel | null>;

export class ProviderConfigError extends Error {}

function providerConfigError(message: string): never {
  throw new ProviderConfigError(message);
}

function readPositiveIntegerEnv(
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

function positiveIntegerEnv(
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

function realContextCompactionOptions(
  runtime: ProviderConfigRuntime,
): ContextCompactionOptions {
  return {
    contextWindowTokens:
      positiveIntegerEnv(runtime, "KEEL_CONTEXT_WINDOW_TOKENS") ?? 256_000,
  };
}

function isProviderId(value: string): value is ProviderId {
  return (
    value === "fake" ||
    value === "deepseek" ||
    value === "kimi" ||
    value === "qwen"
  );
}

function selectedProvider(
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

function selectedProviderId(
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

function parseCliEditDemo(message: string): CliEditRequest | null {
  const prefix = "replace ";
  const withToken = " with ";
  const inToken = " in ";

  if (!message.startsWith(prefix)) return null;

  const body = message.slice(prefix.length);
  const withIndex = body.indexOf(withToken);
  if (withIndex < 0) return null;

  const newTextStart = withIndex + withToken.length;
  const inIndex = body.indexOf(inToken, newTextStart);
  if (inIndex < 0) return null;

  const oldText = body.slice(0, withIndex);
  const newText = body.slice(newTextStart, inIndex);
  const path = body.slice(inIndex + inToken.length);

  if (oldText === "" || newText === "" || path === "") return null;

  return { path, oldText, newText };
}

function parseCliWriteDemo(message: string): CliWriteRequest | null {
  const prefix = "create ";
  if (!message.startsWith(prefix)) return null;

  const path = message.slice(prefix.length);
  if (path === "") return null;

  return { path, content: '{"created":true}\n' };
}

function parseCliPatchDemo(message: string): CliPatchRequest | null {
  if (message !== "apply patch demo") return null;
  return {
    readPath: "src.ts",
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
  };
}

const ZERO_USAGE = {
  inputTokens: 0,
  cachedInputTokens: 0,
  uncachedInputTokens: 0,
  outputTokens: 0,
};

const ZERO_COST_MODEL: CostModel = {
  type: "fixed",
  uncachedInputPerMillionTokens: 0,
  cachedInputPerMillionTokens: 0,
  outputPerMillionTokens: 0,
};

function kimiCostModel(model: string): CostModel | null {
  if (model === "kimi-k2.6") return KIMI_K2_6_COST_MODEL;
  return null;
}

interface ProviderProfileBase {
  readonly defaultModel: string;
  readonly modelEnvKey?: Exclude<ModelSource, "--model" | "default">;
  readonly apiKeyEnvKeys: readonly string[];
  readonly missingApiKeyMessage: string;
  readonly contextWindowDefaultTokens?: number;
  readonly costModel: (model: string) => CostModel | null;
}

type ProviderProfile =
  | (ProviderProfileBase & {
      readonly baseUrlEnvKey: Exclude<BaseUrlSource, "default">;
      readonly defaultBaseUrl: string;
    })
  | (ProviderProfileBase & {
      readonly baseUrlEnvKey?: never;
      readonly defaultBaseUrl?: never;
    });

const PROVIDER_PROFILES = {
  fake: {
    defaultModel: "fake",
    apiKeyEnvKeys: [],
    missingApiKeyMessage: "Error: fake provider does not require an API key.",
    costModel: () => ZERO_COST_MODEL,
  },
  deepseek: {
    defaultModel: "deepseek-v4-flash",
    modelEnvKey: "DEEPSEEK_MODEL",
    apiKeyEnvKeys: ["DEEPSEEK_API_KEY"],
    missingApiKeyMessage:
      "Error: DEEPSEEK_API_KEY is required. Set the API key to use DeepSeek.",
    baseUrlEnvKey: "DEEPSEEK_BASE_URL",
    defaultBaseUrl: "https://api.deepseek.com",
    contextWindowDefaultTokens: 256_000,
    costModel: deepseekCostModel,
  },
  kimi: {
    defaultModel: "kimi-k2.6",
    modelEnvKey: "KIMI_MODEL",
    apiKeyEnvKeys: ["KIMI_API_KEY"],
    missingApiKeyMessage:
      "Error: KIMI_API_KEY is required. Set the API key to use Kimi.",
    baseUrlEnvKey: "KIMI_BASE_URL",
    defaultBaseUrl: "https://api.moonshot.cn/v1",
    contextWindowDefaultTokens: 256_000,
    costModel: kimiCostModel,
  },
  qwen: {
    defaultModel: "qwen3.7-max",
    modelEnvKey: "QWEN_MODEL",
    apiKeyEnvKeys: ["DASHSCOPE_API_KEY", "QWEN_API_KEY"],
    missingApiKeyMessage:
      "Error: DASHSCOPE_API_KEY or QWEN_API_KEY is required. Qwen default endpoint is https://dashscope-intl.aliyuncs.com/compatible-mode/v1; set QWEN_BASE_URL if your key belongs to China region or a workspace-scoped DashScope endpoint.",
    baseUrlEnvKey: "QWEN_BASE_URL",
    defaultBaseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    contextWindowDefaultTokens: 256_000,
    costModel: qwenCostModel,
  },
} satisfies Record<ProviderId, ProviderProfile>;

function providerProfile(providerId: ProviderId): ProviderProfile {
  return PROVIDER_PROFILES[providerId];
}

function selectedModelFromProfile(
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

function selectPresentApiKeyEnvKey(
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

function requireApiKey(
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

function inspectApiKey(
  runtime: ProviderConfigRuntime,
  profile: ProviderProfile,
): ApiKeyDiagnostic {
  if (profile.apiKeyEnvKeys.length === 0) {
    return { status: "not-required", expectedEnvKeys: [] };
  }

  const presentEnvKey = selectPresentApiKeyEnvKey(
    runtime,
    profile.apiKeyEnvKeys,
  );
  if (presentEnvKey !== null) {
    return {
      status: "present",
      expectedEnvKeys: profile.apiKeyEnvKeys,
      presentEnvKey,
    };
  }

  return { status: "missing", expectedEnvKeys: profile.apiKeyEnvKeys };
}

function inspectBaseUrl(
  runtime: ProviderConfigRuntime,
  profile: ProviderProfile,
): BaseUrlDiagnostic {
  if (profile.baseUrlEnvKey === undefined) {
    return { status: "none" };
  }

  const configuredBaseUrl = runtime.env(profile.baseUrlEnvKey);
  if (configuredBaseUrl !== undefined) {
    return {
      status: "configured",
      value: configuredBaseUrl,
      source: profile.baseUrlEnvKey,
    };
  }

  return {
    status: "configured",
    value: profile.defaultBaseUrl,
    source: "default",
  };
}

function inspectContextWindow(
  runtime: ProviderConfigRuntime,
  profile: ProviderProfile,
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

  const defaultTokens = profile.contextWindowDefaultTokens;
  if (defaultTokens === undefined) {
    return { status: "disabled" };
  }
  return {
    status: "enabled",
    tokens: defaultTokens,
    source: "default",
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
  const selected = selectedModelFromProfile(runtime, selection, profile);
  const apiKey = inspectApiKey(runtime, profile);
  const contextWindow = inspectContextWindow(runtime, profile);
  const costModel =
    profile.costModel(selected.model) === null ? "unknown" : "known";
  const issues: ProviderDiagnosticIssue[] = [];

  if (apiKey.status === "missing") {
    issues.push({
      severity: "error",
      message: `missing API key: expected ${apiKeyLabel(apiKey)}`,
    });
  }

  if (contextWindow.status === "invalid") {
    issues.push({
      severity: "error",
      message: contextWindow.message,
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
    baseUrl: inspectBaseUrl(runtime, profile),
    contextWindow,
    costModel,
    issues,
  };
}

function createCliFakeProvider(userMessage: string): LLMProvider {
  const patch = parseCliPatchDemo(userMessage);
  if (patch !== null) {
    let turn = 0;
    return {
      id: "fake",
      async *stream(options) {
        turn++;
        if (turn === 1) {
          yield {
            type: "tool_call",
            id: "fake_read_before_patch",
            tool: "read",
            path: patch.readPath,
          };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }

        const toolContent = options.messages.findLast(
          (m) => m.role === "tool",
        )?.content;
        if (turn === 2) {
          if (toolContent?.startsWith("Tool failed:")) {
            yield { type: "text", text: toolContent };
            yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
            return;
          }
          yield {
            type: "tool_call",
            id: "fake_apply_patch",
            tool: "apply_patch",
            patch: patch.patch,
          };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }

        const reply = toolContent?.startsWith("Tool failed:")
          ? toolContent
          : "Applied patch";
        yield { type: "text", text: reply };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
  }

  const edit = parseCliEditDemo(userMessage);
  const write = parseCliWriteDemo(userMessage);
  if (edit === null) {
    if (write === null) {
      return createFakeProvider([fakeResponse("Hello from fake provider.")]);
    }

    let turn = 0;
    return {
      id: "fake",
      async *stream(options) {
        turn++;
        if (turn === 1) {
          yield {
            type: "tool_call",
            id: "fake_write",
            tool: "write",
            path: write.path,
            content: write.content,
          };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }

        const toolContent = options.messages.findLast(
          (m) => m.role === "tool",
        )?.content;
        const reply = toolContent?.startsWith("Tool failed:")
          ? toolContent
          : `Created ${write.path}`;
        yield { type: "text", text: reply };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
  }

  let turn = 0;
  return {
    id: "fake",
    async *stream(options) {
      turn++;
      if (turn === 1) {
        yield {
          type: "tool_call",
          id: "fake_read_before_edit",
          tool: "read",
          path: edit.path,
        };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
        return;
      }

      const toolContent = options.messages.findLast(
        (m) => m.role === "tool",
      )?.content;
      if (turn === 2) {
        if (toolContent?.startsWith("Tool failed:")) {
          yield { type: "text", text: toolContent };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        yield {
          type: "tool_call",
          id: "fake_edit",
          tool: "edit",
          path: edit.path,
          edits: [{ oldText: edit.oldText, newText: edit.newText }],
        };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
        return;
      }

      const reply = toolContent?.startsWith("Tool failed:")
        ? toolContent
        : `Edited ${edit.path}`;
      yield { type: "text", text: reply };
      yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
    },
  };
}

function createInteractiveFakeProvider(): LLMProvider {
  return {
    id: "fake",
    async *stream(options) {
      const userMessages = options.messages.filter(
        (message) => message.role === "user",
      );
      const latest = userMessages.at(-1)?.content ?? "";
      const previous = userMessages.at(-2)?.content;
      const text =
        previous !== undefined && latest.endsWith("remember?")
          ? `Earlier you said: ${previous}`
          : `Remembered: ${latest}`;
      yield { type: "text", text };
      yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
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
      return {
        providerId: "fake",
        provider: createCliFakeProvider(userMessage),
        model: "fake",
        costModel: ZERO_COST_MODEL,
        ...(contextCompaction !== undefined ? { contextCompaction } : {}),
      };
    }

    case "deepseek": {
      const profile = PROVIDER_PROFILES.deepseek;
      const apiKey = requireApiKey(runtime, profile);
      const selected = selectedModelFromProfile(runtime, selection, profile);
      const contextCompaction = realContextCompactionOptions(runtime);
      return {
        providerId: "deepseek",
        provider: createDeepseekProvider({
          apiKey,
          baseUrl: runtime.env(profile.baseUrlEnvKey) ?? profile.defaultBaseUrl,
          model: selected.model,
        }),
        model: selected.model,
        costModel: profile.costModel(selected.model),
        modelSource: selected.source,
        contextCompaction,
      };
    }

    case "kimi": {
      const profile = PROVIDER_PROFILES.kimi;
      const apiKey = requireApiKey(runtime, profile);
      const selected = selectedModelFromProfile(runtime, selection, profile);
      const contextCompaction = realContextCompactionOptions(runtime);
      return {
        providerId: "kimi",
        provider: createKimiProvider({
          apiKey,
          baseUrl: runtime.env(profile.baseUrlEnvKey) ?? profile.defaultBaseUrl,
          model: selected.model,
        }),
        model: selected.model,
        costModel: profile.costModel(selected.model),
        modelSource: selected.source,
        contextCompaction,
      };
    }

    case "qwen": {
      const profile = PROVIDER_PROFILES.qwen;
      const apiKey = requireApiKey(runtime, profile);
      const selected = selectedModelFromProfile(runtime, selection, profile);
      const contextCompaction = realContextCompactionOptions(runtime);
      return {
        providerId: "qwen",
        provider: createQwenProvider({
          apiKey,
          baseUrl: runtime.env(profile.baseUrlEnvKey) ?? profile.defaultBaseUrl,
          model: selected.model,
        }),
        model: selected.model,
        costModel: profile.costModel(selected.model),
        modelSource: selected.source,
        contextCompaction,
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
    return {
      providerId: "fake",
      provider: createInteractiveFakeProvider(),
      model: "fake",
      costModel: ZERO_COST_MODEL,
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
