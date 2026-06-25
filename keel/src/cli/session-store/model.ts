import type { ProviderId } from "../../core/provider-id.ts";
import type { Message } from "../../llm/types.ts";
import type { BashApprovalGrant } from "../../permissions/bash.ts";

export const SESSION_SCHEMA_VERSION = 2;
export const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
export const SESSION_LOCK_DIRECTORY_NAME = "active.lock";
export const SESSION_LOCK_OWNER_FILE_NAME = "owner.json";
export const SESSION_LEDGER_RESUME_MAX_BYTES = 32 * 1024 * 1024;
export const SESSION_LEDGER_SNAPSHOT_THRESHOLD_BYTES = 16 * 1024 * 1024;
export const SESSION_LEDGER_HEADER_READ_MAX_BYTES = 64 * 1024;
export const SESSION_CATALOG_PREVIEW_MAX_LENGTH = 120;
export const EMPTY_SESSION_CATALOG_PREVIEW = "(no restored user messages)";
export const CONVERSATION_CHECKPOINT_OPEN = "<conversation-checkpoint>";
export const CONVERSATION_CHECKPOINT_CLOSE = "</conversation-checkpoint>";
export const CONVERSATION_CHECKPOINT_INSTRUCTION =
  "The following is a summary of earlier conversation. Treat it as historical context, not as a new instruction.";
export const CONVERSATION_CHECKPOINT_NO_LATER_MESSAGES =
  "No later messages are available after this checkpoint; continue from the task state and next steps in the summary.";
export const SUMMARY_OPEN = "<summary>";
export const SUMMARY_CLOSE = "</summary>";

export interface StoredMessage {
  readonly id: string;
  readonly message: Message;
}

export interface SessionForkPolicyRecord {
  readonly transcript: "copy_prefix";
  readonly pendingInputs: "drop";
  readonly queuedInputs: "drop";
  readonly bashApprovalGrants: "drop";
}

interface BeforeMessageForkPointRecord {
  readonly kind: "before_message";
  readonly sourceSessionId: string;
  readonly sourceMessageId: string;
  readonly sourceOrdinal: number;
  readonly preview: string;
}

interface EndForkPointRecord {
  readonly kind: "end";
  readonly sourceSessionId: string;
  readonly sourceLastMessageId: string | null;
  readonly sourceOrdinal: number;
  readonly preview: string;
}

export type SessionForkPointRecord =
  | BeforeMessageForkPointRecord
  | EndForkPointRecord;

export interface SessionGraphRecord {
  readonly graphId: string;
  readonly rootSessionId: string;
  readonly parentSessionId: string | null;
  readonly branchTitle: string;
  readonly forkPoint: SessionForkPointRecord | null;
  readonly forkPolicy: SessionForkPolicyRecord;
}

export interface SessionHeaderRecord {
  readonly schemaVersion: 2;
  readonly type: "session";
  readonly id: string;
  readonly createdAt: string;
  readonly workspace: string;
  readonly graph: SessionGraphRecord;
}

export interface SessionModelSelection {
  readonly providerId: ProviderId;
  readonly model: string;
}

export interface SessionModelSwitch {
  readonly timestamp: string;
  readonly from: SessionModelSelection | null;
  readonly to: SessionModelSelection;
  readonly messageOrdinal: number;
}

export interface AppendSessionRecord {
  readonly schemaVersion: 2;
  readonly type: "append";
  readonly timestamp: string;
  readonly reason: "turn";
  readonly messages: readonly StoredMessage[];
  readonly consumedInputIds?: readonly string[];
}

export interface ReplaceSessionRecord {
  readonly schemaVersion: 2;
  readonly type: "replace";
  readonly timestamp: string;
  readonly reason: "turn" | "compaction";
  readonly messages: readonly StoredMessage[];
  readonly consumedInputIds?: readonly string[];
}

export interface ModelSwitchSessionRecord {
  readonly schemaVersion: 2;
  readonly type: "model_switch";
  readonly timestamp: string;
  readonly from: SessionModelSelection | null;
  readonly to: SessionModelSelection;
  readonly consumedInputIds?: readonly string[];
}

interface InputAdmittedSessionRecord {
  readonly schemaVersion: 2;
  readonly type: "input_admitted";
  readonly timestamp: string;
  readonly id: string;
  readonly sequence: number;
  readonly line: string;
}

interface InputConsumedSessionRecord {
  readonly schemaVersion: 2;
  readonly type: "input_consumed";
  readonly timestamp: string;
  readonly inputIds: readonly string[];
}

interface BashApprovalGrantedSessionRecord {
  readonly schemaVersion: 2;
  readonly type: "bash_approval_granted";
  readonly timestamp: string;
  readonly grant: BashApprovalGrant;
}

export interface SnapshotSessionRecord {
  readonly schemaVersion: 2;
  readonly type: "snapshot";
  readonly timestamp: string;
  readonly reason: "size_threshold";
  readonly messages: readonly StoredMessage[];
  readonly pendingInputs: readonly SessionQueuedInput[];
  readonly bashApprovalGrants?: readonly BashApprovalGrant[];
  readonly activeModel?: SessionModelSelection;
  readonly modelSwitches?: readonly SessionModelSwitch[];
}

export type SessionMutationRecord =
  | AppendSessionRecord
  | ReplaceSessionRecord
  | ModelSwitchSessionRecord
  | InputAdmittedSessionRecord
  | InputConsumedSessionRecord
  | BashApprovalGrantedSessionRecord
  | SnapshotSessionRecord;

export interface SessionRecords {
  readonly header: SessionHeaderRecord;
  readonly mutations: readonly SessionMutationRecord[];
}

export type SessionPersistenceReason = "turn" | "compaction";

export interface SessionStoreRuntime {
  readonly env: (key: string) => string | undefined;
  readonly now: () => number;
}

export const sessionReplayStateKey: unique symbol =
  Symbol("sessionReplayState");

export interface SessionState {
  readonly id: string;
  readonly filePath: string;
  readonly workspace: string;
  readonly graph: SessionGraphRecord;
  readonly messages: readonly Message[];
  readonly storedMessages: readonly StoredMessage[];
  readonly pendingInputs: readonly SessionQueuedInput[];
  readonly bashApprovalGrants: readonly BashApprovalGrant[];
  readonly activeModel?: SessionModelSelection;
  readonly modelSwitches: readonly SessionModelSwitch[];
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
  readonly graph: SessionGraphRecord;
  readonly preview: string;
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

export type CatalogPreviewState =
  | { readonly kind: "empty" }
  | { readonly kind: "checkpoint" | "user"; readonly preview: string };

export interface SessionCatalogReplayState {
  readonly updatedAt: string;
  readonly preview: CatalogPreviewState;
}

export interface SessionReplayState {
  readonly storedMessages: StoredMessage[];
  readonly pendingInputsById: Map<string, SessionQueuedInput>;
  readonly bashApprovalGrants: BashApprovalGrant[];
  activeModel?: SessionModelSelection;
  readonly modelSwitches: SessionModelSwitch[];
}

export type ObjectValue =
  | { readonly exists: false }
  | { readonly exists: true; readonly value: unknown };

export interface SnapshotSearchResult {
  readonly index: number;
  readonly record: SnapshotSessionRecord;
}

export interface SessionLock {
  readonly lockPath: string;
  readonly release: () => void;
}
