import { realpathSync } from "node:fs";
import { z } from "zod";
import { KeelError } from "../core/error.ts";
import {
  assertGitPathFiltersAllowed,
  expectGitExitCode,
  GIT_ARTIFACT_OUTPUT_MAX_BYTES,
  GIT_PREVIEW_OUTPUT_MAX_BYTES,
  type GitPathspecs,
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
const GIT_COMMIT_OID_OUTPUT_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?\r?\n$/u;
const FILTER_DRIVER_KEY_PATTERN = /^filter\.[^=]+\.(?:clean|process)$/u;
const SINGLE_CHANGED_STATUS_PATTERN = /^(?:[ADMTUXB]|M(?:100|0[0-9]{2}))$/u;
const PAIRED_CHANGED_STATUS_PATTERN = /^[RC](?:100|0[0-9]{2})$/u;

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
  readonly hiddenPaths?: readonly string[];
}

export interface GitDiffResult extends ToolResult {
  readonly hasChanges: boolean;
  readonly inGitWorkTree: boolean;
}

const changedTrackedPathSchema = z.string().min(1);
const changedTrackedEntrySchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("single"),
      path: changedTrackedPathSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("paired"),
      oldPath: changedTrackedPathSchema,
      newPath: changedTrackedPathSchema,
    })
    .strict(),
]);
const changedTrackedEntriesSchema = z.array(changedTrackedEntrySchema);
const filterDriverKeySchema = z
  .string()
  .regex(FILTER_DRIVER_KEY_PATTERN)
  .transform((key) => {
    const suffix = key.endsWith(".clean") ? ".clean" : ".process";
    return key.slice(0, -suffix.length);
  });
const filterDriverKeysSchema = z.array(filterDriverKeySchema).min(1);

type ChangedTrackedEntry = z.infer<typeof changedTrackedEntrySchema>;

interface GitDiffRefComparison {
  readonly baseRef: string;
  readonly headRef: string;
  readonly mergeBase: boolean;
}

interface ResolvedGitDiffRefComparison extends GitDiffRefComparison {
  readonly baseCommit: string;
  readonly headCommit: string;
}

interface GitDiffSourceTruncation {
  readonly preview: boolean;
  readonly artifact: boolean;
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

function malformedGitOutputError(command: string): KeelError {
  return new KeelError(
    "tool_unavailable",
    `git_diff failed: git ${command} returned malformed output`,
    "Retry git_diff, or inspect the affected files directly with read/grep.",
  );
}

function truncatedGitMetadataError(command: string): KeelError {
  return new KeelError(
    "tool_unavailable",
    `git_diff failed: git ${command} returned truncated metadata`,
    "Use paths to narrow the metadata set, or inspect files directly with read/grep.",
  );
}

function completeGitMetadata(
  command: string,
  output: CapturedByteOutput,
): string {
  if (output.truncated) {
    throw truncatedGitMetadataError(command);
  }
  return output.text;
}

function stripFinalLf(output: string): string {
  return output.endsWith("\n") ? output.slice(0, -1) : output;
}

function parseGitCommitOid(
  command: string,
  output: CapturedByteOutput,
): string {
  const completeOutput = completeGitMetadata(command, output);
  if (!GIT_COMMIT_OID_OUTPUT_PATTERN.test(completeOutput)) {
    throw malformedGitOutputError(command);
  }
  return completeOutput.replace(/\r?\n$/u, "");
}

function nulTerminatedGitRecords(
  command: string,
  output: string,
): readonly string[] {
  if (output === "") return [];
  if (!output.endsWith("\0")) {
    throw malformedGitOutputError(command);
  }
  const parsed = z
    .array(changedTrackedPathSchema)
    .safeParse(output.slice(0, -1).split("\0"));
  if (!parsed.success) {
    throw malformedGitOutputError(command);
  }
  return parsed.data;
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
  if (result.exitCode === 1) {
    if (completeGitMetadata("config", result.artifactStdout) !== "") {
      throw malformedGitOutputError("config");
    }
    return [];
  }
  expectGitExitCode("git_diff", "config", result, new Set([0]));

  const parsed = filterDriverKeysSchema.safeParse(
    nulTerminatedGitRecords(
      "config",
      completeGitMetadata("config", result.artifactStdout),
    ),
  );
  if (!parsed.success) {
    throw malformedGitOutputError("config");
  }

  return [...new Set(parsed.data)].flatMap((driver) => [
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
  const output = [stripFinalLf(options.stdout.text)];
  if (options.stdout.truncated) {
    output.push(
      `[git_diff stdout truncated: showing first ${options.maxBytes} bytes]`,
    );
  }
  if (options.stderr.text !== "") {
    output.push(`git stderr:\n${stripFinalLf(options.stderr.text)}`);
  }
  if (options.stderr.truncated) {
    output.push(
      `[git_diff stderr truncated: showing first ${options.maxBytes} bytes]`,
    );
  }
  return output.join("\n");
}

function appendProcessSections(
  sections: string[],
  artifactSections: string[],
  label: string,
  result: GitProcessResult,
): GitDiffSourceTruncation {
  if (result.artifactStdout.text === "") {
    throw malformedGitOutputError("diff");
  }
  sections.push(
    `${label}:\n${processOutput({
      stdout: result.stdout,
      stderr: result.stderr,
      maxBytes: GIT_PREVIEW_OUTPUT_MAX_BYTES,
    })}`,
  );
  artifactSections.push(
    `${label}:\n${processOutput({
      stdout: result.artifactStdout,
      stderr: result.artifactStderr,
      maxBytes: GIT_ARTIFACT_OUTPUT_MAX_BYTES,
    })}`,
  );
  return {
    preview: result.stdout.truncated || result.stderr.truncated,
    artifact:
      result.artifactStdout.truncated || result.artifactStderr.truncated,
  };
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
  return expectGitExitCode("git_diff", "diff", result, new Set([0]));
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
  if (result.exitCode === null) {
    throw gitCommandFailure("git_diff", "rev-parse", result);
  }
  /* v8 ignore next 3 -- the numeric-exit timeout race is owned by expectGitExitCode's process-level contract. */
  if (result.timedOut) {
    throw gitCommandFailure("git_diff", "rev-parse", result);
  }
  if (result.exitCode !== 0) {
    throw gitRefDoesNotResolveToCommitError(requestedRef);
  }

  return parseGitCommitOid("rev-parse", result.artifactStdout);
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
  if (result.exitCode === null) {
    throw gitCommandFailure("git_diff", "merge-base", result);
  }
  /* v8 ignore next 3 -- the numeric-exit timeout race is owned by expectGitExitCode's process-level contract. */
  if (result.timedOut) {
    throw gitCommandFailure("git_diff", "merge-base", result);
  }
  if (result.exitCode === 1) {
    throw noCommonAncestorError(comparison);
  }
  if (result.exitCode !== 0) {
    throw gitCommandFailure("git_diff", "merge-base", result);
  }
  return parseGitCommitOid("merge-base", result.artifactStdout);
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
  const tokens = nulTerminatedGitRecords(
    "diff --name-status",
    nameStatusOutput,
  );
  const entries: unknown[] = [];
  const iterator = tokens[Symbol.iterator]();

  for (const status of iterator) {
    if (PAIRED_CHANGED_STATUS_PATTERN.test(status)) {
      const oldPath = iterator.next().value;
      const newPath = iterator.next().value;
      entries.push({ kind: "paired", oldPath, newPath });
      continue;
    }
    if (!SINGLE_CHANGED_STATUS_PATTERN.test(status)) {
      throw malformedGitOutputError("diff --name-status");
    }

    const path = iterator.next().value;
    entries.push({ kind: "single", path });
  }

  const parsed = changedTrackedEntriesSchema.safeParse(entries);
  if (!parsed.success) {
    throw malformedGitOutputError("diff --name-status");
  }
  return parsed.data;
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
  expectGitExitCode("git_diff", "diff --name-status", result, new Set([0]));
  return parseChangedTrackedEntries(
    completeGitMetadata("diff --name-status", result.artifactStdout),
  );
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
  paths: GitPathspecs,
): boolean {
  return trackedEntryPaths(entry).some((path) =>
    pathMatchesAnyFilter(path, paths),
  );
}

async function trackedDiffPaths(
  workspacePath: string,
  gitRootPath: string,
  args: readonly string[],
  discoveryPaths: readonly string[],
  paths: GitPathspecs,
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
  paths: GitPathspecs,
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
  paths: GitPathspecs,
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

  return nulTerminatedGitRecords(
    "ls-files",
    completeGitMetadata("ls-files", result.artifactStdout),
  ).filter((path) =>
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
  paths: GitPathspecs,
  config: readonly string[],
  signal: AbortSignal | undefined,
  projectIgnorePolicy: ProjectIgnorePolicy,
): Promise<GitDiffSourceTruncation> {
  const files = await untrackedFiles(
    workspacePath,
    gitRootPath,
    paths,
    config,
    signal,
    projectIgnorePolicy,
  );
  const visibleFiles = limitCountedOutput(files, UNTRACKED_FILE_LIMIT);
  const sourceTruncations: GitDiffSourceTruncation[] = [];
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
    sourceTruncations.push(
      appendProcessSections(
        sections,
        artifactSections,
        `Untracked changes (${file})`,
        expectGitExitCode(
          "git_diff",
          "diff --no-index",
          result,
          new Set([0, 1]),
        ),
      ),
    );
  }
  if (visibleFiles.truncated) {
    const marker = `[git_diff output truncated: showing first ${visibleFiles.items.length} untracked files. Use paths to narrow output.]`;
    sections.push(marker);
    artifactSections.push(marker);
  }
  return {
    preview:
      visibleFiles.truncated ||
      sourceTruncations.some((truncation) => truncation.preview),
    artifact:
      visibleFiles.truncated ||
      sourceTruncations.some((truncation) => truncation.artifact),
  };
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
  const projectIgnorePolicy = createProjectIgnorePolicy(
    scope.rootPath,
    options.hiddenPaths,
  );
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
  const sourceTruncations: GitDiffSourceTruncation[] = [];

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
      sourceTruncations.push(
        appendProcessSections(
          sections,
          artifactSections,
          refComparisonLabel(refComparison),
          refDiff,
        ),
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
        sourceTruncations.push(
          appendProcessSections(
            sections,
            artifactSections,
            "Unstaged changes",
            unstagedDiff,
          ),
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
        sourceTruncations.push(
          appendProcessSections(
            sections,
            artifactSections,
            "Staged changes",
            stagedDiff,
          ),
        );
      }
    }

    if (mode === "all" || mode === "unstaged") {
      sourceTruncations.push(
        await appendUntrackedDiffs(
          sections,
          artifactSections,
          workspacePath,
          scope.rootPath,
          scope.pathspecs,
          config,
          options.signal,
          projectIgnorePolicy,
        ),
      );
    }
  }

  const content =
    sections.length === 0 ? GIT_DIFF_NO_CHANGES_CONTENT : sections.join("\n\n");
  const artifactContent =
    artifactSections.length === 0
      ? GIT_DIFF_NO_CHANGES_CONTENT
      : artifactSections.join("\n\n");
  const previewSourceTruncated = sourceTruncations.some(
    (truncation) => truncation.preview,
  );
  const artifactSourceTruncated = sourceTruncations.some(
    (truncation) => truncation.artifact,
  );
  return {
    content,
    hasChanges: sections.length > 0,
    inGitWorkTree: true,
    ...(previewSourceTruncated ? { sourceTruncated: true } : {}),
    ...(previewSourceTruncated || artifactSourceTruncated
      ? { artifactContent }
      : {}),
    ...(previewSourceTruncated || artifactSourceTruncated
      ? { artifactSourceTruncated }
      : {}),
  };
}
