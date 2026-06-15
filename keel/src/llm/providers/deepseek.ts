import { z } from "zod";
import type { CostModel } from "../../core/cost.ts";
import { KeelError } from "../../core/error.ts";
import type { Usage } from "../types.ts";
import {
  createOpenAICompatibleProvider,
  type OpenAICompatibleChoice,
  type OpenAICompatibleChunk,
  type OpenAICompatibleStreamState,
  type ProviderRetryConfig,
} from "./openai-compatible.ts";

// DeepSeek V4 Flash prices are per 1M tokens.
export const DEEPSEEK_V4_FLASH_COST_MODEL: CostModel = {
  uncachedInputPerMillionTokens: 0.14,
  cachedInputPerMillionTokens: 0.0028,
  outputPerMillionTokens: 0.28,
};

const deepseekToolCallSchema = z
  .object({
    id: z.string().optional(),
    index: z.number().optional(),
    function: z
      .object({
        name: z.string().optional(),
        arguments: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const deepseekChoiceSchema = z
  .object({
    delta: z
      .object({
        // DeepSeek emits content: null while streaming reasoning_content.
        content: z.string().nullable().optional(),
        tool_calls: z.array(deepseekToolCallSchema).optional(),
      })
      .passthrough()
      .optional(),
    finish_reason: z.string().nullable().optional(),
  })
  .passthrough();

const deepseekUsageSchema = z
  .object({
    prompt_tokens: z.number(),
    prompt_cache_hit_tokens: z.number(),
    prompt_cache_miss_tokens: z.number(),
    completion_tokens: z.number(),
  })
  .refine(
    (usage) =>
      usage.prompt_tokens ===
      usage.prompt_cache_hit_tokens + usage.prompt_cache_miss_tokens,
  )
  .passthrough();

const deepseekStreamChunkSchema = z
  .object({
    choices: z.array(deepseekChoiceSchema).optional(),
    // Some OpenAI-compatible streams emit usage: null on non-final chunks.
    // Accept it here; the stream still requires real usage before stop.
    usage: deepseekUsageSchema.nullable().optional(),
  })
  .passthrough()
  .refine((chunk) => chunk.choices !== undefined || chunk.usage !== undefined);

type DeepseekUsage = z.infer<typeof deepseekUsageSchema>;

export interface DeepseekConfig {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly retry?: ProviderRetryConfig;
}

function parseDeepseekChunk(data: string): OpenAICompatibleChunk {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    throw new KeelError(
      "provider_protocol_error",
      "DeepSeek stream chunk has invalid JSON",
    );
  }

  const result = deepseekStreamChunkSchema.safeParse(parsed);
  if (!result.success) {
    throw new KeelError(
      "provider_protocol_error",
      "DeepSeek stream chunk has invalid schema",
    );
  }
  return result.data;
}

function usageFromDeepseekUsage(usage: DeepseekUsage): Usage {
  return {
    inputTokens: usage.prompt_tokens,
    cachedInputTokens: usage.prompt_cache_hit_tokens,
    uncachedInputTokens: usage.prompt_cache_miss_tokens,
    outputTokens: usage.completion_tokens,
  };
}

function captureDeepseekUsage(
  state: OpenAICompatibleStreamState,
  chunk: OpenAICompatibleChunk,
  _choice: OpenAICompatibleChoice | undefined,
): void {
  const result = deepseekUsageSchema
    .nullable()
    .optional()
    .safeParse(chunk.usage);
  if (!result.success || result.data === undefined || result.data === null) {
    return;
  }
  state.usage = usageFromDeepseekUsage(result.data);
}

export function createDeepseekProvider(config: DeepseekConfig) {
  return createOpenAICompatibleProvider({
    id: "deepseek",
    providerName: "DeepSeek",
    config,
    parseChunk: parseDeepseekChunk,
    captureUsage: captureDeepseekUsage,
  });
}
