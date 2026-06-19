import type { z } from "zod";
import type {
  BuiltinToolExecutionContext,
  ToolArgDefinition,
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
  const result = tool.args.schema.safeParse(parsedArguments);
  if (!result.success) {
    return null;
  }
  const toolCall = Object.assign({ id, tool: name }, result.data);
  return isToolCall(toolCall) ? toolCall : null;
}

function toolCallRawArguments(
  tool: { readonly args: { readonly fields: object } },
  toolCall: object,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(toolCall).filter(([name]) =>
      Object.hasOwn(tool.args.fields, name),
    ),
  );
}

function isToolCall(toolCall: {
  readonly id: string;
  readonly tool: ToolName;
}): toolCall is ToolCall {
  const tool = builtinToolForName(toolCall.tool);
  return tool.args.schema.safeParse(toolCallRawArguments(tool, toolCall))
    .success;
}

export function executeBuiltinToolCall(
  context: BuiltinToolExecutionContext,
  toolCall: ToolCall,
): ToolExecution | Promise<ToolExecution> {
  const tool = builtinToolForName(toolCall.tool);
  return tool.executeCall(context, toolCall);
}

export function toolCallArguments(toolCall: ToolCall): Record<string, unknown> {
  switch (toolCall.tool) {
    case "read":
      return {
        path: toolCall.path,
        ...(toolCall.offset !== undefined ? { offset: toolCall.offset } : {}),
        ...(toolCall.limit !== undefined ? { limit: toolCall.limit } : {}),
      };
    case "ls":
      return {
        ...(toolCall.path !== undefined ? { path: toolCall.path } : {}),
        ...(toolCall.limit !== undefined ? { limit: toolCall.limit } : {}),
      };
    case "glob":
      return {
        pattern: toolCall.pattern,
        ...(toolCall.path !== undefined ? { path: toolCall.path } : {}),
      };
    case "grep":
      return {
        pattern: toolCall.pattern,
        ...(toolCall.path !== undefined ? { path: toolCall.path } : {}),
      };
    case "edit":
      return {
        path: toolCall.path,
        oldString: toolCall.oldString,
        newString: toolCall.newString,
        ...(toolCall.replaceAll !== undefined
          ? { replaceAll: toolCall.replaceAll }
          : {}),
      };
    case "write":
      return {
        path: toolCall.path,
        content: toolCall.content,
      };
    case "bash":
      return {
        command: toolCall.command,
        ...(toolCall.timeoutMs !== undefined
          ? { timeoutMs: toolCall.timeoutMs }
          : {}),
      };
  }
}
