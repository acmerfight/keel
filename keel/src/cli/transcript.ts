import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { projectSessionMessageToProvider } from "../agent/session-ledger.ts";
import type { SessionMessage } from "../agent/session-message.ts";
import type { ProviderMessage } from "../llm/types.ts";
import {
  redactProviderMessageForPersistence,
  redactTextForPersistence,
} from "./persistence-redaction.ts";

interface RunTranscriptInput {
  readonly provider: string;
  readonly model: string;
  readonly systemPrompt: string;
  readonly messages: readonly SessionMessage[];
}

interface TranscriptHeader {
  readonly schemaVersion: 1;
  readonly type: "transcript";
  readonly provider: string;
  readonly model: string;
  readonly systemPrompt: string;
}

interface TranscriptMessage {
  readonly type: "message";
  readonly message: ProviderMessage;
}

type TranscriptRecord = TranscriptHeader | TranscriptMessage;

export function writeRunTranscript(
  filePath: string,
  input: RunTranscriptInput,
): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const records: TranscriptRecord[] = [
    {
      schemaVersion: 1,
      type: "transcript",
      provider: input.provider,
      model: input.model,
      systemPrompt: redactTextForPersistence(input.systemPrompt),
    },
    ...input.messages.map((message) => ({
      type: "message" as const,
      message: redactProviderMessageForPersistence(
        projectSessionMessageToProvider(message),
      ),
    })),
  ];
  writeFileSync(
    filePath,
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
    "utf8",
  );
}
