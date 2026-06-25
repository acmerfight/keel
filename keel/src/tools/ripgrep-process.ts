import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { KeelError } from "../core/error.ts";
import { resolveRipgrep } from "./ripgrep.ts";

const RIPGREP_KILL_GRACE_MS = 1_000;

type RecoverableRipgrepStartErrorCode =
  | "ENOENT"
  | "EACCES"
  | "EPERM"
  | "EAGAIN";

export interface RipgrepProcessOptions {
  readonly toolName: "grep" | "glob";
  readonly workspacePath: string;
  readonly args: readonly string[];
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
  readonly onStdoutLine: (line: string, stopRipgrep: () => void) => void;
}

export interface RipgrepProcessResult {
  readonly code: number | null;
  readonly stderr: string;
}

function recoverableRipgrepStartErrorCode(
  error: NodeJS.ErrnoException,
): RecoverableRipgrepStartErrorCode | null {
  if (
    error.code === "ENOENT" ||
    error.code === "EACCES" ||
    error.code === "EPERM" ||
    error.code === "EAGAIN"
  ) {
    return error.code;
  }
  return null;
}

function isAbortError(error: NodeJS.ErrnoException): boolean {
  return error.name === "AbortError" || error.code === "ABORT_ERR";
}

function ripgrepStartRecovery(code: RecoverableRipgrepStartErrorCode): string {
  if (code === "EAGAIN") {
    return "The system could not start ripgrep because process resources are temporarily exhausted. Use ls/read with known paths, narrow the search, or retry after freeing system resources.";
  }
  if (code === "ENOENT") {
    return "The bundled ripgrep binary disappeared after validation. Use ls/read with known paths, or ask the user to run keel --doctor and reinstall dependencies before searching again.";
  }
  return "The bundled ripgrep binary is not executable. Use ls/read with known paths, or ask the user to restore execute permissions and run keel --doctor before searching again.";
}

function ripgrepStartError(
  options: RipgrepProcessOptions,
  code: RecoverableRipgrepStartErrorCode,
): KeelError {
  return new KeelError(
    "tool_search_unavailable",
    `${options.toolName} failed: ripgrep could not start (${code})`,
    ripgrepStartRecovery(code),
  );
}

export async function runRipgrepProcess(
  options: RipgrepProcessOptions,
): Promise<RipgrepProcessResult> {
  const ripgrep = await resolveRipgrep();

  return new Promise<RipgrepProcessResult>((resolveResult, rejectResult) => {
    let settled = false;
    let stderr = "";

    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      callback();
    };

    const child = spawn(ripgrep.path, options.args, {
      cwd: options.workspacePath,
      stdio: ["ignore", "pipe", "pipe"],
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });

    const stdout = createInterface({ input: child.stdout });
    let timeout: NodeJS.Timeout | undefined;
    let forceKillTimeout: NodeJS.Timeout | undefined;
    let stdoutClosed = false;
    const closeStdout = () => {
      if (stdoutClosed) return;
      stdoutClosed = true;
      stdout.close();
    };
    const clearSearchTimeout = () => {
      if (timeout === undefined) return;
      clearTimeout(timeout);
      timeout = undefined;
    };
    const cleanup = () => {
      clearSearchTimeout();
      if (forceKillTimeout !== undefined) {
        clearTimeout(forceKillTimeout);
        forceKillTimeout = undefined;
      }
      closeStdout();
    };
    const stopRipgrep = () => {
      child.kill("SIGTERM");
      /* v8 ignore next: stopRipgrep has one caller per request path; duplicate calls are defensive. */
      if (forceKillTimeout !== undefined) return;
      /* v8 ignore next 3: SIGKILL fallback only fires if ripgrep ignores SIGTERM. */
      forceKillTimeout = setTimeout(() => {
        child.kill("SIGKILL");
      }, RIPGREP_KILL_GRACE_MS);
    };
    timeout = setTimeout(() => {
      stopRipgrep();
      clearSearchTimeout();
      closeStdout();
      settle(() => {
        rejectResult(
          new KeelError(
            "tool_unavailable",
            `${options.toolName} failed: ripgrep timed out after ${options.timeoutMs}ms`,
          ),
        );
      });
    }, options.timeoutMs);

    stdout.on("line", (line) => {
      options.onStdoutLine(line, stopRipgrep);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", (error: NodeJS.ErrnoException) => {
      cleanup();
      settle(() => {
        if (isAbortError(error)) {
          rejectResult(error);
          return;
        }
        const code = recoverableRipgrepStartErrorCode(error);
        if (code !== null) {
          rejectResult(ripgrepStartError(options, code));
          return;
        }
        rejectResult(error);
      });
    });

    child.on("close", (code) => {
      cleanup();
      settle(() => {
        resolveResult({ code, stderr });
      });
    });
  });
}
