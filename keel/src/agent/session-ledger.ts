import type { ProviderMessage } from "../llm/types.ts";
import type { SessionMessage } from "./session-message.ts";

export interface SessionLedger {
  readonly messages: () => readonly SessionMessage[];
  readonly append: (message: SessionMessage) => void;
  readonly appendMany: (messages: readonly SessionMessage[]) => void;
  readonly replace: (messages: readonly SessionMessage[]) => void;
}

export function sessionLedgerFromMessages(
  messages: readonly SessionMessage[],
): SessionLedger {
  let currentMessages = [...messages];
  return {
    messages: () => currentMessages,
    append: (message) => {
      currentMessages = [...currentMessages, message];
    },
    appendMany: (nextMessages) => {
      if (nextMessages.length === 0) return;
      currentMessages = [...currentMessages, ...nextMessages];
    },
    replace: (nextMessages) => {
      currentMessages = [...nextMessages];
    },
  };
}

export function appendSessionLedgerMessage(
  ledger: SessionLedger,
  message: SessionMessage,
): SessionLedger {
  ledger.append(message);
  return ledger;
}

export function appendSessionLedgerMessages(
  ledger: SessionLedger,
  messages: readonly SessionMessage[],
): SessionLedger {
  ledger.appendMany(messages);
  return ledger;
}

export function projectSessionLedgerToProviderMessages(
  ledger: SessionLedger,
): readonly ProviderMessage[] {
  return ledger.messages().map(projectSessionMessageToProvider);
}

export function projectSessionMessageToProvider(
  message: SessionMessage,
): ProviderMessage {
  switch (message.role) {
    case "user":
      return {
        role: "user",
        content: message.content,
      };
    case "assistant":
      return {
        role: "assistant",
        content: message.content,
        toolCalls: message.toolCalls,
        ...(message.providerMetadata === undefined
          ? {}
          : { providerMetadata: message.providerMetadata }),
      };
    case "tool":
      return {
        role: "tool",
        toolCallId: message.toolCallId,
        content: message.content,
      };
  }
}

export function sessionLedgerMessages(
  ledger: SessionLedger,
): readonly SessionMessage[] {
  return ledger.messages();
}

export function replaceSessionLedgerMessages(
  ledger: SessionLedger,
  messages: readonly SessionMessage[],
): void {
  ledger.replace(messages);
}
