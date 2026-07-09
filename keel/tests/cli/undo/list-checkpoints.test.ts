import { describe, expect, test } from "vitest";
import {
  commitFile,
  createGitWorkspace,
  join,
  readFile,
  rm,
  runCli,
} from "./fixtures.ts";

describe("CLI Undo", () => {
  test(`Given fewer undo checkpoints exist than the requested list index,
    When user runs undo through that checkpoint,
    Then the CLI preserves the checkpoint and tells the user to list available checkpoints`, async () => {
    // Given
    const workspace = await createGitWorkspace();
    await commitFile(workspace, "note.txt", "old\n");

    try {
      const edit = await runCli(["replace old with new in note.txt"], {
        cwd: workspace,
        env: { KEEL_PROVIDER: "fake" },
      });
      expect(edit.exitCode).toBe(0);

      // When
      const undo = await runCli(["/undo", "--to", "2"], { cwd: workspace });

      // Then
      expect(undo.exitCode).not.toBe(0);
      expect(undo.stdout).toBe("");
      expect(undo.stderr).toBe(
        "No undo checkpoint 2. Run keel /undo --list to choose an available checkpoint.\n",
      );
      expect(await readFile(join(workspace, "note.txt"), "utf8")).toBe("new\n");
      const list = await runCli(["/undo", "--list"], { cwd: workspace });
      expect(list.exitCode).toBe(0);
      expect(list.stdout).toBe("Undo checkpoints:\n1. note.txt\n");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given Keel has multiple undo checkpoints,
    When user lists undo checkpoints,
    Then the CLI shows the remaining tasks newest first without restoring them`, async () => {
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
      const list = await runCli(["/undo", "--list"], { cwd: workspace });

      // Then
      expect(list.exitCode).toBe(0);
      expect(list.stderr).toBe("");
      expect(list.stdout).toBe(
        ["Undo checkpoints:", "1. second.txt", "2. first.txt", ""].join("\n"),
      );
      expect(await readFile(join(workspace, "first.txt"), "utf8")).toBe(
        "first new\n",
      );
      expect(await readFile(join(workspace, "second.txt"), "utf8")).toBe(
        "second new\n",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
