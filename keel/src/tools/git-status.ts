import { realpathSync } from "node:fs";
import { isAbsolute, sep } from "node:path";
import { z } from "zod";
import { KeelError } from "../core/error.ts";
import {
  assertGitPathFiltersAllowed,
  expectGitExitCode,
  GIT_ARTIFACT_OUTPUT_MAX_BYTES,
  gitPathspecArgs,
  gitPathVisibleToProvider,
  gitRunOptions,
  normalizeGitPathFilters,
  resolveGitWorkTreeScope,
  runGitProcess,
} from "./git-process.ts";
import { type CapturedByteOutput, limitCountedOutput } from "./output-limit.ts";
import { createProjectIgnorePolicy } from "./project-ignore.ts";
import type { ToolResult } from "./types.ts";

const STATUS_ENTRY_LIMIT = 200;

export interface GitStatusOptions {
  readonly paths?: readonly string[];
  readonly signal?: AbortSignal;
  readonly hiddenPaths?: readonly string[];
}

export interface GitStatusResult extends ToolResult {
  readonly inGitWorkTree: boolean;
}

interface GitStatusBranch {
  readonly head: string;
  readonly upstream: string | null;
  readonly aheadBehind: {
    readonly ahead: number;
    readonly behind: number;
  } | null;
}

interface ParsedGitStatus {
  readonly branch: GitStatusBranch;
  readonly entries: readonly GitStatusEntry[];
}

interface GitStatusBranchState {
  readonly head: string | null;
  readonly upstream: string | null;
  readonly aheadBehind: {
    readonly ahead: number;
    readonly behind: number;
  } | null;
}

type GitObjectIdLength = 40 | 64;

interface ParsedTrackedStatusEntry {
  readonly entry: GitStatusEntry;
  readonly objectIdLength: GitObjectIdLength;
}

function isValidGitStatusPath(value: string): boolean {
  if (value.includes("\0") || isAbsolute(value)) return false;
  const components = value.replaceAll(sep, "/").split("/");
  return components.every(
    (component) => component !== "" && component !== "." && component !== "..",
  );
}

const gitStatusPathSchema = z.string().min(1).refine(isValidGitStatusPath);
const ordinaryStatusCodeSchema = z.enum([
  ".A",
  ".M",
  ".T",
  ".D",
  "M.",
  "MM",
  "MT",
  "MD",
  "T.",
  "TM",
  "TT",
  "TD",
  "A.",
  "AM",
  "AT",
  "AD",
  "D.",
]);
const renamedStatusCodeSchema = z.enum(["R.", "RM", "RT", "RD", ".R"]);
const unmergedStatusCodeSchema = z.enum([
  "DD",
  "AU",
  "UD",
  "UA",
  "DU",
  "AA",
  "UU",
]);
const gitStatusSubmoduleSchema = z
  .string()
  .regex(/^(?:N\.\.\.|S[.C][.M][.U])$/u);
const gitStatusModeSchema = z.string().regex(/^[0-7]{6}$/u);
const gitObjectIdSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u);
const renameScoreSchema = z.string().regex(/^R(?:100|[1-9]?[0-9])$/u);
const gitStatusBranchValueSchema = z.string().min(1);
const gitStatusRecordsSchema = z.array(z.string().min(1));
const branchAheadSchema = z
  .string()
  .regex(/^\+\d+$/u)
  .refine((value) => Number.isSafeInteger(Number(value.slice(1))))
  .transform((value) => Number.parseInt(value.slice(1), 10));
const branchBehindSchema = z
  .string()
  .regex(/^-\d+$/u)
  .refine((value) => Number.isSafeInteger(Number(value.slice(1))))
  .transform((value) => Number.parseInt(value.slice(1), 10));
const branchAheadBehindSchema = z.tuple([
  branchAheadSchema,
  branchBehindSchema,
]);
const ordinaryStatusFieldsSchema = z.tuple([
  z.literal("1"),
  ordinaryStatusCodeSchema,
  gitStatusSubmoduleSchema,
  gitStatusModeSchema,
  gitStatusModeSchema,
  gitStatusModeSchema,
  gitObjectIdSchema,
  gitObjectIdSchema,
]);
const renamedStatusFieldsSchema = z.tuple([
  z.literal("2"),
  renamedStatusCodeSchema,
  gitStatusSubmoduleSchema,
  gitStatusModeSchema,
  gitStatusModeSchema,
  gitStatusModeSchema,
  gitObjectIdSchema,
  gitObjectIdSchema,
  renameScoreSchema,
]);
const unmergedStatusFieldsSchema = z.tuple([
  z.literal("u"),
  unmergedStatusCodeSchema,
  gitStatusSubmoduleSchema,
  gitStatusModeSchema,
  gitStatusModeSchema,
  gitStatusModeSchema,
  gitStatusModeSchema,
  gitObjectIdSchema,
  gitObjectIdSchema,
  gitObjectIdSchema,
]);

const ordinaryStatusEntrySchema = z
  .object({
    kind: z.literal("ordinary"),
    xy: ordinaryStatusCodeSchema,
    path: gitStatusPathSchema,
  })
  .strict();

const renamedStatusEntrySchema = z
  .object({
    kind: z.literal("renamed"),
    xy: renamedStatusCodeSchema,
    path: gitStatusPathSchema,
    oldPath: gitStatusPathSchema,
  })
  .strict();

const unmergedStatusEntrySchema = z
  .object({
    kind: z.literal("unmerged"),
    xy: unmergedStatusCodeSchema,
    path: gitStatusPathSchema,
  })
  .strict();

const untrackedStatusEntrySchema = z
  .object({
    kind: z.literal("untracked"),
    path: gitStatusPathSchema,
  })
  .strict();

const gitStatusEntrySchema = z.discriminatedUnion("kind", [
  ordinaryStatusEntrySchema,
  renamedStatusEntrySchema,
  unmergedStatusEntrySchema,
  untrackedStatusEntrySchema,
]);

type GitStatusEntry = z.infer<typeof gitStatusEntrySchema>;

interface ParsedRenamedStatusMetadata {
  readonly xy: z.infer<typeof renamedStatusCodeSchema>;
  readonly path: string;
  readonly objectIdLength: GitObjectIdLength;
}

function malformedGitStatusOutput(): never {
  throw new KeelError(
    "tool_unavailable",
    "git_status failed: git status returned malformed output",
    "Retry git_status, or inspect the workspace directly with git status.",
  );
}

function consistentGitObjectIdLength(
  currentLength: GitObjectIdLength | null,
  objectIds: readonly [string, ...string[]],
): GitObjectIdLength {
  const recordLength: GitObjectIdLength = objectIds[0].length === 40 ? 40 : 64;
  if (
    objectIds.some((objectId) => objectId.length !== recordLength) ||
    (currentLength !== null && currentLength !== recordLength)
  ) {
    malformedGitStatusOutput();
  }
  return recordLength;
}

function completedGitStatusRecords(
  output: CapturedByteOutput,
): readonly string[] {
  let recordText: string;
  if (output.truncated) {
    const lastTerminator = output.text.lastIndexOf("\0");
    if (lastTerminator === -1) return [];
    recordText = output.text.slice(0, lastTerminator);
  } else {
    if (!output.text.endsWith("\0")) malformedGitStatusOutput();
    recordText = output.text.slice(0, -1);
  }
  const parsed = gitStatusRecordsSchema.safeParse(recordText.split("\0"));
  if (!parsed.success) malformedGitStatusOutput();
  return parsed.data;
}

function parseOrdinaryStatusEntry(
  record: string,
  objectIdLength: GitObjectIdLength | null,
): ParsedTrackedStatusEntry {
  const fields = record.split(" ");
  const metadata = ordinaryStatusFieldsSchema.safeParse(fields.slice(0, 8));
  if (!metadata.success) malformedGitStatusOutput();
  const parsed = ordinaryStatusEntrySchema.safeParse({
    kind: "ordinary",
    xy: metadata.data[1],
    path: fields.slice(8).join(" "),
  });
  if (!parsed.success) malformedGitStatusOutput();
  return {
    entry: parsed.data,
    objectIdLength: consistentGitObjectIdLength(objectIdLength, [
      metadata.data[6],
      metadata.data[7],
    ]),
  };
}

function parseRenamedStatusMetadata(
  record: string,
  objectIdLength: GitObjectIdLength | null,
): ParsedRenamedStatusMetadata {
  const fields = record.split(" ");
  const metadata = renamedStatusFieldsSchema.safeParse(fields.slice(0, 9));
  if (!metadata.success) malformedGitStatusOutput();
  const path = gitStatusPathSchema.safeParse(fields.slice(9).join(" "));
  if (!path.success) malformedGitStatusOutput();
  return {
    xy: metadata.data[1],
    path: path.data,
    objectIdLength: consistentGitObjectIdLength(objectIdLength, [
      metadata.data[6],
      metadata.data[7],
    ]),
  };
}

function parseRenamedStatusEntry(
  metadata: ParsedRenamedStatusMetadata,
  oldPath: string,
): GitStatusEntry {
  const parsed = renamedStatusEntrySchema.safeParse({
    kind: "renamed",
    xy: metadata.xy,
    path: metadata.path,
    oldPath,
  });
  if (!parsed.success) malformedGitStatusOutput();
  return parsed.data;
}

function parseUnmergedStatusEntry(
  record: string,
  objectIdLength: GitObjectIdLength | null,
): ParsedTrackedStatusEntry {
  const fields = record.split(" ");
  const metadata = unmergedStatusFieldsSchema.safeParse(fields.slice(0, 10));
  if (!metadata.success) malformedGitStatusOutput();
  const parsed = unmergedStatusEntrySchema.safeParse({
    kind: "unmerged",
    xy: metadata.data[1],
    path: fields.slice(10).join(" "),
  });
  if (!parsed.success) malformedGitStatusOutput();
  return {
    entry: parsed.data,
    objectIdLength: consistentGitObjectIdLength(objectIdLength, [
      metadata.data[7],
      metadata.data[8],
      metadata.data[9],
    ]),
  };
}

function parseUntrackedStatusEntry(record: string): GitStatusEntry {
  const parsed = untrackedStatusEntrySchema.safeParse({
    kind: "untracked",
    path: record.slice(2),
  });
  if (!parsed.success) malformedGitStatusOutput();
  return parsed.data;
}

function branchWithHead(
  branch: GitStatusBranchState,
  head: string,
): GitStatusBranchState {
  return { ...branch, head };
}

function branchWithUpstream(
  branch: GitStatusBranchState,
  upstream: string,
): GitStatusBranchState {
  return { ...branch, upstream };
}

function branchWithAheadBehind(
  branch: GitStatusBranchState,
  ahead: number,
  behind: number,
): GitStatusBranchState {
  return { ...branch, aheadBehind: { ahead, behind } };
}

function parseBranchHeader(
  branch: GitStatusBranchState,
  record: string,
): GitStatusBranchState {
  if (record === "# branch.head" || record.startsWith("# branch.head ")) {
    const parsed = gitStatusBranchValueSchema.safeParse(
      record.slice("# branch.head ".length),
    );
    if (!parsed.success) malformedGitStatusOutput();
    return branchWithHead(branch, parsed.data);
  }
  if (
    record === "# branch.upstream" ||
    record.startsWith("# branch.upstream ")
  ) {
    const parsed = gitStatusBranchValueSchema.safeParse(
      record.slice("# branch.upstream ".length),
    );
    if (!parsed.success) malformedGitStatusOutput();
    return branchWithUpstream(branch, parsed.data);
  }
  if (record === "# branch.ab" || record.startsWith("# branch.ab ")) {
    const parsed = branchAheadBehindSchema.safeParse(
      record.slice("# branch.ab ".length).split(" "),
    );
    if (!parsed.success) malformedGitStatusOutput();
    return branchWithAheadBehind(branch, ...parsed.data);
  }
  return branch;
}

function finalizedGitStatusBranch(
  branch: GitStatusBranchState,
  producerTruncated: boolean,
): GitStatusBranch {
  if (branch.head === null) {
    if (!producerTruncated) malformedGitStatusOutput();
    return { ...branch, head: "unknown" };
  }
  return {
    head: branch.head,
    upstream: branch.upstream,
    aheadBehind: branch.aheadBehind,
  };
}

function parseGitStatusOutput(output: CapturedByteOutput): ParsedGitStatus {
  const records = completedGitStatusRecords(output);
  const entries: GitStatusEntry[] = [];
  let branch: GitStatusBranchState = {
    head: null,
    upstream: null,
    aheadBehind: null,
  };
  let objectIdLength: GitObjectIdLength | null = null;

  const iterator = records[Symbol.iterator]();
  for (const record of iterator) {
    if (record.startsWith("# ")) {
      branch = parseBranchHeader(branch, record);
      continue;
    }

    if (record.startsWith("? ")) {
      entries.push(parseUntrackedStatusEntry(record));
      continue;
    }

    if (record.startsWith("1 ")) {
      const parsed = parseOrdinaryStatusEntry(record, objectIdLength);
      entries.push(parsed.entry);
      objectIdLength = parsed.objectIdLength;
      continue;
    }

    if (record.startsWith("2 ")) {
      const metadata = parseRenamedStatusMetadata(record, objectIdLength);
      const oldPath = iterator.next().value;
      if (oldPath === undefined) {
        if (output.truncated) break;
        malformedGitStatusOutput();
      }
      entries.push(parseRenamedStatusEntry(metadata, oldPath));
      objectIdLength = metadata.objectIdLength;
      continue;
    }

    if (record.startsWith("u ")) {
      const parsed = parseUnmergedStatusEntry(record, objectIdLength);
      entries.push(parsed.entry);
      objectIdLength = parsed.objectIdLength;
      continue;
    }

    malformedGitStatusOutput();
  }

  return {
    branch: finalizedGitStatusBranch(branch, output.truncated),
    entries,
  };
}

function entryPaths(entry: GitStatusEntry): readonly string[] {
  if (entry.kind === "renamed") return [entry.oldPath, entry.path];
  return [entry.path];
}

function visibleStatusEntries(
  workspacePath: string,
  gitRootPath: string,
  projectIgnorePolicy: ReturnType<typeof createProjectIgnorePolicy>,
  parsed: ParsedGitStatus,
): readonly GitStatusEntry[] {
  return parsed.entries.filter((entry) =>
    entryPaths(entry).every((path) =>
      gitPathVisibleToProvider(
        workspacePath,
        gitRootPath,
        projectIgnorePolicy,
        path,
      ),
    ),
  );
}

function changedPathLabel(entry: GitStatusEntry): string {
  if (entry.kind === "renamed") return `${entry.oldPath} -> ${entry.path}`;
  return entry.path;
}

function appendChangedLine(
  lines: string[],
  code: string,
  entry: GitStatusEntry,
): void {
  lines.push(`- ${code} ${changedPathLabel(entry)}`);
}

function statusBuckets(entries: readonly GitStatusEntry[]): {
  readonly staged: readonly string[];
  readonly unstaged: readonly string[];
  readonly untracked: readonly string[];
  readonly unmerged: readonly string[];
} {
  const staged: string[] = [];
  const unstaged: string[] = [];
  const untracked: string[] = [];
  const unmerged: string[] = [];

  for (const entry of entries) {
    if (entry.kind === "untracked") {
      untracked.push(`- ${entry.path}`);
      continue;
    }

    if (entry.kind === "unmerged") {
      unmerged.push(`- ${entry.xy} ${changedPathLabel(entry)}`);
      continue;
    }

    const stagedCode = entry.xy.charAt(0);
    const unstagedCode = entry.xy.charAt(1);
    if (stagedCode !== ".") {
      appendChangedLine(staged, stagedCode, entry);
    }
    if (unstagedCode !== ".") {
      appendChangedLine(unstaged, unstagedCode, entry);
    }
  }

  return { staged, unstaged, untracked, unmerged };
}

function formatBranch(branch: GitStatusBranch): string {
  const details: string[] = [];
  if (branch.upstream !== null) details.push(`upstream: ${branch.upstream}`);
  if (branch.aheadBehind !== null) {
    details.push(
      `ahead ${branch.aheadBehind.ahead}, behind ${branch.aheadBehind.behind}`,
    );
  }
  if (details.length === 0) return `Branch: ${branch.head}`;
  return `Branch: ${branch.head} (${details.join("; ")})`;
}

function appendSection(
  sections: string[],
  title: string,
  lines: readonly string[],
): void {
  if (lines.length === 0) return;
  sections.push(`${title}:\n${lines.join("\n")}`);
}

function formatGitStatus(
  branch: GitStatusBranch,
  entries: readonly GitStatusEntry[],
  entryListTruncated: boolean,
  producerTruncated: boolean,
): string {
  const sections = [formatBranch(branch)];
  if (entries.length === 0 && !producerTruncated) {
    sections.push("No git changes found.");
  } else if (entries.length > 0) {
    const buckets = statusBuckets(entries);
    appendSection(sections, "Staged changes", buckets.staged);
    appendSection(sections, "Unstaged changes", buckets.unstaged);
    appendSection(sections, "Unmerged paths", buckets.unmerged);
    appendSection(sections, "Untracked files", buckets.untracked);
  }
  if (entryListTruncated) {
    sections.push(
      `[git_status output truncated: showing first ${STATUS_ENTRY_LIMIT} entries. Use paths to narrow output.]`,
    );
  }
  if (producerTruncated) {
    sections.push(
      `[git_status output truncated: git status exceeded ${GIT_ARTIFACT_OUTPUT_MAX_BYTES} bytes before parsing completed. Use paths to narrow output.]`,
    );
  }
  return sections.join("\n\n");
}

export async function executeGitStatus(
  workspace: string,
  options: GitStatusOptions = {},
): Promise<GitStatusResult> {
  const workspacePath = realpathSync(workspace);
  const paths = normalizeGitPathFilters(
    "git_status",
    workspacePath,
    options.paths,
  );
  const scope = await resolveGitWorkTreeScope(
    "git_status",
    workspacePath,
    paths,
    options.signal,
  );
  if (scope === null) {
    return {
      inGitWorkTree: false,
      content:
        "Not in a git work tree. git_status can only inspect changes inside a Git repository.",
    };
  }
  const projectIgnorePolicy = createProjectIgnorePolicy(
    scope.rootPath,
    options.hiddenPaths,
  );
  assertGitPathFiltersAllowed(
    "git_status",
    workspacePath,
    paths,
    projectIgnorePolicy,
  );

  const result = await runGitProcess(
    "git_status",
    scope.rootPath,
    [
      "status",
      "--porcelain=v2",
      "--branch",
      "--untracked-files=all",
      "--renames",
      "-z",
      ...gitPathspecArgs(scope.pathspecs),
    ],
    gitRunOptions(undefined, options.signal, "metadata"),
  );
  const output = expectGitExitCode(
    "git_status",
    "status",
    result,
    new Set([0]),
  ).artifactStdout;
  const parsed = parseGitStatusOutput(output);
  const limited = limitCountedOutput(
    visibleStatusEntries(
      workspacePath,
      scope.rootPath,
      projectIgnorePolicy,
      parsed,
    ),
    STATUS_ENTRY_LIMIT,
  );
  const content = formatGitStatus(
    parsed.branch,
    limited.items,
    limited.truncated,
    output.truncated,
  );
  if (limited.truncated) {
    return { content, inGitWorkTree: true, sourceTruncated: true };
  }
  if (output.truncated) {
    return { content, inGitWorkTree: true, sourceTruncated: true };
  }
  return {
    content,
    inGitWorkTree: true,
  };
}
