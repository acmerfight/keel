import { realpathSync } from "node:fs";
import { KeelError } from "../core/error.ts";
import {
  assertGitPathFiltersAllowed,
  expectGitExitCode,
  GIT_ARTIFACT_OUTPUT_MAX_BYTES,
  GIT_PREVIEW_OUTPUT_MAX_BYTES,
  type GitProcessResult,
  gitCommandFailure,
  gitNullDevicePath,
  gitPathspecArgs,
  gitPathVisibleToProvider,
  gitRunOptions,
  normalizeGitPathFilters,
  resolveGitWorkTreeScope,
  runGitProcess,
} from "./git-process.ts";
import { type CapturedByteOutput, limitCountedOutput } from "./output-limit.ts";
import {
  createProjectIgnorePolicy,
  type ProjectIgnorePolicy,
} from "./project-ignore.ts";
import type { ToolResult } from "./types.ts";

const UNTRACKED_FILE_LIMIT = 50;
const GIT_DIFF_NO_CHANGES_CONTENT = "No git changes found.";
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

export interface GitDiffOptions {
  readonly mode?: GitDiffMode;
  readonly baseRef?: string;
  readonly headRef?: string;
  readonly mergeBase?: boolean;
  readonly paths?: readonly string[];
  readonly signal?: AbortSignal;
}

export interface GitDiffResult extends ToolResult {
  readonly hasChanges: boolean;
  readonly inGitWorkTree: boolean;
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

function safeDiffArgs(
  extraArgs: readonly string[],
  paths: readonly string[],
): readonly string[] {
  return [
    "diff",
    ...TRACKED_DIFF_ARGS,
    ...extraArgs,
    ...gitPathspecArgs(paths),
  ];
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
    "git_diff",
    workspacePath,
    [
      "config",
      "--null",
      "--name-only",
      "--get-regexp",
      "^filter\\..*\\.(clean|process)$",
    ],
    gitRunOptions(undefined, signal, "metadata"),
  );
  /* v8 ignore next: exit 1 is git's normal no-match result; other config failures are environment faults. */
  if (result.exitCode === 1) return [];
  /* v8 ignore next: unexpected git config failures are surfaced through the generic git failure path. */
  expectGitExitCode("git_diff", "config", result, new Set([0]));

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
      maxBytes: GIT_PREVIEW_OUTPUT_MAX_BYTES,
    }),
  );
  appendOutputSection(
    artifactSections,
    label,
    processOutput({
      stdout: result.artifactStdout,
      stderr: result.artifactStderr,
      maxBytes: GIT_ARTIFACT_OUTPUT_MAX_BYTES,
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
    "git_diff",
    workspacePath,
    safeDiffArgs(args, paths),
    gitRunOptions(config, signal),
  );
  return expectGitExitCode("git_diff", "diff", result, new Set([0, 1]));
}

async function resolveGitCommitRef(
  workspacePath: string,
  requestedRef: string,
  config: readonly string[],
  signal: AbortSignal | undefined,
): Promise<string> {
  const result = await runGitProcess(
    "git_diff",
    workspacePath,
    ["rev-parse", "--verify", "--end-of-options", `${requestedRef}^{commit}`],
    gitRunOptions(config, signal, "metadata"),
  );
  /* v8 ignore next 3: rev-parse timeout/null exit is an OS process-control failure, not deterministic tool behavior. */
  if (result.exitCode === null || result.timedOut) {
    throw gitCommandFailure("git_diff", "rev-parse", result);
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
    "git_diff",
    workspacePath,
    ["merge-base", comparison.baseCommit, comparison.headCommit],
    gitRunOptions(config, signal, "metadata"),
  );
  /* v8 ignore next 3: merge-base timeout/null exit is an OS process-control failure, not deterministic tool behavior. */
  if (result.exitCode === null || result.timedOut) {
    throw gitCommandFailure("git_diff", "merge-base", result);
  }
  if (result.exitCode === 1) {
    throw noCommonAncestorError(comparison);
  }
  /* v8 ignore next 3: git merge-base returns 0 for success and 1 for no common ancestor; other exits are environment faults. */
  if (result.exitCode !== 0) {
    throw gitCommandFailure("git_diff", "merge-base", result);
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
  paths: readonly string[],
  config: readonly string[],
  signal: AbortSignal | undefined,
): Promise<readonly ChangedTrackedEntry[]> {
  const result = await runGitProcess(
    "git_diff",
    workspacePath,
    safeDiffArgs([...args, "--name-status", "-z"], paths),
    gitRunOptions(config, signal, "metadata"),
  );
  expectGitExitCode("git_diff", "diff --name-status", result, new Set([0, 1]));
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

async function trackedDiffPaths(
  workspacePath: string,
  gitRootPath: string,
  args: readonly string[],
  discoveryPaths: readonly string[],
  paths: readonly string[],
  config: readonly string[],
  signal: AbortSignal | undefined,
  projectIgnorePolicy: ProjectIgnorePolicy,
): Promise<readonly string[]> {
  const entries = await changedTrackedEntries(
    gitRootPath,
    args,
    discoveryPaths,
    config,
    signal,
  );
  const visiblePaths = new Set<string>();

  for (const entry of entries) {
    const entryPaths = trackedEntryPaths(entry);
    const entryVisible = entryPaths.every((path) =>
      gitPathVisibleToProvider(
        workspacePath,
        gitRootPath,
        projectIgnorePolicy,
        path,
      ),
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
  gitRootPath: string,
  args: readonly string[],
  discoveryPaths: readonly string[],
  paths: readonly string[],
  config: readonly string[],
  signal: AbortSignal | undefined,
  projectIgnorePolicy: ProjectIgnorePolicy,
): Promise<GitProcessResult | null> {
  const visiblePaths = await trackedDiffPaths(
    workspacePath,
    gitRootPath,
    args,
    discoveryPaths,
    paths,
    config,
    signal,
    projectIgnorePolicy,
  );
  if (visiblePaths.length === 0) return null;
  return runDiff(gitRootPath, args, visiblePaths, config, signal);
}

async function untrackedFiles(
  workspacePath: string,
  gitRootPath: string,
  paths: readonly string[],
  config: readonly string[],
  signal: AbortSignal | undefined,
  projectIgnorePolicy: ProjectIgnorePolicy,
): Promise<readonly string[]> {
  const result = await runGitProcess(
    "git_diff",
    gitRootPath,
    [
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
      ...gitPathspecArgs(paths),
    ],
    gitRunOptions(config, signal, "metadata"),
  );
  expectGitExitCode("git_diff", "ls-files", result, new Set([0]));

  return result.artifactStdout.text
    .split("\0")
    .filter(
      (path) =>
        path !== "" &&
        gitPathVisibleToProvider(
          workspacePath,
          gitRootPath,
          projectIgnorePolicy,
          path,
        ),
    );
}

async function appendUntrackedDiffs(
  sections: string[],
  artifactSections: string[],
  workspacePath: string,
  gitRootPath: string,
  paths: readonly string[],
  config: readonly string[],
  signal: AbortSignal | undefined,
  projectIgnorePolicy: ProjectIgnorePolicy,
): Promise<void> {
  const files = await untrackedFiles(
    workspacePath,
    gitRootPath,
    paths,
    config,
    signal,
    projectIgnorePolicy,
  );
  const visibleFiles = limitCountedOutput(files, UNTRACKED_FILE_LIMIT);
  for (const file of visibleFiles.items) {
    const result = await runGitProcess(
      "git_diff",
      gitRootPath,
      [
        "diff",
        ...UNTRACKED_DIFF_ARGS,
        "--no-index",
        "--",
        gitNullDevicePath(),
        file,
      ],
      gitRunOptions(config, signal),
    );
    appendProcessSections(
      sections,
      artifactSections,
      `Untracked changes (${file})`,
      expectGitExitCode("git_diff", "diff --no-index", result, new Set([0, 1])),
    );
  }
  if (visibleFiles.truncated) {
    const marker = `[git_diff output truncated: showing first ${visibleFiles.items.length} untracked files. Use paths to narrow output.]`;
    sections.push(marker);
    artifactSections.push(marker);
  }
}

export async function executeGitDiff(
  workspace: string,
  options: GitDiffOptions = {},
): Promise<GitDiffResult> {
  const workspacePath = realpathSync(workspace);
  const refComparison = normalizeRefComparison(options);
  const paths = normalizeGitPathFilters(
    "git_diff",
    workspacePath,
    options.paths,
  );
  const scope = await resolveGitWorkTreeScope(
    "git_diff",
    workspacePath,
    paths,
    options.signal,
  );
  if (scope === null) {
    return {
      content:
        "Not in a git work tree. git_diff can only inspect changes inside a Git repository.",
      hasChanges: false,
      inGitWorkTree: false,
    };
  }
  const projectIgnorePolicy = createProjectIgnorePolicy(scope.rootPath);
  assertGitPathFiltersAllowed(
    "git_diff",
    workspacePath,
    paths,
    projectIgnorePolicy,
  );

  const config = await configuredFilterOverrides(
    scope.rootPath,
    options.signal,
  );
  const sections: string[] = [];
  const artifactSections: string[] = [];

  if (refComparison !== null) {
    const resolvedComparison = await resolveRefComparison(
      scope.rootPath,
      refComparison,
      config,
      options.signal,
    );
    const refDiff = await runTrackedDiff(
      workspacePath,
      scope.rootPath,
      await refComparisonDiffArgs(
        scope.rootPath,
        resolvedComparison,
        config,
        options.signal,
      ),
      [scope.workspacePathspec],
      scope.pathspecs,
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
        scope.rootPath,
        [],
        [scope.workspacePathspec],
        scope.pathspecs,
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
        scope.rootPath,
        ["--cached"],
        [scope.workspacePathspec],
        scope.pathspecs,
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
        scope.rootPath,
        scope.pathspecs,
        config,
        options.signal,
        projectIgnorePolicy,
      );
    }
  }

  const content =
    sections.length === 0 ? GIT_DIFF_NO_CHANGES_CONTENT : sections.join("\n\n");
  const artifactContent =
    artifactSections.length === 0
      ? GIT_DIFF_NO_CHANGES_CONTENT
      : artifactSections.join("\n\n");
  const previewTruncated = gitDiffContentSourceTruncated(content);
  const artifactSourceTruncated =
    gitDiffContentSourceTruncated(artifactContent);
  return {
    content,
    hasChanges: sections.length > 0,
    inGitWorkTree: true,
    ...(previewTruncated ? { sourceTruncated: true } : {}),
    ...(previewTruncated || artifactSourceTruncated ? { artifactContent } : {}),
    ...(previewTruncated || artifactSourceTruncated
      ? { artifactSourceTruncated }
      : {}),
  };
}
