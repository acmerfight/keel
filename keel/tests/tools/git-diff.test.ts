import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { executeToolCall } from "../../src/tools/execution.ts";
import { executeGitDiff } from "../../src/tools/git-diff.ts";

const GIT_EXTERNAL_DIFF_ENV = "GIT_EXTERNAL_DIFF";
const GIT_CONFIG_COUNT_ENV = "GIT_CONFIG_COUNT";
const GIT_CONFIG_KEY_0_ENV = "GIT_CONFIG_KEY_0";
const GIT_CONFIG_VALUE_0_ENV = "GIT_CONFIG_VALUE_0";
const GIT_CONFIG_PARAMETERS_ENV = "GIT_CONFIG_PARAMETERS";
const GIT_CONFIG_GLOBAL_ENV = "GIT_CONFIG_GLOBAL";
const GIT_CONFIG_SYSTEM_ENV = "GIT_CONFIG_SYSTEM";

function freshSignal(): AbortSignal {
  return new AbortController().signal;
}

async function createGitWorkspace(prefix: string): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), prefix));
  execFileSync("git", ["init"], { cwd: workspace });
  execFileSync("git", ["config", "user.email", "keel@example.test"], {
    cwd: workspace,
  });
  execFileSync("git", ["config", "user.name", "Keel Test"], {
    cwd: workspace,
  });
  await writeFile(join(workspace, "tracked.txt"), "before\n", "utf8");
  execFileSync("git", ["add", "tracked.txt"], { cwd: workspace });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: workspace });
  return workspace;
}

function restoreEnv(
  previousValues: ReadonlyMap<string, string | undefined>,
): void {
  for (const [key, value] of previousValues) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

interface ExecutableGitDiffHelperFixture {
  readonly marker: string;
  readonly restore: () => void;
}

async function configureExecutableGitDiffHelpers(
  workspace: string,
): Promise<ExecutableGitDiffHelperFixture> {
  const marker = join(workspace, "helper-ran");
  const helper = join(workspace, "helper.sh");
  await writeFile(
    helper,
    ["#!/bin/sh", `printf ran > ${JSON.stringify(marker)}`, "exit 0", ""].join(
      "\n",
    ),
    "utf8",
  );
  await chmod(helper, 0o755);
  execFileSync("git", ["config", "diff.external", helper], {
    cwd: workspace,
  });
  execFileSync("git", ["config", "core.fsmonitor", helper], {
    cwd: workspace,
  });
  execFileSync("git", ["config", "filter.keel.clean", helper], {
    cwd: workspace,
  });
  execFileSync("git", ["config", "filter.keel.process", helper], {
    cwd: workspace,
  });
  execFileSync("git", ["config", "filter.keel.required", "true"], {
    cwd: workspace,
  });
  const previousEnv = new Map<string, string | undefined>([
    [GIT_EXTERNAL_DIFF_ENV, process.env[GIT_EXTERNAL_DIFF_ENV]],
    [GIT_CONFIG_COUNT_ENV, process.env[GIT_CONFIG_COUNT_ENV]],
    [GIT_CONFIG_KEY_0_ENV, process.env[GIT_CONFIG_KEY_0_ENV]],
    [GIT_CONFIG_VALUE_0_ENV, process.env[GIT_CONFIG_VALUE_0_ENV]],
    [GIT_CONFIG_PARAMETERS_ENV, process.env[GIT_CONFIG_PARAMETERS_ENV]],
    [GIT_CONFIG_GLOBAL_ENV, process.env[GIT_CONFIG_GLOBAL_ENV]],
    [GIT_CONFIG_SYSTEM_ENV, process.env[GIT_CONFIG_SYSTEM_ENV]],
  ]);
  process.env[GIT_EXTERNAL_DIFF_ENV] = helper;
  process.env[GIT_CONFIG_COUNT_ENV] = "1";
  process.env[GIT_CONFIG_KEY_0_ENV] = "core.fsmonitor";
  process.env[GIT_CONFIG_VALUE_0_ENV] = helper;
  process.env[GIT_CONFIG_PARAMETERS_ENV] = `core.fsmonitor=${helper}`;
  process.env[GIT_CONFIG_GLOBAL_ENV] = helper;
  process.env[GIT_CONFIG_SYSTEM_ENV] = helper;

  return { marker, restore: () => restoreEnv(previousEnv) };
}

describe("git_diff tool", () => {
  test(`Given staged unstaged and untracked changes,
    When git_diff inspects the workspace with bash disabled,
    Then it returns every current change without shell approval`, async () => {
    // Given
    const workspace = await createGitWorkspace("keel-git-diff-");
    await writeFile(join(workspace, "tracked.txt"), "after\n", "utf8");
    await writeFile(join(workspace, "staged.txt"), "staged\n", "utf8");
    execFileSync("git", ["add", "staged.txt"], { cwd: workspace });
    await writeFile(join(workspace, "untracked.txt"), "untracked\n", "utf8");

    try {
      // When
      const result = await executeToolCall({
        workspace,
        signal: freshSignal(),
        allowBash: false,
        toolCall: {
          id: "inspect_changes",
          tool: "git_diff",
          mode: "all",
        },
      });

      // Then
      expect(result.ok).toBe(true);
      expect(result.content).toContain(
        "diff --git a/tracked.txt b/tracked.txt",
      );
      expect(result.content).toContain("-before");
      expect(result.content).toContain("+after");
      expect(result.content).toContain("diff --git a/staged.txt b/staged.txt");
      expect(result.content).toContain("+staged");
      expect(result.content).toContain(
        "diff --git a/untracked.txt b/untracked.txt",
      );
      expect(result.content).toContain("+untracked");
      expect(result.content).not.toContain("Tool failed: bash failed");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given no current git changes,
    When git_diff inspects the workspace,
    Then it reports that no changes were found`, async () => {
    // Given
    const workspace = await createGitWorkspace("keel-git-diff-clean-");

    try {
      // When
      const result = await executeToolCall({
        workspace,
        signal: freshSignal(),
        allowBash: false,
        toolCall: {
          id: "clean_diff",
          tool: "git_diff",
        },
      });

      // Then
      expect(result.ok).toBe(true);
      expect(result.content).toBe("No git changes found.");
      await expect(executeGitDiff(workspace)).resolves.toEqual({
        content: "No git changes found.",
        hasChanges: false,
        inGitWorkTree: true,
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the workspace is a git repository subdirectory,
    When git_diff inspects current changes,
    Then it returns only diffs inside that workspace`, async () => {
    // Given
    const workspace = await createGitWorkspace("keel-git-diff-subdir-");
    await mkdir(join(workspace, "src"));
    await writeFile(join(workspace, "root.txt"), "before\n", "utf8");
    await writeFile(join(workspace, "src", "app.ts"), "before\n", "utf8");
    execFileSync("git", ["add", "root.txt", "src/app.ts"], {
      cwd: workspace,
    });
    execFileSync("git", ["commit", "-m", "add nested files"], {
      cwd: workspace,
    });
    await writeFile(join(workspace, "root.txt"), "after\n", "utf8");
    await writeFile(join(workspace, "src", "app.ts"), "after\n", "utf8");
    await writeFile(join(workspace, "src", "new.ts"), "new\n", "utf8");

    try {
      // When
      const result = await executeToolCall({
        workspace: join(workspace, "src"),
        signal: freshSignal(),
        allowBash: false,
        toolCall: {
          id: "subdir_diff",
          tool: "git_diff",
          mode: "all",
        },
      });

      // Then
      expect(result.ok).toBe(true);
      expect(result.content).toContain("diff --git a/src/app.ts b/src/app.ts");
      expect(result.content).toContain("-before");
      expect(result.content).toContain("+after");
      expect(result.content).toContain("diff --git a/src/new.ts b/src/new.ts");
      expect(result.content).toContain("+new");
      expect(result.content).not.toContain("root.txt");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given two committed refs in a clean workspace,
    When git_diff compares the refs,
    Then it returns the committed diff without shell approval`, async () => {
    // Given
    const workspace = await createGitWorkspace("keel-git-diff-refs-");
    await writeFile(join(workspace, "tracked.txt"), "after\n", "utf8");
    execFileSync("git", ["add", "tracked.txt"], { cwd: workspace });
    execFileSync("git", ["commit", "-m", "update tracked"], {
      cwd: workspace,
    });

    try {
      // When
      const result = await executeToolCall({
        workspace,
        signal: freshSignal(),
        allowBash: false,
        toolCall: {
          id: "compare_refs",
          tool: "git_diff",
          baseRef: "HEAD~1",
          headRef: "HEAD",
        },
      });

      // Then
      expect(result.ok).toBe(true);
      expect(result.content).toContain("Ref comparison (HEAD~1..HEAD):");
      expect(result.content).toContain(
        "diff --git a/tracked.txt b/tracked.txt",
      );
      expect(result.content).toContain("-before");
      expect(result.content).toContain("+after");
      expect(result.content).not.toContain("Unstaged changes:");
      expect(result.content).not.toContain("Staged changes:");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given baseRef is set without headRef,
    When git_diff compares the ref to the default head,
    Then it uses HEAD as the newer side`, async () => {
    // Given
    const workspace = await createGitWorkspace("keel-git-diff-default-head-");
    await writeFile(join(workspace, "tracked.txt"), "after\n", "utf8");
    execFileSync("git", ["add", "tracked.txt"], { cwd: workspace });
    execFileSync("git", ["commit", "-m", "update tracked"], {
      cwd: workspace,
    });

    try {
      // When
      const result = await executeToolCall({
        workspace,
        signal: freshSignal(),
        allowBash: false,
        toolCall: {
          id: "compare_default_head",
          tool: "git_diff",
          baseRef: "HEAD~1",
        },
      });

      // Then
      expect(result.ok).toBe(true);
      expect(result.content).toContain("Ref comparison (HEAD~1..HEAD):");
      expect(result.content).toContain("+after");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a ref comparison has no file changes,
    When git_diff compares the same commit,
    Then it reports that no changes were found`, async () => {
    // Given
    const workspace = await createGitWorkspace("keel-git-diff-empty-refs-");

    try {
      // When
      const result = await executeToolCall({
        workspace,
        signal: freshSignal(),
        allowBash: false,
        toolCall: {
          id: "empty_ref_diff",
          tool: "git_diff",
          baseRef: "HEAD",
          headRef: "HEAD",
        },
      });

      // Then
      expect(result.ok).toBe(true);
      expect(result.content).toBe("No git changes found.");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given divergent branches and a requested merge-base comparison,
    When git_diff compares baseRef to headRef with mergeBase enabled,
    Then it returns the head branch diff from the merge base`, async () => {
    // Given
    const workspace = await createGitWorkspace("keel-git-diff-merge-base-");
    execFileSync("git", ["branch", "target"], { cwd: workspace });
    execFileSync("git", ["checkout", "-q", "-b", "feature"], {
      cwd: workspace,
    });
    await writeFile(join(workspace, "tracked.txt"), "feature\n", "utf8");
    execFileSync("git", ["add", "tracked.txt"], { cwd: workspace });
    execFileSync("git", ["commit", "-m", "feature change"], {
      cwd: workspace,
    });
    execFileSync("git", ["checkout", "-q", "target"], { cwd: workspace });
    await writeFile(join(workspace, "tracked.txt"), "target\n", "utf8");
    execFileSync("git", ["add", "tracked.txt"], { cwd: workspace });
    execFileSync("git", ["commit", "-m", "target change"], {
      cwd: workspace,
    });

    try {
      // When
      const result = await executeToolCall({
        workspace,
        signal: freshSignal(),
        allowBash: false,
        toolCall: {
          id: "compare_merge_base",
          tool: "git_diff",
          baseRef: "target",
          headRef: "feature",
          mergeBase: true,
        },
      });

      // Then
      expect(result.ok).toBe(true);
      expect(result.content).toContain("Ref comparison (target...feature):");
      expect(result.content).toContain(
        "diff --git a/tracked.txt b/tracked.txt",
      );
      expect(result.content).toContain("-before");
      expect(result.content).toContain("+feature");
      expect(result.content).not.toContain("+target");
      expect(result.content).not.toContain("-target");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a staged path filter,
    When git_diff inspects only staged changes for that path,
    Then unrelated unstaged and untracked changes are omitted`, async () => {
    // Given
    const workspace = await createGitWorkspace("keel-git-diff-staged-");
    await writeFile(join(workspace, "tracked.txt"), "unstaged\n", "utf8");
    await writeFile(join(workspace, "staged.txt"), "staged only\n", "utf8");
    execFileSync("git", ["add", "staged.txt"], { cwd: workspace });
    await writeFile(join(workspace, "untracked.txt"), "untracked\n", "utf8");

    try {
      // When
      const result = await executeToolCall({
        workspace,
        signal: freshSignal(),
        allowBash: false,
        toolCall: {
          id: "staged_path_diff",
          tool: "git_diff",
          mode: "staged",
          paths: ["staged.txt"],
        },
      });

      // Then
      expect(result.ok).toBe(true);
      expect(result.content).toContain("Staged changes:");
      expect(result.content).toContain("+staged only");
      expect(result.content).not.toContain("unstaged");
      expect(result.content).not.toContain("untracked");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a staged rename and a target path filter,
    When git_diff inspects the filtered staged changes,
    Then it preserves the rename metadata instead of reporting an add-only file`, async () => {
    // Given
    const workspace = await createGitWorkspace("keel-git-diff-rename-filter-");
    await mkdir(join(workspace, "src"));
    await writeFile(join(workspace, "src", "old.ts"), "export const x = 1;\n");
    execFileSync("git", ["add", "src/old.ts"], { cwd: workspace });
    execFileSync("git", ["commit", "-m", "add old path"], { cwd: workspace });
    execFileSync("git", ["mv", "src/old.ts", "src/new.ts"], {
      cwd: workspace,
    });

    try {
      // When
      const result = await executeToolCall({
        workspace,
        signal: freshSignal(),
        allowBash: false,
        toolCall: {
          id: "staged_rename_path_diff",
          tool: "git_diff",
          mode: "staged",
          paths: ["src/new.ts"],
        },
      });

      // Then
      expect(result.ok).toBe(true);
      expect(result.content).toContain("diff --git a/src/old.ts b/src/new.ts");
      expect(result.content).toContain("similarity index 100%");
      expect(result.content).toContain("rename from src/old.ts");
      expect(result.content).toContain("rename to src/new.ts");
      expect(result.content).not.toContain("new file mode");
      expect(result.content).not.toContain("deleted file mode");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given root and dot-prefixed path filters,
    When git_diff inspects tracked changes,
    Then the filters still match workspace-relative diff paths`, async () => {
    // Given
    const workspace = await createGitWorkspace("keel-git-diff-dot-filter-");
    await mkdir(join(workspace, "src"));
    await writeFile(join(workspace, "src", "app.ts"), "before\n", "utf8");
    execFileSync("git", ["add", "src/app.ts"], { cwd: workspace });
    execFileSync("git", ["commit", "-m", "add src file"], { cwd: workspace });
    await writeFile(join(workspace, "src", "app.ts"), "after\n", "utf8");

    try {
      // When
      const rootResult = await executeToolCall({
        workspace,
        signal: freshSignal(),
        allowBash: false,
        toolCall: {
          id: "root_filter_diff",
          tool: "git_diff",
          mode: "unstaged",
          paths: ["."],
        },
      });
      const dotPrefixedResult = await executeToolCall({
        workspace,
        signal: freshSignal(),
        allowBash: false,
        toolCall: {
          id: "dot_prefixed_filter_diff",
          tool: "git_diff",
          mode: "unstaged",
          paths: ["./src"],
        },
      });

      // Then
      expect(rootResult.ok).toBe(true);
      expect(rootResult.content).toContain(
        "diff --git a/src/app.ts b/src/app.ts",
      );
      expect(rootResult.content).toContain("+after");
      expect(dotPrefixedResult.ok).toBe(true);
      expect(dotPrefixedResult.content).toContain(
        "diff --git a/src/app.ts b/src/app.ts",
      );
      expect(dotPrefixedResult.content).toContain("+after");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given tracked files later become ignored,
    When git_diff inspects visible changes,
    Then ignored tracked and untracked content is not exposed`, async () => {
    // Given
    const workspace = await createGitWorkspace("keel-git-diff-ignored-");
    await writeFile(
      join(workspace, "secret-staged.env"),
      "original staged secret\n",
      "utf8",
    );
    await writeFile(
      join(workspace, "secret-unstaged.env"),
      "original unstaged secret\n",
      "utf8",
    );
    execFileSync("git", ["add", "secret-staged.env", "secret-unstaged.env"], {
      cwd: workspace,
    });
    execFileSync("git", ["commit", "-m", "add tracked secrets"], {
      cwd: workspace,
    });
    await writeFile(
      join(workspace, ".gitignore"),
      [
        "secret-staged.env",
        "secret-unstaged.env",
        "ignored-untracked.env",
        "",
      ].join("\n"),
      "utf8",
    );
    execFileSync("git", ["add", ".gitignore"], { cwd: workspace });
    execFileSync("git", ["commit", "-m", "ignore secrets"], {
      cwd: workspace,
    });
    await writeFile(join(workspace, "tracked.txt"), "visible unstaged\n");
    await writeFile(join(workspace, "visible-staged.txt"), "visible staged\n");
    await writeFile(
      join(workspace, "secret-staged.env"),
      "STAGED_SECRET=leaked\n",
      "utf8",
    );
    await writeFile(
      join(workspace, "secret-unstaged.env"),
      "UNSTAGED_SECRET=leaked\n",
      "utf8",
    );
    await writeFile(
      join(workspace, "ignored-untracked.env"),
      "UNTRACKED_SECRET=leaked\n",
      "utf8",
    );
    execFileSync("git", ["add", "visible-staged.txt", "secret-staged.env"], {
      cwd: workspace,
    });

    try {
      // When
      const result = await executeToolCall({
        workspace,
        signal: freshSignal(),
        allowBash: false,
        toolCall: {
          id: "visible_diff",
          tool: "git_diff",
          mode: "all",
        },
      });

      // Then
      expect(result.ok).toBe(true);
      expect(result.content).toContain(
        "diff --git a/tracked.txt b/tracked.txt",
      );
      expect(result.content).toContain("+visible unstaged");
      expect(result.content).toContain(
        "diff --git a/visible-staged.txt b/visible-staged.txt",
      );
      expect(result.content).toContain("+visible staged");
      expect(result.content).not.toContain("secret-staged.env");
      expect(result.content).not.toContain("secret-unstaged.env");
      expect(result.content).not.toContain("ignored-untracked.env");
      expect(result.content).not.toContain("STAGED_SECRET");
      expect(result.content).not.toContain("UNSTAGED_SECRET");
      expect(result.content).not.toContain("UNTRACKED_SECRET");

      const ignoredPathResult = await executeToolCall({
        workspace,
        signal: freshSignal(),
        allowBash: false,
        toolCall: {
          id: "ignored_path_diff",
          tool: "git_diff",
          paths: ["secret-staged.env"],
        },
      });
      expect(ignoredPathResult.ok).toBe(false);
      expect(ignoredPathResult.content).toContain("ignored path");
      expect(ignoredPathResult.content).not.toContain("STAGED_SECRET");

      const missingPathResult = await executeToolCall({
        workspace,
        signal: freshSignal(),
        allowBash: false,
        toolCall: {
          id: "missing_path_diff",
          tool: "git_diff",
          paths: ["missing.txt"],
        },
      });
      expect(missingPathResult.ok).toBe(true);
      expect(missingPathResult.content).toBe("No git changes found.");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a tracked rename has an ignored source path,
    When git_diff inspects visible staged changes,
    Then it hides the whole rename instead of exposing the visible target as a new file`, async () => {
    // Given
    const workspace = await createGitWorkspace("keel-git-diff-ignored-rename-");
    await writeFile(join(workspace, "secret.env"), "TOKEN=hidden\n", "utf8");
    execFileSync("git", ["add", "secret.env"], { cwd: workspace });
    execFileSync("git", ["commit", "-m", "track secret"], { cwd: workspace });
    await writeFile(join(workspace, ".gitignore"), "secret.env\n", "utf8");
    execFileSync("git", ["add", ".gitignore"], { cwd: workspace });
    execFileSync("git", ["commit", "-m", "ignore secret path"], {
      cwd: workspace,
    });
    execFileSync("git", ["mv", "secret.env", "visible.txt"], {
      cwd: workspace,
    });

    try {
      // When
      const result = await executeToolCall({
        workspace,
        signal: freshSignal(),
        allowBash: false,
        toolCall: {
          id: "hidden_source_rename_diff",
          tool: "git_diff",
          mode: "staged",
        },
      });

      // Then
      expect(result.ok).toBe(true);
      expect(result.content).toBe("No git changes found.");
      expect(result.content).not.toContain("secret.env");
      expect(result.content).not.toContain("visible.txt");
      expect(result.content).not.toContain("TOKEN=hidden");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a visible tracked filename contains pathspec metacharacters and an ignored rename exists,
    When git_diff reruns the staged diff for visible paths,
    Then it treats the visible filename literally and does not leak the ignored rename`, async () => {
    // Given
    const workspace = await createGitWorkspace(
      "keel-git-diff-literal-pathspec-",
    );
    await mkdir(join(workspace, "src"));
    await writeFile(
      join(workspace, "src", "*.txt"),
      "visible before\n",
      "utf8",
    );
    await writeFile(
      join(workspace, "src", "secret-old.txt"),
      "TOKEN=hidden\n",
      "utf8",
    );
    execFileSync("git", ["add", "src"], { cwd: workspace });
    execFileSync("git", ["commit", "-m", "track wildcard and secret"], {
      cwd: workspace,
    });
    await writeFile(join(workspace, ".gitignore"), "src/secret-old.txt\n");
    execFileSync("git", ["add", ".gitignore"], { cwd: workspace });
    execFileSync("git", ["commit", "-m", "ignore old secret path"], {
      cwd: workspace,
    });
    await writeFile(join(workspace, "src", "*.txt"), "visible after\n", "utf8");
    execFileSync("git", ["mv", "src/secret-old.txt", "src/secret-new.txt"], {
      cwd: workspace,
    });
    execFileSync("git", ["add", "src/*.txt"], { cwd: workspace });

    try {
      // When
      const result = await executeToolCall({
        workspace,
        signal: freshSignal(),
        allowBash: false,
        toolCall: {
          id: "literal_pathspec_diff",
          tool: "git_diff",
          mode: "staged",
        },
      });

      // Then
      expect(result.ok).toBe(true);
      expect(result.content).toContain("diff --git a/src/*.txt b/src/*.txt");
      expect(result.content).toContain("+visible after");
      expect(result.content).not.toContain("secret-old.txt");
      expect(result.content).not.toContain("secret-new.txt");
      expect(result.content).not.toContain("TOKEN=hidden");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a workspace is not a git repository,
    When git_diff inspects it,
    Then it returns a clear non-git result`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-git-diff-nongit-"));

    try {
      // When
      const result = await executeToolCall({
        workspace,
        signal: freshSignal(),
        allowBash: false,
        toolCall: {
          id: "nongit_diff",
          tool: "git_diff",
        },
      });

      // Then
      expect(result.ok).toBe(true);
      expect(result.content).toContain("Not in a git work tree.");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a diff output exceeds the tool cap,
    When git_diff captures the process output,
    Then it reports stdout truncation`, async () => {
    // Given
    const workspace = await createGitWorkspace("keel-git-diff-large-");
    await writeFile(
      join(workspace, "tracked.txt"),
      `head-sentinel\n${"large changed line\n".repeat(9000)}tail-sentinel\n`,
      "utf8",
    );

    try {
      // When
      const result = await executeToolCall({
        workspace,
        signal: freshSignal(),
        allowBash: false,
        toolCall: {
          id: "large_diff",
          tool: "git_diff",
          mode: "unstaged",
        },
      });

      // Then
      expect(result.ok).toBe(true);
      expect(result.content).toContain("[git_diff stdout truncated:");
      expect(result.content).toContain("head-sentinel");
      expect(result.content).not.toContain("tail-sentinel");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a large diff output remains below the tool cap,
    When git_diff captures the process output,
    Then it returns the complete diff without claiming truncation`, async () => {
    // Given
    const workspace = await createGitWorkspace("keel-git-diff-large-complete-");
    await writeFile(
      join(workspace, "tracked.txt"),
      `head-sentinel\n${"large changed line\n".repeat(1_000)}tail-sentinel\n`,
      "utf8",
    );

    try {
      // When
      const result = await executeToolCall({
        workspace,
        signal: freshSignal(),
        allowBash: false,
        toolCall: {
          id: "large_complete_diff",
          tool: "git_diff",
          mode: "unstaged",
        },
      });

      // Then
      expect(result.ok).toBe(true);
      expect(result.content).toContain(
        "diff --git a/tracked.txt b/tracked.txt",
      );
      expect(result.content).toContain("head-sentinel");
      expect(result.content).toContain("tail-sentinel");
      expect(result.content).not.toContain("[git_diff stdout truncated");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given more than the untracked diff display limit,
    When git_diff includes untracked files,
    Then it reports that the untracked list was truncated`, async () => {
    // Given
    const workspace = await createGitWorkspace("keel-git-diff-many-");
    for (let index = 0; index < 51; index += 1) {
      await writeFile(
        join(workspace, `untracked-${index}.txt`),
        `file ${index}\n`,
        "utf8",
      );
    }

    try {
      // When
      const result = await executeToolCall({
        workspace,
        signal: freshSignal(),
        allowBash: false,
        toolCall: {
          id: "many_untracked_diff",
          tool: "git_diff",
          mode: "unstaged",
        },
      });

      // Then
      expect(result.ok).toBe(true);
      expect(result.content).toContain(
        "[git_diff output truncated: showing first 50 untracked files.",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the untracked file list exactly reaches the display limit,
    When git_diff includes untracked files,
    Then it returns every untracked diff without claiming the list was truncated`, async () => {
    // Given
    const workspace = await createGitWorkspace(
      "keel-git-diff-exact-untracked-",
    );
    for (let index = 0; index < 50; index += 1) {
      await writeFile(
        join(workspace, `untracked-${index}.txt`),
        `file ${index}\n`,
        "utf8",
      );
    }

    try {
      // When
      const result = await executeToolCall({
        workspace,
        signal: freshSignal(),
        allowBash: false,
        toolCall: {
          id: "exact_untracked_diff",
          tool: "git_diff",
          mode: "unstaged",
        },
      });

      // Then
      expect(result.ok).toBe(true);
      expect(result.content).toContain("untracked-49.txt");
      expect(result.content).not.toContain("[git_diff output truncated");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the run is already aborted,
    When git_diff starts,
    Then it rejects with an aborted tool error`, async () => {
    // Given
    const workspace = await createGitWorkspace("keel-git-diff-aborted-");
    const controller = new AbortController();
    controller.abort();

    try {
      // When / Then
      await expect(
        executeGitDiff(workspace, { signal: controller.signal }),
      ).rejects.toMatchObject({
        code: "tool_aborted",
        message: "git_diff failed: command aborted",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given executable git diff helpers are configured,
    When git_diff reads current changes,
    Then external helpers are disabled before the diff runs`, async () => {
    // Given
    const workspace = await createGitWorkspace("keel-git-diff-helpers-");
    const helperFixture = await configureExecutableGitDiffHelpers(workspace);
    await writeFile(join(workspace, ".gitattributes"), "*.txt filter=keel\n");
    await writeFile(join(workspace, "tracked.txt"), "after helper\n", "utf8");

    try {
      // When
      const result = await executeToolCall({
        workspace,
        signal: freshSignal(),
        allowBash: false,
        toolCall: {
          id: "safe_diff",
          tool: "git_diff",
          mode: "unstaged",
        },
      });

      // Then
      expect(result.ok).toBe(true);
      expect(result.content).toContain("+after helper");
      expect(existsSync(helperFixture.marker)).toBe(false);
    } finally {
      helperFixture.restore();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given executable git diff helpers are configured,
    When git_diff compares committed refs,
    Then external helpers are disabled before the diff runs`, async () => {
    // Given
    const workspace = await createGitWorkspace("keel-git-diff-ref-helpers-");
    await writeFile(join(workspace, "tracked.txt"), "after helper\n", "utf8");
    execFileSync("git", ["add", "tracked.txt"], { cwd: workspace });
    execFileSync("git", ["commit", "-m", "update tracked"], {
      cwd: workspace,
    });

    const helperFixture = await configureExecutableGitDiffHelpers(workspace);

    try {
      // When
      const result = await executeToolCall({
        workspace,
        signal: freshSignal(),
        allowBash: false,
        toolCall: {
          id: "safe_ref_diff",
          tool: "git_diff",
          baseRef: "HEAD~1",
          headRef: "HEAD",
        },
      });

      // Then
      expect(result.ok).toBe(true);
      expect(result.content).toContain("+after helper");
      expect(existsSync(helperFixture.marker)).toBe(false);
    } finally {
      helperFixture.restore();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a ref comparison tries to pass options ranges or blob specs,
    When git_diff validates the refs,
    Then it reports a recoverable tool failure before running git`, async () => {
    // Given
    const workspace = await createGitWorkspace("keel-git-diff-unsafe-ref-");
    const unsafeRefs = [
      "--output=leak.diff",
      "/tmp/not-a-ref",
      "bad ref",
      "bad\0ref",
      "HEAD..HEAD",
      "HEAD:tracked.txt",
    ];

    try {
      for (const baseRef of unsafeRefs) {
        // When
        const result = await executeToolCall({
          workspace,
          signal: freshSignal(),
          allowBash: false,
          toolCall: {
            id: "unsafe_ref_diff",
            tool: "git_diff",
            baseRef,
            headRef: "HEAD",
          },
        });

        // Then
        expect(result.ok).toBe(false);
        expect(result.content).toContain("Tool failed: git_diff failed");
        expect(result.content).toContain("unsafe git ref");
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a ref comparison names tree objects or revision peels,
    When git_diff resolves the refs,
    Then it rejects the comparison before diffing`, async () => {
    // Given
    const workspace = await createGitWorkspace("keel-git-diff-non-commit-ref-");
    const treeId = execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
      cwd: workspace,
      encoding: "utf8",
    }).trim();
    const nonCommitRefs = [
      { baseRef: "HEAD^{tree}", headRef: "HEAD" },
      { baseRef: treeId, headRef: "HEAD" },
      { baseRef: "HEAD", headRef: treeId },
    ];

    try {
      for (const toolCall of nonCommitRefs) {
        // When
        const result = await executeToolCall({
          workspace,
          signal: freshSignal(),
          allowBash: false,
          toolCall: {
            id: "non_commit_ref_diff",
            tool: "git_diff",
            ...toolCall,
          },
        });

        // Then
        expect(result.ok).toBe(false);
        expect(result.content).toContain("Tool failed: git_diff failed");
        expect(result.content).toContain("does not resolve to a commit");
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a merge-base ref comparison has unrelated histories,
    When git_diff compares the refs,
    Then it reports a recoverable no-common-ancestor failure`, async () => {
    // Given
    const workspace = await createGitWorkspace(
      "keel-git-diff-unrelated-merge-base-",
    );
    const originalBranch = execFileSync("git", ["branch", "--show-current"], {
      cwd: workspace,
      encoding: "utf8",
    }).trim();
    execFileSync("git", ["checkout", "-q", "--orphan", "unrelated"], {
      cwd: workspace,
    });
    await writeFile(join(workspace, "tracked.txt"), "unrelated\n", "utf8");
    execFileSync("git", ["add", "tracked.txt"], { cwd: workspace });
    execFileSync("git", ["commit", "-m", "unrelated root"], {
      cwd: workspace,
    });

    try {
      // When
      const result = await executeToolCall({
        workspace,
        signal: freshSignal(),
        allowBash: false,
        toolCall: {
          id: "unrelated_merge_base_diff",
          tool: "git_diff",
          baseRef: originalBranch,
          headRef: "unrelated",
          mergeBase: true,
        },
      });

      // Then
      expect(result.ok).toBe(false);
      expect(result.content).toContain("Tool failed: git_diff failed");
      expect(result.content).toContain(
        `no common ancestor between ${originalBranch} and unrelated`,
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given current-change mode is combined with a ref comparison,
    When git_diff validates the options,
    Then it reports a recoverable tool failure before running git`, async () => {
    // Given
    const workspace = await createGitWorkspace("keel-git-diff-ref-mode-");

    try {
      // When
      const result = await executeToolCall({
        workspace,
        signal: freshSignal(),
        allowBash: false,
        toolCall: {
          id: "ref_mode_diff",
          tool: "git_diff",
          mode: "staged",
          baseRef: "HEAD~1",
          headRef: "HEAD",
        },
      });

      // Then
      expect(result.ok).toBe(false);
      expect(result.content).toContain("Tool failed: git_diff failed");
      expect(result.content).toContain(
        "ref comparison cannot be combined with mode",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given ref-only options are missing baseRef,
    When git_diff validates the options,
    Then it reports a recoverable tool failure before running git`, async () => {
    // Given
    const workspace = await createGitWorkspace("keel-git-diff-missing-base-");

    try {
      // When
      const headOnlyResult = await executeToolCall({
        workspace,
        signal: freshSignal(),
        allowBash: false,
        toolCall: {
          id: "head_without_base",
          tool: "git_diff",
          headRef: "HEAD",
        },
      });
      const mergeBaseOnlyResult = await executeToolCall({
        workspace,
        signal: freshSignal(),
        allowBash: false,
        toolCall: {
          id: "merge_base_without_base",
          tool: "git_diff",
          mergeBase: true,
        },
      });

      // Then
      expect(headOnlyResult.ok).toBe(false);
      expect(headOnlyResult.content).toContain("Tool failed: git_diff failed");
      expect(headOnlyResult.content).toContain("headRef requires baseRef");
      expect(mergeBaseOnlyResult.ok).toBe(false);
      expect(mergeBaseOnlyResult.content).toContain(
        "Tool failed: git_diff failed",
      );
      expect(mergeBaseOnlyResult.content).toContain(
        "mergeBase requires baseRef",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a path tries to escape the workspace or use pathspec magic,
    When git_diff validates the path filter,
    Then it reports a recoverable tool failure before running git`, async () => {
    // Given
    const workspace = await createGitWorkspace("keel-git-diff-path-");
    const invalidPaths = [
      ["../outside.txt"],
      [join(tmpdir(), "keel-git-diff-outside.txt")],
      [":(glob)*.txt"],
      ["bad\0path"],
    ];

    try {
      for (const paths of invalidPaths) {
        // When
        const result = await executeToolCall({
          workspace,
          signal: freshSignal(),
          allowBash: false,
          toolCall: {
            id: "unsafe_diff",
            tool: "git_diff",
            paths,
          },
        });

        // Then
        expect(result.ok).toBe(false);
        expect(result.content).toContain("Tool failed: git_diff failed");
        expect(result.content).toContain("outside the workspace");
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
