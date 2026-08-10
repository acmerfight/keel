import type { ReadResourceObservation } from "../core/resource-observation.ts";
import type { AssistantProviderMetadata } from "../llm/types.ts";
import type { ToolCall } from "../tools/tool-call.ts";
import type { SubagentResultDeliveryReference } from "./subagent-lifecycle.ts";

export const ordinaryUserMessageOriginTypes = [
  "user_prompt",
  "steer",
  "queued_followup",
  "runtime_goal_activation",
  "runtime_goal_continuation",
  "runtime_goal_resumption",
  "runtime_goal_stagnation_recovery",
  "runtime_subagent_delegation",
  "runtime_turn_limit_summary",
  "runtime_undo_restoration",
  "compaction_checkpoint",
] as const;
export const subagentResultDeliveryOriginType =
  "runtime_subagent_notification" as const;
type OrdinaryUserMessageOriginType =
  (typeof ordinaryUserMessageOriginTypes)[number];

export interface OrdinaryUserMessageOrigin {
  readonly type: OrdinaryUserMessageOriginType;
}

export type UserMessageOrigin =
  | OrdinaryUserMessageOrigin
  | { readonly type: typeof subagentResultDeliveryOriginType };

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

interface SessionUserMessageBase extends SessionMessageAudience {
  readonly role: "user";
  readonly content: string;
  readonly contextCompaction?: UserMessageContextCompactionMetadata;
}

interface OrdinarySessionUserMessage extends SessionUserMessageBase {
  readonly origin?: OrdinaryUserMessageOrigin;
  readonly subagentResultDelivery?: never;
}

interface SubagentResultDeliverySessionMessage extends SessionUserMessageBase {
  readonly origin: { readonly type: "runtime_subagent_notification" };
  readonly subagentResultDelivery: SubagentResultDeliveryReference;
}

type SessionUserMessage =
  | OrdinarySessionUserMessage
  | SubagentResultDeliverySessionMessage;

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
  | (OrdinarySessionUserMessage & {
      readonly origin: OrdinaryUserMessageOrigin;
    })
  | SubagentResultDeliverySessionMessage
  | SessionAssistantMessage
  | SessionToolMessage;
