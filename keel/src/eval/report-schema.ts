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

export const runReportSchema = z.object({
  schemaVersion: z.literal(5),
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
      turns: z.number().int().nonnegative(),
      usage: usageSchema,
      costUsd: z.number().nonnegative(),
    }),
  ),
  turns: z.number().int().nonnegative(),
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
      trigger: z.literal("model_selected"),
    }),
  ),
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
