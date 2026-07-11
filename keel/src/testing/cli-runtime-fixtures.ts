import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { Terminal } from "@earendil-works/pi-tui";
import type { CliRuntime } from "../cli/runtime.ts";

export interface RuntimeFixture {
  readonly runtime: CliRuntime;
  readonly stdout: () => string;
  readonly stderr: () => string;
}

export interface SigintCapture {
  handler: (() => void) | null;
}

export function createRuntime(
  args: readonly string[],
  options: {
    readonly cwd?: string;
    readonly env?: Record<string, string>;
    readonly input?: PassThrough;
    readonly inputIsTTY?: boolean;
    readonly stderrIsTTY?: boolean;
    readonly stdoutIsTTY?: boolean;
    readonly createInteractiveTerminal?: () => Terminal;
    readonly onStdout?: (text: string) => void;
    readonly onStderr?: (text: string) => void;
    readonly onSigint?: (handler: () => void) => void;
    readonly offSigint?: (handler: () => void) => void;
    readonly now?: () => number;
  } = {},
): RuntimeFixture {
  let stdout = "";
  let stderr = "";
  const input = options.input ?? new PassThrough();
  const stderrIsTTY = options.stderrIsTTY ?? options.inputIsTTY === true;
  if (options.inputIsTTY === true) {
    Object.defineProperty(input, "isTTY", { value: true });
    if (stderrIsTTY) {
      // TTY display tests treat stderr() as rendered terminal chrome plus cooked-mode input echo.
      input.on("data", (chunk: Buffer | string) => {
        stderr += chunk.toString();
      });
    }
  }

  return {
    runtime: {
      args,
      cliEntry: join(process.cwd(), "src/cli/index.ts"),
      cwd: () => options.cwd ?? process.cwd(),
      env: (key) => options.env?.[key],
      input,
      platform: process.platform,
      stderrIsTTY,
      ...(options.stdoutIsTTY !== undefined
        ? { stdoutIsTTY: options.stdoutIsTTY }
        : {}),
      ...(options.createInteractiveTerminal !== undefined
        ? { createInteractiveTerminal: options.createInteractiveTerminal }
        : {}),
      now: options.now ?? (() => 0),
      writeStdout: (text) => {
        stdout += text;
        options.onStdout?.(text);
      },
      writeStderr: (text) => {
        stderr += text;
        options.onStderr?.(text);
      },
      onSigint: options.onSigint ?? (() => {}),
      offSigint: options.offSigint ?? (() => {}),
      forceExit: (code) => {
        throw new Error(`unexpected forceExit(${code})`);
      },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}
export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(message));
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
