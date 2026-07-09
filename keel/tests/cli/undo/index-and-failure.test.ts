import { describe, expect, test } from "vitest";
import {
  commitFile,
  createGitWorkspace,
  join,
  readFile,
  rm,
  runCli,
  runGit,
  writeFile,
} from "./fixtures.ts";

describe("CLI Undo", () => {
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
    Then the CLI reports the next actions without requiring a provider`, async () => {
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
      expect(undo.stderr).toBe(
        "No earlier checkpoints. Ask me to undo more, or use git to reset.\n",
      );
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
      expect(undo.stderr).toBe(
        "No earlier checkpoints. Ask me to undo more, or use git to reset.\n",
      );
      expect(await readFile(join(workspace, "note.txt"), "utf8")).toBe(
        "hello old world\n",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
