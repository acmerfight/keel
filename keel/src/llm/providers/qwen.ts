import { z } from "zod";
import type { CostModel } from "../../core/cost.ts";
import { KeelError } from "../../core/error.ts";
import type { Usage } from "../types.ts";
import {
  createOpenAICompatibleProvider,
  type OpenAICompatibleChunk,
  type OpenAICompatibleStreamState,
  type ProviderRetryConfig,
} from "./openai-compatible.ts";

const QWEN_3_7_MAX_COST_MODEL: CostModel = {
  uncachedInputPerMillionTokens: 2.5,
  cachedInputPerMillionTokens: 0.25,
  outputPerMillionTokens: 7.5,
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

export interface QwenConfig {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly retry?: ProviderRetryConfig;
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
  chunk: OpenAICompatibleChunk,
): void {
  const usageResult = qwenUsageSchema
    .nullable()
    .optional()
    .safeParse(chunk.usage);
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
