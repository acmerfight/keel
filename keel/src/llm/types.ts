import type { ToolCall } from "../tools/tool-call.ts";

export interface Usage {
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly uncachedInputTokens: number;
  readonly outputTokens: number;
}

interface UserMessage {
  readonly role: "user";
  readonly content: string;
  readonly contextCompaction?: UserMessageContextCompactionMetadata;
}

export interface UserMessageContextCompactionEvidence {
  readonly handle: string;
  readonly label: string;
  readonly source: string;
  readonly why: string;
  readonly inspectCommand?: string;
}

export interface UserMessageContextCompactionMetadata {
  readonly evidence: readonly UserMessageContextCompactionEvidence[];
}

export type { ToolCall } from "../tools/tool-call.ts";

interface OpenAICompatibleAssistantMetadata {
  readonly reasoningContent: string;
}

export interface AssistantProviderMetadata {
  readonly openaiCompatible: OpenAICompatibleAssistantMetadata;
}

interface AssistantMessage {
  readonly role: "assistant";
  readonly content: string;
  readonly toolCalls: readonly ToolCall[];
  readonly providerMetadata?: AssistantProviderMetadata;
}

interface ToolMessage {
  readonly role: "tool";
  readonly toolCallId: string;
  readonly content: string;
  readonly sourceTruncated?: boolean;
}

export type Message = UserMessage | AssistantMessage | ToolMessage;

export type LLMStopReason = "stop" | "length";

export type LLMEvent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "reasoning"; readonly text: string }
  | ({ readonly type: "tool_call" } & ToolCall)
  | {
      readonly type: "provider_retry";
      readonly provider: string;
      readonly reason: string;
      readonly attempt: number;
      readonly maxRetries: number;
      readonly delayMs: number;
    }
  | {
      readonly type: "stop";
      readonly reason: LLMStopReason;
      readonly usage: Usage;
    };

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
