import { realpathSync } from "node:fs";
import { z } from "zod";
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
import { limitCountedOutput } from "./output-limit.ts";
import { createProjectIgnorePolicy } from "./project-ignore.ts";
import type { ToolResult } from "./types.ts";

const STATUS_ENTRY_LIMIT = 200;
const STATUS_CODE_PATTERN = /^[.MADRCUTU?!]{2}$/u;

export interface GitStatusOptions {
  readonly paths?: readonly string[];
  readonly signal?: AbortSignal;
  readonly hiddenPaths?: readonly string[];
}

export interface GitStatusResult extends ToolResult {
  readonly inGitWorkTree: boolean;
}

interface GitStatusBranch {
  readonly head?: string;
  readonly upstream?: string;
  readonly ahead?: number;
  readonly behind?: number;
}

interface ParsedGitStatus {
  readonly branch: GitStatusBranch;
  readonly entries: readonly GitStatusEntry[];
}

const gitStatusPathSchema = z
  .string()
  .min(1)
  .refine((value) => !value.includes("\0"));
const gitStatusCodeSchema = z.string().regex(STATUS_CODE_PATTERN);

const ordinaryStatusEntrySchema = z
  .object({
    kind: z.literal("ordinary"),
    xy: gitStatusCodeSchema,
    path: gitStatusPathSchema,
  })
  .strict();

const renamedStatusEntrySchema = z
  .object({
    kind: z.literal("renamed"),
    xy: gitStatusCodeSchema,
    path: gitStatusPathSchema,
    oldPath: gitStatusPathSchema,
  })
  .strict();

const unmergedStatusEntrySchema = z
  .object({
    kind: z.literal("unmerged"),
    xy: gitStatusCodeSchema,
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

function parsePathRecord(
  record: string,
  pathFieldIndex: number,
): readonly string[] | null {
  const fields = record.split(" ");
  // malformed porcelain records are ignored defensively; Git owns this record shape.
  if (fields.length <= pathFieldIndex) return null;
  const path = fields.slice(pathFieldIndex).join(" ");
  return [...fields.slice(0, pathFieldIndex), path];
}

function parseOrdinaryStatusEntry(record: string): GitStatusEntry | null {
  const fields = parsePathRecord(record, 8);
  // malformed porcelain records are ignored defensively; Git owns this record shape.
  if (fields === null) return null;
  const parsed = ordinaryStatusEntrySchema.safeParse({
    kind: "ordinary",
    xy: fields[1],
    path: fields[8],
  });
  // schema rejection is a defensive guard for malformed Git output.
  return parsed.success ? parsed.data : null;
}

function parseRenamedStatusEntry(
  record: string,
  oldPath: string | undefined,
): GitStatusEntry | null {
  // malformed porcelain rename records are ignored defensively; Git owns the paired old path.
  if (oldPath === undefined) return null;
  const fields = parsePathRecord(record, 9);
  // malformed porcelain records are ignored defensively; Git owns this record shape.
  if (fields === null) return null;
  const parsed = renamedStatusEntrySchema.safeParse({
    kind: "renamed",
    xy: fields[1],
    path: fields[9],
    oldPath,
  });
  // schema rejection is a defensive guard for malformed Git output.
  return parsed.success ? parsed.data : null;
}

function parseUnmergedStatusEntry(record: string): GitStatusEntry | null {
  const fields = parsePathRecord(record, 10);
  // malformed porcelain records are ignored defensively; Git owns this record shape.
  if (fields === null) return null;
  const parsed = unmergedStatusEntrySchema.safeParse({
    kind: "unmerged",
    xy: fields[1],
    path: fields[10],
  });
  // schema rejection is a defensive guard for malformed Git output.
  return parsed.success ? parsed.data : null;
}

function parseUntrackedStatusEntry(record: string): GitStatusEntry | null {
  const parsed = untrackedStatusEntrySchema.safeParse({
    kind: "untracked",
    path: record.slice(2),
  });
  // schema rejection is a defensive guard for malformed Git output.
  return parsed.success ? parsed.data : null;
}

function branchWithHead(
  branch: GitStatusBranch,
  head: string,
): GitStatusBranch {
  return { ...branch, head };
}

function branchWithUpstream(
  branch: GitStatusBranch,
  upstream: string,
): GitStatusBranch {
  return { ...branch, upstream };
}

function branchWithAheadBehind(
  branch: GitStatusBranch,
  ahead: number,
  behind: number,
): GitStatusBranch {
  return { ...branch, ahead, behind };
}

function parseBranchHeader(
  branch: GitStatusBranch,
  record: string,
): GitStatusBranch {
  if (record.startsWith("# branch.head ")) {
    return branchWithHead(branch, record.slice("# branch.head ".length));
  }
  if (record.startsWith("# branch.upstream ")) {
    return branchWithUpstream(
      branch,
      record.slice("# branch.upstream ".length),
    );
  }
  if (record.startsWith("# branch.ab ")) {
    const match = /^# branch\.ab \+(\d+) -(\d+)$/u.exec(record);
    // malformed branch.ab headers are ignored defensively; Git owns this record shape.
    if (match === null) return branch;
    const ahead = match[1];
    const behind = match[2];
    // successful branch.ab regex matches always include both captures.
    if (ahead === undefined || behind === undefined) return branch;
    return branchWithAheadBehind(
      branch,
      Number.parseInt(ahead, 10),
      Number.parseInt(behind, 10),
    );
  }
  return branch;
}

function parseGitStatusOutput(output: string): ParsedGitStatus {
  const records = output.split("\0");
  const entries: GitStatusEntry[] = [];
  let branch: GitStatusBranch = {};
  let index = 0;

  while (index < records.length) {
    const record = records[index];
    index += 1;
    // index is bounded by the loop condition.
    if (record === undefined) break;
    if (record === "") break;

    if (record.startsWith("# ")) {
      branch = parseBranchHeader(branch, record);
      continue;
    }

    if (record.startsWith("? ")) {
      const entry = parseUntrackedStatusEntry(record);
      // null means malformed Git output; valid untracked records are covered.
      if (entry !== null) entries.push(entry);
      continue;
    }

    if (record.startsWith("1 ")) {
      const entry = parseOrdinaryStatusEntry(record);
      // null means malformed Git output; valid ordinary records are covered.
      if (entry !== null) entries.push(entry);
      continue;
    }

    if (record.startsWith("2 ")) {
      const entry = parseRenamedStatusEntry(record, records[index]);
      index += 1;
      // null means malformed Git output; valid rename records are covered.
      if (entry !== null) entries.push(entry);
      continue;
    }

    if (record.startsWith("u ")) {
      const entry = parseUnmergedStatusEntry(record);
      // null means malformed Git output; valid unmerged records are covered.
      if (entry !== null) entries.push(entry);
    }
  }

  return { branch, entries };
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
  // git status --branch normally emits branch.head; this fallback is for malformed output.
  const head = branch.head ?? "unknown";
  const details: string[] = [];
  if (branch.upstream !== undefined)
    details.push(`upstream: ${branch.upstream}`);
  if (branch.ahead !== undefined && branch.behind !== undefined) {
    details.push(`ahead ${branch.ahead}, behind ${branch.behind}`);
  }
  if (details.length === 0) return `Branch: ${head}`;
  return `Branch: ${head} (${details.join("; ")})`;
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
  const parsed = parseGitStatusOutput(output.text);
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
