import { z } from "zod";
import {
  keelErrorCodes,
  providerRequestTerminalErrorCodes,
} from "../core/error.ts";
import { reasoningEfforts } from "../core/model-metadata.ts";

// Mirrors the CLI --report payload. The eval runner and comparator consume the
// same report file a user would, so bump this together with CLI report output.
const usageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative(),
  uncachedInputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
});

const compactionArtifactSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("stored"),
    ref: z.string(),
    toolCallId: z.string(),
    toolName: z.string(),
    sourceStatus: z.enum(["complete", "source-truncated"]),
    omittedChars: z.number().int().nonnegative(),
  }),
  z.object({
    status: z.literal("reused"),
    ref: z.string(),
    toolCallId: z.string(),
    toolName: z.string(),
    sourceStatus: z.enum(["complete", "source-truncated"]),
    omittedChars: z.number().int().nonnegative(),
  }),
  z.object({
    status: z.literal("failed"),
    reason: z.string(),
    toolCallId: z.string(),
    toolName: z.string(),
    sourceStatus: z.enum(["complete", "source-truncated"]),
    omittedChars: z.number().int().nonnegative(),
  }),
]);

const contextCompactionSchema = z.object({
  reason: z.enum(["proactive", "preflight", "overflow_recovery"]),
  providerRequestAction: z.enum([
    "compacted_before_request",
    "avoided_predictable_overflow_request",
    "retried_after_context_overflow",
  ]),
  scopes: z.array(
    z.enum(["history", "stale_tool_output", "current_tool_output_round"]),
  ),
  beforeMessageCount: z.number().int().nonnegative(),
  afterMessageCount: z.number().int().nonnegative(),
  beforeEstimatedTokens: z.number().int().nonnegative(),
  afterEstimatedTokens: z.number().int().nonnegative(),
  toolOutputsCompacted: z.number().int().nonnegative(),
  staleToolOutputsCompacted: z.number().int().nonnegative(),
  currentToolOutputsCompacted: z.number().int().nonnegative(),
  toolOutputCharsBefore: z.number().int().nonnegative(),
  toolOutputCharsAfter: z.number().int().nonnegative(),
  toolOutputEstimatedTokensBefore: z.number().int().nonnegative(),
  toolOutputEstimatedTokensAfter: z.number().int().nonnegative(),
  artifacts: z.array(compactionArtifactSchema),
});

const providerRetrySchema = z.object({
  provider: z.string(),
  reason: z.enum(keelErrorCodes),
  attempt: z.number().int().nonnegative(),
  maxRetries: z.number().int().nonnegative(),
  delayMs: z.number().nonnegative(),
});

const agentRunSchema = z.object({
  ordinal: z.number().int().positive(),
  trigger: z.enum([
    "user_prompt",
    "goal_activation",
    "goal_resume",
    "goal_continuation",
  ]),
  humanInterventionCount: z.number().int().nonnegative(),
  agentLoopTurns: z.number().int().nonnegative(),
  providerRetries: z.array(providerRetrySchema),
  contextCompactions: z.array(contextCompactionSchema),
  stopReason: z.string(),
});

const taskSchema = z.object({
  ordinal: z.number().int().positive(),
  trigger: z.enum(["user_prompt", "goal_activation", "goal_resume"]),
  humanInterventionCount: z.number().int().nonnegative(),
  agentRuns: z.array(agentRunSchema).min(1),
  outcome: z.string(),
});

const retryDecisionSchema = z.object({
  provider: z.string(),
  reason: z.enum(keelErrorCodes),
  attempt: z.number().int().positive(),
  maxRetries: z.number().int().nonnegative(),
  delayMs: z.number().nonnegative(),
});

const providerRequestAttemptBase = {
  ordinal: z.number().int().positive(),
};

const providerRequestAttemptSchema = z.discriminatedUnion("outcome", [
  z.object({
    ...providerRequestAttemptBase,
    outcome: z.literal("completed"),
    usage: usageSchema,
    costUsd: z.number().nonnegative(),
  }),
  z.object({
    ...providerRequestAttemptBase,
    outcome: z.literal("retryable_error"),
    retryDecision: retryDecisionSchema,
  }),
  z.object({
    ...providerRequestAttemptBase,
    outcome: z.literal("context_overflow"),
    recoveryOperationOrdinal: z.number().int().positive().nullable(),
  }),
  z.object({
    ...providerRequestAttemptBase,
    outcome: z.literal("terminal_error"),
    errorCode: z.enum(providerRequestTerminalErrorCodes),
  }),
  z.object({
    ...providerRequestAttemptBase,
    outcome: z.literal("aborted"),
  }),
]);

const modelOperationAttributionSchema = z.object({
  type: z.literal("subagent"),
  delegationId: z.string(),
  childRunId: z.string(),
  profile: z.string().min(1),
  effort: z.enum(reasoningEfforts).nullable(),
});

const modelOperationBase = {
  ordinal: z.number().int().positive(),
  owner: z.discriminatedUnion("type", [
    z.object({
      type: z.literal("agent_run"),
      taskOrdinal: z.number().int().positive(),
      agentRunOrdinal: z.number().int().positive(),
    }),
    z.object({ type: z.literal("session") }),
  ]),
  provider: z.string(),
  model: z.string(),
  providerRequestAttempts: z.array(providerRequestAttemptSchema),
  outcome: z.enum([
    "completed",
    "context_overflow",
    "terminal_error",
    "aborted",
    "admission_rejected",
  ]),
  usage: usageSchema,
  costUsd: z.number().nonnegative(),
};

const modelOperationSchema = z.discriminatedUnion("purpose", [
  z.object({
    ...modelOperationBase,
    purpose: z.literal("subagent_turn"),
    attribution: modelOperationAttributionSchema,
  }),
  z.object({
    ...modelOperationBase,
    purpose: z.enum([
      "agent_turn",
      "goal_assertion_evaluation",
      "manual_compaction",
      "model_switch_compaction",
    ]),
    attribution: z.never().optional(),
  }),
  z.object({
    ...modelOperationBase,
    purpose: z.enum(["turn_limit_summary", "context_compaction"]),
    attribution: modelOperationAttributionSchema.optional(),
  }),
]);

const projectMemoryScopeSchema = z.object({
  kind: z.literal("project"),
  id: z.string(),
});

const runReportMemoryOperationSchema = z.union([
  z.object({
    operation: z.literal("add"),
    id: z.string(),
    scope: projectMemoryScopeSchema,
    outcome: z.literal("saved"),
  }),
  z.object({
    operation: z.literal("forget"),
    id: z.string(),
    scope: projectMemoryScopeSchema,
    outcome: z.literal("forgotten"),
  }),
  z.discriminatedUnion("outcome", [
    z.object({
      operation: z.literal("propose"),
      candidateId: z.string().regex(/^cand_[0-9a-f-]+$/u),
      memoryId: z.string().regex(/^mem_[0-9a-f-]+$/u),
      scope: projectMemoryScopeSchema,
      outcome: z.literal("approved"),
    }),
    z.object({
      operation: z.literal("propose"),
      candidateId: z.string().regex(/^cand_[0-9a-f-]+$/u),
      memoryId: z.null(),
      scope: projectMemoryScopeSchema,
      outcome: z.literal("rejected"),
    }),
    z.object({
      operation: z.literal("propose"),
      candidateId: z.string().regex(/^cand_[0-9a-f-]+$/u),
      memoryId: z.null(),
      scope: projectMemoryScopeSchema,
      outcome: z.literal("pending"),
    }),
  ]),
]);

const runReportMemoryEntrySchema = z.object({
  id: z.string(),
  status: z.enum(["current", "stale"]),
  source: z.discriminatedUnion("type", [
    z.object({
      type: z.literal("user_explicit"),
      channel: z.enum(["agent", "cli"]),
      candidateId: z.null(),
    }),
    z.object({
      type: z.literal("user_approved"),
      channel: z.enum(["cli", "interactive"]),
      candidateId: z.string().regex(/^cand_[0-9a-f-]+$/u),
    }),
  ]),
  createdAt: z.string(),
  lastVerifiedAt: z.string(),
  supersedes: z.array(z.string()),
  supersededBy: z.null(),
  reviewAfter: z.string().nullable(),
  expiresAt: z.string().nullable(),
});

const loadedMemoryReportShape = {
  loadedIds: z.array(z.string()),
  loadedEntries: z.array(runReportMemoryEntrySchema),
  renderedBytes: z.number().int().nonnegative(),
  estimatedTokens: z.number().int().nonnegative(),
  operations: z.array(runReportMemoryOperationSchema),
};

const runReportMemorySchema = z
  .discriminatedUnion("status", [
    z.object({
      status: z.literal("disabled"),
      scope: z.null(),
      loadedIds: z.tuple([]),
      loadedEntries: z.tuple([]),
      renderedBytes: z.literal(0),
      estimatedTokens: z.literal(0),
      operations: z.tuple([]),
      error: z.never().optional(),
    }),
    z.object({
      status: z.literal("available"),
      scope: projectMemoryScopeSchema,
      ...loadedMemoryReportShape,
      error: z.never().optional(),
    }),
    z.object({
      status: z.literal("error"),
      scope: projectMemoryScopeSchema.nullable(),
      ...loadedMemoryReportShape,
      error: z.string(),
    }),
  ])
  .superRefine((memory, ctx) => {
    const entryIds = memory.loadedEntries.map((entry) => entry.id);
    if (new Set(entryIds).size !== entryIds.length) {
      ctx.addIssue({
        code: "custom",
        path: ["loadedEntries"],
        message: "loaded memory entry IDs must be unique",
      });
    }
    if (
      memory.loadedIds.length !== entryIds.length ||
      memory.loadedIds.some((id, index) => id !== entryIds[index])
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["loadedIds"],
        message: "loadedIds must exactly match loadedEntries",
      });
    }
  });

const runReportGoalOutcomeSchema = z.discriminatedUnion("status", [
  z.object({
    sessionId: z.string(),
    status: z.literal("completed"),
    reason: z.string(),
    evidenceKind: z.enum(["command", "assertion_evaluator", "user_override"]),
  }),
  z.object({
    sessionId: z.string(),
    status: z.enum(["blocked", "budget_limited", "usage_limited"]),
    reason: z.string(),
    evidenceKind: z.never().optional(),
  }),
]);

const runReportBaseSchema = z.object({
  schemaVersion: z.literal(21),
  tasks: z.array(taskSchema),
  humanInterventionCount: z.number().int().nonnegative(),
  modelOperations: z.array(modelOperationSchema),
  modelOperationCount: z.number().int().nonnegative(),
  providerRequestAttemptCount: z.number().int().nonnegative(),
  modelsUsed: z.array(
    z.object({
      provider: z.string(),
      model: z.string(),
    }),
  ),
  usageByModel: z.array(
    z.object({
      provider: z.string(),
      model: z.string(),
      agentLoopTurns: z.number().int().nonnegative(),
      usage: usageSchema,
      costUsd: z.number().nonnegative(),
    }),
  ),
  agentLoopTurns: z.number().int().nonnegative(),
  stopReason: z.string(),
  usage: usageSchema,
  durationMs: z.number().nonnegative(),
  costUsd: z.number().nonnegative(),
  costBudgetUsd: z.number().positive().optional(),
  costOvershootUsd: z.number().nonnegative(),
  contextCompactions: z.array(contextCompactionSchema),
  skillActivations: z.array(
    z.object({
      name: z.string(),
      relativePath: z.string(),
      trigger: z.enum(["model_selected", "user_explicit"]),
    }),
  ),
  activeSkills: z.array(
    z.object({
      name: z.string(),
      digest: z.string(),
      trigger: z.enum(["model_selected", "user_explicit"]),
      diskStatus: z.enum(["current", "changed_on_disk", "missing_on_disk"]),
    }),
  ),
  skillCatalog: z.object({
    exposed: z.number().int().nonnegative(),
    omitted: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    budgetChars: z.number().int().nonnegative(),
    usedChars: z.number().int().nonnegative(),
  }),
  skillPolicy: z.object({
    mode: z.enum(["enabled", "cli_disabled", "globally_disabled", "filtered"]),
    disabledPackages: z.number().int().nonnegative(),
  }),
  undoProtection: z.object({
    status: z.enum(["available", "not_applicable", "unavailable"]),
    checkpointsWritten: z.number().int().nonnegative(),
    failures: z.array(
      z.object({
        reason: z.enum([
          "checkpoint_write_failed",
          "git_workspace_unavailable",
          "target_unavailable",
        ]),
        count: z.number().int().positive(),
      }),
    ),
    latestCheckpoint: z
      .discriminatedUnion("written", [
        z.object({ written: z.literal(true) }),
        z.object({
          written: z.literal(false),
          reason: z.enum([
            "checkpoint_write_failed",
            "git_workspace_unavailable",
            "target_unavailable",
          ]),
        }),
      ])
      .nullable(),
  }),
  memory: runReportMemorySchema,
  failure: z
    .object({
      category: z.enum([...keelErrorCodes, "unexpected_error"]),
      message: z.string().max(2_000),
      sessionId: z.string().optional(),
    })
    .optional(),
  goalOutcome: runReportGoalOutcomeSchema.optional(),
});

export const runReportSchema = runReportBaseSchema.superRefine(
  (report, context) => {
    if (report.stopReason === "failed" && report.failure === undefined) {
      context.addIssue({
        code: "custom",
        path: ["failure"],
        message: "failed report requires failure evidence",
      });
    }
    if (report.stopReason !== "failed" && report.failure !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["failure"],
        message: "failure evidence requires stopReason failed",
      });
    }
  },
);

export type RunReport = z.infer<typeof runReportSchema>;
