import { createDeepseekProvider } from "../../src/llm/providers/deepseek.ts";
import { createKimiProvider } from "../../src/llm/providers/kimi.ts";
import { createQwenProvider } from "../../src/llm/providers/qwen.ts";
import {
  type OpenAICompatibleConformanceProvider,
  runOpenAICompatibleConformance,
} from "../../src/testing/openai-compatible-conformance.ts";

const providers = [
  {
    id: "deepseek",
    name: "DeepSeek",
    model: "deepseek-v4-flash",
    maxOutputTokensField: "max_tokens",
    createProvider: createDeepseekProvider,
    usage: ({ inputTokens, outputTokens }) => ({
      prompt_tokens: inputTokens,
      prompt_cache_hit_tokens: 0,
      prompt_cache_miss_tokens: inputTokens,
      completion_tokens: outputTokens,
    }),
  },
  {
    id: "kimi",
    name: "Kimi",
    model: "kimi-k2.6",
    maxOutputTokensField: "max_completion_tokens",
    createProvider: createKimiProvider,
    usage: ({ inputTokens, outputTokens }) => ({
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
    }),
  },
  {
    id: "qwen",
    name: "Qwen",
    model: "qwen3.7-max",
    maxOutputTokensField: "max_completion_tokens",
    createProvider: createQwenProvider,
    usage: ({ inputTokens, outputTokens }) => ({
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
    }),
  },
] satisfies readonly OpenAICompatibleConformanceProvider[];

runOpenAICompatibleConformance(providers);
