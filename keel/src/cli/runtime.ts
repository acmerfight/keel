import { writeSync } from "node:fs";
import { isAbortThrow } from "../core/error.ts";
import { formatCliRuntimeError } from "./runtime-error.ts";
import type { SessionStoreRuntime } from "./session-store.ts";

interface CliInput extends NodeJS.ReadableStream {
  readonly isTTY?: boolean;
}

export interface CliRuntime extends SessionStoreRuntime {
  readonly args: readonly string[];
  readonly cliEntry: string;
  readonly cwd: () => string;
  readonly input: CliInput;
  readonly platform: NodeJS.Platform;
  readonly stderrIsTTY?: boolean;
  readonly writeStdout: (text: string) => void;
  readonly writeStderr: (text: string) => void;
  readonly onSigint: (handler: () => void) => void;
  readonly offSigint: (handler: () => void) => void;
  readonly forceExit: (code: number) => never;
}

export async function withCliRuntimeErrorBoundary(
  runtime: CliRuntime,
  action: () => Promise<number>,
): Promise<number> {
  try {
    return await action();
  } catch (error) {
    return writeCliRuntimeError(runtime, error);
  }
}

function writeCliRuntimeError(
  runtime: Pick<CliRuntime, "writeStderr">,
  error: unknown,
): number {
  if (isAbortThrow(error)) return 130;
  runtime.writeStderr(formatCliRuntimeError(error));
  return 1;
}

/* v8 ignore start: real process adapter is exercised by CLI subprocess tests. */
export function exitWithCliRuntimeError(error: unknown): never {
  if (isAbortThrow(error)) {
    process.exit(130);
  }
  try {
    writeSync(2, formatCliRuntimeError(error));
  } finally {
    process.exit(1);
  }
}
/* v8 ignore stop */
