import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import {
  listUndoCheckpoints,
  type RecordLastEditCheckpointOptions,
  recordLastBatchCheckpoint,
  recordLastCreateCheckpoint,
  recordLastDeleteCheckpoint,
  recordLastEditCheckpoint,
  recordLastTaskCheckpoint,
  restoreLastEditCheckpoint,
  restoreUndoCheckpointsThrough,
} from "../../src/core/git.ts";
import {
  createGitWorkspace,
  runGit as git,
} from "../../src/testing/cli-harness.ts";

const DEBUG_ENV_KEY = "KEEL_DEBUG";

async function checkpointPath(workspace: string): Promise<string> {
  const result = await git(workspace, [
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "keel/undo-checkpoints.json",
  ]);
  return result.stdout.trim();
}

async function writeRawCheckpoint(
  workspace: string,
  checkpoint: unknown,
): Promise<void> {
  const path = await checkpointPath(workspace);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    `${JSON.stringify({ version: 1, checkpoints: [checkpoint] })}\n`,
    "utf8",
  );
}

function recordUnownedEditCheckpoint(
  options: Omit<RecordLastEditCheckpointOptions, "modeOwnership">,
): ReturnType<typeof recordLastEditCheckpoint> {
  return recordLastEditCheckpoint({
    ...options,
    modeOwnership: { kind: "unowned" },
  });
}

describe("Git Checkpoints", () => {
  test(`Given a workspace is not a git repository,
    When recording and restoring an edit checkpoint,
    Then no checkpoint is written and there is nothing to undo`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-git-"));
    const filePath = join(workspace, "note.txt");
    await writeFile(filePath, "new\n", "utf8");

    try {
      // When
      const record = recordUnownedEditCheckpoint({
        workspace,
        filePath,
        beforeContent: "old\n",
        afterContent: "new\n",
      });
      const restore = restoreLastEditCheckpoint(workspace);
      const checkpoints = listUndoCheckpoints(workspace);

      // Then
      expect(record).toEqual({
        written: false,
        reason: "git_workspace_unavailable",
      });
      expect(checkpoints).toEqual([]);
      expect(restore).toEqual({
        status: "none",
        message:
          "No earlier checkpoints. Ask me to undo more, or use git to reset.",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a task checkpoint has no operations,
    When recording the checkpoint,
    Then no checkpoint is written`, async () => {
    // Given
    const workspace = await createGitWorkspace("keel-git-empty-task-");

    try {
      // When
      const result = recordLastTaskCheckpoint({
        workspace,
        operations: [],
      });
      const restore = restoreLastEditCheckpoint(workspace);

      // Then
      expect(result).toEqual({ written: false, reason: "no_changes" });
      expect(restore).toEqual({
        status: "none",
        message:
          "No earlier checkpoints. Ask me to undo more, or use git to reset.",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given more than twenty undo checkpoints are recorded,
    When listing undo checkpoints,
    Then only the newest twenty checkpoints remain newest first`, async () => {
    // Given
    const workspace = await createGitWorkspace("keel-git-undo-bound-");

    try {
      for (let index = 1; index <= 22; index++) {
        const fileName = `note-${index}.txt`;
        const filePath = join(workspace, fileName);
        await writeFile(filePath, `after ${index}\n`, "utf8");
        recordUnownedEditCheckpoint({
          workspace,
          filePath,
          beforeContent: `before ${index}\n`,
          afterContent: `after ${index}\n`,
        });
      }

      // When
      const checkpoints = listUndoCheckpoints(workspace);

      // Then
      expect(checkpoints).toHaveLength(20);
      expect(checkpoints[0]?.restoredLabel).toBe("note-22.txt");
      expect(checkpoints.at(-1)?.restoredLabel).toBe("note-3.txt");
      expect(
        checkpoints.map((checkpoint) => checkpoint.restoredLabel),
      ).not.toContain("note-2.txt");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given two consecutive edit checkpoints for the same file,
    When restoring through the second listed checkpoint,
    Then the file is restored to the oldest selected state atomically`, async () => {
    // Given
    const workspace = await createGitWorkspace("keel-git-undo-through-file-");
    const filePath = join(workspace, "note.txt");
    await writeFile(filePath, "middle\n", "utf8");
    recordUnownedEditCheckpoint({
      workspace,
      filePath,
      beforeContent: "before\n",
      afterContent: "middle\n",
    });
    await writeFile(filePath, "after\n", "utf8");
    recordUnownedEditCheckpoint({
      workspace,
      filePath,
      beforeContent: "middle\n",
      afterContent: "after\n",
    });

    try {
      // When
      const restore = restoreUndoCheckpointsThrough(workspace, 2);

      // Then
      expect(restore).toEqual({
        status: "restored",
        restoredLabel: "2 checkpoints",
      });
      expect(await readFile(filePath, "utf8")).toBe("before\n");
      expect(listUndoCheckpoints(workspace)).toEqual([]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given two consecutive edit checkpoints for the same file record modes,
    When restoring through the second listed checkpoint,
    Then the file is restored to the oldest selected content and mode`, async () => {
    // Given
    const workspace = await createGitWorkspace(
      "keel-git-undo-through-file-mode-",
    );
    const filePath = join(workspace, "tool.sh");
    await writeFile(filePath, "middle\n", "utf8");
    if (process.platform !== "win32") {
      await chmod(filePath, 0o755);
    }
    recordLastEditCheckpoint({
      workspace,
      filePath,
      beforeContent: "before\n",
      afterContent: "middle\n",
      modeOwnership: {
        kind: "owned",
        beforeMode: 0o644,
        afterMode: 0o755,
      },
    });
    await writeFile(filePath, "after\n", "utf8");
    if (process.platform !== "win32") {
      await chmod(filePath, 0o755);
    }
    recordLastEditCheckpoint({
      workspace,
      filePath,
      beforeContent: "middle\n",
      afterContent: "after\n",
      modeOwnership: {
        kind: "owned",
        beforeMode: 0o755,
        afterMode: 0o755,
      },
    });

    try {
      // When
      const restore = restoreUndoCheckpointsThrough(workspace, 2);

      // Then
      expect(restore).toEqual({
        status: "restored",
        restoredLabel: "2 checkpoints",
      });
      expect(await readFile(filePath, "utf8")).toBe("before\n");
      if (process.platform !== "win32") {
        expect((await stat(filePath)).mode & 0o777).toBe(0o644);
      }
      expect(listUndoCheckpoints(workspace)).toEqual([]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given selected edit checkpoints have matching content but discontinuous modes,
    When restoring through both checkpoints,
    Then restore blocks without consuming either checkpoint`, async () => {
    // Given
    const workspace = await createGitWorkspace(
      "keel-git-undo-through-file-mode-gap-",
    );
    const filePath = join(workspace, "tool.sh");
    await writeFile(filePath, "after\n", "utf8");
    if (process.platform !== "win32") {
      await chmod(filePath, 0o755);
    }
    recordLastEditCheckpoint({
      workspace,
      filePath,
      beforeContent: "before\n",
      afterContent: "middle\n",
      modeOwnership: {
        kind: "owned",
        beforeMode: 0o644,
        afterMode: 0o755,
      },
    });
    recordLastEditCheckpoint({
      workspace,
      filePath,
      beforeContent: "middle\n",
      afterContent: "after\n",
      modeOwnership: {
        kind: "owned",
        beforeMode: 0o644,
        afterMode: 0o755,
      },
    });

    try {
      // When
      const restore = restoreUndoCheckpointsThrough(workspace, 2);

      // Then
      expect(restore).toEqual({
        status: "blocked",
        filePath: "tool.sh",
        message: "Cannot undo tool.sh: Refusing to overwrite user changes.",
      });
      expect(await readFile(filePath, "utf8")).toBe("after\n");
      expect(listUndoCheckpoints(workspace)).toEqual([
        { restoredLabel: "tool.sh" },
        { restoredLabel: "tool.sh" },
      ]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given selected edit checkpoints have discontinuous content,
    When restoring through both checkpoints,
    Then restore blocks without consuming either checkpoint`, async () => {
    // Given
    const workspace = await createGitWorkspace(
      "keel-git-undo-through-file-content-gap-",
    );
    const filePath = join(workspace, "note.txt");
    await writeFile(filePath, "after\n", "utf8");
    recordUnownedEditCheckpoint({
      workspace,
      filePath,
      beforeContent: "before\n",
      afterContent: "middle\n",
    });
    recordUnownedEditCheckpoint({
      workspace,
      filePath,
      beforeContent: "different\n",
      afterContent: "after\n",
    });

    try {
      // When
      const restore = restoreUndoCheckpointsThrough(workspace, 2);

      // Then
      expect(restore).toEqual({
        status: "blocked",
        filePath: "note.txt",
        message: "Cannot undo note.txt: Refusing to overwrite user changes.",
      });
      expect(await readFile(filePath, "utf8")).toBe("after\n");
      expect(listUndoCheckpoints(workspace)).toEqual([
        { restoredLabel: "note.txt" },
        { restoredLabel: "note.txt" },
      ]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given fewer undo checkpoints exist than the requested list index,
    When restoring through that checkpoint index,
    Then no checkpoint is consumed and the user is told to list checkpoints`, async () => {
    // Given
    const workspace = await createGitWorkspace("keel-git-undo-through-range-");
    const filePath = join(workspace, "note.txt");
    await writeFile(filePath, "after\n", "utf8");
    recordUnownedEditCheckpoint({
      workspace,
      filePath,
      beforeContent: "before\n",
      afterContent: "after\n",
    });

    try {
      // When
      const restore = restoreUndoCheckpointsThrough(workspace, 2);

      // Then
      expect(restore).toEqual({
        status: "none",
        message:
          "No undo checkpoint 2. Run keel /undo --list to choose an available checkpoint.",
      });
      expect(await readFile(filePath, "utf8")).toBe("after\n");
      expect(listUndoCheckpoints(workspace)).toEqual([
        { restoredLabel: "note.txt" },
      ]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an invalid undo checkpoint index reaches core restore,
    When restoring through that index,
    Then the stack is preserved and the user is told to list checkpoints`, async () => {
    // Given
    const workspace = await createGitWorkspace(
      "keel-git-undo-through-invalid-index-",
    );
    const filePath = join(workspace, "note.txt");
    await writeFile(filePath, "after\n", "utf8");
    recordUnownedEditCheckpoint({
      workspace,
      filePath,
      beforeContent: "before\n",
      afterContent: "after\n",
    });

    try {
      // When
      const restore = restoreUndoCheckpointsThrough(workspace, 0);

      // Then
      expect(restore).toEqual({
        status: "none",
        message:
          "No undo checkpoint 0. Run keel /undo --list to choose an available checkpoint.",
      });
      expect(await readFile(filePath, "utf8")).toBe("after\n");
      expect(listUndoCheckpoints(workspace)).toEqual([
        { restoredLabel: "note.txt" },
      ]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given create and delete checkpoints leave a file absent,
    When restoring through both checkpoints,
    Then the no-op file transition still consumes the selected checkpoints`, async () => {
    // Given
    const workspace = await createGitWorkspace("keel-git-undo-through-noop-");
    const filePath = join(workspace, "note.txt");
    await writeFile(filePath, "created\n", "utf8");
    recordLastCreateCheckpoint({
      workspace,
      filePath,
      afterContent: "created\n",
    });
    await rm(filePath);
    recordLastDeleteCheckpoint({
      workspace,
      filePath,
      beforeContent: "created\n",
      mode: 0o644,
    });

    try {
      // When
      const restore = restoreUndoCheckpointsThrough(workspace, 2);

      // Then
      expect(restore).toEqual({
        status: "restored",
        restoredLabel: "2 checkpoints",
      });
      await expect(readFile(filePath, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(listUndoCheckpoints(workspace)).toEqual([]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given create checkpoints are separated by the user deleting the file,
    When restoring through both checkpoints,
    Then the file remains absent and both create checkpoints are consumed`, async () => {
    // Given
    const workspace = await createGitWorkspace(
      "keel-git-undo-through-creates-",
    );
    const filePath = join(workspace, "note.txt");
    await writeFile(filePath, "first create\n", "utf8");
    recordLastCreateCheckpoint({
      workspace,
      filePath,
      afterContent: "first create\n",
    });
    await rm(filePath);
    await writeFile(filePath, "second create\n", "utf8");
    recordLastCreateCheckpoint({
      workspace,
      filePath,
      afterContent: "second create\n",
    });

    try {
      // When
      const restore = restoreUndoCheckpointsThrough(workspace, 2);

      // Then
      expect(restore).toEqual({
        status: "restored",
        restoredLabel: "2 checkpoints",
      });
      await expect(readFile(filePath, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(listUndoCheckpoints(workspace)).toEqual([]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given create checkpoints are separated by deletion and the latest file is already absent,
    When restoring through both checkpoints,
    Then the file remains absent and both checkpoints are consumed`, async () => {
    // Given
    const workspace = await createGitWorkspace(
      "keel-git-undo-through-creates-missing-",
    );
    const filePath = join(workspace, "note.txt");
    await writeFile(filePath, "first create\n", "utf8");
    recordLastCreateCheckpoint({
      workspace,
      filePath,
      afterContent: "first create\n",
    });
    await rm(filePath);
    await writeFile(filePath, "second create\n", "utf8");
    recordLastCreateCheckpoint({
      workspace,
      filePath,
      afterContent: "second create\n",
    });
    await rm(filePath);

    try {
      // When
      const restore = restoreUndoCheckpointsThrough(workspace, 2);

      // Then
      expect(restore).toEqual({
        status: "restored",
        restoredLabel: "2 checkpoints",
      });
      await expect(readFile(filePath, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(listUndoCheckpoints(workspace)).toEqual([]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a create checkpoint is followed by an edit checkpoint and the user deletes the file,
    When restoring through both checkpoints,
    Then the restore blocks without consuming either checkpoint`, async () => {
    // Given
    const workspace = await createGitWorkspace(
      "keel-git-undo-through-create-edit-missing-",
    );
    const filePath = join(workspace, "note.txt");
    await writeFile(filePath, "created\n", "utf8");
    recordLastCreateCheckpoint({
      workspace,
      filePath,
      afterContent: "created\n",
    });
    await writeFile(filePath, "edited\n", "utf8");
    recordUnownedEditCheckpoint({
      workspace,
      filePath,
      beforeContent: "created\n",
      afterContent: "edited\n",
    });
    await rm(filePath);

    try {
      // When
      const restore = restoreUndoCheckpointsThrough(workspace, 2);

      // Then
      expect(restore).toEqual({
        status: "blocked",
        filePath: "note.txt",
        message: "Cannot undo note.txt: Refusing to overwrite user changes.",
      });
      await expect(readFile(filePath, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(listUndoCheckpoints(workspace)).toEqual([
        { restoredLabel: "note.txt" },
        { restoredLabel: "note.txt" },
      ]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a create checkpoint is followed by an edit checkpoint and the file changed again,
    When restoring through both checkpoints,
    Then the restore blocks without removing the user's changed file`, async () => {
    // Given
    const workspace = await createGitWorkspace(
      "keel-git-undo-through-create-edit-change-",
    );
    const filePath = join(workspace, "note.txt");
    await writeFile(filePath, "created\n", "utf8");
    recordLastCreateCheckpoint({
      workspace,
      filePath,
      afterContent: "created\n",
    });
    await writeFile(filePath, "edited\n", "utf8");
    recordUnownedEditCheckpoint({
      workspace,
      filePath,
      beforeContent: "created\n",
      afterContent: "edited\n",
    });
    await writeFile(filePath, "user change\n", "utf8");

    try {
      // When
      const restore = restoreUndoCheckpointsThrough(workspace, 2);

      // Then
      expect(restore).toEqual({
        status: "blocked",
        filePath: "note.txt",
        message: "Cannot undo note.txt: Refusing to overwrite user changes.",
      });
      expect(await readFile(filePath, "utf8")).toBe("user change\n");
      expect(listUndoCheckpoints(workspace)).toEqual([
        { restoredLabel: "note.txt" },
        { restoredLabel: "note.txt" },
      ]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a mode-owning create checkpoint is followed by a content-only edit,
    When restoring through both checkpoints while the file mode still matches,
    Then the unowned edit mode is treated as continuous and the file is removed`, async () => {
    // Given
    const workspace = await createGitWorkspace(
      "keel-git-undo-through-create-edit-unowned-mode-",
    );
    const filePath = join(workspace, "tool.sh");
    await writeFile(filePath, "final\n", "utf8");
    if (process.platform !== "win32") {
      await chmod(filePath, 0o755);
    }
    recordLastCreateCheckpoint({
      workspace,
      filePath,
      afterContent: "initial\n",
      mode: 0o755,
    });
    recordUnownedEditCheckpoint({
      workspace,
      filePath,
      beforeContent: "initial\n",
      afterContent: "final\n",
    });

    try {
      // When
      const restore = restoreUndoCheckpointsThrough(workspace, 2);

      // Then
      expect(restore).toEqual({
        status: "restored",
        restoredLabel: "2 checkpoints",
      });
      await expect(readFile(filePath, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(listUndoCheckpoints(workspace)).toEqual([]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a create checkpoint with a mode is followed by a content-only edit,
    When the user changes only the current file mode before restoring both,
    Then the restore blocks without deleting the file`, async () => {
    // Given
    const workspace = await createGitWorkspace(
      "keel-git-undo-through-create-edit-mode-",
    );
    const filePath = join(workspace, "tool.sh");
    await writeFile(filePath, "final\n", "utf8");
    if (process.platform !== "win32") {
      await chmod(filePath, 0o755);
    }
    recordLastCreateCheckpoint({
      workspace,
      filePath,
      afterContent: "initial\n",
      mode: 0o755,
    });
    recordUnownedEditCheckpoint({
      workspace,
      filePath,
      beforeContent: "initial\n",
      afterContent: "final\n",
    });
    if (process.platform !== "win32") {
      await chmod(filePath, 0o644);
    }

    try {
      // When
      const restore = restoreUndoCheckpointsThrough(workspace, 2);

      // Then
      expect(restore).toEqual({
        status: "blocked",
        filePath: "tool.sh",
        message: "Cannot undo tool.sh: Refusing to overwrite user changes.",
      });
      expect(await readFile(filePath, "utf8")).toBe("final\n");
      expect(listUndoCheckpoints(workspace)).toEqual([
        { restoredLabel: "tool.sh" },
        { restoredLabel: "tool.sh" },
      ]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a create checkpoint is followed by an edit checkpoint and the target is a symlink,
    When restoring through both checkpoints,
    Then the restore blocks without removing the symlink`, async () => {
    // Given
    const workspace = await createGitWorkspace(
      "keel-git-undo-through-create-edit-symlink-",
    );
    const filePath = join(workspace, "note.txt");
    await writeFile(filePath, "created\n", "utf8");
    recordLastCreateCheckpoint({
      workspace,
      filePath,
      afterContent: "created\n",
    });
    await writeFile(filePath, "edited\n", "utf8");
    recordUnownedEditCheckpoint({
      workspace,
      filePath,
      beforeContent: "created\n",
      afterContent: "edited\n",
    });
    await rm(filePath);
    await writeFile(join(workspace, "target.txt"), "target\n", "utf8");
    await symlink("target.txt", filePath);

    try {
      // When
      const restore = restoreUndoCheckpointsThrough(workspace, 2);

      // Then
      expect(restore).toEqual({
        status: "blocked",
        filePath: "note.txt",
        message: "Cannot undo note.txt: Refusing to overwrite user changes.",
      });
      expect((await lstat(filePath)).isSymbolicLink()).toBe(true);
      expect(await readFile(join(workspace, "target.txt"), "utf8")).toBe(
        "target\n",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given create and delete checkpoints are followed by another create,
    When restoring through all selected checkpoints,
    Then the file returns to its pre-create missing state`, async () => {
    // Given
    const workspace = await createGitWorkspace(
      "keel-git-undo-through-create-delete-create-",
    );
    const filePath = join(workspace, "note.txt");
    await writeFile(filePath, "first\n", "utf8");
    recordLastCreateCheckpoint({
      workspace,
      filePath,
      afterContent: "first\n",
    });
    await rm(filePath);
    recordLastDeleteCheckpoint({
      workspace,
      filePath,
      beforeContent: "first\n",
      mode: 0o644,
    });
    await writeFile(filePath, "second\n", "utf8");
    recordLastCreateCheckpoint({
      workspace,
      filePath,
      afterContent: "second\n",
    });

    try {
      // When
      const restore = restoreUndoCheckpointsThrough(workspace, 3);

      // Then
      expect(restore).toEqual({
        status: "restored",
        restoredLabel: "3 checkpoints",
      });
      await expect(readFile(filePath, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(listUndoCheckpoints(workspace)).toEqual([]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given create and delete checkpoints leave a file absent but the user recreated it,
    When restoring through both checkpoints,
    Then the user-created file blocks the restore and checkpoints remain`, async () => {
    // Given
    const workspace = await createGitWorkspace(
      "keel-git-undo-through-recreate-",
    );
    const filePath = join(workspace, "note.txt");
    await writeFile(filePath, "created\n", "utf8");
    recordLastCreateCheckpoint({
      workspace,
      filePath,
      afterContent: "created\n",
    });
    await rm(filePath);
    recordLastDeleteCheckpoint({
      workspace,
      filePath,
      beforeContent: "created\n",
      mode: 0o644,
    });
    await writeFile(filePath, "user recreated\n", "utf8");

    try {
      // When
      const restore = restoreUndoCheckpointsThrough(workspace, 2);

      // Then
      expect(restore).toEqual({
        status: "blocked",
        filePath: "note.txt",
        message: "Cannot undo note.txt: Refusing to overwrite user changes.",
      });
      expect(await readFile(filePath, "utf8")).toBe("user recreated\n");
      expect(listUndoCheckpoints(workspace)).toEqual([
        { restoredLabel: "note.txt" },
        { restoredLabel: "note.txt" },
      ]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given user changes break continuity between same-file checkpoints,
    When restoring through those checkpoints,
    Then the restore blocks before overwriting the user's intervening state`, async () => {
    // Given
    const workspace = await createGitWorkspace(
      "keel-git-undo-through-discontinuous-",
    );
    const filePath = join(workspace, "note.txt");
    await writeFile(filePath, "new\n", "utf8");
    recordUnownedEditCheckpoint({
      workspace,
      filePath,
      beforeContent: "old\n",
      afterContent: "new\n",
    });
    await rm(filePath);
    await writeFile(filePath, "created after user deletion\n", "utf8");
    recordLastCreateCheckpoint({
      workspace,
      filePath,
      afterContent: "created after user deletion\n",
    });

    try {
      // When
      const restore = restoreUndoCheckpointsThrough(workspace, 2);

      // Then
      expect(restore).toEqual({
        status: "blocked",
        filePath: "note.txt",
        message: "Cannot undo note.txt: Refusing to overwrite user changes.",
      });
      expect(await readFile(filePath, "utf8")).toBe(
        "created after user deletion\n",
      );
      expect(listUndoCheckpoints(workspace)).toEqual([
        { restoredLabel: "note.txt" },
        { restoredLabel: "note.txt" },
      ]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test.each([
    {
      sequence: "create-delete-edit",
      checkpointCount: 3,
      prepare: async (workspace: string, filePath: string) => {
        await writeFile(filePath, "created\n", "utf8");
        recordLastCreateCheckpoint({
          workspace,
          filePath,
          afterContent: "created\n",
        });
        await rm(filePath);
        recordLastDeleteCheckpoint({
          workspace,
          filePath,
          beforeContent: "created\n",
          mode: 0o644,
        });
        await writeFile(filePath, "edited after recreation\n", "utf8");
        recordUnownedEditCheckpoint({
          workspace,
          filePath,
          beforeContent: "recreated by user\n",
          afterContent: "edited after recreation\n",
        });
      },
    },
    {
      sequence: "delete-edit",
      checkpointCount: 2,
      prepare: async (workspace: string, filePath: string) => {
        await writeFile(filePath, "deleted\n", "utf8");
        await rm(filePath);
        recordLastDeleteCheckpoint({
          workspace,
          filePath,
          beforeContent: "deleted\n",
          mode: 0o644,
        });
        await writeFile(filePath, "edited after recreation\n", "utf8");
        recordUnownedEditCheckpoint({
          workspace,
          filePath,
          beforeContent: "recreated by user\n",
          afterContent: "edited after recreation\n",
        });
      },
    },
    {
      sequence: "create-discontinuous-edit",
      checkpointCount: 2,
      prepare: async (workspace: string, filePath: string) => {
        await writeFile(filePath, "created\n", "utf8");
        recordLastCreateCheckpoint({
          workspace,
          filePath,
          afterContent: "created\n",
        });
        await writeFile(filePath, "edited after user change\n", "utf8");
        recordUnownedEditCheckpoint({
          workspace,
          filePath,
          beforeContent: "changed by user\n",
          afterContent: "edited after user change\n",
        });
      },
    },
  ])(
    `Given a $sequence checkpoint sequence crosses a user-owned state,
    When restoring through all checkpoints,
    Then undo blocks before coalescing across that discontinuity`,
    async ({ checkpointCount, prepare, sequence }) => {
      // Given
      const workspace = await createGitWorkspace(
        `keel-git-undo-through-${sequence}-`,
      );
      const filePath = join(workspace, "note.txt");
      await prepare(workspace, filePath);

      try {
        // When
        const restore = restoreUndoCheckpointsThrough(
          workspace,
          checkpointCount,
        );

        // Then
        expect(restore).toEqual({
          status: "blocked",
          filePath: "note.txt",
          message: "Cannot undo note.txt: Refusing to overwrite user changes.",
        });
        expect(await readFile(filePath, "utf8")).toBe(
          sequence === "create-discontinuous-edit"
            ? "edited after user change\n"
            : "edited after recreation\n",
        );
        expect(listUndoCheckpoints(workspace)).toHaveLength(checkpointCount);
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    },
  );

  test(`Given a delete checkpoint is followed by a create checkpoint on the same path,
    When restoring through both checkpoints,
    Then the deleted file content and mode are restored`, async () => {
    // Given
    const workspace = await createGitWorkspace(
      "keel-git-undo-through-delete-create-",
    );
    const filePath = join(workspace, "tool.sh");
    await writeFile(filePath, "old\n", "utf8");
    await chmod(filePath, 0o755);
    await rm(filePath);
    recordLastDeleteCheckpoint({
      workspace,
      filePath,
      beforeContent: "old\n",
      mode: 0o755,
    });
    await writeFile(filePath, "created\n", "utf8");
    await chmod(filePath, 0o644);
    recordLastCreateCheckpoint({
      workspace,
      filePath,
      afterContent: "created\n",
      mode: 0o644,
    });

    try {
      // When
      const restore = restoreUndoCheckpointsThrough(workspace, 2);

      // Then
      expect(restore).toEqual({
        status: "restored",
        restoredLabel: "2 checkpoints",
      });
      expect(await readFile(filePath, "utf8")).toBe("old\n");
      expect((await stat(filePath)).mode & 0o7777).toBe(0o755);
      expect(listUndoCheckpoints(workspace)).toEqual([]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a delete checkpoint is followed by a mode-owning create checkpoint,
    When the user changes only the current file mode before restoring both,
    Then restore blocks without replacing the file`, async () => {
    // Given
    const workspace = await createGitWorkspace(
      "keel-git-undo-through-delete-create-mode-",
    );
    const filePath = join(workspace, "tool.sh");
    await writeFile(filePath, "old\n", "utf8");
    await chmod(filePath, 0o644);
    await rm(filePath);
    recordLastDeleteCheckpoint({
      workspace,
      filePath,
      beforeContent: "old\n",
      mode: 0o644,
    });
    await writeFile(filePath, "created\n", "utf8");
    await chmod(filePath, 0o755);
    recordLastCreateCheckpoint({
      workspace,
      filePath,
      afterContent: "created\n",
      mode: 0o755,
    });
    await chmod(filePath, 0o644);

    try {
      // When
      const restore = restoreUndoCheckpointsThrough(workspace, 2);

      // Then
      expect(restore).toEqual({
        status: "blocked",
        filePath: "tool.sh",
        message: "Cannot undo tool.sh: Refusing to overwrite user changes.",
      });
      expect(await readFile(filePath, "utf8")).toBe("created\n");
      expect((await stat(filePath)).mode & 0o777).toBe(0o644);
      expect(listUndoCheckpoints(workspace)).toEqual([
        { restoredLabel: "tool.sh" },
        { restoredLabel: "tool.sh" },
      ]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an edit checkpoint is followed by a delete checkpoint on the same path,
    When restoring through both checkpoints,
    Then the file is restored to the pre-edit content`, async () => {
    // Given
    const workspace = await createGitWorkspace(
      "keel-git-undo-through-edit-delete-",
    );
    const filePath = join(workspace, "note.txt");
    await writeFile(filePath, "middle\n", "utf8");
    recordUnownedEditCheckpoint({
      workspace,
      filePath,
      beforeContent: "before\n",
      afterContent: "middle\n",
    });
    await rm(filePath);
    recordLastDeleteCheckpoint({
      workspace,
      filePath,
      beforeContent: "middle\n",
      mode: 0o644,
    });

    try {
      // When
      const restore = restoreUndoCheckpointsThrough(workspace, 2);

      // Then
      expect(restore).toEqual({
        status: "restored",
        restoredLabel: "2 checkpoints",
      });
      expect(await readFile(filePath, "utf8")).toBe("before\n");
      expect(listUndoCheckpoints(workspace)).toEqual([]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a batch checkpoint is followed by an edit checkpoint,
    When restoring through both checkpoints,
    Then the batch and edit changes are restored atomically`, async () => {
    // Given
    const workspace = await createGitWorkspace(
      "keel-git-undo-through-batch-edit-",
    );
    const firstPath = join(workspace, "first.txt");
    const secondPath = join(workspace, "second.txt");
    await writeFile(firstPath, "first after batch\n", "utf8");
    await writeFile(secondPath, "second after batch\n", "utf8");
    recordLastBatchCheckpoint({
      workspace,
      operations: [
        {
          operation: "edit",
          filePath: firstPath,
          beforeContent: "first before\n",
          afterContent: "first after batch\n",
          modeOwnership: { kind: "unowned" },
        },
        {
          operation: "create",
          filePath: secondPath,
          afterContent: "second after batch\n",
        },
      ],
    });
    await writeFile(secondPath, "second after edit\n", "utf8");
    recordUnownedEditCheckpoint({
      workspace,
      filePath: secondPath,
      beforeContent: "second after batch\n",
      afterContent: "second after edit\n",
    });

    try {
      // When
      const restore = restoreUndoCheckpointsThrough(workspace, 2);

      // Then
      expect(restore).toEqual({
        status: "restored",
        restoredLabel: "2 checkpoints",
      });
      expect(await readFile(firstPath, "utf8")).toBe("first before\n");
      await expect(readFile(secondPath, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(listUndoCheckpoints(workspace)).toEqual([]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a delete checkpoint is followed by a create checkpoint already removed by the user,
    When restoring through both checkpoints,
    Then the older deleted file is restored and both checkpoints are consumed`, async () => {
    // Given
    const workspace = await createGitWorkspace(
      "keel-git-undo-through-delete-create-missing-",
    );
    const filePath = join(workspace, "tool.sh");
    await writeFile(filePath, "old\n", "utf8");
    await chmod(filePath, 0o755);
    await rm(filePath);
    recordLastDeleteCheckpoint({
      workspace,
      filePath,
      beforeContent: "old\n",
      mode: 0o755,
    });
    await writeFile(filePath, "created\n", "utf8");
    recordLastCreateCheckpoint({
      workspace,
      filePath,
      afterContent: "created\n",
    });
    await rm(filePath);

    try {
      // When
      const restore = restoreUndoCheckpointsThrough(workspace, 2);

      // Then
      expect(restore).toEqual({
        status: "restored",
        restoredLabel: "2 checkpoints",
      });
      expect(await readFile(filePath, "utf8")).toBe("old\n");
      expect((await stat(filePath)).mode & 0o7777).toBe(0o755);
      expect(listUndoCheckpoints(workspace)).toEqual([]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a delete-create sequence is followed by another create after user deletion,
    When restoring through all selected checkpoints,
    Then the original deleted file is restored`, async () => {
    // Given
    const workspace = await createGitWorkspace(
      "keel-git-undo-through-delete-create-create-",
    );
    const filePath = join(workspace, "tool.sh");
    await writeFile(filePath, "old\n", "utf8");
    await chmod(filePath, 0o755);
    await rm(filePath);
    recordLastDeleteCheckpoint({
      workspace,
      filePath,
      beforeContent: "old\n",
      mode: 0o755,
    });
    await writeFile(filePath, "first create\n", "utf8");
    recordLastCreateCheckpoint({
      workspace,
      filePath,
      afterContent: "first create\n",
    });
    await rm(filePath);
    await writeFile(filePath, "second create\n", "utf8");
    recordLastCreateCheckpoint({
      workspace,
      filePath,
      afterContent: "second create\n",
    });

    try {
      // When
      const restore = restoreUndoCheckpointsThrough(workspace, 3);

      // Then
      expect(restore).toEqual({
        status: "restored",
        restoredLabel: "3 checkpoints",
      });
      expect(await readFile(filePath, "utf8")).toBe("old\n");
      expect((await stat(filePath)).mode & 0o7777).toBe(0o755);
      expect(listUndoCheckpoints(workspace)).toEqual([]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a delete-create sequence is followed by a delete checkpoint,
    When restoring through all selected checkpoints,
    Then the original deleted file is restored`, async () => {
    // Given
    const workspace = await createGitWorkspace(
      "keel-git-undo-through-delete-create-delete-",
    );
    const filePath = join(workspace, "tool.sh");
    await writeFile(filePath, "old\n", "utf8");
    await chmod(filePath, 0o755);
    await rm(filePath);
    recordLastDeleteCheckpoint({
      workspace,
      filePath,
      beforeContent: "old\n",
      mode: 0o755,
    });
    await writeFile(filePath, "created\n", "utf8");
    recordLastCreateCheckpoint({
      workspace,
      filePath,
      afterContent: "created\n",
    });
    await rm(filePath);
    recordLastDeleteCheckpoint({
      workspace,
      filePath,
      beforeContent: "created\n",
      mode: 0o644,
    });

    try {
      // When
      const restore = restoreUndoCheckpointsThrough(workspace, 3);

      // Then
      expect(restore).toEqual({
        status: "restored",
        restoredLabel: "3 checkpoints",
      });
      expect(await readFile(filePath, "utf8")).toBe("old\n");
      expect((await stat(filePath)).mode & 0o7777).toBe(0o755);
      expect(listUndoCheckpoints(workspace)).toEqual([]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a delete checkpoint is followed by create and edit checkpoints before the user deletes the file,
    When restoring through all selected checkpoints,
    Then the restore blocks without consuming checkpoints`, async () => {
    // Given
    const workspace = await createGitWorkspace(
      "keel-git-undo-through-delete-create-edit-missing-",
    );
    const filePath = join(workspace, "tool.sh");
    await writeFile(filePath, "old\n", "utf8");
    await rm(filePath);
    recordLastDeleteCheckpoint({
      workspace,
      filePath,
      beforeContent: "old\n",
      mode: 0o755,
    });
    await writeFile(filePath, "created\n", "utf8");
    recordLastCreateCheckpoint({
      workspace,
      filePath,
      afterContent: "created\n",
    });
    await writeFile(filePath, "edited\n", "utf8");
    recordUnownedEditCheckpoint({
      workspace,
      filePath,
      beforeContent: "created\n",
      afterContent: "edited\n",
    });
    await rm(filePath);

    try {
      // When
      const restore = restoreUndoCheckpointsThrough(workspace, 3);

      // Then
      expect(restore).toEqual({
        status: "blocked",
        filePath: "tool.sh",
        message: "Cannot undo tool.sh: Refusing to overwrite user changes.",
      });
      await expect(readFile(filePath, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(listUndoCheckpoints(workspace)).toEqual([
        { restoredLabel: "tool.sh" },
        { restoredLabel: "tool.sh" },
        { restoredLabel: "tool.sh" },
      ]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a delete checkpoint is followed by a create checkpoint and the file changed again,
    When restoring through both checkpoints,
    Then the restore blocks without overwriting the user's changed file`, async () => {
    // Given
    const workspace = await createGitWorkspace(
      "keel-git-undo-through-delete-create-change-",
    );
    const filePath = join(workspace, "tool.sh");
    await writeFile(filePath, "old\n", "utf8");
    await rm(filePath);
    recordLastDeleteCheckpoint({
      workspace,
      filePath,
      beforeContent: "old\n",
      mode: 0o755,
    });
    await writeFile(filePath, "created\n", "utf8");
    recordLastCreateCheckpoint({
      workspace,
      filePath,
      afterContent: "created\n",
    });
    await writeFile(filePath, "user change\n", "utf8");

    try {
      // When
      const restore = restoreUndoCheckpointsThrough(workspace, 2);

      // Then
      expect(restore).toEqual({
        status: "blocked",
        filePath: "tool.sh",
        message: "Cannot undo tool.sh: Refusing to overwrite user changes.",
      });
      expect(await readFile(filePath, "utf8")).toBe("user change\n");
      expect(listUndoCheckpoints(workspace)).toEqual([
        { restoredLabel: "tool.sh" },
        { restoredLabel: "tool.sh" },
      ]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a delete checkpoint is followed by a create checkpoint and the target is a symlink,
    When restoring through both checkpoints,
    Then the restore blocks without modifying the symlink target`, async () => {
    // Given
    const workspace = await createGitWorkspace(
      "keel-git-undo-through-delete-create-symlink-",
    );
    const filePath = join(workspace, "tool.sh");
    const targetPath = join(workspace, "target.sh");
    await writeFile(filePath, "old\n", "utf8");
    await rm(filePath);
    recordLastDeleteCheckpoint({
      workspace,
      filePath,
      beforeContent: "old\n",
      mode: 0o755,
    });
    await writeFile(filePath, "created\n", "utf8");
    recordLastCreateCheckpoint({
      workspace,
      filePath,
      afterContent: "created\n",
    });
    await rm(filePath);
    await writeFile(targetPath, "target\n", "utf8");
    await symlink("target.sh", filePath);

    try {
      // When
      const restore = restoreUndoCheckpointsThrough(workspace, 2);

      // Then
      expect(restore).toEqual({
        status: "blocked",
        filePath: "tool.sh",
        message: "Cannot undo tool.sh: Refusing to overwrite user changes.",
      });
      expect((await lstat(filePath)).isSymbolicLink()).toBe(true);
      expect(await readFile(targetPath, "utf8")).toBe("target\n");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a delete-create restore target parent now points outside the git root,
    When restoring through both checkpoints,
    Then undo is blocked before recreating the file outside the workspace`, async () => {
    // Given
    const workspace = await createGitWorkspace(
      "keel-git-undo-through-delete-create-parent-",
    );
    const outsideDirectory = await mkdtemp(join(tmpdir(), "keel-git-outside-"));
    const parentPath = join(workspace, "nested");
    const filePath = join(parentPath, "tool.sh");
    const outsideFile = join(outsideDirectory, "tool.sh");
    await mkdir(parentPath);
    await writeFile(filePath, "old\n", "utf8");
    await rm(filePath);
    recordLastDeleteCheckpoint({
      workspace,
      filePath,
      beforeContent: "old\n",
      mode: 0o755,
    });
    await writeFile(filePath, "created\n", "utf8");
    recordLastCreateCheckpoint({
      workspace,
      filePath,
      afterContent: "created\n",
    });
    await rm(parentPath, { recursive: true });
    await symlink(outsideDirectory, parentPath);

    try {
      // When
      const restore = restoreUndoCheckpointsThrough(workspace, 2);

      // Then
      expect(restore).toEqual({
        status: "blocked",
        filePath: "nested/tool.sh",
        message:
          "Cannot undo nested/tool.sh: Refusing to overwrite user changes.",
      });
      await expect(readFile(outsideFile, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(listUndoCheckpoints(workspace)).toEqual([
        { restoredLabel: "nested/tool.sh" },
        { restoredLabel: "nested/tool.sh" },
      ]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(outsideDirectory, { recursive: true, force: true });
    }
  });

  test(`Given a selected undo checkpoint no longer matches the workspace,
    When restoring through multiple listed checkpoints,
    Then no checkpoint is consumed and no earlier file is partially restored`, async () => {
    // Given
    const workspace = await createGitWorkspace("keel-git-undo-through-block-");
    const firstPath = join(workspace, "first.txt");
    const secondPath = join(workspace, "second.txt");
    await writeFile(firstPath, "first after\n", "utf8");
    recordUnownedEditCheckpoint({
      workspace,
      filePath: firstPath,
      beforeContent: "first before\n",
      afterContent: "first after\n",
    });
    await writeFile(secondPath, "second after\n", "utf8");
    recordUnownedEditCheckpoint({
      workspace,
      filePath: secondPath,
      beforeContent: "second before\n",
      afterContent: "second after\n",
    });
    await writeFile(secondPath, "user change\n", "utf8");

    try {
      // When
      const restore = restoreUndoCheckpointsThrough(workspace, 2);

      // Then
      expect(restore).toEqual({
        status: "blocked",
        filePath: "second.txt",
        message: "Cannot undo second.txt: Refusing to overwrite user changes.",
      });
      expect(await readFile(firstPath, "utf8")).toBe("first after\n");
      expect(await readFile(secondPath, "utf8")).toBe("user change\n");
      expect(listUndoCheckpoints(workspace)).toEqual([
        { restoredLabel: "second.txt" },
        { restoredLabel: "first.txt" },
      ]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a file checkpoint is created,
    When the checkpoint is written,
    Then no git commit is created and no file is staged`, async () => {
    // Given
    const workspace = await createGitWorkspace();
    await writeFile(join(workspace, "note.txt"), "old\n", "utf8");
    await git(workspace, ["add", "note.txt"]);
    await git(workspace, ["commit", "-m", "initial"]);
    const headBefore = (await git(workspace, ["rev-parse", "HEAD"])).stdout;

    try {
      // When
      const result = recordUnownedEditCheckpoint({
        workspace,
        filePath: join(workspace, "note.txt"),
        beforeContent: "old\n",
        afterContent: "new\n",
      });

      // Then
      expect(result.written).toBe(true);
      expect((await git(workspace, ["rev-parse", "HEAD"])).stdout).toBe(
        headBefore,
      );
      expect(
        (await git(workspace, ["diff", "--cached", "--name-only"])).stdout,
      ).toBe("");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given undo checkpoint metadata is corrupt,
    When Keel records a new checkpoint,
    Then the new checkpoint replaces the corrupt stack and can be restored`, async () => {
    // Given
    const workspace = await createGitWorkspace("keel-git-corrupt-stack-");
    const filePath = join(workspace, "note.txt");
    await writeFile(filePath, "new\n", "utf8");
    const path = await checkpointPath(workspace);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "{", "utf8");

    try {
      // When
      const record = recordUnownedEditCheckpoint({
        workspace,
        filePath,
        beforeContent: "old\n",
        afterContent: "new\n",
      });
      const restore = restoreLastEditCheckpoint(workspace);

      // Then
      expect(record).toEqual({ written: true });
      expect(restore).toEqual({
        status: "restored",
        restoredLabel: "note.txt",
      });
      expect(await readFile(filePath, "utf8")).toBe("old\n");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a batch checkpoint records updates and creates,
    When the checkpoint is restored,
    Then every file is returned to its pre-batch state`, async () => {
    // Given
    const workspace = await createGitWorkspace("keel-git-batch-");
    const firstPath = join(workspace, "first.txt");
    const secondPath = join(workspace, "second.txt");
    const createdPath = join(workspace, "nested", "created.txt");
    await mkdir(dirname(createdPath), { recursive: true });
    await writeFile(firstPath, "first new\n", "utf8");
    await writeFile(secondPath, "second new\n", "utf8");
    await writeFile(createdPath, "created\n", "utf8");

    try {
      // When
      const record = recordLastBatchCheckpoint({
        workspace,
        operations: [
          {
            operation: "edit",
            filePath: firstPath,
            beforeContent: "first old\n",
            afterContent: "first new\n",
            modeOwnership: { kind: "unowned" },
          },
          {
            operation: "edit",
            filePath: secondPath,
            beforeContent: "second old\n",
            afterContent: "second new\n",
            modeOwnership: { kind: "unowned" },
          },
          {
            operation: "create",
            filePath: createdPath,
            afterContent: "created\n",
          },
        ],
      });
      const checkpoints = listUndoCheckpoints(workspace);
      const restore = restoreLastEditCheckpoint(workspace);

      // Then
      expect(record).toEqual({ written: true });
      expect(checkpoints).toEqual([{ restoredLabel: "3 files" }]);
      expect(restore).toEqual({
        status: "restored",
        restoredLabel: "3 files",
      });
      expect(await readFile(firstPath, "utf8")).toBe("first old\n");
      expect(await readFile(secondPath, "utf8")).toBe("second old\n");
      await expect(readFile(createdPath, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a batch checkpoint records modes for an edit and a create,
    When the checkpoint is restored,
    Then it restores the edited file mode and removes the created file`, async () => {
    // Given
    const workspace = await createGitWorkspace("keel-git-batch-modes-");
    const editedPath = join(workspace, "tool.sh");
    const createdPath = join(workspace, "created.sh");
    await writeFile(editedPath, "after\n", "utf8");
    await writeFile(createdPath, "created\n", "utf8");
    if (process.platform !== "win32") {
      await chmod(editedPath, 0o755);
      await chmod(createdPath, 0o755);
    }

    try {
      // When
      const record = recordLastBatchCheckpoint({
        workspace,
        operations: [
          {
            operation: "edit",
            filePath: editedPath,
            beforeContent: "before\n",
            afterContent: "after\n",
            modeOwnership: {
              kind: "owned",
              beforeMode: 0o644,
              afterMode: 0o755,
            },
          },
          {
            operation: "create",
            filePath: createdPath,
            afterContent: "created\n",
            mode: 0o755,
          },
        ],
      });
      const restore = restoreLastEditCheckpoint(workspace);

      // Then
      expect(record).toEqual({ written: true });
      expect(restore).toEqual({
        status: "restored",
        restoredLabel: "2 files",
      });
      expect(await readFile(editedPath, "utf8")).toBe("before\n");
      if (process.platform !== "win32") {
        expect((await stat(editedPath)).mode & 0o777).toBe(0o644);
      }
      await expect(readFile(createdPath, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a batch checkpoint created file has the expected content but a changed mode,
    When the checkpoint is restored,
    Then undo blocks before removing the user's file`, async () => {
    // Given
    const workspace = await createGitWorkspace(
      "keel-git-batch-create-mode-blocked-",
    );
    const createdPath = join(workspace, "created.sh");
    await writeFile(createdPath, "created\n", "utf8");
    if (process.platform !== "win32") {
      await chmod(createdPath, 0o755);
    }

    try {
      recordLastBatchCheckpoint({
        workspace,
        operations: [
          {
            operation: "create",
            filePath: createdPath,
            afterContent: "created\n",
            mode: 0o755,
          },
        ],
      });
      if (process.platform !== "win32") {
        await chmod(createdPath, 0o644);
      }

      // When
      const restore = restoreLastEditCheckpoint(workspace);

      // Then
      expect(restore).toEqual({
        status: "blocked",
        filePath: "created.sh",
        message: "Cannot undo created.sh: Refusing to overwrite user changes.",
      });
      expect(await readFile(createdPath, "utf8")).toBe("created\n");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a batch checkpoint edit has the expected content but a changed mode,
    When the checkpoint is restored,
    Then undo blocks before overwriting the user's file`, async () => {
    // Given
    const workspace = await createGitWorkspace(
      "keel-git-batch-edit-mode-blocked-",
    );
    const editedPath = join(workspace, "tool.sh");
    await writeFile(editedPath, "after\n", "utf8");
    if (process.platform !== "win32") {
      await chmod(editedPath, 0o755);
    }

    try {
      recordLastBatchCheckpoint({
        workspace,
        operations: [
          {
            operation: "edit",
            filePath: editedPath,
            beforeContent: "before\n",
            afterContent: "after\n",
            modeOwnership: {
              kind: "owned",
              beforeMode: 0o644,
              afterMode: 0o755,
            },
          },
        ],
      });
      if (process.platform !== "win32") {
        await chmod(editedPath, 0o644);
      }

      // When
      const restore = restoreLastEditCheckpoint(workspace);

      // Then
      expect(restore).toEqual({
        status: "blocked",
        filePath: "tool.sh",
        message: "Cannot undo tool.sh: Refusing to overwrite user changes.",
      });
      expect(await readFile(editedPath, "utf8")).toBe("after\n");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a batch checkpoint records a deleted file,
    When the checkpoint is restored,
    Then the deleted file is recreated from its pre-delete content`, async () => {
    // Given
    const workspace = await createGitWorkspace("keel-git-batch-delete-");
    const deletedPath = join(workspace, "obsolete.txt");
    await writeFile(deletedPath, "obsolete\n", "utf8");
    await chmod(deletedPath, 0o640);
    const deletedRealPath = await realpath(deletedPath);
    await rm(deletedPath);

    try {
      // When
      const record = recordLastBatchCheckpoint({
        workspace,
        operations: [
          {
            operation: "delete",
            filePath: deletedRealPath,
            beforeContent: "obsolete\n",
            mode: 0o640,
          },
        ],
      });
      const restore = restoreLastEditCheckpoint(workspace);

      // Then
      expect(record).toEqual({ written: true });
      expect(restore).toEqual({
        status: "restored",
        restoredLabel: "1 files",
      });
      expect(await readFile(deletedPath, "utf8")).toBe("obsolete\n");
      expect((await stat(deletedPath)).mode & 0o777).toBe(0o640);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a delete checkpoint is recorded outside a git repository,
    When the checkpoint is written,
    Then Keel ignores it`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-git-delete-nongit-"));
    const filePath = join(workspace, "obsolete.txt");

    try {
      // When
      const result = recordLastDeleteCheckpoint({
        workspace,
        filePath,
        beforeContent: "obsolete\n",
        mode: 0o644,
      });

      // Then
      expect(result).toEqual({
        written: false,
        reason: "git_workspace_unavailable",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a delete checkpoint is recorded for a path outside the git root,
    When the checkpoint is written,
    Then Keel ignores it`, async () => {
    // Given
    const workspace = await createGitWorkspace("keel-git-delete-outside-");
    const outsideDirectory = await mkdtemp(join(tmpdir(), "keel-git-outside-"));
    const outsideFile = join(outsideDirectory, "obsolete.txt");

    try {
      // When
      const result = recordLastDeleteCheckpoint({
        workspace,
        filePath: outsideFile,
        beforeContent: "obsolete\n",
        mode: 0o644,
      });

      // Then
      expect(result).toEqual({
        written: false,
        reason: "target_unavailable",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(outsideDirectory, { recursive: true, force: true });
    }
  });

  test(`Given a delete checkpoint target parent cannot be resolved,
    When the checkpoint is written,
    Then Keel ignores it`, async () => {
    // Given
    const workspace = await createGitWorkspace("keel-git-delete-missing-");

    try {
      // When
      const result = recordLastDeleteCheckpoint({
        workspace,
        filePath: join(workspace, "missing", "obsolete.txt"),
        beforeContent: "obsolete\n",
        mode: 0o644,
      });

      // Then
      expect(result).toEqual({
        written: false,
        reason: "target_unavailable",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a delete checkpoint is recorded for the git root itself,
    When the checkpoint is written,
    Then Keel ignores it`, async () => {
    // Given
    const workspace = await createGitWorkspace("keel-git-delete-root-");

    try {
      // When
      const result = recordLastDeleteCheckpoint({
        workspace,
        filePath: workspace,
        beforeContent: "obsolete\n",
        mode: 0o644,
      });

      // Then
      expect(result).toEqual({
        written: false,
        reason: "target_unavailable",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a batch checkpoint deleted target was recreated after recording,
    When the checkpoint is restored,
    Then undo is blocked before overwriting the user's file`, async () => {
    // Given
    const workspace = await createGitWorkspace(
      "keel-git-batch-delete-blocked-",
    );
    const deletedPath = join(workspace, "obsolete.txt");
    await writeFile(deletedPath, "obsolete\n", "utf8");
    const deletedRealPath = await realpath(deletedPath);
    await rm(deletedPath);

    try {
      recordLastBatchCheckpoint({
        workspace,
        operations: [
          {
            operation: "delete",
            filePath: deletedRealPath,
            beforeContent: "obsolete\n",
            mode: 0o644,
          },
        ],
      });
      await writeFile(deletedPath, "user recreated\n", "utf8");

      // When
      const restore = restoreLastEditCheckpoint(workspace);

      // Then
      expect(restore).toEqual({
        status: "blocked",
        filePath: "obsolete.txt",
        message:
          "Cannot undo obsolete.txt: Refusing to overwrite user changes.",
      });
      expect(await readFile(deletedPath, "utf8")).toBe("user recreated\n");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a batch delete checkpoint target parent was removed after recording,
    When the checkpoint is restored,
    Then undo is blocked before recreating the parent path`, async () => {
    // Given
    const workspace = await createGitWorkspace("keel-git-batch-delete-parent-");
    const parentPath = join(workspace, "removed");
    const deletedPath = join(parentPath, "obsolete.txt");
    await mkdir(parentPath);
    await writeFile(deletedPath, "obsolete\n", "utf8");
    const deletedRealPath = await realpath(deletedPath);
    await rm(deletedPath);

    try {
      recordLastBatchCheckpoint({
        workspace,
        operations: [
          {
            operation: "delete",
            filePath: deletedRealPath,
            beforeContent: "obsolete\n",
            mode: 0o644,
          },
        ],
      });
      await rm(parentPath, { recursive: true });

      // When
      const restore = restoreLastEditCheckpoint(workspace);

      // Then
      expect(restore).toEqual({
        status: "blocked",
        filePath: "removed/obsolete.txt",
        message:
          "Cannot undo removed/obsolete.txt: Refusing to overwrite user changes.",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a standalone delete checkpoint target was recreated after recording,
    When the checkpoint is restored,
    Then undo is blocked before overwriting the user's file`, async () => {
    // Given
    const workspace = await createGitWorkspace(
      "keel-git-delete-restore-blocked-",
    );
    const deletedPath = join(workspace, "obsolete.txt");

    try {
      recordLastDeleteCheckpoint({
        workspace,
        filePath: deletedPath,
        beforeContent: "obsolete\n",
        mode: 0o644,
      });
      await writeFile(deletedPath, "user recreated\n", "utf8");

      // When
      const restore = restoreLastEditCheckpoint(workspace);

      // Then
      expect(restore).toEqual({
        status: "blocked",
        filePath: "obsolete.txt",
        message:
          "Cannot undo obsolete.txt: Refusing to overwrite user changes.",
      });
      expect(await readFile(deletedPath, "utf8")).toBe("user recreated\n");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a standalone delete checkpoint target parent was removed after recording,
    When the checkpoint is restored,
    Then undo is blocked before recreating the parent path`, async () => {
    // Given
    const workspace = await createGitWorkspace(
      "keel-git-delete-restore-parent-",
    );
    const parentPath = join(workspace, "removed");
    const deletedPath = join(parentPath, "obsolete.txt");
    await mkdir(parentPath);

    try {
      recordLastDeleteCheckpoint({
        workspace,
        filePath: deletedPath,
        beforeContent: "obsolete\n",
        mode: 0o644,
      });
      await rm(parentPath, { recursive: true });

      // When
      const restore = restoreLastEditCheckpoint(workspace);

      // Then
      expect(restore).toEqual({
        status: "blocked",
        filePath: "removed/obsolete.txt",
        message:
          "Cannot undo removed/obsolete.txt: Refusing to overwrite user changes.",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given one task edits the same file twice,
    When the task checkpoint is restored,
    Then the file returns to its original content`, async () => {
    // Given
    const workspace = await createGitWorkspace("keel-git-task-edit-");
    const filePath = join(workspace, "note.txt");
    await writeFile(filePath, "final\n", "utf8");

    try {
      // When
      const record = recordLastTaskCheckpoint({
        workspace,
        operations: [
          {
            operation: "edit",
            filePath,
            beforeContent: "old\n",
            afterContent: "middle\n",
            modeOwnership: { kind: "unowned" },
          },
          {
            operation: "edit",
            filePath,
            beforeContent: "middle\n",
            afterContent: "final\n",
            modeOwnership: { kind: "unowned" },
          },
        ],
      });
      const restore = restoreLastEditCheckpoint(workspace);

      // Then
      expect(record).toEqual({ written: true });
      expect(restore).toEqual({
        status: "restored",
        restoredLabel: "note.txt",
      });
      expect(await readFile(filePath, "utf8")).toBe("old\n");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given one task edits the same file twice with modes,
    When the task checkpoint is restored,
    Then the file returns to its original content and mode`, async () => {
    // Given
    const workspace = await createGitWorkspace("keel-git-task-edit-mode-");
    const filePath = join(workspace, "tool.sh");
    await writeFile(filePath, "final\n", "utf8");
    if (process.platform !== "win32") {
      await chmod(filePath, 0o755);
    }

    try {
      // When
      const record = recordLastTaskCheckpoint({
        workspace,
        operations: [
          {
            operation: "edit",
            filePath,
            beforeContent: "old\n",
            afterContent: "middle\n",
            modeOwnership: {
              kind: "owned",
              beforeMode: 0o644,
              afterMode: 0o755,
            },
          },
          {
            operation: "edit",
            filePath,
            beforeContent: "middle\n",
            afterContent: "final\n",
            modeOwnership: {
              kind: "owned",
              beforeMode: 0o755,
              afterMode: 0o755,
            },
          },
        ],
      });
      const restore = restoreLastEditCheckpoint(workspace);

      // Then
      expect(record).toEqual({ written: true });
      expect(restore).toEqual({
        status: "restored",
        restoredLabel: "tool.sh",
      });
      expect(await readFile(filePath, "utf8")).toBe("old\n");
      if (process.platform !== "win32") {
        expect((await stat(filePath)).mode & 0o777).toBe(0o644);
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given one task edits and then deletes the same file,
    When the task checkpoint is restored,
    Then the file returns to its original pre-task content`, async () => {
    // Given
    const workspace = await createGitWorkspace("keel-git-task-edit-delete-");
    const filePath = join(workspace, "note.txt");

    try {
      // When
      const record = recordLastTaskCheckpoint({
        workspace,
        operations: [
          {
            operation: "edit",
            filePath,
            beforeContent: "old\n",
            afterContent: "middle\n",
            modeOwnership: { kind: "unowned" },
          },
          {
            operation: "delete",
            filePath,
            beforeContent: "middle\n",
            mode: 0o644,
          },
        ],
      });
      const restore = restoreLastEditCheckpoint(workspace);

      // Then
      expect(record).toEqual({ written: true });
      expect(restore).toEqual({
        status: "restored",
        restoredLabel: "note.txt",
      });
      expect(await readFile(filePath, "utf8")).toBe("old\n");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given one task deletes the same file twice,
    When the task checkpoint is restored,
    Then the file returns to its original pre-task content`, async () => {
    // Given
    const workspace = await createGitWorkspace("keel-git-task-delete-delete-");
    const filePath = join(workspace, "note.txt");

    try {
      // When
      const record = recordLastTaskCheckpoint({
        workspace,
        operations: [
          {
            operation: "delete",
            filePath,
            beforeContent: "old\n",
            mode: 0o644,
          },
          {
            operation: "delete",
            filePath,
            beforeContent: "old\n",
            mode: 0o644,
          },
        ],
      });
      const restore = restoreLastEditCheckpoint(workspace);

      // Then
      expect(record).toEqual({ written: true });
      expect(restore).toEqual({
        status: "restored",
        restoredLabel: "note.txt",
      });
      expect(await readFile(filePath, "utf8")).toBe("old\n");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given one task creates and then deletes the same file,
    When the task checkpoint is recorded,
    Then no undo checkpoint is written`, async () => {
    // Given
    const workspace = await createGitWorkspace("keel-git-task-create-delete-");
    const filePath = join(workspace, "created.txt");

    try {
      // When
      const record = recordLastTaskCheckpoint({
        workspace,
        operations: [
          {
            operation: "create",
            filePath,
            afterContent: "created\n",
          },
          {
            operation: "delete",
            filePath,
            beforeContent: "created\n",
            mode: 0o644,
          },
        ],
      });
      const restore = restoreLastEditCheckpoint(workspace);

      // Then
      expect(record).toEqual({ written: false, reason: "no_changes" });
      expect(restore).toEqual({
        status: "none",
        message:
          "No earlier checkpoints. Ask me to undo more, or use git to reset.",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given one task deletes and then recreates the same file,
    When the task checkpoint is restored,
    Then the recreated file returns to its original content`, async () => {
    // Given
    const workspace = await createGitWorkspace("keel-git-task-delete-create-");
    const filePath = join(workspace, "note.txt");
    await writeFile(filePath, "replacement\n", "utf8");

    try {
      // When
      const record = recordLastTaskCheckpoint({
        workspace,
        operations: [
          {
            operation: "delete",
            filePath,
            beforeContent: "old\n",
            mode: 0o644,
          },
          {
            operation: "create",
            filePath,
            afterContent: "replacement\n",
          },
        ],
      });
      const restore = restoreLastEditCheckpoint(workspace);

      // Then
      expect(record).toEqual({ written: true });
      expect(restore).toEqual({
        status: "restored",
        restoredLabel: "note.txt",
      });
      expect(await readFile(filePath, "utf8")).toBe("old\n");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given one task deletes and then edits the same file after it reappears,
    When the task checkpoint is restored,
    Then the file returns to its original content and mode`, async () => {
    // Given
    const workspace = await createGitWorkspace(
      "keel-git-task-delete-edit-mode-",
    );
    const filePath = join(workspace, "tool.sh");
    await writeFile(filePath, "final\n", "utf8");
    if (process.platform !== "win32") {
      await chmod(filePath, 0o755);
    }

    try {
      // When
      const record = recordLastTaskCheckpoint({
        workspace,
        operations: [
          {
            operation: "delete",
            filePath,
            beforeContent: "old\n",
            mode: 0o644,
          },
          {
            operation: "edit",
            filePath,
            beforeContent: "recreated\n",
            afterContent: "final\n",
            modeOwnership: {
              kind: "owned",
              beforeMode: 0o644,
              afterMode: 0o755,
            },
          },
        ],
      });
      const restore = restoreLastEditCheckpoint(workspace);

      // Then
      expect(record).toEqual({ written: true });
      expect(restore).toEqual({
        status: "restored",
        restoredLabel: "tool.sh",
      });
      expect(await readFile(filePath, "utf8")).toBe("old\n");
      if (process.platform !== "win32") {
        expect((await stat(filePath)).mode & 0o777).toBe(0o644);
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given one task edits and then recreates the same file with a mode,
    When the task checkpoint is restored,
    Then the file returns to its original content and mode`, async () => {
    // Given
    const workspace = await createGitWorkspace(
      "keel-git-task-edit-create-mode-",
    );
    const filePath = join(workspace, "tool.sh");
    await writeFile(filePath, "replacement\n", "utf8");
    if (process.platform !== "win32") {
      await chmod(filePath, 0o755);
    }

    try {
      // When
      const record = recordLastTaskCheckpoint({
        workspace,
        operations: [
          {
            operation: "edit",
            filePath,
            beforeContent: "old\n",
            afterContent: "middle\n",
            modeOwnership: {
              kind: "owned",
              beforeMode: 0o644,
              afterMode: 0o644,
            },
          },
          {
            operation: "create",
            filePath,
            afterContent: "replacement\n",
            mode: 0o755,
          },
        ],
      });
      const restore = restoreLastEditCheckpoint(workspace);

      // Then
      expect(record).toEqual({ written: true });
      expect(restore).toEqual({
        status: "restored",
        restoredLabel: "tool.sh",
      });
      expect(await readFile(filePath, "utf8")).toBe("old\n");
      if (process.platform !== "win32") {
        expect((await stat(filePath)).mode & 0o777).toBe(0o644);
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given one task edits and then recreates the same file without a new mode,
    When the task checkpoint is restored,
    Then the edit mode still protects the recreated file`, async () => {
    // Given
    const workspace = await createGitWorkspace(
      "keel-git-task-edit-create-inherit-mode-",
    );
    const filePath = join(workspace, "tool.sh");
    await writeFile(filePath, "replacement\n", "utf8");
    if (process.platform !== "win32") {
      await chmod(filePath, 0o755);
    }

    try {
      // When
      const record = recordLastTaskCheckpoint({
        workspace,
        operations: [
          {
            operation: "edit",
            filePath,
            beforeContent: "old\n",
            afterContent: "middle\n",
            modeOwnership: {
              kind: "owned",
              beforeMode: 0o644,
              afterMode: 0o755,
            },
          },
          {
            operation: "create",
            filePath,
            afterContent: "replacement\n",
          },
        ],
      });
      const restore = restoreLastEditCheckpoint(workspace);

      // Then
      expect(record).toEqual({ written: true });
      expect(restore).toEqual({
        status: "restored",
        restoredLabel: "tool.sh",
      });
      expect(await readFile(filePath, "utf8")).toBe("old\n");
      if (process.platform !== "win32") {
        expect((await stat(filePath)).mode & 0o777).toBe(0o644);
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given one task creates and then edits the same file,
    When the task checkpoint is restored,
    Then the file is removed`, async () => {
    // Given
    const workspace = await createGitWorkspace("keel-git-task-create-");
    const filePath = join(workspace, "created.txt");
    await writeFile(filePath, "final\n", "utf8");

    try {
      // When
      const record = recordLastTaskCheckpoint({
        workspace,
        operations: [
          {
            operation: "create",
            filePath,
            afterContent: "initial\n",
          },
          {
            operation: "edit",
            filePath,
            beforeContent: "initial\n",
            afterContent: "final\n",
            modeOwnership: { kind: "unowned" },
          },
        ],
      });
      const restore = restoreLastEditCheckpoint(workspace);

      // Then
      expect(record).toEqual({ written: true });
      expect(restore).toEqual({
        status: "restored",
        restoredLabel: "created.txt",
      });
      await expect(readFile(filePath, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given one task creates the same file twice and the final create omits a mode,
    When the task checkpoint is restored,
    Then the first create mode still protects the final file`, async () => {
    // Given
    const workspace = await createGitWorkspace(
      "keel-git-task-create-create-inherit-mode-",
    );
    const filePath = join(workspace, "created.sh");
    await writeFile(filePath, "final\n", "utf8");
    if (process.platform !== "win32") {
      await chmod(filePath, 0o755);
    }

    try {
      // When
      const record = recordLastTaskCheckpoint({
        workspace,
        operations: [
          {
            operation: "create",
            filePath,
            afterContent: "initial\n",
            mode: 0o755,
          },
          {
            operation: "create",
            filePath,
            afterContent: "final\n",
          },
        ],
      });
      const restore = restoreLastEditCheckpoint(workspace);

      // Then
      expect(record).toEqual({ written: true });
      expect(restore).toEqual({
        status: "restored",
        restoredLabel: "created.sh",
      });
      await expect(readFile(filePath, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given one task creates the same file twice with different modes,
    When the task checkpoint is restored,
    Then the final created file is removed only when its final mode still matches`, async () => {
    // Given
    const workspace = await createGitWorkspace(
      "keel-git-task-create-create-mode-",
    );
    const filePath = join(workspace, "created.sh");
    await writeFile(filePath, "final\n", "utf8");
    if (process.platform !== "win32") {
      await chmod(filePath, 0o755);
    }

    try {
      // When
      const record = recordLastTaskCheckpoint({
        workspace,
        operations: [
          {
            operation: "create",
            filePath,
            afterContent: "initial\n",
            mode: 0o644,
          },
          {
            operation: "create",
            filePath,
            afterContent: "final\n",
            mode: 0o755,
          },
        ],
      });
      const restore = restoreLastEditCheckpoint(workspace);

      // Then
      expect(record).toEqual({ written: true });
      expect(restore).toEqual({
        status: "restored",
        restoredLabel: "created.sh",
      });
      await expect(readFile(filePath, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a batch checkpoint created file was already removed,
    When the checkpoint is restored,
    Then edited files are restored and the missing created file stays absent`, async () => {
    // Given
    const workspace = await createGitWorkspace("keel-git-batch-missing-");
    const editedPath = join(workspace, "edited.txt");
    const createdPath = join(workspace, "created.txt");
    await writeFile(editedPath, "new\n", "utf8");
    await writeFile(createdPath, "created\n", "utf8");

    try {
      recordLastBatchCheckpoint({
        workspace,
        operations: [
          {
            operation: "edit",
            filePath: editedPath,
            beforeContent: "old\n",
            afterContent: "new\n",
            modeOwnership: { kind: "unowned" },
          },
          {
            operation: "create",
            filePath: createdPath,
            afterContent: "created\n",
          },
        ],
      });
      await rm(createdPath);

      // When
      const restore = restoreLastEditCheckpoint(workspace);

      // Then
      expect(restore).toEqual({
        status: "restored",
        restoredLabel: "2 files",
      });
      expect(await readFile(editedPath, "utf8")).toBe("old\n");
      await expect(readFile(createdPath, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a batch checkpoint target was changed after recording,
    When the checkpoint is restored,
    Then undo is blocked before restoring any batch file`, async () => {
    // Given
    const workspace = await createGitWorkspace("keel-git-batch-blocked-");
    const editedPath = join(workspace, "edited.txt");
    const createdPath = join(workspace, "created.txt");
    await writeFile(editedPath, "new\n", "utf8");
    await writeFile(createdPath, "created\n", "utf8");

    try {
      recordLastBatchCheckpoint({
        workspace,
        operations: [
          {
            operation: "edit",
            filePath: editedPath,
            beforeContent: "old\n",
            afterContent: "new\n",
            modeOwnership: { kind: "unowned" },
          },
          {
            operation: "create",
            filePath: createdPath,
            afterContent: "created\n",
          },
        ],
      });
      await writeFile(createdPath, "user change\n", "utf8");

      // When
      const restore = restoreLastEditCheckpoint(workspace);

      // Then
      expect(restore).toEqual({
        status: "blocked",
        filePath: "created.txt",
        message: "Cannot undo created.txt: Refusing to overwrite user changes.",
      });
      expect(await readFile(editedPath, "utf8")).toBe("new\n");
      expect(await readFile(createdPath, "utf8")).toBe("user change\n");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a batch checkpoint is recorded for a path outside the git root,
    When the checkpoint is written,
    Then Keel ignores it`, async () => {
    // Given
    const workspace = await createGitWorkspace();
    const outsideDirectory = await mkdtemp(join(tmpdir(), "keel-git-outside-"));
    const outsideFile = join(outsideDirectory, "created.txt");
    await writeFile(outsideFile, "created\n", "utf8");

    try {
      // When
      const result = recordLastBatchCheckpoint({
        workspace,
        operations: [
          {
            operation: "create",
            filePath: outsideFile,
            afterContent: "created\n",
          },
        ],
      });

      // Then
      expect(result).toEqual({
        written: false,
        reason: "target_unavailable",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(outsideDirectory, { recursive: true, force: true });
    }
  });

  test(`Given an empty batch checkpoint is recorded,
    When the checkpoint is written,
    Then Keel ignores it`, async () => {
    // Given
    const workspace = await createGitWorkspace();

    try {
      // When
      const result = recordLastBatchCheckpoint({
        workspace,
        operations: [],
      });

      // Then
      expect(result).toEqual({ written: false, reason: "no_changes" });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a batch checkpoint edit target changed after recording,
    When the checkpoint is restored,
    Then undo is blocked before restoring any batch file`, async () => {
    // Given
    const workspace = await createGitWorkspace("keel-git-batch-edit-blocked-");
    const editedPath = join(workspace, "edited.txt");
    const createdPath = join(workspace, "created.txt");
    await writeFile(editedPath, "new\n", "utf8");
    await writeFile(createdPath, "created\n", "utf8");

    try {
      recordLastBatchCheckpoint({
        workspace,
        operations: [
          {
            operation: "edit",
            filePath: editedPath,
            beforeContent: "old\n",
            afterContent: "new\n",
            modeOwnership: { kind: "unowned" },
          },
          {
            operation: "create",
            filePath: createdPath,
            afterContent: "created\n",
          },
        ],
      });
      await writeFile(editedPath, "user change\n", "utf8");

      // When
      const restore = restoreLastEditCheckpoint(workspace);

      // Then
      expect(restore).toEqual({
        status: "blocked",
        filePath: "edited.txt",
        message: "Cannot undo edited.txt: Refusing to overwrite user changes.",
      });
      expect(await readFile(editedPath, "utf8")).toBe("user change\n");
      expect(await readFile(createdPath, "utf8")).toBe("created\n");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a batch checkpoint edit target was deleted after recording,
    When the checkpoint is restored,
    Then undo is blocked before restoring any batch file`, async () => {
    // Given
    const workspace = await createGitWorkspace("keel-git-batch-edit-missing-");
    const editedPath = join(workspace, "edited.txt");
    await writeFile(editedPath, "new\n", "utf8");

    try {
      recordLastBatchCheckpoint({
        workspace,
        operations: [
          {
            operation: "edit",
            filePath: editedPath,
            beforeContent: "old\n",
            afterContent: "new\n",
            modeOwnership: { kind: "unowned" },
          },
        ],
      });
      await rm(editedPath);

      // When
      const restore = restoreLastEditCheckpoint(workspace);

      // Then
      expect(restore).toEqual({
        status: "blocked",
        filePath: "edited.txt",
        message: "Cannot undo edited.txt: Refusing to overwrite user changes.",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a batch checkpoint created target is now a symlink,
    When the checkpoint is restored,
    Then undo is blocked before removing the symlink`, async () => {
    // Given
    const workspace = await createGitWorkspace("keel-git-batch-symlink-");
    const createdPath = join(workspace, "created.txt");
    const targetPath = join(workspace, "target.txt");
    await writeFile(createdPath, "created\n", "utf8");
    await writeFile(targetPath, "target\n", "utf8");

    try {
      recordLastBatchCheckpoint({
        workspace,
        operations: [
          {
            operation: "create",
            filePath: createdPath,
            afterContent: "created\n",
          },
        ],
      });
      await rm(createdPath);
      await symlink("target.txt", createdPath);

      // When
      const restore = restoreLastEditCheckpoint(workspace);

      // Then
      expect(restore).toEqual({
        status: "blocked",
        filePath: "created.txt",
        message: "Cannot undo created.txt: Refusing to overwrite user changes.",
      });
      expect(await readFile(targetPath, "utf8")).toBe("target\n");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a checkpoint is recorded for a path outside the git root,
    When the checkpoint is written,
    Then Keel ignores it`, async () => {
    // Given
    const workspace = await createGitWorkspace();
    const outsideDirectory = await mkdtemp(join(tmpdir(), "keel-git-outside-"));
    const outsideFile = join(outsideDirectory, "note.txt");
    await writeFile(outsideFile, "new\n", "utf8");

    try {
      // When
      const result = recordUnownedEditCheckpoint({
        workspace,
        filePath: outsideFile,
        beforeContent: "old\n",
        afterContent: "new\n",
      });

      // Then
      expect(result).toEqual({
        written: false,
        reason: "target_unavailable",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(outsideDirectory, { recursive: true, force: true });
    }
  });

  test(`Given a create checkpoint is recorded for a path outside the git root,
    When the checkpoint is written,
    Then Keel ignores it`, async () => {
    // Given
    const workspace = await createGitWorkspace();
    const outsideDirectory = await mkdtemp(join(tmpdir(), "keel-git-outside-"));
    const outsideFile = join(outsideDirectory, "created.txt");
    await writeFile(outsideFile, "created\n", "utf8");

    try {
      // When
      const result = recordLastCreateCheckpoint({
        workspace,
        filePath: outsideFile,
        afterContent: "created\n",
      });

      // Then
      expect(result).toEqual({
        written: false,
        reason: "target_unavailable",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(outsideDirectory, { recursive: true, force: true });
    }
  });

  test(`Given a create checkpoint is recorded for the git root itself,
    When the checkpoint is written,
    Then Keel ignores it`, async () => {
    // Given
    const workspace = await createGitWorkspace();

    try {
      // When
      const result = recordLastCreateCheckpoint({
        workspace,
        filePath: workspace,
        afterContent: "created\n",
      });

      // Then
      expect(result).toEqual({
        written: false,
        reason: "target_unavailable",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a checkpoint target no longer exists,
    When the checkpoint is recorded,
    Then Keel skips it without failing`, async () => {
    // Given
    const workspace = await createGitWorkspace();
    let debugOutput = "";
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        debugOutput += chunk.toString();
        return true;
      });

    try {
      // When
      const record = recordUnownedEditCheckpoint({
        workspace,
        filePath: join(workspace, "missing.txt"),
        beforeContent: "old\n",
        afterContent: "new\n",
      });
      const restore = restoreLastEditCheckpoint(workspace);

      // Then
      expect(record).toEqual({
        written: false,
        reason: "target_unavailable",
      });
      expect(restore).toEqual({
        status: "none",
        message:
          "No earlier checkpoints. Ask me to undo more, or use git to reset.",
      });
      expect(debugOutput).toBe("");
    } finally {
      stderr.mockRestore();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given debug logging is enabled and checkpoint recording fails,
    When the checkpoint is recorded,
    Then Keel logs failure metadata without file contents`, async () => {
    // Given
    const workspace = await createGitWorkspace();
    const filePath = join(workspace, "missing.txt");
    const previousDebug = process.env[DEBUG_ENV_KEY];
    process.env[DEBUG_ENV_KEY] = "1";
    let debugOutput = "";
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        debugOutput += chunk.toString();
        return true;
      });

    try {
      // When
      const record = recordUnownedEditCheckpoint({
        workspace,
        filePath,
        beforeContent: "secret old content\n",
        afterContent: "secret new content\n",
      });

      // Then
      expect(record).toEqual({
        written: false,
        reason: "target_unavailable",
      });
      expect(debugOutput).toContain("undo checkpoint write skipped");
      expect(debugOutput).toContain(`workspace=${workspace}`);
      expect(debugOutput).toContain(`filePath=${filePath}`);
      expect(debugOutput).toContain("error=");
      expect(debugOutput).not.toContain("secret old content");
      expect(debugOutput).not.toContain("secret new content");
    } finally {
      stderr.mockRestore();
      if (previousDebug === undefined) {
        delete process.env[DEBUG_ENV_KEY];
      } else {
        process.env[DEBUG_ENV_KEY] = previousDebug;
      }
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given debug logging is enabled and create checkpoint recording fails,
    When the checkpoint is recorded,
    Then Keel logs failure metadata without file contents`, async () => {
    // Given
    const workspace = await createGitWorkspace();
    const filePath = join(workspace, "created.txt");
    await writeFile(filePath, "created\n", "utf8");
    await writeFile(join(workspace, ".git", "keel"), "not a directory\n");
    const previousDebug = process.env[DEBUG_ENV_KEY];
    process.env[DEBUG_ENV_KEY] = "1";
    let debugOutput = "";
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        debugOutput += chunk.toString();
        return true;
      });

    try {
      // When
      const record = recordLastCreateCheckpoint({
        workspace,
        filePath,
        afterContent: "secret created content\n",
      });

      // Then
      expect(record).toEqual({
        written: false,
        reason: "git_workspace_unavailable",
      });
      expect(debugOutput).toContain("undo checkpoint write skipped");
      expect(debugOutput).toContain(`workspace=${workspace}`);
      expect(debugOutput).toContain(`filePath=${filePath}`);
      expect(debugOutput).toContain("error=");
      expect(debugOutput).not.toContain("secret created content");
    } finally {
      stderr.mockRestore();
      if (previousDebug === undefined) {
        delete process.env[DEBUG_ENV_KEY];
      } else {
        process.env[DEBUG_ENV_KEY] = previousDebug;
      }
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given no checkpoint metadata exists,
    When restoring the checkpoint,
    Then there is nothing to undo`, async () => {
    // Given
    const workspace = await createGitWorkspace();

    try {
      // When
      const result = restoreLastEditCheckpoint(workspace);

      // Then
      expect(result).toEqual({
        status: "none",
        message:
          "No earlier checkpoints. Ask me to undo more, or use git to reset.",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given checkpoint metadata was written by Keel,
    When current file content still matches Keel's post-edit content,
    Then restoring the checkpoint writes the pre-edit content`, async () => {
    // Given
    const workspace = await createGitWorkspace();
    const filePath = join(workspace, "note.txt");
    await writeFile(filePath, "new\n", "utf8");
    recordUnownedEditCheckpoint({
      workspace,
      filePath,
      beforeContent: "old\n",
      afterContent: "new\n",
    });

    try {
      // When
      const result = restoreLastEditCheckpoint(workspace);

      // Then
      expect(result).toMatchObject({
        status: "restored",
        restoredLabel: "note.txt",
      });
      expect(await readFile(filePath, "utf8")).toBe("old\n");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an edit checkpoint records file modes,
    When current content and mode still match Keel's post-edit state,
    Then restoring the checkpoint writes the old content and restores the old mode`, async () => {
    // Given
    const workspace = await createGitWorkspace();
    const filePath = join(workspace, "tool.sh");
    await writeFile(filePath, "after\n", "utf8");
    if (process.platform !== "win32") {
      await chmod(filePath, 0o755);
    }
    recordLastEditCheckpoint({
      workspace,
      filePath,
      beforeContent: "before\n",
      afterContent: "after\n",
      modeOwnership: {
        kind: "owned",
        beforeMode: 0o644,
        afterMode: 0o755,
      },
    });

    try {
      // When
      const result = restoreLastEditCheckpoint(workspace);

      // Then
      expect(result).toMatchObject({
        status: "restored",
        restoredLabel: "tool.sh",
      });
      expect(await readFile(filePath, "utf8")).toBe("before\n");
      if (process.platform !== "win32") {
        expect((await stat(filePath)).mode & 0o777).toBe(0o644);
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an edit checkpoint records file modes and the user changes the mode,
    When restoring the checkpoint,
    Then restore blocks without overwriting the file`, async () => {
    // Given
    const workspace = await createGitWorkspace();
    const filePath = join(workspace, "tool.sh");
    await writeFile(filePath, "after\n", "utf8");
    if (process.platform !== "win32") {
      await chmod(filePath, 0o755);
    }
    recordLastEditCheckpoint({
      workspace,
      filePath,
      beforeContent: "before\n",
      afterContent: "after\n",
      modeOwnership: {
        kind: "owned",
        beforeMode: 0o644,
        afterMode: 0o755,
      },
    });
    if (process.platform !== "win32") {
      await chmod(filePath, 0o644);
    }

    try {
      // When
      const result = restoreLastEditCheckpoint(workspace);

      // Then
      expect(result).toEqual({
        status: "blocked",
        filePath: "tool.sh",
        message: "Cannot undo tool.sh: Refusing to overwrite user changes.",
      });
      expect(await readFile(filePath, "utf8")).toBe("after\n");
      if (process.platform !== "win32") {
        expect((await stat(filePath)).mode & 0o777).toBe(0o644);
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a create checkpoint was written by Keel,
    When current file content still matches Keel's created content,
    Then restoring the checkpoint deletes the created file`, async () => {
    // Given
    const workspace = await createGitWorkspace();
    const filePath = join(workspace, "created.txt");
    await writeFile(filePath, "created\n", "utf8");
    recordLastCreateCheckpoint({
      workspace,
      filePath,
      afterContent: "created\n",
    });

    try {
      // When
      const result = restoreLastEditCheckpoint(workspace);

      // Then
      expect(result).toMatchObject({
        status: "restored",
        restoredLabel: "created.txt",
      });
      await expect(stat(filePath)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a create checkpoint records a mode and the user changes that mode,
    When restoring the checkpoint,
    Then restore blocks without deleting the user's file`, async () => {
    // Given
    const workspace = await createGitWorkspace();
    const filePath = join(workspace, "tool.sh");
    await writeFile(filePath, "#!/bin/sh\n", "utf8");
    if (process.platform !== "win32") {
      await chmod(filePath, 0o755);
    }
    recordLastCreateCheckpoint({
      workspace,
      filePath,
      afterContent: "#!/bin/sh\n",
      mode: 0o755,
    });
    if (process.platform !== "win32") {
      await chmod(filePath, 0o644);
    }

    try {
      // When
      const result = restoreLastEditCheckpoint(workspace);

      // Then
      expect(result).toEqual({
        status: "blocked",
        filePath: "tool.sh",
        message: "Cannot undo tool.sh: Refusing to overwrite user changes.",
      });
      expect(await readFile(filePath, "utf8")).toBe("#!/bin/sh\n");
      await stat(filePath);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a create checkpoint was written by Keel and the user changed that file afterwards,
    When restoring the checkpoint,
    Then restore fails without deleting the user's file`, async () => {
    // Given
    const workspace = await createGitWorkspace();
    const filePath = join(workspace, "created.txt");
    await writeFile(filePath, "user change\n", "utf8");
    recordLastCreateCheckpoint({
      workspace,
      filePath,
      afterContent: "created\n",
    });

    try {
      // When
      const result = restoreLastEditCheckpoint(workspace);

      // Then
      expect(result).toMatchObject({
        status: "blocked",
        filePath: "created.txt",
      });
      expect(await readFile(filePath, "utf8")).toBe("user change\n");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a create checkpoint target was already deleted,
    When restoring the checkpoint,
    Then restore succeeds and consumes the checkpoint`, async () => {
    // Given
    const workspace = await createGitWorkspace();
    const filePath = join(workspace, "created.txt");
    await writeFile(filePath, "created\n", "utf8");
    recordLastCreateCheckpoint({
      workspace,
      filePath,
      afterContent: "created\n",
    });
    await rm(filePath);

    try {
      // When
      const result = restoreLastEditCheckpoint(workspace);
      const secondResult = restoreLastEditCheckpoint(workspace);

      // Then
      expect(result).toMatchObject({
        status: "restored",
        restoredLabel: "created.txt",
      });
      expect(secondResult).toEqual({
        status: "none",
        message:
          "No earlier checkpoints. Ask me to undo more, or use git to reset.",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a create checkpoint target becomes a symlink to another file in the git root,
    When restoring the checkpoint,
    Then restore fails without deleting the symlink target`, async () => {
    // Given
    const workspace = await createGitWorkspace();
    const filePath = join(workspace, "created.txt");
    const targetPath = join(workspace, "target.txt");
    await writeFile(filePath, "created\n", "utf8");
    await writeFile(targetPath, "created\n", "utf8");
    recordLastCreateCheckpoint({
      workspace,
      filePath,
      afterContent: "created\n",
    });
    await rm(filePath);
    await symlink("target.txt", filePath);

    try {
      // When
      const result = restoreLastEditCheckpoint(workspace);

      // Then
      expect(result).toMatchObject({
        status: "blocked",
        filePath: "created.txt",
      });
      expect(await readFile(targetPath, "utf8")).toBe("created\n");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a create checkpoint target becomes a dangling symlink,
    When restoring the checkpoint,
    Then restore fails without consuming the checkpoint or removing the symlink`, async () => {
    // Given
    const workspace = await createGitWorkspace();
    const filePath = join(workspace, "created.txt");
    await writeFile(filePath, "created\n", "utf8");
    recordLastCreateCheckpoint({
      workspace,
      filePath,
      afterContent: "created\n",
    });
    await rm(filePath);
    await symlink("missing-target.txt", filePath);

    try {
      // When
      const result = restoreLastEditCheckpoint(workspace);
      const secondResult = restoreLastEditCheckpoint(workspace);

      // Then
      expect(result).toMatchObject({
        status: "blocked",
        filePath: "created.txt",
      });
      expect(secondResult).toMatchObject({
        status: "blocked",
        filePath: "created.txt",
      });
      expect((await lstat(filePath)).isSymbolicLink()).toBe(true);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a create checkpoint target becomes a directory,
    When restoring the checkpoint,
    Then restore fails without deleting the user's directory`, async () => {
    // Given
    const workspace = await createGitWorkspace();
    const filePath = join(workspace, "created.txt");
    await writeFile(filePath, "created\n", "utf8");
    recordLastCreateCheckpoint({
      workspace,
      filePath,
      afterContent: "created\n",
    });
    await rm(filePath);
    await mkdir(filePath);

    try {
      // When
      const result = restoreLastEditCheckpoint(workspace);

      // Then
      expect(result).toMatchObject({
        status: "blocked",
        filePath: "created.txt",
      });
      expect((await stat(filePath)).isDirectory()).toBe(true);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a create checkpoint target becomes a symlink to a file outside the git root,
    When restoring the checkpoint,
    Then restore fails without deleting the outside file`, async () => {
    // Given
    const workspace = await createGitWorkspace();
    const outsideDirectory = await mkdtemp(join(tmpdir(), "keel-git-outside-"));
    const filePath = join(workspace, "created.txt");
    const outsideFile = join(outsideDirectory, "outside.txt");
    await writeFile(filePath, "created\n", "utf8");
    await writeFile(outsideFile, "created\n", "utf8");
    recordLastCreateCheckpoint({
      workspace,
      filePath,
      afterContent: "created\n",
    });
    await rm(filePath);
    await symlink(outsideFile, filePath);

    try {
      // When
      const result = restoreLastEditCheckpoint(workspace);

      // Then
      expect(result).toMatchObject({
        status: "blocked",
        filePath: "created.txt",
      });
      expect(await readFile(outsideFile, "utf8")).toBe("created\n");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(outsideDirectory, { recursive: true, force: true });
    }
  });

  test(`Given current file content no longer matches Keel's post-edit content,
    When restoring the checkpoint,
    Then restore fails without modifying the file`, async () => {
    // Given
    const workspace = await createGitWorkspace();
    const filePath = join(workspace, "note.txt");
    await writeFile(filePath, "user change\n", "utf8");
    recordUnownedEditCheckpoint({
      workspace,
      filePath,
      beforeContent: "old\n",
      afterContent: "new\n",
    });

    try {
      // When
      const result = restoreLastEditCheckpoint(workspace);

      // Then
      expect(result).toMatchObject({
        status: "blocked",
        filePath: "note.txt",
      });
      expect(await readFile(filePath, "utf8")).toBe("user change\n");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the checkpoint target becomes a symlink to a file outside the git root,
    When restoring the checkpoint,
    Then restore fails without modifying the outside file`, async () => {
    // Given
    const workspace = await createGitWorkspace();
    const outsideDirectory = await mkdtemp(join(tmpdir(), "keel-git-outside-"));
    const filePath = join(workspace, "note.txt");
    const outsideFile = join(outsideDirectory, "outside.txt");
    await writeFile(filePath, "new\n", "utf8");
    await writeFile(outsideFile, "new\n", "utf8");
    recordUnownedEditCheckpoint({
      workspace,
      filePath,
      beforeContent: "old\n",
      afterContent: "new\n",
    });
    await rm(filePath);
    await symlink(outsideFile, filePath);

    try {
      // When
      const result = restoreLastEditCheckpoint(workspace);

      // Then
      expect(result).toMatchObject({
        status: "blocked",
        filePath: "note.txt",
      });
      expect(await readFile(outsideFile, "utf8")).toBe("new\n");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(outsideDirectory, { recursive: true, force: true });
    }
  });

  test(`Given the checkpoint target file no longer exists,
    When restoring the checkpoint,
    Then restore fails without recreating the file`, async () => {
    // Given
    const workspace = await createGitWorkspace();
    await writeRawCheckpoint(workspace, {
      version: 1,
      operation: "edit",
      gitRoot: await realpath(workspace),
      relativePath: "note.txt",
      beforeContent: "old\n",
      afterContent: "new\n",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    try {
      // When
      const result = restoreLastEditCheckpoint(workspace);

      // Then
      expect(result).toMatchObject({
        status: "blocked",
        filePath: "note.txt",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given checkpoint metadata is not valid JSON,
    When restoring the checkpoint,
    Then Keel reports the checkpoint as invalid`, async () => {
    // Given
    const workspace = await createGitWorkspace();
    const path = await checkpointPath(workspace);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "{", "utf8");

    try {
      // When / Then
      expect(() => restoreLastEditCheckpoint(workspace)).toThrow(
        "undo failed: checkpoint is invalid",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given checkpoint metadata does not match Keel's schema,
    When restoring the checkpoint,
    Then Keel reports the checkpoint as invalid`, async () => {
    // Given
    const workspace = await createGitWorkspace();
    await writeRawCheckpoint(workspace, {
      version: 1,
      operation: "edit",
      gitRoot: await realpath(workspace),
      relativePath: "note.txt",
      beforeContent: "old\n",
      afterContent: "new\n",
      createdAt: "",
    });

    try {
      // When / Then
      expect(() => restoreLastEditCheckpoint(workspace)).toThrow(
        "undo failed: checkpoint is invalid",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an edit checkpoint records only one file mode,
    When restoring the checkpoint,
    Then Keel reports the checkpoint as invalid`, async () => {
    // Given
    const workspace = await createGitWorkspace();
    await writeRawCheckpoint(workspace, {
      version: 1,
      operation: "edit",
      gitRoot: await realpath(workspace),
      relativePath: "tool.sh",
      beforeContent: "old\n",
      afterContent: "new\n",
      beforeMode: 0o644,
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    try {
      // When / Then
      expect(() => restoreLastEditCheckpoint(workspace)).toThrow(
        "undo failed: checkpoint is invalid",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given checkpoint metadata points outside the git root,
    When restoring the checkpoint,
    Then Keel reports the checkpoint as invalid`, async () => {
    // Given
    const workspace = await createGitWorkspace();
    await writeRawCheckpoint(workspace, {
      version: 1,
      operation: "edit",
      gitRoot: await realpath(workspace),
      relativePath: "../outside.txt",
      beforeContent: "old\n",
      afterContent: "new\n",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    try {
      // When / Then
      expect(() => restoreLastEditCheckpoint(workspace)).toThrow(
        "undo failed: checkpoint is invalid",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
