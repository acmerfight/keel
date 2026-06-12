import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  commitFile,
  createGitWorkspace,
  runCli,
  runGit,
} from "../../src/testing/cli-harness.ts";

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
        (await runGit(workspace, ["status", "--porcelain", "--", "note.txt"]))
          .stdout,
      ).toBe("?? note.txt\n");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given Keel created a new file in a git workspace,
    When user runs the undo command,
    Then the created file is removed`, async () => {
    // Given
    const workspace = await createGitWorkspace();

    try {
      const write = await runCli(["create config.json"], {
        cwd: workspace,
        env: { KEEL_PROVIDER: "fake" },
      });
      expect(write.exitCode).toBe(0);
      expect(await readFile(join(workspace, "config.json"), "utf8")).toBe(
        '{"created":true}\n',
      );

      // When
      const undo = await runCli(["/undo"], { cwd: workspace });

      // Then
      expect(undo.exitCode).toBe(0);
      expect(undo.stdout).toBe("Restored config.json\n");
      await expect(
        readFile(join(workspace, "config.json"), "utf8"),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
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
    await runGit(workspace, ["add", "staged.txt"]);
    await runGit(workspace, ["commit", "-m", "add staged"]);
    await writeFile(join(workspace, "staged.txt"), "staged change\n", "utf8");
    await runGit(workspace, ["add", "staged.txt"]);

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
        (await runGit(workspace, ["diff", "--cached", "--", "staged.txt"]))
          .stdout,
      ).toContain("+staged change");
      expect(
        (await runGit(workspace, ["diff", "--cached", "--", "note.txt"]))
          .stdout,
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
      expect(edit.exitCode).toBe(0);
      expect(edit.stdout).toContain("Tool failed:");
      expect(edit.stdout).not.toContain("Edited");

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
