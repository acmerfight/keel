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
});
