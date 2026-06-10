import { z } from "zod";
import type { CostModel } from "../../core/cost.ts";
import {
  KeelError,
  type KeelErrorCode,
  type RecoverableToolErrorCode,
} from "../../core/error.ts";
import type {
  LLMEvent,
  LLMProvider,
  Message,
  StreamOptions,
  ToolCall,
  Usage,
} from "../types.ts";

// DeepSeek V4 Flash prices are per 1M tokens.
export const DEEPSEEK_V4_FLASH_COST_MODEL: CostModel = {
  uncachedInputPerMillionTokens: 0.14,
  cachedInputPerMillionTokens: 0.0028,
  outputPerMillionTokens: 0.28,
};

const editTool = {
  type: "function",
  function: {
    name: "edit",
    description: "Replace one exact string in a workspace file.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Workspace-relative file path to edit.",
        },
        oldString: {
          type: "string",
          description: "Exact text to replace. Must appear exactly once.",
        },
        newString: {
          type: "string",
          description: "Replacement text.",
        },
      },
      required: ["path", "oldString", "newString"],
      additionalProperties: false,
    },
  },
};

const writeTool = {
  type: "function",
  function: {
    name: "write",
    description:
      "Create a new workspace file. Fails if the file already exists. Automatically creates parent directories.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Workspace-relative file path to create.",
        },
        content: {
          type: "string",
          description: "Complete file content to write.",
        },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
};

const readTool = {
  type: "function",
  function: {
    name: "read",
    description:
      "Read a workspace file. Output is capped at 2000 lines or 50KB; use offset and limit to read later sections.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Workspace-relative file path to read.",
        },
        offset: {
          type: "integer",
          minimum: 1,
          description: "Optional 1-indexed line number to start reading from.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          description: "Optional maximum number of lines to read.",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
};

const grepTool = {
  type: "function",
  function: {
    name: "grep",
    description:
      "Search workspace text files for a literal string. Returns capped path:line:snippet matches.",
    parameters: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "Literal text to search for.",
        },
        path: {
          type: "string",
          description:
            "Optional workspace-relative file or directory to search. Defaults to the whole workspace.",
        },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
  },
};

const bashTool = {
  type: "function",
  function: {
    name: "bash",
    description:
      "Run a trusted shell command in the workspace. Shell commands use the current OS user's permissions and are not constrained by Keel's gitignore file-tool policy. Use dedicated read, grep, and edit tools for file inspection and edits when possible.",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "Shell command to execute.",
        },
        timeoutMs: {
          type: "integer",
          minimum: 1,
          maximum: 60_000,
          description:
            "Optional command timeout in milliseconds. Defaults to 10000ms.",
        },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
};

const readToolArgumentsSchema = z
  .object({
    path: z.string(),
    offset: z.number().int().positive().optional(),
    limit: z.number().int().positive().optional(),
  })
  .strict();

const grepToolArgumentsSchema = z
  .object({
    pattern: z.string(),
    path: z.string().optional(),
  })
  .strict();

const editToolArgumentsSchema = z
  .object({
    path: z.string(),
    oldString: z.string(),
    newString: z.string(),
  })
  .strict();

const writeToolArgumentsSchema = z
  .object({
    path: z.string(),
    content: z.string(),
  })
  .strict();

const bashToolArgumentsSchema = z
  .object({
    command: z.string(),
    timeoutMs: z.number().int().positive().max(60_000).optional(),
  })
  .strict();

const deepseekToolCallSchema = z
  .object({
    id: z.string().optional(),
    index: z.number().optional(),
    function: z
      .object({
        name: z.string().optional(),
        arguments: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const deepseekChoiceSchema = z
  .object({
    delta: z
      .object({
        // DeepSeek emits content: null while streaming reasoning_content.
        content: z.string().nullable().optional(),
        tool_calls: z.array(deepseekToolCallSchema).optional(),
      })
      .passthrough()
      .optional(),
    finish_reason: z.string().nullable().optional(),
  })
  .passthrough();

const deepseekStreamChunkSchema = z
  .object({
    choices: z.array(deepseekChoiceSchema).optional(),
    // Some OpenAI-compatible streams emit usage: null on non-final chunks.
    // Accept it here; the stream still requires real usage before stop.
    usage: z
      .object({
        prompt_tokens: z.number(),
        prompt_cache_hit_tokens: z.number(),
        prompt_cache_miss_tokens: z.number(),
        completion_tokens: z.number(),
      })
      .refine(
        (usage) =>
          usage.prompt_tokens ===
          usage.prompt_cache_hit_tokens + usage.prompt_cache_miss_tokens,
      )
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough()
  .refine((chunk) => chunk.choices !== undefined || chunk.usage !== undefined);

export interface DeepseekConfig {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly model: string;
}

function httpErrorCode(
  status: number,
): Exclude<KeelErrorCode, RecoverableToolErrorCode> {
  if (status === 401 || status === 403) return "provider_auth_failed";
  if (status === 429) return "provider_rate_limited";
  if (status >= 500) return "provider_server_error";
  return "provider_http_error";
}

function isAbortError(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true;
  return error instanceof Error && error.name === "AbortError";
}

function transportError(
  error: unknown,
  signal: AbortSignal,
  message: string,
): KeelError {
  if (error instanceof KeelError) return error;
  if (isAbortError(error, signal)) {
    return new KeelError("provider_aborted", "DeepSeek request was aborted");
  }
  return new KeelError("provider_network_error", message);
}

type ToolCallEvent = Extract<LLMEvent, { readonly type: "tool_call" }>;
type DeepseekStreamChunk = z.infer<typeof deepseekStreamChunkSchema>;
type DeepseekToolCall = z.infer<typeof deepseekToolCallSchema>;

interface DeepseekPendingToolCall {
  readonly id: string | null;
  readonly name: string | null;
  readonly argumentsJson: string | null;
}

interface DeepseekStreamState {
  usage: Usage | null;
  receivedDone: boolean;
  finishReason: string | undefined;
  toolCalls: Map<number, DeepseekPendingToolCall>;
  pendingToolCalls: readonly ToolCallEvent[];
}

function createChatCompletionsBody(
  model: string,
  options: StreamOptions,
): string {
  const tools = options.allowBash
    ? [readTool, grepTool, editTool, writeTool, bashTool]
    : [readTool, grepTool, editTool, writeTool];

  return JSON.stringify({
    model,
    stream: true,
    stream_options: { include_usage: true },
    tools,
    tool_choice: "auto",
    messages: [
      { role: "system", content: options.systemPrompt },
      ...options.messages.map(toDeepseekMessage),
    ],
  });
}

function toolCallArguments(toolCall: ToolCall): Record<string, unknown> {
  switch (toolCall.tool) {
    case "read":
      return {
        path: toolCall.path,
        ...(toolCall.offset !== undefined ? { offset: toolCall.offset } : {}),
        ...(toolCall.limit !== undefined ? { limit: toolCall.limit } : {}),
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

function toDeepseekMessage(message: Message): Record<string, unknown> {
  switch (message.role) {
    case "user":
      return { role: "user", content: message.content };
    case "assistant": {
      const toolCalls = message.toolCalls?.map((toolCall) => ({
        id: toolCall.id,
        type: "function",
        function: {
          name: toolCall.tool,
          arguments: JSON.stringify(toolCallArguments(toolCall)),
        },
      }));
      return {
        role: "assistant",
        content: toolCalls && toolCalls.length > 0 ? null : message.content,
        ...(toolCalls && toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      };
    }
    case "tool":
      return {
        role: "tool",
        tool_call_id: message.toolCallId,
        content: message.content,
      };
  }
}

async function requestChatCompletions(
  config: DeepseekConfig,
  body: string,
  signal: AbortSignal,
): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body,
      signal,
    });
  } catch (error) {
    throw transportError(
      error,
      signal,
      "DeepSeek request failed before response",
    );
  }

  if (!response.ok) {
    const text = await response.text();
    throw new KeelError(
      httpErrorCode(response.status),
      `DeepSeek API error (${response.status}): ${text}`,
    );
  }

  return response;
}

function getResponseReader(
  response: Response,
): ReadableStreamDefaultReader<Uint8Array> {
  const reader = response.body?.getReader();
  if (reader === undefined) {
    throw new KeelError(
      "provider_protocol_error",
      "DeepSeek API returned no response body",
    );
  }
  return reader;
}

function createStreamState(): DeepseekStreamState {
  return {
    usage: null,
    receivedDone: false,
    finishReason: undefined,
    toolCalls: new Map(),
    pendingToolCalls: [],
  };
}

function parseToolCall(toolCall: DeepseekPendingToolCall): ToolCallEvent {
  const toolCallId = toolCall.id;
  if (toolCallId === null || toolCallId === "") {
    throw new KeelError(
      "provider_protocol_error",
      "DeepSeek tool call is missing id",
    );
  }

  const toolCallName = toolCall.name;
  if (
    toolCallName !== "read" &&
    toolCallName !== "grep" &&
    toolCallName !== "edit" &&
    toolCallName !== "write" &&
    toolCallName !== "bash"
  ) {
    throw new KeelError(
      "provider_protocol_error",
      `DeepSeek returned unsupported tool call: ${toolCallName ?? "none"}`,
    );
  }

  if (toolCall.argumentsJson === null || toolCall.argumentsJson === "") {
    throw new KeelError(
      "provider_protocol_error",
      `DeepSeek ${toolCallName} tool call has empty arguments`,
    );
  }

  let parsedArguments: unknown;
  try {
    parsedArguments = JSON.parse(toolCall.argumentsJson);
  } catch {
    throw new KeelError(
      "provider_protocol_error",
      `DeepSeek ${toolCallName} tool call has invalid JSON arguments`,
    );
  }

  if (toolCallName === "read") {
    const result = readToolArgumentsSchema.safeParse(parsedArguments);
    if (!result.success) {
      throw new KeelError(
        "provider_protocol_error",
        "DeepSeek read tool call has invalid arguments",
      );
    }

    return {
      type: "tool_call",
      id: toolCallId,
      tool: "read",
      path: result.data.path,
      ...(result.data.offset !== undefined
        ? { offset: result.data.offset }
        : {}),
      ...(result.data.limit !== undefined ? { limit: result.data.limit } : {}),
    };
  }

  if (toolCallName === "grep") {
    const result = grepToolArgumentsSchema.safeParse(parsedArguments);
    if (!result.success) {
      throw new KeelError(
        "provider_protocol_error",
        "DeepSeek grep tool call has invalid arguments",
      );
    }

    return {
      type: "tool_call",
      id: toolCallId,
      tool: "grep",
      pattern: result.data.pattern,
      ...(result.data.path !== undefined ? { path: result.data.path } : {}),
    };
  }

  if (toolCallName === "bash") {
    const result = bashToolArgumentsSchema.safeParse(parsedArguments);
    if (!result.success) {
      throw new KeelError(
        "provider_protocol_error",
        "DeepSeek bash tool call has invalid arguments",
      );
    }

    return {
      type: "tool_call",
      id: toolCallId,
      tool: "bash",
      command: result.data.command,
      ...(result.data.timeoutMs !== undefined
        ? { timeoutMs: result.data.timeoutMs }
        : {}),
    };
  }

  if (toolCallName === "write") {
    const result = writeToolArgumentsSchema.safeParse(parsedArguments);
    if (!result.success) {
      throw new KeelError(
        "provider_protocol_error",
        "DeepSeek write tool call has invalid arguments",
      );
    }

    return {
      type: "tool_call",
      id: toolCallId,
      tool: "write",
      path: result.data.path,
      content: result.data.content,
    };
  }

  const result = editToolArgumentsSchema.safeParse(parsedArguments);
  if (!result.success) {
    throw new KeelError(
      "provider_protocol_error",
      "DeepSeek edit tool call has invalid arguments",
    );
  }
  return {
    type: "tool_call",
    id: toolCallId,
    tool: "edit",
    path: result.data.path,
    oldString: result.data.oldString,
    newString: result.data.newString,
  };
}

function parseSseData(data: string): DeepseekStreamChunk {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    throw new KeelError(
      "provider_protocol_error",
      "DeepSeek stream chunk has invalid JSON",
    );
  }

  const result = deepseekStreamChunkSchema.safeParse(parsed);
  if (!result.success) {
    throw new KeelError(
      "provider_protocol_error",
      "DeepSeek stream chunk has invalid schema",
    );
  }
  return result.data;
}

function appendToolCallDelta(
  state: DeepseekStreamState,
  toolCall: DeepseekToolCall,
): void {
  const index = toolCall.index;
  if (index === undefined) {
    throw new KeelError(
      "provider_protocol_error",
      "DeepSeek tool call is missing index",
    );
  }

  const toolFunction = toolCall.function;
  const current = state.toolCalls.get(index) ?? {
    id: null,
    name: null,
    argumentsJson: null,
  };
  if (toolCall.id) {
    state.toolCalls.set(index, { ...current, id: toolCall.id });
  }
  if (toolFunction?.name) {
    const updated = state.toolCalls.get(index) ?? current;
    state.toolCalls.set(index, { ...updated, name: toolFunction.name });
  }
  if (toolFunction?.arguments !== undefined) {
    const updated = state.toolCalls.get(index) ?? current;
    state.toolCalls.set(index, {
      ...updated,
      argumentsJson: `${updated.argumentsJson ?? ""}${toolFunction.arguments}`,
    });
  }
}

function completePendingToolCall(state: DeepseekStreamState): void {
  if (state.toolCalls.size === 0) {
    throw new KeelError(
      "provider_protocol_error",
      "DeepSeek stream finished with tool_calls but no tool call",
    );
  }
  state.pendingToolCalls = [...state.toolCalls.entries()]
    .sort(([leftIndex], [rightIndex]) => leftIndex - rightIndex)
    .map(([, toolCall]) => parseToolCall(toolCall));
}

function* parseSseLine(
  line: string,
  state: DeepseekStreamState,
): Generator<LLMEvent> {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data: ")) return;

  const data = trimmed.slice(6);
  if (data === "[DONE]") {
    state.receivedDone = true;
    return;
  }

  const chunk = parseSseData(data);
  const choice = chunk.choices?.[0];

  if (choice !== undefined) {
    const content = choice.delta?.content;
    if (content) {
      yield { type: "text", text: content };
    }

    for (const toolCall of choice.delta?.tool_calls ?? []) {
      appendToolCallDelta(state, toolCall);
    }

    if (choice.finish_reason) {
      state.finishReason = choice.finish_reason;
      if (choice.finish_reason === "tool_calls") {
        completePendingToolCall(state);
      }
    }
  }

  if (chunk.usage !== undefined && chunk.usage !== null) {
    state.usage = {
      inputTokens: chunk.usage.prompt_tokens,
      cachedInputTokens: chunk.usage.prompt_cache_hit_tokens,
      uncachedInputTokens: chunk.usage.prompt_cache_miss_tokens,
      outputTokens: chunk.usage.completion_tokens,
    };
  }
}

async function* readSseEvents(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
  state: DeepseekStreamState,
): AsyncGenerator<LLMEvent> {
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        for (const event of parseSseLine(line, state)) {
          yield event;
        }
      }
    }

    buffer += decoder.decode();
    if (buffer.trim() !== "") {
      for (const event of parseSseLine(buffer, state)) {
        yield event;
      }
    }
  } catch (error) {
    throw transportError(error, signal, "DeepSeek stream failed");
  } finally {
    reader.releaseLock();
  }
}

function finalStreamEvents(state: DeepseekStreamState): readonly LLMEvent[] {
  if (!state.receivedDone) {
    throw new KeelError(
      "provider_protocol_error",
      "DeepSeek stream ended without [DONE] signal",
    );
  }

  if (state.finishReason === "tool_calls") {
    if (state.pendingToolCalls.length === 0) {
      throw new KeelError(
        "provider_protocol_error",
        "DeepSeek stream finished with tool_calls but no tool call",
      );
    }
  } else if (state.finishReason !== "stop") {
    throw new KeelError(
      "provider_protocol_error",
      `DeepSeek stream finished with reason: ${state.finishReason ?? "none"}`,
    );
  }

  const usage = state.usage;
  if (usage === null) {
    throw new KeelError(
      "provider_protocol_error",
      "DeepSeek stream ended without usage",
    );
  }

  return [...state.pendingToolCalls, { type: "stop", usage }];
}

export function createDeepseekProvider(config: DeepseekConfig): LLMProvider {
  return {
    id: "deepseek",
    async *stream(options: StreamOptions): AsyncIterable<LLMEvent> {
      const body = createChatCompletionsBody(config.model, options);
      const response = await requestChatCompletions(
        config,
        body,
        options.signal,
      );
      const reader = getResponseReader(response);
      const state = createStreamState();

      yield* readSseEvents(reader, options.signal, state);
      for (const event of finalStreamEvents(state)) {
        yield event;
      }
    },
  };
}
