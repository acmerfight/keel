export const providerIds = ["fake", "deepseek", "kimi", "qwen"] as const;

export type ProviderId = (typeof providerIds)[number];

const providerIdSet: ReadonlySet<string> = new Set(providerIds);

export function isProviderId(value: string): value is ProviderId {
  return providerIdSet.has(value);
}
