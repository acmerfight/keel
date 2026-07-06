import { type ChildProcessByStdio, spawn } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, posix, relative, resolve, win32 } from "node:path";
import type { Readable } from "node:stream";
import { KeelError } from "../core/error.ts";
import {
  type CapturedByteOutput,
  HeadByteOutputLimit,
  limitCountedOutput,
  MemoryByteOutputCapture,
  TempFileByteOutputCapture,
} from "./output-limit.ts";
import {
  createProjectIgnorePolicy,
  type ProjectIgnorePolicy,
} from "./project-ignore.ts";
import type { ToolResult } from "./types.ts";
import { isInsideWorkspace } from "./workspace-path.ts";

const DEFAULT_TIMEOUT_MS = 30_000;
const OUTPUT_MAX_BYTES = 100_000;
const ARTIFACT_OUTPUT_MAX_BYTES = 10_000_000;
const UNTRACKED_FILE_LIMIT = 50;
const GIT_OPTIONAL_LOCKS_ENV = "GIT_OPTIONAL_LOCKS";
const GIT_PAGER_ENV = "GIT_PAGER";
const SAFE_GIT_REF_PATTERN = /^[A-Za-z0-9_./@{}~^+-]+$/u;
const GIT_COMMIT_OID_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;

const DIFF_BASE_ARGS = [
  "--no-color",
  "--no-ext-diff",
  "--no-textconv",
  "--submodule=short",
  "--ignore-submodules=dirty",
];
const TRACKED_DIFF_ARGS = [...DIFF_BASE_ARGS, "--find-renames"];
const UNTRACKED_DIFF_ARGS = [...DIFF_BASE_ARGS, "--no-renames"];

type GitDiffMode = "all" | "unstaged" | "staged";
type GitProcessCaptureMode = "artifact" | "metadata";

export interface GitDiffOptions {
  readonly mode?: GitDiffMode;
  readonly baseRef?: string;
  readonly headRef?: string;
  readonly mergeBase?: boolean;
  readonly paths?: readonly string[];
  readonly signal?: AbortSignal;
}

interface GitProcessResult {
  readonly stdout: CapturedByteOutput;
  readonly stderr: CapturedByteOutput;
  readonly artifactStdout: CapturedByteOutput;
  readonly artifactStderr: CapturedByteOutput;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly timeoutMs: number;
}

interface RunGitOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly config?: readonly string[];
  readonly captureMode?: GitProcessCaptureMode;
}

interface SingleChangedTrackedEntry {
  readonly kind: "single";
  readonly path: string;
}

interface PairedChangedTrackedEntry {
  readonly kind: "paired";
  readonly oldPath: string;
  readonly newPath: string;
}

type ChangedTrackedEntry =
  | SingleChangedTrackedEntry
  | PairedChangedTrackedEntry;

interface GitDiffRefComparison {
  readonly baseRef: string;
  readonly headRef: string;
  readonly mergeBase: boolean;
}

interface ResolvedGitDiffRefComparison extends GitDiffRefComparison {
  readonly baseCommit: string;
  readonly headCommit: string;
}

interface GitProcessOutputCapture {
  readonly append: (chunk: Buffer) => void;
  readonly capture: () => CapturedByteOutput;
  readonly cleanup: () => void;
}

function nullDevicePath(): string {
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

function runOptions(
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
    `core.hooksPath=${nullDevicePath()}`,
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
    return new MemoryByteOutputCapture(ARTIFACT_OUTPUT_MAX_BYTES);
  }
  return new TempFileByteOutputCapture(
    prefix,
    ARTIFACT_OUTPUT_MAX_BYTES,
    OUTPUT_MAX_BYTES,
  );
}

function runGitProcess(
  workspacePath: string,
  args: readonly string[],
  options: RunGitOptions = {},
): Promise<GitProcessResult> {
  if (options.signal?.aborted === true) {
    return Promise.reject(
      new KeelError(
        "tool_aborted",
        "git_diff failed: command aborted",
        "The task was cancelled. Do not retry this tool call; proceed with the next step or stop.",
      ),
    );
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const captureMode = options.captureMode ?? "artifact";
  const stdout = new HeadByteOutputLimit(OUTPUT_MAX_BYTES);
  const stderr = new HeadByteOutputLimit(OUTPUT_MAX_BYTES);
  const artifactStdout = gitProcessOutputCapture(
    captureMode,
    "keel-git-diff-stdout-",
  );
  const artifactStderr = gitProcessOutputCapture(
    captureMode,
    "keel-git-diff-stderr-",
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
            `git_diff failed: could not capture output artifact: ${detail}`,
            "Use paths to narrow the diff or inspect files directly with read/grep.",
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
          "git_diff failed: command aborted",
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
            `git_diff failed: could not capture ${label} artifact: ${detail}`,
            "Use paths to narrow the diff or inspect files directly with read/grep.",
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
          `git_diff failed: could not start git: ${error.message}`,
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
function gitCommandFailure(
  command: string,
  result: GitProcessResult,
): KeelError {
  if (result.timedOut) {
    return new KeelError(
      "tool_unavailable",
      `git_diff failed: git ${command} timed out after ${result.timeoutMs}ms`,
      "Use paths to narrow the diff or inspect files directly with read/grep.",
    );
  }

  const stderr = result.stderr.text.trim();
  const stderrSuffix = stderr === "" ? "" : `: ${stderr}`;
  return new KeelError(
    "tool_unavailable",
    `git_diff failed: git ${command} exited with code ${
      result.exitCode ?? "unknown"
    }${stderrSuffix}`,
    "Use paths to narrow the diff or inspect files directly with read/grep.",
  );
}
/* v8 ignore stop */

function expectExitCode(
  command: string,
  result: GitProcessResult,
  acceptedExitCodes: ReadonlySet<number>,
): GitProcessResult {
  /* v8 ignore next 3: null exit codes require external signal races; normal git exits report numeric codes. */
  if (result.exitCode === null) {
    throw gitCommandFailure(command, result);
  }
  /* v8 ignore next 3: non-accepted git exits are covered by gitCommandFailure formatting guards. */
  if (!acceptedExitCodes.has(result.exitCode)) {
    throw gitCommandFailure(command, result);
  }
  return result;
}

function pathFilterError(requestedPath: string): KeelError {
  return new KeelError(
    "tool_path_outside_workspace",
    `git_diff failed: path filter is outside the workspace or unsafe: ${requestedPath}`,
    "Use literal workspace-relative paths without absolute prefixes, '..', NUL bytes, or git pathspec magic.",
  );
}

function pathIgnoredError(requestedPath: string): KeelError {
  return new KeelError(
    "tool_path_ignored",
    `git_diff failed: ignored path: ${requestedPath}`,
    "This path is excluded by the project ignore policy. Use a different path or omit paths to inspect visible changes only.",
  );
}

function gitRefError(message: string): KeelError {
  return new KeelError(
    "tool_invalid_git_ref",
    `git_diff failed: ${message}`,
    "Use separate safe refs such as HEAD, HEAD~1, or origin/main. Do not include ranges, whitespace, blob specs, or option prefixes.",
  );
}

function unsafeGitRefError(requestedRef: string): KeelError {
  return gitRefError(`unsafe git ref: ${requestedRef}`);
}

function gitRefDoesNotResolveToCommitError(requestedRef: string): KeelError {
  return gitRefError(`git ref does not resolve to a commit: ${requestedRef}`);
}

function noCommonAncestorError(comparison: GitDiffRefComparison): KeelError {
  return new KeelError(
    "tool_invalid_git_ref",
    `git_diff failed: no common ancestor between ${comparison.baseRef} and ${comparison.headRef}`,
    "Choose refs that share a common ancestor, or compare explicit commits without mergeBase.",
  );
}

function normalizePathFilter(
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
    throw pathFilterError(requestedPath);
  }

  const normalizedPath = requestedPath.replace(/\\/gu, "/");
  if (normalizedPath.split("/").includes("..")) {
    throw pathFilterError(requestedPath);
  }
  const canonicalPath = posix.normalize(normalizedPath);

  const absolutePath = resolve(workspacePath, canonicalPath);
  /* v8 ignore next 3: lexical validation above constrains normalized relative paths inside the workspace. */
  if (!isInsideWorkspace(workspacePath, absolutePath)) {
    throw pathFilterError(requestedPath);
  }
  return canonicalPath;
}

function normalizeGitRef(requestedRef: string): string {
  if (
    requestedRef === "" ||
    requestedRef.trim() !== requestedRef ||
    requestedRef.includes("\0") ||
    requestedRef.startsWith("-") ||
    requestedRef.startsWith("/") ||
    requestedRef.includes("..") ||
    requestedRef.includes(":") ||
    !SAFE_GIT_REF_PATTERN.test(requestedRef)
  ) {
    throw unsafeGitRefError(requestedRef);
  }
  return requestedRef;
}

function normalizeRefComparison(
  options: GitDiffOptions,
): GitDiffRefComparison | null {
  if (options.baseRef === undefined) {
    if (options.headRef !== undefined) {
      throw gitRefError("headRef requires baseRef");
    }
    if (options.mergeBase === true) {
      throw gitRefError("mergeBase requires baseRef");
    }
    return null;
  }

  if (options.mode !== undefined) {
    throw gitRefError("ref comparison cannot be combined with mode");
  }

  return {
    baseRef: normalizeGitRef(options.baseRef),
    headRef: normalizeGitRef(options.headRef ?? "HEAD"),
    mergeBase: options.mergeBase === true,
  };
}

function refComparisonLabel(comparison: GitDiffRefComparison): string {
  const separator = comparison.mergeBase ? "..." : "..";
  return `Ref comparison (${comparison.baseRef}${separator}${comparison.headRef})`;
}

function normalizePathFilters(
  workspacePath: string,
  requestedPaths: readonly string[] | undefined,
): readonly string[] {
  if (requestedPaths === undefined) return [];
  return requestedPaths.map((path) => normalizePathFilter(workspacePath, path));
}

function pathFilterIsDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

function assertPathFiltersAllowed(
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
      throw pathIgnoredError(path);
    }
  }
}

function pathspecArgs(paths: readonly string[]): readonly string[] {
  return paths.length === 0
    ? []
    : ["--", ...paths.map((path) => `:(literal)${path}`)];
}

function safeDiffArgs(
  extraArgs: readonly string[],
  paths: readonly string[],
): readonly string[] {
  return ["diff", ...TRACKED_DIFF_ARGS, ...extraArgs, ...pathspecArgs(paths)];
}

function filterDriverFromKey(key: string): string | null {
  if (!key.startsWith("filter.")) return null;
  for (const suffix of [".clean", ".process"]) {
    if (key.endsWith(suffix)) return key.slice(0, -suffix.length);
  }
  /* v8 ignore next: git config is queried with a clean/process suffix regexp; this guards malformed output. */
  return null;
}

async function configuredFilterOverrides(
  workspacePath: string,
  signal: AbortSignal | undefined,
): Promise<readonly string[]> {
  const result = await runGitProcess(
    workspacePath,
    [
      "config",
      "--null",
      "--name-only",
      "--get-regexp",
      "^filter\\..*\\.(clean|process)$",
    ],
    runOptions(undefined, signal, "metadata"),
  );
  /* v8 ignore next: exit 1 is git's normal no-match result; other config failures are environment faults. */
  if (result.exitCode === 1) return [];
  /* v8 ignore next: unexpected git config failures are surfaced through the generic git failure path. */
  expectExitCode("config", result, new Set([0]));

  const drivers = new Set<string>();
  for (const key of result.artifactStdout.text.split("\0")) {
    const driver = filterDriverFromKey(key);
    if (driver !== null) drivers.add(driver);
  }

  return [...drivers].flatMap((driver) => [
    `${driver}.clean=`,
    `${driver}.process=`,
    `${driver}.required=false`,
  ]);
}

function processOutput(options: {
  readonly stdout: CapturedByteOutput;
  readonly stderr: CapturedByteOutput;
  readonly maxBytes: number;
}): string {
  const output: string[] = [];
  /* v8 ignore next: callers skip known-empty tracked diffs; this remains as a defensive guard for git races/warnings. */
  if (options.stdout.text !== "") output.push(options.stdout.text.trimEnd());
  if (options.stdout.truncated) {
    output.push(
      `[git_diff stdout truncated: showing first ${options.maxBytes} bytes]`,
    );
  }
  /* v8 ignore next 3: stderr pass-through is for unexpected git warnings; successful fixture diffs keep stderr empty. */
  if (options.stderr.text !== "") {
    output.push(`git stderr:\n${options.stderr.text.trimEnd()}`);
  }
  /* v8 ignore next 4: stderr truncation is a defensive cap for unexpected noisy git warnings/errors. */
  if (options.stderr.truncated) {
    output.push(
      `[git_diff stderr truncated: showing first ${options.maxBytes} bytes]`,
    );
  }
  return output.join("\n");
}

function appendOutputSection(
  sections: string[],
  label: string,
  output: string,
): void {
  /* v8 ignore next: callers skip known-empty tracked diffs; this remains as a defensive guard for git races/warnings. */
  if (output !== "") sections.push(`${label}:\n${output}`);
}

function appendProcessSections(
  sections: string[],
  artifactSections: string[],
  label: string,
  result: GitProcessResult,
): void {
  appendOutputSection(
    sections,
    label,
    processOutput({
      stdout: result.stdout,
      stderr: result.stderr,
      maxBytes: OUTPUT_MAX_BYTES,
    }),
  );
  appendOutputSection(
    artifactSections,
    label,
    processOutput({
      stdout: result.artifactStdout,
      stderr: result.artifactStderr,
      maxBytes: ARTIFACT_OUTPUT_MAX_BYTES,
    }),
  );
}

function gitDiffContentSourceTruncated(content: string): boolean {
  return (
    content.includes("[git_diff stdout truncated:") ||
    content.includes("[git_diff stderr truncated:") ||
    content.includes("[git_diff output truncated:")
  );
}

async function runDiff(
  workspacePath: string,
  args: readonly string[],
  paths: readonly string[],
  config: readonly string[],
  signal: AbortSignal | undefined,
): Promise<GitProcessResult> {
  const result = await runGitProcess(
    workspacePath,
    safeDiffArgs(args, paths),
    runOptions(config, signal),
  );
  return expectExitCode("diff", result, new Set([0, 1]));
}

async function resolveGitCommitRef(
  workspacePath: string,
  requestedRef: string,
  config: readonly string[],
  signal: AbortSignal | undefined,
): Promise<string> {
  const result = await runGitProcess(
    workspacePath,
    ["rev-parse", "--verify", "--end-of-options", `${requestedRef}^{commit}`],
    runOptions(config, signal, "metadata"),
  );
  /* v8 ignore next 3: rev-parse timeout/null exit is an OS process-control failure, not deterministic tool behavior. */
  if (result.exitCode === null || result.timedOut) {
    throw gitCommandFailure("rev-parse", result);
  }
  if (result.exitCode !== 0) {
    throw gitRefDoesNotResolveToCommitError(requestedRef);
  }

  const commit = result.artifactStdout.text.trim();
  /* v8 ignore next 3: git rev-parse --verify <ref>^{commit} emits a commit OID on success. */
  if (!GIT_COMMIT_OID_PATTERN.test(commit)) {
    throw gitRefDoesNotResolveToCommitError(requestedRef);
  }
  return commit;
}

async function resolveRefComparison(
  workspacePath: string,
  comparison: GitDiffRefComparison,
  config: readonly string[],
  signal: AbortSignal | undefined,
): Promise<ResolvedGitDiffRefComparison> {
  const [baseCommit, headCommit] = await Promise.all([
    resolveGitCommitRef(workspacePath, comparison.baseRef, config, signal),
    resolveGitCommitRef(workspacePath, comparison.headRef, config, signal),
  ]);
  return { ...comparison, baseCommit, headCommit };
}

async function mergeBaseRef(
  workspacePath: string,
  comparison: ResolvedGitDiffRefComparison,
  config: readonly string[],
  signal: AbortSignal | undefined,
): Promise<string> {
  const result = await runGitProcess(
    workspacePath,
    ["merge-base", comparison.baseCommit, comparison.headCommit],
    runOptions(config, signal, "metadata"),
  );
  /* v8 ignore next 3: merge-base timeout/null exit is an OS process-control failure, not deterministic tool behavior. */
  if (result.exitCode === null || result.timedOut) {
    throw gitCommandFailure("merge-base", result);
  }
  if (result.exitCode === 1) {
    throw noCommonAncestorError(comparison);
  }
  /* v8 ignore next 3: git merge-base returns 0 for success and 1 for no common ancestor; other exits are environment faults. */
  if (result.exitCode !== 0) {
    throw gitCommandFailure("merge-base", result);
  }
  const mergeBase = result.artifactStdout.text.trim();
  /* v8 ignore next 3: successful git merge-base emits the selected ancestor commit. */
  if (mergeBase === "") {
    throw noCommonAncestorError(comparison);
  }
  return mergeBase;
}

async function refComparisonDiffArgs(
  workspacePath: string,
  comparison: ResolvedGitDiffRefComparison,
  config: readonly string[],
  signal: AbortSignal | undefined,
): Promise<readonly string[]> {
  if (!comparison.mergeBase)
    return [comparison.baseCommit, comparison.headCommit];
  return [
    await mergeBaseRef(workspacePath, comparison, config, signal),
    comparison.headCommit,
  ];
}

function parseChangedTrackedEntries(
  nameStatusOutput: string,
): readonly ChangedTrackedEntry[] {
  const tokens = nameStatusOutput.split("\0");
  const entries: ChangedTrackedEntry[] = [];
  let index = 0;

  while (index < tokens.length) {
    const status = tokens[index];
    index += 1;
    if (status === undefined || status === "") break;

    const statusKind = status[0];
    if (statusKind === "R" || statusKind === "C") {
      const oldPath = tokens[index];
      const newPath = tokens[index + 1];
      index += 2;
      /* v8 ignore next: git --name-status -z emits old/new paths for rename/copy entries. */
      if (
        oldPath === undefined ||
        oldPath === "" ||
        newPath === undefined ||
        newPath === ""
      ) {
        continue;
      }
      entries.push({ kind: "paired", oldPath, newPath });
      continue;
    }

    const path = tokens[index];
    index += 1;
    /* v8 ignore next: git --name-status -z emits status/path pairs for non-rename entries. */
    if (path === undefined || path === "") continue;
    entries.push({ kind: "single", path });
  }

  return entries;
}

async function changedTrackedEntries(
  workspacePath: string,
  args: readonly string[],
  config: readonly string[],
  signal: AbortSignal | undefined,
): Promise<readonly ChangedTrackedEntry[]> {
  const result = await runGitProcess(
    workspacePath,
    safeDiffArgs([...args, "--name-status", "-z"], []),
    runOptions(config, signal, "metadata"),
  );
  expectExitCode("diff --name-status", result, new Set([0, 1]));
  return parseChangedTrackedEntries(result.artifactStdout.text);
}

function pathMatchesFilter(path: string, filter: string): boolean {
  if (filter === ".") return true;
  return path === filter || path.startsWith(`${filter}/`);
}

function pathMatchesAnyFilter(
  path: string,
  filters: readonly string[],
): boolean {
  return filters.some((filter) => pathMatchesFilter(path, filter));
}

function trackedEntryPaths(entry: ChangedTrackedEntry): readonly string[] {
  if (entry.kind === "paired") {
    return [entry.oldPath, entry.newPath];
  }
  return [entry.path];
}

function trackedEntryMatchesPathFilters(
  entry: ChangedTrackedEntry,
  paths: readonly string[],
): boolean {
  if (paths.length === 0) return true;
  return trackedEntryPaths(entry).some((path) =>
    pathMatchesAnyFilter(path, paths),
  );
}

function pathVisibleToProvider(
  workspacePath: string,
  projectIgnorePolicy: ProjectIgnorePolicy,
  path: string,
): boolean {
  const absolutePath = resolve(workspacePath, path);
  /* v8 ignore next: git emits paths relative to the queried work tree; this guards unexpected git output. */
  if (!isInsideWorkspace(workspacePath, absolutePath)) return false;
  return !projectIgnorePolicy.isIgnored(absolutePath, false);
}

async function trackedDiffPaths(
  workspacePath: string,
  args: readonly string[],
  paths: readonly string[],
  config: readonly string[],
  signal: AbortSignal | undefined,
  projectIgnorePolicy: ProjectIgnorePolicy,
): Promise<readonly string[]> {
  const entries = await changedTrackedEntries(
    workspacePath,
    args,
    config,
    signal,
  );
  const visiblePaths = new Set<string>();

  for (const entry of entries) {
    const entryPaths = trackedEntryPaths(entry);
    const entryVisible = entryPaths.every((path) =>
      pathVisibleToProvider(workspacePath, projectIgnorePolicy, path),
    );
    if (entryVisible && trackedEntryMatchesPathFilters(entry, paths)) {
      for (const path of entryPaths) {
        visiblePaths.add(path);
      }
    }
  }

  return [...visiblePaths];
}

async function runTrackedDiff(
  workspacePath: string,
  args: readonly string[],
  paths: readonly string[],
  config: readonly string[],
  signal: AbortSignal | undefined,
  projectIgnorePolicy: ProjectIgnorePolicy,
): Promise<GitProcessResult | null> {
  const visiblePaths = await trackedDiffPaths(
    workspacePath,
    args,
    paths,
    config,
    signal,
    projectIgnorePolicy,
  );
  if (visiblePaths.length === 0) return null;
  return runDiff(workspacePath, args, visiblePaths, config, signal);
}

async function untrackedFiles(
  workspacePath: string,
  paths: readonly string[],
  config: readonly string[],
  signal: AbortSignal | undefined,
  projectIgnorePolicy: ProjectIgnorePolicy,
): Promise<readonly string[]> {
  const result = await runGitProcess(
    workspacePath,
    [
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
      ...pathspecArgs(paths),
    ],
    runOptions(config, signal, "metadata"),
  );
  expectExitCode("ls-files", result, new Set([0]));

  return result.artifactStdout.text
    .split("\0")
    .filter(
      (path) =>
        path !== "" &&
        pathVisibleToProvider(workspacePath, projectIgnorePolicy, path),
    );
}

async function appendUntrackedDiffs(
  sections: string[],
  artifactSections: string[],
  workspacePath: string,
  paths: readonly string[],
  config: readonly string[],
  signal: AbortSignal | undefined,
  projectIgnorePolicy: ProjectIgnorePolicy,
): Promise<void> {
  const files = await untrackedFiles(
    workspacePath,
    paths,
    config,
    signal,
    projectIgnorePolicy,
  );
  const visibleFiles = limitCountedOutput(files, UNTRACKED_FILE_LIMIT);
  for (const file of visibleFiles.items) {
    const result = await runGitProcess(
      workspacePath,
      [
        "diff",
        ...UNTRACKED_DIFF_ARGS,
        "--no-index",
        "--",
        nullDevicePath(),
        file,
      ],
      runOptions(config, signal),
    );
    appendProcessSections(
      sections,
      artifactSections,
      `Untracked changes (${relative(workspacePath, resolve(workspacePath, file))})`,
      expectExitCode("diff --no-index", result, new Set([0, 1])),
    );
  }
  if (visibleFiles.truncated) {
    const marker = `[git_diff output truncated: showing first ${visibleFiles.items.length} untracked files. Use paths to narrow output.]`;
    sections.push(marker);
    artifactSections.push(marker);
  }
}

async function isGitWorkspace(
  workspacePath: string,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  const result = await runGitProcess(
    workspacePath,
    ["rev-parse", "--is-inside-work-tree"],
    runOptions(undefined, signal, "metadata"),
  );
  if (result.exitCode !== 0) return false;
  return result.artifactStdout.text.trim() === "true";
}

export async function executeGitDiff(
  workspace: string,
  options: GitDiffOptions = {},
): Promise<ToolResult> {
  const workspacePath = realpathSync(workspace);
  const refComparison = normalizeRefComparison(options);
  const paths = normalizePathFilters(workspacePath, options.paths);
  const projectIgnorePolicy = createProjectIgnorePolicy(workspacePath);
  assertPathFiltersAllowed(workspacePath, paths, projectIgnorePolicy);

  if (!(await isGitWorkspace(workspacePath, options.signal))) {
    return {
      content:
        "Not in a git work tree. git_diff can only inspect changes inside a Git repository.",
    };
  }

  const config = await configuredFilterOverrides(workspacePath, options.signal);
  const sections: string[] = [];
  const artifactSections: string[] = [];

  if (refComparison !== null) {
    const resolvedComparison = await resolveRefComparison(
      workspacePath,
      refComparison,
      config,
      options.signal,
    );
    const refDiff = await runTrackedDiff(
      workspacePath,
      await refComparisonDiffArgs(
        workspacePath,
        resolvedComparison,
        config,
        options.signal,
      ),
      paths,
      config,
      options.signal,
      projectIgnorePolicy,
    );
    if (refDiff !== null) {
      appendProcessSections(
        sections,
        artifactSections,
        refComparisonLabel(refComparison),
        refDiff,
      );
    }
  } else {
    const mode = options.mode ?? "all";

    if (mode === "all" || mode === "unstaged") {
      const unstagedDiff = await runTrackedDiff(
        workspacePath,
        [],
        paths,
        config,
        options.signal,
        projectIgnorePolicy,
      );
      if (unstagedDiff !== null) {
        appendProcessSections(
          sections,
          artifactSections,
          "Unstaged changes",
          unstagedDiff,
        );
      }
    }

    if (mode === "all" || mode === "staged") {
      const stagedDiff = await runTrackedDiff(
        workspacePath,
        ["--cached"],
        paths,
        config,
        options.signal,
        projectIgnorePolicy,
      );
      if (stagedDiff !== null) {
        appendProcessSections(
          sections,
          artifactSections,
          "Staged changes",
          stagedDiff,
        );
      }
    }

    if (mode === "all" || mode === "unstaged") {
      await appendUntrackedDiffs(
        sections,
        artifactSections,
        workspacePath,
        paths,
        config,
        options.signal,
        projectIgnorePolicy,
      );
    }
  }

  const content =
    sections.length === 0 ? "No git changes found." : sections.join("\n\n");
  const artifactContent =
    artifactSections.length === 0
      ? "No git changes found."
      : artifactSections.join("\n\n");
  const previewTruncated = gitDiffContentSourceTruncated(content);
  const artifactSourceTruncated =
    gitDiffContentSourceTruncated(artifactContent);
  return {
    content,
    ...(previewTruncated ? { sourceTruncated: true } : {}),
    ...(previewTruncated || artifactSourceTruncated ? { artifactContent } : {}),
    ...(previewTruncated || artifactSourceTruncated
      ? { artifactSourceTruncated }
      : {}),
  };
}
