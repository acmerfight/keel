import type { LineReader, QueuedLine } from "./line-reader.ts";

interface NumberedPickerSelection {
  readonly choice: number;
}

interface NumberedPickerSelected {
  readonly kind: "selected";
  readonly selection: NumberedPickerSelection;
  readonly consumedLines: readonly QueuedLine[];
}

interface NumberedPickerCancelled {
  readonly kind: "cancelled";
  readonly consumedLines: readonly QueuedLine[];
  readonly explicit: boolean;
}

export type NumberedPickerResult =
  | NumberedPickerSelected
  | NumberedPickerCancelled;

function parseNumberedPickerSelection(options: {
  readonly rawSelection: string;
  readonly minChoice: number;
  readonly maxChoice: number;
}): NumberedPickerSelection | "cancelled" | "invalid" {
  const selection = options.rawSelection.trim().toLowerCase();
  if (selection === "q" || selection === "quit" || selection === "cancel") {
    return "cancelled";
  }
  if (!/^(0|[1-9][0-9]*)$/u.test(selection)) {
    return "invalid";
  }

  const choice = Number(selection);
  if (
    !Number.isSafeInteger(choice) ||
    choice < options.minChoice ||
    choice > options.maxChoice
  ) {
    return "invalid";
  }
  return { choice };
}

export async function readNumberedPickerSelection(options: {
  readonly minChoice: number;
  readonly maxChoice: number;
  readonly prompt: string;
  readonly invalidSelectionMessage: string;
  readonly lineReader: LineReader;
  readonly writeStdout: (text: string) => void;
  readonly writeStderr: (text: string) => void;
}): Promise<NumberedPickerResult> {
  const consumedLines: QueuedLine[] = [];
  for (;;) {
    const rawSelection = await options.lineReader.readLine();
    if (rawSelection === null) {
      return {
        kind: "cancelled",
        consumedLines,
        explicit: false,
      };
    }
    consumedLines.push(rawSelection);
    const selection = parseNumberedPickerSelection({
      rawSelection: rawSelection.line,
      minChoice: options.minChoice,
      maxChoice: options.maxChoice,
    });
    if (selection === "cancelled") {
      return {
        kind: "cancelled",
        consumedLines,
        explicit: true,
      };
    }
    if (selection === "invalid") {
      options.writeStderr(`${options.invalidSelectionMessage}\n`);
      options.writeStdout(options.prompt);
      continue;
    }
    return {
      kind: "selected",
      selection,
      consumedLines,
    };
  }
}
