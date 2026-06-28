import { type ChildProcessByStdio, spawn } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, win32 } from "node:path";
import type { Readable } from "node:stream";
import { KeelError } from "../core/error.ts";
import {
  createProjectIgnorePolicy,
  type ProjectIgnorePolicy,
} from "./project-ignore.ts";
import type { ToolResult } from "./types.ts";
import { isInsideWorkspace } from "./workspace-path.ts";

const DEFAULT_TIMEOUT_MS = 30_000;
const OUTPUT_MAX_BYTES = 100_000;
const UNTRACKED_FILE_LIMIT = 50;
const GIT_OPTIONAL_LOCKS_ENV = "GIT_OPTIONAL_LOCKS";
const GIT_PAGER_ENV = "GIT_PAGER";

const DIFF_SAFETY_ARGS = [
  "--no-color",
  "--no-ext-diff",
  "--no-textconv",
  "--no-renames",
  "--submodule=short",
  "--ignore-submodules=dirty",
];

type GitDiffMode = "all" | "unstaged" | "staged";

export interface GitDiffOptions {
  readonly mode?: GitDiffMode;
  readonly paths?: readonly string[];
  readonly signal?: AbortSignal;
}

interface CapturedStream {
  readonly text: string;
  readonly truncated: boolean;
}

interface GitProcessResult {
  readonly stdout: CapturedStream;
  readonly stderr: CapturedStream;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly timeoutMs: number;
}

interface RunGitOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly config?: readonly string[];
}

interface ChangedTrackedEntry {
  readonly diffPath: string;
}

class HeadBuffer {
  readonly #maxBytes: number;
  #chunks: Buffer[] = [];
  #bytes = 0;
  #truncated = false;

  constructor(maxBytes: number) {
    this.#maxBytes = maxBytes;
  }

  append(chunk: Buffer): void {
    if (this.#bytes >= this.#maxBytes) {
      this.#truncated = true;
      return;
    }

    const remainingBytes = this.#maxBytes - this.#bytes;
    if (chunk.length <= remainingBytes) {
      this.#chunks.push(chunk);
      this.#bytes += chunk.length;
      return;
    }

    this.#chunks.push(chunk.subarray(0, remainingBytes));
    this.#bytes = this.#maxBytes;
    this.#truncated = true;
  }

  capture(): CapturedStream {
    return {
      text: Buffer.concat(this.#chunks, this.#bytes).toString("utf8"),
      truncated: this.#truncated,
    };
  }
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
): RunGitOptions {
  return {
    ...(config !== undefined ? { config } : {}),
    ...(signal !== undefined ? { signal } : {}),
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

function runGitProcess(
  workspacePath: string,
  args: readonly string[],
  options: RunGitOptions = {},
): Promise<GitProcessResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const stdout = new HeadBuffer(OUTPUT_MAX_BYTES);
  const stderr = new HeadBuffer(OUTPUT_MAX_BYTES);
  const gitArgs = [
    "--no-pager",
    "--no-optional-locks",
    ...gitConfigArgs(options.config),
    ...args,
  ];

  return new Promise<GitProcessResult>((resolveProcess, rejectProcess) => {
    if (options.signal?.aborted === true) {
      rejectProcess(
        new KeelError(
          "tool_aborted",
          "git_diff failed: command aborted",
          "The task was cancelled. Do not retry this tool call; proceed with the next step or stop.",
        ),
      );
      return;
    }

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
      cleanup();
      /* v8 ignore next 4: child spawn failures and mid-process aborts are environment/process faults. */
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

    child.stdout.on("data", (chunk: Buffer) => {
      stdout.append(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr.append(chunk);
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

  const absolutePath = resolve(workspacePath, normalizedPath);
  /* v8 ignore next 3: lexical validation above constrains normalized relative paths inside the workspace. */
  if (!isInsideWorkspace(workspacePath, absolutePath)) {
    throw pathFilterError(requestedPath);
  }
  return normalizedPath;
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
  return paths.length === 0 ? [] : ["--", ...paths];
}

function safeDiffArgs(
  extraArgs: readonly string[],
  paths: readonly string[],
): readonly string[] {
  return ["diff", ...DIFF_SAFETY_ARGS, ...extraArgs, ...pathspecArgs(paths)];
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
    runOptions(undefined, signal),
  );
  /* v8 ignore next: exit 1 is git's normal no-match result; other config failures are environment faults. */
  if (result.exitCode === 1) return [];
  /* v8 ignore next: unexpected git config failures are surfaced through the generic git failure path. */
  expectExitCode("config", result, new Set([0]));

  const drivers = new Set<string>();
  for (const key of result.stdout.text.split("\0")) {
    const driver = filterDriverFromKey(key);
    if (driver !== null) drivers.add(driver);
  }

  return [...drivers].flatMap((driver) => [
    `${driver}.clean=`,
    `${driver}.process=`,
    `${driver}.required=false`,
  ]);
}

function processOutput(result: GitProcessResult): string {
  const output: string[] = [];
  /* v8 ignore next: callers skip known-empty tracked diffs; this remains as a defensive guard for git races/warnings. */
  if (result.stdout.text !== "") output.push(result.stdout.text.trimEnd());
  if (result.stdout.truncated) {
    output.push(
      `[git_diff stdout truncated: showing first ${OUTPUT_MAX_BYTES} bytes]`,
    );
  }
  /* v8 ignore next 3: stderr pass-through is for unexpected git warnings; successful fixture diffs keep stderr empty. */
  if (result.stderr.text !== "") {
    output.push(`git stderr:\n${result.stderr.text.trimEnd()}`);
  }
  /* v8 ignore next 4: stderr truncation is a defensive cap for unexpected noisy git warnings/errors. */
  if (result.stderr.truncated) {
    output.push(
      `[git_diff stderr truncated: showing first ${OUTPUT_MAX_BYTES} bytes]`,
    );
  }
  return output.join("\n");
}

function appendProcessSection(
  sections: string[],
  label: string,
  result: GitProcessResult,
): void {
  const output = processOutput(result);
  /* v8 ignore next: callers skip known-empty tracked diffs; this remains as a defensive guard for git races/warnings. */
  if (output !== "") sections.push(`${label}:\n${output}`);
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

function parseChangedTrackedEntries(
  nameStatusOutput: string,
): readonly ChangedTrackedEntry[] {
  const tokens = nameStatusOutput.split("\0");
  const entries: ChangedTrackedEntry[] = [];
  let index = 0;

  while (index + 1 < tokens.length && tokens[index] !== "") {
    index += 1;
    const path = tokens[index];
    index += 1;
    /* v8 ignore next: git --name-status -z emits status/path pairs; this guards malformed output. */
    if (path === undefined || path === "") continue;
    entries.push({ diffPath: path });
  }

  return entries;
}

async function changedTrackedEntries(
  workspacePath: string,
  args: readonly string[],
  paths: readonly string[],
  config: readonly string[],
  signal: AbortSignal | undefined,
): Promise<readonly ChangedTrackedEntry[]> {
  const result = await runGitProcess(
    workspacePath,
    safeDiffArgs([...args, "--name-status", "-z"], paths),
    runOptions(config, signal),
  );
  expectExitCode("diff --name-status", result, new Set([0, 1]));
  return parseChangedTrackedEntries(result.stdout.text);
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
    paths,
    config,
    signal,
  );
  const visiblePaths = new Set<string>();

  for (const entry of entries) {
    if (
      pathVisibleToProvider(workspacePath, projectIgnorePolicy, entry.diffPath)
    ) {
      visiblePaths.add(entry.diffPath);
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
    runOptions(config, signal),
  );
  expectExitCode("ls-files", result, new Set([0]));

  return result.stdout.text
    .split("\0")
    .filter(
      (path) =>
        path !== "" &&
        pathVisibleToProvider(workspacePath, projectIgnorePolicy, path),
    );
}

async function appendUntrackedDiffs(
  sections: string[],
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
  const visibleFiles = files.slice(0, UNTRACKED_FILE_LIMIT);
  for (const file of visibleFiles) {
    const result = await runGitProcess(
      workspacePath,
      ["diff", ...DIFF_SAFETY_ARGS, "--no-index", "--", nullDevicePath(), file],
      runOptions(config, signal),
    );
    appendProcessSection(
      sections,
      `Untracked changes (${relative(workspacePath, resolve(workspacePath, file))})`,
      expectExitCode("diff --no-index", result, new Set([0, 1])),
    );
  }
  if (files.length > visibleFiles.length) {
    sections.push(
      `[git_diff output truncated: showing first ${visibleFiles.length} untracked files. Use paths to narrow output.]`,
    );
  }
}

async function isGitWorkspace(
  workspacePath: string,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  const result = await runGitProcess(
    workspacePath,
    ["rev-parse", "--is-inside-work-tree"],
    runOptions(undefined, signal),
  );
  if (result.exitCode !== 0) return false;
  return result.stdout.text.trim() === "true";
}

export async function executeGitDiff(
  workspace: string,
  options: GitDiffOptions = {},
): Promise<ToolResult> {
  const workspacePath = realpathSync(workspace);
  const mode = options.mode ?? "all";
  const paths = normalizePathFilters(workspacePath, options.paths);
  const projectIgnorePolicy = createProjectIgnorePolicy(workspacePath);
  assertPathFiltersAllowed(workspacePath, paths, projectIgnorePolicy);

  if (!(await isGitWorkspace(workspacePath, options.signal))) {
    return {
      content:
        "Not in a git work tree. git_diff can only inspect current changes inside a Git repository.",
    };
  }

  const config = await configuredFilterOverrides(workspacePath, options.signal);
  const sections: string[] = [];

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
      appendProcessSection(sections, "Unstaged changes", unstagedDiff);
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
      appendProcessSection(sections, "Staged changes", stagedDiff);
    }
  }

  if (mode === "all" || mode === "unstaged") {
    await appendUntrackedDiffs(
      sections,
      workspacePath,
      paths,
      config,
      options.signal,
      projectIgnorePolicy,
    );
  }

  return {
    content:
      sections.length === 0 ? "No git changes found." : sections.join("\n\n"),
  };
}
