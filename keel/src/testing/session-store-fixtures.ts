import { expect } from "vitest";
import type { SessionMessage } from "../agent/session-message.ts";
import type { SessionQueuedInput } from "../cli/session-store.ts";

export function runtime(home: string, now = 0) {
  return {
    env: (key: string) => (key === "KEEL_HOME" ? home : undefined),
    now: () => now,
  };
}

export function rootGraph(sessionId: string) {
  return {
    graphId: sessionId,
    rootSessionId: sessionId,
    parentSessionId: null,
    branchTitle: "main",
    forkPoint: null,
    forkPolicy: {
      transcript: "copy_prefix",
      pendingInputs: "drop",
      queuedInputs: "drop",
      bashApprovalGrants: "drop",
    },
  };
}

export function storedMessages(
  messages: readonly SessionMessage[],
  prefix = "stored-message",
) {
  return messages.map((message, index) => ({
    id: `${prefix}-${index + 1}`,
    message,
  }));
}

export function expectedStoredMessages(messages: readonly SessionMessage[]) {
  return messages.map((message) => ({
    id: expect.any(String),
    message,
  }));
}

export function restoredUserMessageId(
  session: {
    readonly storedMessages: readonly {
      readonly id: string;
      readonly message: SessionMessage;
    }[];
  },
  content: string,
): string {
  const storedMessage = session.storedMessages.find(
    (candidate) =>
      candidate.message.role === "user" &&
      candidate.message.content === content,
  );
  if (storedMessage === undefined) {
    throw new Error(`expected restored user message id for ${content}`);
  }
  return storedMessage.id;
}

export function headerLine(sessionId: string, workspace: string): string {
  return JSON.stringify({
    schemaVersion: 9,
    type: "session",
    id: sessionId,
    createdAt: "1970-01-01T00:00:00.000Z",
    workspace,
    graph: rootGraph(sessionId),
  });
}

export function appendLine(messages: readonly SessionMessage[]): string {
  return JSON.stringify({
    schemaVersion: 9,
    type: "append",
    timestamp: "1970-01-01T00:00:00.000Z",
    reason: "turn",
    messages: storedMessages(messages),
  });
}

export function snapshotLine(
  messages: readonly SessionMessage[],
  pendingInputs: readonly SessionQueuedInput[],
  snapshotState?: {
    readonly title?: string;
    readonly activeModel?: {
      readonly providerId: "fake" | "deepseek" | "kimi" | "qwen";
      readonly model: string;
    };
    readonly modelSwitches?: readonly {
      readonly timestamp: string;
      readonly from: {
        readonly providerId: "fake" | "deepseek" | "kimi" | "qwen";
        readonly model: string;
      } | null;
      readonly to: {
        readonly providerId: "fake" | "deepseek" | "kimi" | "qwen";
        readonly model: string;
      };
      readonly messageOrdinal: number;
    }[];
  },
): string {
  return JSON.stringify({
    schemaVersion: 9,
    type: "snapshot",
    timestamp: "1970-01-01T00:00:00.000Z",
    reason: "size_threshold",
    messages: storedMessages(messages),
    pendingInputs,
    skillStateCheckpoints: [
      { messageOrdinal: 0, skillActivations: [], activeSkillIds: [] },
    ],
    ...(snapshotState !== undefined ? snapshotState : {}),
  });
}

export function inputAdmittedLine(input: SessionQueuedInput): string {
  return JSON.stringify({
    schemaVersion: 9,
    type: "input_admitted",
    timestamp: input.timestamp,
    id: input.id,
    sequence: input.sequence,
    line: input.line,
  });
}

export function inputConsumedLine(inputIds: readonly string[]): string {
  return JSON.stringify({
    schemaVersion: 9,
    type: "input_consumed",
    timestamp: "1970-01-01T00:00:00.005Z",
    inputIds,
  });
}
