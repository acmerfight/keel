import type { Message } from "../llm/types.ts";

interface AgentMemoryScope {
  readonly kind: "project";
  readonly id: string;
}

export interface AgentMemoryEntry {
  readonly id: string;
  readonly text: string;
}

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
    };

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

interface AgentMemoryToolContext {
  readonly capability: AgentMemoryMutationCapability;
  readonly currentUserMessage: () => Extract<
    Message,
    { readonly role: "user" }
  > | null;
  readonly claimSourceMutation: (
    message: Extract<Message, { readonly role: "user" }>,
  ) => boolean;
}

export type { AgentMemoryToolContext };

type MemoryIntentValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

export function validateAgentMemoryAdd(options: {
  readonly currentUserMessage: Extract<
    Message,
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
    Message,
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
