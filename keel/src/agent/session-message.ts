import type { ReadResourceObservation } from "../core/resource-observation.ts";
import type { AssistantProviderMetadata } from "../llm/types.ts";
import type { ToolCall } from "../tools/tool-call.ts";

export const userMessageOriginTypes = [
  "user_prompt",
  "steer",
  "queued_followup",
  "runtime_goal_activation",
  "runtime_goal_continuation",
  "runtime_goal_resumption",
  "runtime_goal_stagnation_recovery",
  "runtime_subagent_delegation",
  "runtime_subagent_notification",
  "runtime_turn_limit_summary",
  "runtime_undo_restoration",
  "compaction_checkpoint",
] as const;

type UserMessageOriginType = (typeof userMessageOriginTypes)[number];

export interface UserMessageOrigin {
  readonly type: UserMessageOriginType;
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
  readonly untrustedMcpContent?: true;
}

interface SessionMessageAudience {
  readonly _messageAudience?: "session";
}

interface SessionUserMessage extends SessionMessageAudience {
  readonly role: "user";
  readonly content: string;
  readonly origin?: UserMessageOrigin;
  readonly contextCompaction?: UserMessageContextCompactionMetadata;
}

interface SessionAssistantMessage extends SessionMessageAudience {
  readonly role: "assistant";
  readonly content: string;
  readonly toolCalls: readonly ToolCall[];
  readonly providerMetadata?: AssistantProviderMetadata;
}

interface SessionToolMessage extends SessionMessageAudience {
  readonly role: "tool";
  readonly toolCallId: string;
  readonly content: string;
  readonly sourceTruncated?: boolean;
  readonly evidenceShortened?: true;
  readonly resourceObservation?: ReadResourceObservation;
}

export type SessionMessage =
  | SessionUserMessage
  | SessionAssistantMessage
  | SessionToolMessage;

export type PersistedSessionMessage =
  | (SessionUserMessage & { readonly origin: UserMessageOrigin })
  | SessionAssistantMessage
  | SessionToolMessage;
