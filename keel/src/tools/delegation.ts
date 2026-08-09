import type { Usage } from "../llm/types.ts";

interface DelegationToolResultBase {
  readonly ok: boolean;
  readonly content: string;
}

export type DelegationToolResult =
  | (DelegationToolResultBase & {
      readonly delivery: "fresh";
      readonly usage: Usage;
    })
  | (DelegationToolResultBase & {
      readonly delivery: "replayed";
      readonly usage?: never;
    })
  | (DelegationToolResultBase & {
      readonly delivery: "rejected";
      readonly ok: false;
      readonly usage?: never;
    });

export interface DelegationRequest {
  readonly toolCallId: string;
  readonly task: string;
  readonly focusPaths: readonly string[];
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
  readonly close: () => void;
}

export interface DelegationCapability {
  readonly available: () => boolean;
  readonly delegate: (
    input: DelegationRequest,
  ) => Promise<DelegationToolResult>;
  readonly prepareBatch: (
    entries: readonly DelegationBatchEntry[],
  ) => DelegationBatch;
}
