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
  test(`Given Keel applies a multi-file patch in a git workspace,
    When user runs the undo command,
    Then every patched file is restored as one batch`, async () => {
    // Given
    const workspace = await createGitWorkspace();
    await commitFile(workspace, "src.ts", "export const value = 1;\n");

    try {
      const patch = await runCli(["apply patch demo"], {
        cwd: workspace,
        env: { KEEL_PROVIDER: "fake" },
      });
      expect(patch.exitCode).toBe(0);
      expect(await readFile(join(workspace, "src.ts"), "utf8")).toBe(
        "export const value = 2;\n",
      );
      expect(await readFile(join(workspace, "docs", "note.md"), "utf8")).toBe(
        "patched\n",
      );

      // When
      const undo = await runCli(["/undo"], { cwd: workspace });

      // Then
      expect(undo.exitCode).toBe(0);
      expect(undo.stdout).toBe("Restored 2 files\n");
      expect(await readFile(join(workspace, "src.ts"), "utf8")).toBe(
        "export const value = 1;\n",
      );
      await expect(
        readFile(join(workspace, "docs", "note.md"), "utf8"),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given Keel deletes a file through apply_patch in a git workspace,
    When user runs the undo command,
    Then the deleted file is restored`, async () => {
    // Given
    const workspace = await createGitWorkspace();
    await commitFile(workspace, "obsolete.txt", "obsolete\n");

    try {
      const patch = await runCli(["remove obsolete.txt"], {
        cwd: workspace,
        env: { KEEL_PROVIDER: "fake" },
      });
      expect(patch.exitCode).toBe(0);
      await expect(
        readFile(join(workspace, "obsolete.txt"), "utf8"),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });

      // When
      const undo = await runCli(["/undo"], { cwd: workspace });

      // Then
      expect(undo.exitCode).toBe(0);
      expect(undo.stdout).toBe("Restored obsolete.txt\n");
      expect(await readFile(join(workspace, "obsolete.txt"), "utf8")).toBe(
        "obsolete\n",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given Keel moves a file through apply_patch in a git workspace,
    When user runs the undo command,
    Then the original path is restored and the moved path is removed`, async () => {
    // Given
    const workspace = await createGitWorkspace();
    await commitFile(workspace, "old.txt", "old\n");

    try {
      const patch = await runCli(["move old.txt to new.txt"], {
        cwd: workspace,
        env: { KEEL_PROVIDER: "fake" },
      });
      expect(patch.exitCode).toBe(0);
      await expect(
        readFile(join(workspace, "old.txt"), "utf8"),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await readFile(join(workspace, "new.txt"), "utf8")).toBe("old\n");

      // When
      const undo = await runCli(["/undo"], { cwd: workspace });

      // Then
      expect(undo.exitCode).toBe(0);
      expect(undo.stdout).toBe("Restored 2 files\n");
      expect(await readFile(join(workspace, "old.txt"), "utf8")).toBe("old\n");
      await expect(
        readFile(join(workspace, "new.txt"), "utf8"),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
