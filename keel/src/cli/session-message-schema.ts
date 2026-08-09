import { z } from "zod";
import { userMessageOriginTypes } from "../agent/session-message.ts";
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

export const userMessageOriginSchema = z
  .object({
    type: z.enum(userMessageOriginTypes),
  })
  .strict();

const userMessageShape = {
  role: z.literal("user"),
  content: z.string(),
  contextCompaction: userMessageContextCompactionSchema.optional(),
};

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

export const sessionMessageSchema = z.discriminatedUnion("role", [
  z
    .object({
      ...userMessageShape,
      origin: userMessageOriginSchema.optional(),
    })
    .strict(),
  assistantMessageSchema,
  toolMessageSchema,
]);

export const persistedSessionMessageSchema = z.discriminatedUnion("role", [
  z
    .object({
      ...userMessageShape,
      origin: userMessageOriginSchema,
    })
    .strict(),
  assistantMessageSchema,
  toolMessageSchema,
]);
