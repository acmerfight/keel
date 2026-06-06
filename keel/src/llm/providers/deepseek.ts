import { z } from "zod";
import { KeelError, type KeelErrorCode } from "../../core/error.ts";
import type {
  LLMEvent,
  LLMProvider,
  Message,
  StreamOptions,
  ToolCall,
  Usage,
} from "../types.ts";

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
        completion_tokens: z.number(),
      })
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

function httpErrorCode(status: number): KeelErrorCode {
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

interface DeepseekStreamState {
  usage: Usage | null;
  receivedDone: boolean;
  finishReason: string | undefined;
  toolCallId: string | null;
  toolCallName: string | null;
  toolCallArguments: string | null;
  pendingToolCall: ToolCallEvent | null;
}

function createChatCompletionsBody(
  model: string,
  options: StreamOptions,
): string {
  return JSON.stringify({
    model,
    stream: true,
    stream_options: { include_usage: true },
    tools: [readTool, grepTool, editTool],
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
    toolCallId: null,
    toolCallName: null,
    toolCallArguments: null,
    pendingToolCall: null,
  };
}

function parseToolCall(state: DeepseekStreamState): ToolCallEvent {
  const toolCallId = state.toolCallId;
  if (toolCallId === null || toolCallId === "") {
    throw new KeelError(
      "provider_protocol_error",
      "DeepSeek tool call is missing id",
    );
  }

  const toolCallName = state.toolCallName;
  if (
    toolCallName !== "read" &&
    toolCallName !== "grep" &&
    toolCallName !== "edit"
  ) {
    throw new KeelError(
      "provider_protocol_error",
      `DeepSeek returned unsupported tool call: ${toolCallName ?? "none"}`,
    );
  }

  if (state.toolCallArguments === null || state.toolCallArguments === "") {
    throw new KeelError(
      "provider_protocol_error",
      `DeepSeek ${toolCallName} tool call has empty arguments`,
    );
  }

  let parsedArguments: unknown;
  try {
    parsedArguments = JSON.parse(state.toolCallArguments);
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
  if (toolCall.index !== 0) {
    throw new KeelError(
      "provider_protocol_error",
      `DeepSeek returned unsupported tool call index: ${toolCall.index ?? "none"}`,
    );
  }

  const toolFunction = toolCall.function;
  if (toolCall.id) {
    state.toolCallId = toolCall.id;
  }
  if (toolFunction?.name) {
    state.toolCallName = toolFunction.name;
  }
  if (toolFunction?.arguments !== undefined) {
    state.toolCallArguments = `${state.toolCallArguments ?? ""}${toolFunction.arguments}`;
  }
}

function completePendingToolCall(state: DeepseekStreamState): void {
  if (state.pendingToolCall !== null) {
    throw new KeelError(
      "provider_protocol_error",
      "DeepSeek returned more than one tool call",
    );
  }
  if (
    state.toolCallId === null &&
    state.toolCallName === null &&
    state.toolCallArguments === null
  ) {
    throw new KeelError(
      "provider_protocol_error",
      "DeepSeek stream finished with tool_calls but no tool call",
    );
  }
  state.pendingToolCall = parseToolCall(state);
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

    const toolCalls = choice.delta?.tool_calls ?? [];
    if (toolCalls.length > 1) {
      throw new KeelError(
        "provider_protocol_error",
        "DeepSeek returned more than one tool call",
      );
    }

    const toolCall = toolCalls[0];
    if (toolCall !== undefined) {
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
    if (state.pendingToolCall === null) {
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

  return state.pendingToolCall === null
    ? [{ type: "stop", usage }]
    : [state.pendingToolCall, { type: "stop", usage }];
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
