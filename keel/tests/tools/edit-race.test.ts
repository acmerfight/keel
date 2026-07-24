import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { KeelErrorCode } from "../../src/core/error.ts";

type PathLike = Parameters<typeof import("node:fs").realpathSync>[0];
type FsModule = typeof import("node:fs");

interface FsOverrides {
  readonly openSync?: FsModule["openSync"];
  readonly realpathSync?: (path: PathLike) => string;
  readonly renameSync?: FsModule["renameSync"];
}

function expectEditError(
  action: () => unknown,
  code: KeelErrorCode,
  message: string,
): void {
  try {
    action();
    throw new Error("Expected edit tool to throw");
  } catch (error) {
    expect(error).toMatchObject({
      name: "KeelError",
      code,
      message: expect.stringContaining(message),
    });
  }
}

async function importEditWithFs(
  overrides: FsOverrides,
): Promise<typeof import("../../src/tools/edit.ts")> {
  vi.resetModules();
  const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
  vi.doMock("node:fs", () => ({ ...actualFs, ...overrides }));
  return import("../../src/tools/edit.ts");
}

describe("Edit Tool Race Handling", () => {
  afterEach(() => {
    vi.doUnmock("node:fs");
    vi.resetModules();
  });

  test(`Given a resolved edit parent is replaced by an outside symlink,
    When the edit tool writes the validated target path,
    Then it rejects the escaped target and leaves the outside file unchanged`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-edit-race-"));
    const parentPath = join(workspace, "race");
    const targetPath = join(parentPath, "note.txt");
    const outside = await mkdtemp(join(tmpdir(), "keel-edit-toc-outside-"));
    await mkdir(parentPath);
    await writeFile(targetPath, "old\n", "utf8");
    await writeFile(join(outside, "note.txt"), "old\n", "utf8");
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    let swapped = false;
    const { executeEdit } = await importEditWithFs({
      realpathSync: (path) => {
        const resolved = actualFs.realpathSync(path);
        if (!swapped && String(path).endsWith(join("race", "note.txt"))) {
          swapped = true;
          const racedParent = dirname(String(path));
          actualFs.rmSync(racedParent, { recursive: true, force: true });
          actualFs.symlinkSync(outside, racedParent, "dir");
        }
        return resolved;
      },
    });

    try {
      // When / Then
      expectEditError(
        () =>
          executeEdit(
            workspace,
            "race/note.txt",
            [{ oldText: "old", newText: "new" }],
            { readBeforeEdit: { revisionStatus: () => "current" } },
          ),
        "tool_path_outside_workspace",
        "outside the workspace",
      );
      expect(await readFile(join(outside, "note.txt"), "utf8")).toBe("old\n");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test(`Given an edit temp file opens in an outside-swapped parent that is restored before cleanup,
    When the edit tool verifies the opened temp file,
    Then it rejects without leaking replacement content in the outside directory`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-edit-temp-race-"));
    const parentPath = join(workspace, "race");
    const backupParentPath = join(workspace, "race-backup");
    const targetPath = join(parentPath, "note.txt");
    const outside = await mkdtemp(join(tmpdir(), "keel-edit-temp-outside-"));
    await mkdir(parentPath);
    await writeFile(targetPath, "old\n", "utf8");
    await writeFile(join(outside, "note.txt"), "old\n", "utf8");
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    let swapped = false;
    let restored = false;
    const restoreParent = (): void => {
      if (!swapped || restored) return;
      restored = true;
      actualFs.rmSync(parentPath, { force: true });
      actualFs.renameSync(backupParentPath, parentPath);
    };
    const { executeEdit } = await importEditWithFs({
      openSync: (path, flags, mode) => {
        if (!swapped && String(path).includes(".keel-edit-")) {
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
          (String(path).includes(".keel-edit-") ||
            String(path).endsWith(join("race", "note.txt")))
        ) {
          restoreParent();
        }
        return resolved;
      },
    });

    try {
      // When / Then
      expect(() =>
        executeEdit(
          workspace,
          "race/note.txt",
          [{ oldText: "old", newText: "new" }],
          { readBeforeEdit: { revisionStatus: () => "current" } },
        ),
      ).toThrow();
      expect(await readdir(outside)).toEqual(
        expect.not.arrayContaining([expect.stringContaining(".keel-edit-")]),
      );
      expect(await readFile(join(outside, "note.txt"), "utf8")).toBe("old\n");
    } finally {
      restoreParent();
      await rm(workspace, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test(`Given an edit target opens through an ignored workspace symlink,
    When the editable text reader rechecks the opened descriptor path,
    Then it rejects before reading ignored content for matching`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-edit-open-ignore-"));
    const targetPath = join(workspace, "note.txt");
    const ignoredPath = join(workspace, "private");
    const ignoredTargetPath = join(ignoredPath, "note.txt");
    await mkdir(ignoredPath);
    await writeFile(join(workspace, ".gitignore"), "private/\n", "utf8");
    await writeFile(targetPath, "old\n", "utf8");
    await writeFile(ignoredTargetPath, "old\n", "utf8");
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    let swapped = false;
    const { executeEdit } = await importEditWithFs({
      openSync: (path, flags, mode) => {
        if (!swapped && String(path).endsWith("note.txt")) {
          swapped = true;
          actualFs.rmSync(targetPath, { force: true });
          actualFs.symlinkSync(ignoredTargetPath, targetPath);
        }
        return actualFs.openSync(path, flags, mode);
      },
    });

    try {
      // When / Then
      expectEditError(
        () =>
          executeEdit(
            workspace,
            "note.txt",
            [{ oldText: "old", newText: "new" }],
            { readBeforeEdit: { revisionStatus: () => "current" } },
          ),
        "tool_path_ignored",
        "ignored path",
      );
      expect(await readFile(ignoredTargetPath, "utf8")).toBe("old\n");
      expect(swapped).toBe(true);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an edit target opens as a different workspace file after initial read validation,
    When read-before-edit is rechecked on the opened descriptor path,
    Then it rejects without editing the unread file`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-edit-open-unread-"));
    const targetPath = join(workspace, "note.txt");
    const alternatePath = join(workspace, "alternate.txt");
    await writeFile(targetPath, "old\n", "utf8");
    await writeFile(alternatePath, "old\n", "utf8");
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const readTargetPath = actualFs.realpathSync(targetPath);
    let swapped = false;
    const { executeEdit } = await importEditWithFs({
      openSync: (path, flags, mode) => {
        if (!swapped && String(path) === readTargetPath) {
          swapped = true;
          actualFs.rmSync(targetPath, { force: true });
          actualFs.symlinkSync(alternatePath, targetPath);
        }
        return actualFs.openSync(path, flags, mode);
      },
    });

    try {
      // When / Then
      expectEditError(
        () =>
          executeEdit(
            workspace,
            "note.txt",
            [{ oldText: "old", newText: "new" }],
            {
              readBeforeEdit: {
                revisionStatus: (path) =>
                  path === readTargetPath ? "current" : "unread",
              },
            },
          ),
        "tool_file_not_read",
        "file has not been read",
      );
      expect(await readFile(alternatePath, "utf8")).toBe("old\n");
      expect(swapped).toBe(true);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an edit parent is moved outside after final publish validation,
    When the edit tool renames the replacement through the raced path,
    Then it restores the escaped file content before reporting the boundary failure`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-edit-rename-race-"));
    const parentPath = join(workspace, "race");
    const outside = await mkdtemp(join(tmpdir(), "keel-edit-rename-outside-"));
    const outsideParentPath = join(outside, "race");
    const targetPath = join(parentPath, "note.txt");
    await mkdir(parentPath);
    await writeFile(targetPath, "old\n", "utf8");
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    let swapped = false;
    const { executeEdit } = await importEditWithFs({
      renameSync: (oldPath, newPath) => {
        if (
          !swapped &&
          String(oldPath).includes(".keel-edit-") &&
          String(newPath).endsWith(join("race", "note.txt"))
        ) {
          swapped = true;
          actualFs.renameSync(parentPath, outsideParentPath);
          actualFs.symlinkSync(outsideParentPath, parentPath, "dir");
        }
        return actualFs.renameSync(oldPath, newPath);
      },
    });

    try {
      // When / Then
      expectEditError(
        () =>
          executeEdit(
            workspace,
            "race/note.txt",
            [{ oldText: "old", newText: "new" }],
            { readBeforeEdit: { revisionStatus: () => "current" } },
          ),
        "tool_path_outside_workspace",
        "outside the workspace",
      );
      expect(await readFile(join(outsideParentPath, "note.txt"), "utf8")).toBe(
        "old\n",
      );
      expect(swapped).toBe(true);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test(`Given an edit parent is swapped to an ignored directory during publish,
    When the edit tool verifies the published file identity,
    Then it restores the ignored file before reporting the ignored path`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-edit-publish-ignore-"),
    );
    const parentPath = join(workspace, "race");
    const backupParentPath = join(workspace, "race-backup");
    const ignoredPath = join(workspace, "private");
    const targetPath = join(parentPath, "note.txt");
    const ignoredTargetPath = join(ignoredPath, "note.txt");
    await writeFile(join(workspace, ".gitignore"), "private/\n", "utf8");
    await mkdir(parentPath);
    await mkdir(ignoredPath);
    await writeFile(targetPath, "old\n", "utf8");
    await writeFile(ignoredTargetPath, "old\n", "utf8");
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    let swapped = false;
    const { executeEdit } = await importEditWithFs({
      renameSync: (oldPath, newPath) => {
        if (
          !swapped &&
          String(oldPath).includes(".keel-edit-") &&
          String(newPath).endsWith(join("race", "note.txt"))
        ) {
          swapped = true;
          actualFs.renameSync(parentPath, backupParentPath);
          actualFs.symlinkSync(ignoredPath, parentPath, "dir");
          return actualFs.renameSync(
            join(backupParentPath, basename(String(oldPath))),
            newPath,
          );
        }
        return actualFs.renameSync(oldPath, newPath);
      },
    });

    try {
      // When / Then
      expectEditError(
        () =>
          executeEdit(
            workspace,
            "race/note.txt",
            [{ oldText: "old", newText: "new" }],
            { readBeforeEdit: { revisionStatus: () => "current" } },
          ),
        "tool_path_ignored",
        "ignored path",
      );
      expect(await readFile(ignoredTargetPath, "utf8")).toBe("old\n");
      expect(swapped).toBe(true);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an escaped edit replacement is changed concurrently before rollback,
    When publish verification fails,
    Then rollback preserves the concurrent content`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-edit-rollback-skip-"));
    const parentPath = join(workspace, "race");
    const outside = await mkdtemp(join(tmpdir(), "keel-edit-skip-outside-"));
    const outsideParentPath = join(outside, "race");
    const targetPath = join(parentPath, "note.txt");
    await mkdir(parentPath);
    await writeFile(targetPath, "old\n", "utf8");
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    let swapped = false;
    const { executeEdit } = await importEditWithFs({
      renameSync: (oldPath, newPath) => {
        if (
          !swapped &&
          String(oldPath).includes(".keel-edit-") &&
          String(newPath).endsWith(join("race", "note.txt"))
        ) {
          swapped = true;
          actualFs.renameSync(parentPath, outsideParentPath);
          actualFs.symlinkSync(outsideParentPath, parentPath, "dir");
          actualFs.renameSync(oldPath, newPath);
          actualFs.writeFileSync(newPath, "user\n", "utf8");
          return;
        }
        return actualFs.renameSync(oldPath, newPath);
      },
    });

    try {
      // When / Then
      expectEditError(
        () =>
          executeEdit(
            workspace,
            "race/note.txt",
            [{ oldText: "old", newText: "new" }],
            { readBeforeEdit: { revisionStatus: () => "current" } },
          ),
        "tool_path_outside_workspace",
        "outside the workspace",
      );
      expect(await readFile(join(outsideParentPath, "note.txt"), "utf8")).toBe(
        "user\n",
      );
      expect(swapped).toBe(true);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test(`Given an edit target changes to a different in-workspace file after read validation,
    When read-before-edit is checked against the access-time target,
    Then it rejects without editing the unread file`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-edit-read-race-"));
    const targetPath = join(workspace, "note.txt");
    const backupTargetPath = join(workspace, "note-original.txt");
    const alternatePath = join(workspace, "alternate.txt");
    await writeFile(targetPath, "old\n", "utf8");
    await writeFile(alternatePath, "old\n", "utf8");
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const readTargetPath = actualFs.realpathSync(targetPath);
    let swapped = false;
    const { executeEdit } = await importEditWithFs({
      realpathSync: (path) => {
        const resolved = actualFs.realpathSync(path);
        if (!swapped && String(path) === readTargetPath) {
          swapped = true;
          actualFs.renameSync(targetPath, backupTargetPath);
          actualFs.symlinkSync(alternatePath, targetPath);
        }
        return resolved;
      },
    });

    try {
      // When / Then
      expectEditError(
        () =>
          executeEdit(
            workspace,
            "note.txt",
            [{ oldText: "old", newText: "new" }],
            {
              readBeforeEdit: {
                revisionStatus: (path) =>
                  path === readTargetPath ? "current" : "unread",
              },
            },
          ),
        "tool_file_not_read",
        "file has not been read",
      );
      expect(await readFile(alternatePath, "utf8")).toBe("old\n");
      expect(swapped).toBe(true);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an edit source file opens through an outside-swapped parent restored before validation,
    When the editable text reader verifies the opened descriptor,
    Then it rejects before using outside content for matching`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-edit-source-race-"));
    const parentPath = join(workspace, "race");
    const backupParentPath = join(workspace, "race-backup");
    const targetPath = join(parentPath, "note.txt");
    const outside = await mkdtemp(join(tmpdir(), "keel-edit-source-outside-"));
    await mkdir(parentPath);
    await writeFile(targetPath, "old\n", "utf8");
    await writeFile(join(outside, "note.txt"), "outside\n", "utf8");
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    let racedOpen = false;
    const { executeEdit } = await importEditWithFs({
      openSync: (path, flags, mode) => {
        if (
          !racedOpen &&
          !String(path).includes(".keel-") &&
          String(path).endsWith(join("race", "note.txt"))
        ) {
          racedOpen = true;
          actualFs.renameSync(parentPath, backupParentPath);
          actualFs.symlinkSync(outside, parentPath, "dir");
          const fd = actualFs.openSync(path, flags, mode);
          actualFs.rmSync(parentPath, { force: true });
          actualFs.renameSync(backupParentPath, parentPath);
          return fd;
        }
        return actualFs.openSync(path, flags, mode);
      },
    });

    try {
      // When / Then
      expectEditError(
        () =>
          executeEdit(
            workspace,
            "race/note.txt",
            [{ oldText: "outside", newText: "new" }],
            { readBeforeEdit: { revisionStatus: () => "current" } },
          ),
        "tool_path_outside_workspace",
        "outside the workspace",
      );
      expect(await readFile(targetPath, "utf8")).toBe("old\n");
      expect(await readFile(join(outside, "note.txt"), "utf8")).toBe(
        "outside\n",
      );
      expect(racedOpen).toBe(true);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test(`Given a validated edit target is swapped to an ignored workspace path before writing,
    When the edit tool revalidates the publish target,
    Then it rejects without modifying ignored content`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-edit-ignore-race-"));
    const parentPath = join(workspace, "race");
    const ignoredPath = join(workspace, "private");
    const targetPath = join(parentPath, "note.txt");
    const ignoredTargetPath = join(ignoredPath, "note.txt");
    await writeFile(join(workspace, ".gitignore"), "private/\n", "utf8");
    await mkdir(parentPath);
    await mkdir(ignoredPath);
    await writeFile(targetPath, "old\n", "utf8");
    await writeFile(ignoredTargetPath, "old\n", "utf8");
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    let swapped = false;
    const { executeEdit } = await importEditWithFs({
      realpathSync: (path) => {
        const resolved = actualFs.realpathSync(path);
        if (!swapped && String(path).endsWith(join("race", "note.txt"))) {
          swapped = true;
          actualFs.rmSync(parentPath, { recursive: true, force: true });
          actualFs.symlinkSync(ignoredPath, parentPath, "dir");
        }
        return resolved;
      },
    });

    try {
      // When / Then
      expectEditError(
        () =>
          executeEdit(
            workspace,
            "race/note.txt",
            [{ oldText: "old", newText: "new" }],
            { readBeforeEdit: { revisionStatus: () => "current" } },
          ),
        "tool_path_ignored",
        "ignored path",
      );
      expect(await readFile(ignoredTargetPath, "utf8")).toBe("old\n");
      expect(swapped).toBe(true);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an edit target resolves to an ignored directory before temp creation,
    When the edit tool performs the pre-write access check,
    Then it rejects before writing replacement content`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-edit-prewrite-ignore-"),
    );
    const parentPath = join(workspace, "race");
    const ignoredPath = join(workspace, "private");
    const targetPath = join(parentPath, "note.txt");
    const ignoredTargetPath = join(ignoredPath, "note.txt");
    await writeFile(join(workspace, ".gitignore"), "private/\n", "utf8");
    await mkdir(parentPath);
    await mkdir(ignoredPath);
    await writeFile(targetPath, "old\n", "utf8");
    await writeFile(ignoredTargetPath, "old\n", "utf8");
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    let targetRealpathCalls = 0;
    let swapped = false;
    const { executeEdit } = await importEditWithFs({
      realpathSync: (path) => {
        if (String(path).endsWith(join("race", "note.txt"))) {
          targetRealpathCalls += 1;
          if (!swapped && targetRealpathCalls === 4) {
            swapped = true;
            actualFs.rmSync(parentPath, { recursive: true, force: true });
            actualFs.symlinkSync(ignoredPath, parentPath, "dir");
          }
        }
        return actualFs.realpathSync(path);
      },
    });

    try {
      // When / Then
      expectEditError(
        () =>
          executeEdit(
            workspace,
            "race/note.txt",
            [{ oldText: "old", newText: "new" }],
            { readBeforeEdit: { revisionStatus: () => "current" } },
          ),
        "tool_path_ignored",
        "ignored path",
      );
      expect(await readFile(ignoredTargetPath, "utf8")).toBe("old\n");
      expect(swapped).toBe(true);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
