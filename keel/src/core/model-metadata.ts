import { type CostModel, ZERO_COST_MODEL } from "./cost.ts";
import { type ProviderId, providerIds } from "./provider-id.ts";

export interface ModelCapabilities {
  readonly textInput: boolean;
  readonly toolCalls: boolean;
  readonly reasoning: boolean;
}

export type ModelMetadata =
  | {
      readonly status: "known";
      readonly source: "registry";
      readonly contextWindowTokens: number | null;
      readonly maxOutputTokens: number | null;
      readonly capabilities: ModelCapabilities;
      readonly costModel: CostModel | null;
      readonly lastVerified: string;
    }
  | { readonly status: "unknown" };

export type KnownModelMetadata = Extract<
  ModelMetadata,
  { readonly status: "known" }
>;

export function modelMetadataMaxOutputTokens(
  metadata: ModelMetadata | undefined,
): number | undefined {
  if (
    metadata === undefined ||
    metadata.status === "unknown" ||
    metadata.maxOutputTokens === null
  ) {
    return undefined;
  }
  return metadata.maxOutputTokens;
}

export interface KnownModelMetadataEntry {
  readonly providerId: ProviderId;
  readonly model: string;
  readonly metadata: KnownModelMetadata;
}

type ModelMetadataRegistry = Record<
  ProviderId,
  Readonly<Record<string, KnownModelMetadata>>
>;

const MODEL_METADATA_LAST_VERIFIED = "2026-06-26";

function verifiedMetadata(
  metadata: Omit<KnownModelMetadata, "lastVerified">,
): KnownModelMetadata {
  return { ...metadata, lastVerified: MODEL_METADATA_LAST_VERIFIED };
}

const DEEPSEEK_V4_FLASH_COST_MODEL: CostModel = {
  type: "fixed",
  uncachedInputPerMillionTokens: 0.14,
  cachedInputPerMillionTokens: 0.0028,
  outputPerMillionTokens: 0.28,
};

const DEEPSEEK_V4_PRO_COST_MODEL: CostModel = {
  type: "fixed",
  uncachedInputPerMillionTokens: 0.435,
  cachedInputPerMillionTokens: 0.003625,
  outputPerMillionTokens: 0.87,
};

const KIMI_K2_6_COST_MODEL: CostModel = {
  type: "fixed",
  uncachedInputPerMillionTokens: 0.95,
  cachedInputPerMillionTokens: 0.16,
  outputPerMillionTokens: 4,
};

const QWEN_3_7_MAX_COST_MODEL: CostModel = {
  type: "fixed",
  uncachedInputPerMillionTokens: 2.5,
  cachedInputPerMillionTokens: 0.5,
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

const TEXT_TOOL_REASONING_CAPABILITIES: ModelCapabilities = {
  textInput: true,
  toolCalls: true,
  reasoning: true,
};

const TEXT_TOOL_CAPABILITIES: ModelCapabilities = {
  textInput: true,
  toolCalls: true,
  reasoning: false,
};

const QWEN_3_6_FLASH_METADATA: KnownModelMetadata = verifiedMetadata({
  status: "known",
  source: "registry",
  contextWindowTokens: 1_000_000,
  maxOutputTokens: 65_536,
  capabilities: TEXT_TOOL_REASONING_CAPABILITIES,
  costModel: QWEN_3_6_FLASH_COST_MODEL,
});

const MODEL_METADATA_REGISTRY: ModelMetadataRegistry = {
  fake: {
    fake: verifiedMetadata({
      status: "known",
      source: "registry",
      contextWindowTokens: null,
      maxOutputTokens: null,
      capabilities: TEXT_TOOL_CAPABILITIES,
      costModel: ZERO_COST_MODEL,
    }),
  },
  deepseek: {
    "deepseek-v4-flash": verifiedMetadata({
      status: "known",
      source: "registry",
      contextWindowTokens: 1_000_000,
      maxOutputTokens: 384_000,
      capabilities: TEXT_TOOL_REASONING_CAPABILITIES,
      costModel: DEEPSEEK_V4_FLASH_COST_MODEL,
    }),
    "deepseek-v4-pro": verifiedMetadata({
      status: "known",
      source: "registry",
      contextWindowTokens: 1_000_000,
      maxOutputTokens: 384_000,
      capabilities: TEXT_TOOL_REASONING_CAPABILITIES,
      costModel: DEEPSEEK_V4_PRO_COST_MODEL,
    }),
  },
  kimi: {
    "kimi-k2.6": verifiedMetadata({
      status: "known",
      source: "registry",
      contextWindowTokens: 262_144,
      maxOutputTokens: 32_768,
      capabilities: TEXT_TOOL_REASONING_CAPABILITIES,
      costModel: KIMI_K2_6_COST_MODEL,
    }),
  },
  qwen: {
    "qwen3.7-max": verifiedMetadata({
      status: "known",
      source: "registry",
      contextWindowTokens: 1_000_000,
      maxOutputTokens: 65_536,
      capabilities: TEXT_TOOL_REASONING_CAPABILITIES,
      costModel: QWEN_3_7_MAX_COST_MODEL,
    }),
    "qwen3.7-plus": verifiedMetadata({
      status: "known",
      source: "registry",
      contextWindowTokens: 1_000_000,
      maxOutputTokens: 65_536,
      capabilities: TEXT_TOOL_REASONING_CAPABILITIES,
      costModel: QWEN_3_7_PLUS_COST_MODEL,
    }),
    "qwen3.6-flash": QWEN_3_6_FLASH_METADATA,
    "qwen3.6-flash-2026-04-16": QWEN_3_6_FLASH_METADATA,
  },
};

export function knownModelMetadataEntries(): readonly KnownModelMetadataEntry[] {
  const entries: KnownModelMetadataEntry[] = [];
  for (const providerId of providerIds) {
    const models = MODEL_METADATA_REGISTRY[providerId];
    for (const [model, metadata] of Object.entries(models)) {
      entries.push({ providerId, model, metadata });
    }
  }
  return entries;
}

export function modelMetadata(
  providerId: ProviderId,
  model: string,
): ModelMetadata {
  return MODEL_METADATA_REGISTRY[providerId][model] ?? { status: "unknown" };
}

export function modelCostModel(
  providerId: ProviderId,
  model: string,
): CostModel | null {
  const metadata = modelMetadata(providerId, model);
  if (metadata.status === "unknown") return null;
  return metadata.costModel;
}
