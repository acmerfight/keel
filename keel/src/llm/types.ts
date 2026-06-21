import type { ToolCall } from "../tools/registry.ts";

export interface Usage {
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly uncachedInputTokens: number;
  readonly outputTokens: number;
}

interface UserMessage {
  readonly role: "user";
  readonly content: string;
}

export type { ToolCall } from "../tools/registry.ts";

interface AssistantMessage {
  readonly role: "assistant";
  readonly content: string;
  readonly toolCalls: readonly ToolCall[];
}

interface ToolMessage {
  readonly role: "tool";
  readonly toolCallId: string;
  readonly content: string;
}

export type Message = UserMessage | AssistantMessage | ToolMessage;

export type LLMEvent =
  | { readonly type: "text"; readonly text: string }
  | ({ readonly type: "tool_call" } & ToolCall)
  | {
      readonly type: "provider_retry";
      readonly provider: string;
      readonly reason: string;
      readonly attempt: number;
      readonly maxRetries: number;
      readonly delayMs: number;
    }
  | { readonly type: "stop"; readonly usage: Usage };

export interface StreamOptions {
  readonly systemPrompt: string;
  readonly messages: readonly Message[];
  readonly signal: AbortSignal;
  readonly allowBash?: boolean;
  // Absent = provider default (model may call tools). "none" is for turns
  // that must produce text only, e.g. the wrap-up summary after the turn
  // limit; providers enforce it at the protocol level.
  readonly toolChoice?: "none";
}

export interface LLMProvider {
  readonly id: string;
  readonly stream: (options: StreamOptions) => AsyncIterable<LLMEvent>;
}
