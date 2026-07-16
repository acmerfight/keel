import { z } from "zod";

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
  reason: z.string(),
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
  reason: z.string(),
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
    outcome: z.enum(["terminal_error", "aborted"]),
  }),
]);

const modelOperationBase = {
  ordinal: z.number().int().positive(),
  owner: z.discriminatedUnion("type", [
    z.object({
      type: z.literal("agent_run"),
      taskOrdinal: z.number().int().positive(),
      agentRunOrdinal: z.number().int().positive(),
    }),
    z.object({ type: z.literal("session") }),
    z.object({ type: z.literal("invocation") }),
  ]),
  purpose: z.enum([
    "agent_turn",
    "turn_limit_summary",
    "context_compaction",
    "goal_assertion_evaluation",
    "manual_compaction",
    "model_switch_compaction",
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

const modelOperationSchema = z.object(modelOperationBase);

const runReportMemorySchema = z
  .object({
    enabled: z.boolean(),
    scope: z
      .object({
        kind: z.literal("project"),
        id: z.string(),
      })
      .nullable(),
    loadedIds: z.array(z.string()),
    loadedEntries: z.array(
      z.object({
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
            channel: z.literal("cli"),
            candidateId: z.string().regex(/^cand_[0-9a-f-]+$/u),
          }),
        ]),
        createdAt: z.string(),
        lastVerifiedAt: z.string(),
        supersedes: z.array(z.string()),
        supersededBy: z.null(),
        reviewAfter: z.string().nullable(),
        expiresAt: z.string().nullable(),
      }),
    ),
    renderedBytes: z.number().int().nonnegative(),
    estimatedTokens: z.number().int().nonnegative().optional(),
    operations: z.array(
      z.discriminatedUnion("operation", [
        z.object({
          operation: z.literal("add"),
          id: z.string(),
          scope: z.object({ kind: z.literal("project"), id: z.string() }),
          outcome: z.literal("saved"),
        }),
        z.object({
          operation: z.literal("forget"),
          id: z.string(),
          scope: z.object({ kind: z.literal("project"), id: z.string() }),
          outcome: z.literal("forgotten"),
        }),
      ]),
    ),
    error: z.string().optional(),
  })
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

export const runReportSchema = z.object({
  schemaVersion: z.literal(16),
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
  goalOutcome: z
    .object({
      sessionId: z.string(),
      status: z.enum([
        "blocked",
        "budget_limited",
        "usage_limited",
        "completed",
      ]),
      reason: z.string(),
      evidenceKind: z
        .enum(["command", "assertion_evaluator", "user_override"])
        .optional(),
    })
    .optional(),
});

export type RunReport = z.infer<typeof runReportSchema>;
