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
  agentLoopTurns: z.number().int().nonnegative(),
  providerRetries: z.array(providerRetrySchema),
  contextCompactions: z.array(contextCompactionSchema),
  stopReason: z.string(),
});

const taskSchema = z.object({
  ordinal: z.number().int().positive(),
  trigger: z.enum(["user_prompt", "goal_activation", "goal_resume"]),
  agentRuns: z.array(agentRunSchema).min(1),
  outcome: z.string(),
});

export const runReportSchema = z.object({
  schemaVersion: z.literal(10),
  tasks: z.array(taskSchema),
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
