import { join } from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import type { Terminal } from "@earendil-works/pi-tui";
import type { CliRuntime } from "../cli/runtime.ts";
import type { McpSecretBackend } from "../mcp/oauth.ts";

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
    readonly sleep?: (milliseconds: number) => Promise<void>;
    readonly mcpSecretBackend?: McpSecretBackend;
    readonly openExternalUrl?: (url: URL) => Promise<void>;
  } = {},
): RuntimeFixture {
  let stdout = "";
  let stderr = "";
  const input = options.input ?? new PassThrough();
  const stderrIsTTY = options.stderrIsTTY ?? options.inputIsTTY === true;
  const secretEntries = new Map<string, string>();
  const secretKey = (service: string, account: string) =>
    `${service}\0${account}`;
  const mcpSecretBackend: McpSecretBackend = options.mcpSecretBackend ?? {
    getPassword: async (service, account) =>
      secretEntries.get(secretKey(service, account)) ?? null,
    setPassword: async (service, account, password) => {
      secretEntries.set(secretKey(service, account), password);
    },
    deletePassword: async (service, account) =>
      secretEntries.delete(secretKey(service, account)),
  };
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
      mcpSecretBackend,
      openExternalUrl:
        options.openExternalUrl ??
        (async () => {
          throw new Error("unexpected external URL open in CLI test");
        }),
      stderrIsTTY,
      ...(options.stdoutIsTTY !== undefined
        ? { stdoutIsTTY: options.stdoutIsTTY }
        : {}),
      ...(options.createInteractiveTerminal !== undefined
        ? { createInteractiveTerminal: options.createInteractiveTerminal }
        : {}),
      now: options.now ?? (() => 0),
      sleep:
        options.sleep ??
        (async (milliseconds) => {
          await delay(milliseconds);
        }),
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
