export const providerIds = ["fake", "deepseek", "kimi", "qwen"] as const;
const apiKeyProviderIds = ["deepseek", "kimi", "qwen"] as const;

export type ProviderId = (typeof providerIds)[number];
export type ApiKeyProviderId = (typeof apiKeyProviderIds)[number];

const providerIdSet: ReadonlySet<string> = new Set(providerIds);
const apiKeyProviderIdSet: ReadonlySet<ProviderId> = new Set(apiKeyProviderIds);

export function isProviderId(value: string): value is ProviderId {
  return providerIdSet.has(value);
}

export function isApiKeyProviderId(
  value: ProviderId,
): value is ApiKeyProviderId {
  return apiKeyProviderIdSet.has(value);
}
