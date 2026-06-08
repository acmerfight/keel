import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const CLI_PATH = join(import.meta.dirname, "../../src/cli/index.ts");

interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

function runCommand(
  command: string,
  args: readonly string[],
  cwd: string,
  env: Record<string, string> = {},
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = execFile(
      command,
      [...args],
      {
        cwd,
        env: { ...process.env, ...env },
        timeout: 5000,
      },
      (error, stdout, stderr) => {
        resolve({
          stdout,
          stderr,
          exitCode: error?.code ? Number(error.code) : (child.exitCode ?? 0),
        });
      },
    );
  });
}

function runCli(
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly env?: Record<string, string>;
  },
): Promise<CommandResult> {
  return runCommand(
    "node",
    ["--experimental-strip-types", CLI_PATH, ...args],
    options.cwd,
    options.env,
  );
}

async function git(
  cwd: string,
  args: readonly string[],
): Promise<CommandResult> {
  return await runCommand("git", args, cwd);
}

async function createGitWorkspace(): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "keel-cli-undo-"));
  await git(workspace, ["init"]);
  await git(workspace, ["config", "user.name", "Keel Test"]);
  await git(workspace, ["config", "user.email", "keel@example.com"]);
  return workspace;
}

async function commitFile(
  workspace: string,
  path: string,
  content: string,
): Promise<void> {
  await writeFile(join(workspace, path), content, "utf8");
  await git(workspace, ["add", path]);
  await git(workspace, ["commit", "-m", `add ${path}`]);
}

describe("CLI Undo", () => {
  test(`Given a git workspace file is edited by Keel,
    When user runs the undo command,
    Then the file is restored to its pre-edit content`, async () => {
    // Given
    const workspace = await createGitWorkspace();
    await commitFile(workspace, "note.txt", "hello old world\n");

    try {
      const edit = await runCli(["replace old with new in note.txt"], {
        cwd: workspace,
        env: { KEEL_PROVIDER: "fake" },
      });
      expect(edit.exitCode).toBe(0);
      expect(await readFile(join(workspace, "note.txt"), "utf8")).toBe(
        "hello new world\n",
      );

      // When
      const undo = await runCli(["/undo"], { cwd: workspace });

      // Then
      expect(undo.exitCode).toBe(0);
      expect(undo.stdout).toBe("Restored note.txt\n");
      expect(undo.stderr).toBe("");
      expect(await readFile(join(workspace, "note.txt"), "utf8")).toBe(
        "hello old world\n",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given Keel edited a file and the user changed that file afterwards,
    When user runs the undo command,
    Then the CLI refuses to overwrite the user's later change`, async () => {
    // Given
    const workspace = await createGitWorkspace();
    const filePath = join(workspace, "note.txt");
    await commitFile(workspace, "note.txt", "hello old world\n");
    const edit = await runCli(["replace old with new in note.txt"], {
      cwd: workspace,
      env: { KEEL_PROVIDER: "fake" },
    });
    expect(edit.exitCode).toBe(0);
    await writeFile(filePath, "user change\n", "utf8");

    try {
      // When
      const undo = await runCli(["/undo"], { cwd: workspace });

      // Then
      expect(undo.exitCode).not.toBe(0);
      expect(undo.stdout).toBe("");
      expect(undo.stderr).toContain("Refusing to overwrite user changes");
      expect(await readFile(filePath, "utf8")).toBe("user change\n");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given Keel edited an existing untracked file,
    When user runs the undo command,
    Then the untracked file content is restored and remains untracked`, async () => {
    // Given
    const workspace = await createGitWorkspace();
    await commitFile(workspace, "tracked.txt", "tracked\n");
    await writeFile(join(workspace, "note.txt"), "hello old world\n", "utf8");

    try {
      const edit = await runCli(["replace old with new in note.txt"], {
        cwd: workspace,
        env: { KEEL_PROVIDER: "fake" },
      });
      expect(edit.exitCode).toBe(0);

      // When
      const undo = await runCli(["/undo"], { cwd: workspace });

      // Then
      expect(undo.exitCode).toBe(0);
      expect(await readFile(join(workspace, "note.txt"), "utf8")).toBe(
        "hello old world\n",
      );
      expect(
        (await git(workspace, ["status", "--porcelain", "--", "note.txt"]))
          .stdout,
      ).toBe("?? note.txt\n");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the user's git index has staged changes,
    When Keel edits and undoes a different file,
    Then the staged changes are preserved`, async () => {
    // Given
    const workspace = await createGitWorkspace();
    await commitFile(workspace, "note.txt", "hello old world\n");
    await writeFile(join(workspace, "staged.txt"), "base\n", "utf8");
    await git(workspace, ["add", "staged.txt"]);
    await git(workspace, ["commit", "-m", "add staged"]);
    await writeFile(join(workspace, "staged.txt"), "staged change\n", "utf8");
    await git(workspace, ["add", "staged.txt"]);

    try {
      const edit = await runCli(["replace old with new in note.txt"], {
        cwd: workspace,
        env: { KEEL_PROVIDER: "fake" },
      });
      expect(edit.exitCode).toBe(0);

      // When
      const undo = await runCli(["/undo"], { cwd: workspace });

      // Then
      expect(undo.exitCode).toBe(0);
      expect(await readFile(join(workspace, "note.txt"), "utf8")).toBe(
        "hello old world\n",
      );
      expect(
        (await git(workspace, ["diff", "--cached", "--", "staged.txt"])).stdout,
      ).toContain("+staged change");
      expect(
        (await git(workspace, ["diff", "--cached", "--", "note.txt"])).stdout,
      ).toBe("");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given no Keel checkpoint exists,
    When user runs the undo command,
    Then the CLI reports that there is nothing to undo without requiring a provider`, async () => {
    // Given
    const workspace = await createGitWorkspace();

    try {
      // When
      const undo = await runCli(["/undo"], {
        cwd: workspace,
        env: {
          KEEL_PROVIDER: "deepseek",
          DEEPSEEK_API_KEY: "",
        },
      });

      // Then
      expect(undo.exitCode).not.toBe(0);
      expect(undo.stdout).toBe("");
      expect(undo.stderr).toBe("Nothing to undo.\n");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an edit request fails before writing a file,
    When user runs the undo command,
    Then no checkpoint is consumed and the original file remains unchanged`, async () => {
    // Given
    const workspace = await createGitWorkspace();
    await commitFile(workspace, "note.txt", "hello old world\n");

    try {
      const edit = await runCli(["replace missing with new in note.txt"], {
        cwd: workspace,
        env: { KEEL_PROVIDER: "fake" },
      });
      expect(edit.exitCode).not.toBe(0);

      // When
      const undo = await runCli(["/undo"], { cwd: workspace });

      // Then
      expect(undo.exitCode).not.toBe(0);
      expect(undo.stderr).toBe("Nothing to undo.\n");
      expect(await readFile(join(workspace, "note.txt"), "utf8")).toBe(
        "hello old world\n",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given Keel successfully edits two files in separate runs,
    When user runs the undo command once,
    Then only the latest Keel edit is restored`, async () => {
    // Given
    const workspace = await createGitWorkspace();
    await commitFile(workspace, "first.txt", "first old\n");
    await commitFile(workspace, "second.txt", "second old\n");

    try {
      const firstEdit = await runCli(["replace old with new in first.txt"], {
        cwd: workspace,
        env: { KEEL_PROVIDER: "fake" },
      });
      expect(firstEdit.exitCode).toBe(0);
      const secondEdit = await runCli(["replace old with new in second.txt"], {
        cwd: workspace,
        env: { KEEL_PROVIDER: "fake" },
      });
      expect(secondEdit.exitCode).toBe(0);

      // When
      const undo = await runCli(["/undo"], { cwd: workspace });

      // Then
      expect(undo.exitCode).toBe(0);
      expect(await readFile(join(workspace, "first.txt"), "utf8")).toBe(
        "first new\n",
      );
      expect(await readFile(join(workspace, "second.txt"), "utf8")).toBe(
        "second old\n",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
