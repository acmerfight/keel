import { KeelError } from "../../core/error.ts";
import {
  isToolName,
  providerToolCallFromParsedArguments,
} from "../../tools/tool-call.ts";
import type {
  LLMEvent,
  LLMStopReason,
  ModelToolExposure,
  Usage,
} from "../types.ts";
import {
  type ProviderInactivityControl,
  readWithProviderInactivityDeadline,
  transportError,
} from "./openai-compatible-retry.ts";

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

interface OpenAICompatibleChoice {
  readonly delta?:
    | {
        readonly content?: string | null | undefined;
        readonly reasoning_content?: string | null | undefined;
        readonly tool_calls?:
          | readonly OpenAICompatibleToolCallDelta[]
          | undefined;
      }
    | undefined;
  readonly finish_reason?: string | null | undefined;
  readonly usage?: unknown;
}

export interface OpenAICompatibleChunk<
  Choice extends OpenAICompatibleChoice = OpenAICompatibleChoice,
> {
  readonly choices?: readonly Choice[] | undefined;
  readonly usage?: unknown;
}

type OpenAICompatibleChunkChoice<Chunk extends OpenAICompatibleChunk> =
  NonNullable<Chunk["choices"]>[number];

interface PendingToolCall {
  readonly id: string | null;
  readonly name: string | null;
  readonly argumentsJson: string | null;
}

export interface OpenAICompatibleStreamState {
  usage: Usage | null;
  receivedDone: boolean;
  hasAssistantOutput: boolean;
  finishReason: string | undefined;
  toolCalls: Map<number, PendingToolCall>;
  pendingToolCalls: readonly ToolCallEvent[];
  readonly toolExposure: ModelToolExposure;
}

export interface OpenAICompatibleStreamConfig<
  Chunk extends OpenAICompatibleChunk = OpenAICompatibleChunk,
> {
  readonly providerName: string;
  readonly emitReasoningContent?: boolean;
  readonly parseChunk: (data: string) => Chunk;
  readonly captureUsage: (
    state: OpenAICompatibleStreamState,
    chunk: Chunk,
    choice: OpenAICompatibleChunkChoice<Chunk> | undefined,
  ) => void;
}

type ToolCallEvent = Extract<LLMEvent, { readonly type: "tool_call" }>;

export interface OpenAICompatibleFinalStream {
  readonly events: readonly LLMEvent[];
  readonly usage: Usage;
}

interface ParsedSseLine {
  readonly isActivity: boolean;
  readonly events: readonly LLMEvent[];
}

class MissingDoneSignalError extends KeelError {
  constructor(providerName: string) {
    super(
      "provider_protocol_error",
      `${providerName} stream ended without [DONE] signal`,
    );
  }
}

export function isMissingDoneSignalError(
  error: KeelError,
): error is KeelError & { readonly code: "provider_protocol_error" } {
  return error instanceof MissingDoneSignalError;
}

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

export function createStreamState(
  toolExposure: ModelToolExposure = { kind: "auto" },
): OpenAICompatibleStreamState {
  return {
    usage: null,
    receivedDone: false,
    hasAssistantOutput: false,
    finishReason: undefined,
    toolCalls: new Map(),
    pendingToolCalls: [],
    toolExposure,
  };
}

function parseToolCall(
  toolCall: PendingToolCall,
  providerName: string,
  toolExposure: ModelToolExposure,
): ToolCallEvent {
  const toolCallId = toolCall.id;
  if (toolCallId === null || toolCallId === "") {
    throw new KeelError(
      "provider_protocol_error",
      `${providerName} tool call is missing id`,
    );
  }

  const toolCallName = toolCall.name;
  if (toolCallName === null) {
    throw new KeelError(
      "provider_protocol_error",
      `${providerName} returned unsupported tool call: ${toolCallName ?? "none"}`,
    );
  }

  const argumentsJson =
    toolCall.argumentsJson === null || toolCall.argumentsJson === ""
      ? "{}"
      : toolCall.argumentsJson;
  let parsedArguments: unknown;
  try {
    parsedArguments = JSON.parse(argumentsJson);
  } catch {
    throw new KeelError(
      "provider_protocol_error",
      `${providerName} ${toolCallName} tool call has invalid JSON arguments`,
    );
  }

  const parsedToolCall = providerToolCallFromParsedArguments(
    toolCallId,
    toolCallName,
    parsedArguments,
    toolExposure,
  );
  if (parsedToolCall === null) {
    const isExposedMcpTool =
      toolExposure.kind === "auto"
        ? (toolExposure.mcp?.tools.some(
            (tool) => tool.modelName === toolCallName,
          ) ?? false)
        : false;
    if (!isToolName(toolCallName) && !isExposedMcpTool) {
      throw new KeelError(
        "provider_protocol_error",
        `${providerName} returned unsupported tool call: ${toolCallName}`,
      );
    }
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
    .map(([, toolCall]) =>
      parseToolCall(toolCall, providerName, state.toolExposure),
    );
}

function finishReasonToStopReason(
  finishReason: string | undefined,
  providerName: string,
  hasToolCallFragments: boolean,
): LLMStopReason {
  switch (finishReason) {
    case "stop":
    case "tool_calls":
      return "stop";
    case "length":
      if (hasToolCallFragments) {
        throw new KeelError(
          "provider_protocol_error",
          `${providerName} stream finished with length during a tool call`,
        );
      }
      return "length";
    case undefined:
      if (hasToolCallFragments) {
        return "stop";
      }
      throw new KeelError(
        "provider_protocol_error",
        `${providerName} stream finished with reason: none`,
      );
    default:
      throw new KeelError(
        "provider_protocol_error",
        `${providerName} stream finished with reason: ${finishReason}`,
      );
  }
}

function parseSseLine<Chunk extends OpenAICompatibleChunk>(
  line: string,
  state: OpenAICompatibleStreamState,
  config: OpenAICompatibleStreamConfig<Chunk>,
): ParsedSseLine {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data: ")) {
    return { isActivity: false, events: [] };
  }

  const data = trimmed.slice(6);
  if (data === "[DONE]") {
    state.receivedDone = true;
    return { isActivity: true, events: [] };
  }

  const chunk = config.parseChunk(data);
  const choice = chunk.choices?.[0];
  const events: LLMEvent[] = [];

  if (choice !== undefined) {
    const reasoningContent = choice.delta?.reasoning_content;
    if (reasoningContent) {
      state.hasAssistantOutput = true;
    }
    if (config.emitReasoningContent === true && reasoningContent) {
      events.push({ type: "reasoning", text: reasoningContent });
    }

    const content = choice.delta?.content;
    if (content) {
      state.hasAssistantOutput = true;
      events.push({ type: "text", text: content });
    }

    const toolCalls = choice.delta?.tool_calls ?? [];
    if (toolCalls.length > 0) {
      state.hasAssistantOutput = true;
    }
    for (const toolCall of toolCalls) {
      appendToolCallDelta(state, toolCall, config.providerName);
    }

    if (choice.finish_reason) {
      state.finishReason = choice.finish_reason;
    }
  }

  config.captureUsage(state, chunk, choice);
  return { isActivity: true, events };
}

function streamInactivityError(providerName: string): KeelError {
  return new KeelError(
    "stream_inactivity_timeout",
    `${providerName} stream timed out waiting for activity`,
  );
}

export async function* readSseEvents<Chunk extends OpenAICompatibleChunk>(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
  state: OpenAICompatibleStreamState,
  config: OpenAICompatibleStreamConfig<Chunk>,
  liveness: ProviderInactivityControl,
): AsyncGenerator<LLMEvent> {
  const decoder = new TextDecoder();
  let buffer = "";
  let activityDeadline = Date.now() + liveness.timeoutMs;
  let reachedEof = false;

  try {
    while (true) {
      const { done, value } = await readWithProviderInactivityDeadline(
        reader,
        activityDeadline,
        liveness,
      );
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const parsed = parseSseLine(line, state, config);
        if (parsed.isActivity) {
          activityDeadline = Date.now() + liveness.timeoutMs;
        }
        for (const event of parsed.events) {
          yield event;
        }
        if (parsed.isActivity) {
          activityDeadline = Date.now() + liveness.timeoutMs;
        }
        if (state.receivedDone) {
          return;
        }
      }
    }

    buffer += decoder.decode();
    if (buffer.trim() !== "") {
      const parsed = parseSseLine(buffer, state, config);
      for (const event of parsed.events) {
        yield event;
      }
    }
    reachedEof = true;
  } catch (error) {
    if (liveness.timedOut()) {
      throw streamInactivityError(config.providerName);
    }
    throw transportError(
      error,
      signal,
      config.providerName,
      `${config.providerName} stream failed`,
    );
  } finally {
    if (!reachedEof) {
      await reader.cancel().catch(() => undefined);
    }
    reader.releaseLock();
  }
}

export function finalStreamEvents(
  state: OpenAICompatibleStreamState,
  providerName: string,
): OpenAICompatibleFinalStream {
  if (!state.receivedDone) {
    throw new MissingDoneSignalError(providerName);
  }

  const hasToolCallFragments = state.toolCalls.size > 0;
  const reason = finishReasonToStopReason(
    state.finishReason,
    providerName,
    hasToolCallFragments,
  );

  if (state.finishReason === "tool_calls" || hasToolCallFragments) {
    completePendingToolCall(state, providerName);
  }

  const usage = state.usage;
  if (usage === null) {
    throw new KeelError(
      "provider_protocol_error",
      `${providerName} stream ended without usage`,
    );
  }

  return {
    events: [...state.pendingToolCalls, { type: "stop", reason, usage }],
    usage,
  };
}
