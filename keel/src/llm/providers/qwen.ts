import { z } from "zod";
import type { CostModel } from "../../core/cost.ts";
import { KeelError } from "../../core/error.ts";
import type { Usage } from "../types.ts";
import {
  createOpenAICompatibleProvider,
  type OpenAICompatibleStreamState,
  type ProviderRetryConfig,
} from "./openai-compatible.ts";

// Qwen prices are per 1M tokens. Tiered models choose one tier from the
// request's input-token count; cached input uses the implicit cache discount.
const QWEN_3_7_MAX_COST_MODEL: CostModel = {
  type: "fixed",
  uncachedInputPerMillionTokens: 2.5,
  cachedInputPerMillionTokens: 0.25,
  outputPerMillionTokens: 7.5,
};

const QWEN_3_7_PLUS_COST_MODEL: CostModel = {
  type: "input-token-tiers",
  tiers: [
    {
      startsAboveInputTokens: 0,
      uncachedInputPerMillionTokens: 0.4,
      cachedInputPerMillionTokens: 0.08,
      outputPerMillionTokens: 1.6,
    },
    {
      startsAboveInputTokens: 256_000,
      uncachedInputPerMillionTokens: 1.2,
      cachedInputPerMillionTokens: 0.24,
      outputPerMillionTokens: 4.8,
    },
  ],
};

const QWEN_3_6_FLASH_COST_MODEL: CostModel = {
  type: "input-token-tiers",
  tiers: [
    {
      startsAboveInputTokens: 0,
      uncachedInputPerMillionTokens: 0.25,
      cachedInputPerMillionTokens: 0.05,
      outputPerMillionTokens: 1.5,
    },
    {
      startsAboveInputTokens: 256_000,
      uncachedInputPerMillionTokens: 1,
      cachedInputPerMillionTokens: 0.2,
      outputPerMillionTokens: 4,
    },
  ],
};

const qwenUsageSchema = z
  .object({
    prompt_tokens: z.number().int().nonnegative(),
    completion_tokens: z.number().int().nonnegative(),
    prompt_tokens_details: z
      .object({
        cached_tokens: z.number().int().nonnegative().optional(),
      })
      .passthrough()
      .optional(),
  })
  .refine((usage) => {
    const cachedTokens = usage.prompt_tokens_details?.cached_tokens;

    if (cachedTokens !== undefined && cachedTokens > usage.prompt_tokens) {
      return false;
    }
    return true;
  })
  .passthrough();

const qwenToolCallSchema = z
  .object({
    id: z.string().optional(),
    index: z.number().int().nonnegative().optional(),
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
        tool_calls: z.array(qwenToolCallSchema).optional(),
      })
      .passthrough()
      .optional(),
    finish_reason: z.string().nullable().optional(),
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
type QwenStreamChunk = z.infer<typeof qwenStreamChunkSchema>;

export interface QwenConfig {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly retry?: ProviderRetryConfig;
}

function parseQwenChunk(data: string): QwenStreamChunk {
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
  const cachedInputTokens = usage.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    inputTokens: usage.prompt_tokens,
    cachedInputTokens,
    uncachedInputTokens: usage.prompt_tokens - cachedInputTokens,
    outputTokens: usage.completion_tokens,
  };
}

function captureQwenUsage(
  state: OpenAICompatibleStreamState,
  chunk: QwenStreamChunk,
): void {
  const usage = chunk.usage;
  if (usage === undefined || usage === null) {
    return;
  }
  state.usage = usageFromQwenUsage(usage);
}

export function qwenCostModel(model: string): CostModel | null {
  if (model === "qwen3.7-max") return QWEN_3_7_MAX_COST_MODEL;
  if (model === "qwen3.7-plus") return QWEN_3_7_PLUS_COST_MODEL;
  if (model === "qwen3.6-flash") return QWEN_3_6_FLASH_COST_MODEL;
  if (model === "qwen3.6-flash-2026-04-16") {
    return QWEN_3_6_FLASH_COST_MODEL;
  }
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
