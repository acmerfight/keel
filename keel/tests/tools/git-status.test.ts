import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { executeToolCall } from "../../src/tools/execution.ts";
import { GIT_ARTIFACT_OUTPUT_MAX_BYTES } from "../../src/tools/git-process.ts";

const PATH_ENV = "PATH";

function freshSignal(): AbortSignal {
  return new AbortController().signal;
}

async function createGitWorkspace(prefix: string): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), prefix));
  execFileSync("git", ["init", "--quiet", "--initial-branch=main"], {
    cwd: workspace,
  });
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

async function withFakeGitStatusOutput<T>(
  options: {
    readonly statusOutput: string;
    readonly extraOutputBytes?: number;
  },
  callback: (workspace: string) => Promise<T>,
): Promise<T> {
  const workspace = await mkdtemp(join(tmpdir(), "keel-git-status-fake-"));
  const bin = await mkdtemp(join(tmpdir(), "keel-fake-git-"));
  const fakeGitPath = join(bin, "git");
  await writeFile(
    fakeGitPath,
    `#!/usr/bin/env node
const { writeSync } = require("node:fs");
const statusOutput = ${JSON.stringify(options.statusOutput)};
const extraOutputBytes = ${options.extraOutputBytes ?? 0};
const args = process.argv.slice(2);
while (
  args[0] === "--no-pager" ||
  args[0] === "--no-optional-locks" ||
  args[0] === "-c"
) {
  if (args[0] === "-c") {
    args.splice(0, 2);
  } else {
    args.shift();
  }
}
if (args[0] === "rev-parse") {
  if (args.includes("--show-toplevel")) {
    writeSync(1, process.cwd() + "\\n");
    process.exit(0);
  }
  writeSync(1, "true\\n");
  process.exit(0);
}
if (args[0] === "status") {
  writeSync(1, statusOutput);
  if (extraOutputBytes > 0) {
    writeSync(1, "x".repeat(extraOutputBytes));
  }
  process.exit(0);
}
process.stderr.write(\`unexpected fake git command: \${args.join(" ")}\\n\`);
process.exit(2);
`,
    "utf8",
  );
  await chmod(fakeGitPath, 0o755);
  const originalPath = process.env[PATH_ENV];
  process.env[PATH_ENV] =
    originalPath === undefined ? bin : `${bin}:${originalPath}`;

  try {
    return await callback(workspace);
  } finally {
    if (originalPath === undefined) {
      delete process.env[PATH_ENV];
    } else {
      process.env[PATH_ENV] = originalPath;
    }
    await rm(bin, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
}

describe("git_status tool", () => {
  test(`Given staged unstaged and untracked changes,
    When git_status inspects the workspace with bash disabled,
    Then it returns a grouped status summary without shell approval`, async () => {
    // Given
    const workspace = await createGitWorkspace("keel-git-status-");
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
          id: "inspect_status",
          tool: "git_status",
        },
      });

      // Then
      expect(result.ok).toBe(true);
      expect(result.content).toContain("Branch: main");
      expect(result.content).toContain("Staged changes:");
      expect(result.content).toContain("- A staged.txt");
      expect(result.content).toContain("Unstaged changes:");
      expect(result.content).toContain("- M tracked.txt");
      expect(result.content).toContain("Untracked files:");
      expect(result.content).toContain("- untracked.txt");
      expect(result.content).not.toContain("[git_status output truncated");
      expect(result.content).not.toContain("Tool failed: bash failed");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given no current git changes,
    When git_status inspects the workspace,
    Then it reports that no changes were found`, async () => {
    // Given
    const workspace = await createGitWorkspace("keel-git-status-clean-");

    try {
      // When
      const result = await executeToolCall({
        workspace,
        signal: freshSignal(),
        allowBash: false,
        toolCall: {
          id: "clean_status",
          tool: "git_status",
        },
      });

      // Then
      expect(result.ok).toBe(true);
      expect(result.content).toBe("Branch: main\n\nNo git changes found.");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given current git changes in multiple directories,
    When git_status inspects a path filter,
    Then it reports only matching paths`, async () => {
    // Given
    const workspace = await createGitWorkspace("keel-git-status-paths-");
    await mkdir(join(workspace, "src"));
    await mkdir(join(workspace, "docs"));
    await writeFile(join(workspace, "src", "app.ts"), "app\n", "utf8");
    await writeFile(join(workspace, "docs", "guide.md"), "guide\n", "utf8");

    try {
      // When
      const result = await executeToolCall({
        workspace,
        signal: freshSignal(),
        allowBash: false,
        toolCall: {
          id: "path_status",
          tool: "git_status",
          paths: ["src"],
        },
      });

      // Then
      expect(result.ok).toBe(true);
      expect(result.content).toContain("Untracked files:");
      expect(result.content).toContain("- src/app.ts");
      expect(result.content).not.toContain("docs/guide.md");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the workspace is a git repository subdirectory,
    When git_status inspects current changes,
    Then it reports only changes inside that workspace`, async () => {
    // Given
    const workspace = await createGitWorkspace("keel-git-status-subdir-");
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

    try {
      // When
      const result = await executeToolCall({
        workspace: join(workspace, "src"),
        signal: freshSignal(),
        allowBash: false,
        toolCall: {
          id: "subdir_status",
          tool: "git_status",
        },
      });

      // Then
      expect(result.ok).toBe(true);
      expect(result.content).toContain("Unstaged changes:");
      expect(result.content).toContain("- M src/app.ts");
      expect(result.content).not.toContain("root.txt");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the workspace is a git repository subdirectory,
    When git_status inspects explicit workspace-relative path filters,
    Then it scopes each filter under the workspace`, async () => {
    // Given
    const workspace = await createGitWorkspace("keel-git-status-subdir-paths-");
    await mkdir(join(workspace, "src"));
    await mkdir(join(workspace, "src", "nested"));
    await writeFile(join(workspace, "src", "app.ts"), "before\n", "utf8");
    await writeFile(
      join(workspace, "src", "nested", "app.ts"),
      "before\n",
      "utf8",
    );
    execFileSync("git", ["add", "src/app.ts", "src/nested/app.ts"], {
      cwd: workspace,
    });
    execFileSync("git", ["commit", "-m", "add nested workspace files"], {
      cwd: workspace,
    });
    await writeFile(join(workspace, "src", "app.ts"), "after\n", "utf8");
    await writeFile(
      join(workspace, "src", "nested", "app.ts"),
      "after\n",
      "utf8",
    );

    try {
      // When
      const currentWorkspaceResult = await executeToolCall({
        workspace: join(workspace, "src"),
        signal: freshSignal(),
        allowBash: false,
        toolCall: {
          id: "subdir_dot_status",
          tool: "git_status",
          paths: ["."],
        },
      });
      const nestedResult = await executeToolCall({
        workspace: join(workspace, "src"),
        signal: freshSignal(),
        allowBash: false,
        toolCall: {
          id: "subdir_nested_status",
          tool: "git_status",
          paths: ["nested"],
        },
      });

      // Then
      expect(currentWorkspaceResult.ok).toBe(true);
      expect(currentWorkspaceResult.content).toContain("- M src/app.ts");
      expect(currentWorkspaceResult.content).toContain("- M src/nested/app.ts");
      expect(nestedResult.ok).toBe(true);
      expect(nestedResult.content).not.toContain("- M src/app.ts");
      expect(nestedResult.content).toContain("- M src/nested/app.ts");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given branch metadata includes upstream ahead and behind counts,
    When git_status inspects the workspace,
    Then it includes the branch relationship in the status summary`, async () => {
    // Given
    const statusOutput = [
      "# branch.head feature/status",
      "# branch.upstream origin/feature/status",
      "# branch.ab +2 -1",
      "? note.txt",
      "",
    ].join("\0");

    await withFakeGitStatusOutput({ statusOutput }, async (workspace) => {
      // When
      const result = await executeToolCall({
        workspace,
        signal: freshSignal(),
        allowBash: false,
        toolCall: {
          id: "branch_status",
          tool: "git_status",
        },
      });

      // Then
      expect(result.ok).toBe(true);
      expect(result.content).toContain(
        "Branch: feature/status (upstream: origin/feature/status; ahead 2, behind 1)",
      );
      expect(result.content).toContain("Untracked files:");
      expect(result.content).toContain("- note.txt");
    });
  });

  test(`Given git reports unmerged paths,
    When git_status inspects the workspace,
    Then it groups conflicts separately from staged and unstaged changes`, async () => {
    // Given
    const statusOutput = [
      "# branch.head main",
      "u UU N... 100644 100644 100644 100644 1111111111111111111111111111111111111111 2222222222222222222222222222222222222222 3333333333333333333333333333333333333333 conflict.txt",
      "",
    ].join("\0");

    await withFakeGitStatusOutput({ statusOutput }, async (workspace) => {
      // When
      const result = await executeToolCall({
        workspace,
        signal: freshSignal(),
        allowBash: false,
        toolCall: {
          id: "unmerged_status",
          tool: "git_status",
        },
      });

      // Then
      expect(result.ok).toBe(true);
      expect(result.content).toContain("Unmerged paths:");
      expect(result.content).toContain("- UU conflict.txt");
      expect(result.content).not.toContain("Staged changes:");
      expect(result.content).not.toContain("Unstaged changes:");
    });
  });

  test(`Given a visible tracked rename,
    When git_status inspects staged changes,
    Then it reports the source and target paths`, async () => {
    // Given
    const workspace = await createGitWorkspace("keel-git-status-rename-");
    execFileSync("git", ["mv", "tracked.txt", "renamed.txt"], {
      cwd: workspace,
    });

    try {
      // When
      const result = await executeToolCall({
        workspace,
        signal: freshSignal(),
        allowBash: false,
        toolCall: {
          id: "visible_rename_status",
          tool: "git_status",
        },
      });

      // Then
      expect(result.ok).toBe(true);
      expect(result.content).toContain("Staged changes:");
      expect(result.content).toContain("- R tracked.txt -> renamed.txt");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a tracked rename has an ignored source path,
    When git_status inspects visible staged changes,
    Then it hides the whole rename instead of exposing the visible target`, async () => {
    // Given
    const workspace = await createGitWorkspace("keel-git-status-ignored-");
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
          id: "hidden_source_rename_status",
          tool: "git_status",
        },
      });

      // Then
      expect(result.ok).toBe(true);
      expect(result.content).toBe("Branch: main\n\nNo git changes found.");
      expect(result.content).not.toContain("secret.env");
      expect(result.content).not.toContain("visible.txt");
      expect(result.content).not.toContain("TOKEN=hidden");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the git status output has more than the display limit,
    When git_status inspects untracked files,
    Then it reports that the status list was truncated`, async () => {
    // Given
    const workspace = await createGitWorkspace("keel-git-status-many-");
    for (let index = 0; index < 201; index += 1) {
      await writeFile(
        join(workspace, `untracked-${String(index).padStart(3, "0")}.txt`),
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
          id: "many_status",
          tool: "git_status",
        },
      });

      // Then
      expect(result.ok).toBe(true);
      expect(result.content).toContain(
        "[git_status output truncated: showing first 200 entries. Use paths to narrow output.]",
      );
      expect(result.content).not.toContain("untracked-200.txt");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the git status output exactly reaches the display limit,
    When git_status inspects untracked files,
    Then it returns every status entry without claiming truncation`, async () => {
    // Given
    const workspace = await createGitWorkspace("keel-git-status-exact-");
    for (let index = 0; index < 200; index += 1) {
      await writeFile(
        join(workspace, `untracked-${String(index).padStart(3, "0")}.txt`),
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
          id: "exact_status",
          tool: "git_status",
        },
      });

      // Then
      expect(result.ok).toBe(true);
      expect(result.content).toContain("untracked-199.txt");
      expect(result.content).not.toContain("[git_status output truncated");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the workspace is not a git repository,
    When git_status inspects the workspace,
    Then it returns recoverable guidance instead of running shell commands`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-git-status-none-"));

    try {
      // When
      const result = await executeToolCall({
        workspace,
        signal: freshSignal(),
        allowBash: false,
        toolCall: {
          id: "non_git_status",
          tool: "git_status",
        },
      });

      // Then
      expect(result.ok).toBe(true);
      expect(result.content).toBe(
        "Not in a git work tree. git_status can only inspect changes inside a Git repository.",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given git status exceeds the producer output cap,
    When git_status parses the captured status output,
    Then it marks the result source-truncated and tells the model to narrow paths`, async () => {
    // Given
    const statusOutput = ["# branch.head main", "? visible.txt", ""].join("\0");

    await withFakeGitStatusOutput(
      {
        statusOutput,
        extraOutputBytes: GIT_ARTIFACT_OUTPUT_MAX_BYTES + 1,
      },
      async (workspace) => {
        // When
        const result = await executeToolCall({
          workspace,
          signal: freshSignal(),
          allowBash: false,
          toolCall: {
            id: "producer_truncated_status",
            tool: "git_status",
          },
        });

        // Then
        expect(result.ok).toBe(true);
        expect(result.sourceTruncated).toBe(true);
        expect(result.content).toContain("Branch: main");
        expect(result.content).toContain("- visible.txt");
        expect(result.content).toContain(
          `[git_status output truncated: git status exceeded ${GIT_ARTIFACT_OUTPUT_MAX_BYTES} bytes before parsing completed. Use paths to narrow output.]`,
        );
        expect(result.content).not.toContain("No git changes found.");
      },
    );
  });

  test(`Given git status exceeds the producer output cap before any visible entry,
    When git_status formats the partial result,
    Then it does not report a clean working tree`, async () => {
    // Given
    const statusOutput = ["# branch.head main", ""].join("\0");

    await withFakeGitStatusOutput(
      {
        statusOutput,
        extraOutputBytes: GIT_ARTIFACT_OUTPUT_MAX_BYTES + 1,
      },
      async (workspace) => {
        // When
        const result = await executeToolCall({
          workspace,
          signal: freshSignal(),
          allowBash: false,
          toolCall: {
            id: "producer_truncated_empty_status",
            tool: "git_status",
          },
        });

        // Then
        expect(result.ok).toBe(true);
        expect(result.sourceTruncated).toBe(true);
        expect(result.content).toContain("Branch: main");
        expect(result.content).toContain(
          `[git_status output truncated: git status exceeded ${GIT_ARTIFACT_OUTPUT_MAX_BYTES} bytes before parsing completed. Use paths to narrow output.]`,
        );
        expect(result.content).not.toContain("No git changes found.");
      },
    );
  });
});
