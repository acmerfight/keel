import { z } from "zod";
import { providerIds } from "../../core/provider-id.ts";
import type { Message } from "../../llm/types.ts";
import type { BashApprovalGrant } from "../../permissions/bash.ts";
import { builtinToolCallSchema } from "../../tools/tool-call.ts";
import {
  hasPersistenceRedactionMarker,
  redactMessageForPersistence,
  redactTextForPersistence,
} from "../persistence-redaction.ts";
import {
  isWorkflowSkillResourcePath,
  MAX_WORKFLOW_SKILL_RESOURCE_PATHS,
} from "../workflow-skill-contract.ts";
import { sessionStoreError } from "./errors.ts";
import {
  type AppendSessionRecord,
  type ModelSwitchSessionRecord,
  type ReplaceSessionRecord,
  SESSION_SCHEMA_VERSION,
  type SessionForkPointRecord,
  type SessionForkPolicyRecord,
  type SessionGraphRecord,
  type SessionHeaderRecord,
  type SessionModelSelection,
  type SessionModelSwitch,
  type SessionMutationRecord,
  type SessionQueuedInput,
  type SnapshotSessionRecord,
  type StoredMessage,
  type WorkflowSkill,
} from "./model.ts";

const toolCallSchema = builtinToolCallSchema;

const userMessageSchema = z
  .object({
    role: z.literal("user"),
    content: z.string(),
  })
  .strict();

const openAICompatibleAssistantMetadataSchema = z
  .object({
    reasoningContent: z.string(),
  })
  .strict();

const assistantProviderMetadataSchema = z
  .object({
    openaiCompatible: openAICompatibleAssistantMetadataSchema,
  })
  .strict();

const assistantMessageSchema = z
  .object({
    role: z.literal("assistant"),
    content: z.string(),
    toolCalls: z.array(toolCallSchema),
    providerMetadata: assistantProviderMetadataSchema.optional(),
  })
  .strict();

const toolMessageSchema = z
  .object({
    role: z.literal("tool"),
    toolCallId: z.string(),
    content: z.string(),
  })
  .strict();

const messageSchema = z.discriminatedUnion("role", [
  userMessageSchema,
  assistantMessageSchema,
  toolMessageSchema,
]);

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

const workflowSkillSchema = z
  .object({
    relativePath: z.string(),
    name: z.string(),
    resourcePaths: z
      .array(
        z.string().refine(isWorkflowSkillResourcePath, {
          message:
            "must be a skill-relative path under references/, scripts/, or assets/",
        }),
      )
      .max(MAX_WORKFLOW_SKILL_RESOURCE_PATHS),
    content: z.string(),
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
    workflowSkill: workflowSkillSchema.optional(),
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

const appendRecordSchema = z
  .object({
    schemaVersion: z.literal(SESSION_SCHEMA_VERSION),
    type: z.literal("append"),
    timestamp: z.string(),
    reason: z.literal("turn"),
    messages: z.array(storedMessageSchema),
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

const bashApprovalGrantSchema = z.discriminatedUnion("type", [
  exactBashApprovalGrantSchema,
  prefixBashApprovalGrantSchema,
]);

const bashApprovalGrantedRecordSchema = z
  .object({
    schemaVersion: z.literal(SESSION_SCHEMA_VERSION),
    type: z.literal("bash_approval_granted"),
    timestamp: z.string(),
    grant: bashApprovalGrantSchema,
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
    messages: z.array(storedMessageSchema),
    pendingInputs: z.array(queuedInputSchema),
    bashApprovalGrants: z.array(bashApprovalGrantSchema).optional(),
    activeModel: sessionModelSelectionSchema.optional(),
    modelSwitches: z.array(sessionModelSwitchSchema).optional(),
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
  inputAdmittedRecordSchema,
  inputConsumedRecordSchema,
  bashApprovalGrantedRecordSchema,
  snapshotRecordSchema,
]);

type RawMessage = z.infer<typeof messageSchema>;
type RawStoredMessage = z.infer<typeof storedMessageSchema>;
type RawSessionQueuedInput = z.infer<typeof queuedInputSchema>;
type RawBashApprovalGrant = z.infer<typeof bashApprovalGrantSchema>;
type RawSessionModelSelection = z.infer<typeof sessionModelSelectionSchema>;
type RawSessionModelSwitch = z.infer<typeof sessionModelSwitchSchema>;
type RawSessionHeaderRecord = z.infer<typeof sessionHeaderSchema>;
type RawSessionMutationRecord = z.infer<typeof sessionMutationRecordSchema>;

function toMessage(message: RawMessage): Message {
  switch (message.role) {
    case "user":
      return {
        role: "user",
        content: message.content,
      };
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
      };
  }
}

function copyMessage(message: Message): Message {
  switch (message.role) {
    case "user":
      return {
        role: "user",
        content: message.content,
      };
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
): readonly Message[] {
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

function copyWorkflowSkill(skill: WorkflowSkill): WorkflowSkill {
  return {
    relativePath: skill.relativePath,
    name: skill.name,
    resourcePaths: [...skill.resourcePaths],
    content: skill.content,
  };
}

function redactWorkflowSkillForPersistence(
  skill: WorkflowSkill,
): WorkflowSkill {
  return {
    relativePath: skill.relativePath,
    name: skill.name,
    resourcePaths: skill.resourcePaths.map(redactTextForPersistence),
    content: redactTextForPersistence(skill.content),
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
    ...(record.workflowSkill !== undefined
      ? { workflowSkill: copyWorkflowSkill(record.workflowSkill) }
      : {}),
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
  record: AppendSessionRecord | ReplaceSessionRecord | ModelSwitchSessionRecord,
  inputIds: readonly string[] | undefined,
): AppendSessionRecord | ReplaceSessionRecord | ModelSwitchSessionRecord {
  if (inputIds === undefined) {
    return record;
  }
  return { ...record, consumedInputIds: [...inputIds] };
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
    case "snapshot":
      return {
        schemaVersion: SESSION_SCHEMA_VERSION,
        type: "snapshot",
        timestamp: record.timestamp,
        reason: "size_threshold",
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
      };
  }
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
  return toSessionMutationRecord(parsed.data);
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
  return record.type === "snapshot" ? record : null;
}

function parseProviderVisibleMessages(
  sessionId: string,
  messages: readonly Message[],
  action: "persist" | "fork",
): readonly Message[] {
  const parsed = z.array(messageSchema).safeParse(messages);
  if (!parsed.success) {
    sessionStoreError(
      `Error: cannot ${action} session "${sessionId}": ledger contains invalid provider-visible messages.`,
    );
  }
  return parsed.data.map(toMessage);
}

function validateCompletedTranscript(
  sessionId: string,
  messages: readonly Message[],
  action: "persist" | "resume" | "fork",
): void {
  const errorPrefix = `Error: cannot ${action} session "${sessionId}":`;
  const pendingToolCallIds = new Set<string>();
  for (const message of messages) {
    if (pendingToolCallIds.size > 0 && message.role !== "tool") {
      sessionStoreError(
        `${errorPrefix} ledger contains incomplete tool calls.`,
      );
    }

    switch (message.role) {
      case "user":
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
  copyBashApprovalGrant,
  copyMessage,
  copySessionForkPointRecord,
  copySessionGraphRecord,
  copyStoredMessage,
  copyWorkflowSkill,
  messagesFromStoredMessages,
  parseProviderVisibleMessages,
  parseSessionHeaderRecord,
  parseSessionMutationRecord,
  parseSnapshotSessionMutationRecord,
  redactBashApprovalGrantForPersistence,
  redactSessionQueuedInputForPersistence,
  redactStoredMessageForPersistence,
  redactWorkflowSkillForPersistence,
  validateCompletedTranscript,
};
