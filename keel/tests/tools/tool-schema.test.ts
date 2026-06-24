import { describe, expect, test } from "vitest";
import { z } from "zod";
import {
  openAICompatibleParametersFromSchema,
  stripUndefinedProperties,
} from "../../src/tools/tool-schema.ts";

describe("tool schema helpers", () => {
  test(`Given parsed tool arguments contain explicit undefined properties,
    When undefined properties are stripped,
    Then nested object keys are removed while array positions are preserved`, () => {
    const stripped = stripUndefinedProperties({
      keep: "value",
      omit: undefined,
      nested: {
        keep: true,
        omit: undefined,
      },
      items: [
        {
          keep: 1,
          omit: undefined,
        },
        undefined,
      ],
    });

    expect(stripped).toStrictEqual({
      keep: "value",
      nested: {
        keep: true,
      },
      items: [{ keep: 1 }, undefined],
    });
  });

  test(`Given a Zod integer argument uses exclusive bounds,
    When provider parameters are generated,
    Then bounds are converted to inclusive OpenAI-compatible values`, () => {
    const parameters = openAICompatibleParametersFromSchema(
      z
        .object({
          count: z.number().int().gt(1).lt(5).describe("Bounded count."),
        })
        .strict(),
    );

    expect(parameters.properties["count"]).toEqual({
      type: "integer",
      description: "Bounded count.",
      minimum: 2,
      maximum: 4,
    });
  });

  test(`Given Zod arguments omit optional provider metadata,
    When provider parameters are generated,
    Then optional descriptions and required lists are omitted or defaulted`, () => {
    const parameters = openAICompatibleParametersFromSchema(
      z
        .object({
          text: z.string(),
          count: z.number().int().min(1),
          items: z.array(z.string()),
          nested: z
            .object({
              value: z.string(),
            })
            .strict(),
        })
        .strict(),
    );
    const optionalParameters = openAICompatibleParametersFromSchema(
      z
        .object({
          value: z.string().optional(),
        })
        .strict(),
    );
    const unboundedParameters = openAICompatibleParametersFromSchema(
      z
        .object({
          free: z
            .number()
            .int()
            .meta({ minimum: undefined, maximum: undefined }),
        })
        .strict(),
    );
    const missingRequiredParameters = openAICompatibleParametersFromSchema(
      z
        .object({
          value: z.string().optional(),
        })
        .strict()
        .meta({ required: undefined }),
    );

    expect(parameters.properties["text"]).toEqual({ type: "string" });
    expect(parameters.properties["count"]).toEqual({
      type: "integer",
      minimum: 1,
    });
    expect(parameters.properties["items"]).toEqual({
      type: "array",
      items: { type: "string" },
    });
    expect(parameters.properties["nested"]).toEqual({
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
      additionalProperties: false,
    });
    expect(optionalParameters.required).toEqual([]);
    expect(unboundedParameters.properties["free"]).toEqual({ type: "integer" });
    expect(missingRequiredParameters.required).toEqual([]);
  });

  test(`Given a Zod schema cannot render as supported provider parameters,
    When provider parameters are generated,
    Then unsupported schema shapes fail closed`, () => {
    const badDescriptionMetadata = JSON.parse('{"description":123}');
    const badMaximumMetadata = JSON.parse('{"maximum":"bad"}');
    const badMinimumMetadata = JSON.parse('{"minimum":"bad"}');
    const badRequiredMetadata = JSON.parse('{"required":"bad"}');
    const badRequiredEntriesMetadata = JSON.parse('{"required":[1]}');

    expect(() => openAICompatibleParametersFromSchema(z.string())).toThrow(
      "Tool argument schema must render as an object",
    );
    expect(() =>
      openAICompatibleParametersFromSchema(
        z
          .object({
            value: z.union([z.string(), z.number()]),
          })
          .strict(),
      ),
    ).toThrow(
      "tool.parameters.properties.value.type has unsupported JSON Schema type",
    );
    expect(() =>
      openAICompatibleParametersFromSchema(
        z
          .object({
            value: z.string().meta(badDescriptionMetadata),
          })
          .strict(),
      ),
    ).toThrow("tool.parameters.properties.value.description must be a string");
    expect(() =>
      openAICompatibleParametersFromSchema(
        z
          .object({
            value: z.number().int().meta(badMinimumMetadata),
          })
          .strict(),
      ),
    ).toThrow("tool.parameters.properties.value.minimum must be a number");
    expect(() =>
      openAICompatibleParametersFromSchema(
        z
          .object({
            value: z.number().int().meta(badMaximumMetadata),
          })
          .strict(),
      ),
    ).toThrow("tool.parameters.properties.value.maximum must be a number");
    expect(() =>
      openAICompatibleParametersFromSchema(
        z
          .object({
            value: z.string(),
          })
          .passthrough(),
      ),
    ).toThrow("tool.parameters.additionalProperties must be false");
    expect(() =>
      openAICompatibleParametersFromSchema(
        z
          .object({
            value: z.string(),
          })
          .strict()
          .meta({ additionalProperties: undefined }),
      ),
    ).toThrow("tool.parameters.additionalProperties must be false");
    expect(() =>
      openAICompatibleParametersFromSchema(
        z
          .object({
            value: z.string(),
          })
          .strict()
          .meta(badRequiredMetadata),
      ),
    ).toThrow("tool.parameters.required must be an array");
    expect(() =>
      openAICompatibleParametersFromSchema(
        z
          .object({
            value: z.string(),
          })
          .strict()
          .meta(badRequiredEntriesMetadata),
      ),
    ).toThrow("tool.parameters.required entries must be strings");
    expect(() =>
      openAICompatibleParametersFromSchema(
        z
          .object({
            value: z.tuple([z.string(), z.number()]).describe("Tuple value."),
          })
          .strict(),
      ),
    ).toThrow(
      "tool.parameters.properties.value.items must be a JSON Schema object",
    );
  });
});
