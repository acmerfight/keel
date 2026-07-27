import { z } from "zod";

interface OpenAICompatibleToolParameterBase {
  readonly description?: string;
}

interface OpenAICompatibleStringToolParameter
  extends OpenAICompatibleToolParameterBase {
  readonly type: "string";
  readonly enum?: readonly string[];
}

interface OpenAICompatibleIntegerToolParameter
  extends OpenAICompatibleToolParameterBase {
  readonly type: "integer";
  readonly minimum?: number;
  readonly maximum?: number;
}

interface OpenAICompatibleNumberToolParameter
  extends OpenAICompatibleToolParameterBase {
  readonly type: "number";
  readonly minimum?: number;
  readonly maximum?: number;
}

interface OpenAICompatibleBooleanToolParameter
  extends OpenAICompatibleToolParameterBase {
  readonly type: "boolean";
}

interface OpenAICompatibleArrayToolParameter
  extends OpenAICompatibleToolParameterBase {
  readonly type: "array";
  readonly items: OpenAICompatibleToolParameter;
}

interface OpenAICompatibleObjectToolParameter
  extends OpenAICompatibleToolParameterBase {
  readonly type: "object";
  readonly properties: Record<string, OpenAICompatibleToolParameter>;
  readonly required: readonly string[];
  readonly additionalProperties: false;
}

export type OpenAICompatibleToolParameter =
  | OpenAICompatibleStringToolParameter
  | OpenAICompatibleIntegerToolParameter
  | OpenAICompatibleNumberToolParameter
  | OpenAICompatibleBooleanToolParameter
  | OpenAICompatibleArrayToolParameter
  | OpenAICompatibleObjectToolParameter;

export type OpenAICompatibleToolParameters =
  OpenAICompatibleObjectToolParameter;

type JsonObject = Readonly<Record<string, unknown>>;

interface JsonSchemaObject extends JsonObject {
  readonly additionalProperties?: unknown;
  readonly description?: unknown;
  readonly exclusiveMaximum?: unknown;
  readonly exclusiveMinimum?: unknown;
  readonly enum?: unknown;
  readonly items?: unknown;
  readonly maximum?: unknown;
  readonly minimum?: unknown;
  readonly properties?: unknown;
  readonly required?: unknown;
  readonly type?: unknown;
}

export function optionalToolArgument<Schema extends z.ZodType>(schema: Schema) {
  return z.preprocess(
    (value) => (value === null ? undefined : value),
    schema.optional(),
  );
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stripUndefinedProperties(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripUndefinedProperties);
  }

  if (!isJsonObject(value)) {
    return value;
  }

  const stripped: Record<string, unknown> = {};
  for (const [key, property] of Object.entries(value)) {
    const strippedProperty = stripUndefinedProperties(property);
    if (strippedProperty !== undefined) {
      stripped[key] = strippedProperty;
    }
  }
  return stripped;
}

function stringValue(value: unknown, context: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "string") {
    return value;
  }
  throw new Error(`${context} must be a string`);
}

function numberValue(value: unknown, context: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "number") {
    return value;
  }
  throw new Error(`${context} must be a number`);
}

function falseValue(value: unknown, context: string): false | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === false) {
    return false;
  }
  throw new Error(`${context} must be false`);
}

function stringArray(value: unknown, context: string): readonly string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`${context} must be an array`);
  }

  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      throw new Error(`${context} entries must be strings`);
    }
    result.push(item);
  }
  return result;
}

type BuiltinToolParameterType = Exclude<
  OpenAICompatibleToolParameter["type"],
  "number"
>;

function toolParameterType(
  value: unknown,
  context: string,
): BuiltinToolParameterType {
  switch (value) {
    case "string":
    case "integer":
    case "object":
    case "boolean":
    case "array":
      return value;
    default:
      throw new Error(`${context} has unsupported JSON Schema type`);
  }
}

function integerMinimum(
  schema: JsonSchemaObject,
  context: string,
): number | undefined {
  const minimum = numberValue(schema.minimum, `${context}.minimum`);
  if (minimum !== undefined) {
    return minimum;
  }

  const exclusiveMinimum = numberValue(
    schema.exclusiveMinimum,
    `${context}.exclusiveMinimum`,
  );
  return exclusiveMinimum === undefined ? undefined : exclusiveMinimum + 1;
}

function integerMaximum(
  schema: JsonSchemaObject,
  context: string,
): number | undefined {
  const maximum = numberValue(schema.maximum, `${context}.maximum`);
  if (maximum === Number.MAX_SAFE_INTEGER) {
    return undefined;
  }
  if (maximum !== undefined) {
    return maximum;
  }

  const exclusiveMaximum = numberValue(
    schema.exclusiveMaximum,
    `${context}.exclusiveMaximum`,
  );
  return exclusiveMaximum === undefined ? undefined : exclusiveMaximum - 1;
}

function schemaObject(value: unknown, context: string): JsonSchemaObject {
  if (isJsonObject(value)) {
    return value;
  }
  throw new Error(`${context} must be a JSON Schema object`);
}

function schemaProperties(
  value: unknown,
  context: string,
): Record<string, OpenAICompatibleToolParameter> {
  const properties = schemaObject(value, context);
  const result: Record<string, OpenAICompatibleToolParameter> = {};
  for (const [name, property] of Object.entries(properties)) {
    result[name] = openAICompatibleToolParameterFromSchema(
      property,
      `${context}.${name}`,
    );
  }
  return result;
}

function openAICompatibleToolParameterFromSchema(
  value: unknown,
  context: string,
): OpenAICompatibleToolParameter {
  const schema = schemaObject(value, context);
  const type = toolParameterType(schema.type, `${context}.type`);
  const description = stringValue(schema.description, `${context}.description`);

  switch (type) {
    case "string":
      return {
        type,
        ...(description !== undefined ? { description } : {}),
        ...(() => {
          const enumValues = stringArray(schema.enum, `${context}.enum`);
          return enumValues.length > 0 ? { enum: enumValues } : {};
        })(),
      };
    case "boolean":
      return {
        type,
        ...(description !== undefined ? { description } : {}),
      };
    case "integer": {
      const minimum = integerMinimum(schema, context);
      const maximum = integerMaximum(schema, context);
      return {
        type,
        ...(description !== undefined ? { description } : {}),
        ...(minimum !== undefined ? { minimum } : {}),
        ...(maximum !== undefined ? { maximum } : {}),
      };
    }
    case "array":
      return {
        type,
        ...(description !== undefined ? { description } : {}),
        items: openAICompatibleToolParameterFromSchema(
          schema.items,
          `${context}.items`,
        ),
      };
    case "object": {
      const additionalProperties = falseValue(
        schema.additionalProperties,
        `${context}.additionalProperties`,
      );
      if (additionalProperties !== false) {
        throw new Error(`${context}.additionalProperties must be false`);
      }
      return {
        type,
        ...(description !== undefined ? { description } : {}),
        properties: schemaProperties(
          schema.properties,
          `${context}.properties`,
        ),
        required: stringArray(schema.required, `${context}.required`),
        additionalProperties,
      };
    }
  }
}

export function openAICompatibleParametersFromSchema(
  schema: z.ZodType,
): OpenAICompatibleToolParameters {
  const parameter = openAICompatibleToolParameterFromSchema(
    z.toJSONSchema(schema),
    "tool.parameters",
  );
  if (parameter.type !== "object") {
    throw new Error("Tool argument schema must render as an object");
  }
  return {
    type: "object",
    properties: parameter.properties,
    required: parameter.required,
    additionalProperties: false,
  };
}

export function toolArgumentKeys(schema: z.ZodType): readonly string[] {
  return Object.keys(openAICompatibleParametersFromSchema(schema).properties);
}
