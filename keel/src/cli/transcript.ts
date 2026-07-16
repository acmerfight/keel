import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { projectSessionMessageToProvider } from "../agent/session-ledger.ts";
import type { Message } from "../llm/types.ts";
import {
  redactMessageForPersistence,
  redactTextForPersistence,
} from "./persistence-redaction.ts";

interface RunTranscriptInput {
  readonly provider: string;
  readonly model: string;
  readonly systemPrompt: string;
  readonly messages: readonly Message[];
}

interface TranscriptHeader {
  readonly schemaVersion: 2;
  readonly type: "transcript";
  readonly provider: string;
  readonly model: string;
  readonly systemPrompt: string;
}

interface TranscriptMessage {
  readonly type: "message";
  readonly message: Message;
}

interface TranscriptReadObservation {
  readonly type: "read_observation";
  readonly toolCallId: string;
  readonly targetPathSha256: string;
}

type TranscriptRecord =
  | TranscriptHeader
  | TranscriptMessage
  | TranscriptReadObservation;

function transcriptRecordsForMessage(
  message: Message,
): readonly (TranscriptMessage | TranscriptReadObservation)[] {
  const persistedMessage: TranscriptMessage = {
    type: "message",
    message: redactMessageForPersistence(
      projectSessionMessageToProvider(message),
    ),
  };
  if (message.role !== "tool" || message.resourceObservation === undefined) {
    return [persistedMessage];
  }
  return [
    persistedMessage,
    {
      type: "read_observation",
      toolCallId: message.toolCallId,
      targetPathSha256: message.resourceObservation.targetPathSha256,
    },
  ];
}

export function writeRunTranscript(
  filePath: string,
  input: RunTranscriptInput,
): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const records: TranscriptRecord[] = [
    {
      schemaVersion: 2,
      type: "transcript",
      provider: input.provider,
      model: input.model,
      systemPrompt: redactTextForPersistence(input.systemPrompt),
    },
    ...input.messages.flatMap(transcriptRecordsForMessage),
  ];
  writeFileSync(
    filePath,
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
    "utf8",
  );
}
