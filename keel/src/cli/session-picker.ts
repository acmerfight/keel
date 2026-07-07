import { createInterface } from "node:readline/promises";
import { createLineReader } from "./interactive-session/line-reader.ts";
import {
  type NumberedPickerResult,
  readNumberedPickerSelection,
} from "./interactive-session/numbered-picker.ts";
import type { CliRuntime } from "./runtime.ts";

export type SessionPickerResult = NumberedPickerResult & {
  readonly initialInputLines: readonly string[];
};

function formatSessionSelectionPrompt(maxChoice: number): string {
  return `Select session [1-${maxChoice}], or q to cancel:\n`;
}

export async function readSessionPickerSelection(options: {
  readonly input: CliRuntime["input"];
  readonly maxChoice: number;
  readonly writeStdout: (text: string) => void;
  readonly writeStderr: (text: string) => void;
}): Promise<SessionPickerResult> {
  const input = createInterface({
    input: options.input,
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  const lineReader = createLineReader(input, {});
  try {
    const pickerResult = await readNumberedPickerSelection({
      minChoice: 1,
      maxChoice: options.maxChoice,
      prompt: formatSessionSelectionPrompt(options.maxChoice),
      invalidSelectionMessage: `Error: selection must be 1-${options.maxChoice} or q.`,
      lineReader,
      writeStdout: options.writeStdout,
      writeStderr: options.writeStderr,
    });
    const lastConsumedSequence =
      pickerResult.consumedLines.at(-1)?.sequence ?? 0;
    return {
      ...pickerResult,
      initialInputLines: lineReader
        .drainLinesAfter(lastConsumedSequence)
        .map((line) => line.line),
    };
  } finally {
    input.close();
  }
}
