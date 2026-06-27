import type { ProviderId } from "../core/provider-id.ts";

export type ModelSource =
  | "--model"
  | "DEEPSEEK_MODEL"
  | "KIMI_MODEL"
  | "QWEN_MODEL"
  | "default";

export type BaseUrlSource =
  | "DEEPSEEK_BASE_URL"
  | "KIMI_BASE_URL"
  | "QWEN_BASE_URL"
  | "default";

interface ProviderProfileBase {
  readonly defaultModel: string;
  readonly modelEnvKey?: Exclude<ModelSource, "--model" | "default">;
  readonly apiKeyEnvKeys: readonly string[];
  readonly missingApiKeyMessage: string;
}

type ProviderProfileWithBaseUrl = ProviderProfileBase & {
  readonly baseUrlEnvKey: Exclude<BaseUrlSource, "default">;
  readonly defaultBaseUrl: string;
};

type ProviderProfileWithoutBaseUrl = ProviderProfileBase & {
  readonly baseUrlEnvKey?: never;
  readonly defaultBaseUrl?: never;
};

interface ProviderProfiles {
  readonly fake: ProviderProfileWithoutBaseUrl;
  readonly deepseek: ProviderProfileWithBaseUrl;
  readonly kimi: ProviderProfileWithBaseUrl;
  readonly qwen: ProviderProfileWithBaseUrl;
}

export type ProviderProfile = ProviderProfiles[ProviderId];

const PROVIDER_PROFILES = {
  fake: {
    defaultModel: "fake",
    apiKeyEnvKeys: [],
    missingApiKeyMessage: "Error: fake provider does not require an API key.",
  },
  deepseek: {
    defaultModel: "deepseek-v4-flash",
    modelEnvKey: "DEEPSEEK_MODEL",
    apiKeyEnvKeys: ["DEEPSEEK_API_KEY"],
    missingApiKeyMessage:
      "Error: DEEPSEEK_API_KEY is required. Set the API key to use DeepSeek.",
    baseUrlEnvKey: "DEEPSEEK_BASE_URL",
    defaultBaseUrl: "https://api.deepseek.com",
  },
  kimi: {
    defaultModel: "kimi-k2.6",
    modelEnvKey: "KIMI_MODEL",
    apiKeyEnvKeys: ["KIMI_API_KEY"],
    missingApiKeyMessage:
      "Error: KIMI_API_KEY is required. Set the API key to use Kimi.",
    baseUrlEnvKey: "KIMI_BASE_URL",
    defaultBaseUrl: "https://api.moonshot.cn/v1",
  },
  qwen: {
    defaultModel: "qwen3.7-max",
    modelEnvKey: "QWEN_MODEL",
    apiKeyEnvKeys: ["DASHSCOPE_API_KEY", "QWEN_API_KEY"],
    missingApiKeyMessage:
      "Error: DASHSCOPE_API_KEY or QWEN_API_KEY is required. Qwen default endpoint is https://dashscope-intl.aliyuncs.com/compatible-mode/v1; set QWEN_BASE_URL if your key belongs to China region or a workspace-scoped DashScope endpoint.",
    baseUrlEnvKey: "QWEN_BASE_URL",
    defaultBaseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
  },
} satisfies ProviderProfiles;

export function providerProfile<Id extends ProviderId>(
  providerId: Id,
): ProviderProfiles[Id] {
  return PROVIDER_PROFILES[providerId];
}
