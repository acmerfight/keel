import { z } from "zod";
import {
  ordinaryUserMessageOriginTypes,
  subagentResultDeliveryOriginType,
} from "../agent/session-message.ts";
import type { AgentId, SubagentRunId } from "../agent/subagent-lifecycle.ts";
import { toolCallSchema } from "../tools/tool-call.ts";

const userMessageContextCompactionEvidenceSchema = z
  .object({
    handle: z.string(),
    label: z.string(),
    source: z.string(),
    why: z.string(),
    inspectCommand: z.string().optional(),
  })
  .strict();

export const userMessageContextCompactionSchema = z
  .object({
    evidence: z.array(userMessageContextCompactionEvidenceSchema),
    untrustedMcpContent: z.literal(true).optional(),
  })
  .strict();

const ordinaryUserMessageOriginSchema = z
  .object({ type: z.enum(ordinaryUserMessageOriginTypes) })
  .strict();

const subagentResultDeliveryReferenceSchema = z
  .object({
    sessionId: z.string().min(1),
    delegationId: z.string().min(1),
    childAgentId: z.templateLiteral([
      "agent-",
      z.string().regex(/^[a-f0-9-]+$/u),
    ]) satisfies z.ZodType<AgentId>,
    childRunId: z.templateLiteral([
      "subagent-",
      z.string().regex(/^[a-f0-9-]+$/u),
    ]) satisfies z.ZodType<SubagentRunId>,
    canonicalResultSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();

const userMessageShape = {
  role: z.literal("user"),
  content: z.string(),
  contextCompaction: userMessageContextCompactionSchema.optional(),
};

const ordinaryUserMessageSchema = z
  .object({
    ...userMessageShape,
    origin: ordinaryUserMessageOriginSchema.optional(),
  })
  .strict();

const subagentResultDeliveryMessageSchema = z
  .object({
    ...userMessageShape,
    origin: z
      .object({ type: z.literal(subagentResultDeliveryOriginType) })
      .strict(),
    subagentResultDelivery: subagentResultDeliveryReferenceSchema,
  })
  .strict();

const openAICompatibleAssistantMetadataSchema = z
  .object({ reasoningContent: z.string() })
  .strict();

const assistantProviderMetadataSchema = z
  .object({ openaiCompatible: openAICompatibleAssistantMetadataSchema })
  .strict();

const assistantMessageSchema = z
  .object({
    role: z.literal("assistant"),
    content: z.string(),
    toolCalls: z.array(toolCallSchema),
    providerMetadata: assistantProviderMetadataSchema.optional(),
  })
  .strict();

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const readResourceObservationSchema = z
  .object({
    kind: z.literal("read_projection"),
    targetPathSha256: sha256Schema,
    contentSha256: sha256Schema,
  })
  .strict();

const toolMessageSchema = z
  .object({
    role: z.literal("tool"),
    toolCallId: z.string(),
    content: z.string(),
    sourceTruncated: z.boolean().optional(),
    evidenceShortened: z.literal(true).optional(),
    resourceObservation: readResourceObservationSchema.optional(),
  })
  .strict();

export const sessionMessageSchema = z.union([
  ordinaryUserMessageSchema,
  subagentResultDeliveryMessageSchema,
  assistantMessageSchema,
  toolMessageSchema,
]);

export const persistedSessionMessageSchema = z.union([
  z
    .object({
      ...userMessageShape,
      origin: ordinaryUserMessageOriginSchema,
    })
    .strict(),
  subagentResultDeliveryMessageSchema,
  assistantMessageSchema,
  toolMessageSchema,
]);
