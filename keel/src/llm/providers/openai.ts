import type { LLMProvider } from "../types.ts";

export const openaiProvider: LLMProvider = {
  id: "openai",
  stream() {
    throw new Error("openai provider not implemented");
  },
};
