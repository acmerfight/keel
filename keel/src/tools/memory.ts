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
    sourceText: string,
  ) => { readonly id: string; readonly scope: AgentMemoryScope };
  readonly forget: (
    id: string,
    sourceText: string,
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

const REMEMBER_INTENT =
  /^(?:(?:please|kindly)\s+|(?:can|could|would)\s+you\s+|i\s+(?:want|need)\s+you\s+to\s+)?remember(?:\s+(?:that|this))?(?:\s*[:,—-])?\s+([\s\S]+?)\s*[.!]?\s*$/iu;
const FORGET_INTENT =
  /^(?:(?:please|kindly)\s+|(?:can|could|would)\s+you\s+|i\s+(?:want|need)\s+you\s+to\s+)?forget(?:\s+(?:that|this))?(?:\s*[:,—-])?\s+([\s\S]+?)\s*[.!]?\s*$/iu;

const FORGET_QUERY_STOP_WORDS: ReadonlySet<string> = new Set([
  "a",
  "about",
  "an",
  "entry",
  "fact",
  "memory",
  "one",
  "project",
  "saved",
  "says",
  "that",
  "the",
  "this",
]);

function sourceSpanStart(message: string, sourceText: string): number | null {
  const first = message.indexOf(sourceText);
  if (first < 0 || message.indexOf(sourceText, first + 1) >= 0) return null;
  const prefix = message.slice(0, first);
  if (
    prefix.trim() !== "" &&
    !prefix.endsWith("\n") &&
    !/[.!?]\s*$/u.test(prefix)
  )
    return null;
  const suffix = message.slice(first + sourceText.length);
  if (suffix !== "") {
    if (suffix.startsWith("\n")) return first;
    if (!/[.!?]\s*$/u.test(sourceText) || !/^\s+/u.test(suffix)) return null;
  }
  return first;
}

function rememberClaim(sourceText: string): string | null {
  const match = REMEMBER_INTENT.exec(sourceText);
  return match?.[1]?.trim() ?? null;
}

function forgetQuery(sourceText: string): string | null {
  const match = FORGET_INTENT.exec(sourceText);
  return match?.[1]?.trim() ?? null;
}

export function hasExplicitAgentMemoryIntent(userMessage: string): boolean {
  return userMessage
    .trim()
    .split(/(?<=[.!?])\s+|\r?\n/u)
    .some(
      (sourceUnit) =>
        rememberClaim(sourceUnit) !== null || forgetQuery(sourceUnit) !== null,
    );
}

function textMatchesClaim(text: string, claim: string): boolean {
  if (text === claim) return true;
  return text === claim.replace(/[.!]$/u, "").trimEnd();
}

function validateSourceSpan(
  currentUserMessage: Extract<Message, { readonly role: "user" }> | null,
  sourceText: string,
): MemoryIntentValidation {
  if (currentUserMessage === null) {
    return {
      ok: false,
      reason: "no eligible current-user message authorizes memory mutation",
    };
  }
  const sourceWithoutFinalPunctuation = sourceText
    .trim()
    .replace(/[.!?]$/u, "");
  if (
    /[\r\n]/u.test(sourceText) ||
    /[.!?]\s+/u.test(sourceWithoutFinalPunctuation)
  ) {
    return {
      ok: false,
      reason:
        "sourceText must be one exact current-user sentence or standalone line",
    };
  }
  if (sourceSpanStart(currentUserMessage.content, sourceText) === null) {
    return {
      ok: false,
      reason:
        "sourceText must be one exact current-user sentence or standalone line",
    };
  }
  return { ok: true };
}

export function validateAgentMemoryAdd(options: {
  readonly currentUserMessage: Extract<
    Message,
    { readonly role: "user" }
  > | null;
  readonly sourceText: string;
  readonly text: string;
}): MemoryIntentValidation {
  const source = validateSourceSpan(
    options.currentUserMessage,
    options.sourceText,
  );
  if (!source.ok) return source;
  const claim = rememberClaim(options.sourceText);
  if (claim === null) {
    return {
      ok: false,
      reason:
        "current-user source is not a direct unambiguous remember request",
    };
  }
  if (
    !options.sourceText.includes(options.text) ||
    !textMatchesClaim(options.text, claim)
  ) {
    return {
      ok: false,
      reason:
        "text must be copied exactly from the durable claim in sourceText without paraphrasing or broadening",
    };
  }
  return { ok: true };
}

function words(text: string): readonly string[] {
  return (text.toLocaleLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? []).filter(
    (word) => !FORGET_QUERY_STOP_WORDS.has(word),
  );
}

function uniquelyMatchingMemoryId(
  entries: readonly AgentMemoryEntry[],
  query: string,
): string | null {
  const exactIdMatches = entries.filter((entry) => query.includes(entry.id));
  if (exactIdMatches.length === 1) return exactIdMatches[0]?.id ?? null;
  if (exactIdMatches.length > 1) return null;

  const queryWords = [...new Set(words(query))];
  if (queryWords.length === 0) return null;

  const matchingEntries = entries.filter((entry) => {
    const entryWords = new Set(words(entry.text));
    return queryWords.every((word) => entryWords.has(word));
  });
  return matchingEntries.length === 1 ? (matchingEntries[0]?.id ?? null) : null;
}

export function validateAgentMemoryForget(options: {
  readonly currentUserMessage: Extract<
    Message,
    { readonly role: "user" }
  > | null;
  readonly sourceText: string;
  readonly id: string;
  readonly entries: readonly AgentMemoryEntry[];
}): MemoryIntentValidation {
  const source = validateSourceSpan(
    options.currentUserMessage,
    options.sourceText,
  );
  if (!source.ok) return source;
  const query = forgetQuery(options.sourceText);
  if (query === null) {
    return {
      ok: false,
      reason: "current-user source is not a direct unambiguous forget request",
    };
  }
  const matchingId = uniquelyMatchingMemoryId(options.entries, query);
  if (matchingId === null) {
    return {
      ok: false,
      reason:
        "ambiguous current-user forget request; ask the user to choose one active memory ID",
    };
  }
  if (matchingId !== options.id) {
    return {
      ok: false,
      reason:
        "requested memory ID does not match the one entry identified by sourceText",
    };
  }
  return { ok: true };
}
