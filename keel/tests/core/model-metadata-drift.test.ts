import { describe, expect, test } from "vitest";
import {
  classifyModelMetadataAgainstModelsDev,
  diffModelMetadataAgainstModelsDev,
  formatAcceptedModelMetadataDriftReport,
  formatModelMetadataCheckReport,
  hasActionableModelMetadataFindings,
  type ModelMetadataDriftCheckResult,
  parseModelsDevCatalog,
  unmonitoredKnownModelMetadataEntries,
  untrackedModelsDevModels,
} from "../../src/core/model-metadata-drift.ts";

describe("Model Metadata Drift", () => {
  test(`Given a models.dev fixture that matches every monitored registry model,
    When metadata drift is checked,
    Then no drift is reported`, () => {
    // Given
    const catalog = parseModelsDevCatalog({
      deepseek: {
        models: {
          "deepseek-v4-flash": {
            limit: { context: 1_000_000, output: 384_000 },
            reasoning: true,
            tool_call: true,
            cost: {
              input: 0.14,
              cache_read: 0.0028,
              output: 0.28,
            },
          },
          "deepseek-v4-pro": {
            limit: { context: 1_000_000, output: 384_000 },
            reasoning: true,
            tool_call: true,
            cost: {
              input: 0.435,
              cache_read: 0.003625,
              output: 0.87,
            },
          },
        },
      },
      moonshotai: {
        models: {
          "kimi-k2.6": {
            limit: { context: 262_144, output: 32_768 },
            reasoning: true,
            tool_call: true,
            cost: {
              input: 0.95,
              cache_read: 0.16,
              output: 4,
            },
          },
        },
      },
      alibaba: {
        models: {
          "qwen3.7-max": {
            limit: { context: 1_000_000, output: 65_536 },
            reasoning: true,
            tool_call: true,
            cost: {
              input: 2.5,
              cache_read: 0.5,
              output: 7.5,
            },
          },
          "qwen3.7-plus": {
            limit: { context: 1_000_000, output: 65_536 },
            reasoning: true,
            tool_call: true,
            cost: {
              input: 0.4,
              cache_read: 0.08,
              output: 1.6,
              tiers: [
                {
                  input: 1.2,
                  cache_read: 0.24,
                  output: 4.8,
                  tier: { type: "context", size: 256_000 },
                },
              ],
            },
          },
          "qwen3.6-flash": {
            limit: { context: 1_000_000, output: 65_536 },
            reasoning: true,
            tool_call: true,
            cost: {
              input: 0.25,
              cache_read: 0.05,
              output: 1.5,
              tiers: [
                {
                  input: 1,
                  cache_read: 0.2,
                  output: 4,
                  tier: { type: "context", size: 256_000 },
                },
              ],
            },
          },
        },
      },
    });

    // When
    const drift = diffModelMetadataAgainstModelsDev(catalog);
    const classified = classifyModelMetadataAgainstModelsDev(catalog);

    // Then
    expect(drift).toEqual([]);
    expect(classified).toEqual({
      actionableDrift: [],
      acceptedDrift: [],
      unmonitoredRegistryEntries: [],
      actionableUntracked: [],
      acceptedUntracked: [],
    });
    expect(hasActionableModelMetadataFindings(classified)).toBe(false);
    expect(unmonitoredKnownModelMetadataEntries()).toEqual([]);
    expect(untrackedModelsDevModels(catalog)).toEqual([]);
  });

  test(`Given a models.dev fixture with a changed price,
    When metadata drift is checked,
    Then the changed field is reported with both values`, () => {
    // Given
    const catalog = parseModelsDevCatalog({
      deepseek: {
        models: {
          "deepseek-v4-flash": {
            limit: { context: 1_000_000, output: 384_000 },
            reasoning: true,
            tool_call: true,
            cost: {
              input: 0.14,
              cache_read: 0.0028,
              output: 0.29,
            },
          },
        },
      },
    });

    // When
    const drift = diffModelMetadataAgainstModelsDev(catalog, [
      {
        providerId: "deepseek",
        model: "deepseek-v4-flash",
        modelsDevProviderId: "deepseek",
        modelsDevModel: "deepseek-v4-flash",
      },
    ]);

    // Then
    expect(drift).toEqual([
      {
        providerId: "deepseek",
        model: "deepseek-v4-flash",
        modelsDevProviderId: "deepseek",
        modelsDevModel: "deepseek-v4-flash",
        differences: [
          {
            field: "costModel.outputPerMillionTokens",
            registryValue: "0.28",
            modelsDevValue: "0.29",
          },
        ],
      },
    ]);
  });

  test(`Given a models.dev fixture uses the context window as Kimi output,
    When metadata drift is checked,
    Then the placeholder-shaped output is still reported for human review`, () => {
    // Given
    const catalog = parseModelsDevCatalog({
      moonshotai: {
        models: {
          "kimi-k2.6": {
            limit: { context: 262_144, output: 262_144 },
            reasoning: true,
            tool_call: true,
            cost: {
              input: 0.95,
              cache_read: 0.16,
              output: 4,
            },
          },
        },
      },
    });

    // When
    const drift = diffModelMetadataAgainstModelsDev(catalog, [
      {
        providerId: "kimi",
        model: "kimi-k2.6",
        modelsDevProviderId: "moonshotai",
        modelsDevModel: "kimi-k2.6",
      },
    ]);

    // Then
    expect(drift).toEqual([
      {
        providerId: "kimi",
        model: "kimi-k2.6",
        modelsDevProviderId: "moonshotai",
        modelsDevModel: "kimi-k2.6",
        differences: [
          {
            field: "maxOutputTokens",
            registryValue: "32768",
            modelsDevValue: "262144",
          },
        ],
      },
    ]);
  });

  test(`Given a reviewed models.dev placeholder differs from the registry,
    When metadata drift is classified,
    Then the exact reviewed difference is accepted without actionable drift`, () => {
    // Given
    const catalog = parseModelsDevCatalog({
      moonshotai: {
        models: {
          "kimi-k2.6": {
            limit: { context: 262_144, output: 262_144 },
            reasoning: true,
            tool_call: true,
            cost: {
              input: 0.95,
              cache_read: 0.16,
              output: 4,
            },
          },
        },
      },
    });

    // When
    const result = classifyModelMetadataAgainstModelsDev(catalog, {
      targets: [
        {
          providerId: "kimi",
          model: "kimi-k2.6",
          modelsDevProviderId: "moonshotai",
          modelsDevModel: "kimi-k2.6",
        },
      ],
      acceptedDifferences: [
        {
          providerId: "kimi",
          model: "kimi-k2.6",
          modelsDevProviderId: "moonshotai",
          modelsDevModel: "kimi-k2.6",
          field: "maxOutputTokens",
          registryValue: "32768",
          modelsDevValue: "262144",
          reviewedAt: "2026-06-26",
          reason:
            "models.dev currently mirrors the Kimi context window into the output limit.",
        },
      ],
      acceptedUntrackedModels: [],
    });

    // Then
    expect(result.actionableDrift).toEqual([]);
    expect(result.acceptedDrift).toEqual([
      {
        providerId: "kimi",
        model: "kimi-k2.6",
        modelsDevProviderId: "moonshotai",
        modelsDevModel: "kimi-k2.6",
        differences: [
          {
            field: "maxOutputTokens",
            registryValue: "32768",
            modelsDevValue: "262144",
            reviewedAt: "2026-06-26",
            reason:
              "models.dev currently mirrors the Kimi context window into the output limit.",
          },
        ],
      },
    ]);
    expect(formatAcceptedModelMetadataDriftReport(result.acceptedDrift)).toBe(
      [
        "Accepted model metadata drift against models.dev:",
        "- kimi/kimi-k2.6 (models.dev moonshotai/kimi-k2.6)",
        "  maxOutputTokens: registry=32768 models.dev=262144 (reviewed 2026-06-26; models.dev currently mirrors the Kimi context window into the output limit.)",
      ].join("\n"),
    );
  });

  test(`Given a reviewed models.dev placeholder later changes value,
    When metadata drift is classified,
    Then the stale review no longer suppresses actionable drift`, () => {
    // Given
    const catalog = parseModelsDevCatalog({
      moonshotai: {
        models: {
          "kimi-k2.6": {
            limit: { context: 262_144, output: 131_072 },
            reasoning: true,
            tool_call: true,
            cost: {
              input: 0.95,
              cache_read: 0.16,
              output: 4,
            },
          },
        },
      },
    });

    // When
    const result = classifyModelMetadataAgainstModelsDev(catalog, {
      targets: [
        {
          providerId: "kimi",
          model: "kimi-k2.6",
          modelsDevProviderId: "moonshotai",
          modelsDevModel: "kimi-k2.6",
        },
      ],
      acceptedDifferences: [
        {
          providerId: "kimi",
          model: "kimi-k2.6",
          modelsDevProviderId: "moonshotai",
          modelsDevModel: "kimi-k2.6",
          field: "maxOutputTokens",
          registryValue: "32768",
          modelsDevValue: "262144",
          reviewedAt: "2026-06-26",
          reason:
            "models.dev currently mirrors the Kimi context window into the output limit.",
        },
      ],
      acceptedUntrackedModels: [],
    });

    // Then
    expect(result.acceptedDrift).toEqual([]);
    expect(result.actionableDrift).toEqual([
      {
        providerId: "kimi",
        model: "kimi-k2.6",
        modelsDevProviderId: "moonshotai",
        modelsDevModel: "kimi-k2.6",
        differences: [
          {
            field: "maxOutputTokens",
            registryValue: "32768",
            modelsDevValue: "131072",
          },
        ],
      },
    ]);
  });

  test(`Given a monitored models.dev model has an invalid target field,
    When metadata drift is checked,
    Then target schema validation fails before comparing values`, () => {
    // Given
    const catalog = parseModelsDevCatalog({
      deepseek: {
        models: {
          "deepseek-v4-flash": {
            limit: { context: "1000000" },
          },
        },
      },
    });

    // Then
    expect(() =>
      diffModelMetadataAgainstModelsDev(catalog, [
        {
          providerId: "deepseek",
          model: "deepseek-v4-flash",
          modelsDevProviderId: "deepseek",
          modelsDevModel: "deepseek-v4-flash",
        },
      ]),
    ).toThrowError(
      "models.dev model deepseek/deepseek-v4-flash has invalid schema",
    );
  });

  test(`Given a monitored external model is missing from models.dev,
    When metadata drift is checked,
    Then the missing external entry is reported`, () => {
    // Given
    const catalog = parseModelsDevCatalog({
      alibaba: {
        models: {},
      },
    });

    // When
    const drift = diffModelMetadataAgainstModelsDev(catalog, [
      {
        providerId: "qwen",
        model: "qwen3.7-plus",
        modelsDevProviderId: "alibaba",
        modelsDevModel: "qwen3.7-plus",
      },
    ]);

    // Then
    expect(drift).toEqual([
      {
        providerId: "qwen",
        model: "qwen3.7-plus",
        modelsDevProviderId: "alibaba",
        modelsDevModel: "qwen3.7-plus",
        differences: [
          {
            field: "models.dev",
            registryValue: "known",
            modelsDevValue: "missing",
          },
        ],
      },
    ]);
    expect(untrackedModelsDevModels(catalog)).toEqual([]);
  });

  test(`Given a monitored registry model is unknown locally,
    When metadata drift is checked,
    Then the unknown registry entry is reported`, () => {
    // Given
    const catalog = parseModelsDevCatalog({
      deepseek: {
        models: {
          "deepseek-v5-preview": {},
        },
      },
    });

    // When
    const drift = diffModelMetadataAgainstModelsDev(catalog, [
      {
        providerId: "deepseek",
        model: "deepseek-v5-preview",
        modelsDevProviderId: "deepseek",
        modelsDevModel: "deepseek-v5-preview",
      },
    ]);

    // Then
    expect(drift).toEqual([
      {
        providerId: "deepseek",
        model: "deepseek-v5-preview",
        modelsDevProviderId: "deepseek",
        modelsDevModel: "deepseek-v5-preview",
        differences: [
          {
            field: "registry",
            registryValue: "unknown",
            modelsDevValue: "known",
          },
        ],
      },
    ]);
  });

  test(`Given models.dev omits cost for a priced registry model,
    When metadata drift is checked,
    Then the missing cost model is reported`, () => {
    // Given
    const catalog = parseModelsDevCatalog({
      deepseek: {
        models: {
          "deepseek-v4-flash": {
            limit: { context: 1_000_000, output: 384_000 },
            reasoning: true,
            tool_call: true,
          },
        },
      },
    });

    // When
    const drift = diffModelMetadataAgainstModelsDev(catalog, [
      {
        providerId: "deepseek",
        model: "deepseek-v4-flash",
        modelsDevProviderId: "deepseek",
        modelsDevModel: "deepseek-v4-flash",
      },
    ]);

    // Then
    expect(drift).toEqual([
      {
        providerId: "deepseek",
        model: "deepseek-v4-flash",
        modelsDevProviderId: "deepseek",
        modelsDevModel: "deepseek-v4-flash",
        differences: [
          {
            field: "costModel",
            registryValue: "fixed",
            modelsDevValue: "null",
          },
        ],
      },
    ]);
  });

  test(`Given models.dev omits limits and individual cost rates,
    When metadata drift is checked,
    Then null external fields are reported with registry values`, () => {
    // Given
    const catalog = parseModelsDevCatalog({
      deepseek: {
        models: {
          "deepseek-v4-pro": {
            cost: {},
          },
        },
      },
    });

    // When
    const drift = diffModelMetadataAgainstModelsDev(catalog, [
      {
        providerId: "deepseek",
        model: "deepseek-v4-pro",
        modelsDevProviderId: "deepseek",
        modelsDevModel: "deepseek-v4-pro",
      },
    ]);

    // Then
    expect(drift).toEqual([
      {
        providerId: "deepseek",
        model: "deepseek-v4-pro",
        modelsDevProviderId: "deepseek",
        modelsDevModel: "deepseek-v4-pro",
        differences: [
          {
            field: "contextWindowTokens",
            registryValue: "1000000",
            modelsDevValue: "null",
          },
          {
            field: "maxOutputTokens",
            registryValue: "384000",
            modelsDevValue: "null",
          },
          {
            field: "capabilities.toolCalls",
            registryValue: "true",
            modelsDevValue: "false",
          },
          {
            field: "capabilities.reasoning",
            registryValue: "true",
            modelsDevValue: "false",
          },
          {
            field: "costModel.uncachedInputPerMillionTokens",
            registryValue: "0.435",
            modelsDevValue: "null",
          },
          {
            field: "costModel.cachedInputPerMillionTokens",
            registryValue: "0.003625",
            modelsDevValue: "null",
          },
          {
            field: "costModel.outputPerMillionTokens",
            registryValue: "0.87",
            modelsDevValue: "null",
          },
        ],
      },
    ]);
  });

  test(`Given models.dev returns a top-level invalid catalog shape,
    When the catalog is parsed,
    Then top-level schema validation fails before diffing`, () => {
    // Given
    const rawCatalog = {
      alibaba: {
        models: undefined,
      },
    };

    // Then
    expect(() => parseModelsDevCatalog(rawCatalog)).toThrowError(
      "models.dev catalog has invalid schema",
    );
  });

  test(`Given models.dev flattens and changes a tiered registry cost model,
    When metadata drift is checked,
    Then the cost model type and base price mismatches are reported`, () => {
    // Given
    const catalog = parseModelsDevCatalog({
      alibaba: {
        models: {
          "qwen3.6-flash": {
            limit: { context: 1_000_000, output: 65_536 },
            reasoning: true,
            tool_call: true,
            cost: {
              input: 0.1875,
              output: 1.125,
            },
          },
        },
      },
    });

    // When
    const drift = diffModelMetadataAgainstModelsDev(catalog, [
      {
        providerId: "qwen",
        model: "qwen3.6-flash",
        modelsDevProviderId: "alibaba",
        modelsDevModel: "qwen3.6-flash",
      },
    ]);

    // Then
    expect(drift).toEqual([
      {
        providerId: "qwen",
        model: "qwen3.6-flash",
        modelsDevProviderId: "alibaba",
        modelsDevModel: "qwen3.6-flash",
        differences: [
          {
            field: "costModel.type",
            registryValue: "input-token-tiers",
            modelsDevValue: "fixed",
          },
          {
            field: "costModel.base.uncachedInputPerMillionTokens",
            registryValue: "0.25",
            modelsDevValue: "0.1875",
          },
          {
            field: "costModel.base.cachedInputPerMillionTokens",
            registryValue: "0.05",
            modelsDevValue: "null",
          },
          {
            field: "costModel.base.outputPerMillionTokens",
            registryValue: "1.5",
            modelsDevValue: "1.125",
          },
        ],
      },
    ]);
  });

  test(`Given models.dev returns a tier without context or price fields,
    When metadata drift is checked,
    Then sparse tier fields are reported as null`, () => {
    // Given
    const catalog = parseModelsDevCatalog({
      alibaba: {
        models: {
          "qwen3.7-plus": {
            limit: { context: 1_000_000, output: 65_536 },
            reasoning: true,
            tool_call: true,
            cost: {
              input: 0.4,
              cache_read: 0.08,
              output: 1.6,
              tiers: [{}],
            },
          },
        },
      },
    });

    // When
    const drift = diffModelMetadataAgainstModelsDev(catalog, [
      {
        providerId: "qwen",
        model: "qwen3.7-plus",
        modelsDevProviderId: "alibaba",
        modelsDevModel: "qwen3.7-plus",
      },
    ]);

    // Then
    expect(drift).toEqual([
      {
        providerId: "qwen",
        model: "qwen3.7-plus",
        modelsDevProviderId: "alibaba",
        modelsDevModel: "qwen3.7-plus",
        differences: [
          {
            field: "costModel.tiers[1].startsAboveInputTokens",
            registryValue: "256000",
            modelsDevValue: "null",
          },
          {
            field: "costModel.tiers[1].uncachedInputPerMillionTokens",
            registryValue: "1.2",
            modelsDevValue: "null",
          },
          {
            field: "costModel.tiers[1].cachedInputPerMillionTokens",
            registryValue: "0.24",
            modelsDevValue: "null",
          },
          {
            field: "costModel.tiers[1].outputPerMillionTokens",
            registryValue: "4.8",
            modelsDevValue: "null",
          },
        ],
      },
    ]);
  });

  test(`Given models.dev includes current-family provider models missing locally,
    When untracked external models are checked,
    Then relevant provider models are reported without older family noise`, () => {
    // Given
    const catalog = parseModelsDevCatalog({
      deepseek: {
        models: {
          "deepseek-chat": {},
          "deepseek-v5-preview": {},
        },
      },
      moonshotai: {
        models: {
          "kimi-k2-thinking": {},
          "kimi-k2.7-code": {},
        },
      },
      alibaba: {
        models: {
          "qwen2-5-72b-instruct": {},
          "qwen3.6-plus": {},
        },
      },
    });

    // When
    const untracked = untrackedModelsDevModels(catalog);

    // Then
    expect(untracked).toEqual([
      {
        providerId: "deepseek",
        modelsDevProviderId: "deepseek",
        modelsDevModel: "deepseek-v5-preview",
      },
      {
        providerId: "kimi",
        modelsDevProviderId: "moonshotai",
        modelsDevModel: "kimi-k2.7-code",
      },
      {
        providerId: "qwen",
        modelsDevProviderId: "alibaba",
        modelsDevModel: "qwen3.6-plus",
      },
    ]);
  });

  test(`Given models.dev includes reviewed and new current-family models missing locally,
    When metadata drift is classified,
    Then reviewed untracked models are separated from actionable additions`, () => {
    // Given
    const catalog = parseModelsDevCatalog({
      alibaba: {
        models: {
          "qwen3.6-new": {},
          "qwen3.6-plus": {},
        },
      },
    });

    // When
    const result = classifyModelMetadataAgainstModelsDev(catalog, {
      targets: [],
      acceptedDifferences: [],
      acceptedUntrackedModels: [
        {
          providerId: "qwen",
          modelsDevProviderId: "alibaba",
          modelsDevModel: "qwen3.6-plus",
          reviewedAt: "2026-06-26",
          reason:
            "Current-family model is known in models.dev but not yet added to Keel's curated registry.",
        },
      ],
    });

    // Then
    expect(result.actionableUntracked).toEqual([
      {
        providerId: "qwen",
        modelsDevProviderId: "alibaba",
        modelsDevModel: "qwen3.6-new",
      },
    ]);
    expect(result.acceptedUntracked).toEqual([
      {
        providerId: "qwen",
        modelsDevProviderId: "alibaba",
        modelsDevModel: "qwen3.6-plus",
        reviewedAt: "2026-06-26",
        reason:
          "Current-family model is known in models.dev but not yet added to Keel's curated registry.",
      },
    ]);
    expect(formatModelMetadataCheckReport(result)).toContain(
      "- qwen/qwen3.6-plus (models.dev alibaba/qwen3.6-plus; reviewed 2026-06-26; Current-family model is known in models.dev but not yet added to Keel's curated registry.)",
    );
  });

  test(`Given a classified metadata result has actionable findings,
    When the full check report is formatted,
    Then every actionable section is visible`, () => {
    // Given
    const result: ModelMetadataDriftCheckResult = {
      actionableDrift: [
        {
          providerId: "deepseek",
          model: "deepseek-v4-flash",
          modelsDevProviderId: "deepseek",
          modelsDevModel: "deepseek-v4-flash",
          differences: [
            {
              field: "costModel.outputPerMillionTokens",
              registryValue: "0.28",
              modelsDevValue: "0.29",
            },
          ],
        },
      ],
      acceptedDrift: [],
      unmonitoredRegistryEntries: ["qwen/qwen-new"],
      actionableUntracked: [
        {
          providerId: "qwen",
          modelsDevProviderId: "alibaba",
          modelsDevModel: "qwen3.6-new",
        },
      ],
      acceptedUntracked: [],
    };

    // When
    const report = formatModelMetadataCheckReport(result);

    // Then
    expect(hasActionableModelMetadataFindings(result)).toBe(true);
    expect(report).toContain(
      "Actionable model metadata drift detected against models.dev:",
    );
    expect(report).toContain("Unmonitored registry entries: qwen/qwen-new");
    expect(report).toContain(
      "Actionable untracked models.dev models detected:",
    );
    expect(report).toContain(
      "- qwen/qwen3.6-new (models.dev alibaba/qwen3.6-new)",
    );
  });
});
