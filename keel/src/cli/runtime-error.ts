import { KeelError } from "../core/error.ts";
import { RunReportWriteError } from "./report.ts";

function formatKeelError(error: KeelError): string {
  const message = error.message.startsWith("Error: ")
    ? error.message
    : `Error: ${error.message}`;
  if (error.recovery === undefined) return `${message}\n`;
  return `${message}\nRecovery: ${error.recovery}\n`;
}

export function formatCliRuntimeError(error: unknown): string | null {
  if (error instanceof KeelError) return formatKeelError(error);
  if (error instanceof RunReportWriteError) return `${error.message}\n`;
  return null;
}
