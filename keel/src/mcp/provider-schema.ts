import { Buffer } from "node:buffer";
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
    $ref: z.json().optional(),
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

export interface McpProviderSchemaReferenceLimits {
  readonly maxDepth: number;
  readonly maxExpandedNodes: number;
  readonly maxExpandedBytes: number;
}

export interface McpProviderSchemaCompilationOptions {
  readonly target: McpProviderSchemaTarget;
  readonly referenceLimits: McpProviderSchemaReferenceLimits;
}

export const MCP_PROVIDER_SCHEMA_REFERENCE_LIMITS: McpProviderSchemaReferenceLimits =
  {
    maxDepth: 16,
    maxExpandedNodes: 1_024,
    maxExpandedBytes: 64 * 1_024,
  };

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
  readonly rootSchema: z.infer<typeof schemaNodeBoundary>;
  readonly referenceLimits: McpProviderSchemaReferenceLimits;
  readonly activeReferences: string[];
  readonly validationWideningDiagnostics: Set<string>;
  expandedNodes: number;
  expandedBytes: number;
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

type LocalReferenceResolution =
  | {
      readonly ok: true;
      readonly reference: string;
      readonly value: unknown;
    }
  | { readonly ok: false; readonly reason: string };

function decodeJsonPointerToken(token: string): string | null {
  if (/~(?:[^01]|$)/u.test(token)) return null;
  return token.replaceAll("~1", "/").replaceAll("~0", "~");
}

function resolveLocalReference(
  value: ProviderToolSchemaJson,
  path: string,
  rootSchema: z.infer<typeof schemaNodeBoundary>,
): LocalReferenceResolution {
  if (typeof value !== "string") {
    return { ok: false, reason: `${path}.$ref must be a string` };
  }
  if (value !== "#" && !value.startsWith("#/")) {
    return {
      ok: false,
      reason: `${path}.$ref must be a same-document JSON Pointer`,
    };
  }
  let pointer: string;
  try {
    pointer = decodeURIComponent(value.slice(1));
  } catch {
    return {
      ok: false,
      reason: `${path}.$ref contains invalid percent encoding`,
    };
  }
  const reference = `#${pointer}`;
  let current: unknown = rootSchema;
  if (pointer.length === 0) {
    return { ok: true, reference, value: current };
  }
  for (const encodedToken of pointer.slice(1).split("/")) {
    const token = decodeJsonPointerToken(encodedToken);
    if (token === null) {
      return {
        ok: false,
        reason: `${path}.$ref contains an invalid JSON Pointer escape`,
      };
    }
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9]\d*)$/u.test(token)) {
        return {
          ok: false,
          reason: `${path}.$ref cannot resolve local reference ${JSON.stringify(reference)}`,
        };
      }
      const item: unknown = current[Number(token)];
      if (item === undefined) {
        return {
          ok: false,
          reason: `${path}.$ref cannot resolve local reference ${JSON.stringify(reference)}`,
        };
      }
      current = item;
      continue;
    }
    const object = schemaNodeBoundary.safeParse(current);
    if (!object.success) {
      return {
        ok: false,
        reason: `${path}.$ref cannot resolve local reference ${JSON.stringify(reference)}`,
      };
    }
    if (!Object.hasOwn(object.data, token)) {
      return {
        ok: false,
        reason: `${path}.$ref cannot resolve local reference ${JSON.stringify(reference)}`,
      };
    }
    const property = object.data[token];
    current = property;
  }
  return { ok: true, reference, value: current };
}

function referenceOnlyCycleDiagnostic(
  value: unknown,
  path: string,
  rootSchema: z.infer<typeof schemaNodeBoundary>,
): string | null {
  const activeReferences = new Set<string>();
  let current = value;
  let currentPath = path;
  while (true) {
    const parsed = schemaNodeBoundary.safeParse(current);
    if (!parsed.success || parsed.data.$ref === undefined) return null;
    const resolved = resolveLocalReference(
      parsed.data.$ref,
      currentPath,
      rootSchema,
    );
    if (!resolved.ok) return null;
    if (activeReferences.has(resolved.reference)) {
      return `${currentPath}.$ref forms a cycle through ${JSON.stringify(resolved.reference)}`;
    }
    activeReferences.add(resolved.reference);
    current = resolved.value;
    currentPath = `${currentPath}.$ref(${JSON.stringify(resolved.reference)})`;
  }
}

interface PendingSchemaScan {
  readonly value: unknown;
  readonly path: string;
}

const localReferenceSchemaMapKeywords = new Set([
  "$defs",
  "definitions",
  "dependencies",
  "dependentSchemas",
  "patternProperties",
  "properties",
]);

const localReferenceSchemaArrayKeywords = new Set([
  "allOf",
  "anyOf",
  "oneOf",
  "prefixItems",
]);

const localReferenceSchemaValueKeywords = new Set([
  "additionalItems",
  "additionalProperties",
  "contains",
  "contentSchema",
  "else",
  "if",
  "items",
  "not",
  "propertyNames",
  "then",
  "unevaluatedItems",
  "unevaluatedProperties",
]);

/**
 * Recovers a precise diagnostic for reference-only loops that can overflow the
 * SDK validator before provider projection. Call only after validator failure;
 * structural recursion remains valid at the catalog boundary.
 */
export function mcpDegenerateLocalReferenceCycleDiagnostic(
  rootSchema: z.infer<typeof schemaNodeBoundary>,
  path: "inputSchema" | "outputSchema",
): string | null {
  const pending: PendingSchemaScan[] = [{ value: rootSchema, path }];
  while (true) {
    const current = pending.pop();
    if (current === undefined) return null;
    const diagnostic = referenceOnlyCycleDiagnostic(
      current.value,
      current.path,
      rootSchema,
    );
    if (diagnostic !== null) return diagnostic;

    const object = schemaObjectBoundary.safeParse(current.value);
    if (!object.success) continue;
    for (const [name, child] of Object.entries(object.data).toReversed()) {
      const childPath = `${current.path}.${name}`;
      if (localReferenceSchemaMapKeywords.has(name)) {
        const schemaMap = schemaObjectBoundary.safeParse(child);
        if (!schemaMap.success) continue;
        for (const [schemaName, schema] of Object.entries(
          schemaMap.data,
        ).toReversed()) {
          pending.push({
            value: schema,
            path: `${childPath}.${schemaName}`,
          });
        }
        continue;
      }
      if (
        localReferenceSchemaArrayKeywords.has(name) ||
        (name === "items" && Array.isArray(child))
      ) {
        if (!Array.isArray(child)) continue;
        for (const [childIndex, childSchema] of [
          ...child.entries(),
        ].toReversed()) {
          pending.push({
            value: childSchema,
            path: `${childPath}[${childIndex}]`,
          });
        }
        continue;
      }
      if (localReferenceSchemaValueKeywords.has(name)) {
        pending.push({ value: child, path: childPath });
      }
    }
  }
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

function compileReferencedSchemaNode(
  reference: ProviderToolSchemaJson,
  source: z.infer<typeof schemaNodeBoundary>,
  path: string,
  context: CompilationContext,
  root: boolean,
): SchemaNodeCompilation {
  const resolved = resolveLocalReference(reference, path, context.rootSchema);
  if (!resolved.ok) return resolved;
  if (context.activeReferences.includes(resolved.reference)) {
    return {
      ok: false,
      reason: `${path}.$ref forms a cycle through ${JSON.stringify(resolved.reference)}`,
    };
  }
  if (context.activeReferences.length >= context.referenceLimits.maxDepth) {
    return {
      ok: false,
      reason: `${path}.$ref exceeds the local reference depth limit of ${context.referenceLimits.maxDepth}`,
    };
  }
  for (const keyword of Object.keys(source)) {
    if (
      keyword === "$ref" ||
      keyword === "description" ||
      annotationKeywords.has(keyword)
    ) {
      continue;
    }
    if (validationOnlyKeywords.has(keyword)) {
      recordValidationWidening(context, `omitted ${path}.${keyword}`);
      continue;
    }
    if (supportedKeywords.has(keyword)) {
      return {
        ok: false,
        reason: `${path}.${keyword} cannot be safely combined with $ref`,
      };
    }
    return {
      ok: false,
      reason: `${path}.${keyword} changes structure and is not supported by ${context.target.providerId}/${context.target.model}`,
    };
  }

  context.activeReferences.push(resolved.reference);
  const compiled = compileSchemaNode(
    resolved.value,
    `${path}.$ref(${JSON.stringify(resolved.reference)})`,
    context,
    root,
  );
  const outermostReference = context.activeReferences.length === 1;
  context.activeReferences.pop();
  if (!compiled.ok) return compiled;

  // Count each projected replacement once; nested references are already
  // represented inside their outermost serialized subtree.
  if (outermostReference) {
    context.expandedBytes += Buffer.byteLength(
      JSON.stringify(compiled.schema),
      "utf8",
    );
    if (context.expandedBytes > context.referenceLimits.maxExpandedBytes) {
      return {
        ok: false,
        reason: `${path}.$ref exceeds the expanded schema byte limit of ${context.referenceLimits.maxExpandedBytes}`,
      };
    }
  }
  const description =
    typeof source.description === "string"
      ? providerDescription(source.description)
      : compiled.schema.description;
  return {
    ok: true,
    schema: {
      ...compiled.schema,
      ...(description !== undefined ? { description } : {}),
    },
  };
}

function compileSchemaNode(
  value: unknown,
  path: string,
  context: CompilationContext,
  root: boolean,
): SchemaNodeCompilation {
  if (context.activeReferences.length > 0) {
    context.expandedNodes += 1;
    if (context.expandedNodes > context.referenceLimits.maxExpandedNodes) {
      return {
        ok: false,
        reason: `${path} exceeds the expanded schema node limit of ${context.referenceLimits.maxExpandedNodes}`,
      };
    }
  }
  const parsed = schemaNodeBoundary.safeParse(value);
  if (!parsed.success) {
    return { ok: false, reason: `${path} must be a JSON Schema object` };
  }
  const source = parsed.data;
  if (source.$ref !== undefined) {
    return compileReferencedSchemaNode(
      source.$ref,
      source,
      path,
      context,
      root,
    );
  }
  for (const keyword of Object.keys(source)) {
    if (validationOnlyKeywords.has(keyword)) {
      recordValidationWidening(context, `omitted ${path}.${keyword}`);
      continue;
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
  options: McpProviderSchemaCompilationOptions,
): McpProviderSchemaCompilation {
  const root = schemaNodeBoundary.safeParse(inputSchema);
  if (!root.success) {
    return { ok: false, reason: "inputSchema must be a JSON Schema object" };
  }
  const validationWideningDiagnostics = new Set<string>();
  const compiled = compileSchemaNode(
    root.data,
    "inputSchema",
    {
      target: options.target,
      rootSchema: root.data,
      referenceLimits: options.referenceLimits,
      activeReferences: [],
      validationWideningDiagnostics,
      expandedNodes: 0,
      expandedBytes: 0,
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
