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

// Kimi K2.6 prices are per 1M tokens.
export const KIMI_K2_6_COST_MODEL: CostModel = {
  uncachedInputPerMillionTokens: 0.95,
  cachedInputPerMillionTokens: 0.16,
  outputPerMillionTokens: 4,
};

const kimiUsageSchema = z
  .object({
    prompt_tokens: z.number(),
    completion_tokens: z.number(),
    prompt_cache_hit_tokens: z.number().optional(),
    prompt_cache_miss_tokens: z.number().optional(),
    prompt_tokens_details: z
      .object({
        cached_tokens: z.number().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const kimiToolCallSchema = z
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

const kimiChoiceSchema = z
  .object({
    delta: z
      .object({
        content: z.string().nullable().optional(),
        reasoning_content: z.string().nullable().optional(),
        tool_calls: z.array(kimiToolCallSchema).optional(),
      })
      .passthrough()
      .optional(),
    finish_reason: z.string().nullable().optional(),
    usage: kimiUsageSchema.nullable().optional(),
  })
  .passthrough();

const kimiStreamChunkSchema = z
  .object({
    choices: z.array(kimiChoiceSchema).optional(),
    usage: kimiUsageSchema.nullable().optional(),
  })
  .passthrough()
  .refine((chunk) => chunk.choices !== undefined || chunk.usage !== undefined);

type KimiUsage = z.infer<typeof kimiUsageSchema>;

export interface KimiConfig {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly model: string;
}

function parseKimiChunk(data: string): OpenAICompatibleChunk {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    throw new KeelError(
      "provider_protocol_error",
      "Kimi stream chunk has invalid JSON",
    );
  }

  const result = kimiStreamChunkSchema.safeParse(parsed);
  if (!result.success) {
    throw new KeelError(
      "provider_protocol_error",
      "Kimi stream chunk has invalid schema",
    );
  }
  return result.data;
}

function usageFromKimiUsage(usage: KimiUsage): Usage {
  const cachedInputTokens =
    usage.prompt_cache_hit_tokens ??
    usage.prompt_tokens_details?.cached_tokens ??
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

function captureKimiUsage(
  state: OpenAICompatibleStreamState,
  chunk: OpenAICompatibleChunk,
  choice: OpenAICompatibleChoice | undefined,
): void {
  const usageResult = kimiUsageSchema
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
  state.usage = usageFromKimiUsage(usageResult.data);
}

export function createKimiProvider(config: KimiConfig) {
  return createOpenAICompatibleProvider({
    id: "kimi",
    providerName: "Kimi",
    config,
    parseChunk: parseKimiChunk,
    captureUsage: captureKimiUsage,
  });
}
