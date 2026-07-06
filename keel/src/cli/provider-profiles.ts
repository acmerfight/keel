import type { ProviderId } from "../core/provider-id.ts";

export type ModelSource =
  | "--model"
  | "DEEPSEEK_MODEL"
  | "KIMI_MODEL"
  | "QWEN_MODEL"
  | "config"
  | "default";

export type BaseUrlSource =
  | "DEEPSEEK_BASE_URL"
  | "KIMI_BASE_URL"
  | "QWEN_BASE_URL"
  | "config"
  | "default";

interface ProviderProfileBase {
  readonly defaultModel: string;
  readonly modelEnvKey?: Exclude<ModelSource, "--model" | "config" | "default">;
  readonly apiKeyEnvKeys: readonly string[];
  readonly apiKeySetupNotes?: readonly string[];
}

type ProviderProfileWithBaseUrl = ProviderProfileBase & {
  readonly baseUrlEnvKey: Exclude<BaseUrlSource, "config" | "default">;
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
  },
  deepseek: {
    defaultModel: "deepseek-v4-flash",
    modelEnvKey: "DEEPSEEK_MODEL",
    apiKeyEnvKeys: ["DEEPSEEK_API_KEY"],
    baseUrlEnvKey: "DEEPSEEK_BASE_URL",
    defaultBaseUrl: "https://api.deepseek.com",
  },
  kimi: {
    defaultModel: "kimi-k2.6",
    modelEnvKey: "KIMI_MODEL",
    apiKeyEnvKeys: ["KIMI_API_KEY"],
    baseUrlEnvKey: "KIMI_BASE_URL",
    defaultBaseUrl: "https://api.moonshot.cn/v1",
  },
  qwen: {
    defaultModel: "qwen3.7-max",
    modelEnvKey: "QWEN_MODEL",
    apiKeyEnvKeys: ["DASHSCOPE_API_KEY", "QWEN_API_KEY"],
    apiKeySetupNotes: [
      "Qwen default endpoint is https://dashscope-intl.aliyuncs.com/compatible-mode/v1; set QWEN_BASE_URL if your key belongs to China region or a workspace-scoped DashScope endpoint.",
    ],
    baseUrlEnvKey: "QWEN_BASE_URL",
    defaultBaseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
  },
} satisfies ProviderProfiles;

export function providerProfile<Id extends ProviderId>(
  providerId: Id,
): ProviderProfiles[Id] {
  return PROVIDER_PROFILES[providerId];
}

function apiKeyEnvLabel(apiKeyEnvKeys: readonly string[]): string {
  return apiKeyEnvKeys.join(" or ");
}

function apiKeyShellValue(apiKeyEnvKeys: readonly string[]): string | null {
  let expression: string | null = null;
  for (const envKey of [...apiKeyEnvKeys].reverse()) {
    expression =
      expression === null ? `$${envKey}` : `\${${envKey}:-${expression}}`;
  }
  return expression === null ? null : `"${expression}"`;
}

export function providerApiKeySetupLines(
  providerId: ProviderId,
): readonly string[] {
  const profile = providerProfile(providerId);
  const stdinValue = apiKeyShellValue(profile.apiKeyEnvKeys);
  if (stdinValue === null) {
    return [];
  }

  return [
    `Set ${apiKeyEnvLabel(profile.apiKeyEnvKeys)} for this run, or store it:`,
    `  printf '%s\\n' ${stdinValue} | keel auth login ${providerId} --with-api-key`,
    `  keel config set-provider ${providerId}`,
    "  keel --doctor",
    ...(profile.apiKeySetupNotes ?? []),
  ];
}

export function missingProviderApiKeyMessage(providerId: ProviderId): string {
  const setupLines = providerApiKeySetupLines(providerId);
  return [`Error: missing API key for ${providerId}.`, ...setupLines].join(
    "\n",
  );
}
