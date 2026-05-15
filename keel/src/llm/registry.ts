import type { LLMProvider } from "./types.ts";

const providers = new Map<string, LLMProvider>();

export function register(provider: LLMProvider): void {
  providers.set(provider.id, provider);
}

export function get(id: string): LLMProvider | undefined {
  return providers.get(id);
}
