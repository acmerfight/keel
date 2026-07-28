import { z } from "zod";
import type { ProviderId } from "../core/provider-id.ts";
import type {
  ProviderToolInputSchema,
  ProviderToolJsonSchema,
  ProviderToolSchemaJson,
  ProviderToolSchemaType,
} from "../tools/tool-schema.ts";

const schemaObjectBoundary = z.record(z.string(), z.json());
const schemaNodeBoundary = z
  .object({
    type: z.json().optional(),
    description: z.json().optional(),
    enum: z.json().optional(),
    const: z.json().optional(),
    anyOf: z.json().optional(),
    oneOf: z.json().optional(),
    items: z.json().optional(),
    properties: z.json().optional(),
    required: z.json().optional(),
    additionalProperties: z.json().optional(),
    minimum: z.json().optional(),
    maximum: z.json().optional(),
  })
  .catchall(z.json());
const schemaTypeBoundary = z.enum([
  "array",
  "boolean",
  "integer",
  "null",
  "number",
  "object",
  "string",
]);

const annotationKeywords = new Set([
  "$comment",
  "$defs",
  "$id",
  "$schema",
  "contentSchema",
  "default",
  "definitions",
  "deprecated",
  "examples",
  "readOnly",
  "title",
  "writeOnly",
  "x-mcp-header",
]);

const validationOnlyKeywords = new Set([
  "contains",
  "contentEncoding",
  "contentMediaType",
  "dependentRequired",
  "exclusiveMaximum",
  "exclusiveMinimum",
  "format",
  "maxContains",
  "maxItems",
  "maxLength",
  "maxProperties",
  "minContains",
  "minItems",
  "minLength",
  "minProperties",
  "multipleOf",
  "pattern",
  "propertyNames",
  "uniqueItems",
]);

const supportedKeywords = new Set([
  "additionalProperties",
  "anyOf",
  "const",
  "description",
  "enum",
  "items",
  "maximum",
  "minimum",
  "oneOf",
  "properties",
  "required",
  "type",
]);

type McpProviderSchemaCapabilityProfile = "openai-compatible-json-schema";

export interface McpProviderSchemaTarget {
  readonly providerId: ProviderId;
  readonly model: string;
  readonly capabilityProfile: McpProviderSchemaCapabilityProfile;
}

export type McpProviderSchemaCompilation =
  | {
      readonly ok: true;
      readonly fidelity: "exact" | "validation-widened";
      readonly parameters: ProviderToolInputSchema;
      readonly validationWideningDiagnostics: readonly string[];
    }
  | { readonly ok: false; readonly reason: string };

interface CompilationContext {
  readonly target: McpProviderSchemaTarget;
  readonly validationWideningDiagnostics: Set<string>;
  validationWideningCount: number;
}

type SchemaNodeCompilation =
  | { readonly ok: true; readonly schema: ProviderToolJsonSchema }
  | { readonly ok: false; readonly reason: string };

function recordValidationWidening(
  context: CompilationContext,
  diagnostic: string,
): void {
  context.validationWideningCount += 1;
  context.validationWideningDiagnostics.add(diagnostic);
}

const providerCapabilityProfiles = {
  fake: "openai-compatible-json-schema",
  deepseek: "openai-compatible-json-schema",
  kimi: "openai-compatible-json-schema",
  qwen: "openai-compatible-json-schema",
} satisfies Record<ProviderId, McpProviderSchemaCapabilityProfile>;

export function mcpProviderSchemaTarget(
  providerId: ProviderId,
  model: string,
): McpProviderSchemaTarget {
  return {
    providerId,
    model,
    capabilityProfile: providerCapabilityProfiles[providerId],
  };
}

function schemaObject(
  value: unknown,
  path: string,
):
  | {
      readonly ok: true;
      readonly value: Record<string, ProviderToolSchemaJson>;
    }
  | { readonly ok: false; readonly reason: string } {
  const parsed = schemaObjectBoundary.safeParse(value);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, reason: `${path} must be a JSON Schema object` };
}

function compileType(
  value: ProviderToolSchemaJson | undefined,
  path: string,
):
  | {
      readonly ok: true;
      readonly value:
        | ProviderToolSchemaType
        | readonly ProviderToolSchemaType[]
        | undefined;
    }
  | { readonly ok: false; readonly reason: string } {
  if (value === undefined) {
    return { ok: true, value: undefined };
  }
  if (Array.isArray(value)) {
    const parsed = z.array(schemaTypeBoundary).min(1).safeParse(value);
    if (!parsed.success) {
      return {
        ok: false,
        reason: `${path} must contain supported JSON Schema types`,
      };
    }
    return { ok: true, value: [...new Set(parsed.data)] };
  }
  const parsed = schemaTypeBoundary.safeParse(value);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, reason: `${path} must be a supported JSON Schema type` };
}

function compileComposition(
  value: ProviderToolSchemaJson | undefined,
  path: string,
  context: CompilationContext,
):
  | {
      readonly ok: true;
      readonly value: readonly ProviderToolJsonSchema[];
      readonly validationWidened: boolean;
    }
  | { readonly ok: false; readonly reason: string } {
  if (!Array.isArray(value) || value.length === 0) {
    return {
      ok: false,
      reason: `${path} must contain at least one JSON Schema branch`,
    };
  }
  const wideningCountBefore = context.validationWideningCount;
  const branches: ProviderToolJsonSchema[] = [];
  for (const [index, branch] of value.entries()) {
    const compiled = compileSchemaNode(
      branch,
      `${path}[${index}]`,
      context,
      false,
    );
    if (!compiled.ok) return compiled;
    branches.push(compiled.schema);
  }
  return {
    ok: true,
    value: branches,
    validationWidened: context.validationWideningCount > wideningCountBefore,
  };
}

function compileProperties(
  value: ProviderToolSchemaJson | undefined,
  path: string,
  context: CompilationContext,
):
  | {
      readonly ok: true;
      readonly value: Readonly<Record<string, ProviderToolJsonSchema>>;
    }
  | { readonly ok: false; readonly reason: string } {
  if (value === undefined) return { ok: true, value: {} };
  const parsed = schemaObject(value, path);
  if (!parsed.ok) return parsed;
  const properties: Record<string, ProviderToolJsonSchema> = {};
  for (const [name, property] of Object.entries(parsed.value)) {
    const compiled = compileSchemaNode(
      property,
      `${path}.${name}`,
      context,
      false,
    );
    if (!compiled.ok) return compiled;
    properties[name] = compiled.schema;
  }
  return { ok: true, value: properties };
}

function compileRequired(
  value: ProviderToolSchemaJson | undefined,
  path: string,
):
  | { readonly ok: true; readonly value: readonly string[] | undefined }
  | { readonly ok: false; readonly reason: string } {
  if (value === undefined) return { ok: true, value: undefined };
  const parsed = z.array(z.string()).safeParse(value);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, reason: `${path} must contain only strings` };
}

function compileAdditionalProperties(
  value: ProviderToolSchemaJson | undefined,
  path: string,
  context: CompilationContext,
):
  | {
      readonly ok: true;
      readonly value: boolean | ProviderToolJsonSchema | undefined;
    }
  | { readonly ok: false; readonly reason: string } {
  if (value === undefined || typeof value === "boolean") {
    return { ok: true, value };
  }
  const compiled = compileSchemaNode(value, path, context, false);
  return compiled.ok ? { ok: true, value: compiled.schema } : compiled;
}

function numericKeyword(
  value: ProviderToolSchemaJson | undefined,
  path: string,
):
  | { readonly ok: true; readonly value: number | undefined }
  | { readonly ok: false; readonly reason: string } {
  return value === undefined || typeof value === "number"
    ? { ok: true, value }
    : { ok: false, reason: `${path} must be numeric` };
}

function providerDescription(value: string): string {
  return [...value]
    .map((character) => {
      const codeUnit = character.charCodeAt(0);
      return codeUnit <= 0x1f || codeUnit === 0x7f ? " " : character;
    })
    .join("")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 2_048);
}

function compileSchemaNode(
  value: unknown,
  path: string,
  context: CompilationContext,
  root: boolean,
): SchemaNodeCompilation {
  const parsed = schemaNodeBoundary.safeParse(value);
  if (!parsed.success) {
    return { ok: false, reason: `${path} must be a JSON Schema object` };
  }
  const source = parsed.data;
  for (const keyword of Object.keys(source)) {
    if (validationOnlyKeywords.has(keyword)) {
      recordValidationWidening(context, `omitted ${path}.${keyword}`);
      continue;
    }
    if (keyword === "$ref") {
      return {
        ok: false,
        reason: `${path}.$ref requires bounded local reference compilation`,
      };
    }
    if (!annotationKeywords.has(keyword) && !supportedKeywords.has(keyword)) {
      return {
        ok: false,
        reason: `${path}.${keyword} changes structure and is not supported by ${context.target.providerId}/${context.target.model}`,
      };
    }
  }

  const type = compileType(source.type, `${path}.type`);
  if (!type.ok) return type;
  if (root && type.value !== undefined && type.value !== "object") {
    return {
      ok: false,
      reason: `${path}.type must be object for an MCP tool input schema`,
    };
  }

  let anyOf: readonly ProviderToolJsonSchema[] | undefined;
  if (source.anyOf !== undefined) {
    const compiled = compileComposition(source.anyOf, `${path}.anyOf`, context);
    if (!compiled.ok) return compiled;
    anyOf = compiled.value;
  }
  let oneOf: readonly ProviderToolJsonSchema[] | undefined;
  if (source.oneOf !== undefined) {
    const compiled = compileComposition(source.oneOf, `${path}.oneOf`, context);
    if (!compiled.ok) return compiled;
    if (compiled.validationWidened) {
      if (anyOf !== undefined) {
        return {
          ok: false,
          reason: `${path} combines anyOf with a validation-widened oneOf and cannot be safely projected`,
        };
      }
      anyOf = compiled.value;
      recordValidationWidening(
        context,
        `lowered ${path}.oneOf to anyOf because widened branches may overlap`,
      );
    } else {
      oneOf = compiled.value;
    }
  }

  const properties = compileProperties(
    source.properties,
    `${path}.properties`,
    context,
  );
  if (!properties.ok) return properties;
  const required = compileRequired(source.required, `${path}.required`);
  if (!required.ok) return required;
  const additionalProperties = compileAdditionalProperties(
    source.additionalProperties,
    `${path}.additionalProperties`,
    context,
  );
  if (!additionalProperties.ok) return additionalProperties;

  let items: ProviderToolJsonSchema | undefined;
  if (source.items !== undefined) {
    const compiled = compileSchemaNode(
      source.items,
      `${path}.items`,
      context,
      false,
    );
    if (!compiled.ok) return compiled;
    items = compiled.schema;
  }
  const includesArray =
    type.value === "array" ||
    (Array.isArray(type.value) && type.value.includes("array"));
  if (includesArray && items === undefined) {
    return { ok: false, reason: `${path}.items is required for array schemas` };
  }

  let enumValues: readonly ProviderToolSchemaJson[] | undefined;
  if (source.enum !== undefined) {
    if (!Array.isArray(source.enum)) {
      return { ok: false, reason: `${path}.enum must be an array` };
    }
    enumValues = source.enum;
  }
  let hasConst = false;
  let constValue: ProviderToolSchemaJson = null;
  if (Object.hasOwn(source, "const")) {
    const parsedConst = z.json().safeParse(source.const);
    if (!parsedConst.success) {
      return { ok: false, reason: `${path}.const must be a JSON value` };
    }
    hasConst = true;
    constValue = parsedConst.data;
  }
  const minimum = numericKeyword(source.minimum, `${path}.minimum`);
  if (!minimum.ok) return minimum;
  const maximum = numericKeyword(source.maximum, `${path}.maximum`);
  if (!maximum.ok) return maximum;
  const description =
    typeof source.description === "string"
      ? providerDescription(source.description)
      : undefined;

  return {
    ok: true,
    schema: {
      ...(type.value !== undefined
        ? { type: type.value }
        : root
          ? { type: "object" as const }
          : {}),
      ...(description !== undefined ? { description } : {}),
      ...(enumValues !== undefined ? { enum: enumValues } : {}),
      ...(hasConst ? { const: constValue } : {}),
      ...(anyOf !== undefined ? { anyOf } : {}),
      ...(oneOf !== undefined ? { oneOf } : {}),
      ...(items !== undefined ? { items } : {}),
      ...(Object.keys(properties.value).length > 0 ||
      Object.hasOwn(source, "properties")
        ? { properties: properties.value }
        : {}),
      ...(required.value !== undefined ? { required: required.value } : {}),
      ...(additionalProperties.value !== undefined
        ? { additionalProperties: additionalProperties.value }
        : {}),
      ...(minimum.value !== undefined ? { minimum: minimum.value } : {}),
      ...(maximum.value !== undefined ? { maximum: maximum.value } : {}),
    },
  };
}

export function compileMcpProviderInputSchema(
  inputSchema: unknown,
  target: McpProviderSchemaTarget,
): McpProviderSchemaCompilation {
  const validationWideningDiagnostics = new Set<string>();
  const compiled = compileSchemaNode(
    inputSchema,
    "inputSchema",
    {
      target,
      validationWideningDiagnostics,
      validationWideningCount: 0,
    },
    true,
  );
  if (!compiled.ok) return compiled;
  const diagnostics = [...validationWideningDiagnostics].sort();
  return {
    ok: true,
    fidelity: diagnostics.length === 0 ? "exact" : "validation-widened",
    parameters: {
      ...compiled.schema,
      type: "object",
      properties: compiled.schema.properties ?? {},
      required: compiled.schema.required ?? [],
    },
    validationWideningDiagnostics: diagnostics,
  };
}
