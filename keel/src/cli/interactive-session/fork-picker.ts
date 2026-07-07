import type { LineReader } from "./line-reader.ts";
import {
  type NumberedPickerResult,
  readNumberedPickerSelection,
} from "./numbered-picker.ts";

function formatForkPointSelectionPrompt(maxChoice: number): string {
  return `Select fork point [0-${maxChoice}], or q to cancel:\n`;
}

export async function readForkPointPickerSelection(options: {
  readonly maxChoice: number;
  readonly lineReader: LineReader;
  readonly writeStdout: (text: string) => void;
  readonly writeStderr: (text: string) => void;
}): Promise<NumberedPickerResult> {
  return readNumberedPickerSelection({
    minChoice: 0,
    maxChoice: options.maxChoice,
    prompt: formatForkPointSelectionPrompt(options.maxChoice),
    invalidSelectionMessage: `Error: selection must be 0-${options.maxChoice} or q.`,
    lineReader: options.lineReader,
    writeStdout: options.writeStdout,
    writeStderr: options.writeStderr,
  });
}
