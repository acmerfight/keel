import { type ChildProcessByStdio, spawn } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, posix, relative, resolve, sep, win32 } from "node:path";
import type { Readable } from "node:stream";
import { KeelError } from "../core/error.ts";
import {
  type CapturedByteOutput,
  HeadByteOutputLimit,
  MemoryByteOutputCapture,
  TempFileByteOutputCapture,
} from "./output-limit.ts";
import type { ProjectIgnorePolicy } from "./project-ignore.ts";
import { isInsideWorkspace } from "./workspace-path.ts";

const DEFAULT_TIMEOUT_MS = 30_000;
export const GIT_PREVIEW_OUTPUT_MAX_BYTES = 100_000;
export const GIT_ARTIFACT_OUTPUT_MAX_BYTES = 10_000_000;
const GIT_OPTIONAL_LOCKS_ENV = "GIT_OPTIONAL_LOCKS";
const GIT_PAGER_ENV = "GIT_PAGER";

export type GitProcessCaptureMode = "artifact" | "metadata";

export interface GitProcessResult {
  readonly stdout: CapturedByteOutput;
  readonly stderr: CapturedByteOutput;
  readonly artifactStdout: CapturedByteOutput;
  readonly artifactStderr: CapturedByteOutput;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly timeoutMs: number;
}

export interface RunGitOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly config?: readonly string[];
  readonly captureMode?: GitProcessCaptureMode;
}

export interface GitWorkTreeScope {
  readonly rootPath: string;
  readonly workspacePathspec: string;
  readonly pathspecs: readonly string[];
}

interface GitProcessOutputCapture {
  readonly append: (chunk: Buffer) => void;
  readonly capture: () => CapturedByteOutput;
  readonly cleanup: () => void;
}

export function gitNullDevicePath(): string {
  /* v8 ignore next: Windows null-device path is covered by platform behavior, not macOS CI. */
  return process.platform === "win32" ? "NUL" : "/dev/null";
}

function isUnsafeGitEnvironmentKey(key: string): boolean {
  return (
    key === "GIT_EXTERNAL_DIFF" ||
    key === "GIT_DIFF_OPTS" ||
    key === "GIT_CONFIG_COUNT" ||
    key === "GIT_CONFIG_PARAMETERS" ||
    key === "GIT_CONFIG_GLOBAL" ||
    key === "GIT_CONFIG_SYSTEM" ||
    /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/u.test(key)
  );
}

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!isUnsafeGitEnvironmentKey(key)) env[key] = value;
  }
  env[GIT_OPTIONAL_LOCKS_ENV] = "0";
  env[GIT_PAGER_ENV] = "cat";
  return env;
}

export function gitRunOptions(
  config: readonly string[] | undefined,
  signal: AbortSignal | undefined,
  captureMode?: GitProcessCaptureMode,
): RunGitOptions {
  return {
    ...(config !== undefined ? { config } : {}),
    ...(signal !== undefined ? { signal } : {}),
    ...(captureMode !== undefined ? { captureMode } : {}),
  };
}

function gitConfigArgs(config: readonly string[] | undefined): string[] {
  const configs = [
    "core.fsmonitor=false",
    `core.hooksPath=${gitNullDevicePath()}`,
    "diff.external=",
    ...(config ?? []),
  ];
  return configs.flatMap((entry) => ["-c", entry]);
}

/* v8 ignore start: abort/timeout cleanup races are OS process-control fallbacks, not deterministic unit behavior. */
function killChildProcess(childPid: number): void {
  const signalTarget = process.platform === "win32" ? childPid : -childPid;

  try {
    process.kill(signalTarget, "SIGTERM");
  } catch {
    // Process may already have exited.
  }

  if (process.platform === "win32") return;

  setTimeout(() => {
    try {
      process.kill(-childPid, "SIGKILL");
    } catch {
      // Process may have exited after SIGTERM.
    }
  }, 100).unref();
}

function stopChildProcess(childPid: number | undefined): void {
  if (childPid !== undefined) killChildProcess(childPid);
}
/* v8 ignore stop */

function gitProcessOutputCapture(
  mode: GitProcessCaptureMode,
  prefix: string,
): GitProcessOutputCapture {
  if (mode === "metadata") {
    return new MemoryByteOutputCapture(GIT_ARTIFACT_OUTPUT_MAX_BYTES);
  }
  return new TempFileByteOutputCapture(
    prefix,
    GIT_ARTIFACT_OUTPUT_MAX_BYTES,
    GIT_PREVIEW_OUTPUT_MAX_BYTES,
  );
}

export function runGitProcess(
  toolName: string,
  workspacePath: string,
  args: readonly string[],
  options: RunGitOptions = {},
): Promise<GitProcessResult> {
  if (options.signal?.aborted === true) {
    return Promise.reject(
      new KeelError(
        "tool_aborted",
        `${toolName} failed: command aborted`,
        "The task was cancelled. Do not retry this tool call; proceed with the next step or stop.",
      ),
    );
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const captureMode = options.captureMode ?? "artifact";
  const stdout = new HeadByteOutputLimit(GIT_PREVIEW_OUTPUT_MAX_BYTES);
  const stderr = new HeadByteOutputLimit(GIT_PREVIEW_OUTPUT_MAX_BYTES);
  const artifactStdout = gitProcessOutputCapture(
    captureMode,
    `keel-${toolName}-stdout-`,
  );
  const artifactStderr = gitProcessOutputCapture(
    captureMode,
    `keel-${toolName}-stderr-`,
  );
  const gitArgs = [
    "--no-pager",
    "--no-optional-locks",
    ...gitConfigArgs(options.config),
    ...args,
  ];

  return new Promise<GitProcessResult>((resolveProcess, rejectProcess) => {
    const child: ChildProcessByStdio<null, Readable, Readable> = spawn(
      "git",
      gitArgs,
      {
        cwd: workspacePath,
        detached: process.platform !== "win32",
        env: gitEnv(),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );

    let timedOut = false;
    let settled = false;

    const cleanup = () => {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abort);
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
      /* v8 ignore next: protects close/error races from double-settling the same child process. */
      if (settled) return;
      settled = true;
      /* v8 ignore next 4: child spawn failures and mid-process aborts are environment/process faults. */
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
            `${toolName} failed: could not capture output artifact: ${detail}`,
            "Use paths to narrow output or inspect files directly with read/grep.",
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

    /* v8 ignore start: mid-process abort cleanup is covered by pre-start abort and OS process-control guards. */
    const abort = () => {
      stopChildProcess(child.pid);
      finish({
        type: "reject",
        error: new KeelError(
          "tool_aborted",
          `${toolName} failed: command aborted`,
          "The task was cancelled. Do not retry this tool call; proceed with the next step or stop.",
        ),
      });
    };
    /* v8 ignore stop */

    /* v8 ignore next 4: timeout cleanup is a process-control fallback; normal git invocations complete promptly. */
    const timeout = setTimeout(() => {
      timedOut = true;
      stopChildProcess(child.pid);
    }, timeoutMs);

    const recordOutputChunk = (
      preview: HeadByteOutputLimit,
      artifact: GitProcessOutputCapture,
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
            `${toolName} failed: could not capture ${label} artifact: ${detail}`,
            "Use paths to narrow output or inspect files directly with read/grep.",
          ),
        });
        /* v8 ignore stop */
      }
    };

    child.stdout.on("data", (chunk: Buffer) => {
      recordOutputChunk(stdout, artifactStdout, "stdout", chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      recordOutputChunk(stderr, artifactStderr, "stderr", chunk);
    });
    /* v8 ignore start: spawn errors require a missing/broken git executable or inaccessible cwd. */
    child.once("error", (error) => {
      finish({
        type: "reject",
        error: new KeelError(
          "tool_unavailable",
          `${toolName} failed: could not start git: ${error.message}`,
          "Verify git is installed and the workspace directory exists, or inspect files with read/grep instead.",
        ),
      });
    });
    /* v8 ignore stop */
    child.once("close", (exitCode, childSignal) => {
      finish({ type: "resolve", exitCode, signal: childSignal });
    });

    options.signal?.addEventListener("abort", abort, { once: true });
  });
}

/* v8 ignore start: unexpected git command failures are surfaced, but are not deterministic product paths. */
export function gitCommandFailure(
  toolName: string,
  command: string,
  result: GitProcessResult,
): KeelError {
  if (result.timedOut) {
    return new KeelError(
      "tool_unavailable",
      `${toolName} failed: git ${command} timed out after ${result.timeoutMs}ms`,
      "Use paths to narrow output or inspect files directly with read/grep.",
    );
  }

  const stderr = result.stderr.text.trim();
  const stderrSuffix = stderr === "" ? "" : `: ${stderr}`;
  return new KeelError(
    "tool_unavailable",
    `${toolName} failed: git ${command} exited with code ${
      result.exitCode ?? "unknown"
    }${stderrSuffix}`,
    "Use paths to narrow output or inspect files directly with read/grep.",
  );
}
/* v8 ignore stop */

export function expectGitExitCode(
  toolName: string,
  command: string,
  result: GitProcessResult,
  acceptedExitCodes: ReadonlySet<number>,
): GitProcessResult {
  /* v8 ignore next 3: null exit codes require external signal races; normal git exits report numeric codes. */
  if (result.exitCode === null) {
    throw gitCommandFailure(toolName, command, result);
  }
  /* v8 ignore next 3: non-accepted git exits are covered by gitCommandFailure formatting guards. */
  if (!acceptedExitCodes.has(result.exitCode)) {
    throw gitCommandFailure(toolName, command, result);
  }
  return result;
}

function pathFilterError(toolName: string, requestedPath: string): KeelError {
  return new KeelError(
    "tool_path_outside_workspace",
    `${toolName} failed: path filter is outside the workspace or unsafe: ${requestedPath}`,
    "Use literal workspace-relative paths without absolute prefixes, '..', NUL bytes, or git pathspec magic.",
  );
}

function pathIgnoredError(toolName: string, requestedPath: string): KeelError {
  return new KeelError(
    "tool_path_ignored",
    `${toolName} failed: ignored path: ${requestedPath}`,
    "This path is excluded by the project ignore policy. Use a different path or omit paths to inspect visible changes only.",
  );
}

function normalizeGitPathFilter(
  toolName: string,
  workspacePath: string,
  requestedPath: string,
): string {
  if (
    requestedPath === "" ||
    requestedPath.includes("\0") ||
    requestedPath.startsWith(":") ||
    isAbsolute(requestedPath) ||
    win32.isAbsolute(requestedPath)
  ) {
    throw pathFilterError(toolName, requestedPath);
  }

  const normalizedPath = requestedPath.replace(/\\/gu, "/");
  if (normalizedPath.split("/").includes("..")) {
    throw pathFilterError(toolName, requestedPath);
  }
  const canonicalPath = posix.normalize(normalizedPath);

  const absolutePath = resolve(workspacePath, canonicalPath);
  /* v8 ignore next 3: lexical validation above constrains normalized relative paths inside the workspace. */
  if (!isInsideWorkspace(workspacePath, absolutePath)) {
    throw pathFilterError(toolName, requestedPath);
  }
  return canonicalPath;
}

export function normalizeGitPathFilters(
  toolName: string,
  workspacePath: string,
  requestedPaths: readonly string[] | undefined,
): readonly string[] {
  if (requestedPaths === undefined) return [];
  return requestedPaths.map((path) =>
    normalizeGitPathFilter(toolName, workspacePath, path),
  );
}

function pathFilterIsDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function assertGitPathFiltersAllowed(
  toolName: string,
  workspacePath: string,
  paths: readonly string[],
  projectIgnorePolicy: ProjectIgnorePolicy,
): void {
  for (const path of paths) {
    const absolutePath = resolve(workspacePath, path);
    if (
      projectIgnorePolicy.isIgnored(
        absolutePath,
        pathFilterIsDirectory(absolutePath),
      )
    ) {
      throw pathIgnoredError(toolName, path);
    }
  }
}

export function gitPathspecArgs(paths: readonly string[]): readonly string[] {
  return paths.length === 0
    ? []
    : ["--", ...paths.map((path) => `:(literal)${path}`)];
}

export function gitPathVisibleToProvider(
  workspacePath: string,
  gitPathBasePath: string,
  projectIgnorePolicy: ProjectIgnorePolicy,
  path: string,
): boolean {
  const absolutePath = resolve(gitPathBasePath, path);
  /* v8 ignore next: git emits paths relative to the queried work tree; this guards unexpected git output. */
  if (!isInsideWorkspace(workspacePath, absolutePath)) return false;
  return !projectIgnorePolicy.isIgnored(absolutePath, false);
}

function posixRelativePath(from: string, to: string): string {
  return relative(from, to).split(sep).join(posix.sep);
}

function joinGitPath(basePath: string, path: string): string {
  if (basePath === "") return path;
  if (path === ".") return basePath;
  return `${basePath}/${path}`;
}

export async function resolveGitWorkTreeScope(
  toolName: string,
  workspacePath: string,
  workspaceRelativePaths: readonly string[],
  signal: AbortSignal | undefined,
): Promise<GitWorkTreeScope | null> {
  const result = await runGitProcess(
    toolName,
    workspacePath,
    ["rev-parse", "--show-toplevel"],
    gitRunOptions(undefined, signal, "metadata"),
  );
  if (result.exitCode !== 0) return null;

  const rootPath = realpathSync(result.artifactStdout.text.trim());
  const workspaceFromRoot = posixRelativePath(rootPath, workspacePath);
  const workspacePathspec = workspaceFromRoot === "" ? "." : workspaceFromRoot;
  const pathspecs =
    workspaceRelativePaths.length === 0
      ? [workspacePathspec]
      : workspaceRelativePaths.map((path) =>
          joinGitPath(workspaceFromRoot, path),
        );
  return { rootPath, workspacePathspec, pathspecs };
}
