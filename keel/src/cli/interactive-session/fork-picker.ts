import type { LineReader, QueuedLine } from "./line-reader.ts";

interface ForkPointSelection {
  readonly choice: number;
}

interface ForkPointPickerSelection {
  readonly kind: "selected";
  readonly selection: ForkPointSelection;
  readonly consumedLines: readonly QueuedLine[];
}

interface ForkPointPickerCancelled {
  readonly kind: "cancelled";
  readonly consumedLines: readonly QueuedLine[];
  readonly explicit: boolean;
}

type ForkPointPickerResult =
  | ForkPointPickerSelection
  | ForkPointPickerCancelled;

function formatForkPointSelectionPrompt(maxChoice: number): string {
  return `Select fork point [0-${maxChoice}], or q to cancel:\n`;
}

function parseForkPointSelection(
  rawSelection: string,
  maxChoice: number,
): ForkPointSelection | "cancelled" | "invalid" {
  const selection = rawSelection.trim().toLowerCase();
  if (selection === "0") {
    return { choice: 0 };
  }
  if (selection === "q" || selection === "quit" || selection === "cancel") {
    return "cancelled";
  }
  if (!/^[1-9][0-9]*$/u.test(selection)) {
    return "invalid";
  }

  const choice = Number(selection);
  if (!Number.isSafeInteger(choice) || choice > maxChoice) {
    return "invalid";
  }
  return { choice };
}

export async function readForkPointPickerSelection(options: {
  readonly maxChoice: number;
  readonly lineReader: LineReader;
  readonly writeStdout: (text: string) => void;
  readonly writeStderr: (text: string) => void;
}): Promise<ForkPointPickerResult> {
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
    const selection = parseForkPointSelection(
      rawSelection.line,
      options.maxChoice,
    );
    if (selection === "cancelled") {
      return {
        kind: "cancelled",
        consumedLines,
        explicit: true,
      };
    }
    if (selection === "invalid") {
      options.writeStderr(
        `Error: selection must be 0-${options.maxChoice} or q.\n`,
      );
      options.writeStdout(formatForkPointSelectionPrompt(options.maxChoice));
      continue;
    }
    return {
      kind: "selected",
      selection,
      consumedLines,
    };
  }
}
