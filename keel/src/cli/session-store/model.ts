import type { PersistedSessionMessage } from "../../agent/session-message.ts";
import type { RecordLastBatchCheckpointOperation } from "../../core/git.ts";
import type { ProviderId } from "../../core/provider-id.ts";
import type { SessionGoal } from "../../core/session-goal.ts";
import type {
  SessionTask,
  SessionTaskProgress,
} from "../../core/task-progress.ts";
import type { BashApprovalGrant } from "../../permissions/bash.ts";
import type {
  SkillActivation,
  SkillLifecycleState,
} from "../../skills/model.ts";
import type { ToolJsonValue } from "../../tools/tool-call.ts";
import type { ToolRecoveryCapability } from "../../tools/tool-definitions.ts";

export const SESSION_SCHEMA_VERSION = 10;
export const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
export const SESSION_LOCK_DIRECTORY_NAME = "active.lock";
export const SESSION_LOCK_OWNER_FILE_NAME = "owner.json";
export const SESSION_LEDGER_RESUME_MAX_BYTES = 32 * 1024 * 1024;
export const SESSION_LEDGER_SNAPSHOT_THRESHOLD_BYTES = 16 * 1024 * 1024;
export const SESSION_LEDGER_HEADER_READ_MAX_BYTES = 64 * 1024;
export const SESSION_CATALOG_PREVIEW_MAX_LENGTH = 120;
export const SESSION_TITLE_MAX_LENGTH = 200;
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
  readonly message: PersistedSessionMessage;
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
  readonly schemaVersion: typeof SESSION_SCHEMA_VERSION;
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

export type SessionToolEffectRecoveryPolicy = "block" | "accept_unknown";

export interface SessionTaskRecoveryDisposition {
  readonly kind: "accept_unknown";
  readonly operationIds: readonly string[];
}

export interface SessionModelSwitch {
  readonly timestamp: string;
  readonly from: SessionModelSelection | null;
  readonly to: SessionModelSelection;
  readonly messageOrdinal: number;
}

interface SessionProviderAttemptUsage {
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly uncachedInputTokens: number;
  readonly outputTokens: number;
}

export type SessionProviderAttemptSettlement =
  | {
      readonly outcome: "completed";
      readonly usage: SessionProviderAttemptUsage;
    }
  | {
      readonly outcome: "retryable_error";
      readonly provider: string;
      readonly reason: string;
      readonly attempt: number;
      readonly maxRetries: number;
      readonly delayMs: number;
    }
  | { readonly outcome: "context_overflow" | "aborted" }
  | { readonly outcome: "terminal_error"; readonly errorCode: string };

export interface ActiveSessionProviderAttempt {
  readonly attemptId: string;
  readonly responseMessageId: string;
  readonly startedAt: string;
  readonly settlement?: SessionProviderAttemptSettlement;
}

export interface SessionToolContinuationEffects {
  readonly checkpointOperations: readonly RecordLastBatchCheckpointOperation[];
  readonly taskProgress?: SessionTaskProgress;
  readonly goal?: SessionGoal;
  readonly skillState?: SkillLifecycleState;
  readonly delegation?: readonly {
    readonly usage: SessionProviderAttemptUsage;
    readonly costUsd: number;
  }[];
}

interface ActiveSessionToolInvocationBase {
  readonly operationId: string;
  readonly runId: string;
  readonly resultMessageId: string;
  readonly toolCallId: string;
  readonly sourceIndex: number;
  readonly toolName: string;
  readonly recovery: ToolRecoveryCapability;
  readonly canonicalArguments: Readonly<Record<string, ToolJsonValue>>;
  readonly argumentsSha256: string;
}

type SessionToolSettlementKind =
  | "completed"
  | "not_executed_after_restart"
  | "interrupted_no_effect"
  | "interrupted_effect_unknown";

export interface SessionToolEffectReconciliation {
  readonly ownerKey: "agent_tree";
  readonly effect: "applied";
  readonly evidence: {
    readonly kind: "agent_tree_delegate";
    readonly sessionId: string;
    readonly delegationId: string;
    readonly childAgentId: string;
    readonly childRunId: string;
    readonly parentRunId: string;
    readonly parentToolCallId: string;
    readonly status:
      | "queued"
      | "running"
      | "completed"
      | "failed"
      | "turn_limited"
      | "timed_out"
      | "budget_limited"
      | "provider_blocked"
      | "cancelled"
      | "interrupted";
    readonly result: null | {
      readonly status:
        | "completed"
        | "failed"
        | "turn_limited"
        | "timed_out"
        | "budget_limited"
        | "provider_blocked"
        | "cancelled"
        | "interrupted";
      readonly finalText: string | null;
      readonly error: string | null;
      readonly pendingInputCount: number;
    };
  };
}

export type ActiveSessionToolInvocation = ActiveSessionToolInvocationBase &
  (
    | {
        readonly phase: "planned";
        readonly startedAt?: never;
        readonly settledAt?: never;
        readonly kind?: never;
        readonly toolMessage?: never;
        readonly effects?: never;
      }
    | {
        readonly phase: "effect_pending";
        readonly startedAt: string;
        readonly reconciliation?: SessionToolEffectReconciliation;
        readonly settledAt?: never;
        readonly kind?: never;
        readonly toolMessage?: never;
        readonly effects?: never;
      }
    | {
        readonly phase: "settled";
        readonly startedAt?: string;
        readonly settledAt: string;
        readonly kind: SessionToolSettlementKind;
        readonly reconciliation?: SessionToolEffectReconciliation;
        readonly toolMessage: StoredMessage;
        readonly effects: SessionToolContinuationEffects;
      }
  );

interface ActiveSessionTaskBase {
  readonly taskId: string;
  readonly runId: string;
  readonly trigger: "user_prompt";
  readonly admittedAt: string;
  readonly userMessageId: string;
  readonly provider: SessionModelSelection;
  readonly maxProviderReplacements: number;
  readonly providerReplacementsUsed: number;
  readonly recovered: boolean;
  readonly providerRequestIds: readonly {
    readonly attemptId: string;
    readonly responseMessageId: string;
  }[];
  readonly unknownProviderAttemptIds: readonly string[];
  readonly toolEffectRecoveryPolicy: SessionToolEffectRecoveryPolicy;
  readonly acceptedUnknownEffectOperationIds: readonly string[];
}

export type ActiveSessionTask = ActiveSessionTaskBase &
  (
    | {
        readonly phase: "provider_ready";
        readonly providerAttempt?: never;
        readonly assistantMessage?: never;
        readonly stopReason?: never;
      }
    | {
        readonly phase: "provider_pending";
        readonly providerAttempt: ActiveSessionProviderAttempt;
        readonly assistantMessage?: never;
        readonly stopReason?: never;
      }
    | {
        readonly phase: "provider_settled";
        readonly providerAttempt: ActiveSessionProviderAttempt & {
          readonly settlement: Extract<
            SessionProviderAttemptSettlement,
            { readonly outcome: "completed" }
          >;
        };
        readonly assistantMessage: StoredMessage;
        readonly stopReason: "stop" | "length";
      }
    | {
        readonly phase: "tool_execution";
        readonly providerAttempt: ActiveSessionProviderAttempt & {
          readonly settlement: Extract<
            SessionProviderAttemptSettlement,
            { readonly outcome: "completed" }
          >;
        };
        readonly assistantMessage: StoredMessage;
        readonly stopReason: "stop" | "length";
        readonly toolInvocations: readonly ActiveSessionToolInvocation[];
      }
    | {
        readonly phase: "recovery_blocked";
        readonly providerAttempt?: ActiveSessionProviderAttempt;
        readonly assistantMessage?: StoredMessage;
        readonly stopReason?: "stop" | "length";
        readonly toolInvocations?: readonly ActiveSessionToolInvocation[];
        readonly reason:
          | "provider_replacement_limit"
          | "provider_budget"
          | "tool_effect";
      }
  );

export interface SessionLastTaskOutcome {
  readonly taskId: string;
  readonly runId: string;
  readonly outcome:
    | "completed"
    | "completed_with_unknown_effects"
    | "failed"
    | "aborted";
  readonly timestamp: string;
  readonly recovered: boolean;
  readonly unknownProviderAttemptIds: readonly string[];
  readonly unknownToolEffectOperationIds: readonly string[];
  readonly responseMessageId?: string;
}

export interface AppendSessionRecord {
  readonly schemaVersion: typeof SESSION_SCHEMA_VERSION;
  readonly type: "append";
  readonly timestamp: string;
  readonly reason: "turn";
  readonly messages: readonly StoredMessage[];
  readonly skillState?: SkillLifecycleState;
  readonly consumedInputIds?: readonly string[];
}

export interface ReplaceSessionRecord {
  readonly schemaVersion: typeof SESSION_SCHEMA_VERSION;
  readonly type: "replace";
  readonly timestamp: string;
  readonly reason: "turn" | "compaction";
  readonly messages: readonly StoredMessage[];
  readonly skillState?: SkillLifecycleState;
  readonly consumedInputIds?: readonly string[];
}

export interface ModelSwitchSessionRecord {
  readonly schemaVersion: typeof SESSION_SCHEMA_VERSION;
  readonly type: "model_switch";
  readonly timestamp: string;
  readonly from: SessionModelSelection | null;
  readonly to: SessionModelSelection;
  readonly consumedInputIds?: readonly string[];
}

export interface SessionTitleSessionRecord {
  readonly schemaVersion: typeof SESSION_SCHEMA_VERSION;
  readonly type: "session_title";
  readonly timestamp: string;
  readonly title: string;
  readonly consumedInputIds?: readonly string[];
}

export interface SessionGoalSessionRecord {
  readonly schemaVersion: typeof SESSION_SCHEMA_VERSION;
  readonly type: "session_goal";
  readonly timestamp: string;
  readonly goal: SessionGoal | null;
  readonly consumedInputIds?: readonly string[];
}

interface TaskProgressSessionRecord {
  readonly schemaVersion: typeof SESSION_SCHEMA_VERSION;
  readonly type: "task_progress";
  readonly timestamp: string;
  readonly messageOrdinal: number;
  readonly tasks: readonly SessionTask[];
}

export interface SessionTaskProgressCheckpoint {
  readonly messageOrdinal: number;
  readonly taskProgress: SessionTaskProgress;
}

interface InputAdmittedSessionRecord {
  readonly schemaVersion: typeof SESSION_SCHEMA_VERSION;
  readonly type: "input_admitted";
  readonly timestamp: string;
  readonly id: string;
  readonly sequence: number;
  readonly line: string;
}

interface InputConsumedSessionRecord {
  readonly schemaVersion: typeof SESSION_SCHEMA_VERSION;
  readonly type: "input_consumed";
  readonly timestamp: string;
  readonly inputIds: readonly string[];
}

interface BashApprovalGrantedSessionRecord {
  readonly schemaVersion: typeof SESSION_SCHEMA_VERSION;
  readonly type: "bash_approval_granted";
  readonly timestamp: string;
  readonly grant: BashApprovalGrant;
}

interface BashApprovalRevokedSessionRecord {
  readonly schemaVersion: typeof SESSION_SCHEMA_VERSION;
  readonly type: "bash_approval_revoked";
  readonly timestamp: string;
  readonly grant: BashApprovalGrant;
  readonly consumedInputIds?: readonly string[];
}

interface BashApprovalsClearedSessionRecord {
  readonly schemaVersion: typeof SESSION_SCHEMA_VERSION;
  readonly type: "bash_approvals_cleared";
  readonly timestamp: string;
  readonly consumedInputIds?: readonly string[];
}

interface TaskAdmittedSessionRecord {
  readonly schemaVersion: typeof SESSION_SCHEMA_VERSION;
  readonly type: "task_admitted";
  readonly timestamp: string;
  readonly task: Extract<
    ActiveSessionTask,
    { readonly phase: "provider_ready" }
  >;
  readonly userMessage: StoredMessage;
  readonly consumedInputIds?: readonly string[];
}

interface ProviderIntentSessionRecord {
  readonly schemaVersion: typeof SESSION_SCHEMA_VERSION;
  readonly type: "provider_intent";
  readonly timestamp: string;
  readonly task: Extract<
    ActiveSessionTask,
    { readonly phase: "provider_pending" }
  >;
}

interface ProviderAttemptSettledSessionRecord {
  readonly schemaVersion: typeof SESSION_SCHEMA_VERSION;
  readonly type: "provider_attempt_settled";
  readonly timestamp: string;
  readonly task: Extract<
    ActiveSessionTask,
    { readonly phase: "provider_pending" }
  > & {
    readonly providerAttempt: ActiveSessionProviderAttempt & {
      readonly settlement: SessionProviderAttemptSettlement;
    };
  };
}

interface ProviderSettledSessionRecord {
  readonly schemaVersion: typeof SESSION_SCHEMA_VERSION;
  readonly type: "provider_settled";
  readonly timestamp: string;
  readonly task: Extract<
    ActiveSessionTask,
    { readonly phase: "provider_settled" | "tool_execution" }
  >;
}

interface ToolIntentSessionRecord {
  readonly schemaVersion: typeof SESSION_SCHEMA_VERSION;
  readonly type: "tool_intent";
  readonly timestamp: string;
  readonly task: Extract<
    ActiveSessionTask,
    { readonly phase: "tool_execution" }
  >;
  readonly operationIds: readonly string[];
}

interface ToolSettledSessionRecord {
  readonly schemaVersion: typeof SESSION_SCHEMA_VERSION;
  readonly type: "tool_settled";
  readonly timestamp: string;
  readonly task: Extract<
    ActiveSessionTask,
    { readonly phase: "tool_execution" }
  >;
  readonly operationId: string;
}

interface EffectReconciledSessionRecord {
  readonly schemaVersion: typeof SESSION_SCHEMA_VERSION;
  readonly type: "effect_reconciled";
  readonly timestamp: string;
  readonly task: Extract<
    ActiveSessionTask,
    { readonly phase: "tool_execution" }
  >;
  readonly operationId: string;
  readonly reconciliation: SessionToolEffectReconciliation;
}

interface TaskRecoveryDispositionSessionRecord {
  readonly schemaVersion: typeof SESSION_SCHEMA_VERSION;
  readonly type: "task_recovery_disposition";
  readonly timestamp: string;
  readonly task: Extract<
    ActiveSessionTask,
    { readonly phase: "tool_execution" }
  >;
  readonly disposition: SessionTaskRecoveryDisposition;
}

interface TaskRecoveryStartedSessionRecord {
  readonly schemaVersion: typeof SESSION_SCHEMA_VERSION;
  readonly type: "task_recovery_started";
  readonly timestamp: string;
  readonly task: Extract<
    ActiveSessionTask,
    { readonly phase: "provider_ready" | "recovery_blocked" }
  >;
}

interface StepCommittedSessionRecord {
  readonly schemaVersion: typeof SESSION_SCHEMA_VERSION;
  readonly type: "step_committed";
  readonly timestamp: string;
  readonly task: Extract<
    ActiveSessionTask,
    { readonly phase: "provider_ready" | "recovery_blocked" }
  >;
  readonly messages: readonly StoredMessage[];
  readonly replaceTranscript?: true;
  readonly consumedInputIds?: readonly string[];
}

interface TaskTerminalSessionRecord {
  readonly schemaVersion: typeof SESSION_SCHEMA_VERSION;
  readonly type: "task_terminal";
  readonly timestamp: string;
  readonly taskId: string;
  readonly runId: string;
  readonly messages: readonly StoredMessage[];
  readonly replaceTranscript?: true;
  readonly lastTaskOutcome: SessionLastTaskOutcome;
  readonly skillState?: SkillLifecycleState;
  readonly consumedInputIds?: readonly string[];
}

export interface SnapshotSessionRecord {
  readonly schemaVersion: typeof SESSION_SCHEMA_VERSION;
  readonly type: "snapshot";
  readonly timestamp: string;
  readonly reason: "size_threshold";
  readonly title?: string;
  readonly goal?: SessionGoal;
  readonly messages: readonly StoredMessage[];
  readonly pendingInputs: readonly SessionQueuedInput[];
  readonly bashApprovalGrants?: readonly BashApprovalGrant[];
  readonly activeModel?: SessionModelSelection;
  readonly modelSwitches?: readonly SessionModelSwitch[];
  readonly taskProgressCheckpoints?: readonly SessionTaskProgressCheckpoint[];
  readonly skillStateCheckpoints: readonly SessionSkillStateCheckpoint[];
  readonly activeTask?: ActiveSessionTask;
  readonly lastTaskOutcome?: SessionLastTaskOutcome;
}

export interface SkillStateSessionRecord {
  readonly schemaVersion: typeof SESSION_SCHEMA_VERSION;
  readonly type: "skill_state";
  readonly timestamp: string;
  readonly messageOrdinal: number;
  readonly skillActivations: readonly SkillActivation[];
  readonly activeSkillIds: readonly string[];
  readonly consumedInputIds?: readonly string[];
}

export interface SessionSkillStateCheckpoint extends SkillLifecycleState {
  readonly messageOrdinal: number;
}

export type SessionMutationRecord =
  | AppendSessionRecord
  | ReplaceSessionRecord
  | ModelSwitchSessionRecord
  | SessionTitleSessionRecord
  | SessionGoalSessionRecord
  | TaskProgressSessionRecord
  | InputAdmittedSessionRecord
  | InputConsumedSessionRecord
  | BashApprovalGrantedSessionRecord
  | BashApprovalRevokedSessionRecord
  | BashApprovalsClearedSessionRecord
  | TaskAdmittedSessionRecord
  | ProviderIntentSessionRecord
  | ProviderAttemptSettledSessionRecord
  | ProviderSettledSessionRecord
  | ToolIntentSessionRecord
  | EffectReconciledSessionRecord
  | ToolSettledSessionRecord
  | TaskRecoveryDispositionSessionRecord
  | TaskRecoveryStartedSessionRecord
  | StepCommittedSessionRecord
  | TaskTerminalSessionRecord
  | SkillStateSessionRecord
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
  readonly title?: string;
  readonly goal?: SessionGoal;
  readonly messages: readonly PersistedSessionMessage[];
  readonly storedMessages: readonly StoredMessage[];
  readonly pendingInputs: readonly SessionQueuedInput[];
  readonly bashApprovalGrants: readonly BashApprovalGrant[];
  readonly taskProgress: SessionTaskProgress;
  readonly activeModel?: SessionModelSelection;
  readonly modelSwitches: readonly SessionModelSwitch[];
  readonly skillActivations: readonly SkillActivation[];
  readonly activeSkillIds: readonly string[];
  readonly activeTask?: ActiveSessionTask;
  readonly lastTaskOutcome?: SessionLastTaskOutcome;
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
  readonly workflowSkills: readonly SessionCatalogWorkflowSkill[];
  readonly title?: string;
  readonly goal?: SessionGoal;
  readonly preview: string;
  readonly pendingInputCount: number;
  readonly taskProgress: SessionTaskProgress;
  readonly lastTaskOutcome?: SessionLastTaskOutcome;
}

export interface SessionCatalogWorkflowSkill {
  readonly qualifiedName: string;
  readonly relativePath: string;
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
  readonly title?: string;
  readonly goal?: SessionGoal;
  readonly preview: CatalogPreviewState;
  readonly pendingInputsById: Map<string, SessionQueuedInput>;
  readonly taskProgress: SessionTaskProgress;
  readonly skillActivations: readonly SkillActivation[];
  readonly activeSkillIds: readonly string[];
  readonly lastTaskOutcome?: SessionLastTaskOutcome;
}

export interface SessionReplayState {
  readonly storedMessages: StoredMessage[];
  readonly pendingInputsById: Map<string, SessionQueuedInput>;
  readonly bashApprovalGrants: BashApprovalGrant[];
  taskProgress: SessionTaskProgress;
  readonly taskProgressCheckpoints: SessionTaskProgressCheckpoint[];
  title?: string;
  goal?: SessionGoal;
  activeModel?: SessionModelSelection;
  readonly modelSwitches: SessionModelSwitch[];
  readonly skillStateCheckpoints: SessionSkillStateCheckpoint[];
  activeTask?: ActiveSessionTask;
  lastTaskOutcome?: SessionLastTaskOutcome;
}

export interface SnapshotSearchResult {
  readonly index: number;
  readonly record: SnapshotSessionRecord;
}

export interface SessionLock {
  readonly lockPath: string;
  readonly release: () => void;
}
