import { z } from "zod";
import type { CostModel } from "./cost.ts";
import {
  type KnownModelMetadata,
  knownModelMetadataEntries,
  modelMetadata,
} from "./model-metadata.ts";
import type { ProviderId } from "./provider-id.ts";

type ModelsDevProviderId = "deepseek" | "moonshotai" | "alibaba";

export interface ModelMetadataDriftTarget {
  readonly providerId: ProviderId;
  readonly model: string;
  readonly modelsDevProviderId: ModelsDevProviderId;
  readonly modelsDevModel: string;
}

interface ModelsDevProviderMapping {
  readonly providerId: ProviderId;
  readonly modelsDevProviderId: ModelsDevProviderId;
  readonly discoveryModelPrefixes: readonly string[];
}

interface ModelMetadataDifference {
  readonly field: string;
  readonly registryValue: string;
  readonly modelsDevValue: string;
}

export interface ModelMetadataDrift {
  readonly providerId: ProviderId;
  readonly model: string;
  readonly modelsDevProviderId: ModelsDevProviderId;
  readonly modelsDevModel: string;
  readonly differences: readonly ModelMetadataDifference[];
}

export interface UntrackedModelsDevModel {
  readonly providerId: ProviderId;
  readonly modelsDevProviderId: ModelsDevProviderId;
  readonly modelsDevModel: string;
}

interface AcceptedModelMetadataDifference extends ModelMetadataDifference {
  readonly reviewedAt: string;
  readonly reason: string;
}

export interface AcceptedModelMetadataDrift {
  readonly providerId: ProviderId;
  readonly model: string;
  readonly modelsDevProviderId: ModelsDevProviderId;
  readonly modelsDevModel: string;
  readonly differences: readonly AcceptedModelMetadataDifference[];
}

interface AcceptedModelMetadataDifferenceBaseline
  extends AcceptedModelMetadataDifference {
  readonly providerId: ProviderId;
  readonly model: string;
  readonly modelsDevProviderId: ModelsDevProviderId;
  readonly modelsDevModel: string;
}

interface AcceptedUntrackedModelsDevModel extends UntrackedModelsDevModel {
  readonly reviewedAt: string;
  readonly reason: string;
}

export interface ModelMetadataDriftCheckResult {
  readonly actionableDrift: readonly ModelMetadataDrift[];
  readonly acceptedDrift: readonly AcceptedModelMetadataDrift[];
  readonly unmonitoredRegistryEntries: readonly string[];
  readonly actionableUntracked: readonly UntrackedModelsDevModel[];
  readonly acceptedUntracked: readonly AcceptedUntrackedModelsDevModel[];
}

export interface ClassifyModelMetadataAgainstModelsDevOptions {
  readonly targets?: readonly ModelMetadataDriftTarget[];
  readonly acceptedDifferences?: readonly AcceptedModelMetadataDifferenceBaseline[];
  readonly acceptedUntrackedModels?: readonly AcceptedUntrackedModelsDevModel[];
}

interface ComparableCostRates {
  readonly uncachedInputPerMillionTokens: number | null;
  readonly cachedInputPerMillionTokens: number | null;
  readonly outputPerMillionTokens: number | null;
}

type ComparableCostModel =
  | ({
      readonly type: "fixed";
    } & ComparableCostRates)
  | {
      readonly type: "input-token-tiers";
      readonly tiers: readonly ComparableInputTokenCostTier[];
    };

interface ComparableInputTokenCostTier extends ComparableCostRates {
  readonly startsAboveInputTokens: number | null;
}

interface ComparableModelMetadata {
  readonly contextWindowTokens: number | null;
  readonly maxOutputTokens: number | null;
  readonly capabilities: {
    readonly textInput: boolean;
    readonly toolCalls: boolean;
    readonly reasoning: boolean;
  };
  readonly costModel: ComparableCostModel | null;
}

const finiteNumberSchema = z.number().finite();

const modelsDevCostTierSchema = z
  .object({
    input: finiteNumberSchema.optional(),
    output: finiteNumberSchema.optional(),
    cache_read: finiteNumberSchema.optional(),
    tier: z
      .object({
        type: z.literal("context"),
        size: finiteNumberSchema.optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const modelsDevCostSchema = z
  .object({
    input: finiteNumberSchema.optional(),
    output: finiteNumberSchema.optional(),
    cache_read: finiteNumberSchema.optional(),
    tiers: z.array(modelsDevCostTierSchema).optional(),
  })
  .passthrough();

const modelsDevModelSchema = z
  .object({
    limit: z
      .object({
        context: finiteNumberSchema.optional(),
        output: finiteNumberSchema.optional(),
      })
      .passthrough()
      .optional(),
    reasoning: z.boolean().optional(),
    tool_call: z.boolean().optional(),
    cost: modelsDevCostSchema.optional(),
  })
  .passthrough();

const modelsDevProviderSchema = z
  .object({
    models: z.record(z.string(), z.unknown()),
  })
  .passthrough();

const modelsDevCatalogSchema = z
  .object({
    deepseek: modelsDevProviderSchema.optional(),
    moonshotai: modelsDevProviderSchema.optional(),
    alibaba: modelsDevProviderSchema.optional(),
  })
  .passthrough();

export type ModelsDevCatalog = z.infer<typeof modelsDevCatalogSchema>;
type ModelsDevCost = z.infer<typeof modelsDevCostSchema>;
type ModelsDevModel = z.infer<typeof modelsDevModelSchema>;

const MODEL_METADATA_DRIFT_TARGETS = [
  {
    providerId: "deepseek",
    model: "deepseek-v4-flash",
    modelsDevProviderId: "deepseek",
    modelsDevModel: "deepseek-v4-flash",
  },
  {
    providerId: "deepseek",
    model: "deepseek-v4-pro",
    modelsDevProviderId: "deepseek",
    modelsDevModel: "deepseek-v4-pro",
  },
  {
    providerId: "kimi",
    model: "kimi-k2.6",
    modelsDevProviderId: "moonshotai",
    modelsDevModel: "kimi-k2.6",
  },
  {
    providerId: "qwen",
    model: "qwen3.7-max",
    modelsDevProviderId: "alibaba",
    modelsDevModel: "qwen3.7-max",
  },
  {
    providerId: "qwen",
    model: "qwen3.7-plus",
    modelsDevProviderId: "alibaba",
    modelsDevModel: "qwen3.7-plus",
  },
  {
    providerId: "qwen",
    model: "qwen3.6-flash",
    modelsDevProviderId: "alibaba",
    modelsDevModel: "qwen3.6-flash",
  },
  {
    providerId: "qwen",
    model: "qwen3.6-flash-2026-04-16",
    modelsDevProviderId: "alibaba",
    modelsDevModel: "qwen3.6-flash",
  },
] as const satisfies readonly ModelMetadataDriftTarget[];

// Keep discovery prefixes narrow to avoid older-family noise; extend this list
// when a new provider family should be adjudicated by the registry.
const MODELS_DEV_PROVIDER_MAPPINGS = [
  {
    providerId: "deepseek",
    modelsDevProviderId: "deepseek",
    discoveryModelPrefixes: ["deepseek-v"],
  },
  {
    providerId: "kimi",
    modelsDevProviderId: "moonshotai",
    discoveryModelPrefixes: ["kimi-k2."],
  },
  {
    providerId: "qwen",
    modelsDevProviderId: "alibaba",
    discoveryModelPrefixes: ["qwen3.6-", "qwen3.7-"],
  },
] as const satisfies readonly ModelsDevProviderMapping[];

const KIMI_K2_6_OUTPUT_ACCEPTED_REASON =
  "models.dev currently reports the Kimi context window as the output limit; Keel keeps the provider-documented output cap.";
const QWEN_3_7_PLUS_PRICE_ACCEPTED_REASON =
  "models.dev shows a different DashScope price table than Keel's adjudicated provider metadata.";
const QWEN_3_6_FLASH_PRICE_ACCEPTED_REASON =
  "models.dev flattens the current Qwen Flash prices while Keel keeps the tiered provider metadata.";
const UNTRACKED_CURRENT_FAMILY_ACCEPTED_REASON =
  "Current-family model is known in models.dev but not yet added to Keel's curated registry.";

const ACCEPTED_MODEL_METADATA_DRIFT_DIFFERENCES: readonly AcceptedModelMetadataDifferenceBaseline[] =
  [
    {
      providerId: "kimi",
      model: "kimi-k2.6",
      modelsDevProviderId: "moonshotai",
      modelsDevModel: "kimi-k2.6",
      field: "maxOutputTokens",
      registryValue: "32768",
      modelsDevValue: "262144",
      reviewedAt: "2026-06-26",
      reason: KIMI_K2_6_OUTPUT_ACCEPTED_REASON,
    },
    {
      providerId: "qwen",
      model: "qwen3.7-plus",
      modelsDevProviderId: "alibaba",
      modelsDevModel: "qwen3.7-plus",
      field: "costModel.tiers[0].uncachedInputPerMillionTokens",
      registryValue: "0.4",
      modelsDevValue: "0.5",
      reviewedAt: "2026-06-26",
      reason: QWEN_3_7_PLUS_PRICE_ACCEPTED_REASON,
    },
    {
      providerId: "qwen",
      model: "qwen3.7-plus",
      modelsDevProviderId: "alibaba",
      modelsDevModel: "qwen3.7-plus",
      field: "costModel.tiers[0].cachedInputPerMillionTokens",
      registryValue: "0.08",
      modelsDevValue: "0.05",
      reviewedAt: "2026-06-26",
      reason: QWEN_3_7_PLUS_PRICE_ACCEPTED_REASON,
    },
    {
      providerId: "qwen",
      model: "qwen3.7-plus",
      modelsDevProviderId: "alibaba",
      modelsDevModel: "qwen3.7-plus",
      field: "costModel.tiers[0].outputPerMillionTokens",
      registryValue: "1.6",
      modelsDevValue: "3",
      reviewedAt: "2026-06-26",
      reason: QWEN_3_7_PLUS_PRICE_ACCEPTED_REASON,
    },
    {
      providerId: "qwen",
      model: "qwen3.7-plus",
      modelsDevProviderId: "alibaba",
      modelsDevModel: "qwen3.7-plus",
      field: "costModel.tiers[1].uncachedInputPerMillionTokens",
      registryValue: "1.2",
      modelsDevValue: "2",
      reviewedAt: "2026-06-26",
      reason: QWEN_3_7_PLUS_PRICE_ACCEPTED_REASON,
    },
    {
      providerId: "qwen",
      model: "qwen3.7-plus",
      modelsDevProviderId: "alibaba",
      modelsDevModel: "qwen3.7-plus",
      field: "costModel.tiers[1].cachedInputPerMillionTokens",
      registryValue: "0.24",
      modelsDevValue: "0.2",
      reviewedAt: "2026-06-26",
      reason: QWEN_3_7_PLUS_PRICE_ACCEPTED_REASON,
    },
    {
      providerId: "qwen",
      model: "qwen3.7-plus",
      modelsDevProviderId: "alibaba",
      modelsDevModel: "qwen3.7-plus",
      field: "costModel.tiers[1].outputPerMillionTokens",
      registryValue: "4.8",
      modelsDevValue: "6",
      reviewedAt: "2026-06-26",
      reason: QWEN_3_7_PLUS_PRICE_ACCEPTED_REASON,
    },
    {
      providerId: "qwen",
      model: "qwen3.6-flash",
      modelsDevProviderId: "alibaba",
      modelsDevModel: "qwen3.6-flash",
      field: "costModel.type",
      registryValue: "input-token-tiers",
      modelsDevValue: "fixed",
      reviewedAt: "2026-06-26",
      reason: QWEN_3_6_FLASH_PRICE_ACCEPTED_REASON,
    },
    {
      providerId: "qwen",
      model: "qwen3.6-flash",
      modelsDevProviderId: "alibaba",
      modelsDevModel: "qwen3.6-flash",
      field: "costModel.base.uncachedInputPerMillionTokens",
      registryValue: "0.25",
      modelsDevValue: "0.1875",
      reviewedAt: "2026-06-26",
      reason: QWEN_3_6_FLASH_PRICE_ACCEPTED_REASON,
    },
    {
      providerId: "qwen",
      model: "qwen3.6-flash",
      modelsDevProviderId: "alibaba",
      modelsDevModel: "qwen3.6-flash",
      field: "costModel.base.cachedInputPerMillionTokens",
      registryValue: "0.05",
      modelsDevValue: "null",
      reviewedAt: "2026-06-26",
      reason: QWEN_3_6_FLASH_PRICE_ACCEPTED_REASON,
    },
    {
      providerId: "qwen",
      model: "qwen3.6-flash",
      modelsDevProviderId: "alibaba",
      modelsDevModel: "qwen3.6-flash",
      field: "costModel.base.outputPerMillionTokens",
      registryValue: "1.5",
      modelsDevValue: "1.125",
      reviewedAt: "2026-06-26",
      reason: QWEN_3_6_FLASH_PRICE_ACCEPTED_REASON,
    },
    {
      providerId: "qwen",
      model: "qwen3.6-flash-2026-04-16",
      modelsDevProviderId: "alibaba",
      modelsDevModel: "qwen3.6-flash",
      field: "costModel.type",
      registryValue: "input-token-tiers",
      modelsDevValue: "fixed",
      reviewedAt: "2026-06-26",
      reason: QWEN_3_6_FLASH_PRICE_ACCEPTED_REASON,
    },
    {
      providerId: "qwen",
      model: "qwen3.6-flash-2026-04-16",
      modelsDevProviderId: "alibaba",
      modelsDevModel: "qwen3.6-flash",
      field: "costModel.base.uncachedInputPerMillionTokens",
      registryValue: "0.25",
      modelsDevValue: "0.1875",
      reviewedAt: "2026-06-26",
      reason: QWEN_3_6_FLASH_PRICE_ACCEPTED_REASON,
    },
    {
      providerId: "qwen",
      model: "qwen3.6-flash-2026-04-16",
      modelsDevProviderId: "alibaba",
      modelsDevModel: "qwen3.6-flash",
      field: "costModel.base.cachedInputPerMillionTokens",
      registryValue: "0.05",
      modelsDevValue: "null",
      reviewedAt: "2026-06-26",
      reason: QWEN_3_6_FLASH_PRICE_ACCEPTED_REASON,
    },
    {
      providerId: "qwen",
      model: "qwen3.6-flash-2026-04-16",
      modelsDevProviderId: "alibaba",
      modelsDevModel: "qwen3.6-flash",
      field: "costModel.base.outputPerMillionTokens",
      registryValue: "1.5",
      modelsDevValue: "1.125",
      reviewedAt: "2026-06-26",
      reason: QWEN_3_6_FLASH_PRICE_ACCEPTED_REASON,
    },
  ];

const ACCEPTED_UNTRACKED_MODELS_DEV_MODELS: readonly AcceptedUntrackedModelsDevModel[] =
  [
    {
      providerId: "kimi",
      modelsDevProviderId: "moonshotai",
      modelsDevModel: "kimi-k2.5",
      reviewedAt: "2026-06-26",
      reason: UNTRACKED_CURRENT_FAMILY_ACCEPTED_REASON,
    },
    {
      providerId: "kimi",
      modelsDevProviderId: "moonshotai",
      modelsDevModel: "kimi-k2.7-code",
      reviewedAt: "2026-06-26",
      reason: UNTRACKED_CURRENT_FAMILY_ACCEPTED_REASON,
    },
    {
      providerId: "kimi",
      modelsDevProviderId: "moonshotai",
      modelsDevModel: "kimi-k2.7-code-highspeed",
      reviewedAt: "2026-06-26",
      reason: UNTRACKED_CURRENT_FAMILY_ACCEPTED_REASON,
    },
    {
      providerId: "qwen",
      modelsDevProviderId: "alibaba",
      modelsDevModel: "qwen3.6-27b",
      reviewedAt: "2026-06-26",
      reason: UNTRACKED_CURRENT_FAMILY_ACCEPTED_REASON,
    },
    {
      providerId: "qwen",
      modelsDevProviderId: "alibaba",
      modelsDevModel: "qwen3.6-35b-a3b",
      reviewedAt: "2026-06-26",
      reason: UNTRACKED_CURRENT_FAMILY_ACCEPTED_REASON,
    },
    {
      providerId: "qwen",
      modelsDevProviderId: "alibaba",
      modelsDevModel: "qwen3.6-max-preview",
      reviewedAt: "2026-06-26",
      reason: UNTRACKED_CURRENT_FAMILY_ACCEPTED_REASON,
    },
    {
      providerId: "qwen",
      modelsDevProviderId: "alibaba",
      modelsDevModel: "qwen3.6-plus",
      reviewedAt: "2026-06-26",
      reason: UNTRACKED_CURRENT_FAMILY_ACCEPTED_REASON,
    },
  ];

export function parseModelsDevCatalog(raw: unknown): ModelsDevCatalog {
  const result = modelsDevCatalogSchema.safeParse(raw);
  if (!result.success) {
    throw new Error("models.dev catalog has invalid schema");
  }
  return result.data;
}

function comparableRegistryMetadata(
  metadata: KnownModelMetadata,
): ComparableModelMetadata {
  return {
    contextWindowTokens: metadata.contextWindowTokens,
    maxOutputTokens: metadata.maxOutputTokens,
    capabilities: metadata.capabilities,
    // current known registry entries all carry cost metadata.
    costModel:
      metadata.costModel === null
        ? null
        : comparableRegistryCostModel(metadata.costModel),
  };
}

function comparableRegistryCostModel(model: CostModel): ComparableCostModel {
  if (model.type === "fixed") {
    return {
      type: "fixed",
      uncachedInputPerMillionTokens: model.uncachedInputPerMillionTokens,
      cachedInputPerMillionTokens: model.cachedInputPerMillionTokens,
      outputPerMillionTokens: model.outputPerMillionTokens,
    };
  }
  return {
    type: "input-token-tiers",
    tiers: model.tiers.map((tier) => ({
      startsAboveInputTokens: tier.startsAboveInputTokens,
      uncachedInputPerMillionTokens: tier.uncachedInputPerMillionTokens,
      cachedInputPerMillionTokens: tier.cachedInputPerMillionTokens,
      outputPerMillionTokens: tier.outputPerMillionTokens,
    })),
  };
}

function comparableModelsDevMetadata(
  model: ModelsDevModel,
): ComparableModelMetadata {
  return {
    contextWindowTokens: model.limit?.context ?? null,
    maxOutputTokens: model.limit?.output ?? null,
    capabilities: {
      // models.dev has no explicit text-input field for these text model entries.
      textInput: true,
      toolCalls: model.tool_call === true,
      reasoning: model.reasoning === true,
    },
    costModel:
      model.cost === undefined
        ? null
        : comparableModelsDevCostModel(model.cost),
  };
}

function comparableModelsDevCostModel(
  cost: ModelsDevCost,
): ComparableCostModel {
  const baseRates = {
    uncachedInputPerMillionTokens: cost.input ?? null,
    cachedInputPerMillionTokens: cost.cache_read ?? null,
    outputPerMillionTokens: cost.output ?? null,
  };
  const tiers = cost.tiers ?? [];
  if (tiers.length === 0) {
    return { type: "fixed", ...baseRates };
  }
  return {
    type: "input-token-tiers",
    tiers: [
      { startsAboveInputTokens: 0, ...baseRates },
      ...tiers.map((tier) => ({
        startsAboveInputTokens: tier.tier?.size ?? null,
        uncachedInputPerMillionTokens: tier.input ?? null,
        cachedInputPerMillionTokens: tier.cache_read ?? null,
        outputPerMillionTokens: tier.output ?? null,
      })),
    ],
  };
}

function costModelBaseRates(model: ComparableCostModel): ComparableCostRates {
  if (model.type === "fixed") {
    return model;
  }
  const firstTier = model.tiers[0];
  // comparable tiered models are constructed with at least a base tier.
  if (firstTier === undefined) {
    return {
      uncachedInputPerMillionTokens: null,
      cachedInputPerMillionTokens: null,
      outputPerMillionTokens: null,
    };
  }
  return firstTier;
}

function valueString(value: number | boolean | string | null): string {
  return value === null ? "null" : String(value);
}

function pushDifference(
  differences: ModelMetadataDifference[],
  field: string,
  registryValue: number | boolean | string | null,
  modelsDevValue: number | boolean | string | null,
): void {
  if (registryValue === modelsDevValue) return;
  differences.push({
    field,
    registryValue: valueString(registryValue),
    modelsDevValue: valueString(modelsDevValue),
  });
}

function pushRateDifferences(
  differences: ModelMetadataDifference[],
  prefix: string,
  registry: ComparableCostRates,
  modelsDev: ComparableCostRates,
): void {
  pushDifference(
    differences,
    `${prefix}.uncachedInputPerMillionTokens`,
    registry.uncachedInputPerMillionTokens,
    modelsDev.uncachedInputPerMillionTokens,
  );
  pushDifference(
    differences,
    `${prefix}.cachedInputPerMillionTokens`,
    registry.cachedInputPerMillionTokens,
    modelsDev.cachedInputPerMillionTokens,
  );
  pushDifference(
    differences,
    `${prefix}.outputPerMillionTokens`,
    registry.outputPerMillionTokens,
    modelsDev.outputPerMillionTokens,
  );
}

function costModelTypeLabel(model: ComparableCostModel | null): string {
  if (model === null) {
    return "null";
  }
  return model.type;
}

function pushTieredCostModelDifferences(
  differences: ModelMetadataDifference[],
  registry: Extract<
    ComparableCostModel,
    { readonly type: "input-token-tiers" }
  >,
  modelsDev: Extract<
    ComparableCostModel,
    { readonly type: "input-token-tiers" }
  >,
): void {
  pushDifference(
    differences,
    "costModel.tiers.length",
    registry.tiers.length,
    modelsDev.tiers.length,
  );
  const comparedTierCount = Math.min(
    registry.tiers.length,
    modelsDev.tiers.length,
  );
  for (let index = 0; index < comparedTierCount; index += 1) {
    const registryTier = registry.tiers[index];
    const modelsDevTier = modelsDev.tiers[index];
    // comparedTierCount is bounded by both arrays.
    if (registryTier === undefined || modelsDevTier === undefined) {
      continue;
    }
    pushDifference(
      differences,
      `costModel.tiers[${index}].startsAboveInputTokens`,
      registryTier.startsAboveInputTokens,
      modelsDevTier.startsAboveInputTokens,
    );
    pushRateDifferences(
      differences,
      `costModel.tiers[${index}]`,
      registryTier,
      modelsDevTier,
    );
  }
}

function pushCostModelDifferences(
  differences: ModelMetadataDifference[],
  registry: ComparableCostModel | null,
  modelsDev: ComparableCostModel | null,
): void {
  if (registry === null || modelsDev === null) {
    pushDifference(
      differences,
      "costModel",
      costModelTypeLabel(registry),
      costModelTypeLabel(modelsDev),
    );
    return;
  }

  pushDifference(differences, "costModel.type", registry.type, modelsDev.type);
  if (registry.type === "fixed" && modelsDev.type === "fixed") {
    pushRateDifferences(differences, "costModel", registry, modelsDev);
    return;
  }
  if (registry.type !== modelsDev.type) {
    const registryBaseRates = costModelBaseRates(registry);
    const modelsDevBaseRates = costModelBaseRates(modelsDev);
    pushRateDifferences(
      differences,
      "costModel.base",
      registryBaseRates,
      modelsDevBaseRates,
    );
    return;
  }

  // fixed and mismatched cost models return above.
  if (
    registry.type === "input-token-tiers" &&
    modelsDev.type === "input-token-tiers"
  ) {
    pushTieredCostModelDifferences(differences, registry, modelsDev);
  }
}

function pushMetadataDifferences(
  differences: ModelMetadataDifference[],
  registry: ComparableModelMetadata,
  modelsDev: ComparableModelMetadata,
): void {
  pushDifference(
    differences,
    "contextWindowTokens",
    registry.contextWindowTokens,
    modelsDev.contextWindowTokens,
  );
  pushDifference(
    differences,
    "maxOutputTokens",
    registry.maxOutputTokens,
    modelsDev.maxOutputTokens,
  );
  pushDifference(
    differences,
    "capabilities.textInput",
    registry.capabilities.textInput,
    modelsDev.capabilities.textInput,
  );
  pushDifference(
    differences,
    "capabilities.toolCalls",
    registry.capabilities.toolCalls,
    modelsDev.capabilities.toolCalls,
  );
  pushDifference(
    differences,
    "capabilities.reasoning",
    registry.capabilities.reasoning,
    modelsDev.capabilities.reasoning,
  );
  pushCostModelDifferences(
    differences,
    registry.costModel,
    modelsDev.costModel,
  );
}

function modelsDevModelForTarget(
  catalog: ModelsDevCatalog,
  target: ModelMetadataDriftTarget,
): ModelsDevModel | undefined {
  const rawModel =
    catalog[target.modelsDevProviderId]?.models[target.modelsDevModel];
  if (rawModel === undefined) {
    return undefined;
  }
  const result = modelsDevModelSchema.safeParse(rawModel);
  if (!result.success) {
    throw new Error(
      `models.dev model ${target.modelsDevProviderId}/${target.modelsDevModel} has invalid schema`,
    );
  }
  return result.data;
}

export function diffModelMetadataAgainstModelsDev(
  catalog: ModelsDevCatalog,
  targets: readonly ModelMetadataDriftTarget[] = MODEL_METADATA_DRIFT_TARGETS,
): readonly ModelMetadataDrift[] {
  const drift: ModelMetadataDrift[] = [];
  for (const target of targets) {
    const registry = modelMetadata(target.providerId, target.model);
    const external = modelsDevModelForTarget(catalog, target);
    const differences: ModelMetadataDifference[] = [];
    if (registry.status === "unknown") {
      differences.push({
        field: "registry",
        registryValue: "unknown",
        modelsDevValue: "known",
      });
    } else if (external === undefined) {
      differences.push({
        field: "models.dev",
        registryValue: "known",
        modelsDevValue: "missing",
      });
    } else {
      pushMetadataDifferences(
        differences,
        comparableRegistryMetadata(registry),
        comparableModelsDevMetadata(external),
      );
    }

    if (differences.length > 0) {
      drift.push({ ...target, differences });
    }
  }
  return drift;
}

export function unmonitoredKnownModelMetadataEntries(): readonly string[] {
  const monitored = new Set(
    MODEL_METADATA_DRIFT_TARGETS.map(
      (target) => `${target.providerId}/${target.model}`,
    ),
  );
  return knownModelMetadataEntries()
    .map((entry) => `${entry.providerId}/${entry.model}`)
    .filter((entry) => !entry.startsWith("fake/") && !monitored.has(entry));
}

function matchesDiscoveryModelPrefix(
  model: string,
  prefixes: readonly string[],
): boolean {
  return prefixes.some((prefix) => model.startsWith(prefix));
}

export function untrackedModelsDevModels(
  catalog: ModelsDevCatalog,
): readonly UntrackedModelsDevModel[] {
  const knownRegistryModels = new Set(
    knownModelMetadataEntries().map(
      (entry) => `${entry.providerId}/${entry.model}`,
    ),
  );
  const untracked: UntrackedModelsDevModel[] = [];
  for (const mapping of MODELS_DEV_PROVIDER_MAPPINGS) {
    const provider = catalog[mapping.modelsDevProviderId];
    if (provider === undefined) {
      continue;
    }
    for (const modelsDevModel of Object.keys(provider.models).sort()) {
      if (
        !matchesDiscoveryModelPrefix(
          modelsDevModel,
          mapping.discoveryModelPrefixes,
        )
      ) {
        continue;
      }
      const registryKey = `${mapping.providerId}/${modelsDevModel}`;
      if (knownRegistryModels.has(registryKey)) {
        continue;
      }
      untracked.push({
        providerId: mapping.providerId,
        modelsDevProviderId: mapping.modelsDevProviderId,
        modelsDevModel,
      });
    }
  }
  return untracked;
}

function acceptedDifferenceFor(
  item: ModelMetadataDrift,
  difference: ModelMetadataDifference,
  acceptedDifferences: readonly AcceptedModelMetadataDifferenceBaseline[],
): AcceptedModelMetadataDifferenceBaseline | undefined {
  return acceptedDifferences.find(
    (accepted) =>
      accepted.providerId === item.providerId &&
      accepted.model === item.model &&
      accepted.modelsDevProviderId === item.modelsDevProviderId &&
      accepted.modelsDevModel === item.modelsDevModel &&
      accepted.field === difference.field &&
      accepted.registryValue === difference.registryValue &&
      accepted.modelsDevValue === difference.modelsDevValue,
  );
}

function acceptedUntrackedModelFor(
  item: UntrackedModelsDevModel,
  acceptedUntrackedModels: readonly AcceptedUntrackedModelsDevModel[],
): AcceptedUntrackedModelsDevModel | undefined {
  return acceptedUntrackedModels.find(
    (accepted) =>
      accepted.providerId === item.providerId &&
      accepted.modelsDevProviderId === item.modelsDevProviderId &&
      accepted.modelsDevModel === item.modelsDevModel,
  );
}

function classifyModelMetadataDrift(
  drift: readonly ModelMetadataDrift[],
  acceptedDifferences: readonly AcceptedModelMetadataDifferenceBaseline[],
): {
  readonly actionableDrift: readonly ModelMetadataDrift[];
  readonly acceptedDrift: readonly AcceptedModelMetadataDrift[];
} {
  const actionableDrift: ModelMetadataDrift[] = [];
  const acceptedDrift: AcceptedModelMetadataDrift[] = [];

  for (const item of drift) {
    const actionableDifferences: ModelMetadataDifference[] = [];
    const acceptedItemDifferences: AcceptedModelMetadataDifference[] = [];

    for (const difference of item.differences) {
      const acceptedDifference = acceptedDifferenceFor(
        item,
        difference,
        acceptedDifferences,
      );
      if (acceptedDifference === undefined) {
        actionableDifferences.push(difference);
      } else {
        acceptedItemDifferences.push({
          field: difference.field,
          registryValue: difference.registryValue,
          modelsDevValue: difference.modelsDevValue,
          reviewedAt: acceptedDifference.reviewedAt,
          reason: acceptedDifference.reason,
        });
      }
    }

    if (actionableDifferences.length > 0) {
      actionableDrift.push({ ...item, differences: actionableDifferences });
    }
    if (acceptedItemDifferences.length > 0) {
      acceptedDrift.push({ ...item, differences: acceptedItemDifferences });
    }
  }

  return { actionableDrift, acceptedDrift };
}

function classifyUntrackedModelsDevModels(
  untracked: readonly UntrackedModelsDevModel[],
  acceptedUntrackedModels: readonly AcceptedUntrackedModelsDevModel[],
): {
  readonly actionableUntracked: readonly UntrackedModelsDevModel[];
  readonly acceptedUntracked: readonly AcceptedUntrackedModelsDevModel[];
} {
  const actionableUntracked: UntrackedModelsDevModel[] = [];
  const acceptedUntracked: AcceptedUntrackedModelsDevModel[] = [];

  for (const item of untracked) {
    const accepted = acceptedUntrackedModelFor(item, acceptedUntrackedModels);
    if (accepted === undefined) {
      actionableUntracked.push(item);
    } else {
      acceptedUntracked.push(accepted);
    }
  }

  return { actionableUntracked, acceptedUntracked };
}

export function classifyModelMetadataAgainstModelsDev(
  catalog: ModelsDevCatalog,
  options: ClassifyModelMetadataAgainstModelsDevOptions = {},
): ModelMetadataDriftCheckResult {
  const drift = diffModelMetadataAgainstModelsDev(
    catalog,
    options.targets ?? MODEL_METADATA_DRIFT_TARGETS,
  );
  const classifiedDrift = classifyModelMetadataDrift(
    drift,
    options.acceptedDifferences ?? ACCEPTED_MODEL_METADATA_DRIFT_DIFFERENCES,
  );
  const classifiedUntracked = classifyUntrackedModelsDevModels(
    untrackedModelsDevModels(catalog),
    options.acceptedUntrackedModels ?? ACCEPTED_UNTRACKED_MODELS_DEV_MODELS,
  );

  return {
    actionableDrift: classifiedDrift.actionableDrift,
    acceptedDrift: classifiedDrift.acceptedDrift,
    unmonitoredRegistryEntries: unmonitoredKnownModelMetadataEntries(),
    actionableUntracked: classifiedUntracked.actionableUntracked,
    acceptedUntracked: classifiedUntracked.acceptedUntracked,
  };
}

function formatActionableModelMetadataDriftReport(
  drift: readonly ModelMetadataDrift[],
): string {
  if (drift.length === 0) {
    return "No actionable model metadata drift detected against models.dev.";
  }
  const lines = [
    "Actionable model metadata drift detected against models.dev:",
  ];
  for (const item of drift) {
    lines.push(
      `- ${item.providerId}/${item.model} (models.dev ${item.modelsDevProviderId}/${item.modelsDevModel})`,
    );
    for (const difference of item.differences) {
      lines.push(
        `  ${difference.field}: registry=${difference.registryValue} models.dev=${difference.modelsDevValue}`,
      );
    }
  }
  return lines.join("\n");
}

export function formatAcceptedModelMetadataDriftReport(
  drift: readonly AcceptedModelMetadataDrift[],
): string {
  if (drift.length === 0) {
    return "No accepted model metadata drift recorded.";
  }
  const lines = ["Accepted model metadata drift against models.dev:"];
  for (const item of drift) {
    lines.push(
      `- ${item.providerId}/${item.model} (models.dev ${item.modelsDevProviderId}/${item.modelsDevModel})`,
    );
    for (const difference of item.differences) {
      lines.push(
        `  ${difference.field}: registry=${difference.registryValue} models.dev=${difference.modelsDevValue} (reviewed ${difference.reviewedAt}; ${difference.reason})`,
      );
    }
  }
  return lines.join("\n");
}

function formatActionableUntrackedModelsDevModelsReport(
  untracked: readonly UntrackedModelsDevModel[],
): string {
  if (untracked.length === 0) {
    return "No actionable untracked models.dev models detected.";
  }
  const lines = ["Actionable untracked models.dev models detected:"];
  for (const item of untracked) {
    lines.push(
      `- ${item.providerId}/${item.modelsDevModel} (models.dev ${item.modelsDevProviderId}/${item.modelsDevModel})`,
    );
  }
  return lines.join("\n");
}

function formatAcceptedUntrackedModelsDevModelsReport(
  untracked: readonly AcceptedUntrackedModelsDevModel[],
): string {
  if (untracked.length === 0) {
    return "No accepted untracked models.dev models recorded.";
  }
  const lines = ["Accepted untracked models.dev models:"];
  for (const item of untracked) {
    lines.push(
      `- ${item.providerId}/${item.modelsDevModel} (models.dev ${item.modelsDevProviderId}/${item.modelsDevModel}; reviewed ${item.reviewedAt}; ${item.reason})`,
    );
  }
  return lines.join("\n");
}

function formatUnmonitoredRegistryEntriesReport(
  entries: readonly string[],
): string {
  if (entries.length === 0) {
    return "No unmonitored registry entries detected.";
  }
  return `Unmonitored registry entries: ${entries.join(", ")}`;
}

export function hasActionableModelMetadataFindings(
  result: ModelMetadataDriftCheckResult,
): boolean {
  return (
    result.actionableDrift.length > 0 ||
    result.unmonitoredRegistryEntries.length > 0 ||
    result.actionableUntracked.length > 0
  );
}

export function formatModelMetadataCheckReport(
  result: ModelMetadataDriftCheckResult,
): string {
  return [
    formatActionableModelMetadataDriftReport(result.actionableDrift),
    formatAcceptedModelMetadataDriftReport(result.acceptedDrift),
    formatUnmonitoredRegistryEntriesReport(result.unmonitoredRegistryEntries),
    formatActionableUntrackedModelsDevModelsReport(result.actionableUntracked),
    formatAcceptedUntrackedModelsDevModelsReport(result.acceptedUntracked),
  ].join("\n\n");
}
