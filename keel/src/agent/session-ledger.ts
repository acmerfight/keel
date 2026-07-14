import type { Message } from "../llm/types.ts";

interface SessionMessageEntry {
  readonly type: "message";
  readonly message: Message;
}

export interface SessionLedger {
  readonly entries: readonly SessionMessageEntry[];
}

export function sessionLedgerFromMessages(
  messages: readonly Message[],
): SessionLedger {
  return {
    entries: messages.map((message) => ({
      type: "message",
      message,
    })),
  };
}

export function appendSessionLedgerMessage(
  ledger: SessionLedger,
  message: Message,
): SessionLedger {
  return {
    entries: [...ledger.entries, { type: "message", message }],
  };
}

export function appendSessionLedgerMessages(
  ledger: SessionLedger,
  messages: readonly Message[],
): SessionLedger {
  if (messages.length === 0) {
    return ledger;
  }
  return {
    entries: [
      ...ledger.entries,
      ...messages.map(
        (message): SessionMessageEntry => ({ type: "message", message }),
      ),
    ],
  };
}

export function projectSessionLedgerToProviderMessages(
  ledger: SessionLedger,
): readonly Message[] {
  return ledger.entries.map((entry) =>
    projectSessionMessageToProvider(entry.message),
  );
}

export function projectSessionMessageToProvider(message: Message): Message {
  switch (message.role) {
    case "user":
      return {
        role: "user",
        content: message.content,
        ...(message.contextCompaction === undefined
          ? {}
          : { contextCompaction: message.contextCompaction }),
      };
    case "assistant":
      return message;
    case "tool":
      if (message.resourceObservation === undefined) {
        return message;
      }
      return {
        role: "tool",
        toolCallId: message.toolCallId,
        content: message.content,
        ...(message.sourceTruncated !== undefined
          ? { sourceTruncated: message.sourceTruncated }
          : {}),
      };
  }
}

export function sessionLedgerMessages(
  ledger: SessionLedger,
): readonly Message[] {
  return ledger.entries.map((entry) => entry.message);
}

export function syncMessagesFromSessionLedger(
  target: Message[],
  ledger: SessionLedger,
): void {
  target.splice(0, target.length, ...sessionLedgerMessages(ledger));
}
