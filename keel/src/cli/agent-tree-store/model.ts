import { z } from "zod";
import type {
  PersistedSubagentCanonicalResult,
  SubagentAcceptedLifecycle,
  SubagentAccountingSnapshot,
  SubagentTerminalStatus,
} from "../../agent/subagent-lifecycle.ts";
import {
  subagentNonCompletedStatuses,
  subagentTerminalStatuses,
} from "../../agent/subagent-lifecycle.ts";
import type { Usage } from "../../llm/types.ts";
import { sessionMessageSchema } from "../session-message-schema.ts";

export const AGENT_TREE_SCHEMA_VERSION = 1;
export const AGENT_TREE_MAX_BYTES = 32 * 1024 * 1024;
export const AGENT_TRANSCRIPT_MAX_BYTES = 32 * 1024 * 1024;

export const agentIdSchema = z.string().regex(/^agent-[a-f0-9-]+$/u);
const childRunIdSchema = z.string().regex(/^subagent-[a-f0-9-]+$/u);

export interface AgentTreeHeaderRecord {
  readonly schemaVersion: 1;
  readonly type: "agent_tree";
  readonly sessionId: string;
  readonly createdAt: string;
}

export interface AgentRunAcceptedRecord extends SubagentAcceptedLifecycle {
  readonly schemaVersion: 1;
  readonly type: "agent_run_accepted";
  readonly timestamp: string;
  readonly transcriptRef: string;
}

export interface AgentRunRunningRecord {
  readonly schemaVersion: 1;
  readonly type: "agent_run_running";
  readonly timestamp: string;
  readonly childAgentId: string;
  readonly childRunId: string;
}

export interface AgentRunAccountingRecord extends SubagentAccountingSnapshot {
  readonly schemaVersion: 1;
  readonly type: "agent_run_accounting";
  readonly timestamp: string;
  readonly childAgentId: string;
  readonly childRunId: string;
}

export interface AgentResultRecord {
  readonly schemaVersion: 1;
  readonly type: "agent_result";
  readonly timestamp: string;
  readonly result: PersistedSubagentCanonicalResult;
}

export interface AgentRunTerminalRecord {
  readonly schemaVersion: 1;
  readonly type: "agent_run_terminal";
  readonly timestamp: string;
  readonly childAgentId: string;
  readonly childRunId: string;
  readonly status: SubagentTerminalStatus;
}

interface DelegationRejectedRecord {
  readonly schemaVersion: 1;
  readonly type: "delegation_rejected";
  readonly timestamp: string;
  readonly delegationId: string;
  readonly parentRunId: string;
  readonly parentToolCallId: string;
  readonly task: string;
  readonly reason: string;
}

export type AgentTreeMutationRecord =
  | AgentRunAcceptedRecord
  | AgentRunRunningRecord
  | AgentRunAccountingRecord
  | AgentResultRecord
  | AgentRunTerminalRecord
  | DelegationRejectedRecord;

export interface AgentTranscriptHeaderRecord extends SubagentAcceptedLifecycle {
  readonly schemaVersion: 1;
  readonly type: "transcript";
  readonly kind: "subagent";
  readonly createdAt: string;
  readonly transcriptRef: string;
}

export interface AgentTranscriptTerminalRecord {
  readonly schemaVersion: 1;
  readonly type: "transcript_terminal";
  readonly status: SubagentTerminalStatus;
  readonly complete: boolean;
}

const usageSchema: z.ZodType<Usage> = z
  .object({
    inputTokens: z.number().int().nonnegative(),
    cachedInputTokens: z.number().int().nonnegative(),
    uncachedInputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
  })
  .strict();

const canonicalResultBaseSchema = z
  .object({
    delegationId: z.string().min(1),
    childAgentId: agentIdSchema,
    childRunId: childRunIdSchema,
    task: z.string().min(1),
    usage: usageSchema,
    turns: z.number().int().nonnegative(),
    costUsd: z.number().finite().nonnegative(),
    transcriptRef: z.string().min(1),
  })
  .strict();

const canonicalResultSchema: z.ZodType<PersistedSubagentCanonicalResult> =
  z.discriminatedUnion("status", [
    canonicalResultBaseSchema.extend({
      status: z.literal("completed"),
      finalText: z.string(),
      error: z.null(),
    }),
    canonicalResultBaseSchema.extend({
      status: z.enum(subagentNonCompletedStatuses),
      finalText: z.null(),
      error: z.string(),
    }),
  ]);

const lifecycleIdentitySchema = z
  .object({
    delegationId: z.string().min(1),
    childAgentId: agentIdSchema,
    childRunId: childRunIdSchema,
    parentRunId: z.string().min(1),
    parentToolCallId: z.string().min(1),
    task: z.string().min(1),
    focusPaths: z.array(z.string()),
    providerId: z.string().min(1),
    model: z.string().min(1),
    systemPrompt: z.string(),
  })
  .strict();

const acceptedRecordSchema = lifecycleIdentitySchema.extend({
  schemaVersion: z.literal(AGENT_TREE_SCHEMA_VERSION),
  type: z.literal("agent_run_accepted"),
  timestamp: z.string(),
  transcriptRef: z.string().min(1),
});

const runIdentitySchema = z
  .object({
    childAgentId: agentIdSchema,
    childRunId: childRunIdSchema,
  })
  .strict();

export const mutationRecordSchema: z.ZodType<AgentTreeMutationRecord> =
  z.discriminatedUnion("type", [
    acceptedRecordSchema,
    runIdentitySchema.extend({
      schemaVersion: z.literal(AGENT_TREE_SCHEMA_VERSION),
      type: z.literal("agent_run_running"),
      timestamp: z.string(),
    }),
    runIdentitySchema.extend({
      schemaVersion: z.literal(AGENT_TREE_SCHEMA_VERSION),
      type: z.literal("agent_run_accounting"),
      timestamp: z.string(),
      usage: usageSchema,
      turns: z.number().int().nonnegative(),
      costUsd: z.number().finite().nonnegative(),
    }),
    z
      .object({
        schemaVersion: z.literal(AGENT_TREE_SCHEMA_VERSION),
        type: z.literal("agent_result"),
        timestamp: z.string(),
        result: canonicalResultSchema,
      })
      .strict(),
    runIdentitySchema.extend({
      schemaVersion: z.literal(AGENT_TREE_SCHEMA_VERSION),
      type: z.literal("agent_run_terminal"),
      timestamp: z.string(),
      status: z.enum(subagentTerminalStatuses),
    }),
    z
      .object({
        schemaVersion: z.literal(AGENT_TREE_SCHEMA_VERSION),
        type: z.literal("delegation_rejected"),
        timestamp: z.string(),
        delegationId: z.string().min(1),
        parentRunId: z.string().min(1),
        parentToolCallId: z.string().min(1),
        task: z.string().min(1),
        reason: z.string().min(1),
      })
      .strict(),
  ]);

export const headerRecordSchema: z.ZodType<AgentTreeHeaderRecord> = z
  .object({
    schemaVersion: z.literal(AGENT_TREE_SCHEMA_VERSION),
    type: z.literal("agent_tree"),
    sessionId: z.string().min(1),
    createdAt: z.string(),
  })
  .strict();

export const transcriptHeaderSchema: z.ZodType<AgentTranscriptHeaderRecord> =
  lifecycleIdentitySchema.extend({
    schemaVersion: z.literal(AGENT_TREE_SCHEMA_VERSION),
    type: z.literal("transcript"),
    kind: z.literal("subagent"),
    createdAt: z.string(),
    transcriptRef: z.string().min(1),
  });

const transcriptMessagesSchema = z
  .object({
    schemaVersion: z.literal(AGENT_TREE_SCHEMA_VERSION),
    messages: z.array(sessionMessageSchema),
  })
  .strict();

export const transcriptMutationSchema = z.discriminatedUnion("type", [
  transcriptMessagesSchema.extend({ type: z.literal("transcript_initialize") }),
  transcriptMessagesSchema.extend({ type: z.literal("transcript_append") }),
  transcriptMessagesSchema.extend({ type: z.literal("transcript_replace") }),
  z
    .object({
      schemaVersion: z.literal(AGENT_TREE_SCHEMA_VERSION),
      type: z.literal("transcript_terminal"),
      status: z.enum(subagentTerminalStatuses),
      complete: z.boolean(),
    })
    .strict(),
]);

export function zeroUsage(): Usage {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    uncachedInputTokens: 0,
    outputTokens: 0,
  };
}

export function copyAccounting(
  accounting: SubagentAccountingSnapshot,
): SubagentAccountingSnapshot {
  return {
    usage: { ...accounting.usage },
    turns: accounting.turns,
    costUsd: accounting.costUsd,
  };
}

export function copyCanonicalResult(
  result: PersistedSubagentCanonicalResult,
): PersistedSubagentCanonicalResult {
  return { ...result, usage: { ...result.usage } };
}
