import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { errorMessage } from "../core/error.ts";
import type { Message, ToolCall } from "../llm/types.ts";
import {
  isToolName,
  toolCallCanonicalArguments,
  toolCallFromParsedArguments,
} from "../tools/registry.ts";

const SESSION_SCHEMA_VERSION = 1;
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const SESSION_LOCK_DIRECTORY_NAME = "active.lock";
const SESSION_LOCK_OWNER_FILE_NAME = "owner.json";

const persistedToolCallSchema = z
  .object({
    id: z.string(),
    tool: z.string(),
  })
  .catchall(z.unknown());

const toolCallSchema = persistedToolCallSchema.transform(
  (toolCall, context) => {
    const { id, tool, ...parsedArguments } = toolCall;
    if (!isToolName(tool)) {
      context.addIssue({
        code: "custom",
        message: `Unsupported builtin tool "${tool}".`,
      });
      return z.NEVER;
    }
    const parsedToolCall = toolCallFromParsedArguments(
      id,
      tool,
      parsedArguments,
    );
    if (parsedToolCall === null) {
      context.addIssue({
        code: "custom",
        message: `Invalid arguments for builtin tool "${tool}".`,
      });
      return z.NEVER;
    }
    return parsedToolCall;
  },
);

const userMessageSchema = z
  .object({
    role: z.literal("user"),
    content: z.string(),
  })
  .strict();

const assistantMessageSchema = z
  .object({
    role: z.literal("assistant"),
    content: z.string(),
    toolCalls: z.array(toolCallSchema),
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

const sessionHeaderSchema = z
  .object({
    schemaVersion: z.literal(SESSION_SCHEMA_VERSION),
    type: z.literal("session"),
    id: z.string(),
    createdAt: z.string(),
    workspace: z.string(),
  })
  .strict();

const consumedInputIdsSchema = z.array(z.string());

const appendRecordSchema = z
  .object({
    schemaVersion: z.literal(SESSION_SCHEMA_VERSION),
    type: z.literal("append"),
    timestamp: z.string(),
    reason: z.literal("turn"),
    messages: z.array(messageSchema),
    consumedInputIds: consumedInputIdsSchema.optional(),
  })
  .strict();

const replaceRecordSchema = z
  .object({
    schemaVersion: z.literal(SESSION_SCHEMA_VERSION),
    type: z.literal("replace"),
    timestamp: z.string(),
    reason: z.enum(["turn", "compaction"]),
    messages: z.array(messageSchema),
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

const schemaVersionProbeSchema = z
  .object({
    schemaVersion: z.number().int(),
  })
  .passthrough();

const sessionLockOwnerSchema = z
  .object({
    pid: z.number().int().positive(),
    token: z.string(),
    createdAt: z.string(),
  })
  .strict();

const sessionMutationRecordSchema = z.discriminatedUnion("type", [
  appendRecordSchema,
  replaceRecordSchema,
  inputAdmittedRecordSchema,
  inputConsumedRecordSchema,
]);

type RawMessage = z.infer<typeof messageSchema>;
type RawSessionHeaderRecord = z.infer<typeof sessionHeaderSchema>;
type RawSessionMutationRecord = z.infer<typeof sessionMutationRecordSchema>;
type SessionLockOwner = z.infer<typeof sessionLockOwnerSchema>;

interface SessionHeaderRecord {
  readonly schemaVersion: 1;
  readonly type: "session";
  readonly id: string;
  readonly createdAt: string;
  readonly workspace: string;
}

interface AppendSessionRecord {
  readonly schemaVersion: 1;
  readonly type: "append";
  readonly timestamp: string;
  readonly reason: "turn";
  readonly messages: readonly Message[];
  readonly consumedInputIds?: readonly string[];
}

interface ReplaceSessionRecord {
  readonly schemaVersion: 1;
  readonly type: "replace";
  readonly timestamp: string;
  readonly reason: "turn" | "compaction";
  readonly messages: readonly Message[];
  readonly consumedInputIds?: readonly string[];
}

interface InputAdmittedSessionRecord {
  readonly schemaVersion: 1;
  readonly type: "input_admitted";
  readonly timestamp: string;
  readonly id: string;
  readonly sequence: number;
  readonly line: string;
}

interface InputConsumedSessionRecord {
  readonly schemaVersion: 1;
  readonly type: "input_consumed";
  readonly timestamp: string;
  readonly inputIds: readonly string[];
}

type SessionMutationRecord =
  | AppendSessionRecord
  | ReplaceSessionRecord
  | InputAdmittedSessionRecord
  | InputConsumedSessionRecord;

interface SessionRecords {
  readonly header: SessionHeaderRecord;
  readonly mutations: readonly SessionMutationRecord[];
}

export type SessionPersistenceReason = "turn" | "compaction";

export interface SessionStoreRuntime {
  readonly env: (key: string) => string | undefined;
  readonly now: () => number;
}

export interface SessionState {
  readonly id: string;
  readonly filePath: string;
  readonly workspace: string;
  readonly messages: readonly Message[];
  readonly pendingInputs: readonly SessionQueuedInput[];
}

export interface SessionQueuedInput {
  readonly id: string;
  readonly timestamp: string;
  readonly sequence: number;
  readonly line: string;
}

export interface SessionLock {
  readonly lockPath: string;
  readonly release: () => void;
}

export class SessionStoreError extends Error {}

function sessionStoreError(message: string): never {
  throw new SessionStoreError(message);
}

function hasNodeErrorCode(error: unknown, expectedCode: string): boolean {
  return (
    error instanceof Error && "code" in error && error.code === expectedCode
  );
}

function sessionHome(runtime: SessionStoreRuntime): string {
  return runtime.env("KEEL_HOME") ?? join(homedir(), ".keel");
}

function validateSessionId(sessionId: string): void {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    sessionStoreError(
      `Error: invalid session id "${sessionId}". Use letters, numbers, dots, dashes, or underscores.`,
    );
  }
  if (sessionId === "." || sessionId === ".." || sessionId.includes("..")) {
    sessionStoreError(
      `Error: invalid session id "${sessionId}". Use a simple session name without path traversal.`,
    );
  }
}

function sessionDirectoryPath(
  runtime: SessionStoreRuntime,
  sessionId: string,
): string {
  validateSessionId(sessionId);
  return join(sessionHome(runtime), "sessions", sessionId);
}

function sessionFilePath(
  runtime: SessionStoreRuntime,
  sessionId: string,
): string {
  return join(sessionDirectoryPath(runtime, sessionId), "ledger.jsonl");
}

function sessionLockPath(
  runtime: SessionStoreRuntime,
  sessionId: string,
): string {
  return join(
    sessionDirectoryPath(runtime, sessionId),
    SESSION_LOCK_DIRECTORY_NAME,
  );
}

function sessionLockOwnerPath(lockPath: string): string {
  return join(lockPath, SESSION_LOCK_OWNER_FILE_NAME);
}

function readSessionLockOwner(lockPath: string): SessionLockOwner | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(sessionLockOwnerPath(lockPath), "utf8"));
  } catch {
    return null;
  }
  const parsed = sessionLockOwnerSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !hasNodeErrorCode(error, "ESRCH");
  }
}

function removeStaleSessionLock(lockPath: string): boolean {
  const owner = readSessionLockOwner(lockPath);
  if (owner === null || processIsAlive(owner.pid)) {
    return false;
  }
  try {
    rmSync(lockPath, { recursive: true, force: true });
    return true;
  } catch (error) {
    sessionStoreError(
      `Error: cannot remove stale session lock ${lockPath}: ${errorMessage(error)}`,
    );
  }
}

function releaseSessionLock(lockPath: string, token: string): void {
  const owner = readSessionLockOwner(lockPath);
  if (owner === null || owner.token !== token) {
    return;
  }
  try {
    rmSync(lockPath, { recursive: true, force: true });
  } catch (error) {
    sessionStoreError(
      `Error: cannot release session lock ${lockPath}: ${errorMessage(error)}`,
    );
  }
}

export function acquireSessionLock(options: {
  readonly sessionId: string;
  readonly runtime: SessionStoreRuntime;
}): SessionLock {
  const lockPath = sessionLockPath(options.runtime, options.sessionId);
  const token = randomUUID();
  for (;;) {
    try {
      mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
      mkdirSync(lockPath, { mode: 0o700 });
    } catch (error) {
      if (hasNodeErrorCode(error, "EEXIST")) {
        if (removeStaleSessionLock(lockPath)) {
          continue;
        }
        sessionStoreError(
          `Error: session "${options.sessionId}" is already active. Stop the other Keel process before using it again.`,
        );
      }
      sessionStoreError(
        `Error: cannot acquire session lock ${lockPath}: ${errorMessage(error)}`,
      );
    }

    try {
      writeFileSync(
        sessionLockOwnerPath(lockPath),
        `${JSON.stringify({
          pid: process.pid,
          token,
          createdAt: isoTimestamp(options.runtime),
        })}\n`,
        { encoding: "utf8", flag: "wx", mode: 0o600 },
      );
    } catch (error) {
      rmSync(lockPath, { recursive: true, force: true });
      sessionStoreError(
        `Error: cannot write session lock ${lockPath}: ${errorMessage(error)}`,
      );
    }

    return {
      lockPath,
      release: () => {
        releaseSessionLock(lockPath, token);
      },
    };
  }
}

export function ensureSessionCanBeCreated(options: {
  readonly sessionId: string;
  readonly runtime: SessionStoreRuntime;
}): void {
  const filePath = sessionFilePath(options.runtime, options.sessionId);
  try {
    statSync(filePath);
  } catch (error) {
    if (hasNodeErrorCode(error, "ENOENT")) {
      return;
    }
    sessionStoreError(
      `Error: cannot inspect session ledger ${filePath}: ${errorMessage(error)}`,
    );
  }
  sessionStoreError(
    `Error: session "${options.sessionId}" already exists. Use --resume ${options.sessionId} to continue it.`,
  );
}

function isoTimestamp(runtime: SessionStoreRuntime): string {
  return new Date(runtime.now()).toISOString();
}

function appendJsonLine(filePath: string, record: SessionMutationRecord): void {
  let fd: number | undefined;
  try {
    mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
    fd = openSync(filePath, "a", 0o600);
    appendFileSync(fd, `${JSON.stringify(record)}\n`, "utf8");
    fsyncSync(fd);
  } catch (error) {
    sessionStoreError(
      `Error: cannot write session ledger ${filePath}: ${errorMessage(error)}`,
    );
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
  }
}

function writeInitialHeader(
  filePath: string,
  header: SessionHeaderRecord,
): void {
  let fd: number | undefined;
  try {
    mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
    fd = openSync(filePath, "wx", 0o600);
    writeFileSync(fd, `${JSON.stringify(header)}\n`, "utf8");
    fsyncSync(fd);
  } catch (error) {
    if (hasNodeErrorCode(error, "EEXIST")) {
      sessionStoreError(
        `Error: session "${header.id}" already exists. Use --resume ${header.id} to continue it.`,
      );
    }
    sessionStoreError(
      `Error: cannot create session ledger ${filePath}: ${errorMessage(error)}`,
    );
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
  }
}

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
      };
    case "tool":
      return {
        role: "tool",
        toolCallId: message.toolCallId,
        content: message.content,
      };
  }
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
  record: AppendSessionRecord | ReplaceSessionRecord,
  inputIds: readonly string[] | undefined,
): AppendSessionRecord | ReplaceSessionRecord {
  if (inputIds === undefined) {
    return record;
  }
  return { ...record, consumedInputIds: [...inputIds] };
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
          messages: record.messages.map(toMessage),
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
          messages: record.messages.map(toMessage),
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

function readSessionRecords(filePath: string): SessionRecords {
  let content: string;
  try {
    content = readFileSync(filePath, "utf8");
  } catch (error) {
    if (hasNodeErrorCode(error, "ENOENT")) {
      sessionStoreError(`Error: session ledger not found at ${filePath}.`);
    }
    sessionStoreError(
      `Error: cannot read session ledger ${filePath}: ${errorMessage(error)}`,
    );
  }
  const lines = content.split("\n").filter((line) => line !== "");
  const [headerLine, ...mutationLines] = lines;
  if (headerLine === undefined) {
    sessionStoreError(
      `Error: cannot load session ledger ${filePath}: ledger has no session header.`,
    );
  }
  return {
    header: parseSessionHeaderRecord(filePath, headerLine, 1),
    mutations: mutationLines.map((line, index) =>
      parseSessionMutationRecord(filePath, line, index + 2),
    ),
  };
}

function formatNestedSessionStoreError(error: SessionStoreError): string {
  return error.message.replace(/^Error: /u, "");
}

function formatResumeSessionLoadError(error: unknown): string {
  /* v8 ignore next 3: readSessionRecords converts disk and parser failures to SessionStoreError. */
  if (!(error instanceof SessionStoreError)) {
    throw error;
  }
  return formatNestedSessionStoreError(error);
}

function toolCallArgumentsEqual(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): boolean {
  const leftEntries = Object.entries(left);
  if (leftEntries.length !== Object.keys(right).length) {
    return false;
  }
  return leftEntries.every(
    ([key, value]) => Object.hasOwn(right, key) && value === right[key],
  );
}

function toolCallsEqual(left: ToolCall, right: ToolCall): boolean {
  return (
    left.id === right.id &&
    left.tool === right.tool &&
    toolCallArgumentsEqual(
      toolCallCanonicalArguments(left),
      toolCallCanonicalArguments(right),
    )
  );
}

function messagesEqual(left: Message, right: Message): boolean {
  switch (left.role) {
    case "user":
      return right.role === "user" && left.content === right.content;
    case "assistant":
      return (
        right.role === "assistant" &&
        left.content === right.content &&
        left.toolCalls.length === right.toolCalls.length &&
        left.toolCalls.every((toolCall, index) => {
          const rightToolCall = right.toolCalls[index];
          return (
            rightToolCall !== undefined &&
            toolCallsEqual(toolCall, rightToolCall)
          );
        })
      );
    case "tool":
      return (
        right.role === "tool" &&
        left.toolCallId === right.toolCallId &&
        left.content === right.content
      );
  }
}

function messageArraysEqual(
  left: readonly Message[],
  right: readonly Message[],
): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((message, index) => {
    const rightMessage = right[index];
    return rightMessage !== undefined && messagesEqual(message, rightMessage);
  });
}

function hasMessagePrefix(
  currentMessages: readonly Message[],
  previousMessages: readonly Message[],
): boolean {
  if (currentMessages.length < previousMessages.length) {
    return false;
  }
  return previousMessages.every((message, index) => {
    const currentMessage = currentMessages[index];
    return (
      currentMessage !== undefined && messagesEqual(message, currentMessage)
    );
  });
}

function uniqueInputIds(inputIds: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const inputId of inputIds) {
    if (seen.has(inputId)) {
      continue;
    }
    seen.add(inputId);
    unique.push(inputId);
  }
  return unique;
}

function pendingInputsInReplayOrder(
  pendingInputsById: ReadonlyMap<string, SessionQueuedInput>,
): readonly SessionQueuedInput[] {
  return [...pendingInputsById.values()].sort((left, right) => {
    const sequenceDelta = left.sequence - right.sequence;
    if (sequenceDelta !== 0) {
      return sequenceDelta;
    }
    const timestampDelta = left.timestamp.localeCompare(right.timestamp);
    if (timestampDelta !== 0) {
      return timestampDelta;
    }
    return left.id.localeCompare(right.id);
  });
}

function consumeReplayInputs(
  pendingInputsById: Map<string, SessionQueuedInput>,
  consumedInputIds: readonly string[] | undefined,
): void {
  if (consumedInputIds === undefined) {
    return;
  }
  for (const inputId of consumedInputIds) {
    pendingInputsById.delete(inputId);
  }
}

function sessionRecordWithConsumedInputIds(
  record: AppendSessionRecord,
  consumedInputIds: readonly string[],
): AppendSessionRecord;
function sessionRecordWithConsumedInputIds(
  record: ReplaceSessionRecord,
  consumedInputIds: readonly string[],
): ReplaceSessionRecord;
function sessionRecordWithConsumedInputIds(
  record: AppendSessionRecord | ReplaceSessionRecord,
  consumedInputIds: readonly string[],
): AppendSessionRecord | ReplaceSessionRecord {
  if (consumedInputIds.length === 0) {
    return record;
  }
  return { ...record, consumedInputIds: [...consumedInputIds] };
}

function parseProviderVisibleMessages(
  sessionId: string,
  messages: readonly Message[],
  action: "persist",
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
  action: "persist" | "resume",
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

export function createSessionStore(options: {
  readonly sessionId: string;
  readonly workspace: string;
  readonly runtime: SessionStoreRuntime;
}): SessionState {
  const workspace = realpathSync(options.workspace);
  const filePath = sessionFilePath(options.runtime, options.sessionId);
  writeInitialHeader(filePath, {
    schemaVersion: SESSION_SCHEMA_VERSION,
    type: "session",
    id: options.sessionId,
    createdAt: isoTimestamp(options.runtime),
    workspace,
  });
  return {
    id: options.sessionId,
    filePath,
    workspace,
    messages: [],
    pendingInputs: [],
  };
}

export function resumeSessionStore(options: {
  readonly sessionId: string;
  readonly workspace: string;
  readonly runtime: SessionStoreRuntime;
}): SessionState {
  const expectedWorkspace = realpathSync(options.workspace);
  const filePath = sessionFilePath(options.runtime, options.sessionId);
  let records: SessionRecords;
  try {
    records = readSessionRecords(filePath);
  } catch (error) {
    const message = formatResumeSessionLoadError(error);
    sessionStoreError(
      `Error: cannot resume session "${options.sessionId}": ${message}`,
    );
  }
  const { header } = records;
  if (header.id !== options.sessionId) {
    sessionStoreError(
      `Error: cannot resume session "${options.sessionId}": ledger belongs to session "${header.id}".`,
    );
  }
  if (header.workspace !== expectedWorkspace) {
    sessionStoreError(
      `Error: cannot resume session "${options.sessionId}": session workspace is ${header.workspace}, not ${expectedWorkspace}.`,
    );
  }

  let messages: Message[] = [];
  const pendingInputsById = new Map<string, SessionQueuedInput>();
  for (const record of records.mutations) {
    switch (record.type) {
      case "append":
        messages = [...messages, ...record.messages];
        consumeReplayInputs(pendingInputsById, record.consumedInputIds);
        break;
      case "replace":
        messages = [...record.messages];
        consumeReplayInputs(pendingInputsById, record.consumedInputIds);
        break;
      case "input_admitted":
        pendingInputsById.set(record.id, {
          id: record.id,
          timestamp: record.timestamp,
          sequence: record.sequence,
          line: record.line,
        });
        break;
      case "input_consumed":
        consumeReplayInputs(pendingInputsById, record.inputIds);
        break;
    }
  }
  validateCompletedTranscript(options.sessionId, messages, "resume");

  return {
    id: options.sessionId,
    filePath,
    workspace: expectedWorkspace,
    messages,
    pendingInputs: pendingInputsInReplayOrder(pendingInputsById),
  };
}

export function persistSessionMessages(options: {
  readonly session: SessionState;
  readonly previousMessages: readonly Message[];
  readonly currentMessages: readonly Message[];
  readonly runtime: SessionStoreRuntime;
  readonly reason: SessionPersistenceReason;
  readonly consumedInputIds?: readonly string[];
}): readonly Message[] {
  const currentMessages = parseProviderVisibleMessages(
    options.session.id,
    options.currentMessages,
    "persist",
  );
  validateCompletedTranscript(options.session.id, currentMessages, "persist");
  const consumedInputIds = uniqueInputIds(options.consumedInputIds ?? []);

  if (messageArraysEqual(currentMessages, options.previousMessages)) {
    if (consumedInputIds.length > 0) {
      consumeSessionQueuedInputs({
        session: options.session,
        inputIds: consumedInputIds,
        runtime: options.runtime,
      });
    }
    return [...options.previousMessages];
  }

  if (hasMessagePrefix(currentMessages, options.previousMessages)) {
    const messages = currentMessages.slice(options.previousMessages.length);
    appendJsonLine(
      options.session.filePath,
      sessionRecordWithConsumedInputIds(
        {
          schemaVersion: SESSION_SCHEMA_VERSION,
          type: "append",
          timestamp: isoTimestamp(options.runtime),
          reason: "turn",
          messages,
        },
        consumedInputIds,
      ),
    );
    return [...currentMessages];
  }

  appendJsonLine(
    options.session.filePath,
    sessionRecordWithConsumedInputIds(
      {
        schemaVersion: SESSION_SCHEMA_VERSION,
        type: "replace",
        timestamp: isoTimestamp(options.runtime),
        reason: options.reason,
        messages: [...currentMessages],
      },
      consumedInputIds,
    ),
  );
  return [...currentMessages];
}

export function persistSessionQueuedInput(options: {
  readonly session: SessionState;
  readonly sequence: number;
  readonly line: string;
  readonly runtime: SessionStoreRuntime;
}): SessionQueuedInput {
  const queuedInput = {
    id: randomUUID(),
    timestamp: isoTimestamp(options.runtime),
    sequence: options.sequence,
    line: options.line,
  };
  appendJsonLine(options.session.filePath, {
    schemaVersion: SESSION_SCHEMA_VERSION,
    type: "input_admitted",
    timestamp: queuedInput.timestamp,
    id: queuedInput.id,
    sequence: queuedInput.sequence,
    line: queuedInput.line,
  });
  return queuedInput;
}

export function consumeSessionQueuedInputs(options: {
  readonly session: SessionState;
  readonly inputIds: readonly string[];
  readonly runtime: SessionStoreRuntime;
}): void {
  const inputIds = uniqueInputIds(options.inputIds);
  if (inputIds.length === 0) {
    return;
  }
  appendJsonLine(options.session.filePath, {
    schemaVersion: SESSION_SCHEMA_VERSION,
    type: "input_consumed",
    timestamp: isoTimestamp(options.runtime),
    inputIds,
  });
}
