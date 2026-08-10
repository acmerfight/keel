import { errorMessage, KeelError } from "../core/error.ts";
import { RunReportWriteError } from "./report.ts";

function formatKeelError(error: KeelError): string {
  const message = error.message.startsWith("Error: ")
    ? error.message
    : `Error: ${error.message}`;
  if (error.recovery === undefined) return `${message}\n`;
  return `${message}\nRecovery: ${error.recovery}\n`;
}

function firstErrorLine(error: unknown): string {
  return errorMessage(error)
    .replace(/[\r\n][\s\S]*/u, "")
    .trim();
}

export function formatCliRuntimeError(error: unknown): string {
  if (error instanceof KeelError) return formatKeelError(error);
  if (error instanceof RunReportWriteError) return `${error.message}\n`;
  return `Error: unexpected runtime failure: ${firstErrorLine(error)}\n`;
}

export function createCliRuntimeErrorReporter(
  writeStderr: (text: string) => void,
): (error: unknown) => void {
  return (error) => {
    writeStderr(formatCliRuntimeError(error));
  };
}
