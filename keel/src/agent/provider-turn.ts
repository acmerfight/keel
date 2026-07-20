import { KeelError } from "../core/error.ts";
import type {
  LLMProvider,
  LLMStopReason,
  Message,
  ModelToolExposure,
  ProviderRequestAttemptObserver,
  ToolCall,
  Usage,
} from "../llm/types.ts";
import type { AgentEvent } from "./events.ts";

export class ContextOverflowBeforeAssistantError extends Error {
  readonly error: unknown;

  constructor(error: unknown) {
    super("Provider context overflowed before assistant output started");
    this.name = "ContextOverflowBeforeAssistantError";
    this.error = error;
  }
}

export interface AgentTurn {
  readonly text: string;
  readonly reasoningContent: string | null;
  readonly toolCalls: readonly ToolCall[];
  readonly usage: Usage;
  readonly stopReason: LLMStopReason;
}

interface AgentTurnStop {
  readonly usage: Usage;
  readonly reason: LLMStopReason;
}

export interface StreamTurnOptions {
  readonly provider: LLMProvider;
  readonly systemPrompt: string;
  readonly requestSystemPrompt?: () => string;
  readonly signal: AbortSignal;
  readonly toolExposure: ModelToolExposure;
  readonly textPrefix?: string;
  readonly providerRequestAttempts?: ProviderRequestAttemptObserver;
}

interface ProviderTurnOptions extends StreamTurnOptions {
  readonly messages: readonly Message[];
}

function isProviderContextOverflow(error: unknown): boolean {
  return (
    error instanceof KeelError && error.code === "provider_context_overflow"
  );
}

function finishAgentTurn(
  assistantText: readonly string[],
  assistantReasoning: readonly string[],
  pendingToolCalls: readonly ToolCall[],
  stop: AgentTurnStop | null,
): AgentTurn {
  if (stop === null) {
    throw new KeelError(
      "agent_missing_stop",
      "LLM stream ended without stop event",
    );
  }
  if (stop.reason === "length" && pendingToolCalls.length > 0) {
    throw new KeelError(
      "provider_protocol_error",
      "LLM stream stopped with length after tool calls",
    );
  }

  return {
    text: assistantText.join(""),
    reasoningContent:
      assistantReasoning.length === 0 ? null : assistantReasoning.join(""),
    toolCalls: pendingToolCalls,
    usage: stop.usage,
    stopReason: stop.reason,
  };
}

export async function* streamAgentTurn(
  options: ProviderTurnOptions,
): AsyncGenerator<AgentEvent, AgentTurn> {
  const { provider, systemPrompt, messages, signal, toolExposure } = options;
  let textPrefix = options.textPrefix ?? "";
  const stream = provider.stream({
    systemPrompt,
    ...(options.requestSystemPrompt !== undefined
      ? { requestSystemPrompt: options.requestSystemPrompt }
      : {}),
    messages,
    signal,
    toolExposure,
    ...(options.providerRequestAttempts !== undefined
      ? { providerRequestAttempts: options.providerRequestAttempts }
      : {}),
  });

  let stop: AgentTurnStop | null = null;
  const assistantText: string[] = [];
  const assistantReasoning: string[] = [];
  const pendingToolCalls: ToolCall[] = [];
  let assistantStarted = false;

  try {
    for await (const event of stream) {
      switch (event.type) {
        case "text":
          if (event.text !== "") {
            assistantStarted = true;
          }
          if (event.text !== "" && textPrefix !== "") {
            if (!event.text.startsWith("\n")) {
              assistantText.push(textPrefix);
              yield { type: "text", text: textPrefix };
            }
            textPrefix = "";
          }
          assistantText.push(event.text);
          yield { type: "text", text: event.text };
          break;
        case "reasoning":
          if (event.text !== "") {
            assistantStarted = true;
            assistantReasoning.push(event.text);
          }
          break;
        case "tool_call": {
          assistantStarted = true;
          const { type: _llmEventType, ...toolCall } = event;
          pendingToolCalls.push(toolCall);
          break;
        }
        case "provider_retry":
          yield event;
          break;
        case "stop":
          stop = { usage: event.usage, reason: event.reason };
          break;
      }
    }
  } catch (error) {
    if (isProviderContextOverflow(error) && !assistantStarted) {
      throw new ContextOverflowBeforeAssistantError(error);
    }
    throw error;
  }

  return finishAgentTurn(
    assistantText,
    assistantReasoning,
    pendingToolCalls,
    stop,
  );
}
