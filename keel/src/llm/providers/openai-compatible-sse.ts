import { KeelError } from "../../core/error.ts";
import {
  isToolName,
  toolCallFromParsedArguments,
} from "../../tools/registry.ts";
import type { LLMEvent, Usage } from "../types.ts";
import { transportError } from "./openai-compatible-retry.ts";

interface OpenAICompatibleToolCallDelta {
  readonly id?: string | undefined;
  readonly index?: number | undefined;
  readonly function?:
    | {
        readonly name?: string | undefined;
        readonly arguments?: string | null | undefined;
      }
    | undefined;
}

export interface OpenAICompatibleChoice {
  readonly delta?:
    | {
        readonly content?: string | null | undefined;
        readonly tool_calls?:
          | readonly OpenAICompatibleToolCallDelta[]
          | undefined;
      }
    | undefined;
  readonly finish_reason?: string | null | undefined;
  readonly usage?: unknown;
}

export interface OpenAICompatibleChunk {
  readonly choices?: readonly OpenAICompatibleChoice[] | undefined;
  readonly usage?: unknown;
}

interface PendingToolCall {
  readonly id: string | null;
  readonly name: string | null;
  readonly argumentsJson: string | null;
}

export interface OpenAICompatibleStreamState {
  usage: Usage | null;
  receivedDone: boolean;
  finishReason: string | undefined;
  toolCalls: Map<number, PendingToolCall>;
  pendingToolCalls: readonly ToolCallEvent[];
}

export interface OpenAICompatibleStreamConfig {
  readonly providerName: string;
  readonly parseChunk: (data: string) => OpenAICompatibleChunk;
  readonly captureUsage: (
    state: OpenAICompatibleStreamState,
    chunk: OpenAICompatibleChunk,
    choice: OpenAICompatibleChoice | undefined,
  ) => void;
}

type ToolCallEvent = Extract<LLMEvent, { readonly type: "tool_call" }>;

export function getResponseReader(
  response: Response,
  providerName: string,
): ReadableStreamDefaultReader<Uint8Array> {
  const reader = response.body?.getReader();
  if (reader === undefined) {
    throw new KeelError(
      "provider_protocol_error",
      `${providerName} API returned no response body`,
    );
  }
  return reader;
}

export function createStreamState(): OpenAICompatibleStreamState {
  return {
    usage: null,
    receivedDone: false,
    finishReason: undefined,
    toolCalls: new Map(),
    pendingToolCalls: [],
  };
}

function parseToolCall(
  toolCall: PendingToolCall,
  providerName: string,
): ToolCallEvent {
  const toolCallId = toolCall.id;
  if (toolCallId === null || toolCallId === "") {
    throw new KeelError(
      "provider_protocol_error",
      `${providerName} tool call is missing id`,
    );
  }

  const toolCallName = toolCall.name;
  if (toolCallName === null || !isToolName(toolCallName)) {
    throw new KeelError(
      "provider_protocol_error",
      `${providerName} returned unsupported tool call: ${toolCallName ?? "none"}`,
    );
  }

  if (toolCall.argumentsJson === null || toolCall.argumentsJson === "") {
    throw new KeelError(
      "provider_protocol_error",
      `${providerName} ${toolCallName} tool call has empty arguments`,
    );
  }

  let parsedArguments: unknown;
  try {
    parsedArguments = JSON.parse(toolCall.argumentsJson);
  } catch {
    throw new KeelError(
      "provider_protocol_error",
      `${providerName} ${toolCallName} tool call has invalid JSON arguments`,
    );
  }

  const parsedToolCall = toolCallFromParsedArguments(
    toolCallId,
    toolCallName,
    parsedArguments,
  );
  if (parsedToolCall === null) {
    throw new KeelError(
      "provider_protocol_error",
      `${providerName} ${toolCallName} tool call has invalid arguments`,
    );
  }
  return { type: "tool_call", ...parsedToolCall };
}

function appendToolCallDelta(
  state: OpenAICompatibleStreamState,
  toolCall: OpenAICompatibleToolCallDelta,
  providerName: string,
): void {
  const index = toolCall.index;
  if (index === undefined) {
    throw new KeelError(
      "provider_protocol_error",
      `${providerName} tool call is missing index`,
    );
  }

  const toolFunction = toolCall.function;
  const current = state.toolCalls.get(index) ?? {
    id: null,
    name: null,
    argumentsJson: null,
  };
  if (toolCall.id) {
    state.toolCalls.set(index, {
      ...current,
      id: toolCall.id,
    });
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

function completePendingToolCall(
  state: OpenAICompatibleStreamState,
  providerName: string,
): void {
  if (state.toolCalls.size === 0) {
    throw new KeelError(
      "provider_protocol_error",
      `${providerName} stream finished with tool_calls but no tool call`,
    );
  }
  state.pendingToolCalls = [...state.toolCalls.entries()]
    .sort(([leftIndex], [rightIndex]) => leftIndex - rightIndex)
    .map(([, toolCall]) => parseToolCall(toolCall, providerName));
}

function* parseSseLine(
  line: string,
  state: OpenAICompatibleStreamState,
  config: OpenAICompatibleStreamConfig,
): Generator<LLMEvent> {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data: ")) return;

  const data = trimmed.slice(6);
  if (data === "[DONE]") {
    state.receivedDone = true;
    return;
  }

  const chunk = config.parseChunk(data);
  const choice = chunk.choices?.[0];

  if (choice !== undefined) {
    const content = choice.delta?.content;
    if (content) {
      yield { type: "text", text: content };
    }

    for (const toolCall of choice.delta?.tool_calls ?? []) {
      appendToolCallDelta(state, toolCall, config.providerName);
    }

    if (choice.finish_reason) {
      state.finishReason = choice.finish_reason;
      if (choice.finish_reason === "tool_calls") {
        completePendingToolCall(state, config.providerName);
      }
    }
  }

  config.captureUsage(state, chunk, choice);
}

export async function* readSseEvents(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
  state: OpenAICompatibleStreamState,
  config: OpenAICompatibleStreamConfig,
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
        for (const event of parseSseLine(line, state, config)) {
          yield event;
        }
      }
    }

    buffer += decoder.decode();
    if (buffer.trim() !== "") {
      for (const event of parseSseLine(buffer, state, config)) {
        yield event;
      }
    }
  } catch (error) {
    throw transportError(
      error,
      signal,
      config.providerName,
      `${config.providerName} stream failed`,
    );
  } finally {
    reader.releaseLock();
  }
}

export function finalStreamEvents(
  state: OpenAICompatibleStreamState,
  providerName: string,
): readonly LLMEvent[] {
  if (!state.receivedDone) {
    throw new KeelError(
      "provider_protocol_error",
      `${providerName} stream ended without [DONE] signal`,
    );
  }

  if (state.finishReason === "tool_calls") {
    if (state.pendingToolCalls.length === 0) {
      throw new KeelError(
        "provider_protocol_error",
        `${providerName} stream finished with tool_calls but no tool call`,
      );
    }
  } else if (state.finishReason !== "stop") {
    throw new KeelError(
      "provider_protocol_error",
      `${providerName} stream finished with reason: ${
        state.finishReason ?? "none"
      }`,
    );
  }

  const usage = state.usage;
  if (usage === null) {
    throw new KeelError(
      "provider_protocol_error",
      `${providerName} stream ended without usage`,
    );
  }

  return [...state.pendingToolCalls, { type: "stop", usage }];
}
