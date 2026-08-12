import type {
  SubagentMcpToolSelector,
  SubagentProfileName,
} from "../agent/subagent-capability.ts";
import type { SubagentProfileCatalog } from "../agent/subagent-profile.ts";
import type { ProviderContinuationLease, Usage } from "../llm/types.ts";

interface DeliveredDelegationToolResultBase {
  readonly ok: boolean;
  readonly content: string;
}

export type DelegationToolResult =
  | (DeliveredDelegationToolResultBase & {
      readonly delivery: "fresh";
      readonly usage: Usage;
      readonly costUsd: number;
    })
  | (DeliveredDelegationToolResultBase & {
      readonly delivery: "background";
      readonly ok: true;
      readonly usage?: never;
    })
  | (DeliveredDelegationToolResultBase & {
      readonly delivery: "replayed";
      readonly usage?: never;
    })
  | {
      readonly delivery: "rejected";
      readonly ok: false;
      readonly reason: string;
      readonly recovery: string;
      readonly maxResultChars: number;
      readonly content?: never;
      readonly usage?: never;
    };

export function projectDelegationRejection(
  rejection: Pick<
    Extract<DelegationToolResult, { readonly delivery: "rejected" }>,
    "reason" | "recovery" | "maxResultChars"
  >,
): string {
  const prefix = "Tool failed: ";
  const recovery = `\nRecovery: ${rejection.recovery}`;
  const reasonChars = Math.max(
    0,
    rejection.maxResultChars - prefix.length - recovery.length,
  );
  return `${prefix}${rejection.reason.slice(0, reasonChars)}${recovery}`.slice(
    0,
    rejection.maxResultChars,
  );
}

export interface DelegationRequest {
  readonly toolCallId: string;
  readonly profile: SubagentProfileName;
  readonly mode: "foreground" | "background";
  readonly task: string;
  readonly focusPaths: readonly string[];
  readonly skills?: readonly string[];
  readonly mcp: readonly SubagentMcpToolSelector[];
  readonly signal: AbortSignal;
}

export type DelegationBatchEntry =
  | {
      readonly kind: "request";
      readonly request: DelegationRequest;
    }
  | {
      readonly kind: "result";
      readonly toolCallId: string;
      readonly content: string;
    };

const preparedDelegationExecutor = Symbol("preparedDelegationExecutor");

export interface DelegationExecutor {
  readonly [preparedDelegationExecutor]: true;
  readonly delegate: (
    input: DelegationRequest,
  ) => Promise<DelegationToolResult>;
}

export function createDelegationExecutor(
  delegate: DelegationExecutor["delegate"],
): DelegationExecutor {
  return { [preparedDelegationExecutor]: true, delegate };
}

export interface DelegationBatch {
  readonly executor: DelegationExecutor;
  readonly continuation?: ProviderContinuationLease;
  readonly close: () => void;
}

export interface DelegationCapability {
  readonly mode: "foreground" | "background";
  readonly profileCatalog: SubagentProfileCatalog;
  readonly available: () => boolean;
  readonly delegate: (
    input: DelegationRequest,
  ) => Promise<DelegationToolResult>;
  readonly prepareBatch: (
    entries: readonly DelegationBatchEntry[],
  ) => DelegationBatch;
}

export type ForegroundDelegationCapability = DelegationCapability & {
  readonly mode: "foreground";
};
