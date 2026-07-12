import {
  chmod,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { withGitWorkspace as withHarnessGitWorkspace } from "../../src/testing/cli-harness.ts";

interface FsOverrides {
  readonly fchmodSync?: typeof import("node:fs").fchmodSync;
  readonly openSync?: typeof import("node:fs").openSync;
  readonly realpathSync?: (
    path: Parameters<typeof import("node:fs").realpathSync>[0],
  ) => string;
  readonly rmSync?: typeof import("node:fs").rmSync;
  readonly writeFileSync?: typeof import("node:fs").writeFileSync;
}

async function withGitWorkspace(
  action: (workspace: string) => Promise<void>,
): Promise<void> {
  await withHarnessGitWorkspace(action, "keel-git-race-");
}

async function importGitWithFs(
  overrides: FsOverrides,
): Promise<typeof import("../../src/core/git.ts")> {
  vi.resetModules();
  const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
  vi.doMock("node:fs", () => ({ ...actualFs, ...overrides }));
  return import("../../src/core/git.ts");
}

describe("Git Checkpoint Race Handling", () => {
  afterEach(() => {
    vi.doUnmock("node:fs");
    vi.resetModules();
  });

  test(`Given a created file disappears after restore stats it,
    When restoring the create checkpoint,
    Then restore blocks without consuming the checkpoint`, async () => {
    await withGitWorkspace(async (workspace) => {
      // Given
      const filePath = join(workspace, "created.txt");
      await writeFile(filePath, "created\n", "utf8");
      const actualFs =
        await vi.importActual<typeof import("node:fs")>("node:fs");
      let targetRealpathFails = false;
      const { recordLastCreateCheckpoint, restoreLastEditCheckpoint } =
        await importGitWithFs({
          realpathSync: (path) => {
            if (targetRealpathFails && String(path).endsWith("created.txt")) {
              throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
            }
            return actualFs.realpathSync(path);
          },
        });
      recordLastCreateCheckpoint({
        workspace,
        filePath,
        afterContent: "created\n",
      });
      targetRealpathFails = true;

      // When
      const result = restoreLastEditCheckpoint(workspace);

      // Then
      expect(result).toMatchObject({
        status: "blocked",
        filePath: "created.txt",
      });
      expect(restoreLastEditCheckpoint(workspace)).toMatchObject({
        status: "blocked",
        filePath: "created.txt",
      });
    });
  });

  test.each([
    {
      operation: "an edit",
      fileName: "note.txt",
      content: "new\n",
      record: (
        gitModule: typeof import("../../src/core/git.ts"),
        workspace: string,
        filePath: string,
      ) =>
        gitModule.recordLastEditCheckpoint({
          workspace,
          filePath,
          beforeContent: "old\n",
          afterContent: "new\n",
        }),
    },
    {
      operation: "a created file",
      fileName: "created.txt",
      content: "created\n",
      record: (
        gitModule: typeof import("../../src/core/git.ts"),
        workspace: string,
        filePath: string,
      ) =>
        gitModule.recordLastCreateCheckpoint({
          workspace,
          filePath,
          afterContent: "created\n",
        }),
    },
  ])(`Given checkpoint metadata cannot be written for $operation,
    When recording the checkpoint,
    Then Keel skips the checkpoint without failing`, async ({
    fileName,
    content,
    record,
  }) => {
    await withGitWorkspace(async (workspace) => {
      // Given
      const filePath = join(workspace, fileName);
      await writeFile(filePath, content, "utf8");
      const actualFs =
        await vi.importActual<typeof import("node:fs")>("node:fs");
      const gitModule = await importGitWithFs({
        writeFileSync: (path, data, options) => {
          if (String(path).endsWith("undo-checkpoints.json")) {
            throw Object.assign(new Error("EACCES"), { code: "EACCES" });
          }
          return actualFs.writeFileSync(path, data, options);
        },
      });

      // When
      const result = record(gitModule, workspace, filePath);

      // Then
      expect(result).toEqual({
        written: false,
        reason: "checkpoint_write_failed",
      });
    });
  });

  test(`Given delete checkpoint metadata cannot be written,
    When recording the checkpoint,
    Then Keel skips the checkpoint without failing`, async () => {
    await withGitWorkspace(async (workspace) => {
      // Given
      const filePath = join(workspace, "obsolete.txt");
      await writeFile(filePath, "obsolete\n", "utf8");
      const deletedRealPath = await realpath(filePath);
      await rm(filePath);
      const actualFs =
        await vi.importActual<typeof import("node:fs")>("node:fs");
      const { recordLastDeleteCheckpoint } = await importGitWithFs({
        writeFileSync: (path, data, options) => {
          if (String(path).endsWith("undo-checkpoints.json")) {
            throw Object.assign(new Error("EACCES"), { code: "EACCES" });
          }
          return actualFs.writeFileSync(path, data, options);
        },
      });

      // When
      const result = recordLastDeleteCheckpoint({
        workspace,
        filePath: deletedRealPath,
        beforeContent: "obsolete\n",
        mode: 0o644,
      });

      // Then
      expect(result).toEqual({
        written: false,
        reason: "checkpoint_write_failed",
      });
    });
  });

  test(`Given a deleted file is recreated while restore writes it,
    When restoring the delete checkpoint,
    Then restore blocks without consuming the checkpoint`, async () => {
    await withGitWorkspace(async (workspace) => {
      // Given
      const filePath = join(workspace, "obsolete.txt");
      await writeFile(filePath, "obsolete\n", "utf8");
      const deletedRealPath = await realpath(filePath);
      await rm(filePath);
      const actualFs =
        await vi.importActual<typeof import("node:fs")>("node:fs");
      let racedRestore = false;
      const { recordLastDeleteCheckpoint, restoreLastEditCheckpoint } =
        await importGitWithFs({
          openSync: (path, flags, mode) => {
            if (!racedRestore && String(path) === deletedRealPath) {
              racedRestore = true;
              actualFs.writeFileSync(path, "user recreated\n", "utf8");
              throw Object.assign(new Error("EEXIST"), { code: "EEXIST" });
            }
            return actualFs.openSync(path, flags, mode);
          },
        });
      recordLastDeleteCheckpoint({
        workspace,
        filePath: deletedRealPath,
        beforeContent: "obsolete\n",
        mode: 0o644,
      });

      // When
      const result = restoreLastEditCheckpoint(workspace);
      const secondResult = restoreLastEditCheckpoint(workspace);

      // Then
      expect(result).toMatchObject({
        status: "blocked",
        filePath: "obsolete.txt",
      });
      expect(secondResult).toMatchObject({
        status: "blocked",
        filePath: "obsolete.txt",
      });
      expect(await readFile(filePath, "utf8")).toBe("user recreated\n");
      expect(racedRestore).toBe(true);
    });
  });

  test(`Given a batch-deleted file is recreated while restore writes it,
    When restoring the batch delete checkpoint,
    Then restore blocks without consuming the checkpoint`, async () => {
    await withGitWorkspace(async (workspace) => {
      // Given
      const filePath = join(workspace, "obsolete.txt");
      await writeFile(filePath, "obsolete\n", "utf8");
      const deletedRealPath = await realpath(filePath);
      await rm(filePath);
      const actualFs =
        await vi.importActual<typeof import("node:fs")>("node:fs");
      let racedRestore = false;
      const { recordLastBatchCheckpoint, restoreLastEditCheckpoint } =
        await importGitWithFs({
          openSync: (path, flags, mode) => {
            if (!racedRestore && String(path) === deletedRealPath) {
              racedRestore = true;
              actualFs.writeFileSync(path, "user recreated\n", "utf8");
              throw Object.assign(new Error("EEXIST"), { code: "EEXIST" });
            }
            return actualFs.openSync(path, flags, mode);
          },
        });
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

      // When
      const result = restoreLastEditCheckpoint(workspace);
      const secondResult = restoreLastEditCheckpoint(workspace);

      // Then
      expect(result).toMatchObject({
        status: "blocked",
        filePath: "obsolete.txt",
      });
      expect(secondResult).toMatchObject({
        status: "blocked",
        filePath: "obsolete.txt",
      });
      expect(await readFile(filePath, "utf8")).toBe("user recreated\n");
      expect(racedRestore).toBe(true);
    });
  });

  test(`Given a batch edit restore write fails after earlier create and delete restores,
    When restoring the batch checkpoint,
    Then undo rolls every restored file back and preserves the checkpoint`, async () => {
    await withGitWorkspace(async (workspace) => {
      // Given
      const firstPath = join(workspace, "first.txt");
      const createdPath = join(workspace, "created.txt");
      const deletedPath = join(workspace, "obsolete.txt");
      await writeFile(firstPath, "first new\n", "utf8");
      await writeFile(createdPath, "created\n", "utf8");
      await writeFile(deletedPath, "obsolete old\n", "utf8");
      if (process.platform !== "win32") {
        await chmod(createdPath, 0o600);
      }
      const firstRealPath = await realpath(firstPath);
      const createdRealPath = await realpath(createdPath);
      const deletedRealPath = await realpath(deletedPath);
      await rm(deletedPath);
      const actualFs =
        await vi.importActual<typeof import("node:fs")>("node:fs");
      const { recordLastBatchCheckpoint, restoreLastEditCheckpoint } =
        await importGitWithFs({
          writeFileSync: (path, data, options) => {
            if (
              String(path) === firstRealPath &&
              String(data) === "first old\n"
            ) {
              actualFs.writeFileSync(path, "first partial\n", options);
              throw Object.assign(new Error("EACCES"), { code: "EACCES" });
            }
            return actualFs.writeFileSync(path, data, options);
          },
        });
      recordLastBatchCheckpoint({
        workspace,
        operations: [
          {
            operation: "edit",
            filePath: firstRealPath,
            beforeContent: "first old\n",
            afterContent: "first new\n",
          },
          {
            operation: "delete",
            filePath: deletedRealPath,
            beforeContent: "obsolete old\n",
            mode: 0o644,
          },
          {
            operation: "create",
            filePath: createdRealPath,
            afterContent: "created\n",
          },
        ],
      });

      // When
      const result = restoreLastEditCheckpoint(workspace);
      const secondResult = restoreLastEditCheckpoint(workspace);

      // Then
      expect(result).toEqual({
        status: "blocked",
        filePath: "first.txt",
        message: "Cannot undo first.txt: Could not restore file.",
      });
      expect(secondResult).toEqual({
        status: "blocked",
        filePath: "first.txt",
        message: "Cannot undo first.txt: Could not restore file.",
      });
      expect(await readFile(firstPath, "utf8")).toBe("first new\n");
      expect(await readFile(createdPath, "utf8")).toBe("created\n");
      if (process.platform !== "win32") {
        expect((await stat(createdPath)).mode & 0o777).toBe(0o600);
      }
      await expect(readFile(deletedPath, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  });

  test(`Given a batch create restore removal fails after an earlier file was restored,
    When restoring the batch checkpoint,
    Then undo rolls the earlier file back and preserves the checkpoint`, async () => {
    await withGitWorkspace(async (workspace) => {
      // Given
      const editedPath = join(workspace, "edited.txt");
      const createdPath = join(workspace, "created.txt");
      await writeFile(editedPath, "edited new\n", "utf8");
      await writeFile(createdPath, "created\n", "utf8");
      const editedRealPath = await realpath(editedPath);
      const createdRealPath = await realpath(createdPath);
      const actualFs =
        await vi.importActual<typeof import("node:fs")>("node:fs");
      const { recordLastBatchCheckpoint, restoreLastEditCheckpoint } =
        await importGitWithFs({
          rmSync: (path, options) => {
            if (String(path) === createdRealPath) {
              throw Object.assign(new Error("EACCES"), { code: "EACCES" });
            }
            return actualFs.rmSync(path, options);
          },
        });
      recordLastBatchCheckpoint({
        workspace,
        operations: [
          {
            operation: "create",
            filePath: createdRealPath,
            afterContent: "created\n",
          },
          {
            operation: "edit",
            filePath: editedRealPath,
            beforeContent: "edited old\n",
            afterContent: "edited new\n",
          },
        ],
      });

      // When
      const result = restoreLastEditCheckpoint(workspace);
      const secondResult = restoreLastEditCheckpoint(workspace);

      // Then
      expect(result).toEqual({
        status: "blocked",
        filePath: "created.txt",
        message: "Cannot undo created.txt: Could not restore file.",
      });
      expect(secondResult).toEqual({
        status: "blocked",
        filePath: "created.txt",
        message: "Cannot undo created.txt: Could not restore file.",
      });
      expect(await readFile(editedPath, "utf8")).toBe("edited new\n");
      expect(await readFile(createdPath, "utf8")).toBe("created\n");
    });
  });

  test(`Given a batch delete restore fails after creating the current file,
    When restoring the batch checkpoint,
    Then undo removes the current file, rolls earlier files back, and preserves the checkpoint`, async () => {
    await withGitWorkspace(async (workspace) => {
      // Given
      const editedPath = join(workspace, "edited.txt");
      const deletedPath = join(workspace, "obsolete.txt");
      await writeFile(editedPath, "edited new\n", "utf8");
      await writeFile(deletedPath, "obsolete old\n", "utf8");
      const editedRealPath = await realpath(editedPath);
      const deletedRealPath = await realpath(deletedPath);
      await rm(deletedPath);
      const actualFs =
        await vi.importActual<typeof import("node:fs")>("node:fs");
      const { recordLastBatchCheckpoint, restoreLastEditCheckpoint } =
        await importGitWithFs({
          fchmodSync: (_fd, _mode) => {
            throw Object.assign(new Error("EACCES"), { code: "EACCES" });
          },
        });
      recordLastBatchCheckpoint({
        workspace,
        operations: [
          {
            operation: "delete",
            filePath: deletedRealPath,
            beforeContent: "obsolete old\n",
            mode: 0o644,
          },
          {
            operation: "edit",
            filePath: editedRealPath,
            beforeContent: "edited old\n",
            afterContent: "edited new\n",
          },
        ],
      });

      // When
      const result = restoreLastEditCheckpoint(workspace);
      const secondResult = restoreLastEditCheckpoint(workspace);

      // Then
      expect(result).toMatchObject({
        status: "blocked",
        filePath: "obsolete.txt",
      });
      expect(secondResult).toMatchObject({
        status: "blocked",
        filePath: "obsolete.txt",
      });
      await expect(readFile(deletedPath, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await readFile(editedPath, "utf8")).toBe("edited new\n");
      expect(() => actualFs.accessSync(deletedRealPath)).toThrow();
    });
  });
});
