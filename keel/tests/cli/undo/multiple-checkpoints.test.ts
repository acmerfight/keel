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
  test(`Given Keel successfully edits two files in separate runs,
    When user runs the undo command twice,
    Then each task is restored in reverse order`, async () => {
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
      const secondUndo = await runCli(["/undo"], { cwd: workspace });
      const thirdUndo = await runCli(["/undo"], { cwd: workspace });

      // Then
      expect(undo.exitCode).toBe(0);
      expect(undo.stdout).toBe("Restored second.txt\n");
      expect(secondUndo.exitCode).toBe(0);
      expect(secondUndo.stdout).toBe("Restored first.txt\n");
      expect(thirdUndo.exitCode).not.toBe(0);
      expect(thirdUndo.stdout).toBe("");
      expect(thirdUndo.stderr).toBe(
        "No earlier checkpoints. Ask me to undo more, or use git to reset.\n",
      );
      expect(await readFile(join(workspace, "first.txt"), "utf8")).toBe(
        "first old\n",
      );
      expect(await readFile(join(workspace, "second.txt"), "utf8")).toBe(
        "second old\n",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given Keel successfully edits two files in separate runs,
    When user runs undo through the second listed checkpoint,
    Then both tasks are restored in one command`, async () => {
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
      const undo = await runCli(["/undo", "--to", "2"], { cwd: workspace });

      // Then
      expect(undo.exitCode).toBe(0);
      expect(undo.stdout).toBe("Restored 2 checkpoints\n");
      expect(undo.stderr).toBe("");
      expect(await readFile(join(workspace, "first.txt"), "utf8")).toBe(
        "first old\n",
      );
      expect(await readFile(join(workspace, "second.txt"), "utf8")).toBe(
        "second old\n",
      );
      const list = await runCli(["/undo", "--list"], { cwd: workspace });
      expect(list.exitCode).toBe(0);
      expect(list.stdout).toBe("No undo checkpoints.\n");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
