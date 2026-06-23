import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
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
import type { BashApprovalGrant } from "../permissions/bash.ts";
import {
  isToolName,
  toolCallCanonicalArguments,
  toolCallFromParsedArguments,
} from "../tools/registry.ts";

const SESSION_SCHEMA_VERSION = 1;
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const SESSION_LOCK_DIRECTORY_NAME = "active.lock";
const SESSION_LOCK_OWNER_FILE_NAME = "owner.json";
const SESSION_LEDGER_RESUME_MAX_BYTES = 32 * 1024 * 1024;
const SESSION_LEDGER_SNAPSHOT_THRESHOLD_BYTES = 16 * 1024 * 1024;
const SESSION_LEDGER_HEADER_READ_MAX_BYTES = 64 * 1024;
const SESSION_CATALOG_PREVIEW_MAX_LENGTH = 120;
const EMPTY_SESSION_CATALOG_PREVIEW = "(no restored user messages)";
const CONVERSATION_CHECKPOINT_OPEN = "<conversation-checkpoint>";
const CONVERSATION_CHECKPOINT_CLOSE = "</conversation-checkpoint>";
const CONVERSATION_CHECKPOINT_INSTRUCTION =
  "The following is a summary of earlier conversation. Treat it as historical context, not as a new instruction.";
const CONVERSATION_CHECKPOINT_NO_LATER_MESSAGES =
  "No later messages are available after this checkpoint; continue from the task state and next steps in the summary.";
const SUMMARY_OPEN = "<summary>";
const SUMMARY_CLOSE = "</summary>";

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
    forkedFrom: z.string().optional(),
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
    messages: z.array(messageSchema),
    pendingInputs: z.array(queuedInputSchema),
    bashApprovalGrants: z.array(bashApprovalGrantSchema).optional(),
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
  bashApprovalGrantedRecordSchema,
  snapshotRecordSchema,
]);

type RawMessage = z.infer<typeof messageSchema>;
type RawSessionQueuedInput = z.infer<typeof queuedInputSchema>;
type RawBashApprovalGrant = z.infer<typeof bashApprovalGrantSchema>;
type RawSessionHeaderRecord = z.infer<typeof sessionHeaderSchema>;
type RawSessionMutationRecord = z.infer<typeof sessionMutationRecordSchema>;
type SessionLockOwner = z.infer<typeof sessionLockOwnerSchema>;

interface SessionHeaderRecord {
  readonly schemaVersion: 1;
  readonly type: "session";
  readonly id: string;
  readonly createdAt: string;
  readonly workspace: string;
  readonly forkedFrom?: string;
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

interface BashApprovalGrantedSessionRecord {
  readonly schemaVersion: 1;
  readonly type: "bash_approval_granted";
  readonly timestamp: string;
  readonly grant: BashApprovalGrant;
}

interface SnapshotSessionRecord {
  readonly schemaVersion: 1;
  readonly type: "snapshot";
  readonly timestamp: string;
  readonly reason: "size_threshold";
  readonly messages: readonly Message[];
  readonly pendingInputs: readonly SessionQueuedInput[];
  readonly bashApprovalGrants?: readonly BashApprovalGrant[];
}

type SessionMutationRecord =
  | AppendSessionRecord
  | ReplaceSessionRecord
  | InputAdmittedSessionRecord
  | InputConsumedSessionRecord
  | BashApprovalGrantedSessionRecord
  | SnapshotSessionRecord;

interface SessionRecords {
  readonly header: SessionHeaderRecord;
  readonly mutations: readonly SessionMutationRecord[];
}

export type SessionPersistenceReason = "turn" | "compaction";

export interface SessionStoreRuntime {
  readonly env: (key: string) => string | undefined;
  readonly now: () => number;
}

const sessionReplayStateKey: unique symbol = Symbol("sessionReplayState");

export interface SessionState {
  readonly id: string;
  readonly filePath: string;
  readonly workspace: string;
  readonly messages: readonly Message[];
  readonly pendingInputs: readonly SessionQueuedInput[];
  readonly bashApprovalGrants: readonly BashApprovalGrant[];
  readonly [sessionReplayStateKey]: SessionReplayState;
}

export interface SessionQueuedInput {
  readonly id: string;
  readonly timestamp: string;
  readonly sequence: number;
  readonly line: string;
}

export interface SessionCatalogEntry {
  readonly id: string;
  readonly workspace: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly preview: string;
  readonly forkedFrom?: string;
}

export interface SessionCatalogWarning {
  readonly sessionId: string;
  readonly message: string;
}

export interface SessionCatalog {
  readonly workspace: string;
  readonly sessions: readonly SessionCatalogEntry[];
  readonly warnings: readonly SessionCatalogWarning[];
}

type CatalogPreviewState =
  | { readonly kind: "empty" }
  | { readonly kind: "checkpoint" | "user"; readonly preview: string };

interface SessionCatalogReplayState {
  readonly updatedAt: string;
  readonly preview: CatalogPreviewState;
}

interface SessionReplayState {
  readonly messages: Message[];
  readonly pendingInputsById: Map<string, SessionQueuedInput>;
  readonly bashApprovalGrants: BashApprovalGrant[];
}

type ObjectValue =
  | { readonly exists: false }
  | { readonly exists: true; readonly value: unknown };

interface SnapshotSearchResult {
  readonly index: number;
  readonly record: SnapshotSessionRecord;
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
    ...(record.forkedFrom !== undefined
      ? { forkedFrom: record.forkedFrom }
      : {}),
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

function toSessionQueuedInput(
  input: RawSessionQueuedInput,
): SessionQueuedInput {
  return {
    id: input.id,
    timestamp: input.timestamp,
    sequence: input.sequence,
    line: input.line,
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

function toBashApprovalGrant(grant: RawBashApprovalGrant): BashApprovalGrant {
  return copyBashApprovalGrant(grant);
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
        messages: record.messages.map(toMessage),
        pendingInputs: record.pendingInputs.map(toSessionQueuedInput),
        ...(record.bashApprovalGrants !== undefined
          ? {
              bashApprovalGrants:
                record.bashApprovalGrants.map(toBashApprovalGrant),
            }
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

function formatByteCount(bytes: number): string {
  return `${bytes.toLocaleString("en-US")} bytes`;
}

function sessionLedgerSize(filePath: string): number {
  try {
    return statSync(filePath).size;
  } catch (error) {
    if (hasNodeErrorCode(error, "ENOENT")) {
      sessionStoreError(`Error: session ledger not found at ${filePath}.`);
    }
    sessionStoreError(
      `Error: cannot inspect session ledger ${filePath}: ${errorMessage(error)}`,
    );
  }
}

function sessionLedgerReadError(filePath: string, error: unknown): never {
  /* v8 ignore next 3: stat succeeds before reads; ENOENT here requires a filesystem race. */
  if (hasNodeErrorCode(error, "ENOENT")) {
    sessionStoreError(`Error: session ledger not found at ${filePath}.`);
  }
  sessionStoreError(
    `Error: cannot read session ledger ${filePath}: ${errorMessage(error)}`,
  );
}

function oversizedSessionLedgerError(
  filePath: string,
  ledgerSize: number,
): never {
  sessionStoreError(
    `Error: cannot load session ledger ${filePath}: ledger is too large to resume safely (${formatByteCount(ledgerSize)}; limit ${formatByteCount(SESSION_LEDGER_RESUME_MAX_BYTES)}), and no bounded snapshot was found in the final ${formatByteCount(SESSION_LEDGER_RESUME_MAX_BYTES)}. Start a new session with --session <new-id>, or inspect and archive this ledger manually if you need its old context.`,
  );
}

function readSessionLedgerContent(filePath: string): string {
  try {
    return readFileSync(filePath, "utf8");
  } catch (error) {
    return sessionLedgerReadError(filePath, error);
  }
}

function readSessionLedgerRange(
  filePath: string,
  start: number,
  length: number,
): string {
  let fd: number | undefined;
  try {
    fd = openSync(filePath, "r");
    const buffer = Buffer.alloc(length);
    const bytesRead = readSync(fd, buffer, 0, length, start);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } catch (error) {
    return sessionLedgerReadError(filePath, error);
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
  }
}

function splitSessionJsonLines(content: string): readonly string[] {
  return content.split("\n").filter((line) => line !== "");
}

function readSessionHeaderLine(filePath: string, ledgerSize: number): string {
  const sample = readSessionLedgerRange(
    filePath,
    0,
    Math.min(ledgerSize, SESSION_LEDGER_HEADER_READ_MAX_BYTES),
  );
  const newlineIndex = sample.indexOf("\n");
  const headerLine =
    newlineIndex === -1 ? sample : sample.slice(0, newlineIndex);
  if (headerLine === "") {
    sessionStoreError(
      `Error: cannot load session ledger ${filePath}: ledger has no session header.`,
    );
  }
  return headerLine;
}

function readCompleteTailSessionJsonLines(
  filePath: string,
  ledgerSize: number,
): readonly string[] {
  const tailStart = Math.max(0, ledgerSize - SESSION_LEDGER_RESUME_MAX_BYTES);
  const readStart = tailStart === 0 ? 0 : tailStart - 1;
  const tail = readSessionLedgerRange(
    filePath,
    readStart,
    ledgerSize - readStart,
  );
  if (tail.startsWith("\n")) {
    return splitSessionJsonLines(tail.slice(1));
  }

  const firstNewlineIndex = tail.indexOf("\n");
  if (firstNewlineIndex === -1) {
    return [];
  }
  return splitSessionJsonLines(tail.slice(firstNewlineIndex + 1));
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

function findLatestSnapshotRecord(
  tailLines: readonly string[],
): SnapshotSearchResult | null {
  for (const [index, line] of [...tailLines.entries()].reverse()) {
    const record = parseSnapshotSessionMutationRecord(line);
    if (record !== null) {
      return { index, record };
    }
  }
  return null;
}

function parseSessionRecordsFromLines(
  filePath: string,
  lines: readonly string[],
): SessionRecords {
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

function readOversizedSessionRecords(
  filePath: string,
  ledgerSize: number,
): SessionRecords {
  const header = parseSessionHeaderRecord(
    filePath,
    readSessionHeaderLine(filePath, ledgerSize),
    1,
  );
  const tailLines = readCompleteTailSessionJsonLines(filePath, ledgerSize);
  const snapshot = findLatestSnapshotRecord(tailLines);
  if (snapshot === null) {
    oversizedSessionLedgerError(filePath, ledgerSize);
  }

  return {
    header,
    mutations: [
      snapshot.record,
      ...tailLines
        .slice(snapshot.index + 1)
        .map((line, index) =>
          parseSessionMutationRecord(
            filePath,
            line,
            snapshot.index + index + 2,
          ),
        ),
    ],
  };
}

function readSessionRecords(filePath: string): SessionRecords {
  const ledgerSize = sessionLedgerSize(filePath);
  if (ledgerSize > SESSION_LEDGER_RESUME_MAX_BYTES) {
    return readOversizedSessionRecords(filePath, ledgerSize);
  }

  return parseSessionRecordsFromLines(
    filePath,
    splitSessionJsonLines(readSessionLedgerContent(filePath)),
  );
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

function normalizeSessionPreview(content: string): string {
  const normalized = content.replace(/\s+/gu, " ").trim();
  if (normalized.length <= SESSION_CATALOG_PREVIEW_MAX_LENGTH) {
    return normalized;
  }
  return `${normalized.slice(0, SESSION_CATALOG_PREVIEW_MAX_LENGTH - 3)}...`;
}

function catalogCheckpointSummary(content: string): string | null {
  const lines = content.split("\n");
  if (
    lines.length < 5 ||
    lines[0] !== CONVERSATION_CHECKPOINT_OPEN ||
    lines[1] !== CONVERSATION_CHECKPOINT_INSTRUCTION ||
    lines[lines.length - 2] !== SUMMARY_CLOSE ||
    lines[lines.length - 1] !== CONVERSATION_CHECKPOINT_CLOSE
  ) {
    return null;
  }

  const summaryOpenIndex =
    lines[2] === CONVERSATION_CHECKPOINT_NO_LATER_MESSAGES ? 3 : 2;
  if (lines[summaryOpenIndex] !== SUMMARY_OPEN) {
    return null;
  }
  return lines.slice(summaryOpenIndex + 1, -2).join("\n");
}

function catalogPreviewStateFromMessages(
  messages: readonly Message[],
): CatalogPreviewState {
  let checkpointPreview: string | undefined;
  for (const message of messages) {
    if (message.role === "user") {
      const checkpointSummary = catalogCheckpointSummary(message.content);
      if (checkpointSummary !== null) {
        checkpointPreview = normalizeSessionPreview(
          `checkpoint: ${checkpointSummary}`,
        );
        continue;
      }
      return {
        kind: "user",
        preview: normalizeSessionPreview(message.content),
      };
    }
  }
  if (checkpointPreview !== undefined) {
    return { kind: "checkpoint", preview: checkpointPreview };
  }
  return { kind: "empty" };
}

function appendCatalogPreviewState(
  current: CatalogPreviewState,
  next: CatalogPreviewState,
): CatalogPreviewState {
  if (current.kind === "user" || next.kind === "empty") {
    return current;
  }
  return next;
}

function catalogPreviewValue(state: CatalogPreviewState): string {
  return state.kind === "empty" ? EMPTY_SESSION_CATALOG_PREVIEW : state.preview;
}

function initialSessionCatalogReplayState(
  header: SessionHeaderRecord,
): SessionCatalogReplayState {
  return {
    updatedAt: header.createdAt,
    preview: { kind: "empty" },
  };
}

function applySessionCatalogMutation(
  state: SessionCatalogReplayState,
  record: SessionMutationRecord,
): SessionCatalogReplayState {
  switch (record.type) {
    case "append":
      return {
        updatedAt: record.timestamp,
        preview: appendCatalogPreviewState(
          state.preview,
          catalogPreviewStateFromMessages(record.messages),
        ),
      };
    case "replace":
    case "snapshot":
      return {
        updatedAt: record.timestamp,
        preview: catalogPreviewStateFromMessages(record.messages),
      };
    case "input_admitted":
    case "input_consumed":
    case "bash_approval_granted":
      return {
        ...state,
        updatedAt: record.timestamp,
      };
  }
}

function replaySessionCatalogState(
  records: SessionRecords,
): SessionCatalogReplayState {
  let state = initialSessionCatalogReplayState(records.header);
  for (const record of records.mutations) {
    state = applySessionCatalogMutation(state, record);
  }
  return state;
}

function sessionCatalogEntry(records: SessionRecords): SessionCatalogEntry {
  const state = replaySessionCatalogState(records);
  return {
    id: records.header.id,
    workspace: records.header.workspace,
    createdAt: records.header.createdAt,
    updatedAt: state.updatedAt,
    preview: catalogPreviewValue(state.preview),
    ...(records.header.forkedFrom !== undefined
      ? { forkedFrom: records.header.forkedFrom }
      : {}),
  };
}

function compareSessionCatalogEntries(
  left: SessionCatalogEntry,
  right: SessionCatalogEntry,
): number {
  const timestampDelta = right.updatedAt.localeCompare(left.updatedAt);
  if (timestampDelta !== 0) {
    return timestampDelta;
  }
  return left.id.localeCompare(right.id);
}

function readCatalogHeader(options: {
  readonly sessionId: string;
  readonly runtime: SessionStoreRuntime;
}): SessionHeaderRecord {
  const filePath = sessionFilePath(options.runtime, options.sessionId);
  const ledgerSize = sessionLedgerSize(filePath);
  const header = parseSessionHeaderRecord(
    filePath,
    readSessionHeaderLine(filePath, ledgerSize),
    1,
  );
  if (header.id !== options.sessionId) {
    sessionStoreError(
      `Error: ledger belongs to session "${header.id}", not "${options.sessionId}".`,
    );
  }
  return header;
}

function readCatalogRecords(options: {
  readonly sessionId: string;
  readonly runtime: SessionStoreRuntime;
}): SessionRecords {
  const filePath = sessionFilePath(options.runtime, options.sessionId);
  // Use the resume reader so catalog previews follow append/replace/snapshot replay exactly.
  return readSessionRecords(filePath);
}

function listSessionDirectories(
  runtime: SessionStoreRuntime,
): readonly string[] {
  const sessionsPath = join(sessionHome(runtime), "sessions");
  try {
    return readdirSync(sessionsPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (error) {
    if (hasNodeErrorCode(error, "ENOENT")) {
      return [];
    }
    sessionStoreError(
      `Error: cannot list sessions at ${sessionsPath}: ${errorMessage(error)}`,
    );
  }
}

export function listSessionCatalog(options: {
  readonly workspace: string;
  readonly runtime: SessionStoreRuntime;
}): SessionCatalog {
  const workspace = realpathSync(options.workspace);
  const sessions: SessionCatalogEntry[] = [];
  const warnings: SessionCatalogWarning[] = [];

  for (const sessionId of listSessionDirectories(options.runtime)) {
    try {
      const header = readCatalogHeader({
        sessionId,
        runtime: options.runtime,
      });
      if (header.workspace !== workspace) {
        continue;
      }
      sessions.push(
        sessionCatalogEntry(
          readCatalogRecords({
            sessionId,
            runtime: options.runtime,
          }),
        ),
      );
    } catch (error) {
      /* v8 ignore next 3: catalog readers convert supported per-session failures to SessionStoreError. */
      if (!(error instanceof SessionStoreError)) {
        throw error;
      }
      warnings.push({
        sessionId,
        message: formatNestedSessionStoreError(error),
      });
    }
  }

  return {
    workspace,
    sessions: sessions.sort(compareSessionCatalogEntries),
    warnings,
  };
}

function objectValue(input: object, key: string): ObjectValue {
  for (const [name, value] of Object.entries(input)) {
    if (name === key) {
      return { exists: true, value };
    }
  }
  /* v8 ignore next: same-tool canonical args share field names; this guards future schema drift. */
  return { exists: false };
}

function stableValuesEqual(left: unknown, right: unknown): boolean {
  if (
    left === null ||
    right === null ||
    typeof left !== "object" ||
    typeof right !== "object"
  ) {
    return left === right;
  }

  if (Array.isArray(left) || Array.isArray(right)) {
    /* v8 ignore next 3: same-tool canonical args keep stable field types; this guards future schema drift. */
    if (!Array.isArray(left) || !Array.isArray(right)) {
      return false;
    }
    return (
      left.length === right.length &&
      left.every((item, index) => stableValuesEqual(item, right[index]))
    );
  }

  const leftEntries = Object.entries(left);
  if (leftEntries.length !== Object.keys(right).length) {
    return false;
  }
  return leftEntries.every(([key, value]) => {
    const rightValue = objectValue(right, key);
    return rightValue.exists && stableValuesEqual(value, rightValue.value);
  });
}

function toolCallArgumentsEqual(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): boolean {
  return stableValuesEqual(left, right);
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

function sessionStateFromReplay(options: {
  readonly id: string;
  readonly filePath: string;
  readonly workspace: string;
  readonly messages: readonly Message[];
  readonly pendingInputsById: ReadonlyMap<string, SessionQueuedInput>;
  readonly bashApprovalGrants: readonly BashApprovalGrant[];
}): SessionState {
  const messages = [...options.messages];
  const pendingInputsById = new Map(options.pendingInputsById);
  const bashApprovalGrants = options.bashApprovalGrants.map(
    copyBashApprovalGrant,
  );
  const replayState = {
    messages: [...messages],
    pendingInputsById,
    bashApprovalGrants,
  };
  const session = {
    [sessionReplayStateKey]: replayState,
    id: options.id,
    filePath: options.filePath,
    workspace: options.workspace,
    messages,
    pendingInputs: pendingInputsInReplayOrder(pendingInputsById),
    bashApprovalGrants,
  };
  return session;
}

function replayStateForSession(session: SessionState): SessionReplayState {
  return session[sessionReplayStateKey];
}

function replaceReplayMessages(
  state: SessionReplayState,
  messages: readonly Message[],
): void {
  state.messages.splice(0, state.messages.length, ...messages);
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

function appendSessionSnapshotIfNeeded(options: {
  readonly session: SessionState;
  readonly runtime: SessionStoreRuntime;
}): void {
  if (
    sessionLedgerSize(options.session.filePath) <=
    SESSION_LEDGER_SNAPSHOT_THRESHOLD_BYTES
  ) {
    return;
  }

  const replayState = replayStateForSession(options.session);
  const bashApprovalGrants = replayState.bashApprovalGrants.map(
    copyBashApprovalGrant,
  );
  appendJsonLine(options.session.filePath, {
    schemaVersion: SESSION_SCHEMA_VERSION,
    type: "snapshot",
    timestamp: isoTimestamp(options.runtime),
    reason: "size_threshold",
    messages: [...replayState.messages],
    pendingInputs: pendingInputsInReplayOrder(replayState.pendingInputsById),
    ...(bashApprovalGrants.length > 0 ? { bashApprovalGrants } : {}),
  });
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

export function createSessionStore(options: {
  readonly sessionId: string;
  readonly workspace: string;
  readonly runtime: SessionStoreRuntime;
}): SessionState {
  return createEmptySessionStore(options);
}

function createEmptySessionStore(options: {
  readonly sessionId: string;
  readonly workspace: string;
  readonly runtime: SessionStoreRuntime;
  readonly forkedFrom?: string;
}): SessionState {
  const workspace = realpathSync(options.workspace);
  const filePath = sessionFilePath(options.runtime, options.sessionId);
  writeInitialHeader(filePath, {
    schemaVersion: SESSION_SCHEMA_VERSION,
    type: "session",
    id: options.sessionId,
    createdAt: isoTimestamp(options.runtime),
    workspace,
    ...(options.forkedFrom !== undefined
      ? { forkedFrom: options.forkedFrom }
      : {}),
  });
  return sessionStateFromReplay({
    id: options.sessionId,
    filePath,
    workspace,
    messages: [],
    pendingInputsById: new Map(),
    bashApprovalGrants: [],
  });
}

export function forkSessionStore(options: {
  readonly source: SessionState;
  readonly targetSessionId: string;
  readonly forkBeforeUser?: number;
  readonly runtime: SessionStoreRuntime;
}): SessionState {
  const sourceMessages = parseProviderVisibleMessages(
    options.targetSessionId,
    options.source.messages,
    "fork",
  );
  const messages =
    options.forkBeforeUser === undefined
      ? sourceMessages
      : messagesBeforeRestoredUser({
          targetSessionId: options.targetSessionId,
          messages: sourceMessages,
          userMessageNumber: options.forkBeforeUser,
        });
  validateCompletedTranscript(options.targetSessionId, messages, "fork");
  const session = createEmptySessionStore({
    sessionId: options.targetSessionId,
    workspace: options.source.workspace,
    runtime: options.runtime,
    forkedFrom: options.source.id,
  });
  const forkedSession = sessionStateFromReplay({
    id: options.targetSessionId,
    filePath: session.filePath,
    workspace: session.workspace,
    messages,
    pendingInputsById: new Map(),
    bashApprovalGrants: [],
  });
  if (messages.length > 0) {
    appendJsonLine(session.filePath, {
      schemaVersion: SESSION_SCHEMA_VERSION,
      type: "append",
      timestamp: isoTimestamp(options.runtime),
      reason: "turn",
      messages,
    });
  }
  appendSessionSnapshotIfNeeded({
    session: forkedSession,
    runtime: options.runtime,
  });
  return forkedSession;
}

function messagesBeforeRestoredUser(options: {
  readonly targetSessionId: string;
  readonly messages: readonly Message[];
  readonly userMessageNumber: number;
}): readonly Message[] {
  let userMessageCount = 0;
  for (const [index, message] of options.messages.entries()) {
    if (message.role !== "user") {
      continue;
    }
    userMessageCount += 1;
    if (userMessageCount === options.userMessageNumber) {
      return options.messages.slice(0, index);
    }
  }
  sessionStoreError(
    `Error: cannot fork session "${options.targetSessionId}": --fork-before-user ${options.userMessageNumber} exceeds restored user message count ${userMessageCount}.`,
  );
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
  let bashApprovalGrants: BashApprovalGrant[] = [];
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
      case "bash_approval_granted":
        bashApprovalGrants = [
          ...bashApprovalGrants,
          copyBashApprovalGrant(record.grant),
        ];
        break;
      case "snapshot":
        messages = [...record.messages];
        pendingInputsById.clear();
        for (const input of record.pendingInputs) {
          pendingInputsById.set(input.id, input);
        }
        bashApprovalGrants = (record.bashApprovalGrants ?? []).map(
          copyBashApprovalGrant,
        );
        break;
    }
  }
  validateCompletedTranscript(options.sessionId, messages, "resume");

  return sessionStateFromReplay({
    id: options.sessionId,
    filePath,
    workspace: expectedWorkspace,
    messages,
    pendingInputsById,
    bashApprovalGrants,
  });
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
    replaceReplayMessages(
      replayStateForSession(options.session),
      currentMessages,
    );
    if (consumedInputIds.length > 0) {
      consumeSessionQueuedInputs({
        session: options.session,
        inputIds: consumedInputIds,
        runtime: options.runtime,
      });
      appendSessionSnapshotIfNeeded({
        session: options.session,
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
    const replayState = replayStateForSession(options.session);
    replaceReplayMessages(replayState, currentMessages);
    consumeReplayInputs(replayState.pendingInputsById, consumedInputIds);
    appendSessionSnapshotIfNeeded({
      session: options.session,
      runtime: options.runtime,
    });
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
  const replayState = replayStateForSession(options.session);
  replaceReplayMessages(replayState, currentMessages);
  consumeReplayInputs(replayState.pendingInputsById, consumedInputIds);
  appendSessionSnapshotIfNeeded({
    session: options.session,
    runtime: options.runtime,
  });
  return [...currentMessages];
}

export function persistSessionBashApprovalGrant(options: {
  readonly session: SessionState;
  readonly grant: BashApprovalGrant;
  readonly runtime: SessionStoreRuntime;
}): void {
  const grant = copyBashApprovalGrant(options.grant);
  appendJsonLine(options.session.filePath, {
    schemaVersion: SESSION_SCHEMA_VERSION,
    type: "bash_approval_granted",
    timestamp: isoTimestamp(options.runtime),
    grant,
  });
  replayStateForSession(options.session).bashApprovalGrants.push(grant);
  appendSessionSnapshotIfNeeded({
    session: options.session,
    runtime: options.runtime,
  });
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
  replayStateForSession(options.session).pendingInputsById.set(
    queuedInput.id,
    queuedInput,
  );
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
  consumeReplayInputs(
    replayStateForSession(options.session).pendingInputsById,
    inputIds,
  );
}
