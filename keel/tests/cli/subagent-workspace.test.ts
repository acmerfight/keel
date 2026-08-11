import { execFileSync } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, test } from "vitest";
import { resolveBuiltinSubagentProfile } from "../../src/agent/subagent-profile.ts";
import { createCliSubagentWriteWorkspaceRuntime } from "../../src/cli/subagent-workspace.ts";
import { executeToolCall } from "../../src/tools/execution.ts";

function initializeRepository(workspace: string): void {
  execFileSync("git", ["init", "--quiet", "--initial-branch=main"], {
    cwd: workspace,
  });
  execFileSync("git", ["config", "user.name", "Keel Test"], {
    cwd: workspace,
  });
  execFileSync("git", ["config", "user.email", "keel@example.test"], {
    cwd: workspace,
  });
  execFileSync("git", ["add", "--all"], { cwd: workspace });
  execFileSync("git", ["commit", "--quiet", "-m", "initial"], {
    cwd: workspace,
  });
}

describe("CLI subagent workspace lease", () => {
  test(`Given writer preparation runs outside a Git checkout,
    When Keel resolves the parent repository,
    Then it returns the Git diagnostic without creating a lease`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-writer-not-repo-"));
    const leasesRoot = await mkdtemp(
      join(tmpdir(), "keel-writer-not-repo-home-"),
    );

    try {
      expect(
        createCliSubagentWriteWorkspaceRuntime({
          workspace,
          leasesRoot,
          platform: process.platform,
        }).prepare({
          childRunId: "subagent-01010101-0101-4010-8010-010101010101",
          signal: new AbortController().signal,
        }),
      ).toMatchObject({
        kind: "rejected",
        reason: expect.stringContaining("git rev-parse --show-toplevel failed"),
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(leasesRoot, { recursive: true, force: true });
    }
  });

  test(`Given Keel runs from a clean repository directory absent from the frozen tree,
    When writer preparation maps that workspace into a child worktree,
    Then it rejects before creating the child branch or path`, async () => {
    const repository = await mkdtemp(
      join(tmpdir(), "keel-writer-uncommitted-subdir-"),
    );
    const leasesRoot = await mkdtemp(
      join(tmpdir(), "keel-writer-uncommitted-subdir-home-"),
    );
    await writeFile(join(repository, "tracked.txt"), "tracked\n");
    initializeRepository(repository);
    const workspace = join(repository, "empty-workspace");
    await mkdir(workspace);
    const childRunId = "subagent-02020202-0202-4020-8020-020202020202";

    try {
      expect(
        createCliSubagentWriteWorkspaceRuntime({
          workspace,
          leasesRoot,
          platform: process.platform,
        }).prepare({
          childRunId,
          signal: new AbortController().signal,
        }),
      ).toMatchObject({
        kind: "rejected",
        reason: expect.stringContaining(
          "does not exist in the frozen Git base",
        ),
        recovery: expect.stringContaining("repository root"),
      });
      await expect(lstat(join(leasesRoot, childRunId))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(
        execFileSync("git", ["branch", "--list", "keel/subagent/*"], {
          cwd: repository,
          encoding: "utf8",
        }),
      ).toBe("");
    } finally {
      await rm(repository, { recursive: true, force: true });
      await rm(leasesRoot, { recursive: true, force: true });
    }
  });

  test(`Given parent cancellation arrives before writer preparation or activation,
    When the workspace runtime checks each boundary,
    Then it rejects without materializing a child worktree`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-writer-cancelled-"));
    const leasesRoot = await mkdtemp(
      join(tmpdir(), "keel-writer-cancelled-home-"),
    );
    await writeFile(join(workspace, "message.txt"), "before\n");
    initializeRepository(workspace);
    const runtime = createCliSubagentWriteWorkspaceRuntime({
      workspace,
      leasesRoot,
      platform: process.platform,
    });
    const alreadyCancelled = new AbortController();
    alreadyCancelled.abort();

    try {
      expect(
        runtime.prepare({
          childRunId: "subagent-11111111-1111-4111-8111-111111111111",
          signal: alreadyCancelled.signal,
        }),
      ).toMatchObject({
        kind: "rejected",
        reason: expect.stringContaining("already cancelled"),
      });

      const cancellationBetweenPhases = new AbortController();
      const preparation = runtime.prepare({
        childRunId: "subagent-22222222-2222-4222-8222-222222222222",
        signal: cancellationBetweenPhases.signal,
      });
      expect(preparation.kind).toBe("prepared");
      if (preparation.kind !== "prepared") return;
      cancellationBetweenPhases.abort();

      expect(preparation.workspace.activate()).toMatchObject({
        kind: "failed",
        worktreePath: null,
        error: expect.stringContaining("cancellation arrived"),
      });
      expect(preparation.workspace.activate()).toMatchObject({
        kind: "failed",
        worktreePath: null,
        error: expect.stringContaining("attempted twice"),
      });
      await expect(
        lstat(preparation.workspace.reference.worktreePath),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(leasesRoot, { recursive: true, force: true });
    }
  });

  test(`Given the parent checkout changes after writer preparation,
    When activation revalidates the frozen base,
    Then it fails before creating the child branch or worktree`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-writer-parent-race-"));
    const leasesRoot = await mkdtemp(
      join(tmpdir(), "keel-writer-parent-race-home-"),
    );
    await writeFile(join(workspace, "message.txt"), "before\n");
    initializeRepository(workspace);
    const runtime = createCliSubagentWriteWorkspaceRuntime({
      workspace,
      leasesRoot,
      platform: process.platform,
    });
    const preparation = runtime.prepare({
      childRunId: "subagent-33333333-3333-4333-8333-333333333333",
      signal: new AbortController().signal,
    });
    expect(preparation.kind).toBe("prepared");
    if (preparation.kind !== "prepared") return;
    await writeFile(join(workspace, "message.txt"), "changed after prepare\n");

    try {
      expect(preparation.workspace.activate()).toMatchObject({
        kind: "failed",
        worktreePath: null,
        error: expect.stringContaining("changed after writer preparation"),
      });
      await expect(
        lstat(preparation.workspace.reference.worktreePath),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(
        execFileSync(
          "git",
          ["branch", "--list", preparation.workspace.reference.branch],
          { cwd: workspace, encoding: "utf8" },
        ),
      ).toBe("");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(leasesRoot, { recursive: true, force: true });
    }
  });

  test(`Given a child path or branch becomes occupied before writer admission,
    When Keel reserves that exact identity,
    Then it rejects without reusing either existing resource`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-writer-collision-"));
    const leasesRoot = await mkdtemp(
      join(tmpdir(), "keel-writer-collision-home-"),
    );
    await writeFile(join(workspace, "message.txt"), "before\n");
    initializeRepository(workspace);
    const runtime = createCliSubagentWriteWorkspaceRuntime({
      workspace,
      leasesRoot,
      platform: process.platform,
    });
    const pathRunId = "subagent-12121212-1212-4212-8212-121212121212";
    const branchRunId = "subagent-34343434-3434-4434-8434-343434343434";
    await mkdir(join(leasesRoot, pathRunId));
    execFileSync(
      "git",
      ["branch", `keel/subagent/${branchRunId.slice("subagent-".length)}`],
      { cwd: workspace },
    );

    try {
      expect(
        runtime.prepare({
          childRunId: pathRunId,
          signal: new AbortController().signal,
        }),
      ).toMatchObject({
        kind: "rejected",
        reason: expect.stringContaining("worktree path already exists"),
      });
      expect(
        runtime.prepare({
          childRunId: branchRunId,
          signal: new AbortController().signal,
        }),
      ).toMatchObject({
        kind: "rejected",
        reason: expect.stringContaining("branch already exists"),
      });
    } finally {
      execFileSync(
        "git",
        [
          "branch",
          "-D",
          `keel/subagent/${branchRunId.slice("subagent-".length)}`,
        ],
        { cwd: workspace },
      );
      await rm(workspace, { recursive: true, force: true });
      await rm(leasesRoot, { recursive: true, force: true });
    }
  });

  test(`Given the reserved path or lease-root identity changes after preparation,
    When writer activation revalidates the reservation,
    Then it reports the exact materialized path and leaves Git untouched`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-writer-root-race-"));
    const leasesParent = await mkdtemp(
      join(tmpdir(), "keel-writer-root-race-home-"),
    );
    const redirectedRoot = await mkdtemp(
      join(tmpdir(), "keel-writer-root-race-redirect-"),
    );
    const leasesRoot = join(leasesParent, "worktrees");
    await writeFile(join(workspace, "message.txt"), "before\n");
    initializeRepository(workspace);
    const runtime = createCliSubagentWriteWorkspaceRuntime({
      workspace,
      leasesRoot,
      platform: process.platform,
    });

    try {
      const occupied = runtime.prepare({
        childRunId: "subagent-45454545-4545-4454-8454-454545454545",
        signal: new AbortController().signal,
      });
      expect(occupied.kind).toBe("prepared");
      if (occupied.kind !== "prepared") return;
      await mkdir(occupied.workspace.reference.worktreePath, {
        recursive: true,
      });
      expect(occupied.workspace.activate()).toMatchObject({
        kind: "failed",
        worktreePath: occupied.workspace.reference.worktreePath,
        error: expect.stringContaining("worktree path already exists"),
      });
      expect(occupied.workspace.activate()).toMatchObject({
        kind: "failed",
        worktreePath: occupied.workspace.reference.worktreePath,
        error: expect.stringContaining("attempted twice"),
      });
      await rm(leasesRoot, { recursive: true, force: true });

      const redirected = runtime.prepare({
        childRunId: "subagent-56565656-5656-4565-8565-565656565656",
        signal: new AbortController().signal,
      });
      expect(redirected.kind).toBe("prepared");
      if (redirected.kind !== "prepared") return;
      await symlink(redirectedRoot, leasesRoot, "dir");
      expect(redirected.workspace.activate()).toMatchObject({
        kind: "failed",
        worktreePath: null,
        error: expect.stringContaining("canonical lease root changed"),
      });
      expect(
        execFileSync("git", ["branch", "--list", "keel/subagent/*"], {
          cwd: workspace,
          encoding: "utf8",
        }),
      ).toBe("");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(leasesParent, { recursive: true, force: true });
      await rm(redirectedRoot, { recursive: true, force: true });
    }
  });

  test(`Given the configured lease root resolves inside the clean parent checkout,
    When a writer asks for admission,
    Then it is rejected before creating any directory in the user's checkout`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-writer-contained-"));
    const containedHome = join(workspace, ".keel-home");
    await writeFile(join(workspace, "message.txt"), "before\n");
    await writeFile(join(workspace, ".gitignore"), ".keel-home/\n");
    initializeRepository(workspace);
    const runtime = createCliSubagentWriteWorkspaceRuntime({
      workspace,
      leasesRoot: join(containedHome, "sessions", "test", "worktrees"),
      platform: process.platform,
    });

    try {
      const preparation = runtime.prepare({
        childRunId: "subagent-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        signal: new AbortController().signal,
      });

      expect(preparation).toMatchObject({
        kind: "rejected",
        reason: expect.stringContaining("outside the parent repository"),
      });
      await expect(lstat(containedHome)).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(
        execFileSync("git", ["status", "--porcelain"], {
          cwd: workspace,
          encoding: "utf8",
        }),
      ).toBe("");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a writer worktree contains a new file hidden by .gitignore,
    When the lease settles,
    Then the worktree is preserved and the ignored file is present in its patch`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-writer-ignored-"));
    const leasesRoot = await mkdtemp(
      join(tmpdir(), "keel-writer-ignored-home-"),
    );
    await writeFile(join(workspace, "message.txt"), "before\n");
    await writeFile(join(workspace, ".gitignore"), "scratch/\n");
    initializeRepository(workspace);
    const runtime = createCliSubagentWriteWorkspaceRuntime({
      workspace,
      leasesRoot,
      platform: process.platform,
    });
    const preparation = runtime.prepare({
      childRunId: "subagent-cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      signal: new AbortController().signal,
    });
    expect(preparation.kind).toBe("prepared");
    if (preparation.kind !== "prepared") return;
    const acquisition = preparation.workspace.activate();
    expect(acquisition.kind).toBe("acquired");
    if (acquisition.kind !== "acquired") return;
    const lease = acquisition.lease;

    try {
      await mkdir(join(lease.reference.workspaceRoot, "scratch"));
      await writeFile(
        join(lease.reference.workspaceRoot, "scratch", "ignored.txt"),
        "must remain inspectable\n",
      );

      const settlement = lease.settle();

      expect(
        settlement.disposition,
        settlement.disposition === "cleanup_failed"
          ? settlement.error
          : undefined,
      ).toBe("preserved");
      expect(settlement).toMatchObject({
        disposition: "preserved",
        worktreePath: lease.reference.worktreePath,
        patch: { sourceTruncated: false },
      });
      expect(settlement.patch?.content).toContain("scratch/ignored.txt");
      expect(lease.settle()).toBe(settlement);
      await expect(lstat(lease.reference.worktreePath)).resolves.toBeDefined();
    } finally {
      execFileSync(
        "git",
        ["worktree", "remove", "--force", lease.reference.worktreePath],
        { cwd: workspace },
      );
      execFileSync("git", ["branch", "-D", lease.reference.branch], {
        cwd: workspace,
      });
      await rm(workspace, { recursive: true, force: true });
      await rm(leasesRoot, { recursive: true, force: true });
    }
  });

  test(`Given the process environment redirects Git to a different clean repository,
    When the configured parent checkout is dirty,
    Then writer preparation ignores the redirect and rejects before side effects`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-writer-git-env-"));
    const redirected = await mkdtemp(
      join(tmpdir(), "keel-writer-git-env-other-"),
    );
    const leasesParent = await mkdtemp(
      join(tmpdir(), "keel-writer-git-env-home-"),
    );
    const leasesRoot = join(leasesParent, "worktrees");
    await writeFile(join(workspace, "message.txt"), "committed\n");
    await writeFile(join(redirected, "message.txt"), "other\n");
    initializeRepository(workspace);
    initializeRepository(redirected);
    await writeFile(join(workspace, "message.txt"), "dirty\n");
    const gitDirEnvironmentKey = "GIT_DIR";
    const gitWorkTreeEnvironmentKey = "GIT_WORK_TREE";
    const previousGitDir = process.env[gitDirEnvironmentKey];
    const previousGitWorkTree = process.env[gitWorkTreeEnvironmentKey];
    process.env[gitDirEnvironmentKey] = join(redirected, ".git");
    process.env[gitWorkTreeEnvironmentKey] = redirected;

    try {
      const preparation = createCliSubagentWriteWorkspaceRuntime({
        workspace,
        leasesRoot,
        platform: process.platform,
      }).prepare({
        childRunId: "subagent-eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        signal: new AbortController().signal,
      });

      expect(preparation).toMatchObject({
        kind: "rejected",
        reason: expect.stringContaining("parent checkout has staged"),
      });
      await expect(lstat(leasesRoot)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (previousGitDir === undefined)
        delete process.env[gitDirEnvironmentKey];
      else process.env[gitDirEnvironmentKey] = previousGitDir;
      if (previousGitWorkTree === undefined)
        delete process.env[gitWorkTreeEnvironmentKey];
      else process.env[gitWorkTreeEnvironmentKey] = previousGitWorkTree;
      await rm(workspace, { recursive: true, force: true });
      await rm(redirected, { recursive: true, force: true });
      await rm(leasesParent, { recursive: true, force: true });
    }
  });

  test(`Given a writer dispatcher receives the wrong root or a changed Git identity,
    When it attempts file writes under that lease,
    Then it refuses both writes and preserves the restored clean worktree`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-writer-lease-"));
    const leasesRoot = await mkdtemp(join(tmpdir(), "keel-writer-lease-home-"));
    await writeFile(join(workspace, "message.txt"), "before\n");
    initializeRepository(workspace);
    const runtime = createCliSubagentWriteWorkspaceRuntime({
      workspace,
      leasesRoot,
      platform: process.platform,
    });
    const preparation = runtime.prepare({
      childRunId: "subagent-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      signal: new AbortController().signal,
    });
    expect(preparation.kind).toBe("prepared");
    if (preparation.kind !== "prepared") return;
    const acquisition = preparation.workspace.activate();
    expect(acquisition.kind).toBe("acquired");
    if (acquisition.kind !== "acquired") return;
    const lease = acquisition.lease;
    const wrongRootExecution = await executeToolCall({
      workspace,
      workspaceLease: lease,
      builtinToolAuthority: {
        kind: "auto",
        profile: "subagent",
        capability: resolveBuiltinSubagentProfile("writer").snapshot,
      },
      toolCall: {
        id: "writer_wrong_root",
        tool: "write",
        path: "escaped.txt",
        content: "must not be written\n",
      },
      signal: new AbortController().signal,
      bash: { kind: "disabled" },
    });
    expect(wrongRootExecution.ok).toBe(false);
    expect(wrongRootExecution.content).toContain("workspace lease");
    await expect(lstat(join(workspace, "escaped.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    const gitFile = join(lease.reference.worktreePath, ".git");
    const savedGitFile = join(lease.reference.worktreePath, ".git.saved");
    const originalGitFile = await readFile(gitFile, "utf8");
    const absoluteGitDir = originalGitFile.trim().slice("gitdir: ".length);
    await rename(gitFile, savedGitFile);
    await mkdir(gitFile);
    expect(() => lease.verify(lease.reference.workspaceRoot)).toThrow(
      "not a bounded regular file",
    );
    await rm(gitFile, { recursive: true });
    await rename(savedGitFile, gitFile);
    await writeFile(gitFile, "x".repeat(4_097));
    expect(() => lease.verify(lease.reference.workspaceRoot)).toThrow(
      "not a bounded regular file",
    );
    await writeFile(gitFile, originalGitFile);
    await writeFile(
      gitFile,
      `gitdir: ${relative(lease.reference.worktreePath, absoluteGitDir)}\n`,
    );
    expect(() => lease.verify(lease.reference.workspaceRoot)).not.toThrow();
    execFileSync("git", ["commit", "--allow-empty", "-m", "external drift"], {
      cwd: lease.reference.worktreePath,
    });
    expect(() => lease.verify(lease.reference.workspaceRoot)).toThrow(
      "leased HEAD changed",
    );
    execFileSync("git", ["reset", "--hard", lease.reference.baseCommit], {
      cwd: lease.reference.worktreePath,
    });
    execFileSync("git", ["checkout", "--detach", "--quiet"], {
      cwd: lease.reference.worktreePath,
    });
    const detachedExecution = await executeToolCall({
      workspace: lease.reference.workspaceRoot,
      workspaceLease: lease,
      builtinToolAuthority: {
        kind: "auto",
        profile: "subagent",
        capability: resolveBuiltinSubagentProfile("writer").snapshot,
      },
      toolCall: {
        id: "writer_detached_branch",
        tool: "write",
        path: "detached.txt",
        content: "must not be written\n",
      },
      signal: new AbortController().signal,
      bash: { kind: "disabled" },
    });
    expect(detachedExecution.ok).toBe(false);
    expect(detachedExecution.content).toContain("leased branch changed");
    await expect(
      lstat(join(lease.reference.workspaceRoot, "detached.txt")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    execFileSync("git", ["checkout", "--quiet", lease.reference.branch], {
      cwd: lease.reference.worktreePath,
    });
    expect(() => lease.verify(lease.reference.workspaceRoot)).not.toThrow();
    await writeFile(gitFile, "not a gitdir reference\n");
    expect(() => lease.verify(lease.reference.workspaceRoot)).toThrow(
      "identity is malformed",
    );
    await writeFile(gitFile, originalGitFile);
    await rename(gitFile, savedGitFile);
    await writeFile(gitFile, "gitdir: /tmp/not-the-leased-worktree\n");

    try {
      // When
      const execution = await executeToolCall({
        workspace: lease.reference.workspaceRoot,
        workspaceLease: lease,
        builtinToolAuthority: {
          kind: "auto",
          profile: "subagent",
          capability: resolveBuiltinSubagentProfile("writer").snapshot,
        },
        toolCall: {
          id: "writer_forged_root",
          tool: "write",
          path: "escaped.txt",
          content: "must not be written\n",
        },
        signal: new AbortController().signal,
        bash: { kind: "disabled" },
      });

      // Then
      expect(execution.ok).toBe(false);
      expect(execution.content).toContain("workspace lease");
      await expect(
        lstat(join(lease.reference.workspaceRoot, "escaped.txt")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      const settlement = lease.settle();
      expect(settlement).toMatchObject({
        disposition: "cleanup_failed",
        worktreePath: lease.reference.worktreePath,
        patch: null,
        error: expect.stringContaining("workspace lease validation failed"),
      });
      await rm(gitFile);
      await rename(savedGitFile, gitFile);
      expect(lease.settle()).toBe(settlement);
      await expect(lstat(lease.reference.worktreePath)).resolves.toBeDefined();
      expect(
        execFileSync("git", ["branch", "--list", lease.reference.branch], {
          cwd: workspace,
          encoding: "utf8",
        }),
      ).not.toBe("");
    } finally {
      if (await lstat(savedGitFile).catch(() => undefined)) {
        await rm(gitFile, { force: true });
        await rename(savedGitFile, gitFile);
      }
      execFileSync(
        "git",
        ["worktree", "remove", "--force", lease.reference.worktreePath],
        { cwd: workspace },
      );
      execFileSync("git", ["branch", "-D", lease.reference.branch], {
        cwd: workspace,
      });
      await rm(workspace, { recursive: true, force: true });
      await rm(leasesRoot, { recursive: true, force: true });
    }
  });

  test(`Given an acquired writer path is replaced by a different directory identity,
    When the dispatcher verifies the lease,
    Then it rejects the replacement and accepts the restored original inode`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-writer-inode-"));
    const leasesRoot = await mkdtemp(join(tmpdir(), "keel-writer-inode-home-"));
    await writeFile(join(workspace, "message.txt"), "before\n");
    initializeRepository(workspace);
    const preparation = createCliSubagentWriteWorkspaceRuntime({
      workspace,
      leasesRoot,
      platform: process.platform,
    }).prepare({
      childRunId: "subagent-30303030-3030-4030-8030-303030303030",
      signal: new AbortController().signal,
    });
    expect(preparation.kind).toBe("prepared");
    if (preparation.kind !== "prepared") return;
    const acquisition = preparation.workspace.activate();
    expect(acquisition.kind).toBe("acquired");
    if (acquisition.kind !== "acquired") return;
    const lease = acquisition.lease;
    const savedWorktree = `${lease.reference.worktreePath}.saved`;
    const gitIdentity = await readFile(
      join(lease.reference.worktreePath, ".git"),
      "utf8",
    );

    try {
      await rename(lease.reference.worktreePath, savedWorktree);
      await mkdir(lease.reference.worktreePath);
      await writeFile(join(lease.reference.worktreePath, ".git"), gitIdentity);

      expect(() => lease.verify(lease.reference.workspaceRoot)).toThrow(
        "identity changed",
      );
      await rm(lease.reference.worktreePath, { recursive: true });
      await rename(savedWorktree, lease.reference.worktreePath);
      expect(() => lease.verify(lease.reference.workspaceRoot)).not.toThrow();
    } finally {
      if (await lstat(savedWorktree).catch(() => undefined)) {
        await rm(lease.reference.worktreePath, {
          recursive: true,
          force: true,
        });
        await rename(savedWorktree, lease.reference.worktreePath);
      }
      execFileSync(
        "git",
        ["worktree", "remove", "--force", lease.reference.worktreePath],
        { cwd: workspace },
      );
      execFileSync("git", ["branch", "-D", lease.reference.branch], {
        cwd: workspace,
      });
      await rm(workspace, { recursive: true, force: true });
      await rm(leasesRoot, { recursive: true, force: true });
    }
  });

  test(`Given Keel runs from a repository subdirectory that is replaced inside the child,
    When the dispatcher rechecks its canonical workspace root,
    Then it rejects the redirected subdirectory before tool access`, async () => {
    const repository = await mkdtemp(join(tmpdir(), "keel-writer-subdir-"));
    const workspace = join(repository, "project");
    const leasesRoot = await mkdtemp(
      join(tmpdir(), "keel-writer-subdir-home-"),
    );
    await mkdir(workspace);
    await writeFile(join(workspace, "message.txt"), "before\n");
    initializeRepository(repository);
    const preparation = createCliSubagentWriteWorkspaceRuntime({
      workspace,
      leasesRoot,
      platform: process.platform,
    }).prepare({
      childRunId: "subagent-40404040-4040-4040-8040-404040404040",
      signal: new AbortController().signal,
    });
    expect(preparation.kind).toBe("prepared");
    if (preparation.kind !== "prepared") return;
    const acquisition = preparation.workspace.activate();
    expect(acquisition.kind).toBe("acquired");
    if (acquisition.kind !== "acquired") return;
    const lease = acquisition.lease;
    const savedWorkspace = `${lease.reference.workspaceRoot}.saved`;
    const redirectedWorkspace = join(
      lease.reference.worktreePath,
      "redirected-project",
    );

    try {
      await rename(lease.reference.workspaceRoot, savedWorkspace);
      await mkdir(redirectedWorkspace);
      await symlink(redirectedWorkspace, lease.reference.workspaceRoot, "dir");

      expect(() => lease.verify(lease.reference.workspaceRoot)).toThrow(
        "canonical workspace root changed",
      );
      await rm(lease.reference.workspaceRoot);
      await rename(savedWorkspace, lease.reference.workspaceRoot);
    } finally {
      if (await lstat(savedWorkspace).catch(() => undefined)) {
        await rm(lease.reference.workspaceRoot, {
          recursive: true,
          force: true,
        });
        await rename(savedWorkspace, lease.reference.workspaceRoot);
      }
      execFileSync(
        "git",
        ["worktree", "remove", "--force", lease.reference.worktreePath],
        { cwd: repository },
      );
      execFileSync("git", ["branch", "-D", lease.reference.branch], {
        cwd: repository,
      });
      await rm(repository, { recursive: true, force: true });
      await rm(leasesRoot, { recursive: true, force: true });
    }
  });

  test(`Given a clean writer is preserved and later loses its worktree externally,
    When the lease settles each state,
    Then clean evidence is exact and a missing worktree is reported as cleanup failure`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-writer-clean-"));
    const leasesRoot = await mkdtemp(join(tmpdir(), "keel-writer-clean-home-"));
    await writeFile(join(workspace, "message.txt"), "before\n");
    initializeRepository(workspace);
    const runtime = createCliSubagentWriteWorkspaceRuntime({
      workspace,
      leasesRoot,
      platform: process.platform,
    });

    const cleanPreparation = runtime.prepare({
      childRunId: "subagent-67676767-6767-4676-8676-676767676767",
      signal: new AbortController().signal,
    });
    expect(cleanPreparation.kind).toBe("prepared");
    if (cleanPreparation.kind !== "prepared") return;
    const cleanAcquisition = cleanPreparation.workspace.activate();
    expect(cleanAcquisition.kind).toBe("acquired");
    if (cleanAcquisition.kind !== "acquired") return;
    const cleanLease = cleanAcquisition.lease;

    try {
      expect(cleanLease.settle()).toMatchObject({
        disposition: "preserved",
        patch: {
          content: "",
          sourceTruncated: false,
          summary: "clean at base commit",
        },
      });
      expect(cleanPreparation.workspace.activate()).toMatchObject({
        kind: "failed",
        worktreePath: cleanLease.reference.worktreePath,
        error: expect.stringContaining("attempted twice"),
      });
      execFileSync(
        "git",
        ["worktree", "remove", "--force", cleanLease.reference.worktreePath],
        { cwd: workspace },
      );
      execFileSync("git", ["branch", "-D", cleanLease.reference.branch], {
        cwd: workspace,
      });

      const missingPreparation = runtime.prepare({
        childRunId: "subagent-78787878-7878-4787-8787-787878787878",
        signal: new AbortController().signal,
      });
      expect(missingPreparation.kind).toBe("prepared");
      if (missingPreparation.kind !== "prepared") return;
      const missingAcquisition = missingPreparation.workspace.activate();
      expect(missingAcquisition.kind).toBe("acquired");
      if (missingAcquisition.kind !== "acquired") return;
      execFileSync(
        "git",
        [
          "worktree",
          "remove",
          "--force",
          missingAcquisition.lease.reference.worktreePath,
        ],
        { cwd: workspace },
      );
      expect(missingAcquisition.lease.settle()).toMatchObject({
        disposition: "cleanup_failed",
        worktreePath: null,
        patch: null,
      });
      execFileSync(
        "git",
        ["branch", "-D", missingAcquisition.lease.reference.branch],
        { cwd: workspace },
      );
    } finally {
      if (
        await lstat(cleanLease.reference.worktreePath).catch(() => undefined)
      ) {
        execFileSync(
          "git",
          ["worktree", "remove", "--force", cleanLease.reference.worktreePath],
          { cwd: workspace },
        );
      }
      await rm(workspace, { recursive: true, force: true });
      await rm(leasesRoot, { recursive: true, force: true });
    }
  });

  test(`Given a writer has a very large valid status,
    When its lease produces the inspection summary,
    Then its branch identity is explicit and the summary remains bounded`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-writer-summary-"));
    const leasesRoot = await mkdtemp(
      join(tmpdir(), "keel-writer-summary-home-"),
    );
    await writeFile(join(workspace, "message.txt"), "before\n");
    initializeRepository(workspace);
    const runtime = createCliSubagentWriteWorkspaceRuntime({
      workspace,
      leasesRoot,
      platform: process.platform,
    });
    const preparation = runtime.prepare({
      childRunId: "subagent-89898989-8989-4989-8989-898989898989",
      signal: new AbortController().signal,
    });
    expect(preparation.kind).toBe("prepared");
    if (preparation.kind !== "prepared") return;
    const acquisition = preparation.workspace.activate();
    expect(acquisition.kind).toBe("acquired");
    if (acquisition.kind !== "acquired") return;
    const lease = acquisition.lease;

    try {
      for (let index = 0; index < 180; index++) {
        await writeFile(
          join(
            lease.reference.workspaceRoot,
            `status-${String(index).padStart(3, "0")}-${"x".repeat(24)}.txt`,
          ),
          "changed\n",
        );
      }

      const settlement = lease.settle();
      expect(settlement.disposition).toBe("preserved");
      expect(settlement.patch?.summary).toContain(
        `branch ${lease.reference.branch}`,
      );
      expect(settlement.patch?.summary.length).toBe(4_000);
      expect(settlement.patch?.summary.endsWith("...")).toBe(true);
    } finally {
      execFileSync(
        "git",
        ["worktree", "remove", "--force", lease.reference.worktreePath],
        { cwd: workspace },
      );
      execFileSync("git", ["branch", "-D", lease.reference.branch], {
        cwd: workspace,
      });
      await rm(workspace, { recursive: true, force: true });
      await rm(leasesRoot, { recursive: true, force: true });
    }
  });

  test(`Given repository attributes name executable textconv and clean helpers,
    When a writer settles tracked and untracked changes,
    Then admission and patch capture never execute either repository helper`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-writer-textconv-"));
    const leasesRoot = await mkdtemp(
      join(tmpdir(), "keel-writer-textconv-home-"),
    );
    const textconvMarker = join(leasesRoot, "textconv-ran");
    const cleanMarker = join(leasesRoot, "clean-filter-ran");
    const textconvHelper = join(leasesRoot, "textconv-helper.mjs");
    const cleanHelper = join(leasesRoot, "clean-helper.mjs");
    await writeFile(
      join(workspace, ".gitattributes"),
      "*.bin diff=keel filter=keel\n",
    );
    await writeFile(join(workspace, "tracked.bin"), "before\n");
    await writeFile(
      textconvHelper,
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(textconvMarker)}, "ran\\n");\n`,
    );
    await writeFile(
      cleanHelper,
      `import { readFileSync, writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(cleanMarker)}, "ran\\n");\nprocess.stdout.write(readFileSync(0));\n`,
    );
    initializeRepository(workspace);
    execFileSync(
      "git",
      ["config", "diff.keel.textconv", `${process.execPath} ${textconvHelper}`],
      { cwd: workspace },
    );
    execFileSync(
      "git",
      ["config", "filter.keel.clean", `${process.execPath} ${cleanHelper}`],
      { cwd: workspace },
    );
    const runtime = createCliSubagentWriteWorkspaceRuntime({
      workspace,
      leasesRoot,
      platform: process.platform,
    });
    const preparation = runtime.prepare({
      childRunId: "subagent-dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      signal: new AbortController().signal,
    });
    expect(preparation.kind).toBe("prepared");
    if (preparation.kind !== "prepared") return;
    const acquisition = preparation.workspace.activate();
    expect(acquisition.kind).toBe("acquired");
    if (acquisition.kind !== "acquired") return;
    const lease = acquisition.lease;

    try {
      await writeFile(
        join(lease.reference.workspaceRoot, "tracked.bin"),
        "after\n",
      );
      await writeFile(
        join(lease.reference.workspaceRoot, "untracked.bin"),
        "new\n",
      );

      const settlement = lease.settle();

      expect(settlement.disposition).toBe("preserved");
      expect(settlement.patch?.content).toContain("tracked.bin");
      expect(settlement.patch?.content).toContain("untracked.bin");
      await expect(readFile(textconvMarker, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(readFile(cleanMarker, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      execFileSync(
        "git",
        ["worktree", "remove", "--force", lease.reference.worktreePath],
        { cwd: workspace },
      );
      execFileSync("git", ["branch", "-D", lease.reference.branch], {
        cwd: workspace,
      });
      await rm(workspace, { recursive: true, force: true });
      await rm(leasesRoot, { recursive: true, force: true });
    }
  });

  test(`Given child-conditional Git config introduces an executable filter,
    When writer activation checks out the isolated branch,
    Then it disables the child filter before materializing files`, async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-writer-conditional-filter-"),
    );
    const leasesRoot = await mkdtemp(
      join(tmpdir(), "keel-writer-conditional-filter-home-"),
    );
    const marker = join(leasesRoot, "conditional-filter-ran");
    const helper = join(leasesRoot, "conditional-filter.mjs");
    const conditionalConfig = join(leasesRoot, "child-branch.config");
    await writeFile(join(workspace, ".gitattributes"), "*.txt filter=child\n");
    await writeFile(join(workspace, "message.txt"), "before\n");
    await writeFile(
      helper,
      `import { readFileSync, writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "ran\\n");\nprocess.stdout.write(readFileSync(0));\n`,
    );
    await writeFile(
      conditionalConfig,
      `[filter "child"]\n\tsmudge = ${process.execPath} ${helper}\n\trequired = true\n`,
    );
    initializeRepository(workspace);
    execFileSync(
      "git",
      [
        "config",
        "--local",
        "includeIf.onbranch:keel/subagent/**.path",
        conditionalConfig,
      ],
      { cwd: workspace },
    );
    const preparation = createCliSubagentWriteWorkspaceRuntime({
      workspace,
      leasesRoot,
      platform: process.platform,
    }).prepare({
      childRunId: "subagent-eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      signal: new AbortController().signal,
    });
    expect(preparation.kind).toBe("prepared");
    if (preparation.kind !== "prepared") return;

    const acquisition = preparation.workspace.activate();
    expect(acquisition.kind).toBe("acquired");
    if (acquisition.kind !== "acquired") return;

    try {
      expect(
        execFileSync("git", ["config", "--get", "filter.child.smudge"], {
          cwd: acquisition.lease.reference.worktreePath,
          encoding: "utf8",
        }),
      ).toContain(helper);
      await expect(readFile(marker, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(
        readFile(
          join(acquisition.lease.reference.workspaceRoot, "message.txt"),
          "utf8",
        ),
      ).resolves.toBe("before\n");
    } finally {
      execFileSync(
        "git",
        [
          "worktree",
          "remove",
          "--force",
          acquisition.lease.reference.worktreePath,
        ],
        { cwd: workspace },
      );
      execFileSync(
        "git",
        ["branch", "-D", acquisition.lease.reference.branch],
        {
          cwd: workspace,
        },
      );
      await rm(workspace, { recursive: true, force: true });
      await rm(leasesRoot, { recursive: true, force: true });
    }
  });

  test(`Given several untracked files exceed the bounded aggregate patch size,
    When the writer lease settles,
    Then it preserves a source-truncated patch instead of reading without limit`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-writer-patch-bound-"));
    const leasesRoot = await mkdtemp(
      join(tmpdir(), "keel-writer-patch-bound-home-"),
    );
    await writeFile(join(workspace, "message.txt"), "before\n");
    initializeRepository(workspace);
    const runtime = createCliSubagentWriteWorkspaceRuntime({
      workspace,
      leasesRoot,
      platform: process.platform,
    });
    const preparation = runtime.prepare({
      childRunId: "subagent-44444444-4444-4444-8444-444444444444",
      signal: new AbortController().signal,
    });
    expect(preparation.kind).toBe("prepared");
    if (preparation.kind !== "prepared") return;
    const acquisition = preparation.workspace.activate();
    expect(acquisition.kind).toBe("acquired");
    if (acquisition.kind !== "acquired") return;
    const lease = acquisition.lease;

    try {
      await writeFile(
        join(lease.reference.workspaceRoot, "large-a.txt"),
        Buffer.alloc(6_000_000, "a"),
      );
      await writeFile(
        join(lease.reference.workspaceRoot, "large-b.txt"),
        Buffer.alloc(6_000_000, "b"),
      );

      const settlement = lease.settle();

      expect(settlement).toMatchObject({
        disposition: "preserved",
        patch: { sourceTruncated: true },
      });
      expect(settlement.patch?.content.length).toBe(10_000_000);
    } finally {
      execFileSync(
        "git",
        ["worktree", "remove", "--force", lease.reference.worktreePath],
        { cwd: workspace },
      );
      execFileSync("git", ["branch", "-D", lease.reference.branch], {
        cwd: workspace,
      });
      await rm(workspace, { recursive: true, force: true });
      await rm(leasesRoot, { recursive: true, force: true });
    }
  });
});
