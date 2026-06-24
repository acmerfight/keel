import {
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
  recordLastBatchCheckpoint,
  recordLastCreateCheckpoint,
  recordLastEditCheckpoint,
  recordLastTaskCheckpoint,
  restoreLastEditCheckpoint,
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
    "keel/last-edit-checkpoint.json",
  ]);
  return result.stdout.trim();
}

async function writeRawCheckpoint(
  workspace: string,
  checkpoint: unknown,
): Promise<void> {
  const path = await checkpointPath(workspace);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(checkpoint)}\n`, "utf8");
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
      const record = recordLastEditCheckpoint({
        workspace,
        filePath,
        beforeContent: "old\n",
        afterContent: "new\n",
      });
      const restore = restoreLastEditCheckpoint(workspace);

      // Then
      expect(record).toEqual({ written: false });
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
      expect(result).toEqual({ written: false });
      expect(restore).toEqual({
        status: "none",
        message:
          "No earlier checkpoints. Ask me to undo more, or use git to reset.",
      });
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
      const result = recordLastEditCheckpoint({
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
          },
          {
            operation: "edit",
            filePath: secondPath,
            beforeContent: "second old\n",
            afterContent: "second new\n",
          },
          {
            operation: "create",
            filePath: createdPath,
            afterContent: "created\n",
          },
        ],
      });
      const restore = restoreLastEditCheckpoint(workspace);

      // Then
      expect(record).toEqual({ written: true });
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
          },
          {
            operation: "edit",
            filePath,
            beforeContent: "middle\n",
            afterContent: "final\n",
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
      expect(result).toEqual({ written: false });
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
      expect(result).toEqual({ written: false });
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
      const result = recordLastEditCheckpoint({
        workspace,
        filePath: outsideFile,
        beforeContent: "old\n",
        afterContent: "new\n",
      });

      // Then
      expect(result).toEqual({ written: false });
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
      expect(result).toEqual({ written: false });
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
      expect(result).toEqual({ written: false });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a checkpoint target no longer exists,
    When the checkpoint is recorded,
    Then Keel skips it without failing`, async () => {
    // Given
    const workspace = await createGitWorkspace();
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      // When
      const record = recordLastEditCheckpoint({
        workspace,
        filePath: join(workspace, "missing.txt"),
        beforeContent: "old\n",
        afterContent: "new\n",
      });
      const restore = restoreLastEditCheckpoint(workspace);

      // Then
      expect(record).toEqual({ written: false });
      expect(restore).toEqual({
        status: "none",
        message:
          "No earlier checkpoints. Ask me to undo more, or use git to reset.",
      });
      expect(stderr).not.toHaveBeenCalled();
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
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      // When
      const record = recordLastEditCheckpoint({
        workspace,
        filePath,
        beforeContent: "secret old content\n",
        afterContent: "secret new content\n",
      });

      // Then
      expect(record).toEqual({ written: false });
      expect(stderr).toHaveBeenCalledWith(
        expect.stringContaining("undo checkpoint write skipped"),
      );
      const debugOutput = stderr.mock.calls
        .map((call) => call.map(String).join(" "))
        .join("\n");
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
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      // When
      const record = recordLastCreateCheckpoint({
        workspace,
        filePath,
        afterContent: "secret created content\n",
      });

      // Then
      expect(record).toEqual({ written: false });
      expect(stderr).toHaveBeenCalledWith(
        expect.stringContaining("undo checkpoint write skipped"),
      );
      const debugOutput = stderr.mock.calls
        .map((call) => call.map(String).join(" "))
        .join("\n");
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
    recordLastEditCheckpoint({
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

  test(`Given checkpoint metadata belongs to another git root,
    When restoring the checkpoint,
    Then there is nothing to undo`, async () => {
    // Given
    const workspace = await createGitWorkspace();
    await writeRawCheckpoint(workspace, {
      version: 1,
      gitRoot: join(workspace, "other-root"),
      relativePath: "note.txt",
      beforeContent: "old\n",
      afterContent: "new\n",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

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

  test(`Given current file content no longer matches Keel's post-edit content,
    When restoring the checkpoint,
    Then restore fails without modifying the file`, async () => {
    // Given
    const workspace = await createGitWorkspace();
    const filePath = join(workspace, "note.txt");
    await writeFile(filePath, "user change\n", "utf8");
    recordLastEditCheckpoint({
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
    recordLastEditCheckpoint({
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

  test(`Given checkpoint metadata points outside the git root,
    When restoring the checkpoint,
    Then Keel reports the checkpoint as invalid`, async () => {
    // Given
    const workspace = await createGitWorkspace();
    await writeRawCheckpoint(workspace, {
      version: 1,
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
