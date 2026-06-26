import { z } from "zod";
import type { CostModel } from "./cost.ts";
import {
  type KnownModelMetadata,
  knownModelMetadataEntries,
  modelMetadata,
} from "./model-metadata.ts";
import type { ProviderId } from "./provider-id.ts";

type ModelsDevProviderId = "deepseek" | "moonshotai" | "alibaba";

interface ModelMetadataDriftTarget {
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
    /* v8 ignore next 3: current known registry entries all carry cost metadata. */
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
  /* v8 ignore next 8: comparable tiered models are constructed with at least a base tier. */
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
    /* v8 ignore next 3: comparedTierCount is bounded by both arrays. */
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

  /* v8 ignore next 4: fixed and mismatched cost models return above. */
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

export function formatModelMetadataDriftReport(
  drift: readonly ModelMetadataDrift[],
): string {
  if (drift.length === 0) {
    return "No model metadata drift detected against models.dev.";
  }
  const lines = ["Model metadata drift detected against models.dev:"];
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

export function formatUntrackedModelsDevModelsReport(
  untracked: readonly UntrackedModelsDevModel[],
): string {
  if (untracked.length === 0) {
    return "No untracked models.dev models detected.";
  }
  const lines = ["Untracked models.dev models detected:"];
  for (const item of untracked) {
    lines.push(
      `- ${item.providerId}/${item.modelsDevModel} (models.dev ${item.modelsDevProviderId}/${item.modelsDevModel})`,
    );
  }
  return lines.join("\n");
}
