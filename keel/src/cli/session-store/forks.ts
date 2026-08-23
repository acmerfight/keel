import type { SessionMessage } from "../../agent/session-message.ts";
import { normalizeSessionPreview } from "./catalog.ts";
import { sessionStoreError } from "./errors.ts";
import type {
  SessionForkPointRecord,
  SessionForkPolicyRecord,
  SessionGraphRecord,
  SessionState,
  StoredMessage,
} from "./model.ts";
import { copySessionForkPointRecord, copyStoredMessage } from "./records.ts";

function defaultSessionForkPolicy(): SessionForkPolicyRecord {
  return {
    transcript: "copy_prefix",
    pendingInputs: "drop",
    queuedInputs: "drop",
  };
}

function rootSessionGraph(sessionId: string): SessionGraphRecord {
  return {
    graphId: sessionId,
    rootSessionId: sessionId,
    parentSessionId: null,
    branchTitle: "main",
    forkPoint: null,
    forkPolicy: defaultSessionForkPolicy(),
  };
}

function messageForkPreview(message: SessionMessage): string {
  return normalizeSessionPreview(message.content);
}

function endForkPoint(source: SessionState): SessionForkPointRecord {
  const lastMessage = source.storedMessages.at(-1);
  return {
    kind: "end",
    sourceSessionId: source.id,
    sourceLastMessageId: lastMessage?.id ?? null,
    sourceOrdinal: source.storedMessages.length,
    preview: "full restored history",
  };
}

function beforeMessageForkPoint(options: {
  readonly source: SessionState;
  readonly storedMessage: StoredMessage;
  readonly sourceOrdinal: number;
}): SessionForkPointRecord {
  return {
    kind: "before_message",
    sourceSessionId: options.source.id,
    sourceMessageId: options.storedMessage.id,
    sourceOrdinal: options.sourceOrdinal,
    preview: messageForkPreview(options.storedMessage.message),
  };
}

function forkSessionGraph(options: {
  readonly source: SessionState;
  readonly targetSessionId: string;
  readonly forkPoint: SessionForkPointRecord;
}): SessionGraphRecord {
  return {
    graphId: options.source.graph.graphId,
    rootSessionId: options.source.graph.rootSessionId,
    parentSessionId: options.source.id,
    branchTitle: options.targetSessionId,
    forkPoint: copySessionForkPointRecord(options.forkPoint),
    forkPolicy: defaultSessionForkPolicy(),
  };
}

function storedMessagesBeforeMessage(options: {
  readonly targetSessionId: string;
  readonly source: SessionState;
  readonly beforeMessageId: string;
  readonly optionName: string;
}): {
  readonly storedMessages: readonly StoredMessage[];
  readonly forkPoint: SessionForkPointRecord;
} {
  for (const [
    index,
    storedMessage,
  ] of options.source.storedMessages.entries()) {
    if (storedMessage.id === options.beforeMessageId) {
      return {
        storedMessages: options.source.storedMessages
          .slice(0, index)
          .map(copyStoredMessage),
        forkPoint: beforeMessageForkPoint({
          source: options.source,
          storedMessage,
          sourceOrdinal: index + 1,
        }),
      };
    }
  }
  sessionStoreError(
    `Error: cannot fork session "${options.targetSessionId}": ${options.optionName} ${options.beforeMessageId} does not match a restored message id in session "${options.source.id}".`,
  );
}

export {
  endForkPoint,
  forkSessionGraph,
  rootSessionGraph,
  storedMessagesBeforeMessage,
};
