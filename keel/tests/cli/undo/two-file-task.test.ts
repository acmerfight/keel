import { describe, expect, test } from "vitest";
import {
  commitFile,
  createGitWorkspace,
  join,
  readFile,
  rm,
  runCli,
  runTwoFileEditTask,
  writeFile,
} from "./fixtures.ts";

describe("CLI Undo", () => {
  test(`Given one Keel task edits two files in separate tool calls,
    When user runs the undo command,
    Then both files are restored as one task checkpoint`, async () => {
    // Given
    const workspace = await createGitWorkspace();
    await commitFile(workspace, "first.txt", "first old\n");
    await commitFile(workspace, "second.txt", "second old\n");

    try {
      await runTwoFileEditTask(workspace);
      expect(await readFile(join(workspace, "first.txt"), "utf8")).toBe(
        "first new\n",
      );
      expect(await readFile(join(workspace, "second.txt"), "utf8")).toBe(
        "second new\n",
      );

      // When
      const undo = await runCli(["/undo"], { cwd: workspace });

      // Then
      expect(undo.exitCode).toBe(0);
      expect(undo.stdout).toBe("Restored 2 files\n");
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

  test(`Given one Keel task edited two files and the user changed one afterwards,
    When user runs the undo command,
    Then the CLI refuses to partially restore the task`, async () => {
    // Given
    const workspace = await createGitWorkspace();
    await commitFile(workspace, "first.txt", "first old\n");
    await commitFile(workspace, "second.txt", "second old\n");

    try {
      await runTwoFileEditTask(workspace);
      await writeFile(join(workspace, "first.txt"), "user change\n", "utf8");

      // When
      const undo = await runCli(["/undo"], { cwd: workspace });

      // Then
      expect(undo.exitCode).not.toBe(0);
      expect(undo.stdout).toBe("");
      expect(undo.stderr).toContain("Refusing to overwrite user changes");
      expect(await readFile(join(workspace, "first.txt"), "utf8")).toBe(
        "user change\n",
      );
      expect(await readFile(join(workspace, "second.txt"), "utf8")).toBe(
        "second new\n",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
