import { spawnSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { z } from "zod";
import type {
  SubagentWriteWorkspaceLease,
  SubagentWriteWorkspaceRuntime,
  SubagentWriteWorkspaceSettlement,
} from "../agent/subagent-workspace.ts";
import { errorMessage } from "../core/error.ts";

const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_OUTPUT_BYTES = 10_000_000;
const MAX_SUMMARY_CHARS = 4_000;
const commitSchema = z
  .string()
  .trim()
  .regex(/^[a-f0-9]{40,64}$/u);
const childRunIdSchema = z.string().regex(/^subagent-[a-f0-9-]+$/u);
const unsafeGitEnvironmentKeys = new Set([
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CEILING_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_DIR",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
  "GIT_GRAFT_FILE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_NAMESPACE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_OBJECT_DIRECTORY",
  "GIT_PREFIX",
  "GIT_QUARANTINE_PATH",
  "GIT_REPLACE_REF_BASE",
  "GIT_SHALLOW_FILE",
  "GIT_WORK_TREE",
]);

interface GitCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly status: number | null;
}

function nullDevice(platform: NodeJS.Platform): string {
  /* v8 ignore next -- the release coverage host is POSIX; Windows uses Git's documented NUL device path. */
  return platform === "win32" ? "NUL" : "/dev/null";
}

function gitEnvironment(platform: NodeJS.Platform): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (
      key !== "GIT_EXTERNAL_DIFF" &&
      key !== "GIT_DIFF_OPTS" &&
      key !== "GIT_CONFIG_COUNT" &&
      key !== "GIT_CONFIG_PARAMETERS" &&
      key !== "GIT_CONFIG_GLOBAL" &&
      key !== "GIT_CONFIG_SYSTEM" &&
      !unsafeGitEnvironmentKeys.has(key) &&
      !/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/u.test(key)
    ) {
      env[key] = value;
    }
  }
  return {
    ...env,
    GIT_CONFIG_GLOBAL: nullDevice(platform),
    GIT_CONFIG_SYSTEM: nullDevice(platform),
    GIT_ATTR_NOSYSTEM: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "cat",
  };
}

function runGit(
  platform: NodeJS.Platform,
  cwd: string,
  args: readonly string[],
): GitCommandResult {
  const result = spawnSync(
    "git",
    [
      "--no-pager",
      "--no-optional-locks",
      "-c",
      "core.fsmonitor=false",
      "-c",
      `core.hooksPath=${nullDevice(platform)}`,
      "-c",
      "diff.external=",
      ...args,
    ],
    {
      cwd,
      encoding: "utf8",
      env: gitEnvironment(platform),
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_OUTPUT_BYTES,
      windowsHide: true,
    },
  );
  /* v8 ignore next -- requires replacing/exhausting the host Git process adapter before it can return a status. */
  if (result.error !== undefined) throw result.error;
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    status: result.status,
  };
}

function expectGitResult(
  platform: NodeJS.Platform,
  cwd: string,
  args: readonly string[],
  acceptedStatuses: readonly (number | null)[],
): GitCommandResult {
  const result = runGit(platform, cwd, args);
  if (!acceptedStatuses.includes(result.status)) {
    const detail = `${result.stderr.trim()}\n${result.stdout.trim()}`.trim();
    throw new Error(`git ${args.join(" ")} failed: ${detail}`);
  }
  return result;
}

function expectGit(
  platform: NodeJS.Platform,
  cwd: string,
  args: readonly string[],
): string {
  return expectGitResult(platform, cwd, args, [0]).stdout;
}

function pathIsWithin(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return (
    fromRoot === "" ||
    (!fromRoot.startsWith(`..${sep}`) &&
      fromRoot !== ".." &&
      !isAbsolute(fromRoot))
  );
}

function canonicalProspectivePath(path: string): string {
  let existingAncestor = resolve(path);
  const missingSegments: string[] = [];
  while (lstatSync(existingAncestor, { throwIfNoEntry: false }) === undefined) {
    const parent = dirname(existingAncestor);
    missingSegments.unshift(basename(existingAncestor));
    existingAncestor = parent;
  }
  return resolve(realpathSync(existingAncestor), ...missingSegments);
}

function boundedSummary(status: string): string {
  const summary = status.trim();
  return summary.length <= MAX_SUMMARY_CHARS
    ? summary
    : `${summary.slice(0, MAX_SUMMARY_CHARS - 3)}...`;
}

function effectiveFilterOverrides(
  platform: NodeJS.Platform,
  workspace: string,
): readonly string[] {
  const result = expectGitResult(
    platform,
    workspace,
    [
      "config",
      "--get-regexp",
      "^filter\\..*\\.(clean|smudge|process|required)$",
    ],
    [0, 1],
  );
  if (result.status === 1) return [];
  const names = new Set<string>();
  for (const line of result.stdout.split("\n")) {
    const match =
      /^filter\.(.+)\.(?:clean|smudge|process|required)(?:\s|$)/u.exec(line);
    if (match?.[1] !== undefined) {
      names.add(match[1]);
    }
  }
  return [...names].flatMap((name) => [
    "-c",
    `filter.${name}.clean=`,
    "-c",
    `filter.${name}.smudge=`,
    "-c",
    `filter.${name}.process=`,
    "-c",
    `filter.${name}.required=false`,
  ]);
}

function worktreeGitDir(worktreePath: string): string {
  const gitFile = join(worktreePath, ".git");
  const stat = lstatSync(gitFile);
  if (!stat.isFile() || stat.size > 4_096) {
    throw new Error(
      "child worktree .git identity is not a bounded regular file",
    );
  }
  const match = /^gitdir: (.+)\n?$/u.exec(readFileSync(gitFile, "utf8"));
  if (match?.[1] === undefined) {
    throw new Error("child worktree .git identity is malformed");
  }
  const requested = isAbsolute(match[1])
    ? resolve(match[1])
    : resolve(worktreePath, match[1]);
  return realpathSync(requested);
}

function verifyWorktreeRevision(input: {
  readonly platform: NodeJS.Platform;
  readonly worktreePath: string;
  readonly baseCommit: string;
  readonly branch: string;
}): void {
  const head = commitSchema.parse(
    expectGit(input.platform, input.worktreePath, [
      "rev-parse",
      "--verify",
      "HEAD^{commit}",
    ]),
  );
  if (head !== input.baseCommit) {
    throw new Error("leased HEAD changed");
  }
  const symbolicHead = expectGitResult(
    input.platform,
    input.worktreePath,
    ["symbolic-ref", "--quiet", "HEAD"],
    [0, 1],
  );
  if (
    symbolicHead.status !== 0 ||
    symbolicHead.stdout.trim() !== `refs/heads/${input.branch}`
  ) {
    throw new Error("leased branch changed");
  }
}

function capturePatch(
  platform: NodeJS.Platform,
  worktreePath: string,
  baseCommit: string,
  filterOverrides: readonly string[],
): { readonly content: string; readonly sourceTruncated: boolean } {
  const tracked = expectGitResult(
    platform,
    worktreePath,
    [
      ...filterOverrides,
      "diff",
      "--binary",
      "--no-ext-diff",
      "--no-textconv",
      baseCommit,
      "--",
    ],
    [0],
  );
  const untrackedOutput = expectGit(platform, worktreePath, [
    ...filterOverrides,
    "ls-files",
    "--others",
    "-z",
  ]);
  let content = tracked.stdout;
  let sourceTruncated = false;
  for (const path of untrackedOutput
    .split("\0")
    .filter((value) => value !== "")) {
    const untracked = expectGitResult(
      platform,
      worktreePath,
      [
        ...filterOverrides,
        "diff",
        "--no-index",
        "--binary",
        "--no-ext-diff",
        "--no-textconv",
        "--",
        nullDevice(platform),
        path,
      ],
      [0, 1],
    );
    if (content.length + untracked.stdout.length > GIT_MAX_OUTPUT_BYTES) {
      const remaining = Math.max(0, GIT_MAX_OUTPUT_BYTES - content.length);
      content += untracked.stdout.slice(0, remaining);
      sourceTruncated = true;
      break;
    }
    content += untracked.stdout;
  }
  return { content, sourceTruncated };
}

function createLease(input: {
  readonly platform: NodeJS.Platform;
  readonly leaseId: string;
  readonly parentWorkspace: string;
  readonly parentRepoRoot: string;
  readonly baseCommit: string;
  readonly branch: string;
  readonly worktreePath: string;
}): SubagentWriteWorkspaceLease {
  const canonicalWorktreePath = realpathSync(input.worktreePath);
  const workspaceRelativePath = relative(
    input.parentRepoRoot,
    input.parentWorkspace,
  );
  const workspaceRoot = realpathSync(
    resolve(canonicalWorktreePath, workspaceRelativePath),
  );
  const rootStat = statSync(canonicalWorktreePath);
  const expectedGitDir = worktreeGitDir(canonicalWorktreePath);
  let settled: SubagentWriteWorkspaceSettlement | undefined;
  const verify = (requestedWorkspaceRoot: string): void => {
    try {
      if (requestedWorkspaceRoot !== workspaceRoot) {
        throw new Error("dispatcher workspace root does not match the lease");
      }
      const currentPath = realpathSync(input.worktreePath);
      const currentStat = statSync(currentPath);
      if (
        currentPath !== canonicalWorktreePath ||
        currentStat.dev !== rootStat.dev ||
        currentStat.ino !== rootStat.ino ||
        worktreeGitDir(currentPath) !== expectedGitDir
      ) {
        throw new Error("identity changed");
      }
      const currentWorkspaceRoot = realpathSync(
        resolve(currentPath, workspaceRelativePath),
      );
      if (currentWorkspaceRoot !== workspaceRoot) {
        throw new Error("canonical workspace root changed");
      }
      verifyWorktreeRevision({
        platform: input.platform,
        worktreePath: currentPath,
        baseCommit: input.baseCommit,
        branch: input.branch,
      });
    } catch (caught) {
      throw new Error(
        `child workspace lease validation failed: ${errorMessage(caught)}`,
      );
    }
  };
  const settle = (): SubagentWriteWorkspaceSettlement => {
    if (settled !== undefined) return settled;
    try {
      verify(workspaceRoot);
      const head = commitSchema.parse(
        expectGit(input.platform, canonicalWorktreePath, [
          "rev-parse",
          "--verify",
          "HEAD^{commit}",
        ]),
      );
      const branch = expectGit(input.platform, canonicalWorktreePath, [
        "branch",
        "--show-current",
      ]).trim();
      const filterOverrides = effectiveFilterOverrides(
        input.platform,
        canonicalWorktreePath,
      );
      const status = expectGit(input.platform, canonicalWorktreePath, [
        ...filterOverrides,
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
        "--ignored=matching",
      ]);
      const patch = capturePatch(
        input.platform,
        canonicalWorktreePath,
        input.baseCommit,
        filterOverrides,
      );
      settled = {
        disposition: "preserved",
        worktreePath: canonicalWorktreePath,
        patch: {
          ...patch,
          summary:
            head === input.baseCommit &&
            branch === input.branch &&
            status === ""
              ? "clean at base commit"
              : boundedSummary(
                  [`HEAD ${head}`, `branch ${branch}`, status.trim()]
                    .filter((line) => line !== "")
                    .join("\n"),
                ),
        },
      };
      return settled;
    } catch (caught) {
      settled = {
        disposition: "cleanup_failed",
        worktreePath: lstatSync(input.worktreePath, { throwIfNoEntry: false })
          ? input.worktreePath
          : null,
        patch: null,
        error: errorMessage(caught),
      };
      return settled;
    }
  };
  return {
    reference: {
      kind: "isolated_write",
      leaseId: input.leaseId,
      baseCommit: input.baseCommit,
      branch: input.branch,
      worktreePath: canonicalWorktreePath,
      workspaceRoot,
    },
    verify,
    settle,
  };
}

export function createCliSubagentWriteWorkspaceRuntime(options: {
  readonly workspace: string;
  readonly leasesRoot: string;
  readonly platform: NodeJS.Platform;
}): SubagentWriteWorkspaceRuntime {
  return {
    prepare: ({ childRunId, signal }) => {
      if (signal.aborted) {
        return {
          kind: "rejected",
          reason:
            "Writer delegation rejected because the parent is already cancelled.",
          recovery:
            "Start a new foreground delegation after cancellation settles.",
        };
      }
      try {
        const parsedChildRunId = childRunIdSchema.parse(childRunId);
        const parentWorkspace = realpathSync(options.workspace);
        const parentRepoRoot = realpathSync(
          expectGit(options.platform, parentWorkspace, [
            "rev-parse",
            "--show-toplevel",
          ]).trim(),
        );
        const parentFilterOverrides = effectiveFilterOverrides(
          options.platform,
          parentRepoRoot,
        );
        const status = expectGit(options.platform, parentRepoRoot, [
          ...parentFilterOverrides,
          "status",
          "--porcelain=v1",
          "--untracked-files=all",
        ]);
        if (status !== "") {
          return {
            kind: "rejected",
            reason:
              "Writer delegation rejected because the parent checkout has staged, unstaged, untracked, or unmerged changes.",
            recovery:
              "Commit, stash, or remove those changes, then request the writer again. Keel will not silently exclude them from the child base.",
          };
        }
        const baseCommit = commitSchema.parse(
          expectGit(options.platform, parentRepoRoot, [
            "rev-parse",
            "--verify",
            "HEAD^{commit}",
          ]),
        );
        const workspaceRelativePath = relative(parentRepoRoot, parentWorkspace);
        if (workspaceRelativePath !== "") {
          const gitWorkspacePath = workspaceRelativePath.split(sep).join("/");
          const workspaceTree = runGit(options.platform, parentRepoRoot, [
            "cat-file",
            "-e",
            `${baseCommit}:${gitWorkspacePath}`,
          ]);
          if (workspaceTree.status !== 0) {
            return {
              kind: "rejected",
              reason:
                "Writer delegation rejected because the current workspace directory does not exist in the frozen Git base.",
              recovery:
                "Run Keel from the repository root, or commit at least one file in this workspace directory before requesting a writer.",
            };
          }
        }
        const prospectiveWorktreePath = canonicalProspectivePath(
          join(options.leasesRoot, parsedChildRunId),
        );
        if (pathIsWithin(parentRepoRoot, prospectiveWorktreePath)) {
          throw new Error(
            "child worktree location must be outside the parent repository checkout",
          );
        }
        const branch = `keel/subagent/${parsedChildRunId.slice("subagent-".length)}`;
        const worktreePath = prospectiveWorktreePath;
        if (lstatSync(worktreePath, { throwIfNoEntry: false }) !== undefined) {
          throw new Error("child worktree path already exists");
        }
        const existingBranch = runGit(options.platform, parentRepoRoot, [
          "show-ref",
          "--verify",
          "--quiet",
          `refs/heads/${branch}`,
        ]);
        if (existingBranch.status !== 1) {
          throw new Error(
            "child branch already exists or could not be checked",
          );
        }
        const reference = {
          kind: "isolated_write" as const,
          leaseId: parsedChildRunId,
          baseCommit,
          branch,
          worktreePath,
          workspaceRoot: resolve(worktreePath, workspaceRelativePath),
        };
        let activated = false;
        return {
          kind: "prepared",
          workspace: {
            reference,
            activate: () => {
              if (activated) {
                return {
                  kind: "failed",
                  worktreePath:
                    lstatSync(worktreePath, { throwIfNoEntry: false }) ===
                    undefined
                      ? null
                      : worktreePath,
                  error: "writer workspace activation was attempted twice",
                  recovery: `Inspect ${worktreePath} and refs/heads/${branch} before retrying.`,
                };
              }
              activated = true;
              try {
                if (signal.aborted) {
                  throw new Error(
                    "parent cancellation arrived before workspace activation",
                  );
                }
                const currentStatus = expectGit(
                  options.platform,
                  parentRepoRoot,
                  [
                    ...parentFilterOverrides,
                    "status",
                    "--porcelain=v1",
                    "--untracked-files=all",
                  ],
                );
                const currentHead = commitSchema.parse(
                  expectGit(options.platform, parentRepoRoot, [
                    "rev-parse",
                    "--verify",
                    "HEAD^{commit}",
                  ]),
                );
                if (currentStatus !== "" || currentHead !== baseCommit) {
                  throw new Error(
                    "parent checkout changed after writer preparation",
                  );
                }
                if (
                  lstatSync(worktreePath, { throwIfNoEntry: false }) !==
                  undefined
                ) {
                  throw new Error("child worktree path already exists");
                }
                mkdirSync(options.leasesRoot, {
                  recursive: true,
                  mode: 0o700,
                });
                if (
                  realpathSync(options.leasesRoot) !== dirname(worktreePath)
                ) {
                  throw new Error(
                    "canonical lease root changed after writer preparation",
                  );
                }
                expectGit(options.platform, parentRepoRoot, [
                  ...parentFilterOverrides,
                  "worktree",
                  "add",
                  "--no-checkout",
                  "-b",
                  branch,
                  worktreePath,
                  baseCommit,
                ]);
                const childFilterOverrides = effectiveFilterOverrides(
                  options.platform,
                  worktreePath,
                );
                expectGit(options.platform, worktreePath, [
                  ...childFilterOverrides,
                  "reset",
                  "--hard",
                  "--no-recurse-submodules",
                  baseCommit,
                ]);
                const lease = createLease({
                  platform: options.platform,
                  leaseId: parsedChildRunId,
                  parentWorkspace,
                  parentRepoRoot,
                  baseCommit,
                  branch,
                  worktreePath,
                });
                /* v8 ignore next 5 -- preparation and activation derive these paths from one frozen canonical reservation; retain a fail-fast invariant for future adapters. */
                if (
                  lease.reference.worktreePath !== reference.worktreePath ||
                  lease.reference.workspaceRoot !== reference.workspaceRoot
                ) {
                  throw new Error(
                    "materialized writer workspace identity differs from its persisted preparation",
                  );
                }
                lease.verify(lease.reference.workspaceRoot);
                return { kind: "acquired", lease };
              } catch (caught) {
                const materializedPath =
                  lstatSync(worktreePath, { throwIfNoEntry: false }) ===
                  undefined
                    ? null
                    : worktreePath;
                return {
                  kind: "failed",
                  worktreePath: materializedPath,
                  error: errorMessage(caught),
                  recovery: `Inspect ${worktreePath} and refs/heads/${branch}; remove only that exact Keel worktree/branch after confirming it is safe, then retry from a clean checkout.`,
                };
              }
            },
          },
        };
      } catch (caught) {
        return {
          kind: "rejected",
          reason: `Writer delegation rejected before child file access: ${errorMessage(caught)}`,
          recovery:
            "Resolve the reported repository or Git configuration problem, then retry from a clean checkout.",
        };
      }
    },
  };
}
