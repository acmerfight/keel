import { z } from "zod";
import type {
  OrdinaryUserMessageOrigin,
  PersistedSessionMessage,
  SessionMessage,
  UserMessageContextCompactionMetadata,
} from "../../agent/session-message.ts";
import { providerIds } from "../../core/provider-id.ts";
import { copyReadResourceObservation } from "../../core/resource-observation.ts";
import {
  copySessionGoal,
  normalizeSessionGoalCompletionCommand,
  normalizeSessionGoalCompletionCriterion,
  normalizeSessionGoalCompletionEvidence,
  normalizeSessionGoalCompletionEvidenceReason,
  normalizeSessionGoalObjective,
  normalizeSessionGoalRuntimeOutcome,
  normalizeSessionGoalRuntimeOutcomeReason,
  normalizeSessionGoalStatusReason,
  SESSION_GOAL_COMPLETION_CRITERION_MAX_LENGTH,
  SESSION_GOAL_COMPLETION_EVIDENCE_REASON_MAX_LENGTH,
  SESSION_GOAL_OBJECTIVE_MAX_LENGTH,
  SESSION_GOAL_RUNTIME_OUTCOME_REASON_MAX_LENGTH,
  SESSION_GOAL_STATUS_REASON_MAX_LENGTH,
  type SessionGoal,
  type SessionGoalCompletionEvidence,
  type SessionGoalRecord,
  type SessionGoalRuntimeOutcome,
  sessionGoalAccounting,
  sessionGoalSchema,
} from "../../core/session-goal.ts";
import {
  copySessionTaskProgress,
  type SessionTaskProgress,
  sessionTaskPlanSchema,
  sessionTaskProgressSchema,
} from "../../core/task-progress.ts";
import type { BashApprovalGrant } from "../../permissions/bash.ts";
import {
  copySkillActivation,
  copySkillLifecycleState,
} from "../../skills/lifecycle.ts";
import type { SkillActivation } from "../../skills/model.ts";
import {
  isWorkflowSkillResourcePath,
  MAX_WORKFLOW_SKILL_RESOURCE_PATHS,
} from "../../skills/resources.ts";
import {
  hasPersistenceRedactionMarker,
  redactMessageForPersistence,
  redactTextForPersistence,
} from "../persistence-redaction.ts";
import {
  persistedSessionMessageSchema as messageSchema,
  type userMessageContextCompactionSchema,
} from "../session-message-schema.ts";
import { sessionStoreError } from "./errors.ts";
import {
  type ActiveSessionProviderAttempt,
  type ActiveSessionTask,
  type ActiveSessionToolInvocation,
  type AppendSessionRecord,
  type ModelSwitchSessionRecord,
  type ReplaceSessionRecord,
  SESSION_SCHEMA_VERSION,
  SESSION_TITLE_MAX_LENGTH,
  type SessionForkPointRecord,
  type SessionForkPolicyRecord,
  type SessionGoalSessionRecord,
  type SessionGraphRecord,
  type SessionHeaderRecord,
  type SessionLastTaskOutcome,
  type SessionModelSelection,
  type SessionModelSwitch,
  type SessionMutationRecord,
  type SessionProviderAttemptSettlement,
  type SessionQueuedInput,
  type SessionSkillStateCheckpoint,
  type SessionTaskProgressCheckpoint,
  type SessionTitleSessionRecord,
  type SessionToolContinuationEffects,
  type SkillStateSessionRecord,
  type SnapshotSessionRecord,
  type StoredMessage,
} from "./model.ts";

type BashApprovalRevokedSessionRecord = Extract<
  SessionMutationRecord,
  { readonly type: "bash_approval_revoked" }
>;
type BashApprovalsClearedSessionRecord = Extract<
  SessionMutationRecord,
  { readonly type: "bash_approvals_cleared" }
>;
type StepCommittedSessionRecord = Extract<
  SessionMutationRecord,
  { readonly type: "step_committed" }
>;
type TaskTerminalSessionRecord = Extract<
  SessionMutationRecord,
  { readonly type: "task_terminal" }
>;

const sessionTitleSchema = z.string().min(1).max(SESSION_TITLE_MAX_LENGTH);

const storedMessageSchema = z
  .object({
    id: z.string().min(1),
    message: messageSchema,
  })
  .strict();

const sessionForkPolicyRecordSchema = z
  .object({
    transcript: z.literal("copy_prefix"),
    pendingInputs: z.literal("drop"),
    queuedInputs: z.literal("drop"),
    bashApprovalGrants: z.literal("drop"),
  })
  .strict();

const beforeMessageForkPointRecordSchema = z
  .object({
    kind: z.literal("before_message"),
    sourceSessionId: z.string(),
    sourceMessageId: z.string().min(1),
    sourceOrdinal: z.number().int().positive(),
    preview: z.string(),
  })
  .strict();

const endForkPointRecordSchema = z
  .object({
    kind: z.literal("end"),
    sourceSessionId: z.string(),
    sourceLastMessageId: z.string().min(1).nullable(),
    sourceOrdinal: z.number().int().nonnegative(),
    preview: z.string(),
  })
  .strict();

const sessionForkPointRecordSchema = z.discriminatedUnion("kind", [
  beforeMessageForkPointRecordSchema,
  endForkPointRecordSchema,
]);

const sessionGraphRecordSchema = z
  .object({
    graphId: z.string(),
    rootSessionId: z.string(),
    parentSessionId: z.string().nullable(),
    branchTitle: z.string(),
    forkPoint: sessionForkPointRecordSchema.nullable(),
    forkPolicy: sessionForkPolicyRecordSchema,
  })
  .strict();

const skillActivationSchema = z
  .object({
    descriptorId: z.string(),
    packageId: z.string(),
    qualifiedName: z.string(),
    scope: z.enum(["repo", "user", "system", "extra"]),
    name: z.string(),
    relativePath: z.string(),
    resourcePaths: z
      .array(
        z.string().refine(isWorkflowSkillResourcePath, {
          message:
            "must be a skill-relative path under references/, scripts/, or assets/",
        }),
      )
      .max(MAX_WORKFLOW_SKILL_RESOURCE_PATHS),
    digest: z.string(),
    trigger: z.enum(["model_selected", "user_explicit"]),
    args: z.string(),
    contentSnapshot: z.string(),
    activatedAt: z.string(),
  })
  .strict();

const skillActivationsSchema = z.array(skillActivationSchema);
const activeSkillIdsSchema = z.array(z.string());
const skillLifecycleStateSchema = z
  .object({
    skillActivations: skillActivationsSchema,
    activeSkillIds: activeSkillIdsSchema,
  })
  .strict();

const sessionHeaderSchema = z
  .object({
    schemaVersion: z.literal(SESSION_SCHEMA_VERSION),
    type: z.literal("session"),
    id: z.string(),
    createdAt: z.string(),
    workspace: z.string(),
    graph: sessionGraphRecordSchema,
  })
  .strict();

const consumedInputIdsSchema = z.array(z.string());

const sessionModelSelectionSchema = z
  .object({
    providerId: z.enum(providerIds),
    model: z.string().min(1),
  })
  .strict();

const sessionModelSwitchSchema = z
  .object({
    timestamp: z.string(),
    from: sessionModelSelectionSchema.nullable(),
    to: sessionModelSelectionSchema,
    messageOrdinal: z.number().int().nonnegative(),
  })
  .strict();

const sessionProviderAttemptUsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative(),
    cachedInputTokens: z.number().int().nonnegative(),
    uncachedInputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
  })
  .strict();

const sessionProviderAttemptSettlementSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("completed"),
      usage: sessionProviderAttemptUsageSchema,
    })
    .strict(),
  z
    .object({
      outcome: z.literal("retryable_error"),
      provider: z.string(),
      reason: z.string(),
      attempt: z.number().int().nonnegative(),
      maxRetries: z.number().int().nonnegative(),
      delayMs: z.number().nonnegative(),
    })
    .strict(),
  z.object({ outcome: z.literal("context_overflow") }).strict(),
  z.object({ outcome: z.literal("aborted") }).strict(),
  z
    .object({
      outcome: z.literal("terminal_error"),
      errorCode: z.string(),
    })
    .strict(),
]);

const activeSessionProviderAttemptSchema = z
  .object({
    attemptId: z.string().min(1),
    responseMessageId: z.string().min(1),
    startedAt: z.string(),
    settlement: sessionProviderAttemptSettlementSchema.optional(),
  })
  .strict();

const toolRecoveryCapabilitySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("no_effect") }).strict(),
  z
    .object({
      kind: z.literal("owner_reconciled"),
      ownerKey: z.literal("agent_tree"),
    })
    .strict(),
  z.object({ kind: z.literal("opaque") }).strict(),
]);

const sessionToolEffectReconciliationSchema = z.discriminatedUnion("effect", [
  z
    .object({
      ownerKey: z.literal("agent_tree"),
      effect: z.literal("applied"),
      evidence: z
        .object({
          kind: z.literal("agent_tree_delegate"),
          sessionId: z.string().min(1),
          delegationId: z.string().min(1),
          childAgentId: z.string().min(1),
          childRunId: z.string().min(1),
          parentRunId: z.string().min(1),
          parentToolCallId: z.string().min(1),
          status: z.enum([
            "queued",
            "running",
            "completed",
            "failed",
            "turn_limited",
            "timed_out",
            "budget_limited",
            "provider_blocked",
            "cancelled",
            "interrupted",
          ]),
          result: z
            .object({
              status: z.enum([
                "completed",
                "failed",
                "turn_limited",
                "timed_out",
                "budget_limited",
                "provider_blocked",
                "cancelled",
                "interrupted",
              ]),
              finalText: z.string().nullable(),
              error: z.string().nullable(),
              pendingInputCount: z.number().int().nonnegative(),
            })
            .strict()
            .nullable(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ownerKey: z.literal("agent_tree"),
      effect: z.literal("not_applied"),
      evidence: z
        .object({
          kind: z.literal("agent_tree_delegate_not_accepted"),
          sessionId: z.string().min(1),
          delegationId: z.string().min(1),
          parentRunId: z.string().min(1),
          parentToolCallId: z.string().min(1),
          profile: z.enum(["explorer", "reviewer"]),
          mode: z.enum(["foreground", "background"]),
          argumentsSha256: z.string().regex(/^[a-f0-9]{64}$/u),
        })
        .strict(),
    })
    .strict(),
]);

const checkpointModeOwnershipSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("unowned") }).strict(),
  z
    .object({
      kind: z.literal("owned"),
      beforeMode: z.number().int().nonnegative(),
      afterMode: z.number().int().nonnegative(),
    })
    .strict(),
]);

const checkpointOperationSchema = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("edit"),
      filePath: z.string(),
      beforeContent: z.string(),
      afterContent: z.string(),
      modeOwnership: checkpointModeOwnershipSchema,
    })
    .strict(),
  z
    .object({
      operation: z.literal("create"),
      filePath: z.string(),
      afterContent: z.string(),
      mode: z.number().int().nonnegative().optional(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("delete"),
      filePath: z.string(),
      beforeContent: z.string(),
      mode: z.number().int().nonnegative(),
    })
    .strict(),
]);

const sessionToolContinuationEffectsSchema = z
  .object({
    checkpointOperations: z.array(checkpointOperationSchema),
    taskProgress: sessionTaskProgressSchema.optional(),
    goal: sessionGoalSchema.optional(),
    skillState: skillLifecycleStateSchema.optional(),
    delegation: z
      .array(
        z
          .object({
            usage: sessionProviderAttemptUsageSchema,
            costUsd: z.number().nonnegative(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();

const activeSessionToolInvocationBaseSchema = z.object({
  operationId: z.string().min(1),
  runId: z.string().min(1),
  resultMessageId: z.string().min(1),
  toolCallId: z.string().min(1),
  sourceIndex: z.number().int().nonnegative(),
  toolName: z.string().min(1),
  recovery: toolRecoveryCapabilitySchema,
  canonicalArguments: z.record(z.string(), z.json()),
  argumentsSha256: z.string().regex(/^[a-f0-9]{64}$/u),
});

const activeSessionToolInvocationSchema = z.discriminatedUnion("phase", [
  activeSessionToolInvocationBaseSchema
    .extend({ phase: z.literal("planned") })
    .strict(),
  activeSessionToolInvocationBaseSchema
    .extend({
      phase: z.literal("effect_pending"),
      startedAt: z.string(),
      reconciliation: sessionToolEffectReconciliationSchema.optional(),
    })
    .strict(),
  activeSessionToolInvocationBaseSchema
    .extend({
      phase: z.literal("settled"),
      startedAt: z.string().optional(),
      settledAt: z.string(),
      kind: z.enum([
        "completed",
        "not_executed_after_restart",
        "interrupted_no_effect",
        "interrupted_effect_unknown",
      ]),
      reconciliation: sessionToolEffectReconciliationSchema.optional(),
      toolMessage: storedMessageSchema,
      effects: sessionToolContinuationEffectsSchema,
    })
    .strict(),
]);

const activeSessionTaskBaseSchema = z.object({
  taskId: z.string().min(1),
  runId: z.string().min(1),
  trigger: z.literal("user_prompt"),
  admittedAt: z.string(),
  userMessageId: z.string().min(1),
  provider: sessionModelSelectionSchema,
  maxProviderReplacements: z.number().int().nonnegative(),
  providerReplacementsUsed: z.number().int().nonnegative(),
  recovered: z.boolean(),
  providerRequestIds: z.array(
    z
      .object({
        attemptId: z.string().min(1),
        responseMessageId: z.string().min(1),
      })
      .strict(),
  ),
  unknownProviderAttemptIds: z.array(z.string().min(1)),
  toolEffectRecoveryPolicy: z.enum(["block", "accept_unknown"]),
  acceptedUnknownEffectOperationIds: z.array(z.string().min(1)),
});

const providerReadyTaskSchema = activeSessionTaskBaseSchema
  .extend({ phase: z.literal("provider_ready") })
  .strict();
const providerPendingTaskSchema = activeSessionTaskBaseSchema
  .extend({
    phase: z.literal("provider_pending"),
    providerAttempt: activeSessionProviderAttemptSchema,
  })
  .strict();
const providerSettledTaskSchema = activeSessionTaskBaseSchema
  .extend({
    phase: z.literal("provider_settled"),
    providerAttempt: activeSessionProviderAttemptSchema.extend({
      settlement: z
        .object({
          outcome: z.literal("completed"),
          usage: sessionProviderAttemptUsageSchema,
        })
        .strict(),
    }),
    assistantMessage: storedMessageSchema,
    stopReason: z.enum(["stop", "length"]),
  })
  .strict();
const toolExecutionTaskSchema = providerSettledTaskSchema
  .omit({ phase: true })
  .extend({
    phase: z.literal("tool_execution"),
    toolInvocations: z.array(activeSessionToolInvocationSchema).min(1),
  })
  .strict();
const recoveryBlockedTaskSchema = activeSessionTaskBaseSchema
  .extend({
    phase: z.literal("recovery_blocked"),
    providerAttempt: activeSessionProviderAttemptSchema.optional(),
    assistantMessage: storedMessageSchema.optional(),
    stopReason: z.enum(["stop", "length"]).optional(),
    toolInvocations: z
      .array(activeSessionToolInvocationSchema)
      .min(1)
      .optional(),
    reason: z.enum([
      "provider_replacement_limit",
      "provider_budget",
      "tool_effect",
    ]),
  })
  .strict();

const activeSessionTaskSchema = z.discriminatedUnion("phase", [
  providerReadyTaskSchema,
  providerPendingTaskSchema,
  providerSettledTaskSchema,
  toolExecutionTaskSchema,
  recoveryBlockedTaskSchema,
]);

const sessionLastTaskOutcomeSchema = z
  .object({
    taskId: z.string().min(1),
    runId: z.string().min(1),
    outcome: z.enum([
      "completed",
      "completed_with_unknown_effects",
      "failed",
      "aborted",
    ]),
    timestamp: z.string(),
    recovered: z.boolean(),
    unknownProviderAttemptIds: z.array(z.string().min(1)),
    unknownToolEffectOperationIds: z.array(z.string().min(1)),
    responseMessageId: z.string().min(1).optional(),
  })
  .strict();

const appendRecordSchema = z
  .object({
    schemaVersion: z.literal(SESSION_SCHEMA_VERSION),
    type: z.literal("append"),
    timestamp: z.string(),
    reason: z.literal("turn"),
    messages: z.array(storedMessageSchema),
    skillState: skillLifecycleStateSchema.optional(),
    consumedInputIds: consumedInputIdsSchema.optional(),
  })
  .strict();

const replaceRecordSchema = z
  .object({
    schemaVersion: z.literal(SESSION_SCHEMA_VERSION),
    type: z.literal("replace"),
    timestamp: z.string(),
    reason: z.enum(["turn", "compaction"]),
    messages: z.array(storedMessageSchema),
    skillState: skillLifecycleStateSchema.optional(),
    consumedInputIds: consumedInputIdsSchema.optional(),
  })
  .strict();

const modelSwitchRecordSchema = z
  .object({
    schemaVersion: z.literal(SESSION_SCHEMA_VERSION),
    type: z.literal("model_switch"),
    timestamp: z.string(),
    from: sessionModelSelectionSchema.nullable(),
    to: sessionModelSelectionSchema,
    consumedInputIds: consumedInputIdsSchema.optional(),
  })
  .strict();

const sessionTitleRecordSchema = z
  .object({
    schemaVersion: z.literal(SESSION_SCHEMA_VERSION),
    type: z.literal("session_title"),
    timestamp: z.string(),
    title: sessionTitleSchema,
    consumedInputIds: consumedInputIdsSchema.optional(),
  })
  .strict();

const sessionGoalRecordSchema = z
  .object({
    schemaVersion: z.literal(SESSION_SCHEMA_VERSION),
    type: z.literal("session_goal"),
    timestamp: z.string(),
    goal: sessionGoalSchema.nullable(),
    consumedInputIds: consumedInputIdsSchema.optional(),
  })
  .strict();

const taskProgressRecordSchema = z
  .object({
    schemaVersion: z.literal(SESSION_SCHEMA_VERSION),
    type: z.literal("task_progress"),
    timestamp: z.string(),
    messageOrdinal: z.number().int().nonnegative(),
    tasks: sessionTaskPlanSchema,
  })
  .strict();

const sessionSkillStateCheckpointSchema = z
  .object({
    messageOrdinal: z.number().int().nonnegative(),
    skillActivations: skillActivationsSchema,
    activeSkillIds: activeSkillIdsSchema,
  })
  .strict();

const skillStateRecordSchema = z
  .object({
    schemaVersion: z.literal(SESSION_SCHEMA_VERSION),
    type: z.literal("skill_state"),
    timestamp: z.string(),
    messageOrdinal: z.number().int().nonnegative(),
    skillActivations: skillActivationsSchema,
    activeSkillIds: activeSkillIdsSchema,
    consumedInputIds: consumedInputIdsSchema.optional(),
  })
  .strict();

const sessionTaskProgressCheckpointSchema = z
  .object({
    messageOrdinal: z.number().int().nonnegative(),
    taskProgress: sessionTaskProgressSchema,
  })
  .strict();

const inputAdmittedRecordSchema = z
  .object({
    schemaVersion: z.literal(SESSION_SCHEMA_VERSION),
    type: z.literal("input_admitted"),
    timestamp: z.string(),
    id: z.string(),
    sequence: z.number().int().nonnegative(),
    line: z.string(),
  })
  .strict();

const inputConsumedRecordSchema = z
  .object({
    schemaVersion: z.literal(SESSION_SCHEMA_VERSION),
    type: z.literal("input_consumed"),
    timestamp: z.string(),
    inputIds: consumedInputIdsSchema,
  })
  .strict();

const exactBashApprovalGrantSchema = z
  .object({
    type: z.literal("exact"),
    cwd: z.string(),
    command: z.string(),
  })
  .strict();

const prefixBashApprovalGrantSchema = z
  .object({
    type: z.literal("prefix"),
    cwd: z.string(),
    argvPrefix: z.array(z.string()),
  })
  .strict();

const commandFamilyBashApprovalGrantSchema = z
  .object({
    type: z.literal("command_family"),
    cwd: z.string(),
    commandFamily: z.literal("pnpm_vitest_run_workspace_test_selectors"),
  })
  .strict();

const bashApprovalGrantSchema = z.discriminatedUnion("type", [
  exactBashApprovalGrantSchema,
  prefixBashApprovalGrantSchema,
  commandFamilyBashApprovalGrantSchema,
]);

const bashApprovalGrantedRecordSchema = z
  .object({
    schemaVersion: z.literal(SESSION_SCHEMA_VERSION),
    type: z.literal("bash_approval_granted"),
    timestamp: z.string(),
    grant: bashApprovalGrantSchema,
  })
  .strict();

const bashApprovalRevokedRecordSchema = z
  .object({
    schemaVersion: z.literal(SESSION_SCHEMA_VERSION),
    type: z.literal("bash_approval_revoked"),
    timestamp: z.string(),
    grant: bashApprovalGrantSchema,
    consumedInputIds: consumedInputIdsSchema.optional(),
  })
  .strict();

const bashApprovalsClearedRecordSchema = z
  .object({
    schemaVersion: z.literal(SESSION_SCHEMA_VERSION),
    type: z.literal("bash_approvals_cleared"),
    timestamp: z.string(),
    consumedInputIds: consumedInputIdsSchema.optional(),
  })
  .strict();

const taskAdmittedRecordSchema = z
  .object({
    schemaVersion: z.literal(SESSION_SCHEMA_VERSION),
    type: z.literal("task_admitted"),
    timestamp: z.string(),
    task: providerReadyTaskSchema,
    userMessage: storedMessageSchema,
    consumedInputIds: consumedInputIdsSchema.optional(),
  })
  .strict();

const providerIntentRecordSchema = z
  .object({
    schemaVersion: z.literal(SESSION_SCHEMA_VERSION),
    type: z.literal("provider_intent"),
    timestamp: z.string(),
    task: providerPendingTaskSchema,
  })
  .strict();

const providerAttemptSettledRecordSchema = z
  .object({
    schemaVersion: z.literal(SESSION_SCHEMA_VERSION),
    type: z.literal("provider_attempt_settled"),
    timestamp: z.string(),
    task: providerPendingTaskSchema.extend({
      providerAttempt: activeSessionProviderAttemptSchema.extend({
        settlement: sessionProviderAttemptSettlementSchema,
      }),
    }),
  })
  .strict();

const providerSettledRecordSchema = z
  .object({
    schemaVersion: z.literal(SESSION_SCHEMA_VERSION),
    type: z.literal("provider_settled"),
    timestamp: z.string(),
    task: z.discriminatedUnion("phase", [
      providerSettledTaskSchema,
      toolExecutionTaskSchema,
    ]),
  })
  .strict();

const toolIntentRecordSchema = z
  .object({
    schemaVersion: z.literal(SESSION_SCHEMA_VERSION),
    type: z.literal("tool_intent"),
    timestamp: z.string(),
    task: toolExecutionTaskSchema,
    operationIds: z.array(z.string().min(1)).min(1),
  })
  .strict();

const toolSettledRecordSchema = z
  .object({
    schemaVersion: z.literal(SESSION_SCHEMA_VERSION),
    type: z.literal("tool_settled"),
    timestamp: z.string(),
    task: toolExecutionTaskSchema,
    operationId: z.string().min(1),
  })
  .strict();

const effectReconciledRecordSchema = z
  .object({
    schemaVersion: z.literal(SESSION_SCHEMA_VERSION),
    type: z.literal("effect_reconciled"),
    timestamp: z.string(),
    task: toolExecutionTaskSchema,
    operationId: z.string().min(1),
    reconciliation: sessionToolEffectReconciliationSchema,
  })
  .strict();

const taskRecoveryDispositionRecordSchema = z
  .object({
    schemaVersion: z.literal(SESSION_SCHEMA_VERSION),
    type: z.literal("task_recovery_disposition"),
    timestamp: z.string(),
    task: toolExecutionTaskSchema,
    disposition: z
      .object({
        kind: z.literal("accept_unknown"),
        operationIds: z.array(z.string().min(1)).min(1),
      })
      .strict(),
  })
  .strict();

const taskRecoveryStartedRecordSchema = z
  .object({
    schemaVersion: z.literal(SESSION_SCHEMA_VERSION),
    type: z.literal("task_recovery_started"),
    timestamp: z.string(),
    task: z.discriminatedUnion("phase", [
      providerReadyTaskSchema,
      recoveryBlockedTaskSchema,
    ]),
  })
  .strict();

const stepCommittedRecordSchema = z
  .object({
    schemaVersion: z.literal(SESSION_SCHEMA_VERSION),
    type: z.literal("step_committed"),
    timestamp: z.string(),
    task: z.discriminatedUnion("phase", [
      providerReadyTaskSchema,
      recoveryBlockedTaskSchema,
    ]),
    messages: z.array(storedMessageSchema),
    replaceTranscript: z.literal(true).optional(),
    consumedInputIds: consumedInputIdsSchema.optional(),
  })
  .strict();

const taskTerminalRecordSchema = z
  .object({
    schemaVersion: z.literal(SESSION_SCHEMA_VERSION),
    type: z.literal("task_terminal"),
    timestamp: z.string(),
    taskId: z.string().min(1),
    runId: z.string().min(1),
    messages: z.array(storedMessageSchema),
    replaceTranscript: z.literal(true).optional(),
    lastTaskOutcome: sessionLastTaskOutcomeSchema,
    skillState: skillLifecycleStateSchema.optional(),
    consumedInputIds: consumedInputIdsSchema.optional(),
  })
  .strict();

const queuedInputSchema = z
  .object({
    id: z.string(),
    timestamp: z.string(),
    sequence: z.number().int().nonnegative(),
    line: z.string(),
  })
  .strict();

const snapshotRecordSchema = z
  .object({
    schemaVersion: z.literal(SESSION_SCHEMA_VERSION),
    type: z.literal("snapshot"),
    timestamp: z.string(),
    reason: z.literal("size_threshold"),
    title: sessionTitleSchema.optional(),
    goal: sessionGoalSchema.optional(),
    messages: z.array(storedMessageSchema),
    pendingInputs: z.array(queuedInputSchema),
    bashApprovalGrants: z.array(bashApprovalGrantSchema).optional(),
    activeModel: sessionModelSelectionSchema.optional(),
    modelSwitches: z.array(sessionModelSwitchSchema).optional(),
    taskProgressCheckpoints: z
      .array(sessionTaskProgressCheckpointSchema)
      .optional(),
    skillStateCheckpoints: z.array(sessionSkillStateCheckpointSchema).min(1),
    activeTask: activeSessionTaskSchema.optional(),
    lastTaskOutcome: sessionLastTaskOutcomeSchema.optional(),
  })
  .strict();

const schemaVersionProbeSchema = z
  .object({
    schemaVersion: z.number().int(),
  })
  .passthrough();

const sessionMutationRecordSchema = z.discriminatedUnion("type", [
  appendRecordSchema,
  replaceRecordSchema,
  modelSwitchRecordSchema,
  sessionTitleRecordSchema,
  sessionGoalRecordSchema,
  taskProgressRecordSchema,
  inputAdmittedRecordSchema,
  inputConsumedRecordSchema,
  bashApprovalGrantedRecordSchema,
  bashApprovalRevokedRecordSchema,
  bashApprovalsClearedRecordSchema,
  taskAdmittedRecordSchema,
  providerIntentRecordSchema,
  providerAttemptSettledRecordSchema,
  providerSettledRecordSchema,
  toolIntentRecordSchema,
  effectReconciledRecordSchema,
  toolSettledRecordSchema,
  taskRecoveryDispositionRecordSchema,
  taskRecoveryStartedRecordSchema,
  stepCommittedRecordSchema,
  taskTerminalRecordSchema,
  skillStateRecordSchema,
  snapshotRecordSchema,
]);

type RawMessage = z.infer<typeof messageSchema>;
type RawSubagentResultDeliveryMessage = Extract<
  RawMessage,
  { readonly subagentResultDelivery: object }
>;
type RawStoredMessage = z.infer<typeof storedMessageSchema>;
type RawUserMessageContextCompactionMetadata = z.infer<
  typeof userMessageContextCompactionSchema
>;
type RawSessionQueuedInput = z.infer<typeof queuedInputSchema>;
type RawBashApprovalGrant = z.infer<typeof bashApprovalGrantSchema>;
type RawSessionModelSelection = z.infer<typeof sessionModelSelectionSchema>;
type RawSessionModelSwitch = z.infer<typeof sessionModelSwitchSchema>;
type RawSessionGoal = z.infer<typeof sessionGoalSchema>;
type RawSessionTaskProgressCheckpoint = z.infer<
  typeof sessionTaskProgressCheckpointSchema
>;
type RawSkillActivation = z.infer<typeof skillActivationSchema>;
type RawSessionSkillStateCheckpoint = z.infer<
  typeof sessionSkillStateCheckpointSchema
>;
type RawActiveSessionTask = z.infer<typeof activeSessionTaskSchema>;
type RawActiveSessionToolInvocation = z.infer<
  typeof activeSessionToolInvocationSchema
>;
type RawSessionLastTaskOutcome = z.infer<typeof sessionLastTaskOutcomeSchema>;
type RawSessionHeaderRecord = z.infer<typeof sessionHeaderSchema>;
type RawSessionMutationRecord = z.infer<typeof sessionMutationRecordSchema>;

function isRawSubagentResultDeliveryMessage(
  message: RawMessage,
): message is RawSubagentResultDeliveryMessage {
  return message.role === "user" && "subagentResultDelivery" in message;
}

function copyUserContextCompactionMetadata(
  metadata: UserMessageContextCompactionMetadata,
): UserMessageContextCompactionMetadata {
  return {
    evidence: metadata.evidence.map((evidence) => ({
      handle: evidence.handle,
      label: evidence.label,
      source: evidence.source,
      why: evidence.why,
      ...(evidence.inspectCommand === undefined
        ? {}
        : { inspectCommand: evidence.inspectCommand }),
    })),
    ...(metadata.untrustedMcpContent === true
      ? { untrustedMcpContent: true }
      : {}),
  };
}

function copyUserMessageOrigin(
  origin: OrdinaryUserMessageOrigin,
): OrdinaryUserMessageOrigin {
  return { type: origin.type };
}

function toUserMessageOrigin(
  origin: OrdinaryUserMessageOrigin,
): OrdinaryUserMessageOrigin {
  return { type: origin.type };
}

function toUserContextCompactionMetadata(
  metadata: RawUserMessageContextCompactionMetadata,
): UserMessageContextCompactionMetadata {
  return {
    evidence: metadata.evidence.map((evidence) => {
      const inspectCommand = evidence.inspectCommand;
      return inspectCommand === undefined
        ? {
            handle: evidence.handle,
            label: evidence.label,
            source: evidence.source,
            why: evidence.why,
          }
        : {
            handle: evidence.handle,
            label: evidence.label,
            source: evidence.source,
            why: evidence.why,
            inspectCommand,
          };
    }),
    ...(metadata.untrustedMcpContent === true
      ? { untrustedMcpContent: true }
      : {}),
  };
}

function toMessage(message: RawMessage): PersistedSessionMessage {
  switch (message.role) {
    case "user": {
      const contextCompaction =
        message.contextCompaction === undefined
          ? {}
          : {
              contextCompaction: toUserContextCompactionMetadata(
                message.contextCompaction,
              ),
            };
      if (isRawSubagentResultDeliveryMessage(message)) {
        return {
          role: "user",
          content: message.content,
          origin: { type: "runtime_subagent_notification" },
          subagentResultDelivery: { ...message.subagentResultDelivery },
          ...contextCompaction,
        };
      }
      return {
        role: "user",
        content: message.content,
        origin: toUserMessageOrigin(message.origin),
        ...contextCompaction,
      };
    }
    case "assistant":
      return {
        role: "assistant",
        content: message.content,
        toolCalls: message.toolCalls,
        ...(message.providerMetadata !== undefined
          ? { providerMetadata: message.providerMetadata }
          : {}),
      };
    case "tool":
      return {
        role: "tool",
        toolCallId: message.toolCallId,
        content: message.content,
        ...(message.sourceTruncated !== undefined
          ? { sourceTruncated: message.sourceTruncated }
          : {}),
        ...(message.evidenceShortened === true
          ? { evidenceShortened: true as const }
          : {}),
        ...(message.resourceObservation !== undefined
          ? {
              resourceObservation: copyReadResourceObservation(
                message.resourceObservation,
              ),
            }
          : {}),
        ...(message.recovery === undefined
          ? {}
          : { recovery: { ...message.recovery } }),
      };
  }
}

function copyMessage(
  message: PersistedSessionMessage,
): PersistedSessionMessage {
  switch (message.role) {
    case "user": {
      const contextCompaction =
        message.contextCompaction === undefined
          ? {}
          : {
              contextCompaction: copyUserContextCompactionMetadata(
                message.contextCompaction,
              ),
            };
      if (message.subagentResultDelivery !== undefined) {
        return {
          role: "user",
          content: message.content,
          origin: { type: "runtime_subagent_notification" },
          subagentResultDelivery: { ...message.subagentResultDelivery },
          ...contextCompaction,
        };
      }
      return {
        role: "user",
        content: message.content,
        origin: copyUserMessageOrigin(message.origin),
        ...contextCompaction,
      };
    }
    case "assistant":
      return {
        role: "assistant",
        content: message.content,
        toolCalls: [...message.toolCalls],
        ...(message.providerMetadata !== undefined
          ? { providerMetadata: message.providerMetadata }
          : {}),
      };
    case "tool":
      return {
        role: "tool",
        toolCallId: message.toolCallId,
        content: message.content,
        ...(message.sourceTruncated !== undefined
          ? { sourceTruncated: message.sourceTruncated }
          : {}),
        ...(message.evidenceShortened === true
          ? { evidenceShortened: true as const }
          : {}),
        ...(message.resourceObservation !== undefined
          ? {
              resourceObservation: copyReadResourceObservation(
                message.resourceObservation,
              ),
            }
          : {}),
        ...(message.recovery === undefined
          ? {}
          : { recovery: { ...message.recovery } }),
      };
  }
}

function toStoredMessage(storedMessage: RawStoredMessage): StoredMessage {
  return {
    id: storedMessage.id,
    message: toMessage(storedMessage.message),
  };
}

function copyStoredMessage(storedMessage: StoredMessage): StoredMessage {
  return {
    id: storedMessage.id,
    message: copyMessage(storedMessage.message),
  };
}

function copySessionProviderAttemptSettlement(
  settlement: SessionProviderAttemptSettlement,
): SessionProviderAttemptSettlement {
  switch (settlement.outcome) {
    case "completed":
      return {
        outcome: "completed",
        usage: { ...settlement.usage },
      };
    case "retryable_error":
      return { ...settlement };
    case "context_overflow":
    case "aborted":
      return { outcome: settlement.outcome };
    case "terminal_error":
      return { ...settlement };
  }
}

function copyActiveSessionProviderAttempt(
  attempt: ActiveSessionProviderAttempt,
): ActiveSessionProviderAttempt {
  return {
    attemptId: attempt.attemptId,
    responseMessageId: attempt.responseMessageId,
    startedAt: attempt.startedAt,
    ...(attempt.settlement === undefined
      ? {}
      : {
          settlement: copySessionProviderAttemptSettlement(attempt.settlement),
        }),
  };
}

function toActiveSessionProviderAttempt(
  attempt: z.infer<typeof activeSessionProviderAttemptSchema>,
): ActiveSessionProviderAttempt {
  return {
    attemptId: attempt.attemptId,
    responseMessageId: attempt.responseMessageId,
    startedAt: attempt.startedAt,
    ...(attempt.settlement === undefined
      ? {}
      : {
          settlement: copySessionProviderAttemptSettlement(attempt.settlement),
        }),
  };
}

function activeSessionTaskBase(task: ActiveSessionTask) {
  return {
    taskId: task.taskId,
    runId: task.runId,
    trigger: task.trigger,
    admittedAt: task.admittedAt,
    userMessageId: task.userMessageId,
    provider: toSessionModelSelection(task.provider),
    maxProviderReplacements: task.maxProviderReplacements,
    providerReplacementsUsed: task.providerReplacementsUsed,
    recovered: task.recovered,
    providerRequestIds: task.providerRequestIds.map((request) => ({
      attemptId: request.attemptId,
      responseMessageId: request.responseMessageId,
    })),
    unknownProviderAttemptIds: [...task.unknownProviderAttemptIds],
    toolEffectRecoveryPolicy: task.toolEffectRecoveryPolicy,
    acceptedUnknownEffectOperationIds: [
      ...task.acceptedUnknownEffectOperationIds,
    ],
  } as const;
}

/* v8 ignore next 5 -- the checkpoint operation discriminant is exhaustive; this only guards future variants that bypass TypeScript. */
function unsupportedCheckpointOperation(operation: never): never {
  throw new Error(
    `unsupported checkpoint operation ${JSON.stringify(operation)}`,
  );
}

function copySessionToolContinuationEffects(
  effects: SessionToolContinuationEffects,
): SessionToolContinuationEffects {
  return {
    checkpointOperations: effects.checkpointOperations.map((operation) => {
      switch (operation.operation) {
        case "edit":
          return {
            ...operation,
            modeOwnership: { ...operation.modeOwnership },
          };
        case "create":
        case "delete":
          return { ...operation };
      }
      /* v8 ignore next -- the discriminated union is exhaustive; unsupportedCheckpointOperation guards future variants. */
      return unsupportedCheckpointOperation(operation);
    }),
    ...(effects.taskProgress === undefined
      ? {}
      : { taskProgress: copySessionTaskProgress(effects.taskProgress) }),
    ...(effects.goal === undefined
      ? {}
      : { goal: copySessionGoal(effects.goal) }),
    ...(effects.skillState === undefined
      ? {}
      : { skillState: copySkillLifecycleState(effects.skillState) }),
    ...(effects.delegation === undefined
      ? {}
      : {
          delegation: effects.delegation.map((entry) => ({
            usage: { ...entry.usage },
            costUsd: entry.costUsd,
          })),
        }),
  };
}

function copyActiveSessionToolInvocation(
  invocation: ActiveSessionToolInvocation,
): ActiveSessionToolInvocation {
  const base = {
    operationId: invocation.operationId,
    runId: invocation.runId,
    resultMessageId: invocation.resultMessageId,
    toolCallId: invocation.toolCallId,
    sourceIndex: invocation.sourceIndex,
    toolName: invocation.toolName,
    recovery: { ...invocation.recovery },
    canonicalArguments: structuredClone(invocation.canonicalArguments),
    argumentsSha256: invocation.argumentsSha256,
  } as const;
  switch (invocation.phase) {
    case "planned":
      return { ...base, phase: "planned" };
    case "effect_pending":
      return {
        ...base,
        phase: "effect_pending",
        startedAt: invocation.startedAt,
        ...(invocation.reconciliation === undefined
          ? {}
          : { reconciliation: structuredClone(invocation.reconciliation) }),
      };
    case "settled":
      return {
        ...base,
        phase: "settled",
        ...(invocation.startedAt === undefined
          ? {}
          : { startedAt: invocation.startedAt }),
        settledAt: invocation.settledAt,
        kind: invocation.kind,
        ...(invocation.reconciliation === undefined
          ? {}
          : { reconciliation: structuredClone(invocation.reconciliation) }),
        toolMessage: copyStoredMessage(invocation.toolMessage),
        effects: copySessionToolContinuationEffects(invocation.effects),
      };
  }
}

function copyActiveSessionTask(task: ActiveSessionTask): ActiveSessionTask {
  const base = activeSessionTaskBase(task);
  switch (task.phase) {
    case "provider_ready":
      return { ...base, phase: "provider_ready" };
    case "provider_pending":
      return {
        ...base,
        phase: "provider_pending",
        providerAttempt: copyActiveSessionProviderAttempt(task.providerAttempt),
      };
    case "provider_settled":
      return {
        ...base,
        phase: "provider_settled",
        providerAttempt: {
          ...copyActiveSessionProviderAttempt(task.providerAttempt),
          settlement: {
            outcome: "completed",
            usage: { ...task.providerAttempt.settlement.usage },
          },
        },
        assistantMessage: copyStoredMessage(task.assistantMessage),
        stopReason: task.stopReason,
      };
    case "tool_execution":
      return {
        ...base,
        phase: "tool_execution",
        providerAttempt: {
          ...copyActiveSessionProviderAttempt(task.providerAttempt),
          settlement: {
            outcome: "completed",
            usage: { ...task.providerAttempt.settlement.usage },
          },
        },
        assistantMessage: copyStoredMessage(task.assistantMessage),
        stopReason: task.stopReason,
        toolInvocations: task.toolInvocations.map(
          copyActiveSessionToolInvocation,
        ),
      };
    case "recovery_blocked":
      return {
        ...base,
        phase: "recovery_blocked",
        ...(task.providerAttempt === undefined
          ? {}
          : {
              providerAttempt: copyActiveSessionProviderAttempt(
                task.providerAttempt,
              ),
            }),
        ...(task.assistantMessage === undefined
          ? {}
          : { assistantMessage: copyStoredMessage(task.assistantMessage) }),
        ...(task.stopReason === undefined
          ? {}
          : { stopReason: task.stopReason }),
        ...(task.toolInvocations === undefined
          ? {}
          : {
              toolInvocations: task.toolInvocations.map(
                copyActiveSessionToolInvocation,
              ),
            }),
        reason: task.reason,
      };
  }
}

function toActiveSessionTask(task: RawActiveSessionTask): ActiveSessionTask {
  const base = {
    taskId: task.taskId,
    runId: task.runId,
    trigger: task.trigger,
    admittedAt: task.admittedAt,
    userMessageId: task.userMessageId,
    provider: toSessionModelSelection(task.provider),
    maxProviderReplacements: task.maxProviderReplacements,
    providerReplacementsUsed: task.providerReplacementsUsed,
    recovered: task.recovered,
    providerRequestIds: task.providerRequestIds.map((request) => ({
      attemptId: request.attemptId,
      responseMessageId: request.responseMessageId,
    })),
    unknownProviderAttemptIds: [...task.unknownProviderAttemptIds],
    toolEffectRecoveryPolicy: task.toolEffectRecoveryPolicy,
    acceptedUnknownEffectOperationIds: [
      ...task.acceptedUnknownEffectOperationIds,
    ],
  } as const;
  switch (task.phase) {
    case "provider_ready":
      return { ...base, phase: "provider_ready" };
    case "provider_pending":
      return {
        ...base,
        phase: "provider_pending",
        providerAttempt: toActiveSessionProviderAttempt(task.providerAttempt),
      };
    case "provider_settled":
      return {
        ...base,
        phase: "provider_settled",
        providerAttempt: {
          ...task.providerAttempt,
          settlement: {
            outcome: "completed",
            usage: { ...task.providerAttempt.settlement.usage },
          },
        },
        assistantMessage: toStoredMessage(task.assistantMessage),
        stopReason: task.stopReason,
      };
    case "tool_execution":
      return {
        ...base,
        phase: "tool_execution",
        providerAttempt: {
          ...task.providerAttempt,
          settlement: {
            outcome: "completed",
            usage: { ...task.providerAttempt.settlement.usage },
          },
        },
        assistantMessage: toStoredMessage(task.assistantMessage),
        stopReason: task.stopReason,
        toolInvocations: task.toolInvocations.map(
          toActiveSessionToolInvocation,
        ),
      };
    case "recovery_blocked":
      return {
        ...base,
        phase: "recovery_blocked",
        ...(task.providerAttempt === undefined
          ? {}
          : {
              providerAttempt: toActiveSessionProviderAttempt(
                task.providerAttempt,
              ),
            }),
        ...(task.assistantMessage === undefined
          ? {}
          : { assistantMessage: toStoredMessage(task.assistantMessage) }),
        ...(task.stopReason === undefined
          ? {}
          : { stopReason: task.stopReason }),
        ...(task.toolInvocations === undefined
          ? {}
          : {
              toolInvocations: task.toolInvocations.map(
                toActiveSessionToolInvocation,
              ),
            }),
        reason: task.reason,
      };
  }
}

function toActiveSessionToolInvocation(
  invocation: RawActiveSessionToolInvocation,
): ActiveSessionToolInvocation {
  const base = {
    operationId: invocation.operationId,
    runId: invocation.runId,
    resultMessageId: invocation.resultMessageId,
    toolCallId: invocation.toolCallId,
    sourceIndex: invocation.sourceIndex,
    toolName: invocation.toolName,
    recovery: { ...invocation.recovery },
    canonicalArguments: structuredClone(invocation.canonicalArguments),
    argumentsSha256: invocation.argumentsSha256,
  } as const;
  switch (invocation.phase) {
    case "planned":
      return { ...base, phase: "planned" };
    case "effect_pending":
      return {
        ...base,
        phase: "effect_pending",
        startedAt: invocation.startedAt,
        ...(invocation.reconciliation === undefined
          ? {}
          : { reconciliation: structuredClone(invocation.reconciliation) }),
      };
    case "settled":
      return {
        ...base,
        phase: "settled",
        ...(invocation.startedAt === undefined
          ? {}
          : { startedAt: invocation.startedAt }),
        settledAt: invocation.settledAt,
        kind: invocation.kind,
        ...(invocation.reconciliation === undefined
          ? {}
          : { reconciliation: structuredClone(invocation.reconciliation) }),
        toolMessage: toStoredMessage(invocation.toolMessage),
        effects: {
          checkpointOperations: invocation.effects.checkpointOperations.map(
            (operation) => {
              switch (operation.operation) {
                case "edit":
                  return {
                    ...operation,
                    modeOwnership: { ...operation.modeOwnership },
                  };
                case "create":
                  return {
                    operation: "create" as const,
                    filePath: operation.filePath,
                    afterContent: operation.afterContent,
                    ...(operation.mode === undefined
                      ? {}
                      : { mode: operation.mode }),
                  };
                case "delete":
                  return { ...operation };
              }
              /* v8 ignore next -- the discriminated union is exhaustive; unsupportedCheckpointOperation guards future variants. */
              return unsupportedCheckpointOperation(operation);
            },
          ),
          ...(invocation.effects.taskProgress === undefined
            ? {}
            : {
                taskProgress: copySessionTaskProgress(
                  invocation.effects.taskProgress,
                ),
              }),
          ...(invocation.effects.goal === undefined
            ? {}
            : { goal: copySessionGoal(invocation.effects.goal) }),
          ...(invocation.effects.skillState === undefined
            ? {}
            : {
                skillState: copySkillLifecycleState(
                  invocation.effects.skillState,
                ),
              }),
          ...(invocation.effects.delegation === undefined
            ? {}
            : {
                delegation: invocation.effects.delegation.map((entry) => ({
                  usage: { ...entry.usage },
                  costUsd: entry.costUsd,
                })),
              }),
        },
      };
  }
}

function toProviderReadySessionTask(
  task: RawActiveSessionTask,
): Extract<ActiveSessionTask, { readonly phase: "provider_ready" }> {
  const converted = toActiveSessionTask(task);
  /* v8 ignore next 3 -- the discriminated input schema fixes this phase before conversion. */
  if (converted.phase !== "provider_ready") {
    sessionStoreError("Error: provider-ready Task record changed phase.");
  }
  return converted;
}

function toProviderPendingSessionTask(
  task: RawActiveSessionTask,
): Extract<ActiveSessionTask, { readonly phase: "provider_pending" }> {
  const converted = toActiveSessionTask(task);
  /* v8 ignore next 3 -- the discriminated input schema fixes this phase before conversion. */
  if (converted.phase !== "provider_pending") {
    sessionStoreError("Error: provider-pending Task record changed phase.");
  }
  return converted;
}

function toProviderAttemptSettledSessionTask(
  task: RawActiveSessionTask,
): Extract<ActiveSessionTask, { readonly phase: "provider_pending" }> & {
  readonly providerAttempt: ActiveSessionProviderAttempt & {
    readonly settlement: SessionProviderAttemptSettlement;
  };
} {
  const converted = toProviderPendingSessionTask(task);
  const settlement = converted.providerAttempt.settlement;
  /* v8 ignore next 3 -- the settled-attempt input schema requires this field before conversion. */
  if (settlement === undefined) {
    sessionStoreError("Error: settled provider attempt is missing settlement.");
  }
  return {
    ...converted,
    providerAttempt: {
      ...converted.providerAttempt,
      settlement,
    },
  };
}

function toProviderSettledSessionTask(
  task: RawActiveSessionTask,
): Extract<
  ActiveSessionTask,
  { readonly phase: "provider_settled" | "tool_execution" }
> {
  const converted = toActiveSessionTask(task);
  /* v8 ignore next 3 -- the discriminated input schema fixes this phase before conversion. */
  if (
    converted.phase !== "provider_settled" &&
    converted.phase !== "tool_execution"
  ) {
    sessionStoreError("Error: provider-settled Task record changed phase.");
  }
  return converted;
}

function toToolExecutionSessionTask(
  task: RawActiveSessionTask,
): Extract<ActiveSessionTask, { readonly phase: "tool_execution" }> {
  const converted = toActiveSessionTask(task);
  /* v8 ignore next 3 -- the tool mutation schemas fix this phase before conversion. */
  if (converted.phase !== "tool_execution") {
    sessionStoreError("Error: tool-execution Task record changed phase.");
  }
  return converted;
}

function toRecoverySessionTask(
  task: RawActiveSessionTask,
): Extract<
  ActiveSessionTask,
  { readonly phase: "provider_ready" | "recovery_blocked" }
> {
  const converted = toActiveSessionTask(task);
  /* v8 ignore next 6 -- the recovery-record union admits only these two discriminants before conversion. */
  if (
    converted.phase !== "provider_ready" &&
    converted.phase !== "recovery_blocked"
  ) {
    sessionStoreError("Error: recovery Task record changed phase.");
  }
  return converted;
}

function copySessionLastTaskOutcome(
  outcome: SessionLastTaskOutcome,
): SessionLastTaskOutcome {
  return {
    taskId: outcome.taskId,
    runId: outcome.runId,
    outcome: outcome.outcome,
    timestamp: outcome.timestamp,
    recovered: outcome.recovered,
    unknownProviderAttemptIds: [...outcome.unknownProviderAttemptIds],
    unknownToolEffectOperationIds: [...outcome.unknownToolEffectOperationIds],
    ...(outcome.responseMessageId === undefined
      ? {}
      : { responseMessageId: outcome.responseMessageId }),
  };
}

function toSessionLastTaskOutcome(
  outcome: RawSessionLastTaskOutcome,
): SessionLastTaskOutcome {
  return {
    taskId: outcome.taskId,
    runId: outcome.runId,
    outcome: outcome.outcome,
    timestamp: outcome.timestamp,
    recovered: outcome.recovered,
    unknownProviderAttemptIds: [...outcome.unknownProviderAttemptIds],
    unknownToolEffectOperationIds: [...outcome.unknownToolEffectOperationIds],
    ...(outcome.responseMessageId === undefined
      ? {}
      : { responseMessageId: outcome.responseMessageId }),
  };
}

function redactStoredMessageForPersistence(
  storedMessage: StoredMessage,
): StoredMessage {
  return {
    id: storedMessage.id,
    message: redactMessageForPersistence(storedMessage.message),
  };
}

function messagesFromStoredMessages(
  storedMessages: readonly StoredMessage[],
): readonly PersistedSessionMessage[] {
  return storedMessages.map((storedMessage) =>
    copyMessage(storedMessage.message),
  );
}

function copySessionForkPolicyRecord(
  policy: SessionForkPolicyRecord,
): SessionForkPolicyRecord {
  return {
    transcript: policy.transcript,
    pendingInputs: policy.pendingInputs,
    queuedInputs: policy.queuedInputs,
    bashApprovalGrants: policy.bashApprovalGrants,
  };
}

function copySessionForkPointRecord(
  forkPoint: SessionForkPointRecord,
): SessionForkPointRecord {
  switch (forkPoint.kind) {
    case "before_message":
      return {
        kind: "before_message",
        sourceSessionId: forkPoint.sourceSessionId,
        sourceMessageId: forkPoint.sourceMessageId,
        sourceOrdinal: forkPoint.sourceOrdinal,
        preview: forkPoint.preview,
      };
    case "end":
      return {
        kind: "end",
        sourceSessionId: forkPoint.sourceSessionId,
        sourceLastMessageId: forkPoint.sourceLastMessageId,
        sourceOrdinal: forkPoint.sourceOrdinal,
        preview: forkPoint.preview,
      };
  }
}

function copySessionGraphRecord(graph: SessionGraphRecord): SessionGraphRecord {
  return {
    graphId: graph.graphId,
    rootSessionId: graph.rootSessionId,
    parentSessionId: graph.parentSessionId,
    branchTitle: graph.branchTitle,
    forkPoint:
      graph.forkPoint === null
        ? null
        : copySessionForkPointRecord(graph.forkPoint),
    forkPolicy: copySessionForkPolicyRecord(graph.forkPolicy),
  };
}

function toSkillActivation(activation: RawSkillActivation): SkillActivation {
  return {
    descriptorId: activation.descriptorId,
    packageId: activation.packageId,
    qualifiedName: activation.qualifiedName,
    scope: activation.scope,
    name: activation.name,
    relativePath: activation.relativePath,
    resourcePaths: [...activation.resourcePaths],
    digest: activation.digest,
    trigger: activation.trigger,
    args: activation.args,
    contentSnapshot: activation.contentSnapshot,
    activatedAt: activation.activatedAt,
  };
}

function redactSkillActivationForPersistence(
  activation: SkillActivation,
): SkillActivation {
  const redacted = {
    descriptorId: activation.descriptorId,
    packageId: activation.packageId,
    qualifiedName: activation.qualifiedName,
    scope: activation.scope,
    name: activation.name,
    relativePath: activation.relativePath,
    resourcePaths: activation.resourcePaths.map(redactTextForPersistence),
    digest: activation.digest,
    trigger: activation.trigger,
    args: redactTextForPersistence(activation.args),
    contentSnapshot: redactTextForPersistence(activation.contentSnapshot),
    activatedAt: activation.activatedAt,
  };
  if (
    redacted.args !== activation.args ||
    redacted.contentSnapshot !== activation.contentSnapshot ||
    redacted.resourcePaths.some(
      (path, index) => path !== activation.resourcePaths[index],
    )
  ) {
    sessionStoreError(
      `Error: workflow skill ${JSON.stringify(activation.qualifiedName)} cannot be persisted because its snapshot contains secret-like text; remove that text or use an ephemeral session.`,
    );
  }
  return redacted;
}

function toSessionSkillStateCheckpoint(
  checkpoint: RawSessionSkillStateCheckpoint,
): SessionSkillStateCheckpoint {
  return {
    messageOrdinal: checkpoint.messageOrdinal,
    skillActivations: checkpoint.skillActivations.map(toSkillActivation),
    activeSkillIds: [...checkpoint.activeSkillIds],
  };
}

function redactSessionSkillStateCheckpointForPersistence(
  checkpoint: SessionSkillStateCheckpoint,
): SessionSkillStateCheckpoint {
  return {
    messageOrdinal: checkpoint.messageOrdinal,
    skillActivations: checkpoint.skillActivations.map(
      redactSkillActivationForPersistence,
    ),
    activeSkillIds: [...checkpoint.activeSkillIds],
  };
}

function toSessionHeaderRecord(
  record: RawSessionHeaderRecord,
): SessionHeaderRecord {
  return {
    schemaVersion: SESSION_SCHEMA_VERSION,
    type: "session",
    id: record.id,
    createdAt: record.createdAt,
    workspace: record.workspace,
    graph: copySessionGraphRecord(record.graph),
  };
}

function toSessionModelSelection(
  selection: RawSessionModelSelection,
): SessionModelSelection {
  return {
    providerId: selection.providerId,
    model: selection.model,
  };
}

function toSessionModelSwitch(
  modelSwitch: RawSessionModelSwitch,
): SessionModelSwitch {
  return {
    timestamp: modelSwitch.timestamp,
    from:
      modelSwitch.from === null
        ? null
        : toSessionModelSelection(modelSwitch.from),
    to: toSessionModelSelection(modelSwitch.to),
    messageOrdinal: modelSwitch.messageOrdinal,
  };
}

function toSessionGoal(goal: RawSessionGoal): SessionGoal {
  return redactSessionGoalForPersistence(goal);
}

function appendConsumedInputIds(
  record: AppendSessionRecord,
  inputIds: readonly string[] | undefined,
): AppendSessionRecord;
function appendConsumedInputIds(
  record: ReplaceSessionRecord,
  inputIds: readonly string[] | undefined,
): ReplaceSessionRecord;
function appendConsumedInputIds(
  record: ModelSwitchSessionRecord,
  inputIds: readonly string[] | undefined,
): ModelSwitchSessionRecord;
function appendConsumedInputIds(
  record: SessionTitleSessionRecord,
  inputIds: readonly string[] | undefined,
): SessionTitleSessionRecord;
function appendConsumedInputIds(
  record: SessionGoalSessionRecord,
  inputIds: readonly string[] | undefined,
): SessionGoalSessionRecord;
function appendConsumedInputIds(
  record: BashApprovalRevokedSessionRecord,
  inputIds: readonly string[] | undefined,
): BashApprovalRevokedSessionRecord;
function appendConsumedInputIds(
  record: BashApprovalsClearedSessionRecord,
  inputIds: readonly string[] | undefined,
): BashApprovalsClearedSessionRecord;
function appendConsumedInputIds(
  record: SkillStateSessionRecord,
  inputIds: readonly string[] | undefined,
): SkillStateSessionRecord;
function appendConsumedInputIds(
  record: StepCommittedSessionRecord,
  inputIds: readonly string[] | undefined,
): StepCommittedSessionRecord;
function appendConsumedInputIds(
  record: TaskTerminalSessionRecord,
  inputIds: readonly string[] | undefined,
): TaskTerminalSessionRecord;
function appendConsumedInputIds(
  record:
    | AppendSessionRecord
    | ReplaceSessionRecord
    | ModelSwitchSessionRecord
    | SessionTitleSessionRecord
    | SessionGoalSessionRecord
    | BashApprovalRevokedSessionRecord
    | BashApprovalsClearedSessionRecord
    | SkillStateSessionRecord
    | StepCommittedSessionRecord
    | TaskTerminalSessionRecord,
  inputIds: readonly string[] | undefined,
):
  | AppendSessionRecord
  | ReplaceSessionRecord
  | ModelSwitchSessionRecord
  | SessionTitleSessionRecord
  | SessionGoalSessionRecord
  | BashApprovalRevokedSessionRecord
  | BashApprovalsClearedSessionRecord
  | SkillStateSessionRecord
  | StepCommittedSessionRecord
  | TaskTerminalSessionRecord {
  if (inputIds === undefined) {
    return record;
  }
  return { ...record, consumedInputIds: [...inputIds] };
}

function redactSessionTaskProgressForPersistence(
  taskProgress: SessionTaskProgress,
): SessionTaskProgress {
  return {
    tasks: taskProgress.tasks.map((task) => ({
      step: redactTextForPersistence(task.step),
      status: task.status,
    })),
  };
}

function redactSessionToolContinuationEffectsForPersistence(
  effects: SessionToolContinuationEffects,
): SessionToolContinuationEffects {
  return {
    checkpointOperations: effects.checkpointOperations.map((operation) => {
      const filePath = redactTextForPersistence(operation.filePath);
      switch (operation.operation) {
        case "edit":
          return {
            operation: "edit",
            filePath,
            beforeContent: redactTextForPersistence(operation.beforeContent),
            afterContent: redactTextForPersistence(operation.afterContent),
            modeOwnership: { ...operation.modeOwnership },
          };
        case "create":
          return {
            operation: "create",
            filePath,
            afterContent: redactTextForPersistence(operation.afterContent),
            ...(operation.mode === undefined ? {} : { mode: operation.mode }),
          };
        case "delete":
          return {
            operation: "delete",
            filePath,
            beforeContent: redactTextForPersistence(operation.beforeContent),
            mode: operation.mode,
          };
      }
      /* v8 ignore next -- the discriminated union is exhaustive; unsupportedCheckpointOperation guards future variants. */
      return unsupportedCheckpointOperation(operation);
    }),
    ...(effects.taskProgress === undefined
      ? {}
      : {
          taskProgress: redactSessionTaskProgressForPersistence(
            effects.taskProgress,
          ),
        }),
    ...(effects.goal === undefined
      ? {}
      : { goal: redactSessionGoalForPersistence(effects.goal) }),
    ...(effects.skillState === undefined
      ? {}
      : {
          skillState: {
            skillActivations: effects.skillState.skillActivations.map(
              redactSkillActivationForPersistence,
            ),
            activeSkillIds: [...effects.skillState.activeSkillIds],
          },
        }),
    ...(effects.delegation === undefined
      ? {}
      : {
          delegation: effects.delegation.map((entry) => ({
            usage: { ...entry.usage },
            costUsd: entry.costUsd,
          })),
        }),
  };
}

function normalizeSessionTitleForPersistence(title: string): string {
  const normalized = redactTextForPersistence(title)
    .replace(/\s+/gu, " ")
    .trim();
  if (normalized.length <= SESSION_TITLE_MAX_LENGTH) {
    return normalized;
  }
  return normalized.slice(0, SESSION_TITLE_MAX_LENGTH).trimEnd();
}

interface RedactBoundedGoalTextOptions {
  readonly value: string;
  readonly normalize: (value: string) => string;
  readonly maxLength: number;
  readonly emptyError: string;
  readonly lengthError: string;
}

type RedactValidatedBoundedGoalTextOptions = Pick<
  RedactBoundedGoalTextOptions,
  "value" | "normalize" | "maxLength"
>;

function truncateTextForPersistence(text: string, maxLength: number): string {
  const truncated = text.slice(0, maxLength).trimEnd();
  return truncated === "" ? text.slice(0, maxLength) : truncated;
}

function redactBoundedGoalTextForPersistence(
  options: RedactBoundedGoalTextOptions,
): string {
  const redacted = options.normalize(redactTextForPersistence(options.value));
  if (redacted === "") {
    sessionStoreError(options.emptyError);
  }
  if (redacted.length <= options.maxLength) {
    return redacted;
  }
  const raw = options.normalize(options.value);
  if (raw.length <= options.maxLength) {
    return truncateTextForPersistence(redacted, options.maxLength);
  }
  sessionStoreError(options.lengthError);
}

function redactValidatedBoundedGoalTextForPersistence(
  options: RedactValidatedBoundedGoalTextOptions,
): string {
  const redacted = options.normalize(redactTextForPersistence(options.value));
  return redacted.length <= options.maxLength
    ? redacted
    : truncateTextForPersistence(redacted, options.maxLength);
}

function redactSessionGoalCompletionEvidenceForPersistence(
  evidence: SessionGoalCompletionEvidence,
): SessionGoalCompletionEvidence {
  const redactedEvidence: SessionGoalCompletionEvidence = (() => {
    switch (evidence.kind) {
      case "command":
        return {
          kind: "command",
          command: redactBoundedGoalTextForPersistence({
            value: evidence.command,
            normalize: normalizeSessionGoalCompletionCommand,
            maxLength: SESSION_GOAL_COMPLETION_CRITERION_MAX_LENGTH,
            emptyError: "Error: /goal completion evidence command is empty.",
            lengthError: `Error: /goal completion evidence command must be ${SESSION_GOAL_COMPLETION_CRITERION_MAX_LENGTH} characters or fewer.`,
          }),
          cwd: redactBoundedGoalTextForPersistence({
            value: evidence.cwd,
            normalize: (value) => value.trim(),
            maxLength: SESSION_GOAL_OBJECTIVE_MAX_LENGTH,
            emptyError: "Error: /goal completion evidence cwd is empty.",
            lengthError: `Error: /goal completion evidence cwd must be ${SESSION_GOAL_OBJECTIVE_MAX_LENGTH} characters or fewer.`,
          }),
          exitCode: 0,
          freshness: "at_completion",
        };
      case "assertion_evaluator":
        return {
          kind: "assertion_evaluator",
          reason: redactBoundedGoalTextForPersistence({
            value: evidence.reason,
            normalize: normalizeSessionGoalCompletionEvidenceReason,
            maxLength: SESSION_GOAL_COMPLETION_EVIDENCE_REASON_MAX_LENGTH,
            emptyError: "Error: /goal completion evidence reason is empty.",
            lengthError: `Error: /goal completion evidence reason must be ${SESSION_GOAL_COMPLETION_EVIDENCE_REASON_MAX_LENGTH} characters or fewer.`,
          }),
        };
      case "user_override":
        return { kind: "user_override" };
    }
  })();
  return normalizeSessionGoalCompletionEvidence(redactedEvidence);
}

function requireSessionGoalCompletionEvidenceForPersistence(
  evidence: SessionGoalCompletionEvidence | undefined,
): SessionGoalCompletionEvidence {
  if (evidence === undefined) {
    sessionStoreError("Error: /goal completed status requires evidence.");
  }
  return evidence;
}

function redactSessionGoalRuntimeOutcomeForPersistence(
  outcome: SessionGoalRuntimeOutcome,
): SessionGoalRuntimeOutcome {
  const reason = normalizeSessionGoalRuntimeOutcomeReason(outcome.reason);
  if (reason === "") {
    sessionStoreError("Error: /goal runtime outcome requires a reason.");
  }
  if (reason.length > SESSION_GOAL_RUNTIME_OUTCOME_REASON_MAX_LENGTH) {
    sessionStoreError(
      `Error: /goal runtime outcome reason must be ${SESSION_GOAL_RUNTIME_OUTCOME_REASON_MAX_LENGTH} characters or fewer.`,
    );
  }
  return normalizeSessionGoalRuntimeOutcome({
    kind: outcome.kind,
    reason: redactValidatedBoundedGoalTextForPersistence({
      value: reason,
      normalize: normalizeSessionGoalRuntimeOutcomeReason,
      maxLength: SESSION_GOAL_RUNTIME_OUTCOME_REASON_MAX_LENGTH,
    }),
    ...(outcome.observedEvidenceFingerprints === undefined
      ? {}
      : {
          observedEvidenceFingerprints: [
            ...outcome.observedEvidenceFingerprints,
          ],
        }),
  });
}

function sessionGoalRecordForPersistence(goal: SessionGoal): SessionGoalRecord {
  const accounting = sessionGoalAccounting(goal);
  const objective = redactBoundedGoalTextForPersistence({
    value: goal.objective,
    normalize: normalizeSessionGoalObjective,
    maxLength: SESSION_GOAL_OBJECTIVE_MAX_LENGTH,
    emptyError: "Error: /goal requires non-empty text.",
    lengthError: `Error: /goal objective must be ${SESSION_GOAL_OBJECTIVE_MAX_LENGTH} characters or fewer.`,
  });
  const completionCriterion =
    goal.completion === undefined
      ? undefined
      : goal.completion.kind === "command"
        ? redactBoundedGoalTextForPersistence({
            value: goal.completion.command,
            normalize: normalizeSessionGoalCompletionCommand,
            maxLength: SESSION_GOAL_COMPLETION_CRITERION_MAX_LENGTH,
            emptyError: "Error: /goal completion criterion requires text.",
            lengthError: `Error: /goal completion criterion must be ${SESSION_GOAL_COMPLETION_CRITERION_MAX_LENGTH} characters or fewer.`,
          })
        : redactBoundedGoalTextForPersistence({
            value: goal.completion.assertion,
            normalize: normalizeSessionGoalCompletionCriterion,
            maxLength: SESSION_GOAL_COMPLETION_CRITERION_MAX_LENGTH,
            emptyError: "Error: /goal completion criterion requires text.",
            lengthError: `Error: /goal completion criterion must be ${SESSION_GOAL_COMPLETION_CRITERION_MAX_LENGTH} characters or fewer.`,
          });
  const statusReason =
    goal.status === "blocked" ||
    goal.status === "budget_limited" ||
    goal.status === "usage_limited"
      ? redactBoundedGoalTextForPersistence({
          value: goal.statusReason,
          normalize: normalizeSessionGoalStatusReason,
          maxLength: SESSION_GOAL_STATUS_REASON_MAX_LENGTH,
          emptyError:
            "Error: /goal blocked or limited status requires a reason.",
          lengthError: `Error: /goal blocked or limited reason must be ${SESSION_GOAL_STATUS_REASON_MAX_LENGTH} characters or fewer.`,
        })
      : undefined;
  const blockedAuditReason =
    goal.status !== "active" || goal.blockedAudit === undefined
      ? undefined
      : redactBoundedGoalTextForPersistence({
          value: goal.blockedAudit.reason,
          normalize: normalizeSessionGoalStatusReason,
          maxLength: SESSION_GOAL_STATUS_REASON_MAX_LENGTH,
          emptyError: "Error: /goal blocked audit requires a reason.",
          lengthError: `Error: /goal blocked audit reason must be ${SESSION_GOAL_STATUS_REASON_MAX_LENGTH} characters or fewer.`,
        });
  const completionEvidence =
    goal.status === "completed"
      ? redactSessionGoalCompletionEvidenceForPersistence(
          requireSessionGoalCompletionEvidenceForPersistence(
            goal.completionEvidence,
          ),
        )
      : undefined;
  const runtimeOutcome =
    goal.latestRuntimeOutcome === undefined
      ? {}
      : {
          latestRuntimeOutcome: (() => {
            const outcome = redactSessionGoalRuntimeOutcomeForPersistence(
              goal.latestRuntimeOutcome,
            );
            return {
              kind: outcome.kind,
              reason: outcome.reason,
              ...(outcome.observedEvidenceFingerprints === undefined
                ? {}
                : {
                    observedEvidenceFingerprints: [
                      ...outcome.observedEvidenceFingerprints,
                    ],
                  }),
            };
          })(),
        };
  const criterion =
    goal.completion === undefined || completionCriterion === undefined
      ? {}
      : goal.completion.kind === "command"
        ? {
            criterionKind: "command" as const,
            completionCriterion,
            ...(goal.completion.verificationTimeoutMs !== undefined
              ? {
                  verificationTimeoutMs: goal.completion.verificationTimeoutMs,
                }
              : {}),
          }
        : {
            criterionKind: "assertion" as const,
            completionCriterion,
          };
  switch (goal.status) {
    case "active":
      return {
        objective,
        status: "active",
        ...accounting,
        ...criterion,
        ...runtimeOutcome,
        ...(goal.blockedAudit !== undefined && blockedAuditReason !== undefined
          ? {
              blockedAudit: {
                consecutiveCount: goal.blockedAudit.consecutiveCount,
                reason: blockedAuditReason,
              },
            }
          : {}),
      };
    case "blocked":
      return {
        objective,
        status: "blocked",
        ...accounting,
        statusReason: z.string().parse(statusReason),
        ...criterion,
        ...runtimeOutcome,
      };
    case "budget_limited":
      return {
        objective,
        status: "budget_limited",
        ...accounting,
        statusReason: z.string().parse(statusReason),
        ...criterion,
        ...runtimeOutcome,
      };
    case "usage_limited":
      return {
        objective,
        status: "usage_limited",
        ...accounting,
        statusReason: z.string().parse(statusReason),
        ...criterion,
        ...runtimeOutcome,
      };
    case "paused":
      return {
        objective,
        status: "paused",
        ...accounting,
        ...criterion,
        ...runtimeOutcome,
      };
    case "completed":
      return {
        objective,
        status: "completed",
        ...accounting,
        ...criterion,
        ...runtimeOutcome,
        completionEvidence:
          requireSessionGoalCompletionEvidenceForPersistence(
            completionEvidence,
          ),
      };
  }
}

function redactSessionGoalForPersistence(goal: SessionGoal): SessionGoal {
  const redactedGoal = sessionGoalSchema.safeParse(
    sessionGoalRecordForPersistence(goal),
  );
  if (!redactedGoal.success) {
    sessionStoreError(
      "Error: session goal is invalid after persistence redaction.",
    );
  }
  return redactedGoal.data;
}

function serializeSessionGoalForPersistence(
  goal: SessionGoal,
): SessionGoalRecord {
  return sessionGoalRecordForPersistence(goal);
}

function redactSessionTaskProgressCheckpointForPersistence(
  checkpoint: SessionTaskProgressCheckpoint,
): SessionTaskProgressCheckpoint {
  return {
    messageOrdinal: checkpoint.messageOrdinal,
    taskProgress: redactSessionTaskProgressForPersistence(
      checkpoint.taskProgress,
    ),
  };
}

function toSessionTaskProgressCheckpoint(
  checkpoint: RawSessionTaskProgressCheckpoint,
): SessionTaskProgressCheckpoint {
  return redactSessionTaskProgressCheckpointForPersistence({
    messageOrdinal: checkpoint.messageOrdinal,
    taskProgress: checkpoint.taskProgress,
  });
}

function toSessionQueuedInput(
  input: RawSessionQueuedInput,
): SessionQueuedInput {
  return {
    id: input.id,
    timestamp: input.timestamp,
    sequence: input.sequence,
    line: redactTextForPersistence(input.line),
  };
}

function copyBashApprovalGrant(grant: BashApprovalGrant): BashApprovalGrant {
  switch (grant.type) {
    case "exact":
      return {
        type: "exact",
        cwd: grant.cwd,
        command: grant.command,
      };
    case "prefix":
      return {
        type: "prefix",
        cwd: grant.cwd,
        argvPrefix: [...grant.argvPrefix],
      };
    case "command_family":
      return {
        type: "command_family",
        cwd: grant.cwd,
        commandFamily: grant.commandFamily,
      };
  }
}

function redactBashApprovalGrantForPersistence(
  grant: BashApprovalGrant,
): BashApprovalGrant {
  switch (grant.type) {
    case "exact":
      return {
        type: "exact",
        cwd: grant.cwd,
        command: redactTextForPersistence(grant.command),
      };
    case "prefix":
      return {
        type: "prefix",
        cwd: grant.cwd,
        argvPrefix: grant.argvPrefix.map(redactTextForPersistence),
      };
    case "command_family":
      return {
        type: "command_family",
        cwd: grant.cwd,
        commandFamily: grant.commandFamily,
      };
  }
}

function bashApprovalGrantHasRedactionMarker(
  grant: BashApprovalGrant,
): boolean {
  switch (grant.type) {
    case "exact":
      return hasPersistenceRedactionMarker(grant.command);
    case "prefix":
      return grant.argvPrefix.some(hasPersistenceRedactionMarker);
    case "command_family":
      return false;
  }
}

function redactSessionQueuedInputForPersistence(
  input: SessionQueuedInput,
): SessionQueuedInput {
  return {
    id: input.id,
    timestamp: input.timestamp,
    sequence: input.sequence,
    line: redactTextForPersistence(input.line),
  };
}

function toBashApprovalGrant(grant: RawBashApprovalGrant): BashApprovalGrant {
  return redactBashApprovalGrantForPersistence(grant);
}

function toSessionMutationRecord(
  record: RawSessionMutationRecord,
): SessionMutationRecord {
  switch (record.type) {
    case "append":
      return appendConsumedInputIds(
        {
          schemaVersion: SESSION_SCHEMA_VERSION,
          type: "append",
          timestamp: record.timestamp,
          reason: "turn",
          messages: record.messages.map(toStoredMessage),
          ...(record.skillState !== undefined
            ? {
                skillState: {
                  skillActivations:
                    record.skillState.skillActivations.map(toSkillActivation),
                  activeSkillIds: [...record.skillState.activeSkillIds],
                },
              }
            : {}),
        },
        record.consumedInputIds,
      );
    case "replace":
      return appendConsumedInputIds(
        {
          schemaVersion: SESSION_SCHEMA_VERSION,
          type: "replace",
          timestamp: record.timestamp,
          reason: record.reason,
          messages: record.messages.map(toStoredMessage),
          ...(record.skillState !== undefined
            ? {
                skillState: {
                  skillActivations:
                    record.skillState.skillActivations.map(toSkillActivation),
                  activeSkillIds: [...record.skillState.activeSkillIds],
                },
              }
            : {}),
        },
        record.consumedInputIds,
      );
    case "model_switch":
      return appendConsumedInputIds(
        {
          schemaVersion: SESSION_SCHEMA_VERSION,
          type: "model_switch",
          timestamp: record.timestamp,
          from:
            record.from === null ? null : toSessionModelSelection(record.from),
          to: toSessionModelSelection(record.to),
        },
        record.consumedInputIds,
      );
    case "session_title":
      return appendConsumedInputIds(
        {
          schemaVersion: SESSION_SCHEMA_VERSION,
          type: "session_title",
          timestamp: record.timestamp,
          title: normalizeSessionTitleForPersistence(record.title),
        },
        record.consumedInputIds,
      );
    case "session_goal":
      return appendConsumedInputIds(
        {
          schemaVersion: SESSION_SCHEMA_VERSION,
          type: "session_goal",
          timestamp: record.timestamp,
          goal: record.goal === null ? null : toSessionGoal(record.goal),
        },
        record.consumedInputIds,
      );
    case "task_progress":
      return {
        schemaVersion: SESSION_SCHEMA_VERSION,
        type: "task_progress",
        timestamp: record.timestamp,
        messageOrdinal: record.messageOrdinal,
        tasks: record.tasks.map((task) => ({
          step: redactTextForPersistence(task.step),
          status: task.status,
        })),
      };
    case "input_admitted":
      return {
        schemaVersion: SESSION_SCHEMA_VERSION,
        type: "input_admitted",
        timestamp: record.timestamp,
        id: record.id,
        sequence: record.sequence,
        line: record.line,
      };
    case "input_consumed":
      return {
        schemaVersion: SESSION_SCHEMA_VERSION,
        type: "input_consumed",
        timestamp: record.timestamp,
        inputIds: [...record.inputIds],
      };
    case "bash_approval_granted":
      return {
        schemaVersion: SESSION_SCHEMA_VERSION,
        type: "bash_approval_granted",
        timestamp: record.timestamp,
        grant: toBashApprovalGrant(record.grant),
      };
    case "bash_approval_revoked":
      return appendConsumedInputIds(
        {
          schemaVersion: SESSION_SCHEMA_VERSION,
          type: "bash_approval_revoked",
          timestamp: record.timestamp,
          grant: toBashApprovalGrant(record.grant),
        },
        record.consumedInputIds,
      );
    case "bash_approvals_cleared":
      return appendConsumedInputIds(
        {
          schemaVersion: SESSION_SCHEMA_VERSION,
          type: "bash_approvals_cleared",
          timestamp: record.timestamp,
        },
        record.consumedInputIds,
      );
    case "task_admitted":
      return {
        schemaVersion: SESSION_SCHEMA_VERSION,
        type: "task_admitted",
        timestamp: record.timestamp,
        task: toProviderReadySessionTask(record.task),
        userMessage: toStoredMessage(record.userMessage),
        ...(record.consumedInputIds === undefined
          ? {}
          : { consumedInputIds: [...record.consumedInputIds] }),
      };
    case "provider_intent":
      return {
        schemaVersion: SESSION_SCHEMA_VERSION,
        type: "provider_intent",
        timestamp: record.timestamp,
        task: toProviderPendingSessionTask(record.task),
      };
    case "provider_attempt_settled":
      return {
        schemaVersion: SESSION_SCHEMA_VERSION,
        type: "provider_attempt_settled",
        timestamp: record.timestamp,
        task: toProviderAttemptSettledSessionTask(record.task),
      };
    case "provider_settled":
      return {
        schemaVersion: SESSION_SCHEMA_VERSION,
        type: "provider_settled",
        timestamp: record.timestamp,
        task: toProviderSettledSessionTask(record.task),
      };
    case "tool_intent":
      return {
        schemaVersion: SESSION_SCHEMA_VERSION,
        type: "tool_intent",
        timestamp: record.timestamp,
        task: toToolExecutionSessionTask(record.task),
        operationIds: [...record.operationIds],
      };
    case "effect_reconciled":
      return {
        schemaVersion: SESSION_SCHEMA_VERSION,
        type: "effect_reconciled",
        timestamp: record.timestamp,
        task: toToolExecutionSessionTask(record.task),
        operationId: record.operationId,
        reconciliation: structuredClone(record.reconciliation),
      };
    case "tool_settled":
      return {
        schemaVersion: SESSION_SCHEMA_VERSION,
        type: "tool_settled",
        timestamp: record.timestamp,
        task: toToolExecutionSessionTask(record.task),
        operationId: record.operationId,
      };
    case "task_recovery_disposition":
      return {
        schemaVersion: SESSION_SCHEMA_VERSION,
        type: "task_recovery_disposition",
        timestamp: record.timestamp,
        task: toToolExecutionSessionTask(record.task),
        disposition: {
          kind: "accept_unknown",
          operationIds: [...record.disposition.operationIds],
        },
      };
    case "task_recovery_started": {
      return {
        schemaVersion: SESSION_SCHEMA_VERSION,
        type: "task_recovery_started",
        timestamp: record.timestamp,
        task: toRecoverySessionTask(record.task),
      };
    }
    case "step_committed":
      return appendConsumedInputIds(
        {
          schemaVersion: SESSION_SCHEMA_VERSION,
          type: "step_committed",
          timestamp: record.timestamp,
          task: toRecoverySessionTask(record.task),
          messages: record.messages.map(toStoredMessage),
          ...(record.replaceTranscript === true
            ? { replaceTranscript: true as const }
            : {}),
        },
        record.consumedInputIds,
      );
    case "task_terminal":
      return appendConsumedInputIds(
        {
          schemaVersion: SESSION_SCHEMA_VERSION,
          type: "task_terminal",
          timestamp: record.timestamp,
          taskId: record.taskId,
          runId: record.runId,
          messages: record.messages.map(toStoredMessage),
          ...(record.replaceTranscript === true
            ? { replaceTranscript: true as const }
            : {}),
          lastTaskOutcome: toSessionLastTaskOutcome(record.lastTaskOutcome),
          ...(record.skillState === undefined
            ? {}
            : {
                skillState: {
                  skillActivations:
                    record.skillState.skillActivations.map(toSkillActivation),
                  activeSkillIds: [...record.skillState.activeSkillIds],
                },
              }),
        },
        record.consumedInputIds,
      );
    case "skill_state":
      return appendConsumedInputIds(
        {
          schemaVersion: SESSION_SCHEMA_VERSION,
          type: "skill_state",
          timestamp: record.timestamp,
          messageOrdinal: record.messageOrdinal,
          skillActivations: record.skillActivations.map(toSkillActivation),
          activeSkillIds: [...record.activeSkillIds],
        },
        record.consumedInputIds,
      );
    case "snapshot":
      return {
        schemaVersion: SESSION_SCHEMA_VERSION,
        type: "snapshot",
        timestamp: record.timestamp,
        reason: "size_threshold",
        ...(record.title !== undefined
          ? { title: normalizeSessionTitleForPersistence(record.title) }
          : {}),
        ...(record.goal !== undefined
          ? { goal: toSessionGoal(record.goal) }
          : {}),
        messages: record.messages.map(toStoredMessage),
        pendingInputs: record.pendingInputs.map(toSessionQueuedInput),
        ...(record.bashApprovalGrants !== undefined
          ? {
              bashApprovalGrants:
                record.bashApprovalGrants.map(toBashApprovalGrant),
            }
          : {}),
        ...(record.activeModel !== undefined
          ? { activeModel: toSessionModelSelection(record.activeModel) }
          : {}),
        ...(record.modelSwitches !== undefined
          ? { modelSwitches: record.modelSwitches.map(toSessionModelSwitch) }
          : {}),
        ...(record.taskProgressCheckpoints !== undefined
          ? {
              taskProgressCheckpoints: record.taskProgressCheckpoints.map(
                toSessionTaskProgressCheckpoint,
              ),
            }
          : {}),
        skillStateCheckpoints: record.skillStateCheckpoints.map(
          toSessionSkillStateCheckpoint,
        ),
        ...(record.activeTask === undefined
          ? {}
          : { activeTask: toActiveSessionTask(record.activeTask) }),
        ...(record.lastTaskOutcome === undefined
          ? {}
          : {
              lastTaskOutcome: toSessionLastTaskOutcome(record.lastTaskOutcome),
            }),
      };
  }
}

function validSkillLifecycleFields(state: {
  readonly skillActivations: readonly SkillActivation[];
  readonly activeSkillIds: readonly string[];
}): boolean {
  const activeIds = new Set<string>();
  const activePackages = new Set<string>();
  for (const id of state.activeSkillIds) {
    if (activeIds.has(id)) return false;
    activeIds.add(id);
    const activation = state.skillActivations.findLast(
      (candidate) => candidate.descriptorId === id,
    );
    if (activation === undefined || activePackages.has(activation.packageId)) {
      return false;
    }
    activePackages.add(activation.packageId);
  }
  return true;
}

function validSessionSkillState(record: SessionMutationRecord): boolean {
  if (
    (record.type === "append" || record.type === "replace") &&
    record.skillState !== undefined
  ) {
    return validSkillLifecycleFields(record.skillState);
  }
  if (record.type === "skill_state") {
    return validSkillLifecycleFields(record);
  }
  if (record.type === "task_terminal" && record.skillState !== undefined) {
    return validSkillLifecycleFields(record.skillState);
  }
  if (record.type === "snapshot") {
    return record.skillStateCheckpoints.every(validSkillLifecycleFields);
  }
  return true;
}

function parseSessionJsonLine(
  filePath: string,
  line: string,
  lineNumber: number,
): unknown {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    sessionStoreError(
      `Error: cannot load session ledger ${filePath}: line ${lineNumber} is not valid JSON.`,
    );
  }

  const versionProbe = schemaVersionProbeSchema.safeParse(raw);
  if (
    versionProbe.success &&
    versionProbe.data.schemaVersion !== SESSION_SCHEMA_VERSION
  ) {
    sessionStoreError(
      `Error: cannot load session ledger ${filePath}: unsupported session schema version ${versionProbe.data.schemaVersion}.`,
    );
  }
  return raw;
}

function parseSessionHeaderRecord(
  filePath: string,
  line: string,
  lineNumber: number,
): SessionHeaderRecord {
  const raw = parseSessionJsonLine(filePath, line, lineNumber);
  const parsed = sessionHeaderSchema.safeParse(raw);
  if (!parsed.success) {
    sessionStoreError(
      `Error: cannot load session ledger ${filePath}: line ${lineNumber} is not a valid session header.`,
    );
  }
  return toSessionHeaderRecord(parsed.data);
}

function parseSessionMutationRecord(
  filePath: string,
  line: string,
  lineNumber: number,
): SessionMutationRecord {
  const raw = parseSessionJsonLine(filePath, line, lineNumber);
  const parsed = sessionMutationRecordSchema.safeParse(raw);
  if (!parsed.success) {
    sessionStoreError(
      `Error: cannot load session ledger ${filePath}: line ${lineNumber} is not a valid session mutation record.`,
    );
  }
  const record = toSessionMutationRecord(parsed.data);
  if (!validSessionSkillState(record)) {
    sessionStoreError(
      `Error: cannot load session ledger ${filePath}: line ${lineNumber} is not a valid session mutation record.`,
    );
  }
  return record;
}

function parseSnapshotSessionMutationRecord(
  line: string,
): SnapshotSessionRecord | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }

  const parsed = sessionMutationRecordSchema.safeParse(raw);
  if (!parsed.success) {
    return null;
  }
  const record = toSessionMutationRecord(parsed.data);
  if (!validSessionSkillState(record)) return null;
  return record.type === "snapshot" ? record : null;
}

function parseSessionMessages(
  sessionId: string,
  messages: readonly SessionMessage[],
  action: "persist" | "fork",
): readonly PersistedSessionMessage[] {
  const parsed = z.array(messageSchema).safeParse(messages);
  if (!parsed.success) {
    sessionStoreError(
      `Error: cannot ${action} session "${sessionId}": ledger contains invalid session messages.`,
    );
  }
  return parsed.data.map(toMessage);
}

function validateCompletedTranscript(
  sessionId: string,
  messages: readonly SessionMessage[],
  action: "persist" | "resume" | "fork",
): void {
  const errorPrefix = `Error: cannot ${action} session "${sessionId}":`;
  const pendingToolCallIds = new Set<string>();
  const subagentDeliveryIds = new Set<string>();
  for (const message of messages) {
    if (pendingToolCallIds.size > 0 && message.role !== "tool") {
      sessionStoreError(
        `${errorPrefix} ledger contains incomplete tool calls.`,
      );
    }

    switch (message.role) {
      case "user":
        if (message.subagentResultDelivery !== undefined) {
          const deliveryId = message.subagentResultDelivery.delegationId;
          if (subagentDeliveryIds.has(deliveryId)) {
            sessionStoreError(
              `${errorPrefix} ledger contains duplicate subagent result delivery ${JSON.stringify(deliveryId)}.`,
            );
          }
          subagentDeliveryIds.add(deliveryId);
        }
        break;
      case "assistant":
        for (const toolCall of message.toolCalls) {
          if (pendingToolCallIds.has(toolCall.id)) {
            sessionStoreError(
              `${errorPrefix} ledger contains duplicate pending tool call "${toolCall.id}".`,
            );
          }
          pendingToolCallIds.add(toolCall.id);
        }
        break;
      case "tool":
        if (!pendingToolCallIds.delete(message.toolCallId)) {
          sessionStoreError(
            `${errorPrefix} ledger contains a tool result without a pending tool call.`,
          );
        }
        break;
    }
  }

  if (pendingToolCallIds.size > 0) {
    sessionStoreError(`${errorPrefix} ledger contains incomplete tool calls.`);
  }
}

export {
  bashApprovalGrantHasRedactionMarker,
  copyActiveSessionTask,
  copyBashApprovalGrant,
  copyMessage,
  copySessionForkPointRecord,
  copySessionGraphRecord,
  copySessionLastTaskOutcome,
  copySkillActivation,
  copyStoredMessage,
  messagesFromStoredMessages,
  normalizeSessionTitleForPersistence,
  parseSessionHeaderRecord,
  parseSessionMessages,
  parseSessionMutationRecord,
  parseSnapshotSessionMutationRecord,
  redactBashApprovalGrantForPersistence,
  redactSessionGoalForPersistence,
  redactSessionQueuedInputForPersistence,
  redactSessionSkillStateCheckpointForPersistence,
  redactSessionTaskProgressCheckpointForPersistence,
  redactSessionTaskProgressForPersistence,
  redactSessionToolContinuationEffectsForPersistence,
  redactSkillActivationForPersistence,
  redactStoredMessageForPersistence,
  serializeSessionGoalForPersistence,
  validateCompletedTranscript,
};
