import { z } from "zod";
import type { SessionMessage } from "../../agent/session-message.ts";
import {
  EXPLORER_MAX_TURNS,
  MAX_SUBAGENT_SKILLS,
  REVIEWER_MAX_TURNS,
  type RepoSubagentCapabilitySnapshotId,
  type RepoSubagentProfileName,
  SUBAGENT_DEADLINE_MS,
  SUBAGENT_MAX_FINAL_TEXT_CHARS,
  type SubagentCapabilitySnapshot,
  type SubagentSkillSnapshot,
  subagentBuiltinToolNames,
  subagentProfileIds,
} from "../../agent/subagent-capability.ts";
import type {
  AgentId,
  PersistedSubagentCanonicalResult,
  SubagentAcceptedLifecycle,
  SubagentAccountingSnapshot,
  SubagentResultDelivery,
  SubagentResultDeliveryReference,
  SubagentRunId,
  SubagentRunLineage,
  SubagentTerminalStatus,
} from "../../agent/subagent-lifecycle.ts";
import {
  subagentNonCompletedStatuses,
  subagentTerminalStatuses,
} from "../../agent/subagent-lifecycle.ts";
import { reasoningEfforts } from "../../core/model-metadata.ts";
import { providerIds } from "../../core/provider-id.ts";
import type { Usage } from "../../llm/types.ts";
import {
  isWorkflowSkillResourcePath,
  MAX_WORKFLOW_SKILL_BYTES,
  MAX_WORKFLOW_SKILL_RESOURCE_PATHS,
} from "../../skills/resources.ts";
import { sessionMessageSchema } from "../session-message-schema.ts";

export const AGENT_TREE_SCHEMA_VERSION = 7;
export const AGENT_TREE_MAX_BYTES = 32 * 1024 * 1024;
export const AGENT_TRANSCRIPT_MAX_BYTES = 32 * 1024 * 1024;

const agentIdSchema: z.ZodType<AgentId> = z
  .string()
  .regex(/^agent-[a-f0-9-]+$/u)
  .transform((value): AgentId => `agent-${value.slice("agent-".length)}`);
export const childRunIdSchema: z.ZodType<SubagentRunId> = z
  .string()
  .regex(/^subagent-[a-f0-9-]+$/u)
  .transform(
    (value): SubagentRunId => `subagent-${value.slice("subagent-".length)}`,
  );

export interface AgentTreeHeaderRecord {
  readonly schemaVersion: typeof AGENT_TREE_SCHEMA_VERSION;
  readonly type: "agent_tree";
  readonly sessionId: string;
  readonly createdAt: string;
}

export interface AgentRunAcceptedRecord extends SubagentAcceptedLifecycle {
  readonly schemaVersion: typeof AGENT_TREE_SCHEMA_VERSION;
  readonly type: "agent_run_accepted";
  readonly timestamp: string;
  readonly transcriptRef: string;
}

export interface AgentRunRunningRecord {
  readonly schemaVersion: typeof AGENT_TREE_SCHEMA_VERSION;
  readonly type: "agent_run_running";
  readonly timestamp: string;
  readonly childAgentId: AgentId;
  readonly childRunId: SubagentRunId;
}

export interface AgentRunAccountingRecord extends SubagentAccountingSnapshot {
  readonly schemaVersion: typeof AGENT_TREE_SCHEMA_VERSION;
  readonly type: "agent_run_accounting";
  readonly timestamp: string;
  readonly childAgentId: AgentId;
  readonly childRunId: SubagentRunId;
}

export interface AgentResultRecord {
  readonly schemaVersion: typeof AGENT_TREE_SCHEMA_VERSION;
  readonly type: "agent_result";
  readonly timestamp: string;
  readonly result: PersistedSubagentCanonicalResult;
}

export interface AgentRunTerminalRecord {
  readonly schemaVersion: typeof AGENT_TREE_SCHEMA_VERSION;
  readonly type: "agent_run_terminal";
  readonly timestamp: string;
  readonly childAgentId: AgentId;
  readonly childRunId: SubagentRunId;
  readonly status: SubagentTerminalStatus;
}

export interface AgentResultDeliveryPendingRecord {
  readonly schemaVersion: typeof AGENT_TREE_SCHEMA_VERSION;
  readonly type: "agent_result_delivery_pending";
  readonly timestamp: string;
  readonly delivery: SubagentResultDelivery;
}

export interface AgentResultDeliveryDeliveredRecord
  extends SubagentResultDeliveryReference {
  readonly schemaVersion: typeof AGENT_TREE_SCHEMA_VERSION;
  readonly type: "agent_result_delivery_delivered";
  readonly timestamp: string;
}

interface DelegationRejectedRecord {
  readonly schemaVersion: typeof AGENT_TREE_SCHEMA_VERSION;
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
  | AgentResultDeliveryPendingRecord
  | AgentResultDeliveryDeliveredRecord
  | DelegationRejectedRecord;

export interface AgentTranscriptHeaderRecord extends SubagentAcceptedLifecycle {
  readonly schemaVersion: typeof AGENT_TREE_SCHEMA_VERSION;
  readonly type: "transcript";
  readonly kind: "subagent";
  readonly createdAt: string;
  readonly transcriptRef: string;
}

export interface AgentTranscriptTerminalRecord {
  readonly schemaVersion: typeof AGENT_TREE_SCHEMA_VERSION;
  readonly type: "transcript_terminal";
  readonly status: SubagentTerminalStatus;
  readonly pendingInputCount: number;
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

const capabilityLimitsShape = {
  deadlineMs: z.number().int().positive().max(SUBAGENT_DEADLINE_MS),
  maxFinalTextChars: z
    .number()
    .int()
    .positive()
    .max(SUBAGENT_MAX_FINAL_TEXT_CHARS),
};

const repoCapabilityIdSchema: z.ZodType<RepoSubagentCapabilitySnapshotId> =
  z.templateLiteral(["repo-profile-v1:", z.string().regex(/^[a-f0-9]{64}$/u)]);
const repoProfileNameSchema: z.ZodType<RepoSubagentProfileName> =
  z.templateLiteral(["repo:", z.string().regex(/^[a-z][a-z0-9-]{0,31}$/u)]);

const subagentSkillSnapshotSchema: z.ZodType<SubagentSkillSnapshot> = z
  .object({
    descriptorId: z.string().min(1).max(256),
    packageId: z.string().min(1).max(256),
    rootKey: z.string().min(1).max(64),
    rootPriority: z.number().int().nonnegative(),
    qualifiedName: z.string().min(1).max(256),
    scope: z.enum(["repo", "user", "system", "extra"]),
    activationPolicy: z.literal("implicit"),
    name: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
    description: z.string().trim().min(1).max(1_024),
    relativePath: z.string().min(1).max(1_000),
    digest: z.string().regex(/^[a-f0-9]{64}$/u),
    resourcePaths: z
      .array(z.string().max(1_000).refine(isWorkflowSkillResourcePath))
      .max(MAX_WORKFLOW_SKILL_RESOURCE_PATHS)
      .refine((paths) => new Set(paths).size === paths.length),
    content: z
      .string()
      .refine(
        (content) =>
          Buffer.byteLength(content, "utf8") <= MAX_WORKFLOW_SKILL_BYTES,
        {
          message:
            "workflow Skill content exceeds the persisted snapshot limit",
        },
      ),
  })
  .strict();
const subagentSkillsSchema = z
  .array(subagentSkillSnapshotSchema)
  .max(MAX_SUBAGENT_SKILLS)
  .refine(
    (skills) =>
      new Set(skills.map((skill) => skill.qualifiedName)).size ===
      skills.length,
  );

const capabilitySnapshotSchema: z.ZodType<SubagentCapabilitySnapshot> = z.union(
  [
    z
      .object({
        id: z.literal("builtin-explorer-v1"),
        profile: z.literal("explorer"),
        builtinTools: z.tuple([
          z.literal("read"),
          z.literal("ls"),
          z.literal("glob"),
          z.literal("grep"),
        ]),
        skills: z.tuple([]),
        maxTurns: z.number().int().positive().max(EXPLORER_MAX_TURNS),
        ...capabilityLimitsShape,
      })
      .strict(),
    z
      .object({
        id: z.literal("builtin-reviewer-v1"),
        profile: z.literal("reviewer"),
        builtinTools: z.tuple([
          z.literal("read"),
          z.literal("ls"),
          z.literal("glob"),
          z.literal("grep"),
          z.literal("git_status"),
          z.literal("git_diff"),
        ]),
        skills: z.tuple([]),
        maxTurns: z.number().int().positive().max(REVIEWER_MAX_TURNS),
        ...capabilityLimitsShape,
      })
      .strict(),
    z
      .object({
        id: repoCapabilityIdSchema,
        profile: repoProfileNameSchema,
        baseProfile: z.enum(subagentProfileIds),
        builtinTools: z
          .array(z.enum(subagentBuiltinToolNames))
          .min(1)
          .max(subagentBuiltinToolNames.length)
          .refine((tools) => new Set(tools).size === tools.length),
        skills: subagentSkillsSchema,
        maxTurns: z.number().int().positive().max(REVIEWER_MAX_TURNS),
        ...capabilityLimitsShape,
      })
      .strict(),
  ],
);

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
    pendingInputCount: z.number().int().nonnegative(),
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
    mode: z.enum(["foreground", "background"]),
    providerId: z.enum(providerIds),
    model: z.string().min(1),
    effort: z.enum(reasoningEfforts).nullable(),
    threadCapabilityCeiling: capabilitySnapshotSchema,
    capability: capabilitySnapshotSchema,
    systemPrompt: z.string(),
    lineage: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("root") }).strict(),
      z
        .object({
          kind: z.literal("continuation"),
          previousRunId: childRunIdSchema,
        })
        .strict(),
    ]) satisfies z.ZodType<SubagentRunLineage>,
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

const resultDeliveryReferenceShape = {
  sessionId: z.string().min(1),
  delegationId: z.string().min(1),
  childAgentId: agentIdSchema,
  childRunId: childRunIdSchema,
  canonicalResultSha256: z.string().regex(/^[a-f0-9]{64}$/u),
};

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
        type: z.literal("agent_result_delivery_pending"),
        timestamp: z.string(),
        delivery: z
          .object({
            ...resultDeliveryReferenceShape,
            projection: z.string().min(1),
          })
          .strict(),
      })
      .strict(),
    z
      .object({
        schemaVersion: z.literal(AGENT_TREE_SCHEMA_VERSION),
        type: z.literal("agent_result_delivery_delivered"),
        timestamp: z.string(),
        ...resultDeliveryReferenceShape,
      })
      .strict(),
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

export type AgentTranscriptMutationRecord =
  | {
      readonly schemaVersion: typeof AGENT_TREE_SCHEMA_VERSION;
      readonly type:
        | "transcript_initialize"
        | "transcript_append"
        | "transcript_pending_input"
        | "transcript_replace";
      readonly messages: readonly SessionMessage[];
    }
  | AgentTranscriptTerminalRecord;

export const transcriptMutationSchema: z.ZodType<AgentTranscriptMutationRecord> =
  z.discriminatedUnion("type", [
    transcriptMessagesSchema.extend({
      type: z.literal("transcript_initialize"),
    }),
    transcriptMessagesSchema.extend({ type: z.literal("transcript_append") }),
    transcriptMessagesSchema.extend({
      type: z.literal("transcript_pending_input"),
    }),
    transcriptMessagesSchema.extend({ type: z.literal("transcript_replace") }),
    z
      .object({
        schemaVersion: z.literal(AGENT_TREE_SCHEMA_VERSION),
        type: z.literal("transcript_terminal"),
        status: z.enum(subagentTerminalStatuses),
        pendingInputCount: z.number().int().nonnegative(),
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
