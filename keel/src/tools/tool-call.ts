import { z } from "zod";
import {
  builtinToolCallSchema,
  builtinToolRegistry,
  builtinTools,
} from "./tool-definitions.ts";
import { toolCallValidationError, zodIssuesText } from "./tool-error.ts";
import {
  type OpenAICompatibleToolParameters,
  openAICompatibleParametersFromSchema,
} from "./tool-schema.ts";

export interface OpenAICompatibleToolDefinition {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: OpenAICompatibleToolParameters;
  };
}

export type ToolJsonValue =
  | null
  | boolean
  | number
  | string
  | ToolJsonValue[]
  | { [key: string]: ToolJsonValue };

export type McpToolArguments = Readonly<Record<string, ToolJsonValue>>;

const mcpServerIdSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/u);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const mcpToolReferenceSchema = z
  .object({
    kind: z.literal("mcp"),
    serverId: mcpServerIdSchema,
    serverOrigin: z.url().refine((raw) => new URL(raw).origin === raw, {
      message: "must be a canonical URL origin",
    }),
    rawToolName: z.string().min(1).max(128),
    configurationDigest: sha256Schema,
    catalogGeneration: z.string().min(1).max(256),
    descriptorDigest: sha256Schema,
  })
  .strict();

export type McpToolReference = z.infer<typeof mcpToolReferenceSchema>;

export interface McpModelToolDefinition {
  readonly kind: "mcp";
  readonly modelName: string;
  readonly description: string;
  readonly parameters: OpenAICompatibleToolParameters;
  readonly reference: McpToolReference;
}

export interface McpToolExposureSnapshot {
  readonly snapshotId: string;
  readonly tools: readonly McpModelToolDefinition[];
}

const mcpToolCallSchema = z
  .object({
    kind: z.literal("mcp"),
    id: z.string().min(1),
    tool: z.string().regex(/^[A-Za-z0-9_]{1,64}$/u),
    reference: mcpToolReferenceSchema,
    arguments: z.record(z.string(), z.json()),
  })
  .strict();

export type McpToolCall = z.infer<typeof mcpToolCallSchema>;

export type ModelToolExposure =
  | { readonly kind: "none" }
  | {
      readonly kind: "auto";
      readonly bash?: true;
      readonly skill?: true;
      readonly memory?: "direct" | "reviewed";
      readonly mcp?: McpToolExposureSnapshot;
    };

export type ResolvedModelToolExposure =
  | { readonly kind: "none" }
  | {
      readonly kind: "auto";
      readonly bash: boolean;
      readonly skill: boolean;
      readonly memory: "disabled" | "direct" | "reviewed";
      readonly mcpSnapshotId: string | null;
    };

export interface ModelToolExposureAccounting {
  readonly allowBash: boolean;
  readonly allowSkill: boolean;
  readonly allowMemory: boolean;
  readonly allowMemoryProposal: boolean;
  readonly toolChoice: "auto" | "none";
}

type RegisteredBuiltinTool =
  (typeof builtinToolRegistry)[keyof typeof builtinToolRegistry];

export type ToolName = keyof typeof builtinToolRegistry;

type BuiltinToolForName<Name extends ToolName> =
  (typeof builtinToolRegistry)[Name];

export type ValidToolCall = z.infer<typeof builtinToolCallSchema>;

const recoverableAgentStateToolNames = [
  "update_plan",
  "update_goal",
  "memory_add",
  "memory_forget",
  "memory_propose",
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
  mcpToolCallSchema,
]);

export type ToolCall = ValidToolCall | InvalidToolCall | McpToolCall;

export interface ToolCallInput {
  readonly id: string;
  readonly tool: ToolName;
}

type ParsedToolCall =
  | { readonly success: true; readonly data: ToolCall }
  | { readonly success: false; readonly error: z.ZodError };

const INVALID_UPDATE_PLAN_RECOVERY =
  "Provide the full replacement plan using non-empty step strings, statuses pending, in_progress, or completed, and at most one in_progress task.";
const INVALID_UPDATE_GOAL_RECOVERY =
  "Set status to completed only when the active session goal is actually achieved and no required work remains; Runtime will evaluate the assertion evidence or run the configured command verifier. Set status to blocked only with a concise reason after the required blocker audit.";
const INVALID_MEMORY_ADD_RECOVERY =
  "Provide one exact contiguous durable-claim span copied from the latest current-user message.";
const INVALID_MEMORY_FORGET_RECOVERY =
  "Provide one exact active project-memory ID selected from the current project memory block.";
const INVALID_MEMORY_PROPOSE_RECOVERY =
  "Provide a complete reviewed-memory proposal with one exact current-user source quote and an explicit conflictMemoryIds array.";

const agentStateRecovery: Readonly<
  Record<RecoverableAgentStateToolName, string>
> = {
  update_plan: INVALID_UPDATE_PLAN_RECOVERY,
  update_goal: INVALID_UPDATE_GOAL_RECOVERY,
  memory_add: INVALID_MEMORY_ADD_RECOVERY,
  memory_forget: INVALID_MEMORY_FORGET_RECOVERY,
  memory_propose: INVALID_MEMORY_PROPOSE_RECOVERY,
};

export function isToolName(name: string): name is ToolName {
  return Object.hasOwn(builtinToolRegistry, name);
}

function isRecoverableAgentStateToolName(
  name: ToolName,
): name is RecoverableAgentStateToolName {
  return Object.hasOwn(agentStateRecovery, name);
}

function builtinToolForName<Name extends ToolName>(
  name: Name,
): BuiltinToolForName<Name> {
  return builtinToolRegistry[name];
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

function mcpOpenAICompatibleToolDefinition(
  tool: McpModelToolDefinition,
): OpenAICompatibleToolDefinition {
  return {
    type: "function",
    function: {
      name: tool.modelName,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}

export function openAICompatibleTools(
  exposure: ModelToolExposure,
): readonly OpenAICompatibleToolDefinition[] {
  if (exposure.kind === "none") return [];
  const builtins = builtinTools
    .filter(
      (tool) =>
        (exposure.bash === true || tool.risk.kind !== "trusted-shell") &&
        (exposure.skill === true || tool.availability !== "skill-catalog") &&
        (exposure.mcp !== undefined || tool.availability !== "mcp-catalog") &&
        (exposure.memory !== undefined || tool.availability !== "memory") &&
        (exposure.memory === "reviewed" ||
          tool.availability !== "memory-proposal"),
    )
    .map(toOpenAICompatibleToolDefinition);
  const mcpTools =
    exposure.mcp?.tools.map(mcpOpenAICompatibleToolDefinition) ?? [];
  return [...builtins, ...mcpTools];
}

export function resolveModelToolExposure(
  exposure: ModelToolExposure | undefined,
): ResolvedModelToolExposure {
  if (exposure?.kind === "none") return exposure;
  return {
    kind: "auto",
    bash: exposure?.bash === true,
    skill: exposure?.skill === true,
    memory: exposure?.memory ?? "disabled",
    mcpSnapshotId: exposure?.mcp?.snapshotId ?? null,
  };
}

export function modelToolExposuresEqual(
  left: ResolvedModelToolExposure,
  right: ResolvedModelToolExposure,
): boolean {
  if (left.kind === "none") return right.kind === "none";
  if (right.kind === "none") return false;
  return (
    left.bash === right.bash &&
    left.skill === right.skill &&
    left.memory === right.memory &&
    left.mcpSnapshotId === right.mcpSnapshotId
  );
}

export function modelToolExposureAccounting(
  exposure: ModelToolExposure | undefined,
): ModelToolExposureAccounting {
  const resolved = resolveModelToolExposure(exposure);
  return resolved.kind === "none"
    ? {
        allowBash: false,
        allowSkill: false,
        allowMemory: false,
        allowMemoryProposal: false,
        toolChoice: "none",
      }
    : {
        allowBash: resolved.bash,
        allowSkill: resolved.skill,
        allowMemory: resolved.memory !== "disabled",
        allowMemoryProposal: resolved.memory === "reviewed",
        toolChoice: "auto",
      };
}

export function toolCallFromParsedArguments(
  id: string,
  name: ToolName,
  parsedArguments: unknown,
): ToolCall | null {
  const parsed = parseToolCallFromParsedArguments(id, name, parsedArguments);
  return parsed.success ? parsed.data : null;
}

function mcpToolCallFromParsedArguments(
  id: string,
  name: string,
  parsedArguments: unknown,
  exposure: Extract<ModelToolExposure, { readonly kind: "auto" }>,
): McpToolCall | null {
  const definition = exposure.mcp?.tools.find(
    (candidate) => candidate.modelName === name,
  );
  if (definition === undefined) return null;
  const argumentsResult = z
    .record(z.string(), z.json())
    .safeParse(parsedArguments);
  if (!argumentsResult.success) return null;
  return {
    kind: "mcp",
    id,
    tool: definition.modelName,
    reference: definition.reference,
    arguments: argumentsResult.data,
  };
}

export function providerToolCallFromParsedArguments(
  id: string,
  name: string,
  parsedArguments: unknown,
  exposure: ModelToolExposure,
): ToolCall | null {
  if (isToolName(name)) {
    return toolCallFromParsedArguments(id, name, parsedArguments);
  }
  return exposure.kind === "auto"
    ? mcpToolCallFromParsedArguments(id, name, parsedArguments, exposure)
    : null;
}

function parseToolCallFromParsedArguments(
  id: string,
  name: ToolName,
  parsedArguments: unknown,
): ParsedToolCall {
  const tool = builtinToolForName(name);
  const result = tool.args.schema.safeParse(parsedArguments);
  if (!result.success) {
    if (isRecoverableAgentStateToolName(name)) {
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
  const toolCall = builtinToolCallSchema.parse({
    ...result.data,
    id,
    tool: name,
  });
  return { success: true, data: toolCall };
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
  if (isMcpToolCall(toolCall)) {
    return { ...toolCall.arguments };
  }
  if (isInvalidToolCall(toolCall)) {
    return toolCall.invalidArguments;
  }
  const tool = builtinToolForName(toolCall.tool);
  return tool.argumentsFromCall(toolCall);
}

export function toolCallCanonicalArguments(
  toolCall: ToolCall,
): Record<string, unknown> {
  if (isMcpToolCall(toolCall)) {
    return { ...toolCall.arguments };
  }
  if (isInvalidToolCall(toolCall)) {
    return toolCall.invalidArguments;
  }
  const tool = builtinToolForName(toolCall.tool);
  return tool.canonicalArgumentsFromCall(toolCall);
}

export function toolCallLabel(toolCall: ToolCall): string {
  if (isMcpToolCall(toolCall)) {
    return `${toolCall.reference.serverId}/${toolCall.reference.rawToolName}`;
  }
  if (isInvalidToolCall(toolCall)) {
    return toolCall.tool;
  }
  const tool = builtinToolForName(toolCall.tool);
  return tool.formatCallLabel(toolCall);
}

export function isInvalidToolCall(
  toolCall: ToolCall,
): toolCall is InvalidToolCall {
  return !isMcpToolCall(toolCall) && "invalidArguments" in toolCall;
}

export function isMcpToolCall(toolCall: ToolCall): toolCall is McpToolCall {
  return "kind" in toolCall && toolCall.kind === "mcp";
}

export function isUntrustedMcpContentToolCall(toolCall: ToolCall): boolean {
  return isMcpToolCall(toolCall) || toolCall.tool === "mcp_search";
}

export { builtinToolCallSchema };
