import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { KeelError } from "../core/error.ts";
import { resolveRipgrep } from "./ripgrep.ts";

const RIPGREP_KILL_GRACE_MS = 1_000;

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
      if (forceKillTimeout !== undefined) return;
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
        if (error.code === "ENOENT") {
          rejectResult(
            new KeelError(
              "tool_unavailable",
              `${options.toolName} failed: bundled ripgrep is not available (${ripgrep.provider})`,
            ),
          );
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
