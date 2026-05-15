import type { LLMProvider } from "../types.ts";

export const anthropicProvider: LLMProvider = {
  id: "anthropic",
  stream() {
    throw new Error("anthropic provider not implemented");
  },
};
