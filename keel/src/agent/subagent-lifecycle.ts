import type { Usage } from "../llm/types.ts";
import type { SessionLedgerObserver } from "./session-ledger.ts";
import type { SessionMessage } from "./session-message.ts";

export const subagentNonCompletedStatuses = [
  "failed",
  "turn_limited",
  "timed_out",
  "budget_limited",
  "provider_blocked",
  "cancelled",
  "interrupted",
] as const;

export const subagentTerminalStatuses = [
  "completed",
  ...subagentNonCompletedStatuses,
] as const;

export type SubagentTerminalStatus = (typeof subagentTerminalStatuses)[number];

export class SubagentPersistenceError extends Error {}

export type AgentId = `agent-${string}`;
export type SubagentRunId = `subagent-${string}`;
export type SubagentRunMode = "foreground" | "background";

export type SubagentRunLineage =
  | { readonly kind: "root" }
  | {
      readonly kind: "continuation";
      readonly previousRunId: SubagentRunId;
    };

interface SubagentRunIdentity {
  readonly delegationId: string;
  readonly childAgentId: AgentId;
  readonly childRunId: SubagentRunId;
  readonly parentRunId: string;
  readonly parentToolCallId: string;
  readonly task: string;
  readonly focusPaths: readonly string[];
}

export interface SubagentAcceptedLifecycle extends SubagentRunIdentity {
  readonly lineage: SubagentRunLineage;
  readonly mode: SubagentRunMode;
  readonly providerId: string;
  readonly model: string;
  readonly systemPrompt: string;
}

interface SubagentRejectedLifecycle {
  readonly delegationId: string;
  readonly parentRunId: string;
  readonly parentToolCallId: string;
  readonly task: string;
  readonly reason: string;
}

export interface SubagentAccountingSnapshot {
  readonly usage: Usage;
  readonly turns: number;
  readonly costUsd: number;
}

interface SubagentTerminalInputSnapshot {
  readonly pendingInputCount: number;
}

export type SubagentTerminalOutcome =
  | {
      readonly status: "completed";
      readonly finalText: string;
      readonly error: null;
    }
  | {
      readonly status: (typeof subagentNonCompletedStatuses)[number];
      readonly finalText: null;
      readonly error: string;
    };

export type SubagentTerminalSnapshot = SubagentAccountingSnapshot &
  SubagentTerminalInputSnapshot &
  SubagentTerminalOutcome;

type SubagentQueuedTerminalSnapshot = SubagentAccountingSnapshot &
  SubagentTerminalInputSnapshot & {
    readonly status: "cancelled";
    readonly finalText: null;
    readonly error: string;
  };

interface SubagentCanonicalResultBase extends SubagentAccountingSnapshot {
  readonly delegationId: string;
  readonly childAgentId: AgentId;
  readonly childRunId: SubagentRunId;
  readonly task: string;
  readonly transcriptRef: string | null;
  readonly pendingInputCount: number;
}

export type SubagentCanonicalResult = SubagentCanonicalResultBase &
  SubagentTerminalOutcome;

export type PersistedSubagentCanonicalResult = SubagentCanonicalResult & {
  readonly transcriptRef: string;
};

export interface SubagentResultDeliveryReference {
  readonly sessionId: string;
  readonly delegationId: string;
  readonly childAgentId: AgentId;
  readonly childRunId: SubagentRunId;
  readonly canonicalResultSha256: string;
}

export interface SubagentResultDelivery
  extends SubagentResultDeliveryReference {
  readonly projection: string;
}

interface SubagentPersistenceBase {
  readonly transcriptRef: string;
  readonly transcript: SessionLedgerObserver;
  readonly pendingInput: (
    messages: readonly Extract<SessionMessage, { readonly role: "user" }>[],
  ) => void;
}

export interface SubagentRunningPersistence extends SubagentPersistenceBase {
  readonly accounting: (snapshot: SubagentAccountingSnapshot) => void;
  readonly terminal: (snapshot: SubagentTerminalSnapshot) => void;
}

export interface SubagentRunPersistence extends SubagentPersistenceBase {
  readonly running: () => SubagentRunningPersistence;
  readonly terminal: (snapshot: SubagentQueuedTerminalSnapshot) => void;
}

export interface SubagentLifecyclePersistence {
  readonly accepted: (
    lifecycle: SubagentAcceptedLifecycle,
  ) => SubagentRunPersistence;
  readonly rejected: (lifecycle: SubagentRejectedLifecycle) => void;
}
