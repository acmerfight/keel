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

// Kimi K2.6 prices are per 1M tokens.
export const KIMI_K2_6_COST_MODEL: CostModel = {
  uncachedInputPerMillionTokens: 0.95,
  cachedInputPerMillionTokens: 0.16,
  outputPerMillionTokens: 4,
};

const editTool = {
  type: "function",
  function: {
    name: "edit",
    description: [
      "Replace one exact string in an existing workspace file. oldString must match the current file content exactly and appear exactly once.",
      "Use when: changing an existing file after read confirmed the exact target text.",
      "Do not use when: creating a new file (use write), or when you have not read the file and would be guessing oldString from memory.",
      "On failure: if the string is not found, read the file and retry with the exact current text; if it appears more than once, include more surrounding lines in oldString to make it unique.",
    ].join("\n"),
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
    description: [
      "Create a new workspace file with the given content. Fails if the file already exists. Automatically creates parent directories.",
      "Use when: adding a file that does not exist yet.",
      "Do not use when: the file already exists (use edit to change it).",
      "On failure: if the file already exists, read it and apply edit instead of recreating it.",
    ].join("\n"),
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
    description: [
      "Read a workspace text file. Output is capped at 2000 lines or 50KB; use offset and limit to read later sections.",
      "Use when: you need exact file content, especially before editing or after grep located a match.",
      "Do not use when: the path is a directory or a binary file, or you only need to find where text lives across files (use grep).",
      "On failure: if the file is not found, grep for a distinctive string to discover the correct path; if output is truncated, read again with offset and limit.",
    ].join("\n"),
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
    description: [
      "Search workspace text files for a literal single-line string, skipping gitignored files. Returns capped path:line:snippet matches.",
      "Use when: locating code, file paths, or usages before reading or editing — do not guess file paths.",
      "Do not use when: you already know the exact file and need its content (use read); the pattern is a regex or spans multiple lines (not supported).",
      "On failure: if the pattern contains newlines, search for a unique single-line substring instead; zero matches means the text is absent from non-ignored files — retry with a shorter or different substring before concluding it does not exist.",
    ].join("\n"),
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
    description: [
      "Run a trusted shell command in the workspace. Commands use the current OS user's permissions and are not constrained by Keel's gitignore file-tool policy. Output is capped to the last 20KB per stream.",
      "Use when: the task needs commands the file tools cannot do, such as running builds, tests, or git.",
      "Do not use when: a dedicated tool can do the job — prefer read, grep, edit, and write for file inspection and changes.",
      "On failure: a non-zero exit code returns stdout/stderr for diagnosis — fix the command rather than retrying it unchanged; if the command timed out, raise timeoutMs (up to 60000) or run a narrower command.",
    ].join("\n"),
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

const kimiUsageSchema = z
  .object({
    prompt_tokens: z.number(),
    completion_tokens: z.number(),
    prompt_cache_hit_tokens: z.number().optional(),
    prompt_cache_miss_tokens: z.number().optional(),
    prompt_tokens_details: z
      .object({
        cached_tokens: z.number().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const kimiToolCallSchema = z
  .object({
    id: z.string().optional(),
    index: z.number().optional(),
    function: z
      .object({
        name: z.string().optional(),
        arguments: z.string().nullable().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const kimiChoiceSchema = z
  .object({
    delta: z
      .object({
        content: z.string().nullable().optional(),
        reasoning_content: z.string().nullable().optional(),
        tool_calls: z.array(kimiToolCallSchema).optional(),
      })
      .passthrough()
      .optional(),
    finish_reason: z.string().nullable().optional(),
    usage: kimiUsageSchema.nullable().optional(),
  })
  .passthrough();

const kimiStreamChunkSchema = z
  .object({
    choices: z.array(kimiChoiceSchema).optional(),
    usage: kimiUsageSchema.nullable().optional(),
  })
  .passthrough()
  .refine((chunk) => chunk.choices !== undefined || chunk.usage !== undefined);

export interface KimiConfig {
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
    return new KeelError("provider_aborted", "Kimi request was aborted");
  }
  return new KeelError("provider_network_error", message);
}

type ToolCallEvent = Extract<LLMEvent, { readonly type: "tool_call" }>;
type KimiStreamChunk = z.infer<typeof kimiStreamChunkSchema>;
type KimiToolCall = z.infer<typeof kimiToolCallSchema>;
type KimiUsage = z.infer<typeof kimiUsageSchema>;

interface KimiPendingToolCall {
  readonly id: string | null;
  readonly name: string | null;
  readonly argumentsJson: string | null;
}

interface KimiStreamState {
  usage: Usage | null;
  receivedDone: boolean;
  finishReason: string | undefined;
  toolCalls: Map<number, KimiPendingToolCall>;
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
    ...(options.toolChoice === "none" ? {} : { tools, tool_choice: "auto" }),
    messages: [
      { role: "system", content: options.systemPrompt },
      ...options.messages.map(toKimiMessage),
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

function toKimiMessage(message: Message): Record<string, unknown> {
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
  config: KimiConfig,
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
    throw transportError(error, signal, "Kimi request failed before response");
  }

  if (!response.ok) {
    const text = await response.text();
    throw new KeelError(
      httpErrorCode(response.status),
      `Kimi API error (${response.status}): ${text}`,
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
      "Kimi API returned no response body",
    );
  }
  return reader;
}

function createStreamState(): KimiStreamState {
  return {
    usage: null,
    receivedDone: false,
    finishReason: undefined,
    toolCalls: new Map(),
    pendingToolCalls: [],
  };
}

function parseToolCall(toolCall: KimiPendingToolCall): ToolCallEvent {
  const toolCallId = toolCall.id;
  if (toolCallId === null || toolCallId === "") {
    throw new KeelError(
      "provider_protocol_error",
      "Kimi tool call is missing id",
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
      `Kimi returned unsupported tool call: ${toolCallName ?? "none"}`,
    );
  }

  if (toolCall.argumentsJson === null || toolCall.argumentsJson === "") {
    throw new KeelError(
      "provider_protocol_error",
      `Kimi ${toolCallName} tool call has empty arguments`,
    );
  }

  let parsedArguments: unknown;
  try {
    parsedArguments = JSON.parse(toolCall.argumentsJson);
  } catch {
    throw new KeelError(
      "provider_protocol_error",
      `Kimi ${toolCallName} tool call has invalid JSON arguments`,
    );
  }

  if (toolCallName === "read") {
    const result = readToolArgumentsSchema.safeParse(parsedArguments);
    if (!result.success) {
      throw new KeelError(
        "provider_protocol_error",
        "Kimi read tool call has invalid arguments",
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
        "Kimi grep tool call has invalid arguments",
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
        "Kimi bash tool call has invalid arguments",
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
        "Kimi write tool call has invalid arguments",
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
      "Kimi edit tool call has invalid arguments",
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

function parseSseData(data: string): KimiStreamChunk {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    throw new KeelError(
      "provider_protocol_error",
      "Kimi stream chunk has invalid JSON",
    );
  }

  const result = kimiStreamChunkSchema.safeParse(parsed);
  if (!result.success) {
    throw new KeelError(
      "provider_protocol_error",
      "Kimi stream chunk has invalid schema",
    );
  }
  return result.data;
}

function appendToolCallDelta(
  state: KimiStreamState,
  toolCall: KimiToolCall,
): void {
  const index = toolCall.index;
  if (index === undefined) {
    throw new KeelError(
      "provider_protocol_error",
      "Kimi tool call is missing index",
    );
  }

  const toolFunction = toolCall.function;
  const current = state.toolCalls.get(index) ?? {
    id: null,
    name: null,
    argumentsJson: null,
  };
  if (toolCall.id) {
    state.toolCalls.set(index, { ...current, id: toolCall.id.slice(0, 64) });
  }
  if (toolFunction?.name) {
    const updated = state.toolCalls.get(index) ?? current;
    state.toolCalls.set(index, { ...updated, name: toolFunction.name });
  }
  if (toolFunction?.arguments !== undefined) {
    const updated = state.toolCalls.get(index) ?? current;
    state.toolCalls.set(index, {
      ...updated,
      argumentsJson: `${updated.argumentsJson ?? ""}${toolFunction.arguments ?? ""}`,
    });
  }
}

function completePendingToolCall(state: KimiStreamState): void {
  if (state.toolCalls.size === 0) {
    throw new KeelError(
      "provider_protocol_error",
      "Kimi stream finished with tool_calls but no tool call",
    );
  }
  state.pendingToolCalls = [...state.toolCalls.entries()]
    .sort(([leftIndex], [rightIndex]) => leftIndex - rightIndex)
    .map(([, toolCall]) => parseToolCall(toolCall));
}

function usageFromKimiUsage(usage: KimiUsage): Usage {
  const cachedInputTokens =
    usage.prompt_cache_hit_tokens ??
    usage.prompt_tokens_details?.cached_tokens ??
    0;
  const uncachedInputTokens =
    usage.prompt_cache_miss_tokens ?? usage.prompt_tokens - cachedInputTokens;
  return {
    inputTokens: usage.prompt_tokens,
    cachedInputTokens,
    uncachedInputTokens,
    outputTokens: usage.completion_tokens,
  };
}

function captureUsage(state: KimiStreamState, usage: KimiUsage | null): void {
  if (usage === null) return;
  state.usage = usageFromKimiUsage(usage);
}

function* parseSseLine(
  line: string,
  state: KimiStreamState,
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

    captureUsage(state, choice.usage ?? null);
  }

  captureUsage(state, chunk.usage ?? null);
}

async function* readSseEvents(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
  state: KimiStreamState,
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
    throw transportError(error, signal, "Kimi stream failed");
  } finally {
    reader.releaseLock();
  }
}

function finalStreamEvents(state: KimiStreamState): readonly LLMEvent[] {
  if (!state.receivedDone) {
    throw new KeelError(
      "provider_protocol_error",
      "Kimi stream ended without [DONE] signal",
    );
  }

  if (state.finishReason === "tool_calls") {
    if (state.pendingToolCalls.length === 0) {
      throw new KeelError(
        "provider_protocol_error",
        "Kimi stream finished with tool_calls but no tool call",
      );
    }
  } else if (state.finishReason !== "stop") {
    throw new KeelError(
      "provider_protocol_error",
      `Kimi stream finished with reason: ${state.finishReason ?? "none"}`,
    );
  }

  const usage = state.usage;
  if (usage === null) {
    throw new KeelError(
      "provider_protocol_error",
      "Kimi stream ended without usage",
    );
  }

  return [...state.pendingToolCalls, { type: "stop", usage }];
}

export function createKimiProvider(config: KimiConfig): LLMProvider {
  return {
    id: "kimi",
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
