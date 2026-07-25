import {
  access,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, sep } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { KeelErrorCode } from "../../src/core/error.ts";
import {
  createGitWorkspace,
  runGit as git,
} from "../../src/testing/cli-harness.ts";

type PathLike = Parameters<typeof import("node:fs").realpathSync>[0];
type FsModule = typeof import("node:fs");

interface FsOverrides {
  readonly fsyncSync?: FsModule["fsyncSync"];
  readonly lstatSync?: (
    path: PathLike,
  ) => ReturnType<typeof import("node:fs").lstatSync>;
  readonly linkSync?: FsModule["linkSync"];
  readonly mkdirSync?: FsModule["mkdirSync"];
  readonly openSync?: FsModule["openSync"];
  readonly realpathSync?: (path: PathLike) => string;
  readonly rmSync?: FsModule["rmSync"];
  readonly writeFileSync?: FsModule["writeFileSync"];
}

const DEBUG_ENV_KEY = "KEEL_DEBUG";

function errno(code: string): Error & { readonly code: string } {
  return Object.assign(new Error(code), { code });
}

function expectWriteError(
  action: () => unknown,
  code: KeelErrorCode,
  message: string,
): void {
  try {
    action();
    throw new Error("Expected write tool to throw");
  } catch (error) {
    expect(error).toMatchObject({
      name: "KeelError",
      code,
      message: expect.stringContaining(message),
    });
  }
}

async function withWriteWorkspace(
  action: (workspace: string) => Promise<void>,
): Promise<void> {
  const workspace = await mkdtemp(join(tmpdir(), "keel-write-race-"));
  try {
    await action(workspace);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

async function checkpointPath(workspace: string): Promise<string> {
  const result = await git(workspace, [
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "keel/undo-checkpoints.json",
  ]);
  return result.stdout.trim();
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function importWriteWithFs(
  overrides: FsOverrides,
): Promise<typeof import("../../src/tools/write.ts")> {
  vi.resetModules();
  const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
  vi.doMock("node:fs", () => ({ ...actualFs, ...overrides }));
  return import("../../src/tools/write.ts");
}

describe("Write Tool Race Handling", () => {
  afterEach(() => {
    vi.doUnmock("node:fs");
    vi.resetModules();
  });

  test(`Given the target appears after temporary write content is durable,
    When the write tool publishes the new file,
    Then it reports a recoverable file-exists error and leaves the target unchanged`, async () => {
    await withWriteWorkspace(async (workspace) => {
      // Given
      const targetPath = join(workspace, "race.txt");
      const actualFs =
        await vi.importActual<typeof import("node:fs")>("node:fs");
      const { executeWrite } = await importWriteWithFs({
        linkSync: (_existingPath, newPath) => {
          actualFs.writeFileSync(newPath, "user content\n", {
            encoding: "utf8",
            flag: "wx",
          });
          throw errno("EEXIST");
        },
      });

      // When / Then
      expectWriteError(
        () => executeWrite(workspace, "race.txt", "content\n"),
        "tool_file_exists",
        "file already exists",
      );
      expect(await readFile(targetPath, "utf8")).toBe("user content\n");
      expect(await readdir(workspace)).toEqual(
        expect.not.arrayContaining([expect.stringContaining(".keel-write-")]),
      );
    });
  });

  test(`Given a parent segment becomes non-directory during creation,
    When the write tool creates parent directories,
    Then it reports a recoverable not-directory error`, async () => {
    await withWriteWorkspace(async (workspace) => {
      // Given
      const { executeWrite } = await importWriteWithFs({
        mkdirSync: () => {
          throw errno("ENOTDIR");
        },
      });

      // When / Then
      expectWriteError(
        () => executeWrite(workspace, "nested/race.txt", "content\n"),
        "tool_not_directory",
        "parent path is not a directory",
      );
    });
  });

  test(`Given parent directory creation fails unexpectedly,
    When the write tool cannot normalize that failure,
    Then it preserves the original terminal error`, async () => {
    await withWriteWorkspace(async (workspace) => {
      // Given
      const originalError = errno("EIO");
      const { executeWrite } = await importWriteWithFs({
        mkdirSync: () => {
          throw originalError;
        },
      });

      // When / Then
      expect(() =>
        executeWrite(workspace, "nested/io.txt", "content\n"),
      ).toThrow(originalError);
    });
  });

  test(`Given parent directory creation fails after creating an earlier segment,
    When the write tool aborts the create,
    Then it removes the fresh empty parent directories before surfacing the original error`, async () => {
    await withWriteWorkspace(async (workspace) => {
      // Given
      const originalError = errno("EIO");
      const actualFs =
        await vi.importActual<typeof import("node:fs")>("node:fs");
      const { executeWrite } = await importWriteWithFs({
        mkdirSync: (path, options) => {
          if (String(path).endsWith(join("fresh", "nested"))) {
            throw originalError;
          }
          return actualFs.mkdirSync(path, options);
        },
      });

      // When / Then
      expect(() =>
        executeWrite(workspace, "fresh/nested/new.txt", "content\n"),
      ).toThrow(originalError);
      expect(await pathExists(join(workspace, "fresh"))).toBe(false);
    });
  });

  test(`Given a fresh parent directory cannot be validated immediately after creation,
    When the write tool aborts parent creation,
    Then it removes that fresh empty parent directory`, async () => {
    await withWriteWorkspace(async (workspace) => {
      // Given
      const validationError = new Error("fresh parent validation failed");
      const actualFs =
        await vi.importActual<typeof import("node:fs")>("node:fs");
      const { executeWrite } = await importWriteWithFs({
        realpathSync: (path) => {
          if (String(path).endsWith("fresh")) {
            throw validationError;
          }
          return actualFs.realpathSync(path);
        },
      });

      // When / Then
      expect(() =>
        executeWrite(workspace, "fresh/new.txt", "content\n"),
      ).toThrow(validationError);
      expect(await pathExists(join(workspace, "fresh"))).toBe(false);
    });
  });

  test(`Given a missing write parent segment is swapped to an outside symlink during parent creation,
    When the write tool creates the nested parent,
    Then it rejects without creating outside directories, files, temp files, or checkpoint`, async () => {
    const workspace = await createGitWorkspace("keel-write-parent-race-");
    const checkpoint = await checkpointPath(workspace);
    const outside = await mkdtemp(join(tmpdir(), "keel-write-parent-outside-"));
    const targetPath = join(workspace, "race", "nested", "new.txt");
    const outsideNestedPath = join(outside, "nested");
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    let swapped = false;
    const originalCwd = process.cwd();
    const { executeWrite } = await importWriteWithFs({
      mkdirSync: (path, options) => {
        const pathText = String(path);
        if (
          !swapped &&
          (pathText.endsWith(`${sep}race`) ||
            pathText.endsWith(`${sep}${join("race", "nested")}`))
        ) {
          swapped = true;
          actualFs.symlinkSync(outside, join(workspace, "race"), "dir");
        }
        return actualFs.mkdirSync(path, options);
      },
    });

    try {
      // When / Then
      expectWriteError(
        () => executeWrite(workspace, "race/nested/new.txt", "content\n"),
        "tool_path_outside_workspace",
        "outside the workspace",
      );
      expect(process.cwd()).toBe(originalCwd);
      expect(swapped).toBe(true);
      expect(await pathExists(outsideNestedPath)).toBe(false);
      expect(await pathExists(join(outsideNestedPath, "new.txt"))).toBe(false);
      expect(await pathExists(targetPath)).toBe(false);
      expect(await pathExists(checkpoint)).toBe(false);
      expect(await readdir(outside)).toEqual(
        expect.not.arrayContaining([expect.stringContaining(".keel-write-")]),
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test(`Given a missing write parent segment becomes a regular file during parent creation,
    When the write tool enters the created parent,
    Then it reports a recoverable not-directory error`, async () => {
    const workspace = await createGitWorkspace("keel-write-parent-file-race-");
    const parentPath = join(workspace, "race");
    const targetPath = join(parentPath, "nested", "new.txt");
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    let raced = false;
    const { executeWrite } = await importWriteWithFs({
      mkdirSync: (path, options) => {
        const pathText = String(path);
        if (
          !raced &&
          (pathText.endsWith(`${sep}race`) ||
            pathText.endsWith(`${sep}${join("race", "nested")}`))
        ) {
          raced = true;
          actualFs.writeFileSync(parentPath, "not a directory\n", "utf8");
        }
        return actualFs.mkdirSync(path, options);
      },
    });

    try {
      // When / Then
      expectWriteError(
        () => executeWrite(workspace, "race/nested/new.txt", "content\n"),
        "tool_not_directory",
        "parent path is not a directory",
      );
      expect(raced).toBe(true);
      expect(await readFile(parentPath, "utf8")).toBe("not a directory\n");
      expect(await pathExists(targetPath)).toBe(false);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given parent segment lookup fails unexpectedly during parent creation,
    When the write tool checks the next parent segment,
    Then it preserves the original terminal error`, async () => {
    await withWriteWorkspace(async (workspace) => {
      // Given
      const originalError = errno("EIO");
      const actualFs =
        await vi.importActual<typeof import("node:fs")>("node:fs");
      const { executeWrite } = await importWriteWithFs({
        lstatSync: (path) => {
          if (String(path).endsWith(`${sep}race`)) throw originalError;
          return actualFs.lstatSync(path);
        },
      });

      // When / Then
      expect(() =>
        executeWrite(workspace, "race/new.txt", "content\n"),
      ).toThrow(originalError);
    });
  });

  test(`Given a created parent directory loses search permission before entry,
    When the write tool enters that parent,
    Then it preserves the original terminal error`, async () => {
    await withWriteWorkspace(async (workspace) => {
      // Given
      const parentPath = join(workspace, "race");
      const actualFs =
        await vi.importActual<typeof import("node:fs")>("node:fs");
      let restricted = false;
      const { executeWrite } = await importWriteWithFs({
        mkdirSync: (path, options) => {
          const result = actualFs.mkdirSync(path, options);
          const pathText = String(path);
          if (!restricted && pathText.endsWith("race")) {
            restricted = true;
            actualFs.chmodSync(parentPath, 0);
          }
          return result;
        },
      });

      try {
        // When / Then
        try {
          executeWrite(workspace, "race/new.txt", "content\n");
          throw new Error("Expected write tool to throw");
        } catch (error) {
          expect(error).toMatchObject({ code: "EACCES" });
        }
        expect(restricted).toBe(true);
      } finally {
        if (actualFs.existsSync(parentPath)) {
          actualFs.chmodSync(parentPath, 0o700);
        }
      }
    });
  });

  test(`Given a parent directory realpath escapes after directory creation,
    When the write tool revalidates the parent before writing,
    Then it rejects the escaped parent path`, async () => {
    await withWriteWorkspace(async (workspace) => {
      // Given
      const outside = await mkdtemp(join(tmpdir(), "keel-write-outside-"));
      const actualFs =
        await vi.importActual<typeof import("node:fs")>("node:fs");
      const { executeWrite } = await importWriteWithFs({
        realpathSync: (path) => {
          if (String(path).endsWith("nested")) return outside;
          return actualFs.realpathSync(path);
        },
      });

      try {
        // When / Then
        expectWriteError(
          () => executeWrite(workspace, "nested/file.txt", "content\n"),
          "tool_path_outside_workspace",
          "outside the workspace",
        );
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });

  test(`Given a parent directory is replaced by an outside symlink after write validation,
    When the write tool publishes the new file,
    Then it rejects the escaped target without creating the outside file`, async () => {
    await withWriteWorkspace(async (workspace) => {
      // Given
      const parentPath = join(workspace, "race");
      const targetPath = join(parentPath, "new.txt");
      const outside = await mkdtemp(join(tmpdir(), "keel-write-toc-outside-"));
      const actualFs =
        await vi.importActual<typeof import("node:fs")>("node:fs");
      let swapped = false;
      const { executeWrite } = await importWriteWithFs({
        realpathSync: (path) => {
          const resolved = actualFs.realpathSync(path);
          if (!swapped && String(path).endsWith(`${join("race")}`)) {
            swapped = true;
            const racedParent = String(path);
            actualFs.rmSync(racedParent, { recursive: true, force: true });
            actualFs.symlinkSync(outside, racedParent, "dir");
          }
          return resolved;
        },
      });

      try {
        // When / Then
        expectWriteError(
          () => executeWrite(workspace, "race/new.txt", "outside-write\n"),
          "tool_path_outside_workspace",
          "outside the workspace",
        );
        expect(await pathExists(join(outside, "new.txt"))).toBe(false);
        expect(await pathExists(targetPath)).toBe(false);
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });

  test(`Given a write parent is moved outside after final publish validation,
    When the write tool hard-links the new file through the raced path,
    Then it rolls back the escaped file before reporting the boundary failure`, async () => {
    await withWriteWorkspace(async (workspace) => {
      // Given
      const parentPath = join(workspace, "race");
      const outside = await mkdtemp(join(tmpdir(), "keel-write-link-outside-"));
      const outsideParentPath = join(outside, "race");
      const actualFs =
        await vi.importActual<typeof import("node:fs")>("node:fs");
      actualFs.mkdirSync(parentPath);
      let swapped = false;
      const { executeWrite } = await importWriteWithFs({
        linkSync: (existingPath, newPath) => {
          if (!swapped && String(newPath).endsWith(join("race", "new.txt"))) {
            swapped = true;
            actualFs.renameSync(parentPath, outsideParentPath);
            actualFs.symlinkSync(outsideParentPath, parentPath, "dir");
          }
          return actualFs.linkSync(existingPath, newPath);
        },
      });

      try {
        // When / Then
        expectWriteError(
          () => executeWrite(workspace, "race/new.txt", "outside-link\n"),
          "tool_path_outside_workspace",
          "outside the workspace",
        );
        expect(await pathExists(join(outsideParentPath, "new.txt"))).toBe(
          false,
        );
        expect(await readdir(outsideParentPath)).toEqual(
          expect.not.arrayContaining([expect.stringContaining(".keel-write-")]),
        );
        expect(swapped).toBe(true);
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });

  test(`Given a write parent is swapped to an ignored directory during publish,
    When the write tool verifies the published file identity,
    Then it removes the ignored file before reporting the ignored path`, async () => {
    await withWriteWorkspace(async (workspace) => {
      // Given
      const parentPath = join(workspace, "race");
      const backupParentPath = join(workspace, "race-backup");
      const ignoredPath = join(workspace, "private");
      const ignoredTargetPath = join(ignoredPath, "new.txt");
      const actualFs =
        await vi.importActual<typeof import("node:fs")>("node:fs");
      actualFs.writeFileSync(join(workspace, ".gitignore"), "private/\n");
      actualFs.mkdirSync(parentPath);
      actualFs.mkdirSync(ignoredPath);
      let swapped = false;
      const { executeWrite } = await importWriteWithFs({
        linkSync: (existingPath, newPath) => {
          if (!swapped && String(newPath).endsWith(join("race", "new.txt"))) {
            swapped = true;
            actualFs.renameSync(parentPath, backupParentPath);
            actualFs.symlinkSync(ignoredPath, parentPath, "dir");
            return actualFs.linkSync(
              join(backupParentPath, basename(String(existingPath))),
              newPath,
            );
          }
          return actualFs.linkSync(existingPath, newPath);
        },
      });

      // When / Then
      expectWriteError(
        () => executeWrite(workspace, "race/new.txt", "ignored\n"),
        "tool_path_ignored",
        "ignored path",
      );
      expect(await pathExists(ignoredTargetPath)).toBe(false);
      expect(swapped).toBe(true);
    });
  });

  test(`Given a write parent becomes ignored after initial target validation,
    When the write tool revalidates before opening the temp file,
    Then it rejects without creating ignored content`, async () => {
    await withWriteWorkspace(async (workspace) => {
      // Given
      const parentPath = join(workspace, "race");
      const backupParentPath = join(workspace, "race-backup");
      const ignoredPath = join(workspace, "private");
      const ignoredTargetPath = join(ignoredPath, "new.txt");
      const actualFs =
        await vi.importActual<typeof import("node:fs")>("node:fs");
      actualFs.writeFileSync(join(workspace, ".gitignore"), "private/\n");
      actualFs.mkdirSync(ignoredPath);
      let parentRealpathCalls = 0;
      const { executeWrite } = await importWriteWithFs({
        realpathSync: (path) => {
          if (String(path).endsWith(join("race"))) {
            parentRealpathCalls++;
            if (parentRealpathCalls === 3) {
              actualFs.renameSync(parentPath, backupParentPath);
              actualFs.symlinkSync(ignoredPath, parentPath, "dir");
            }
          }
          return actualFs.realpathSync(path);
        },
      });

      // When / Then
      expectWriteError(
        () => executeWrite(workspace, "race/new.txt", "ignored\n"),
        "tool_path_ignored",
        "ignored path",
      );
      expect(await pathExists(ignoredTargetPath)).toBe(false);
      expect(parentRealpathCalls).toBeGreaterThanOrEqual(3);
    });
  });

  test(`Given a published write target is replaced by a directory before verification,
    When the write tool validates the published identity,
    Then it reports the non-file target without removing the concurrent directory`, async () => {
    await withWriteWorkspace(async (workspace) => {
      // Given
      const parentPath = join(workspace, "race");
      const targetPath = join(parentPath, "new.txt");
      const actualFs =
        await vi.importActual<typeof import("node:fs")>("node:fs");
      actualFs.mkdirSync(parentPath);
      let swapped = false;
      const { executeWrite } = await importWriteWithFs({
        linkSync: (existingPath, newPath) => {
          actualFs.linkSync(existingPath, newPath);
          if (!swapped && String(newPath).endsWith(join("race", "new.txt"))) {
            swapped = true;
            actualFs.rmSync(newPath, { force: true });
            actualFs.mkdirSync(newPath);
          }
        },
      });

      // When / Then
      expectWriteError(
        () => executeWrite(workspace, "race/new.txt", "content\n"),
        "tool_not_file",
        "unsupported file type",
      );
      expect(await readdir(targetPath)).toEqual([]);
      expect(swapped).toBe(true);
    });
  });

  test(`Given a published write path is replaced by another workspace file before verification,
    When the write tool compares the published identity,
    Then it preserves the concurrent replacement and reports a boundary failure`, async () => {
    await withWriteWorkspace(async (workspace) => {
      // Given
      const targetPath = join(workspace, "race.txt");
      const actualFs =
        await vi.importActual<typeof import("node:fs")>("node:fs");
      let replaced = false;
      const { executeWrite } = await importWriteWithFs({
        linkSync: (existingPath, newPath) => {
          actualFs.linkSync(existingPath, newPath);
          if (!replaced && String(newPath).endsWith("race.txt")) {
            replaced = true;
            actualFs.rmSync(newPath, { force: true });
            actualFs.writeFileSync(newPath, "user\n", "utf8");
          }
        },
      });

      // When / Then
      expectWriteError(
        () => executeWrite(workspace, "race.txt", "content\n"),
        "tool_path_outside_workspace",
        "outside the workspace",
      );
      expect(await readFile(targetPath, "utf8")).toBe("user\n");
      expect(replaced).toBe(true);
    });
  });

  test(`Given a write temp file opens in an outside-swapped parent that is restored before cleanup,
    When the write tool verifies the opened temp file,
    Then it rejects without leaking caller content in the outside directory`, async () => {
    await withWriteWorkspace(async (workspace) => {
      // Given
      const parentPath = join(workspace, "race");
      const backupParentPath = join(workspace, "race-backup");
      const outside = await mkdtemp(join(tmpdir(), "keel-write-temp-outside-"));
      const actualFs =
        await vi.importActual<typeof import("node:fs")>("node:fs");
      actualFs.mkdirSync(parentPath);
      let swapped = false;
      let restored = false;
      const restoreParent = (): void => {
        if (!swapped || restored) return;
        restored = true;
        actualFs.rmSync(parentPath, { force: true });
        actualFs.renameSync(backupParentPath, parentPath);
      };
      const { executeWrite } = await importWriteWithFs({
        openSync: (path, flags, mode) => {
          if (!swapped && String(path).includes(".keel-write-")) {
            swapped = true;
            actualFs.renameSync(parentPath, backupParentPath);
            actualFs.symlinkSync(outside, parentPath, "dir");
          }
          return actualFs.openSync(path, flags, mode);
        },
        realpathSync: (path) => {
          const resolved = actualFs.realpathSync(path);
          if (
            swapped &&
            !restored &&
            (String(path).includes(".keel-write-") ||
              String(path).endsWith(join("race")))
          ) {
            restoreParent();
          }
          return resolved;
        },
      });

      try {
        // When / Then
        expect(() =>
          executeWrite(workspace, "race/new.txt", "outside-temp\n"),
        ).toThrow();
        expect(await readdir(outside)).toEqual(
          expect.not.arrayContaining([expect.stringContaining(".keel-write-")]),
        );
        expect(await pathExists(join(outside, "new.txt"))).toBe(false);
      } finally {
        restoreParent();
        await rm(outside, { recursive: true, force: true });
      }
    });
  });

  test(`Given a write temp path is replaced after open,
    When the write tool compares the opened descriptor identity,
    Then it rejects without publishing the target or leaving temp content`, async () => {
    await withWriteWorkspace(async (workspace) => {
      // Given
      const parentPath = join(workspace, "race");
      const targetPath = join(parentPath, "new.txt");
      const actualFs =
        await vi.importActual<typeof import("node:fs")>("node:fs");
      actualFs.mkdirSync(parentPath);
      let replaced = false;
      const { executeWrite } = await importWriteWithFs({
        realpathSync: (path) => {
          const resolved = actualFs.realpathSync(path);
          if (!replaced && String(path).includes(".keel-write-")) {
            replaced = true;
            const replacementPath = `${resolved}.replacement`;
            actualFs.writeFileSync(replacementPath, "other\n", "utf8");
            actualFs.rmSync(resolved, { force: true });
            actualFs.renameSync(replacementPath, resolved);
          }
          return resolved;
        },
      });

      // When / Then
      expect(() =>
        executeWrite(workspace, "race/new.txt", "content\n"),
      ).toThrow("opened temp file no longer matches path");
      expect(await pathExists(targetPath)).toBe(false);
      expect(await readdir(parentPath)).toEqual([]);
      expect(replaced).toBe(true);
    });
  });

  test(`Given a validated write parent is swapped to an ignored workspace directory,
    When the write tool revalidates the publish target,
    Then it rejects without creating ignored content`, async () => {
    await withWriteWorkspace(async (workspace) => {
      // Given
      const parentPath = join(workspace, "race");
      const ignoredPath = join(workspace, "private");
      const targetPath = join(parentPath, "new.txt");
      const actualFs =
        await vi.importActual<typeof import("node:fs")>("node:fs");
      actualFs.writeFileSync(join(workspace, ".gitignore"), "private/\n");
      actualFs.mkdirSync(ignoredPath);
      let swapped = false;
      const { executeWrite } = await importWriteWithFs({
        realpathSync: (path) => {
          const resolved = actualFs.realpathSync(path);
          if (!swapped && String(path).endsWith(join("race"))) {
            swapped = true;
            actualFs.rmSync(parentPath, { recursive: true, force: true });
            actualFs.symlinkSync(ignoredPath, parentPath, "dir");
          }
          return resolved;
        },
      });

      // When / Then
      expectWriteError(
        () => executeWrite(workspace, "race/new.txt", "ignored\n"),
        "tool_path_ignored",
        "ignored path",
      );
      expect(await pathExists(join(ignoredPath, "new.txt"))).toBe(false);
      expect(await pathExists(targetPath)).toBe(false);
    });
  });

  test(`Given a write temp file is moved inside the workspace before a write failure,
    When atomic cleanup runs by opened temp identity,
    Then no temp file remains in the moved directory`, async () => {
    await withWriteWorkspace(async (workspace) => {
      // Given
      const parentPath = join(workspace, "race");
      const backupParentPath = join(workspace, "race-backup");
      const originalError = errno("EIO");
      const actualFs =
        await vi.importActual<typeof import("node:fs")>("node:fs");
      actualFs.mkdirSync(parentPath);
      let moved = false;
      const { executeWrite } = await importWriteWithFs({
        writeFileSync: (file, data, options) => {
          actualFs.writeFileSync(file, data, options);
          if (!moved && typeof file === "number") {
            moved = true;
            actualFs.renameSync(parentPath, backupParentPath);
            throw originalError;
          }
        },
      });

      // When / Then
      expect(() =>
        executeWrite(workspace, "race/new.txt", "content\n"),
      ).toThrow(originalError);
      expect(await readdir(backupParentPath)).toEqual(
        expect.not.arrayContaining([expect.stringContaining(".keel-write-")]),
      );
      expect(moved).toBe(true);
    });
  });

  test(`Given the filesystem fails after writing partial bytes for a new file,
    When the write tool cannot finish creation,
    Then no final target, temp file, or create checkpoint remains`, async () => {
    const workspace = await createGitWorkspace("keel-write-race-");
    const targetPath = join(workspace, "partial.txt");
    const checkpoint = await checkpointPath(workspace);

    try {
      // Given
      const originalError = errno("EIO");
      const actualFs =
        await vi.importActual<typeof import("node:fs")>("node:fs");
      const { executeWrite } = await importWriteWithFs({
        writeFileSync: (path, _data, options) => {
          actualFs.writeFileSync(path, "partial", options);
          throw originalError;
        },
      });

      // When / Then
      expect(() =>
        executeWrite(workspace, "partial.txt", "complete\n"),
      ).toThrow(originalError);
      await expect(readFile(targetPath, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await pathExists(checkpoint)).toBe(false);
      expect(await readdir(workspace)).toEqual(
        expect.not.arrayContaining([expect.stringContaining(".keel-write-")]),
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given temporary file durability fails before a new file is published,
    When the write tool aborts creation,
    Then it preserves the filesystem error and removes the temporary file`, async () => {
    await withWriteWorkspace(async (workspace) => {
      // Given
      const originalError = errno("EIO");
      const { executeWrite } = await importWriteWithFs({
        fsyncSync: () => {
          throw originalError;
        },
      });

      // When / Then
      expect(() => executeWrite(workspace, "new.txt", "content\n")).toThrow(
        originalError,
      );
      expect(await pathExists(join(workspace, "new.txt"))).toBe(false);
      expect(await readdir(workspace)).toEqual(
        expect.not.arrayContaining([expect.stringContaining(".keel-write-")]),
      );
    });
  });

  test(`Given directory fsync is unsupported after a new file is published,
    When the write tool completes creation,
    Then it keeps the durable file and reports success`, async () => {
    await withWriteWorkspace(async (workspace) => {
      // Given
      const workspacePath = await realpath(workspace);
      const actualFs =
        await vi.importActual<typeof import("node:fs")>("node:fs");
      const { executeWrite } = await importWriteWithFs({
        openSync: (path, flags, mode) => {
          if (String(path) === workspacePath && flags === "r") {
            throw errno("EINVAL");
          }
          return actualFs.openSync(path, flags, mode);
        },
      });

      // When
      const result = executeWrite(workspace, "new.txt", "content\n");

      // Then
      expect(result.content).toBe("Wrote new.txt");
      expect(await readFile(join(workspace, "new.txt"), "utf8")).toBe(
        "content\n",
      );
    });
  });

  test(`Given the write tool creates fresh parents before publish fails,
    When the create aborts after parent creation,
    Then it removes the fresh empty parent directories`, async () => {
    await withWriteWorkspace(async (workspace) => {
      // Given
      const originalError = errno("EIO");
      const actualFs =
        await vi.importActual<typeof import("node:fs")>("node:fs");
      const { executeWrite } = await importWriteWithFs({
        linkSync: () => {
          throw originalError;
        },
      });

      // When / Then
      expect(() =>
        executeWrite(workspace, "fresh/nested/new.txt", "content\n"),
      ).toThrow(originalError);
      expect(await pathExists(join(workspace, "fresh"))).toBe(false);
      expect(await readdir(workspace)).toEqual(
        expect.not.arrayContaining([expect.stringContaining(".keel-write-")]),
      );
      expect(actualFs.existsSync(join(workspace, "fresh", "nested"))).toBe(
        false,
      );
    });
  });

  test(`Given a concurrent file appears in fresh parents before publish fails,
    When the write tool rolls back the failed creation,
    Then it preserves the concurrent file and the original publish error`, async () => {
    await withWriteWorkspace(async (workspace) => {
      // Given
      const originalError = errno("EIO");
      const actualFs =
        await vi.importActual<typeof import("node:fs")>("node:fs");
      const concurrentPath = join(workspace, "fresh", "nested", "user.txt");
      const { executeWrite } = await importWriteWithFs({
        linkSync: (_existingPath, _newPath) => {
          actualFs.writeFileSync(concurrentPath, "user\n", "utf8");
          throw originalError;
        },
      });

      // When / Then
      expect(() =>
        executeWrite(workspace, "fresh/nested/new.txt", "content\n"),
      ).toThrow(originalError);
      expect(await readFile(concurrentPath, "utf8")).toBe("user\n");
      expect(
        await pathExists(join(workspace, "fresh", "nested", "new.txt")),
      ).toBe(false);
      expect(await readdir(join(workspace, "fresh", "nested"))).toEqual([
        "user.txt",
      ]);
    });
  });

  test(`Given debug logging is enabled and temp cleanup fails after create publish,
    When the write tool finishes the create,
    Then it reports cleanup metadata without failing or logging file contents`, async () => {
    const workspace = await createGitWorkspace("keel-write-race-");
    const targetPath = join(await realpath(workspace), "created.txt");
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
      // Given
      const actualFs =
        await vi.importActual<typeof import("node:fs")>("node:fs");
      const { executeWrite } = await importWriteWithFs({
        rmSync: (path, options) => {
          if (String(path).includes(".keel-write-")) {
            throw errno("EACCES");
          }
          return actualFs.rmSync(path, options);
        },
      });

      // When
      const result = executeWrite(workspace, "created.txt", "secret\n");

      // Then
      expect(result.content).toBe("Wrote created.txt");
      expect(await readFile(targetPath, "utf8")).toBe("secret\n");
      expect(debugOutput).toContain("write temp cleanup failed");
      expect(debugOutput).toContain(`targetPath=${targetPath}`);
      expect(debugOutput).toContain(".keel-write-");
      expect(debugOutput).toContain("error=");
      expect(debugOutput).not.toContain("secret");
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

  test(`Given publishing the created file reports a parent path collision,
    When the write tool normalizes the write failure,
    Then it reports a recoverable not-directory error`, async () => {
    await withWriteWorkspace(async (workspace) => {
      // Given
      const { executeWrite } = await importWriteWithFs({
        linkSync: () => {
          throw errno("ENOTDIR");
        },
      });

      // When / Then
      expectWriteError(
        () => executeWrite(workspace, "race.txt", "content\n"),
        "tool_not_directory",
        "parent path is not a directory",
      );
    });
  });

  test(`Given create-path existence validation sees an unexpected filesystem error,
    When the write tool validates the target,
    Then it preserves the original terminal error`, async () => {
    await withWriteWorkspace(async (workspace) => {
      // Given
      const originalError = errno("EIO");
      const actualFs =
        await vi.importActual<typeof import("node:fs")>("node:fs");
      const { executeWrite } = await importWriteWithFs({
        lstatSync: (path) => {
          if (String(path).endsWith("target.txt")) throw originalError;
          return actualFs.lstatSync(path);
        },
      });

      // When / Then
      expect(() => executeWrite(workspace, "target.txt", "content\n")).toThrow(
        originalError,
      );
    });
  });

  test(`Given an existing ancestor is no longer a directory after target validation,
    When the write tool validates that ancestor,
    Then it reports a recoverable not-directory error`, async () => {
    await withWriteWorkspace(async (workspace) => {
      // Given
      await writeFile(join(workspace, "parent"), "not a directory\n", "utf8");
      const actualFs =
        await vi.importActual<typeof import("node:fs")>("node:fs");
      const { executeWrite } = await importWriteWithFs({
        lstatSync: (path) => {
          if (String(path).endsWith(join("parent", "child.txt"))) {
            throw errno("ENOENT");
          }
          return actualFs.lstatSync(path);
        },
      });

      // When / Then
      expectWriteError(
        () => executeWrite(workspace, "parent/child.txt", "content\n"),
        "tool_not_directory",
        "parent path is not a directory",
      );
    });
  });

  test(`Given the filesystem reports an unexpected write failure,
    When the write tool cannot normalize that failure,
    Then it preserves the original terminal error`, async () => {
    await withWriteWorkspace(async (workspace) => {
      // Given
      const originalError = errno("EIO");
      const { executeWrite } = await importWriteWithFs({
        writeFileSync: () => {
          throw originalError;
        },
      });

      // When / Then
      expect(() => executeWrite(workspace, "io.txt", "content\n")).toThrow(
        originalError,
      );
    });
  });
});
