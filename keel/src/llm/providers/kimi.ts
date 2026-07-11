import { z } from "zod";
import { KeelError } from "../../core/error.ts";
import type { Usage } from "../types.ts";
import {
  createOpenAICompatibleProvider,
  type OpenAICompatibleStreamState,
  type ProviderRetryConfig,
} from "./openai-compatible.ts";

const kimiUsageSchema = z
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

const kimiToolCallSchema = z
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
type KimiChoice = z.infer<typeof kimiChoiceSchema>;
type KimiStreamChunk = z.infer<typeof kimiStreamChunkSchema>;

export interface KimiConfig {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly retry?: ProviderRetryConfig;
}

function parseKimiChunk(data: string): KimiStreamChunk {
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

function captureKimiUsage(
  state: OpenAICompatibleStreamState,
  chunk: KimiStreamChunk,
  choice: KimiChoice | undefined,
): void {
  const usage = choice?.usage ?? chunk.usage;
  if (usage === undefined || usage === null) {
    return;
  }
  state.usage = usageFromKimiUsage(usage);
}

export function createKimiProvider(config: KimiConfig) {
  return createOpenAICompatibleProvider({
    id: "kimi",
    providerName: "Kimi",
    config,
    messageOptions: { maxOutputTokensField: "max_completion_tokens" },
    parseChunk: parseKimiChunk,
    captureUsage: captureKimiUsage,
  });
}
