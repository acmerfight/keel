import { z } from "zod";

export const PROJECT_MEMORY_SCHEMA_VERSION = 5;
export const MEMORY_ID_PATTERN = /^mem_[0-9a-f-]+$/u;
export const CANDIDATE_ID_PATTERN = /^cand_[0-9a-f-]+$/u;
const EXTRACTION_ID_PATTERN = /^mcex_[0-9a-f-]+$/u;

export const projectMemoryTimestampSchema = z.string().datetime({
  offset: true,
});

const usageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative(),
    cachedInputTokens: z.number().int().nonnegative(),
    uncachedInputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
  })
  .strict();

const projectMemorySourceSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("user_explicit"),
      channel: z.enum(["agent", "cli"]),
      evidence: z.string().min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal("user_approved"),
      channel: z.enum(["cli", "interactive"]),
      evidence: z.string().min(1),
      candidateId: z.string().regex(CANDIDATE_ID_PATTERN),
    })
    .strict(),
]);

const memoryRecordSchema = z
  .object({
    id: z.string().regex(MEMORY_ID_PATTERN),
    text: z.string().min(1),
    source: projectMemorySourceSchema,
    createdAt: projectMemoryTimestampSchema,
    lastVerifiedAt: projectMemoryTimestampSchema,
    supersedes: z.array(z.string().regex(MEMORY_ID_PATTERN)),
    reviewAfter: projectMemoryTimestampSchema.nullable(),
    expiresAt: projectMemoryTimestampSchema.nullable(),
  })
  .strict();

const addEventSchema = z
  .object({
    version: z.literal(PROJECT_MEMORY_SCHEMA_VERSION),
    type: z.literal("add"),
    memory: memoryRecordSchema,
  })
  .strict();

const forgetEventSchema = z
  .object({
    version: z.literal(PROJECT_MEMORY_SCHEMA_VERSION),
    type: z.literal("forget"),
    targetId: z.string().regex(MEMORY_ID_PATTERN),
    source: projectMemorySourceSchema,
    createdAt: projectMemoryTimestampSchema,
  })
  .strict();

const verifyEventSchema = z
  .object({
    version: z.literal(PROJECT_MEMORY_SCHEMA_VERSION),
    type: z.literal("verify"),
    targetId: z.string().regex(MEMORY_ID_PATTERN),
    source: projectMemorySourceSchema,
    createdAt: projectMemoryTimestampSchema,
  })
  .strict();

const extractionFailureSchema = z.enum([
  "already_extracted",
  "project_busy",
  "session_busy",
  "session_unavailable",
  "ineligible_session",
  "sensitive_evidence",
  "inbox_full",
  "budget_exceeded",
  "provider_configuration",
  "provider_error",
  "invalid_output",
  "output_limit",
  "forbidden_tool_call",
  "cancelled",
]);

const extractionOperationBase = {
  operationId: z.string().regex(EXTRACTION_ID_PATTERN),
  sessionId: z.string().min(1),
  trigger: z.literal("explicit_command"),
  extractorVersion: z.literal(1),
  maxCostUsd: z.number().finite().positive(),
  createdAt: projectMemoryTimestampSchema,
  finishedAt: projectMemoryTimestampSchema,
};

const succeededExtractionOperationSchema = z
  .object({
    ...extractionOperationBase,
    outcome: z.literal("succeeded"),
    providerId: z.enum(["fake", "deepseek", "kimi", "qwen"]),
    model: z.string().min(1),
    usage: usageSchema,
    costUsd: z.number().finite().nonnegative(),
    attemptCount: z.number().int().positive(),
    retryCount: z.number().int().nonnegative(),
    resultCount: z.number().int().min(0).max(5),
    failure: z.null(),
  })
  .strict();

const failedExtractionOperationSchema = z
  .object({
    ...extractionOperationBase,
    outcome: z.literal("failed"),
    providerId: z.enum(["fake", "deepseek", "kimi", "qwen"]).nullable(),
    model: z.string().min(1).nullable(),
    usage: usageSchema.nullable(),
    costUsd: z.number().finite().nonnegative().nullable(),
    attemptCount: z.number().int().nonnegative(),
    retryCount: z.number().int().nonnegative(),
    resultCount: z.literal(0),
    failure: extractionFailureSchema,
  })
  .strict();

const rejectedExtractionOperationSchema = z
  .object({
    ...extractionOperationBase,
    outcome: z.literal("admission_rejected"),
    providerId: z.enum(["fake", "deepseek", "kimi", "qwen"]).nullable(),
    model: z.string().min(1).nullable(),
    usage: z.null(),
    costUsd: z.null(),
    attemptCount: z.literal(0),
    retryCount: z.literal(0),
    resultCount: z.literal(0),
    failure: extractionFailureSchema,
  })
  .strict();

const cancelledExtractionOperationSchema = z
  .object({
    ...extractionOperationBase,
    outcome: z.literal("cancelled"),
    providerId: z.enum(["fake", "deepseek", "kimi", "qwen"]).nullable(),
    model: z.string().min(1).nullable(),
    usage: usageSchema.nullable(),
    costUsd: z.number().finite().nonnegative().nullable(),
    attemptCount: z.number().int().nonnegative(),
    retryCount: z.number().int().nonnegative(),
    resultCount: z.literal(0),
    failure: z.literal("cancelled"),
  })
  .strict();

const candidateExtractionOperationSchema = z.discriminatedUnion("outcome", [
  succeededExtractionOperationSchema,
  failedExtractionOperationSchema,
  rejectedExtractionOperationSchema,
  cancelledExtractionOperationSchema,
]);

const candidateKindSchema = z.enum([
  "user_preference",
  "feedback",
  "project_context",
  "reference",
]);

const candidateSourceSchema = z
  .object({
    sessionId: z.string().min(1),
    messageId: z.string().min(1),
    quote: z.string().min(1).max(2_000),
  })
  .strict();

const candidateRecordSchema = z
  .object({
    id: z.string().regex(CANDIDATE_ID_PATTERN),
    kind: candidateKindSchema,
    statement: z.string().min(1).max(1_000),
    why: z.string().min(1).max(1_000),
    sources: z.array(candidateSourceSchema).min(1).max(8),
    duplicateMemoryIds: z.array(z.string().regex(MEMORY_ID_PATTERN)).max(8),
    conflictMemoryIds: z.array(z.string().regex(MEMORY_ID_PATTERN)).max(8),
    sensitivityValidation: z.literal("passed_sensitive_text_v1"),
    createdAt: projectMemoryTimestampSchema,
    expiresAt: projectMemoryTimestampSchema,
  })
  .strict();

const candidateExtractionEventSchema = z
  .object({
    version: z.literal(PROJECT_MEMORY_SCHEMA_VERSION),
    type: z.literal("candidate_extraction"),
    operation: candidateExtractionOperationSchema,
    candidates: z.array(candidateRecordSchema).max(5),
    purgedCandidateCount: z.number().int().min(0).max(5),
    discardedCandidateIds: z.array(z.string().regex(CANDIDATE_ID_PATTERN)),
  })
  .strict()
  .superRefine((event, context) => {
    if (
      event.operation.outcome !== "succeeded" &&
      (event.candidates.length > 0 ||
        event.purgedCandidateCount > 0 ||
        event.discardedCandidateIds.length > 0)
    ) {
      context.addIssue({
        code: "custom",
        message: "only successful extraction may create or discard candidates",
      });
    }
    if (
      event.operation.outcome === "succeeded" &&
      event.operation.resultCount !==
        event.candidates.length + event.purgedCandidateCount
    ) {
      context.addIssue({
        code: "custom",
        message: "successful extraction resultCount must match candidates",
      });
    }
  });

const candidateProposalOriginSchema = z
  .object({
    sessionId: z.string().min(1),
    messageId: z.string().min(1),
    providerId: z.enum(["fake", "deepseek", "kimi", "qwen"]),
    model: z.string().min(1),
    createdAt: projectMemoryTimestampSchema,
  })
  .strict();

const candidateProposalEventSchema = z
  .object({
    version: z.literal(PROJECT_MEMORY_SCHEMA_VERSION),
    type: z.literal("candidate_proposal"),
    origin: candidateProposalOriginSchema,
    candidate: candidateRecordSchema,
  })
  .strict()
  .superRefine((event, context) => {
    if (
      event.candidate.sources.length !== 1 ||
      event.candidate.sources[0]?.sessionId !== event.origin.sessionId ||
      event.candidate.sources[0]?.messageId !== event.origin.messageId
    ) {
      context.addIssue({
        code: "custom",
        message:
          "current-turn proposal must cite exactly its originating session message",
      });
    }
  });

const candidateEditEventSchema = z
  .object({
    version: z.literal(PROJECT_MEMORY_SCHEMA_VERSION),
    type: z.literal("candidate_edit"),
    targetId: z.string().regex(CANDIDATE_ID_PATTERN),
    statement: z.string().min(1).max(1_000),
    createdAt: projectMemoryTimestampSchema,
  })
  .strict();

const candidateRejectEventSchema = z
  .object({
    version: z.literal(PROJECT_MEMORY_SCHEMA_VERSION),
    type: z.literal("candidate_reject"),
    targetIds: z.array(z.string().regex(CANDIDATE_ID_PATTERN)).min(1).max(100),
    reason: z.enum(["user_rejected", "cleared"]),
    createdAt: projectMemoryTimestampSchema,
  })
  .strict();

const candidateApproveEventSchema = z
  .object({
    version: z.literal(PROJECT_MEMORY_SCHEMA_VERSION),
    type: z.literal("candidate_approve"),
    targetId: z.string().regex(CANDIDATE_ID_PATTERN),
    memory: memoryRecordSchema,
  })
  .strict();

export const projectMemoryEventSchema = z.discriminatedUnion("type", [
  addEventSchema,
  forgetEventSchema,
  verifyEventSchema,
  candidateExtractionEventSchema,
  candidateProposalEventSchema,
  candidateEditEventSchema,
  candidateRejectEventSchema,
  candidateApproveEventSchema,
]);

export type ProjectMemoryEvent = z.infer<typeof projectMemoryEventSchema>;
export type MemoryRecord = z.infer<typeof memoryRecordSchema>;
export type ProjectMemorySource = z.infer<typeof projectMemorySourceSchema>;
export type CandidateExtractionOperation = z.infer<
  typeof candidateExtractionOperationSchema
>;
export type CandidateExtractionFailure = z.infer<
  typeof extractionFailureSchema
>;
export type CandidateKind = z.infer<typeof candidateKindSchema>;
export type CandidateSource = z.infer<typeof candidateSourceSchema>;
export type CandidateRecord = z.infer<typeof candidateRecordSchema>;
export type CandidateProposalOrigin = z.infer<
  typeof candidateProposalOriginSchema
>;
export type CandidateApproveEvent = z.infer<typeof candidateApproveEventSchema>;

export function memoryRecordFromEvent(
  event: ProjectMemoryEvent,
): MemoryRecord | null {
  if (event.type === "add" || event.type === "candidate_approve") {
    return event.memory;
  }
  return null;
}

export function eventTargetsMemory(
  event: ProjectMemoryEvent,
  memoryId: string,
): boolean {
  const memory = memoryRecordFromEvent(event);
  if (memory !== null) return memory.id === memoryId;
  return (
    (event.type === "forget" || event.type === "verify") &&
    event.targetId === memoryId
  );
}

export function eventsWithoutCandidateArtifacts(
  events: readonly ProjectMemoryEvent[],
  candidateIds: ReadonlySet<string>,
): readonly ProjectMemoryEvent[] {
  return events.flatMap((event): readonly ProjectMemoryEvent[] => {
    if (event.type === "candidate_extraction") {
      const candidates = event.candidates.filter(
        (candidate) => !candidateIds.has(candidate.id),
      );
      const purgedCandidateCount =
        event.purgedCandidateCount +
        (event.candidates.length - candidates.length);
      const discardedCandidateIds = event.discardedCandidateIds.filter(
        (id) => !candidateIds.has(id),
      );
      return [
        {
          ...event,
          candidates,
          purgedCandidateCount,
          discardedCandidateIds,
        },
      ];
    }
    if (
      event.type === "candidate_proposal" &&
      candidateIds.has(event.candidate.id)
    ) {
      return [];
    }
    if (
      (event.type === "candidate_edit" || event.type === "candidate_approve") &&
      candidateIds.has(event.targetId)
    ) {
      return [];
    }
    if (event.type === "candidate_reject") {
      const targetIds = event.targetIds.filter((id) => !candidateIds.has(id));
      return targetIds.length === 0 ? [] : [{ ...event, targetIds }];
    }
    return [event];
  });
}
