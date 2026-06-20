import { type ChildProcessByStdio, spawn } from "node:child_process";
import type { Readable } from "node:stream";
import { KeelError } from "../core/error.ts";
import type { ToolResult } from "./types.ts";

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 60_000;
const OUTPUT_MAX_BYTES = 20_000;

export interface BashOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

interface BashProcessResult {
  readonly stdout: CapturedStream;
  readonly stderr: CapturedStream;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly timeoutMs: number;
}

interface CapturedStream {
  readonly text: string;
  readonly truncated: boolean;
}

class TailBuffer {
  readonly #maxBytes: number;
  #chunks: Buffer[] = [];
  #bytes = 0;
  #truncated = false;

  constructor(maxBytes: number) {
    this.#maxBytes = maxBytes;
  }

  append(chunk: Buffer): void {
    if (chunk.length >= this.#maxBytes) {
      this.#chunks = [chunk.subarray(chunk.length - this.#maxBytes)];
      this.#bytes = this.#maxBytes;
      this.#truncated = true;
      return;
    }

    this.#chunks.push(chunk);
    this.#bytes += chunk.length;

    while (this.#bytes > this.#maxBytes) {
      const first = this.#chunks[0];
      if (first === undefined) return;

      const excessBytes = this.#bytes - this.#maxBytes;
      if (first.length <= excessBytes) {
        this.#chunks.shift();
        this.#bytes -= first.length;
      } else {
        this.#chunks[0] = first.subarray(excessBytes);
        this.#bytes -= excessBytes;
      }
      this.#truncated = true;
    }
  }

  capture(): CapturedStream {
    return {
      text: Buffer.concat(this.#chunks, this.#bytes).toString("utf8"),
      truncated: this.#truncated,
    };
  }
}

function normalizeTimeout(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined) return DEFAULT_TIMEOUT_MS;
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > MAX_TIMEOUT_MS
  ) {
    throw new KeelError(
      "tool_invalid_bash_timeout",
      `bash failed: timeout must be an integer between 1 and ${MAX_TIMEOUT_MS}ms`,
      `Set timeoutMs to an integer between 1 and ${MAX_TIMEOUT_MS}.`,
    );
  }
  return timeoutMs;
}

function envValue(key: string): string | undefined {
  return process.env[key];
}

function killChildProcess(childPid: number): void {
  const signalTarget = process.platform === "win32" ? childPid : -childPid;

  try {
    process.kill(signalTarget, "SIGTERM");
  } catch {
    // The process may have exited between timeout/abort and kill.
  }

  if (process.platform === "win32") {
    return;
  }

  setTimeout(() => {
    try {
      process.kill(-childPid, "SIGKILL");
    } catch {
      // The process may have exited after SIGTERM.
    }
  }, 100).unref();
}

function stopChildProcess(childPid: number | undefined): void {
  if (childPid === undefined) return;
  killChildProcess(childPid);
}

function formatCapturedOutput(
  label: "stdout" | "stderr",
  stream: CapturedStream,
): string {
  if (stream.text === "" && !stream.truncated) return "";

  const lines = [`${label}:`];
  if (stream.truncated) {
    lines.push(
      `[bash ${label} truncated: showing last ${OUTPUT_MAX_BYTES} bytes]`,
    );
  }
  lines.push(stream.text.endsWith("\n") ? stream.text : `${stream.text}\n`);
  return lines.join("\n");
}

function formatResult(result: BashProcessResult): ToolResult {
  const sections: string[] = [];
  if (result.timedOut) {
    sections.push(`Command timed out after ${result.timeoutMs}ms`);
  }
  sections.push(`Exit code: ${result.exitCode ?? "unknown"}`);
  if (result.signal !== null && !result.timedOut) {
    sections.push(`Signal: ${result.signal}`);
  }

  const stdout = formatCapturedOutput("stdout", result.stdout);
  const stderr = formatCapturedOutput("stderr", result.stderr);
  if (stdout !== "") sections.push(stdout);
  if (stderr !== "") sections.push(stderr);
  if (stdout === "" && stderr === "") sections.push("(no output)");

  return { content: sections.join("\n\n") };
}

function runBashProcess(
  workspacePath: string,
  command: string,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<BashProcessResult> {
  const stdout = new TailBuffer(OUTPUT_MAX_BYTES);
  const stderr = new TailBuffer(OUTPUT_MAX_BYTES);

  return new Promise<BashProcessResult>((resolveProcess, rejectProcess) => {
    if (signal?.aborted === true) {
      rejectProcess(
        new KeelError(
          "tool_aborted",
          "bash failed: command aborted",
          "The task was cancelled. Do not retry this command; proceed with the next step or stop.",
        ),
      );
      return;
    }

    const child: ChildProcessByStdio<null, Readable, Readable> = spawn(
      command,
      {
        cwd: workspacePath,
        detached: process.platform !== "win32",
        env: process.env,
        shell: envValue("SHELL") ?? true,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );

    let timedOut = false;
    let settled = false;

    const cleanup = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    };

    const finish = (
      outcome:
        | {
            readonly type: "resolve";
            readonly exitCode: number | null;
            readonly signal: NodeJS.Signals | null;
          }
        | { readonly type: "reject"; readonly error: KeelError },
    ) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (outcome.type === "reject") {
        rejectProcess(outcome.error);
        return;
      }
      resolveProcess({
        stdout: stdout.capture(),
        stderr: stderr.capture(),
        exitCode: outcome.exitCode,
        signal: outcome.signal,
        timedOut,
        timeoutMs,
      });
    };

    const abort = () => {
      stopChildProcess(child.pid);
      finish({
        type: "reject",
        error: new KeelError(
          "tool_aborted",
          "bash failed: command aborted",
          "The task was cancelled. Do not retry this command; proceed with the next step or stop.",
        ),
      });
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      stopChildProcess(child.pid);
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout.append(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr.append(chunk);
    });
    child.once("error", (error) => {
      finish({
        type: "reject",
        error: new KeelError(
          "tool_unavailable",
          `bash failed: could not start shell: ${error.message}`,
          "Verify the workspace directory exists and is accessible, or use file tools instead.",
        ),
      });
    });
    child.once("close", (exitCode, childSignal) => {
      finish({ type: "resolve", exitCode, signal: childSignal });
    });

    signal?.addEventListener("abort", abort, { once: true });
  });
}

export async function executeBash(
  workspacePath: string,
  command: string,
  options: BashOptions = {},
): Promise<ToolResult> {
  if (command.trim() === "") {
    throw new KeelError(
      "tool_empty_command",
      "bash failed: command is empty",
      "Provide a non-empty shell command to execute.",
    );
  }

  const timeoutMs = normalizeTimeout(options.timeoutMs);
  return formatResult(
    await runBashProcess(workspacePath, command, options.signal, timeoutMs),
  );
}
