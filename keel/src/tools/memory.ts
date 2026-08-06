import type { SessionMessage } from "../agent/session-message.ts";
import type { ProviderId } from "../core/provider-id.ts";

interface AgentMemoryScope {
  readonly kind: "project";
  readonly id: string;
}

export interface AgentMemoryEntry {
  readonly id: string;
  readonly text: string;
}

type AgentMemoryProposalOutcome =
  | {
      readonly outcome: "approved";
      readonly memoryId: string;
    }
  | {
      readonly outcome: "rejected";
      readonly memoryId: null;
    }
  | {
      readonly outcome: "pending";
      readonly memoryId: null;
    };

export type AgentMemoryProposalResult = {
  readonly candidateId: string;
  readonly scope: AgentMemoryScope;
} & AgentMemoryProposalOutcome;

export type AgentMemoryOperation =
  | {
      readonly operation: "add";
      readonly id: string;
      readonly scope: AgentMemoryScope;
      readonly outcome: "saved";
    }
  | {
      readonly operation: "forget";
      readonly id: string;
      readonly scope: AgentMemoryScope;
      readonly outcome: "forgotten";
    }
  | ({ readonly operation: "propose" } & AgentMemoryProposalResult);

export interface AgentMemoryMutationCapability {
  readonly list: () => readonly AgentMemoryEntry[];
  readonly add: (
    text: string,
    evidence: string,
  ) => { readonly id: string; readonly scope: AgentMemoryScope };
  readonly forget: (
    id: string,
    evidence: string,
  ) => { readonly id: string; readonly scope: AgentMemoryScope };
}

interface AgentMemoryProposal {
  readonly kind:
    | "user_preference"
    | "feedback"
    | "project_context"
    | "reference";
  readonly statement: string;
  readonly why: string;
  readonly sourceQuote: string;
  readonly conflictMemoryIds: readonly string[];
}

export interface AgentMemoryProposalSource {
  readonly sessionId: string;
  readonly messageId: string;
  readonly providerId: ProviderId;
  readonly model: string;
}

export interface AgentMemoryProposalReviewRequest {
  readonly candidateId: string;
  readonly scope: AgentMemoryScope;
  readonly kind: AgentMemoryProposal["kind"];
  readonly statement: string;
  readonly why: string;
  readonly sourceQuote: string;
  readonly conflictMemoryIds: readonly string[];
}

export type AgentMemoryProposalReviewDecision =
  | { readonly type: "approve" }
  | { readonly type: "reject" }
  | { readonly type: "pending" };

export interface AgentMemoryProposalCapability {
  readonly propose: (
    proposal: AgentMemoryProposal,
    source: AgentMemoryProposalSource,
    review: (
      request: AgentMemoryProposalReviewRequest,
      signal: AbortSignal,
    ) => Promise<AgentMemoryProposalReviewDecision>,
    signal: AbortSignal,
  ) => Promise<AgentMemoryProposalResult>;
}

interface AgentMemoryProposalToolCapability {
  readonly capability: AgentMemoryProposalCapability;
  readonly sourceFor: (
    message: Extract<SessionMessage, { readonly role: "user" }>,
  ) => AgentMemoryProposalSource | undefined;
  readonly persistSource: (
    message: Extract<SessionMessage, { readonly role: "user" }>,
  ) => void;
  readonly review: (
    request: AgentMemoryProposalReviewRequest,
    signal: AbortSignal,
  ) => Promise<AgentMemoryProposalReviewDecision>;
}

export type AgentMemoryRuntime<Proposal = AgentMemoryProposalToolCapability> =
  | {
      readonly kind: "direct";
      readonly prompt: () => string;
      readonly mutation: AgentMemoryMutationCapability;
    }
  | {
      readonly kind: "reviewed";
      readonly prompt: () => string;
      readonly mutation: AgentMemoryMutationCapability;
      readonly proposal: Proposal;
    };

interface AgentMemoryToolContext {
  readonly capability: AgentMemoryMutationCapability;
  readonly proposal: AgentMemoryProposalToolCapability | null;
  readonly currentUserMessage: () => Extract<
    SessionMessage,
    { readonly role: "user" }
  > | null;
  readonly claimSourceMutation: (
    message: Extract<SessionMessage, { readonly role: "user" }>,
  ) => boolean;
}

export type { AgentMemoryToolContext };

type MemoryIntentValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

export function validateAgentMemoryAdd(options: {
  readonly currentUserMessage: Extract<
    SessionMessage,
    { readonly role: "user" }
  > | null;
  readonly text: string;
}): MemoryIntentValidation {
  if (options.currentUserMessage === null) {
    return {
      ok: false,
      reason: "no eligible current-user message authorizes memory mutation",
    };
  }
  if (
    options.text.trim() === "" ||
    !options.currentUserMessage.content.includes(options.text)
  ) {
    return {
      ok: false,
      reason:
        "text must be one exact contiguous span from the current-user message without paraphrasing or broadening",
    };
  }
  return { ok: true };
}

export function validateAgentMemoryForget(options: {
  readonly currentUserMessage: Extract<
    SessionMessage,
    { readonly role: "user" }
  > | null;
  readonly id: string;
  readonly entries: readonly AgentMemoryEntry[];
}): MemoryIntentValidation {
  if (options.currentUserMessage === null) {
    return {
      ok: false,
      reason: "no eligible current-user message authorizes memory mutation",
    };
  }
  if (!options.entries.some((entry) => entry.id === options.id)) {
    return {
      ok: false,
      reason: "requested memory ID is not active in this project",
    };
  }
  return { ok: true };
}

export function validateAgentMemoryProposal(options: {
  readonly currentUserMessage: Extract<
    SessionMessage,
    { readonly role: "user" }
  > | null;
  readonly sourceQuote: string;
  readonly source: AgentMemoryProposalSource | undefined;
}): MemoryIntentValidation {
  if (options.currentUserMessage === null || options.source === undefined) {
    return {
      ok: false,
      reason:
        "reviewed memory is unavailable without a saved current-user message",
    };
  }
  if (
    options.sourceQuote.trim() === "" ||
    !options.currentUserMessage.content.includes(options.sourceQuote)
  ) {
    return {
      ok: false,
      reason:
        "sourceQuote must be one exact contiguous span from the current-user message",
    };
  }
  return { ok: true };
}
