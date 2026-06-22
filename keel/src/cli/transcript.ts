import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Message } from "../llm/types.ts";

interface RunTranscriptInput {
  readonly provider: string;
  readonly model: string;
  readonly systemPrompt: string;
  readonly messages: readonly Message[];
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
  readonly message: Message;
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
      systemPrompt: input.systemPrompt,
    },
    ...input.messages.map((message) => ({ type: "message" as const, message })),
  ];
  writeFileSync(
    filePath,
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
    "utf8",
  );
}
