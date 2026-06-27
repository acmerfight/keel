import type { z } from "zod";
import {
  builtinToolCallSchema,
  builtinTools,
  type ToolConcurrency,
} from "./tool-definitions.ts";
import { toolCallValidationError } from "./tool-error.ts";
import {
  type OpenAICompatibleToolParameters,
  openAICompatibleParametersFromSchema,
} from "./tool-schema.ts";

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

export type ToolCall = z.infer<typeof builtinToolCallSchema>;

export interface ToolCallInput {
  readonly id: string;
  readonly tool: ToolName;
}

type ParsedToolCall =
  | { readonly success: true; readonly data: ToolCall }
  | { readonly success: false; readonly error?: z.ZodError };

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
  /* v8 ignore next 3: ToolName is derived from builtinTools. */
  if (tool !== undefined) {
    return tool;
  }
  /* v8 ignore next: ToolName is derived from builtinTools. */
  throw new Error(`Missing builtin tool registration for ${name}`);
}

function rawToolCallArguments(
  toolCall: ToolCallInput,
): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(toolCall)) {
    if (name !== "id" && name !== "tool") {
      args[name] = value;
    }
  }
  return args;
}

function toOpenAICompatibleToolDefinition(
  tool: RegisteredBuiltinTool,
): OpenAICompatibleToolDefinition {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: openAICompatibleParametersFromSchema(tool.args.schema),
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
  const parsed = parseToolCallFromParsedArguments(id, name, parsedArguments);
  return parsed.success ? parsed.data : null;
}

function parseToolCallFromParsedArguments(
  id: string,
  name: ToolName,
  parsedArguments: unknown,
): ParsedToolCall {
  const tool = builtinToolForName(name);
  const result = tool.args.schema.safeParse(parsedArguments);
  if (!result.success) {
    return { success: false, error: result.error };
  }
  const toolCall = builtinToolCallSchema.safeParse({
    ...result.data,
    id,
    tool: name,
  });
  /* v8 ignore next 3: the call is built from the matching parsed args schema plus contract-owned id/tool fields. */
  if (!toolCall.success) {
    return { success: false, error: toolCall.error };
  }
  /* v8 ignore next 4: toolCall is built from this tool's strict schema after successful parse; the guard narrows the definition-derived union without `as`. */
  if (!tool.isCall(toolCall.data)) {
    return { success: false };
  }
  return { success: true, data: toolCall.data };
}

function normalizeToolCallResult(toolCall: ToolCallInput): ParsedToolCall {
  const parsed = builtinToolCallSchema.safeParse(toolCall);
  if (parsed.success) {
    return { success: true, data: parsed.data };
  }
  return parseToolCallFromParsedArguments(
    toolCall.id,
    toolCall.tool,
    rawToolCallArguments(toolCall),
  );
}

export function normalizeProviderToolCall(toolCall: ToolCallInput): ToolCall {
  const parsed = normalizeToolCallResult(toolCall);
  if (parsed.success) {
    return parsed.data;
  }
  throw toolCallValidationError(
    "Invalid provider tool call",
    toolCall.tool,
    parsed.error,
  );
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

export type { ToolConcurrency };
export { builtinToolCallSchema };
