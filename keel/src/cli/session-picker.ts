import { createInterface } from "node:readline/promises";
import {
  createLineReader,
  type LineReader,
  type QueuedLine,
} from "./interactive-session/line-reader.ts";
import {
  type NumberedPickerResult,
  type NumberedPickerSelection,
  readNumberedPickerSelection,
} from "./interactive-session/numbered-picker.ts";
import type { CliRuntime } from "./runtime.ts";

export type SessionPickerResult = NumberedPickerResult & {
  readonly initialInputLines: readonly string[];
};

function formatSessionSelectionPrompt(maxChoice: number): string {
  return `Select session [1-${maxChoice}], or q to cancel:\n`;
}

function initialInputLinesAfter(
  lineReader: LineReader,
  consumedLines: readonly QueuedLine[],
): readonly string[] {
  const lastConsumedSequence = consumedLines.at(-1)?.sequence ?? 0;
  return lineReader
    .drainLinesAfter(lastConsumedSequence)
    .map((line) => line.line);
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
    return {
      ...pickerResult,
      initialInputLines: initialInputLinesAfter(
        lineReader,
        pickerResult.consumedLines,
      ),
    };
  } finally {
    input.close();
  }
}

type SessionStartupAction = "resume-latest" | "pick" | "new";

export type SessionStartupSelectionResult =
  | {
      readonly kind: "resume-latest";
      readonly initialInputLines: readonly string[];
    }
  | {
      readonly kind: "pick";
      readonly selection: NumberedPickerSelection;
      readonly initialInputLines: readonly string[];
    }
  | {
      readonly kind: "new";
      readonly initialInputLines: readonly string[];
    }
  | {
      readonly kind: "cancelled";
      readonly explicit: boolean;
      readonly source: "startup" | "picker";
    };

function parseSessionStartupAction(
  rawSelection: string,
): SessionStartupAction | "cancelled" | "invalid" {
  const selection = rawSelection.trim().toLowerCase();
  if (selection === "" || selection === "y" || selection === "yes") {
    return "resume-latest";
  }
  if (selection === "p" || selection === "pick") {
    return "pick";
  }
  if (selection === "n" || selection === "new") {
    return "new";
  }
  if (selection === "q" || selection === "quit" || selection === "cancel") {
    return "cancelled";
  }
  return "invalid";
}

export async function readSessionStartupSelection(options: {
  readonly input: CliRuntime["input"];
  readonly maxChoice: number;
  readonly startupPrompt: string;
  readonly pickerPrompt: string;
  readonly writeStdout: (text: string) => void;
  readonly writeStderr: (text: string) => void;
}): Promise<SessionStartupSelectionResult> {
  const input = createInterface({
    input: options.input,
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  const lineReader = createLineReader(input, {});
  try {
    for (;;) {
      const rawSelection = await lineReader.readLine();
      if (rawSelection === null) {
        return {
          kind: "cancelled",
          explicit: false,
          source: "startup",
        };
      }
      const action = parseSessionStartupAction(rawSelection.line);
      if (action === "cancelled") {
        return {
          kind: "cancelled",
          explicit: true,
          source: "startup",
        };
      }
      if (action === "invalid") {
        options.writeStderr("Error: choose Enter/y, p, n, or q.\n");
        options.writeStdout(options.startupPrompt);
        continue;
      }
      if (action === "pick") {
        options.writeStdout(options.pickerPrompt);
        const pickerResult = await readNumberedPickerSelection({
          minChoice: 1,
          maxChoice: options.maxChoice,
          prompt: formatSessionSelectionPrompt(options.maxChoice),
          invalidSelectionMessage: `Error: selection must be 1-${options.maxChoice} or q.`,
          lineReader,
          writeStdout: options.writeStdout,
          writeStderr: options.writeStderr,
        });
        if (pickerResult.kind === "cancelled") {
          return {
            kind: "cancelled",
            explicit: pickerResult.explicit,
            source: "picker",
          };
        }
        return {
          kind: "pick",
          selection: pickerResult.selection,
          initialInputLines: initialInputLinesAfter(
            lineReader,
            pickerResult.consumedLines,
          ),
        };
      }
      return {
        kind: action,
        initialInputLines: initialInputLinesAfter(lineReader, [rawSelection]),
      };
    }
  } finally {
    input.close();
  }
}
