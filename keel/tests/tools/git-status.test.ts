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

async function createGitWorkspace(
  prefix: string,
  options: { readonly objectFormat?: "sha256" } = {},
): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), prefix));
  execFileSync(
    "git",
    [
      "init",
      "--quiet",
      "--initial-branch=main",
      ...(options.objectFormat === undefined
        ? []
        : [`--object-format=${options.objectFormat}`]),
    ],
    { cwd: workspace },
  );
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
  const statusOutputPath = join(bin, "status-output");
  const quotedStatusOutputPath = `'${statusOutputPath.replaceAll("'", "'\\''")}'`;
  await writeFile(
    statusOutputPath,
    options.statusOutput + "x".repeat(options.extraOutputBytes ?? 0),
    "utf8",
  );
  await writeFile(
    fakeGitPath,
    `#!/bin/sh
while [ "$1" = "--no-pager" ] || [ "$1" = "--no-optional-locks" ] || [ "$1" = "-c" ]; do
  if [ "$1" = "-c" ]; then
    shift 2
  else
    shift
  fi
done
if [ "$1" = "rev-parse" ]; then
  case " $* " in
    *" --show-toplevel "*)
      /bin/pwd -P
      exit 0
      ;;
  esac
  printf 'true\\n'
  exit 0
fi
if [ "$1" = "status" ]; then
  /bin/cat ${quotedStatusOutputPath}
  exit $?
fi
printf 'unexpected fake git command: %s\\n' "$*" >&2
exit 2
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
        bash: { kind: "disabled" },
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
        bash: { kind: "disabled" },
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

  test(`Given a SHA-256 repository has a tracked change,
    When git_status inspects real porcelain-v2 metadata,
    Then it accepts the repository object format`, async () => {
    // Given
    const workspace = await createGitWorkspace("keel-git-status-sha256-", {
      objectFormat: "sha256",
    });
    await writeFile(join(workspace, "tracked.txt"), "after\n", "utf8");

    try {
      // When
      const result = await executeToolCall({
        workspace,
        signal: freshSignal(),
        bash: { kind: "disabled" },
        toolCall: {
          id: "sha256_status",
          tool: "git_status",
        },
      });

      // Then
      expect(result.ok).toBe(true);
      expect(result.content).toContain("Branch: main");
      expect(result.content).toContain("- M tracked.txt");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given git returns a complete malformed porcelain record,
    When git_status inspects the workspace,
    Then it fails instead of silently reporting a clean working tree`, async () => {
    // Given
    const statusOutput = ["# branch.head main", "1 M.", ""].join("\0");

    await withFakeGitStatusOutput({ statusOutput }, async (workspace) => {
      // When
      const result = await executeToolCall({
        workspace,
        signal: freshSignal(),
        bash: { kind: "disabled" },
        toolCall: {
          id: "malformed_status",
          tool: "git_status",
        },
      });

      // Then
      expect(result.ok).toBe(false);
      expect(result.content).toContain(
        "git_status failed: git status returned malformed output",
      );
      expect(result.content).not.toContain("No git changes found.");
    });
  });

  const firstOid = "1".repeat(40);
  const secondOid = "2".repeat(40);
  const thirdOid = "3".repeat(40);
  const malformedStatusScenarios = [
    [
      "ordinary mode",
      [
        "# branch.head main",
        `1 M. N... invalid 100644 100644 ${firstOid} ${secondOid} tracked.txt`,
        "",
      ].join("\0"),
    ],
    [
      "ordinary path",
      [
        "# branch.head main",
        `1 M. N... 100644 100644 100644 ${firstOid} ${secondOid} `,
        "",
      ].join("\0"),
    ],
    [
      "ordinary conflict status",
      [
        "# branch.head main",
        `1 DD N... 100644 100644 100644 ${firstOid} ${secondOid} conflict.txt`,
        "",
      ].join("\0"),
    ],
    [
      "mixed object IDs within a record",
      [
        "# branch.head main",
        `1 M. N... 100644 100644 100644 ${firstOid} ${"2".repeat(64)} tracked.txt`,
        "",
      ].join("\0"),
    ],
    [
      "mixed object IDs across records",
      [
        "# branch.head main",
        `1 M. N... 100644 100644 100644 ${firstOid} ${secondOid} first.txt`,
        `1 .M N... 100644 100644 100644 ${"3".repeat(64)} ${"4".repeat(64)} second.txt`,
        "",
      ].join("\0"),
    ],
    [
      "rename score",
      [
        "# branch.head main",
        `2 R. N... 100644 100644 100644 ${firstOid} ${secondOid} invalid renamed.txt`,
        "original.txt",
        "",
      ].join("\0"),
    ],
    [
      "rename conflict status",
      [
        "# branch.head main",
        `2 RR N... 100644 100644 100644 ${firstOid} ${secondOid} R100 renamed.txt`,
        "original.txt",
        "",
      ].join("\0"),
    ],
    [
      "rename score kind",
      [
        "# branch.head main",
        `2 R. N... 100644 100644 100644 ${firstOid} ${secondOid} C75 renamed.txt`,
        "original.txt",
        "",
      ].join("\0"),
    ],
    [
      "rename source",
      [
        "# branch.head main",
        `2 R. N... 100644 100644 100644 ${firstOid} ${secondOid} R100 renamed.txt`,
        "",
      ].join("\0"),
    ],
    [
      "rename source path",
      [
        "# branch.head main",
        `2 R. N... 100644 100644 100644 ${firstOid} ${secondOid} R100 renamed.txt`,
        "../original.txt",
        "",
      ].join("\0"),
    ],
    [
      "rename target",
      [
        "# branch.head main",
        `2 R. N... 100644 100644 100644 ${firstOid} ${secondOid} R100 `,
        "original.txt",
        "",
      ].join("\0"),
    ],
    [
      "unmerged fields",
      [
        "# branch.head main",
        `u UU N... 100644 100644 100644 invalid ${firstOid} ${secondOid} ${thirdOid} conflict.txt`,
        "",
      ].join("\0"),
    ],
    [
      "unmerged path",
      [
        "# branch.head main",
        `u UU N... 100644 100644 100644 100644 ${firstOid} ${secondOid} ${thirdOid} `,
        "",
      ].join("\0"),
    ],
    ["untracked path", ["# branch.head main", "? ", ""].join("\0")],
    [
      "parent-relative path",
      ["# branch.head main", "? ../outside.txt", ""].join("\0"),
    ],
    ["absolute path", ["# branch.head main", "? /outside.txt", ""].join("\0")],
    ["branch head", ["# branch.head", ""].join("\0")],
    [
      "branch upstream",
      ["# branch.head main", "# branch.upstream", ""].join("\0"),
    ],
    [
      "ahead behind",
      ["# branch.head main", "# branch.ab +1 invalid", ""].join("\0"),
    ],
    ["empty stream", "\0"],
    ["terminator", "# branch.head main\0? note.txt"],
    ["interior empty record", "# branch.head main\0\0? note.txt\0"],
    [
      "unknown entry kind",
      ["# branch.head main", "x unsupported", ""].join("\0"),
    ],
    ["missing branch head", ["? note.txt", ""].join("\0")],
  ] satisfies readonly (readonly [string, string])[];

  test.each(malformedStatusScenarios)(`Given complete porcelain %s is malformed,
    When git_status parses the external status stream,
    Then it fails through the recoverable contract`, async (scenario, statusOutput) => {
    // Given
    await withFakeGitStatusOutput({ statusOutput }, async (workspace) => {
      // When
      const result = await executeToolCall({
        workspace,
        signal: freshSignal(),
        bash: { kind: "disabled" },
        toolCall: {
          id: `malformed_status_${scenario}`,
          tool: "git_status",
        },
      });

      // Then
      expect(result.ok, scenario).toBe(false);
      expect(result.content, scenario).toContain(
        "git_status failed: git status returned malformed output",
      );
    });
  });

  test(`Given producer truncation cuts a rename pair after complete earlier records,
    When git_status parses the bounded stream,
    Then it keeps completed entries and reports truncation without accepting the partial rename`, async () => {
    // Given
    const oid = "1".repeat(40);
    const statusOutput = [
      "# branch.head main",
      "? visible.txt",
      `2 R. N... 100644 100644 100644 ${oid} ${oid} R100 renamed.txt`,
      "",
    ].join("\0");

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
          bash: { kind: "disabled" },
          toolCall: {
            id: "truncated_rename_status",
            tool: "git_status",
          },
        });

        // Then
        expect(result.ok).toBe(true);
        expect(result.sourceTruncated).toBe(true);
        expect(result.content).toContain("- visible.txt");
        expect(result.content).not.toContain("renamed.txt");
        expect(result.content).toContain(
          `[git_status output truncated: git status exceeded ${GIT_ARTIFACT_OUTPUT_MAX_BYTES} bytes before parsing completed. Use paths to narrow output.]`,
        );
      },
    );
  });

  test(`Given producer truncation follows a completed malformed rename record,
    When git_status parses the bounded stream,
    Then it rejects the completed metadata before tolerating the partial source path`, async () => {
    // Given
    const oid = "1".repeat(40);
    const statusOutput = [
      "# branch.head main",
      `2 RR N... 100644 100644 100644 ${oid} ${oid} R100 renamed.txt`,
      "",
    ].join("\0");

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
          bash: { kind: "disabled" },
          toolCall: {
            id: "truncated_malformed_rename_status",
            tool: "git_status",
          },
        });

        // Then
        expect(result.ok).toBe(false);
        expect(result.content).toContain(
          "git_status failed: git status returned malformed output",
        );
      },
    );
  });

  test(`Given producer truncation occurs before the first complete record,
    When git_status parses the bounded stream,
    Then it reports unknown branch metadata without claiming the workspace is clean`, async () => {
    // Given
    await withFakeGitStatusOutput(
      {
        statusOutput: "",
        extraOutputBytes: GIT_ARTIFACT_OUTPUT_MAX_BYTES + 1,
      },
      async (workspace) => {
        // When
        const result = await executeToolCall({
          workspace,
          signal: freshSignal(),
          bash: { kind: "disabled" },
          toolCall: {
            id: "truncated_before_status_record",
            tool: "git_status",
          },
        });

        // Then
        expect(result.ok).toBe(true);
        expect(result.sourceTruncated).toBe(true);
        expect(result.content).toContain("Branch: unknown");
        expect(result.content).toContain(
          `[git_status output truncated: git status exceeded ${GIT_ARTIFACT_OUTPUT_MAX_BYTES} bytes before parsing completed. Use paths to narrow output.]`,
        );
        expect(result.content).not.toContain("No git changes found.");
      },
    );
  });

  test(`Given a producer-truncated stream contains a completed empty record,
    When git_status parses the bounded stream,
    Then it rejects the malformed record instead of treating it as missing metadata`, async () => {
    // Given
    await withFakeGitStatusOutput(
      {
        statusOutput: "\0",
        extraOutputBytes: GIT_ARTIFACT_OUTPUT_MAX_BYTES + 1,
      },
      async (workspace) => {
        // When
        const result = await executeToolCall({
          workspace,
          signal: freshSignal(),
          bash: { kind: "disabled" },
          toolCall: {
            id: "truncated_empty_status_record",
            tool: "git_status",
          },
        });

        // Then
        expect(result.ok).toBe(false);
        expect(result.content).toContain(
          "git_status failed: git status returned malformed output",
        );
      },
    );
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
        bash: { kind: "disabled" },
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
        bash: { kind: "disabled" },
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
        bash: { kind: "disabled" },
        toolCall: {
          id: "subdir_dot_status",
          tool: "git_status",
          paths: ["."],
        },
      });
      const nestedResult = await executeToolCall({
        workspace: join(workspace, "src"),
        signal: freshSignal(),
        bash: { kind: "disabled" },
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
        bash: { kind: "disabled" },
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
        bash: { kind: "disabled" },
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

  test(`Given porcelain records contain spaced paths and a status-looking rename source,
    When git_status consumes the paired rename record,
    Then it preserves every path and does not parse the source as another entry`, async () => {
    // Given
    const statusOutput = [
      "# branch.head main",
      "1 M. N... 100644 100644 100644 1111111111111111111111111111111111111111 2222222222222222222222222222222222222222 ordinary  path.txt",
      "2 R. N... 100644 100644 100644 1111111111111111111111111111111111111111 2222222222222222222222222222222222222222 R75 renamed target.txt",
      "? old name.txt",
      "u UU N... 100644 100644 100644 100644 1111111111111111111111111111111111111111 2222222222222222222222222222222222222222 3333333333333333333333333333333333333333 conflict  path.txt",
      "? later file.txt",
      "",
    ].join("\0");

    await withFakeGitStatusOutput({ statusOutput }, async (workspace) => {
      // When
      const result = await executeToolCall({
        workspace,
        signal: freshSignal(),
        bash: { kind: "disabled" },
        toolCall: {
          id: "spaced_rename_status",
          tool: "git_status",
        },
      });

      // Then
      expect(result.ok).toBe(true);
      expect(result.content).toBe(
        [
          "Branch: main",
          "Staged changes:\n- M ordinary  path.txt\n- R ? old name.txt -> renamed target.txt",
          "Unmerged paths:\n- UU conflict  path.txt",
          "Untracked files:\n- later file.txt",
        ].join("\n\n"),
      );
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
        bash: { kind: "disabled" },
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
        bash: { kind: "disabled" },
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
        bash: { kind: "disabled" },
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
        bash: { kind: "disabled" },
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
        bash: { kind: "disabled" },
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
          bash: { kind: "disabled" },
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
          bash: { kind: "disabled" },
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
