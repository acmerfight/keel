import { z } from "zod";
import { builtinToolCallSchema, builtinTools } from "./tool-definitions.ts";
import { toolCallValidationError, zodIssuesText } from "./tool-error.ts";
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

export type ValidToolCall = z.infer<typeof builtinToolCallSchema>;

const recoverableAgentStateToolNames = [
  "update_plan",
  "update_goal",
  "memory_add",
  "memory_forget",
] as const;

type RecoverableAgentStateToolName =
  (typeof recoverableAgentStateToolNames)[number];

const invalidAgentStateToolCallSchema = z
  .object({
    id: z.string(),
    tool: z.enum(recoverableAgentStateToolNames),
    invalidArguments: z.record(z.string(), z.unknown()),
    validationError: z.string(),
    recovery: z.string(),
  })
  .strict();

export type InvalidToolCall = z.infer<typeof invalidAgentStateToolCallSchema>;

export const toolCallSchema = z.union([
  builtinToolCallSchema,
  invalidAgentStateToolCallSchema,
]);

export type ToolCall = ValidToolCall | InvalidToolCall;

export interface ToolCallInput {
  readonly id: string;
  readonly tool: ToolName;
}

type ParsedToolCall =
  | { readonly success: true; readonly data: ToolCall }
  | { readonly success: false; readonly error?: z.ZodError };

const INVALID_UPDATE_PLAN_RECOVERY =
  "Provide the full replacement plan using non-empty step strings, statuses pending, in_progress, or completed, and at most one in_progress task.";
const INVALID_UPDATE_GOAL_RECOVERY =
  "Set status to completed only when the active session goal is actually achieved and no required work remains; Runtime will evaluate the assertion evidence or run the configured command verifier. Set status to blocked only with a concise reason after the required blocker audit.";
const INVALID_MEMORY_ADD_RECOVERY =
  "Provide one exact claim and the exact current-user sentence or standalone line that directly asks Keel to remember it.";
const INVALID_MEMORY_FORGET_RECOVERY =
  "Provide one exact active project-memory ID and the exact current-user sentence or standalone line that unambiguously asks Keel to forget it.";

const agentStateRecovery: Readonly<
  Record<RecoverableAgentStateToolName, string>
> = {
  update_plan: INVALID_UPDATE_PLAN_RECOVERY,
  update_goal: INVALID_UPDATE_GOAL_RECOVERY,
  memory_add: INVALID_MEMORY_ADD_RECOVERY,
  memory_forget: INVALID_MEMORY_FORGET_RECOVERY,
};

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

function isRecoverableAgentStateToolName(
  name: ToolName,
): name is RecoverableAgentStateToolName {
  switch (name) {
    case "update_plan":
    case "update_goal":
    case "memory_add":
    case "memory_forget":
      return true;
    /* v8 ignore next 2: current agent-state tools are exactly the recoverable tools above; registry tests pin the set. */
    default:
      return false;
  }
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

function recordFromProviderArguments(
  parsedArguments: unknown,
): Record<string, unknown> {
  if (
    parsedArguments !== null &&
    typeof parsedArguments === "object" &&
    !Array.isArray(parsedArguments)
  ) {
    const record: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(parsedArguments)) {
      record[key] = value;
    }
    return record;
  }
  return { arguments: parsedArguments };
}

function invalidAgentStateToolCall(options: {
  readonly id: string;
  readonly tool: RecoverableAgentStateToolName;
  readonly parsedArguments: unknown;
  readonly error: z.ZodError;
}): InvalidToolCall {
  return {
    id: options.id,
    tool: options.tool,
    invalidArguments: recordFromProviderArguments(options.parsedArguments),
    validationError: zodIssuesText(options.error),
    recovery: agentStateRecovery[options.tool],
  };
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
  allowSkill: boolean,
  allowMemory: boolean,
): readonly OpenAICompatibleToolDefinition[] {
  return builtinTools
    .filter(
      (tool) =>
        (allowBash || tool.risk.kind !== "trusted-shell") &&
        (allowSkill || tool.availability !== "skill-catalog") &&
        (allowMemory || tool.availability !== "memory"),
    )
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
    if (tool.risk.kind === "agent-state") {
      /* v8 ignore next 3: current agent-state tools are exactly the recoverable tools above; keep the guard for future registry changes. */
      if (!isRecoverableAgentStateToolName(name)) {
        return { success: false, error: result.error };
      }
      return {
        success: true,
        data: invalidAgentStateToolCall({
          id,
          tool: name,
          parsedArguments,
          error: result.error,
        }),
      };
    }
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
  const parsed = toolCallSchema.safeParse(toolCall);
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

export function toolCallArguments(toolCall: ToolCall): Record<string, unknown> {
  if (isInvalidToolCall(toolCall)) {
    return toolCall.invalidArguments;
  }
  const tool = builtinToolForName(toolCall.tool);
  return tool.argumentsFromCall(toolCall);
}

export function toolCallCanonicalArguments(
  toolCall: ToolCall,
): Record<string, unknown> {
  if (isInvalidToolCall(toolCall)) {
    return toolCall.invalidArguments;
  }
  const tool = builtinToolForName(toolCall.tool);
  return tool.canonicalArgumentsFromCall(toolCall);
}

export function toolCallLabel(toolCall: ToolCall): string {
  if (isInvalidToolCall(toolCall)) {
    return toolCall.tool;
  }
  const tool = builtinToolForName(toolCall.tool);
  return tool.formatCallLabel(toolCall);
}

export function isInvalidToolCall(
  toolCall: ToolCall,
): toolCall is InvalidToolCall {
  return "invalidArguments" in toolCall;
}

export { builtinToolCallSchema };
