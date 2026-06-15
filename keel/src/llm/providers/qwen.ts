import { z } from "zod";
import type { CostModel } from "../../core/cost.ts";
import { KeelError } from "../../core/error.ts";
import type { Usage } from "../types.ts";
import {
  createOpenAICompatibleProvider,
  type OpenAICompatibleChoice,
  type OpenAICompatibleChunk,
  type OpenAICompatibleStreamState,
} from "./openai-compatible.ts";

// Qwen prices are per 1M tokens. Long-context requests use higher tiers;
// these models capture the public short-context list prices used by Keel's
// current single-rate cost model.
const QWEN_3_7_PLUS_COST_MODEL: CostModel = {
  uncachedInputPerMillionTokens: 0.4,
  cachedInputPerMillionTokens: 0.08,
  outputPerMillionTokens: 1.6,
};

const QWEN_3_6_FLASH_COST_MODEL: CostModel = {
  uncachedInputPerMillionTokens: 0.25,
  cachedInputPerMillionTokens: 0.25,
  outputPerMillionTokens: 1.5,
};

const QWEN_3_7_MAX_COST_MODEL: CostModel = {
  uncachedInputPerMillionTokens: 2.5,
  cachedInputPerMillionTokens: 0.25,
  outputPerMillionTokens: 7.5,
};

const qwenUsageSchema = z
  .object({
    prompt_tokens: z.number().int().nonnegative(),
    completion_tokens: z.number().int().nonnegative(),
    prompt_cache_hit_tokens: z.number().int().nonnegative().optional(),
    prompt_cache_miss_tokens: z.number().int().nonnegative().optional(),
    prompt_tokens_details: z
      .object({
        cached_tokens: z.number().int().nonnegative().optional(),
      })
      .passthrough()
      .optional(),
    completion_tokens_details: z
      .object({
        reasoning_tokens: z.number().int().nonnegative().optional(),
        text_tokens: z.number().int().nonnegative().optional(),
      })
      .passthrough()
      .optional(),
  })
  .refine((usage) => {
    const cacheHitTokens = usage.prompt_cache_hit_tokens;
    const cacheMissTokens = usage.prompt_cache_miss_tokens;
    const cachedTokens = usage.prompt_tokens_details?.cached_tokens;

    if (cacheHitTokens !== undefined && cacheHitTokens > usage.prompt_tokens) {
      return false;
    }
    if (
      cacheMissTokens !== undefined &&
      cacheMissTokens > usage.prompt_tokens
    ) {
      return false;
    }
    if (cachedTokens !== undefined && cachedTokens > usage.prompt_tokens) {
      return false;
    }
    if (
      cacheHitTokens !== undefined &&
      cachedTokens !== undefined &&
      cacheHitTokens !== cachedTokens
    ) {
      return false;
    }
    if (cacheHitTokens !== undefined && cacheMissTokens !== undefined) {
      return cacheHitTokens + cacheMissTokens === usage.prompt_tokens;
    }
    return true;
  })
  .passthrough();

const qwenToolCallSchema = z
  .object({
    id: z.string().optional(),
    index: z.number().optional(),
    function: z
      .object({
        name: z.string().optional(),
        arguments: z.string().nullable().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const qwenChoiceSchema = z
  .object({
    delta: z
      .object({
        content: z.string().nullable().optional(),
        reasoning_content: z.string().nullable().optional(),
        tool_calls: z.array(qwenToolCallSchema).optional(),
      })
      .passthrough()
      .optional(),
    finish_reason: z.string().nullable().optional(),
    usage: qwenUsageSchema.nullable().optional(),
  })
  .passthrough();

const qwenStreamChunkSchema = z
  .object({
    choices: z.array(qwenChoiceSchema).optional(),
    usage: qwenUsageSchema.nullable().optional(),
  })
  .passthrough()
  .refine((chunk) => chunk.choices !== undefined || chunk.usage !== undefined);

type QwenUsage = z.infer<typeof qwenUsageSchema>;

export interface QwenConfig {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly model: string;
}

function parseQwenChunk(data: string): OpenAICompatibleChunk {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    throw new KeelError(
      "provider_protocol_error",
      "Qwen stream chunk has invalid JSON",
    );
  }

  const result = qwenStreamChunkSchema.safeParse(parsed);
  if (!result.success) {
    throw new KeelError(
      "provider_protocol_error",
      "Qwen stream chunk has invalid schema",
    );
  }
  return result.data;
}

function usageFromQwenUsage(usage: QwenUsage): Usage {
  const cachedInputTokens =
    usage.prompt_cache_hit_tokens ??
    usage.prompt_tokens_details?.cached_tokens ??
    (usage.prompt_cache_miss_tokens !== undefined
      ? usage.prompt_tokens - usage.prompt_cache_miss_tokens
      : undefined) ??
    0;
  const uncachedInputTokens =
    usage.prompt_cache_miss_tokens ?? usage.prompt_tokens - cachedInputTokens;
  return {
    inputTokens: usage.prompt_tokens,
    cachedInputTokens,
    uncachedInputTokens,
    outputTokens: usage.completion_tokens,
  };
}

function captureQwenUsage(
  state: OpenAICompatibleStreamState,
  chunk: OpenAICompatibleChunk,
  choice: OpenAICompatibleChoice | undefined,
): void {
  const usageResult = qwenUsageSchema
    .nullable()
    .optional()
    .safeParse(choice?.usage ?? chunk.usage);
  if (
    !usageResult.success ||
    usageResult.data === undefined ||
    usageResult.data === null
  ) {
    return;
  }
  state.usage = usageFromQwenUsage(usageResult.data);
}

export function qwenCostModel(model: string): CostModel | null {
  if (model === "qwen3.7-plus") return QWEN_3_7_PLUS_COST_MODEL;
  if (model === "qwen3.6-flash") return QWEN_3_6_FLASH_COST_MODEL;
  if (model === "qwen3.7-max") return QWEN_3_7_MAX_COST_MODEL;
  return null;
}

export function createQwenProvider(config: QwenConfig) {
  return createOpenAICompatibleProvider({
    id: "qwen",
    providerName: "Qwen",
    config,
    parseChunk: parseQwenChunk,
    captureUsage: captureQwenUsage,
  });
}
