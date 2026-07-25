import {
  chmod,
  readdir,
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
  readonly ftruncateSync?: typeof import("node:fs").ftruncateSync;
  readonly linkSync?: typeof import("node:fs").linkSync;
  readonly openSync?: typeof import("node:fs").openSync;
  readonly realpathSync?: (
    path: Parameters<typeof import("node:fs").realpathSync>[0],
  ) => string;
  readonly rmSync?: typeof import("node:fs").rmSync;
  readonly writeFileSync?: typeof import("node:fs").writeFileSync;
  readonly writeSync?: (
    fd: number,
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ) => number;
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
          modeOwnership: { kind: "unowned" },
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
  ])(
    `Given checkpoint metadata cannot be written for $operation,
    When recording the checkpoint,
    Then Keel skips the checkpoint without failing`,
    async ({ fileName, content, record }) => {
      await withGitWorkspace(async (workspace) => {
        // Given
        const filePath = join(workspace, fileName);
        await writeFile(filePath, content, "utf8");
        const actualFs =
          await vi.importActual<typeof import("node:fs")>("node:fs");
        const gitModule = await importGitWithFs({
          writeFileSync: (path, data, options) => {
            if (String(path).includes("undo-checkpoints.json.")) {
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
    },
  );

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
          if (String(path).includes("undo-checkpoints.json.")) {
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
          linkSync: (existingPath, newPath) => {
            if (!racedRestore && String(newPath) === deletedRealPath) {
              racedRestore = true;
              actualFs.writeFileSync(newPath, "user recreated\n", "utf8");
              throw Object.assign(new Error("EEXIST"), { code: "EEXIST" });
            }
            return actualFs.linkSync(existingPath, newPath);
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
          linkSync: (existingPath, newPath) => {
            if (!racedRestore && String(newPath) === deletedRealPath) {
              racedRestore = true;
              actualFs.writeFileSync(newPath, "user recreated\n", "utf8");
              throw Object.assign(new Error("EEXIST"), { code: "EEXIST" });
            }
            return actualFs.linkSync(existingPath, newPath);
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
      if (process.platform !== "win32") {
        await chmod(firstPath, 0o600);
      }
      const actualFs =
        await vi.importActual<typeof import("node:fs")>("node:fs");
      const { recordLastBatchCheckpoint, restoreLastEditCheckpoint } =
        await importGitWithFs({
          writeSync: (fd, buffer, offset, length, position) => {
            const content = Buffer.from(
              buffer.subarray(offset, offset + length),
            ).toString("utf8");
            if (content === "first old\n") {
              const partial = Buffer.from("first partial\n");
              actualFs.writeSync(fd, partial, 0, partial.length, 0);
              throw Object.assign(new Error("EACCES"), { code: "EACCES" });
            }
            return actualFs.writeSync(fd, buffer, offset, length, position);
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
            modeOwnership: {
              kind: "owned",
              beforeMode: 0o644,
              afterMode: 0o600,
            },
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
      if (process.platform !== "win32") {
        expect((await stat(firstPath)).mode & 0o777).toBe(0o600);
      }
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
            modeOwnership: { kind: "unowned" },
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
            operation: "edit",
            filePath: editedRealPath,
            beforeContent: "edited old\n",
            afterContent: "edited new\n",
            modeOwnership: { kind: "unowned" },
          },
          {
            operation: "delete",
            filePath: deletedRealPath,
            beforeContent: "obsolete old\n",
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
      await expect(readFile(deletedPath, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await readFile(editedPath, "utf8")).toBe("edited new\n");
      expect(() => actualFs.accessSync(deletedRealPath)).toThrow();
    });
  });

  test(`Given batch checkpoint metadata cannot be written,
    When recording the batch,
    Then Keel skips the checkpoint without failing the completed changes`, async () => {
    await withGitWorkspace(async (workspace) => {
      // Given
      const filePath = join(workspace, "note.txt");
      await writeFile(filePath, "new\n", "utf8");
      const actualFs =
        await vi.importActual<typeof import("node:fs")>("node:fs");
      const { recordLastBatchCheckpoint } = await importGitWithFs({
        writeFileSync: (path, data, options) => {
          if (String(path).includes("undo-checkpoints.json.")) {
            throw Object.assign(new Error("EACCES"), { code: "EACCES" });
          }
          return actualFs.writeFileSync(path, data, options);
        },
      });

      // When
      const result = recordLastBatchCheckpoint({
        workspace,
        operations: [
          {
            operation: "edit",
            filePath,
            beforeContent: "old\n",
            afterContent: "new\n",
            modeOwnership: { kind: "unowned" },
          },
        ],
      });

      // Then
      expect(result).toEqual({
        written: false,
        reason: "checkpoint_write_failed",
      });
      expect(await readFile(filePath, "utf8")).toBe("new\n");
    });
  });

  test(`Given checkpoint metadata cannot be replaced after a successful restore,
    When consuming the checkpoint,
    Then undo rolls the file back and preserves the checkpoint for retry`, async () => {
    await withGitWorkspace(async (workspace) => {
      // Given
      const filePath = join(workspace, "note.txt");
      await writeFile(filePath, "new\n", "utf8");
      const actualFs =
        await vi.importActual<typeof import("node:fs")>("node:fs");
      let failCheckpointWrite = false;
      let shortRollbackWrite = false;
      const {
        listUndoCheckpoints,
        recordLastEditCheckpoint,
        restoreLastEditCheckpoint,
      } = await importGitWithFs({
        writeFileSync: (path, data, options) => {
          if (
            failCheckpointWrite &&
            String(path).includes("undo-checkpoints.json.")
          ) {
            throw Object.assign(new Error("EACCES"), { code: "EACCES" });
          }
          return actualFs.writeFileSync(path, data, options);
        },
        writeSync: (fd, buffer, offset, length, position) => {
          const content = Buffer.from(
            buffer.subarray(offset, offset + length),
          ).toString("utf8");
          if (
            failCheckpointWrite &&
            !shortRollbackWrite &&
            content === "new\n"
          ) {
            shortRollbackWrite = true;
            return actualFs.writeSync(fd, buffer, offset, 2, position);
          }
          return actualFs.writeSync(fd, buffer, offset, length, position);
        },
      });
      recordLastEditCheckpoint({
        workspace,
        filePath,
        beforeContent: "old\n",
        afterContent: "new\n",
        modeOwnership: { kind: "unowned" },
      });
      failCheckpointWrite = true;

      // When
      const restore = () => restoreLastEditCheckpoint(workspace);

      // Then
      expect(restore).toThrowError(expect.objectContaining({ code: "EACCES" }));
      expect(await readFile(filePath, "utf8")).toBe("new\n");
      expect(listUndoCheckpoints(workspace)).toHaveLength(1);
      expect(shortRollbackWrite).toBe(true);
    });
  });

  test(`Given an undo target write makes no progress,
    When restoring an edit checkpoint,
    Then undo aborts without looping and preserves the file and checkpoint`, async () => {
    await withGitWorkspace(async (workspace) => {
      // Given
      const filePath = join(workspace, "note.txt");
      await writeFile(filePath, "new\n", "utf8");
      const actualFs =
        await vi.importActual<typeof import("node:fs")>("node:fs");
      let zeroWritePending = false;
      const {
        listUndoCheckpoints,
        recordLastEditCheckpoint,
        restoreLastEditCheckpoint,
      } = await importGitWithFs({
        writeSync: (fd, buffer, offset, length, position) => {
          const content = Buffer.from(
            buffer.subarray(offset, offset + length),
          ).toString("utf8");
          if (zeroWritePending && content === "old\n") {
            zeroWritePending = false;
            return 0;
          }
          return actualFs.writeSync(fd, buffer, offset, length, position);
        },
      });
      recordLastEditCheckpoint({
        workspace,
        filePath,
        beforeContent: "old\n",
        afterContent: "new\n",
        modeOwnership: { kind: "unowned" },
      });
      zeroWritePending = true;

      // When
      const result = restoreLastEditCheckpoint(workspace);

      // Then
      expect(result).toMatchObject({
        status: "blocked",
        filePath: "note.txt",
      });
      expect(await readFile(filePath, "utf8")).toBe("new\n");
      expect(listUndoCheckpoints(workspace)).toHaveLength(1);
    });
  });

  test(`Given checkpoint metadata cannot be replaced after a multi-checkpoint restore,
    When consuming both checkpoints,
    Then undo rolls the coalesced file back and preserves both checkpoints`, async () => {
    await withGitWorkspace(async (workspace) => {
      // Given
      const filePath = join(workspace, "note.txt");
      await writeFile(filePath, "middle\n", "utf8");
      const actualFs =
        await vi.importActual<typeof import("node:fs")>("node:fs");
      let failCheckpointWrite = false;
      const {
        listUndoCheckpoints,
        recordLastEditCheckpoint,
        restoreUndoCheckpointsThrough,
      } = await importGitWithFs({
        writeFileSync: (path, data, options) => {
          if (
            failCheckpointWrite &&
            String(path).includes("undo-checkpoints.json.")
          ) {
            throw Object.assign(new Error("EACCES"), { code: "EACCES" });
          }
          return actualFs.writeFileSync(path, data, options);
        },
      });
      recordLastEditCheckpoint({
        workspace,
        filePath,
        beforeContent: "old\n",
        afterContent: "middle\n",
        modeOwnership: { kind: "unowned" },
      });
      await writeFile(filePath, "after\n", "utf8");
      recordLastEditCheckpoint({
        workspace,
        filePath,
        beforeContent: "middle\n",
        afterContent: "after\n",
        modeOwnership: { kind: "unowned" },
      });
      failCheckpointWrite = true;

      // When
      const restore = () => restoreUndoCheckpointsThrough(workspace, 2);

      // Then
      expect(restore).toThrowError(expect.objectContaining({ code: "EACCES" }));
      expect(await readFile(filePath, "utf8")).toBe("after\n");
      expect(listUndoCheckpoints(workspace)).toHaveLength(2);
    });
  });

  test(`Given a deleted-file restore writes only part of its staged content,
    When restoring the checkpoint,
    Then undo keeps the target missing and preserves the checkpoint for retry`, async () => {
    await withGitWorkspace(async (workspace) => {
      // Given
      const filePath = join(workspace, "obsolete.txt");
      await writeFile(filePath, "old\n", "utf8");
      await rm(filePath);
      const actualFs =
        await vi.importActual<typeof import("node:fs")>("node:fs");
      let failRestore = false;
      const {
        listUndoCheckpoints,
        recordLastDeleteCheckpoint,
        restoreLastEditCheckpoint,
      } = await importGitWithFs({
        writeFileSync: (path, data, options) => {
          if (
            failRestore &&
            typeof path === "number" &&
            String(data) === "old\n"
          ) {
            actualFs.writeFileSync(path, "partial\n", options);
            throw Object.assign(new Error("EACCES"), { code: "EACCES" });
          }
          return actualFs.writeFileSync(path, data, options);
        },
      });
      recordLastDeleteCheckpoint({
        workspace,
        filePath,
        beforeContent: "old\n",
        mode: 0o644,
      });
      failRestore = true;

      // When
      const result = restoreLastEditCheckpoint(workspace);
      failRestore = false;
      const retryResult = restoreLastEditCheckpoint(workspace);

      // Then
      expect(result).toMatchObject({
        status: "blocked",
        filePath: "obsolete.txt",
      });
      expect(retryResult).toMatchObject({
        status: "restored",
        restoredLabel: "obsolete.txt",
      });
      expect(await readFile(filePath, "utf8")).toBe("old\n");
      expect(listUndoCheckpoints(workspace)).toHaveLength(0);
    });
  });

  test(`Given a user replaces a restored delete before batch rollback removes it,
    When a later edit restore fails,
    Then undo preserves the user path and the batch checkpoint`, async () => {
    await withGitWorkspace(async (workspace) => {
      // Given
      const editedPath = join(workspace, "edited.txt");
      const deletedPath = join(workspace, "obsolete.txt");
      const keelPath = join(workspace, "keel-restored.txt");
      await writeFile(editedPath, "new\n", "utf8");
      await writeFile(deletedPath, "old deleted\n", "utf8");
      await rm(deletedPath);
      const actualFs =
        await vi.importActual<typeof import("node:fs")>("node:fs");
      let failRestore = false;
      const {
        listUndoCheckpoints,
        recordLastBatchCheckpoint,
        restoreLastEditCheckpoint,
      } = await importGitWithFs({
        linkSync: (existingPath, newPath) => {
          if (
            failRestore &&
            String(existingPath).includes(".obsolete.txt.keel-undo-") &&
            String(newPath) === deletedPath
          ) {
            actualFs.writeFileSync(newPath, "newer user content\n", "utf8");
            throw Object.assign(new Error("EEXIST"), { code: "EEXIST" });
          }
          return actualFs.linkSync(existingPath, newPath);
        },
        writeSync: (fd, buffer, offset, length, position) => {
          const content = Buffer.from(
            buffer.subarray(offset, offset + length),
          ).toString("utf8");
          if (failRestore && content === "old edit\n") {
            actualFs.renameSync(deletedPath, keelPath);
            actualFs.writeFileSync(deletedPath, "user content\n", "utf8");
            throw Object.assign(new Error("EACCES"), { code: "EACCES" });
          }
          return actualFs.writeSync(fd, buffer, offset, length, position);
        },
      });
      recordLastBatchCheckpoint({
        workspace,
        operations: [
          {
            operation: "edit",
            filePath: editedPath,
            beforeContent: "old edit\n",
            afterContent: "new\n",
            modeOwnership: { kind: "unowned" },
          },
          {
            operation: "delete",
            filePath: deletedPath,
            beforeContent: "old deleted\n",
            mode: 0o644,
          },
        ],
      });
      failRestore = true;

      // When
      const result = restoreLastEditCheckpoint(workspace);

      // Then
      expect(result).toMatchObject({
        status: "blocked",
        filePath: "edited.txt",
      });
      expect(await readFile(editedPath, "utf8")).toBe("new\n");
      expect(await readFile(deletedPath, "utf8")).toBe("newer user content\n");
      expect(await readFile(keelPath, "utf8")).toBe("old deleted\n");
      const quarantinedName = (await readdir(workspace)).find((name) =>
        name.includes(".obsolete.txt.keel-undo-"),
      );
      if (quarantinedName === undefined) {
        throw new Error("expected concurrent user file to be quarantined");
      }
      expect(await readFile(join(workspace, quarantinedName), "utf8")).toBe(
        "user content\n",
      );
      expect(listUndoCheckpoints(workspace)).toHaveLength(1);
    });
  });

  test(`Given a user replaces an earlier file while a batch restore is failing,
    When undo rolls back the partial batch,
    Then it preserves the user content and the checkpoint`, async () => {
    await withGitWorkspace(async (workspace) => {
      // Given
      const firstPath = join(workspace, "first.txt");
      const secondPath = join(workspace, "second.txt");
      await writeFile(firstPath, "first new\n", "utf8");
      await writeFile(secondPath, "second new\n", "utf8");
      const actualFs =
        await vi.importActual<typeof import("node:fs")>("node:fs");
      let failRestore = false;
      const {
        listUndoCheckpoints,
        recordLastBatchCheckpoint,
        restoreLastEditCheckpoint,
      } = await importGitWithFs({
        writeSync: (fd, buffer, offset, length, position) => {
          const content = Buffer.from(
            buffer.subarray(offset, offset + length),
          ).toString("utf8");
          if (failRestore && content === "first old\n") {
            actualFs.writeFileSync(secondPath, "user content\n", "utf8");
            throw Object.assign(new Error("EACCES"), { code: "EACCES" });
          }
          return actualFs.writeSync(fd, buffer, offset, length, position);
        },
      });
      recordLastBatchCheckpoint({
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
        ],
      });
      failRestore = true;

      // When
      const result = restoreLastEditCheckpoint(workspace);

      // Then
      expect(result).toMatchObject({
        status: "blocked",
        filePath: "first.txt",
      });
      expect(await readFile(firstPath, "utf8")).toBe("first new\n");
      expect(await readFile(secondPath, "utf8")).toBe("user content\n");
      expect(listUndoCheckpoints(workspace)).toHaveLength(1);
    });
  });

  test(`Given a user replaces an edit target with a symlink after undo opens it,
    When restoring the checkpoint,
    Then undo restores only its opened file and preserves the user target`, async () => {
    await withGitWorkspace(async (workspace) => {
      // Given
      const filePath = join(workspace, "note.txt");
      const displacedPath = join(workspace, "displaced.txt");
      const userPath = join(workspace, "user.txt");
      await writeFile(filePath, "new\n", "utf8");
      await writeFile(userPath, "user content\n", "utf8");
      const actualFs =
        await vi.importActual<typeof import("node:fs")>("node:fs");
      let replaceTarget = false;
      const {
        listUndoCheckpoints,
        recordLastEditCheckpoint,
        restoreLastEditCheckpoint,
      } = await importGitWithFs({
        ftruncateSync: (fd, length) => {
          if (replaceTarget && length === 0) {
            replaceTarget = false;
            actualFs.renameSync(filePath, displacedPath);
            actualFs.symlinkSync(userPath, filePath);
          }
          return actualFs.ftruncateSync(fd, length);
        },
      });
      recordLastEditCheckpoint({
        workspace,
        filePath,
        beforeContent: "old\n",
        afterContent: "new\n",
        modeOwnership: { kind: "unowned" },
      });
      replaceTarget = true;

      // When
      const result = restoreLastEditCheckpoint(workspace);

      // Then
      expect(result).toMatchObject({
        status: "blocked",
        filePath: "note.txt",
      });
      expect(actualFs.lstatSync(filePath).isSymbolicLink()).toBe(true);
      expect(await readFile(filePath, "utf8")).toBe("user content\n");
      expect(await readFile(userPath, "utf8")).toBe("user content\n");
      expect(await readFile(displacedPath, "utf8")).toBe("new\n");
      expect(listUndoCheckpoints(workspace)).toHaveLength(1);
    });
  });

  test.each(["identity", "mode", "content", "missing"] as const)(
    `Given an edit target changes its %s after validation but before open,
    When restoring the checkpoint,
    Then undo blocks without mutating or consuming it`,
    async (change) => {
      await withGitWorkspace(async (workspace) => {
        // Given
        const filePath = join(workspace, "note.txt");
        const displacedPath = join(workspace, "displaced.txt");
        await writeFile(filePath, "new\n", "utf8");
        if (process.platform !== "win32") {
          await chmod(filePath, 0o644);
        }
        const actualFs =
          await vi.importActual<typeof import("node:fs")>("node:fs");
        let changeTarget = false;
        const {
          listUndoCheckpoints,
          recordLastEditCheckpoint,
          restoreLastEditCheckpoint,
        } = await importGitWithFs({
          openSync: (path, flags, mode) => {
            if (changeTarget && String(path) === filePath) {
              changeTarget = false;
              if (change === "identity") {
                actualFs.renameSync(filePath, displacedPath);
                actualFs.writeFileSync(filePath, "new\n", "utf8");
              } else if (change === "mode") {
                actualFs.chmodSync(filePath, 0o600);
              } else if (change === "content") {
                actualFs.writeFileSync(filePath, "user content\n", "utf8");
              } else {
                actualFs.rmSync(filePath);
              }
            }
            return actualFs.openSync(path, flags, mode);
          },
        });
        recordLastEditCheckpoint({
          workspace,
          filePath,
          beforeContent: "old\n",
          afterContent: "new\n",
          modeOwnership: { kind: "unowned" },
        });
        changeTarget = true;

        // When
        const result = restoreLastEditCheckpoint(workspace);

        // Then
        expect(result).toMatchObject({
          status: "blocked",
          filePath: "note.txt",
        });
        expect(listUndoCheckpoints(workspace)).toHaveLength(1);
        if (change === "missing") {
          await expect(readFile(filePath, "utf8")).rejects.toMatchObject({
            code: "ENOENT",
          });
        } else if (change === "content") {
          expect(await readFile(filePath, "utf8")).toBe("user content\n");
        } else {
          expect(await readFile(filePath, "utf8")).toBe("new\n");
        }
        if (change === "identity") {
          expect(await readFile(displacedPath, "utf8")).toBe("new\n");
        }
      });
    },
  );

  test.each([
    { operation: "create", fileName: "created.txt" },
    { operation: "edit", fileName: "edited.txt" },
  ] as const)(
    `Given a batch $operation target disappears after stat validation,
    When restoring the batch checkpoint,
    Then undo blocks without consuming the checkpoint`,
    async ({ operation, fileName }) => {
      await withGitWorkspace(async (workspace) => {
        // Given
        const filePath = join(workspace, fileName);
        const afterContent = operation === "create" ? "created\n" : "edited\n";
        await writeFile(filePath, afterContent, "utf8");
        const actualFs =
          await vi.importActual<typeof import("node:fs")>("node:fs");
        let failTargetRealpath = false;
        const { recordLastBatchCheckpoint, restoreLastEditCheckpoint } =
          await importGitWithFs({
            realpathSync: (path) => {
              if (failTargetRealpath && String(path) === filePath) {
                throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
              }
              return actualFs.realpathSync(path);
            },
          });
        recordLastBatchCheckpoint({
          workspace,
          operations:
            operation === "create"
              ? [
                  {
                    operation: "create",
                    filePath,
                    afterContent,
                  },
                ]
              : [
                  {
                    operation: "edit",
                    filePath,
                    beforeContent: "old\n",
                    afterContent,
                    modeOwnership: { kind: "unowned" },
                  },
                ],
        });
        failTargetRealpath = true;

        // When
        const result = restoreLastEditCheckpoint(workspace);

        // Then
        expect(result).toMatchObject({
          status: "blocked",
          filePath: fileName,
        });
        expect(restoreLastEditCheckpoint(workspace)).toMatchObject({
          status: "blocked",
          filePath: fileName,
        });
      });
    },
  );

  test(`Given a single edit target disappears after stat validation,
    When restoring its checkpoint,
    Then undo blocks without consuming the checkpoint`, async () => {
    await withGitWorkspace(async (workspace) => {
      // Given
      const filePath = join(workspace, "edited.txt");
      await writeFile(filePath, "new\n", "utf8");
      const actualFs =
        await vi.importActual<typeof import("node:fs")>("node:fs");
      let failTargetRealpath = false;
      const { recordLastEditCheckpoint, restoreLastEditCheckpoint } =
        await importGitWithFs({
          realpathSync: (path) => {
            if (failTargetRealpath && String(path) === filePath) {
              throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
            }
            return actualFs.realpathSync(path);
          },
        });
      recordLastEditCheckpoint({
        workspace,
        filePath,
        beforeContent: "old\n",
        afterContent: "new\n",
        modeOwnership: { kind: "unowned" },
      });
      failTargetRealpath = true;

      // When
      const result = restoreLastEditCheckpoint(workspace);

      // Then
      expect(result).toMatchObject({
        status: "blocked",
        filePath: "edited.txt",
      });
      expect(await readFile(filePath, "utf8")).toBe("new\n");
    });
  });

  test.each([
    { sequence: "create-edit", fileName: "created.txt" },
    { sequence: "delete-create", fileName: "recreated.txt" },
  ] as const)(
    `Given a coalesced $sequence target disappears after stat validation,
    When restoring through both checkpoints,
    Then undo blocks without consuming either checkpoint`,
    async ({ sequence, fileName }) => {
      await withGitWorkspace(async (workspace) => {
        // Given
        const filePath = join(workspace, fileName);
        const actualFs =
          await vi.importActual<typeof import("node:fs")>("node:fs");
        let failTargetRealpath = false;
        const {
          listUndoCheckpoints,
          recordLastCreateCheckpoint,
          recordLastDeleteCheckpoint,
          recordLastEditCheckpoint,
          restoreUndoCheckpointsThrough,
        } = await importGitWithFs({
          realpathSync: (path) => {
            if (failTargetRealpath && String(path) === filePath) {
              throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
            }
            return actualFs.realpathSync(path);
          },
        });
        if (sequence === "create-edit") {
          await writeFile(filePath, "created\n", "utf8");
          recordLastCreateCheckpoint({
            workspace,
            filePath,
            afterContent: "created\n",
          });
          await writeFile(filePath, "edited\n", "utf8");
          recordLastEditCheckpoint({
            workspace,
            filePath,
            beforeContent: "created\n",
            afterContent: "edited\n",
            modeOwnership: { kind: "unowned" },
          });
        } else {
          await writeFile(filePath, "old\n", "utf8");
          await rm(filePath);
          recordLastDeleteCheckpoint({
            workspace,
            filePath,
            beforeContent: "old\n",
            mode: 0o644,
          });
          await writeFile(filePath, "created\n", "utf8");
          recordLastCreateCheckpoint({
            workspace,
            filePath,
            afterContent: "created\n",
          });
        }
        failTargetRealpath = true;

        // When
        const result = restoreUndoCheckpointsThrough(workspace, 2);

        // Then
        expect(result).toMatchObject({
          status: "blocked",
          filePath: fileName,
        });
        expect(listUndoCheckpoints(workspace)).toHaveLength(2);
      });
    },
  );

  test(`Given a coalesced delete-create target is recreated during a missing-file restore,
    When restoring through both checkpoints,
    Then undo preserves the user file and both checkpoints`, async () => {
    await withGitWorkspace(async (workspace) => {
      // Given
      const filePath = join(workspace, "note.txt");
      await writeFile(filePath, "old\n", "utf8");
      await rm(filePath);
      const actualFs =
        await vi.importActual<typeof import("node:fs")>("node:fs");
      let racedRestore = false;
      const {
        listUndoCheckpoints,
        recordLastCreateCheckpoint,
        recordLastDeleteCheckpoint,
        restoreUndoCheckpointsThrough,
      } = await importGitWithFs({
        linkSync: (existingPath, newPath) => {
          if (!racedRestore && String(newPath) === filePath) {
            racedRestore = true;
            actualFs.writeFileSync(newPath, "user\n", "utf8");
            throw Object.assign(new Error("EEXIST"), { code: "EEXIST" });
          }
          return actualFs.linkSync(existingPath, newPath);
        },
      });
      recordLastDeleteCheckpoint({
        workspace,
        filePath,
        beforeContent: "old\n",
        mode: 0o644,
      });
      await writeFile(filePath, "created\n", "utf8");
      recordLastCreateCheckpoint({
        workspace,
        filePath,
        afterContent: "created\n",
      });
      await rm(filePath);

      // When
      const result = restoreUndoCheckpointsThrough(workspace, 2);

      // Then
      expect(result).toMatchObject({
        status: "blocked",
        filePath: "note.txt",
      });
      expect(await readFile(filePath, "utf8")).toBe("user\n");
      expect(listUndoCheckpoints(workspace)).toHaveLength(2);
      expect(racedRestore).toBe(true);
    });
  });

  test.each([
    { sequence: "delete-create", failure: "write" },
    { sequence: "create-edit", failure: "remove" },
    { sequence: "edit-delete", failure: "create" },
    { sequence: "edit-edit", failure: "write" },
  ] as const)(
    `Given a coalesced $sequence restore hits a $failure race,
    When restoring through both checkpoints,
    Then undo rolls back partial work and preserves both checkpoints`,
    async ({ sequence, failure }) => {
      await withGitWorkspace(async (workspace) => {
        // Given
        const filePath = join(workspace, "note.txt");
        const actualFs =
          await vi.importActual<typeof import("node:fs")>("node:fs");
        let failRestore = false;
        const restoreError = Object.assign(new Error("EACCES"), {
          code: "EACCES",
        });
        const gitModule = await importGitWithFs({
          linkSync: (existingPath, newPath) => {
            if (
              failRestore &&
              failure === "create" &&
              String(newPath) === filePath
            ) {
              throw restoreError;
            }
            return actualFs.linkSync(existingPath, newPath);
          },
          rmSync: (path, options) => {
            if (
              failRestore &&
              failure === "remove" &&
              String(path) === filePath
            ) {
              throw restoreError;
            }
            return actualFs.rmSync(path, options);
          },
          writeSync: (fd, buffer, offset, length, position) => {
            const content = Buffer.from(
              buffer.subarray(offset, offset + length),
            ).toString("utf8");
            if (failRestore && failure === "write" && content === "old\n") {
              const partial = Buffer.from("partial\n");
              actualFs.writeSync(fd, partial, 0, partial.length, 0);
              throw restoreError;
            }
            return actualFs.writeSync(fd, buffer, offset, length, position);
          },
        });
        if (sequence === "delete-create") {
          await writeFile(filePath, "old\n", "utf8");
          await rm(filePath);
          gitModule.recordLastDeleteCheckpoint({
            workspace,
            filePath,
            beforeContent: "old\n",
            mode: 0o644,
          });
          await writeFile(filePath, "created\n", "utf8");
          gitModule.recordLastCreateCheckpoint({
            workspace,
            filePath,
            afterContent: "created\n",
          });
        } else if (sequence === "create-edit") {
          await writeFile(filePath, "created\n", "utf8");
          gitModule.recordLastCreateCheckpoint({
            workspace,
            filePath,
            afterContent: "created\n",
          });
          await writeFile(filePath, "edited\n", "utf8");
          gitModule.recordLastEditCheckpoint({
            workspace,
            filePath,
            beforeContent: "created\n",
            afterContent: "edited\n",
            modeOwnership: { kind: "unowned" },
          });
        } else if (sequence === "edit-delete") {
          await writeFile(filePath, "middle\n", "utf8");
          gitModule.recordLastEditCheckpoint({
            workspace,
            filePath,
            beforeContent: "old\n",
            afterContent: "middle\n",
            modeOwnership: { kind: "unowned" },
          });
          await rm(filePath);
          gitModule.recordLastDeleteCheckpoint({
            workspace,
            filePath,
            beforeContent: "middle\n",
            mode: 0o644,
          });
        } else {
          await writeFile(filePath, "middle\n", "utf8");
          gitModule.recordLastEditCheckpoint({
            workspace,
            filePath,
            beforeContent: "old\n",
            afterContent: "middle\n",
            modeOwnership: { kind: "unowned" },
          });
          await writeFile(filePath, "after\n", "utf8");
          gitModule.recordLastEditCheckpoint({
            workspace,
            filePath,
            beforeContent: "middle\n",
            afterContent: "after\n",
            modeOwnership: { kind: "unowned" },
          });
        }
        failRestore = true;

        // When
        const result = gitModule.restoreUndoCheckpointsThrough(workspace, 2);

        // Then
        expect(result).toMatchObject({
          status: "blocked",
          filePath: "note.txt",
        });
        expect(gitModule.listUndoCheckpoints(workspace)).toHaveLength(2);
        if (sequence === "delete-create") {
          expect(await readFile(filePath, "utf8")).toBe("created\n");
        } else if (sequence === "create-edit") {
          expect(await readFile(filePath, "utf8")).toBe("edited\n");
        } else if (sequence === "edit-delete") {
          await expect(readFile(filePath, "utf8")).rejects.toMatchObject({
            code: "ENOENT",
          });
        } else {
          expect(await readFile(filePath, "utf8")).toBe("after\n");
        }
      });
    },
  );
});
