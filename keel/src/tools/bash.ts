import { type ChildProcessByStdio, spawn } from "node:child_process";
import type { Readable } from "node:stream";
import { KeelError } from "../core/error.ts";
import {
  type CapturedByteOutput,
  TailByteOutputLimit,
  TempFileByteOutputCapture,
} from "./output-limit.ts";
import type { ToolResult } from "./types.ts";

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 60_000;
const OUTPUT_MAX_BYTES = 20_000;
const ARTIFACT_OUTPUT_MAX_BYTES = 10_000_000;
const EXIT_STDIO_QUIET_DRAIN_MS = 25;
const EXIT_STDIO_MAX_DRAIN_MS = 1_000;

export interface BashOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

interface BashProcessResult {
  readonly stdout: CapturedByteOutput;
  readonly stderr: CapturedByteOutput;
  readonly artifactStdout: CapturedByteOutput;
  readonly artifactStderr: CapturedByteOutput;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly timeoutMs: number;
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
  stream: CapturedByteOutput,
  options: {
    readonly direction: "first" | "last";
    readonly maxBytes: number;
  },
): string {
  if (stream.text === "" && !stream.truncated) return "";

  const lines = [`${label}:`];
  if (stream.truncated) {
    lines.push(
      `[bash ${label} truncated: showing ${options.direction} ${options.maxBytes} bytes]`,
    );
  }
  lines.push(stream.text.endsWith("\n") ? stream.text : `${stream.text}\n`);
  return lines.join("\n");
}

function formatResultSections(
  result: BashProcessResult,
  streams: {
    readonly stdout: CapturedByteOutput;
    readonly stderr: CapturedByteOutput;
    readonly direction: "first" | "last";
    readonly maxBytes: number;
  },
): string {
  const sections: string[] = [];
  if (result.timedOut) {
    sections.push(`Command timed out after ${result.timeoutMs}ms`);
  }
  sections.push(`Exit code: ${result.exitCode ?? "unknown"}`);
  if (result.signal !== null && !result.timedOut) {
    sections.push(`Signal: ${result.signal}`);
  }

  const stdout = formatCapturedOutput("stdout", streams.stdout, {
    direction: streams.direction,
    maxBytes: streams.maxBytes,
  });
  const stderr = formatCapturedOutput("stderr", streams.stderr, {
    direction: streams.direction,
    maxBytes: streams.maxBytes,
  });
  if (stdout !== "") sections.push(stdout);
  if (stderr !== "") sections.push(stderr);
  if (stdout === "" && stderr === "") sections.push("(no output)");
  return sections.join("\n\n");
}

function formatResult(result: BashProcessResult): ToolResult {
  const content = formatResultSections(result, {
    stdout: result.stdout,
    stderr: result.stderr,
    direction: "last",
    maxBytes: OUTPUT_MAX_BYTES,
  });
  const artifactContent = formatResultSections(result, {
    stdout: result.artifactStdout,
    stderr: result.artifactStderr,
    direction: "first",
    maxBytes: ARTIFACT_OUTPUT_MAX_BYTES,
  });
  const previewTruncated = result.stdout.truncated || result.stderr.truncated;
  const artifactSourceTruncated =
    result.artifactStdout.truncated || result.artifactStderr.truncated;

  return {
    content,
    ...(previewTruncated ? { sourceTruncated: true } : {}),
    ...(previewTruncated || artifactSourceTruncated ? { artifactContent } : {}),
    ...(previewTruncated || artifactSourceTruncated
      ? { artifactSourceTruncated }
      : {}),
  };
}

function runBashProcess(
  workspacePath: string,
  command: string,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<BashProcessResult> {
  if (signal?.aborted === true) {
    return Promise.reject(
      new KeelError(
        "tool_aborted",
        "bash failed: command aborted",
        "The task was cancelled. Do not retry this command; proceed with the next step or stop.",
      ),
    );
  }
  const stdout = new TailByteOutputLimit(OUTPUT_MAX_BYTES);
  const stderr = new TailByteOutputLimit(OUTPUT_MAX_BYTES);
  const artifactStdout = new TempFileByteOutputCapture(
    "keel-bash-stdout-",
    ARTIFACT_OUTPUT_MAX_BYTES,
    OUTPUT_MAX_BYTES,
  );
  const artifactStderr = new TempFileByteOutputCapture(
    "keel-bash-stderr-",
    ARTIFACT_OUTPUT_MAX_BYTES,
    OUTPUT_MAX_BYTES,
  );

  return new Promise<BashProcessResult>((resolveProcess, rejectProcess) => {
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
    let processExited = false;
    let exitedCode: number | null = null;
    let exitedSignal: NodeJS.Signals | null = null;
    let stdoutClosed = false;
    let stderrClosed = false;
    let quietDrainTimer: ReturnType<typeof setTimeout> | undefined;
    let maxDrainTimer: ReturnType<typeof setTimeout> | undefined;

    const clearDrainTimers = () => {
      if (quietDrainTimer !== undefined) {
        clearTimeout(quietDrainTimer);
        quietDrainTimer = undefined;
      }
      if (maxDrainTimer !== undefined) {
        clearTimeout(maxDrainTimer);
        maxDrainTimer = undefined;
      }
    };

    const cleanup = () => {
      clearTimeout(timeout);
      clearDrainTimers();
      signal?.removeEventListener("abort", abort);
      child.stdout.destroy();
      child.stderr.destroy();
      artifactStdout.cleanup();
      artifactStderr.cleanup();
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
      if (outcome.type === "reject") {
        cleanup();
        rejectProcess(outcome.error);
        return;
      }
      let capturedStdout: CapturedByteOutput;
      let capturedStderr: CapturedByteOutput;
      let capturedArtifactStdout: CapturedByteOutput;
      let capturedArtifactStderr: CapturedByteOutput;
      try {
        capturedStdout = stdout.capture();
        capturedStderr = stderr.capture();
        capturedArtifactStdout = artifactStdout.capture();
        capturedArtifactStderr = artifactStderr.capture();
      } catch (error) {
        /* v8 ignore start: temp output capture failures require filesystem faults after process completion. */
        cleanup();
        const detail = error instanceof Error ? error.message : String(error);
        rejectProcess(
          new KeelError(
            "tool_unavailable",
            `bash failed: could not capture output artifact: ${detail}`,
            "Rerun the command with narrower output or inspect specific files directly.",
          ),
        );
        return;
        /* v8 ignore stop */
      }
      cleanup();
      resolveProcess({
        stdout: capturedStdout,
        stderr: capturedStderr,
        artifactStdout: capturedArtifactStdout,
        artifactStderr: capturedArtifactStderr,
        exitCode: outcome.exitCode,
        signal: outcome.signal,
        timedOut,
        timeoutMs,
      });
    };

    const finishResolvedProcess = () => {
      finish({ type: "resolve", exitCode: exitedCode, signal: exitedSignal });
    };

    const scheduleExitDrain = () => {
      if (!processExited || settled) return;
      if (stdoutClosed && stderrClosed) {
        finishResolvedProcess();
        return;
      }
      if (quietDrainTimer !== undefined) clearTimeout(quietDrainTimer);
      quietDrainTimer = setTimeout(
        finishResolvedProcess,
        EXIT_STDIO_QUIET_DRAIN_MS,
      );
      quietDrainTimer.unref();
      if (maxDrainTimer === undefined) {
        maxDrainTimer = setTimeout(
          finishResolvedProcess,
          EXIT_STDIO_MAX_DRAIN_MS,
        );
        maxDrainTimer.unref();
      }
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

    const recordOutputChunk = (
      preview: TailByteOutputLimit,
      artifact: TempFileByteOutputCapture,
      label: "stdout" | "stderr",
      chunk: Buffer,
    ): void => {
      try {
        preview.append(chunk);
        artifact.append(chunk);
      } catch (error) {
        /* v8 ignore start: temp output write failures require filesystem faults while streaming. */
        stopChildProcess(child.pid);
        const detail = error instanceof Error ? error.message : String(error);
        finish({
          type: "reject",
          error: new KeelError(
            "tool_unavailable",
            `bash failed: could not capture ${label} artifact: ${detail}`,
            "Rerun the command with narrower output or inspect specific files directly.",
          ),
        });
        /* v8 ignore stop */
      }
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      stopChildProcess(child.pid);
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      recordOutputChunk(stdout, artifactStdout, "stdout", chunk);
      scheduleExitDrain();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      recordOutputChunk(stderr, artifactStderr, "stderr", chunk);
      scheduleExitDrain();
    });
    child.stdout.once("close", () => {
      stdoutClosed = true;
      scheduleExitDrain();
    });
    child.stderr.once("close", () => {
      stderrClosed = true;
      scheduleExitDrain();
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
    child.once("exit", (exitCode, childSignal) => {
      processExited = true;
      exitedCode = exitCode;
      exitedSignal = childSignal;
      clearTimeout(timeout);
      scheduleExitDrain();
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
