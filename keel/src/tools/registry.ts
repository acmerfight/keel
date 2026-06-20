import type { z } from "zod";
import type {
  BuiltinToolExecutionContext,
  ToolArgDefinition,
  ToolConcurrency,
  ToolExecution,
} from "./builtin.ts";
import { builtinTools } from "./builtin.ts";

interface OpenAICompatibleToolParameter {
  readonly type: "string" | "integer" | "object" | "boolean";
  readonly description?: string;
  readonly minimum?: number;
  readonly maximum?: number;
}

interface OpenAICompatibleToolParameters {
  readonly type: "object";
  readonly properties: Record<string, OpenAICompatibleToolParameter>;
  readonly required: readonly string[];
  readonly additionalProperties: false;
}

export interface OpenAICompatibleToolDefinition {
  readonly type: "function";
  readonly function: {
    readonly name: ToolName;
    readonly description: string;
    readonly parameters: OpenAICompatibleToolParameters;
  };
}

type RegisteredBuiltinTool = (typeof builtinTools)[number];

export type ToolName = RegisteredBuiltinTool["name"];

type BuiltinToolForName<Name extends ToolName> = Extract<
  RegisteredBuiltinTool,
  { readonly name: Name }
>;

type ToolNameOf<Tool> = Tool extends {
  readonly name: infer Name extends string;
}
  ? Name
  : never;

type ToolArgsOf<Tool> = Tool extends {
  readonly args: { readonly schema: infer Schema extends z.ZodType };
}
  ? z.infer<Schema>
  : never;

export type ToolArgsFor<Name extends ToolName> = ToolArgsOf<
  BuiltinToolForName<Name>
>;

type ToolCallFor<Tool> = Tool extends unknown
  ? {
      readonly id: string;
      readonly tool: ToolNameOf<Tool>;
    } & ToolArgsOf<Tool>
  : never;

export type ToolCall = {
  readonly [Tool in RegisteredBuiltinTool as Tool["name"]]: ToolCallFor<Tool>;
}[ToolName];

const builtinToolNames: ReadonlySet<string> = new Set(
  builtinTools.map((tool) => tool.name),
);

export function isToolName(name: string): name is ToolName {
  return builtinToolNames.has(name);
}

function isBuiltinToolForName<Name extends ToolName>(
  tool: RegisteredBuiltinTool,
  name: Name,
): tool is BuiltinToolForName<Name> {
  return tool.name === name;
}

function builtinToolForName<Name extends ToolName>(
  name: Name,
): BuiltinToolForName<Name> {
  const tool = builtinTools.find((candidate) =>
    isBuiltinToolForName(candidate, name),
  );
  if (tool !== undefined) {
    return tool;
  }
  /* v8 ignore next: ToolName is derived from builtinTools. */
  throw new Error(`Missing builtin tool registration for ${name}`);
}

function toolArgField(
  tool: RegisteredBuiltinTool,
  key: string,
): ToolArgDefinition | null {
  for (const [name, field] of Object.entries(tool.args.fields)) {
    if (name === key) {
      return field;
    }
  }
  return null;
}

function normalizeParsedArguments(
  tool: RegisteredBuiltinTool,
  parsedArguments: unknown,
): unknown {
  if (
    typeof parsedArguments !== "object" ||
    parsedArguments === null ||
    Array.isArray(parsedArguments)
  ) {
    return parsedArguments;
  }

  const normalized: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(parsedArguments)) {
    const field = toolArgField(tool, name);
    if (field !== null && !field.required && value === null) {
      continue;
    }
    normalized[name] = value;
  }
  return normalized;
}

function toOpenAICompatibleToolParameter(
  field: ToolArgDefinition,
): OpenAICompatibleToolParameter {
  return {
    type: field.type,
    description: field.description,
    ...(field.minimum !== undefined ? { minimum: field.minimum } : {}),
    ...(field.maximum !== undefined ? { maximum: field.maximum } : {}),
  };
}

function toOpenAICompatibleToolDefinition(
  tool: RegisteredBuiltinTool,
): OpenAICompatibleToolDefinition {
  const properties: Record<string, OpenAICompatibleToolParameter> = {};
  const required: string[] = [];

  for (const [name, field] of Object.entries(tool.args.fields)) {
    properties[name] = toOpenAICompatibleToolParameter(field);
    if (field.required) {
      required.push(name);
    }
  }

  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: {
        type: "object",
        properties,
        required,
        additionalProperties: false,
      },
    },
  };
}

export function openAICompatibleTools(
  allowBash: boolean,
): readonly OpenAICompatibleToolDefinition[] {
  return builtinTools
    .filter((tool) => allowBash || tool.risk.kind !== "trusted-shell")
    .map(toOpenAICompatibleToolDefinition);
}

export function toolCallFromParsedArguments(
  id: string,
  name: ToolName,
  parsedArguments: unknown,
): ToolCall | null {
  const tool = builtinToolForName(name);
  const result = tool.args.schema.safeParse(
    normalizeParsedArguments(tool, parsedArguments),
  );
  if (!result.success) {
    return null;
  }
  const toolCall = Object.assign({ id, tool: name }, result.data);
  /* v8 ignore next 4: toolCall is built from this tool's strict schema after successful parse; the guard narrows the registry-derived union without `as`. */
  if (!tool.isCall(toolCall)) {
    return null;
  }
  return toolCall;
}

export function executeBuiltinToolCall(
  context: BuiltinToolExecutionContext,
  toolCall: ToolCall,
): ToolExecution | Promise<ToolExecution> {
  const tool = builtinToolForName(toolCall.tool);
  return tool.executeCall(context, toolCall);
}

export function toolCallConcurrency(toolCall: ToolCall): ToolConcurrency {
  const tool = builtinToolForName(toolCall.tool);
  return tool.concurrency;
}

export function toolCallArguments(toolCall: ToolCall): Record<string, unknown> {
  const tool = builtinToolForName(toolCall.tool);
  return tool.argumentsFromCall(toolCall);
}

export function toolCallCanonicalArguments(
  toolCall: ToolCall,
): Record<string, unknown> {
  const tool = builtinToolForName(toolCall.tool);
  return tool.canonicalArgumentsFromCall(toolCall);
}

export function toolCallLabel(toolCall: ToolCall): string {
  const tool = builtinToolForName(toolCall.tool);
  return tool.formatCallLabel(toolCall);
}
