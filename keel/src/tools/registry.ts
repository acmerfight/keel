import type { ToolArgDefinition } from "./builtin.ts";
import { builtinTools } from "./builtin.ts";
import {
  bashToolArgumentsSchema,
  editToolArgumentsSchema,
  globToolArgumentsSchema,
  grepToolArgumentsSchema,
  lsToolArgumentsSchema,
  readToolArgumentsSchema,
  writeToolArgumentsSchema,
} from "./tool-arguments.ts";

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

export type ToolCall =
  | {
      readonly id: string;
      readonly tool: "read";
      readonly path: string;
      readonly offset?: number;
      readonly limit?: number;
    }
  | {
      readonly id: string;
      readonly tool: "ls";
      readonly path?: string;
      readonly limit?: number;
    }
  | {
      readonly id: string;
      readonly tool: "glob";
      readonly pattern: string;
      readonly path?: string;
    }
  | {
      readonly id: string;
      readonly tool: "grep";
      readonly pattern: string;
      readonly path?: string;
    }
  | {
      readonly id: string;
      readonly tool: "edit";
      readonly path: string;
      readonly oldString: string;
      readonly newString: string;
      readonly replaceAll?: boolean;
    }
  | {
      readonly id: string;
      readonly tool: "write";
      readonly path: string;
      readonly content: string;
    }
  | {
      readonly id: string;
      readonly tool: "bash";
      readonly command: string;
      readonly timeoutMs?: number;
    };

export type ToolName = ToolCall["tool"];

const builtinToolNames: ReadonlySet<string> = new Set(
  builtinTools.map((tool) => tool.name),
);

export function isToolName(name: string): name is ToolName {
  return builtinToolNames.has(name);
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
  tool: (typeof builtinTools)[number],
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
  switch (name) {
    case "read": {
      const result = readToolArgumentsSchema.safeParse(parsedArguments);
      if (!result.success) return null;
      return {
        id,
        tool: "read",
        path: result.data.path,
        ...(result.data.offset !== undefined
          ? { offset: result.data.offset }
          : {}),
        ...(result.data.limit !== undefined
          ? { limit: result.data.limit }
          : {}),
      };
    }
    case "ls": {
      const result = lsToolArgumentsSchema.safeParse(parsedArguments);
      if (!result.success) return null;
      return {
        id,
        tool: "ls",
        ...(result.data.path !== undefined ? { path: result.data.path } : {}),
        ...(result.data.limit !== undefined
          ? { limit: result.data.limit }
          : {}),
      };
    }
    case "glob": {
      const result = globToolArgumentsSchema.safeParse(parsedArguments);
      if (!result.success) return null;
      return {
        id,
        tool: "glob",
        pattern: result.data.pattern,
        ...(result.data.path !== undefined ? { path: result.data.path } : {}),
      };
    }
    case "grep": {
      const result = grepToolArgumentsSchema.safeParse(parsedArguments);
      if (!result.success) return null;
      return {
        id,
        tool: "grep",
        pattern: result.data.pattern,
        ...(result.data.path !== undefined ? { path: result.data.path } : {}),
      };
    }
    case "edit": {
      const result = editToolArgumentsSchema.safeParse(parsedArguments);
      if (!result.success) return null;
      return {
        id,
        tool: "edit",
        path: result.data.path,
        oldString: result.data.oldString,
        newString: result.data.newString,
        ...(result.data.replaceAll !== undefined
          ? { replaceAll: result.data.replaceAll }
          : {}),
      };
    }
    case "write": {
      const result = writeToolArgumentsSchema.safeParse(parsedArguments);
      if (!result.success) return null;
      return {
        id,
        tool: "write",
        path: result.data.path,
        content: result.data.content,
      };
    }
    case "bash": {
      const result = bashToolArgumentsSchema.safeParse(parsedArguments);
      if (!result.success) return null;
      return {
        id,
        tool: "bash",
        command: result.data.command,
        ...(result.data.timeoutMs !== undefined
          ? { timeoutMs: result.data.timeoutMs }
          : {}),
      };
    }
  }
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
