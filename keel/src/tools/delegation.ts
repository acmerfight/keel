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

export interface DelegationCapability {
  readonly available: () => boolean;
  readonly delegate: (input: {
    readonly toolCallId: string;
    readonly task: string;
    readonly focusPaths: readonly string[];
    readonly signal: AbortSignal;
  }) => Promise<DelegationToolResult>;
}
