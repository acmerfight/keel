import type {
  KeelErrorCode,
  ProviderRequestTerminalErrorCode,
} from "../core/error.ts";
import type { ModelToolExposure, ToolCall } from "../tools/tool-call.ts";

export type { ModelToolExposure } from "../tools/tool-call.ts";

export interface Usage {
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly uncachedInputTokens: number;
  readonly outputTokens: number;
}

interface ProviderMessageAudience {
  readonly _messageAudience?: "provider";
}

interface ProviderUserMessage extends ProviderMessageAudience {
  readonly role: "user";
  readonly content: string;
}

export type { ToolCall } from "../tools/tool-call.ts";

interface OpenAICompatibleProviderAssistantMetadata {
  readonly reasoningContent: string;
}

export interface AssistantProviderMetadata {
  readonly openaiCompatible: OpenAICompatibleProviderAssistantMetadata;
}

interface ProviderAssistantMessage extends ProviderMessageAudience {
  readonly role: "assistant";
  readonly content: string;
  readonly toolCalls: readonly ToolCall[];
  readonly providerMetadata?: AssistantProviderMetadata;
}

interface ProviderToolMessage extends ProviderMessageAudience {
  readonly role: "tool";
  readonly toolCallId: string;
  readonly content: string;
}

export type ProviderMessage =
  | ProviderUserMessage
  | ProviderAssistantMessage
  | ProviderToolMessage;

export type LLMStopReason = "stop" | "length";

export type ProviderRequestAttemptOutcome =
  | "completed"
  | "retryable_error"
  | "context_overflow"
  | "terminal_error"
  | "aborted";

export interface ProviderRequestRetryDecision {
  readonly provider: string;
  readonly reason: KeelErrorCode;
  readonly attempt: number;
  readonly maxRetries: number;
  readonly delayMs: number;
}

export type ProviderRequestAttemptFinish =
  | { readonly outcome: "completed"; readonly usage: Usage }
  | {
      readonly outcome: "retryable_error";
      readonly retryDecision: ProviderRequestRetryDecision;
    }
  | {
      readonly outcome: "context_overflow" | "aborted";
    }
  | {
      readonly outcome: "terminal_error";
      readonly errorCode: ProviderRequestTerminalErrorCode;
    };

export interface ProviderRequestAttemptHandle {
  readonly finish: (result: ProviderRequestAttemptFinish) => void;
}

export interface ProviderRequestAttemptObserver {
  readonly begin: () => ProviderRequestAttemptHandle;
}

export interface ProviderRetryCoordination {
  readonly reserveRetry: (input: {
    readonly reason: KeelErrorCode;
    readonly suggestedDelayMs: number;
  }) => number | null;
}

export interface ProviderRequestSlot {
  readonly release: () => void;
}

export interface ProviderRequestConcurrency {
  readonly acquire: (signal: AbortSignal) => Promise<ProviderRequestSlot>;
}

export type LLMEvent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "reasoning"; readonly text: string }
  | ({ readonly type: "tool_call" } & ToolCall)
  | {
      readonly type: "provider_retry";
      readonly provider: string;
      readonly reason: KeelErrorCode;
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
  readonly requestSystemPrompt?: () => string;
  readonly messages: readonly ProviderMessage[];
  readonly signal: AbortSignal;
  // Absent = the standard provider tool surface. "none" is for turns that
  // must produce text only, e.g. the wrap-up summary after the turn limit.
  readonly toolExposure?: ModelToolExposure;
  readonly maxOutputTokens?: number;
  readonly providerRequestAttempts?: ProviderRequestAttemptObserver;
  readonly providerRetryCoordination?: ProviderRetryCoordination;
  readonly providerRequestConcurrency?: ProviderRequestConcurrency;
}

export interface LLMProvider {
  readonly id: string;
  readonly abortSignalSupport?: true;
  readonly estimateInputTokens?: (options: StreamOptions) => number;
  readonly stream: (options: StreamOptions) => AsyncIterable<LLMEvent>;
}
