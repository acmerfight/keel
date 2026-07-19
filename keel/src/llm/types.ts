import type { ReadResourceObservation } from "../core/resource-observation.ts";
import type { ToolCall } from "../tools/tool-call.ts";

export interface Usage {
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly uncachedInputTokens: number;
  readonly outputTokens: number;
}

export const userMessageOriginTypes = [
  "user_prompt",
  "steer",
  "queued_followup",
  "runtime_goal_activation",
  "runtime_goal_continuation",
  "runtime_goal_resumption",
  "runtime_goal_stagnation_recovery",
  "runtime_undo_restoration",
  "compaction_checkpoint",
] as const;

type UserMessageOriginType = (typeof userMessageOriginTypes)[number];

export interface UserMessageOrigin {
  readonly type: UserMessageOriginType;
}

interface UserMessage {
  readonly role: "user";
  readonly content: string;
  readonly origin?: UserMessageOrigin;
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
  readonly resourceObservation?: ReadResourceObservation;
}

export type Message = UserMessage | AssistantMessage | ToolMessage;

export type SessionMessage =
  | (UserMessage & { readonly origin: UserMessageOrigin })
  | AssistantMessage
  | ToolMessage;

export type LLMStopReason = "stop" | "length";

export type ProviderRequestAttemptOutcome =
  | "completed"
  | "retryable_error"
  | "context_overflow"
  | "terminal_error"
  | "aborted";

export interface ProviderRequestRetryDecision {
  readonly provider: string;
  readonly reason: string;
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
      readonly outcome: "context_overflow" | "terminal_error" | "aborted";
    };

export interface ProviderRequestAttemptHandle {
  readonly finish: (result: ProviderRequestAttemptFinish) => void;
}

export interface ProviderRequestAttemptObserver {
  readonly begin: () => ProviderRequestAttemptHandle;
}

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
  readonly requestSystemPrompt?: () => string;
  readonly messages: readonly Message[];
  readonly signal: AbortSignal;
  readonly allowBash?: boolean;
  readonly allowSkill?: boolean;
  readonly allowMemory?: boolean;
  readonly allowMemoryProposal?: boolean;
  // Absent = provider default (model may call tools). "none" is for turns
  // that must produce text only, e.g. the wrap-up summary after the turn
  // limit; providers enforce it at the protocol level.
  readonly toolChoice?: "none";
  readonly maxOutputTokens?: number;
  readonly providerRequestAttempts?: ProviderRequestAttemptObserver;
}

export interface LLMProvider {
  readonly id: string;
  readonly estimateInputTokens?: (options: StreamOptions) => number;
  readonly stream: (options: StreamOptions) => AsyncIterable<LLMEvent>;
}
