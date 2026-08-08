import type { Usage } from "../llm/types.ts";

interface SubmittedAgentEvidence {
  readonly path: string;
  readonly line?: number;
  readonly detail: string;
}

export interface SubmittedAgentResult {
  readonly summary: string;
  readonly evidence: readonly SubmittedAgentEvidence[];
  readonly risks: readonly string[];
}

export interface AgentResultSubmissionCapability {
  readonly submit: (result: SubmittedAgentResult) => boolean;
  readonly accepted: () => SubmittedAgentResult | null;
}

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
  readonly delegate: (input: {
    readonly toolCallId: string;
    readonly task: string;
    readonly focusPaths: readonly string[];
    readonly signal: AbortSignal;
  }) => Promise<DelegationToolResult>;
}

export function createAgentResultSubmissionCapability(): AgentResultSubmissionCapability {
  let submitted: SubmittedAgentResult | null = null;
  return {
    submit: (result) => {
      if (submitted !== null) return false;
      submitted = {
        summary: result.summary,
        evidence: result.evidence.map((evidence) => ({ ...evidence })),
        risks: [...result.risks],
      };
      return true;
    },
    accepted: () => submitted,
  };
}
