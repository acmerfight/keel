import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { KeelErrorCode } from "../../src/core/error.ts";
import {
  createGitWorkspace,
  runGit as git,
} from "../../src/testing/cli-harness.ts";

type PathLike = Parameters<typeof import("node:fs").realpathSync>[0];
type FsModule = typeof import("node:fs");

interface FsOverrides {
  readonly linkSync?: FsModule["linkSync"];
  readonly mkdirSync?: FsModule["mkdirSync"];
  readonly openSync?: FsModule["openSync"];
  readonly realpathSync?: (path: PathLike) => string;
  readonly renameSync?: FsModule["renameSync"];
  readonly statSync?: (
    path: PathLike,
  ) => ReturnType<typeof import("node:fs").statSync>;
}

function expectApplyPatchError(
  action: () => unknown,
  code: KeelErrorCode,
  message: string,
): void {
  try {
    action();
    throw new Error("Expected apply_patch tool to throw");
  } catch (error) {
    expect(error).toMatchObject({
      name: "KeelError",
      code,
      message: expect.stringContaining(message),
    });
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function checkpointPath(workspace: string): Promise<string> {
  const result = await git(workspace, [
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "keel/last-edit-checkpoint.json",
  ]);
  return result.stdout.trim();
}

async function importApplyPatchWithFs(
  overrides: FsOverrides,
): Promise<typeof import("../../src/tools/apply-patch.ts")> {
  vi.resetModules();
  const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
  vi.doMock("node:fs", () => ({ ...actualFs, ...overrides }));
  return import("../../src/tools/apply-patch.ts");
}

describe("Apply Patch Tool Race Handling", () => {
  afterEach(() => {
    vi.doUnmock("node:fs");
    vi.resetModules();
  });

  test(`Given a missing add-file parent segment is swapped to an outside symlink during parent creation,
    When apply_patch creates the nested parent,
    Then it rejects without creating outside directories, files, temp files, or checkpoint`, async () => {
    // Given
    const workspace = await createGitWorkspace("keel-patch-parent-race-");
    const checkpoint = await checkpointPath(workspace);
    const outside = await mkdtemp(join(tmpdir(), "keel-patch-parent-outside-"));
    const targetPath = join(workspace, "race", "nested", "new.txt");
    const outsideNestedPath = join(outside, "nested");
    const patch = [
      "*** Begin Patch",
      "*** Add File: race/nested/new.txt",
      "+content",
      "*** End Patch",
    ].join("\n");
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    let swapped = false;
    const originalCwd = process.cwd();
    const { executeApplyPatch } = await importApplyPatchWithFs({
      mkdirSync: (path, options) => {
        const pathText = String(path);
        if (
          !swapped &&
          (pathText === "race" || pathText.endsWith(join("race", "nested")))
        ) {
          swapped = true;
          actualFs.symlinkSync(outside, join(workspace, "race"), "dir");
        }
        return actualFs.mkdirSync(path, options);
      },
    });

    try {
      // When / Then
      expectApplyPatchError(
        () => executeApplyPatch(workspace, patch),
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

  test(`Given an add-file parent is replaced by an outside symlink after validation,
    When apply_patch publishes the new file,
    Then it rejects the escaped target without creating or checkpointing outside content`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-patch-race-"));
    const parentPath = join(workspace, "race");
    const targetPath = join(parentPath, "new.txt");
    const outside = await mkdtemp(join(tmpdir(), "keel-patch-toc-outside-"));
    const patch = [
      "*** Begin Patch",
      "*** Add File: race/new.txt",
      "+outside-patch",
      "*** End Patch",
    ].join("\n");
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    let swapped = false;
    const { executeApplyPatch } = await importApplyPatchWithFs({
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
      expectApplyPatchError(
        () => executeApplyPatch(workspace, patch),
        "tool_path_outside_workspace",
        "outside the workspace",
      );
      expect(await pathExists(join(outside, "new.txt"))).toBe(false);
      expect(await pathExists(targetPath)).toBe(false);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test(`Given an earlier add target is swapped outside before rollback,
    When a later patch operation fails during publish,
    Then rollback removes the created workspace file without touching outside content`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-patch-rollback-race-"),
    );
    const parentPath = join(workspace, "race");
    const backupParentPath = join(workspace, "race-backup");
    const outside = await mkdtemp(
      join(tmpdir(), "keel-patch-rollback-outside-"),
    );
    await mkdir(parentPath);
    await writeFile(join(outside, "new.txt"), "created\n", "utf8");
    const patch = [
      "*** Begin Patch",
      "*** Add File: race/new.txt",
      "+created",
      "*** Add File: late.txt",
      "+late",
      "*** End Patch",
    ].join("\n");
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const publishError = new Error("late publish failed");
    let swapped = false;
    const { executeApplyPatch } = await importApplyPatchWithFs({
      linkSync: (existingPath, newPath) => {
        if (String(newPath).endsWith("late.txt")) {
          swapped = true;
          actualFs.renameSync(parentPath, backupParentPath);
          actualFs.symlinkSync(outside, parentPath, "dir");
          throw publishError;
        }
        return actualFs.linkSync(existingPath, newPath);
      },
    });

    try {
      // When / Then
      expect(() => executeApplyPatch(workspace, patch)).toThrow(publishError);
      expect(await readFile(join(outside, "new.txt"), "utf8")).toBe(
        "created\n",
      );
      expect(await pathExists(join(backupParentPath, "new.txt"))).toBe(false);
      expect(swapped).toBe(true);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test(`Given an add target is swapped outside immediately after publish,
    When apply_patch verifies the published target before checkpointing,
    Then it rejects without returning an outside checkpoint path`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-patch-checkpoint-race-"),
    );
    const parentPath = join(workspace, "race");
    const backupParentPath = join(workspace, "race-backup");
    const outside = await mkdtemp(
      join(tmpdir(), "keel-patch-checkpoint-outside-"),
    );
    await mkdir(parentPath);
    await writeFile(join(outside, "new.txt"), "outside\n", "utf8");
    const patch = [
      "*** Begin Patch",
      "*** Add File: race/new.txt",
      "+created",
      "*** End Patch",
    ].join("\n");
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    let swapped = false;
    const { executeApplyPatch } = await importApplyPatchWithFs({
      linkSync: (existingPath, newPath) => {
        actualFs.linkSync(existingPath, newPath);
        if (!swapped && String(newPath).endsWith(join("race", "new.txt"))) {
          swapped = true;
          actualFs.renameSync(parentPath, backupParentPath);
          actualFs.symlinkSync(outside, parentPath, "dir");
        }
      },
    });

    try {
      // When / Then
      expectApplyPatchError(
        () => executeApplyPatch(workspace, patch),
        "tool_path_outside_workspace",
        "outside the workspace",
      );
      expect(await readFile(join(outside, "new.txt"), "utf8")).toBe(
        "outside\n",
      );
      expect(await pathExists(join(backupParentPath, "new.txt"))).toBe(false);
      expect(swapped).toBe(true);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test(`Given an add target is replaced after publish verification,
    When apply_patch verifies the applied identity,
    Then it rejects without deleting the concurrent replacement`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-patch-verify-race-"));
    const parentPath = join(workspace, "race");
    const targetPath = join(parentPath, "new.txt");
    const replacementPath = join(parentPath, "replacement.txt");
    await mkdir(parentPath);
    await writeFile(replacementPath, "user\n", "utf8");
    const patch = [
      "*** Begin Patch",
      "*** Add File: race/new.txt",
      "+created",
      "*** End Patch",
    ].join("\n");
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    let replaced = false;
    const { executeApplyPatch } = await importApplyPatchWithFs({
      statSync: (path) => {
        const stat = actualFs.statSync(path);
        if (String(path).endsWith(join("race", "new.txt"))) {
          if (!replaced) {
            replaced = true;
            actualFs.rmSync(targetPath, { force: true });
            actualFs.renameSync(replacementPath, targetPath);
          }
        }
        return stat;
      },
    });

    try {
      // When / Then
      expectApplyPatchError(
        () => executeApplyPatch(workspace, patch),
        "tool_path_outside_workspace",
        "path changed outside",
      );
      expect(await readFile(targetPath, "utf8")).toBe("user\n");
      expect(replaced).toBe(true);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an add target is replaced before checkpoint recording,
    When apply_patch verifies the checkpoint identity,
    Then it rejects without deleting the concurrent replacement`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-patch-checkpoint-id-"),
    );
    const parentPath = join(workspace, "race");
    const targetPath = join(parentPath, "new.txt");
    const replacementPath = join(parentPath, "replacement.txt");
    const secondTargetPath = join(workspace, "other.txt");
    await mkdir(parentPath);
    await writeFile(replacementPath, "user\n", "utf8");
    const patch = [
      "*** Begin Patch",
      "*** Add File: race/new.txt",
      "+created",
      "*** Add File: other.txt",
      "+other",
      "*** End Patch",
    ].join("\n");
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    let replaced = false;
    const { executeApplyPatch } = await importApplyPatchWithFs({
      linkSync: (existingPath, newPath) => {
        actualFs.linkSync(existingPath, newPath);
        if (!replaced && String(newPath).endsWith("other.txt")) {
          replaced = true;
          actualFs.rmSync(targetPath, { force: true });
          actualFs.renameSync(replacementPath, targetPath);
        }
      },
    });

    try {
      // When / Then
      expectApplyPatchError(
        () => executeApplyPatch(workspace, patch),
        "tool_path_outside_workspace",
        "path changed outside",
      );
      expect(await readFile(targetPath, "utf8")).toBe("user\n");
      expect(await pathExists(secondTargetPath)).toBe(false);
      expect(replaced).toBe(true);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an add parent is swapped to an ignored directory during publish,
    When apply_patch verifies the published file identity,
    Then it removes the ignored file before reporting the ignored path`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-patch-add-ignore-"));
    const parentPath = join(workspace, "race");
    const backupParentPath = join(workspace, "race-backup");
    const ignoredPath = join(workspace, "private");
    const ignoredTargetPath = join(ignoredPath, "new.txt");
    await writeFile(join(workspace, ".gitignore"), "private/\n", "utf8");
    await mkdir(parentPath);
    await mkdir(ignoredPath);
    const patch = [
      "*** Begin Patch",
      "*** Add File: race/new.txt",
      "+created",
      "*** End Patch",
    ].join("\n");
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    let swapped = false;
    const { executeApplyPatch } = await importApplyPatchWithFs({
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

    try {
      // When / Then
      expectApplyPatchError(
        () => executeApplyPatch(workspace, patch),
        "tool_path_ignored",
        "ignored path",
      );
      expect(await pathExists(ignoredTargetPath)).toBe(false);
      expect(swapped).toBe(true);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an update target changes to a different in-workspace file after read validation,
    When apply_patch checks read-before-edit against the access-time target,
    Then it rejects without patching the unread file`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-patch-read-race-"));
    const targetPath = join(workspace, "note.txt");
    const backupTargetPath = join(workspace, "note-original.txt");
    const alternatePath = join(workspace, "alternate.txt");
    await writeFile(targetPath, "old\n", "utf8");
    await writeFile(alternatePath, "old\n", "utf8");
    const patch = [
      "*** Begin Patch",
      "*** Update File: note.txt",
      "@@",
      "-old",
      "+new",
      "*** End Patch",
    ].join("\n");
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const readTargetPath = actualFs.realpathSync(targetPath);
    let swapped = false;
    const { executeApplyPatch } = await importApplyPatchWithFs({
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
      expectApplyPatchError(
        () =>
          executeApplyPatch(workspace, patch, {
            readBeforeEdit: { hasRead: (path) => path === readTargetPath },
          }),
        "tool_file_not_read",
        "file has not been read",
      );
      expect(await readFile(alternatePath, "utf8")).toBe("old\n");
      expect(swapped).toBe(true);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an update target opens through an ignored workspace symlink,
    When apply_patch rechecks the opened descriptor path,
    Then it rejects before reading ignored content for matching`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-patch-open-ignore-"));
    const targetPath = join(workspace, "note.txt");
    const ignoredPath = join(workspace, "private");
    const ignoredTargetPath = join(ignoredPath, "note.txt");
    await mkdir(ignoredPath);
    await writeFile(join(workspace, ".gitignore"), "private/\n", "utf8");
    await writeFile(targetPath, "old\n", "utf8");
    await writeFile(ignoredTargetPath, "old\n", "utf8");
    const patch = [
      "*** Begin Patch",
      "*** Update File: note.txt",
      "@@",
      "-old",
      "+new",
      "*** End Patch",
    ].join("\n");
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    let swapped = false;
    const { executeApplyPatch } = await importApplyPatchWithFs({
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
      expectApplyPatchError(
        () =>
          executeApplyPatch(workspace, patch, {
            readBeforeEdit: { hasRead: () => true },
          }),
        "tool_path_ignored",
        "ignored path",
      );
      expect(await readFile(ignoredTargetPath, "utf8")).toBe("old\n");
      expect(swapped).toBe(true);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a delete target opens through an ignored workspace symlink,
    When apply_patch rechecks the opened descriptor path,
    Then it rejects before recording or removing ignored content`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-patch-delete-open-ignore-"),
    );
    const targetPath = join(workspace, "note.txt");
    const ignoredPath = join(workspace, "private");
    const ignoredTargetPath = join(ignoredPath, "note.txt");
    await mkdir(ignoredPath);
    await writeFile(join(workspace, ".gitignore"), "private/\n", "utf8");
    await writeFile(targetPath, "old\n", "utf8");
    await writeFile(ignoredTargetPath, "ignored\n", "utf8");
    const patch = [
      "*** Begin Patch",
      "*** Delete File: note.txt",
      "*** End Patch",
    ].join("\n");
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    let swapped = false;
    const { executeApplyPatch } = await importApplyPatchWithFs({
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
      expectApplyPatchError(
        () =>
          executeApplyPatch(workspace, patch, {
            readBeforeEdit: { hasRead: () => true },
          }),
        "tool_path_ignored",
        "ignored path",
      );
      expect(await readFile(ignoredTargetPath, "utf8")).toBe("ignored\n");
      expect(swapped).toBe(true);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a delete target opens as a different workspace file after initial read validation,
    When apply_patch rechecks read-before-edit on the opened descriptor path,
    Then it rejects without deleting the unread file`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-patch-delete-open-unread-"),
    );
    const targetPath = join(workspace, "note.txt");
    const alternatePath = join(workspace, "alternate.txt");
    await writeFile(targetPath, "old\n", "utf8");
    await writeFile(alternatePath, "alternate\n", "utf8");
    const patch = [
      "*** Begin Patch",
      "*** Delete File: note.txt",
      "*** End Patch",
    ].join("\n");
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const readTargetPath = actualFs.realpathSync(targetPath);
    let swapped = false;
    const { executeApplyPatch } = await importApplyPatchWithFs({
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
      expectApplyPatchError(
        () =>
          executeApplyPatch(workspace, patch, {
            readBeforeEdit: { hasRead: (path) => path === readTargetPath },
          }),
        "tool_file_not_read",
        "file has not been read",
      );
      expect(await readFile(alternatePath, "utf8")).toBe("alternate\n");
      expect(swapped).toBe(true);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an update target opens as a different workspace file after initial read validation,
    When apply_patch rechecks read-before-edit on the opened descriptor path,
    Then it rejects without patching the unread file`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-patch-open-unread-"));
    const targetPath = join(workspace, "note.txt");
    const alternatePath = join(workspace, "alternate.txt");
    await writeFile(targetPath, "old\n", "utf8");
    await writeFile(alternatePath, "old\n", "utf8");
    const patch = [
      "*** Begin Patch",
      "*** Update File: note.txt",
      "@@",
      "-old",
      "+new",
      "*** End Patch",
    ].join("\n");
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const readTargetPath = actualFs.realpathSync(targetPath);
    let swapped = false;
    const { executeApplyPatch } = await importApplyPatchWithFs({
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
      expectApplyPatchError(
        () =>
          executeApplyPatch(workspace, patch, {
            readBeforeEdit: { hasRead: (path) => path === readTargetPath },
          }),
        "tool_file_not_read",
        "file has not been read",
      );
      expect(await readFile(alternatePath, "utf8")).toBe("old\n");
      expect(swapped).toBe(true);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a validated delete target resolves to an ignored workspace path before removal,
    When apply_patch performs the delete access check,
    Then it rejects without deleting ignored content`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-patch-delete-apply-ignore-"),
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
    await writeFile(ignoredTargetPath, "ignored\n", "utf8");
    const patch = [
      "*** Begin Patch",
      "*** Delete File: race/note.txt",
      "*** End Patch",
    ].join("\n");
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const readTargetPath = actualFs.realpathSync(targetPath);
    let targetRealpathCalls = 0;
    let swapped = false;
    const { executeApplyPatch } = await importApplyPatchWithFs({
      realpathSync: (path) => {
        if (String(path) === readTargetPath) {
          targetRealpathCalls += 1;
          if (!swapped && targetRealpathCalls === 4) {
            swapped = true;
            actualFs.renameSync(parentPath, backupParentPath);
            actualFs.symlinkSync(ignoredPath, parentPath, "dir");
          }
        }
        return actualFs.realpathSync(path);
      },
    });

    try {
      // When / Then
      expectApplyPatchError(
        () =>
          executeApplyPatch(workspace, patch, {
            readBeforeEdit: { hasRead: (path) => path === readTargetPath },
          }),
        "tool_path_ignored",
        "ignored path",
      );
      expect(await readFile(ignoredTargetPath, "utf8")).toBe("ignored\n");
      expect(swapped).toBe(true);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a validated delete target is swapped to another workspace file before removal,
    When apply_patch checks the target identity at access time,
    Then it rejects without deleting the alternate file`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-patch-delete-swap-"));
    const targetPath = join(workspace, "note.txt");
    const backupTargetPath = join(workspace, "note-original.txt");
    const alternatePath = join(workspace, "alternate.txt");
    await writeFile(targetPath, "old\n", "utf8");
    await writeFile(alternatePath, "alternate\n", "utf8");
    const patch = [
      "*** Begin Patch",
      "*** Delete File: note.txt",
      "*** End Patch",
    ].join("\n");
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const readTargetPath = actualFs.realpathSync(targetPath);
    let targetStatCalls = 0;
    let swapped = false;
    const { executeApplyPatch } = await importApplyPatchWithFs({
      statSync: (path) => {
        if (String(path) === readTargetPath) {
          targetStatCalls += 1;
          if (!swapped && targetStatCalls === 4) {
            swapped = true;
            actualFs.renameSync(targetPath, backupTargetPath);
            actualFs.symlinkSync(alternatePath, targetPath);
          }
        }
        return actualFs.statSync(path);
      },
    });

    try {
      // When / Then
      expectApplyPatchError(
        () =>
          executeApplyPatch(workspace, patch, {
            readBeforeEdit: { hasRead: (path) => path === readTargetPath },
          }),
        "tool_path_outside_workspace",
        "path changed outside the verified workspace target",
      );
      expect(await readFile(alternatePath, "utf8")).toBe("alternate\n");
      expect(await readFile(backupTargetPath, "utf8")).toBe("old\n");
      expect(swapped).toBe(true);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an update parent is moved outside after final publish validation,
    When apply_patch renames the replacement through the raced path,
    Then it restores the escaped file content before reporting the boundary failure`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-patch-rename-race-"));
    const parentPath = join(workspace, "race");
    const outside = await mkdtemp(join(tmpdir(), "keel-patch-rename-outside-"));
    const outsideParentPath = join(outside, "race");
    const targetPath = join(parentPath, "note.txt");
    await mkdir(parentPath);
    await writeFile(targetPath, "old\n", "utf8");
    const patch = [
      "*** Begin Patch",
      "*** Update File: race/note.txt",
      "@@",
      "-old",
      "+new",
      "*** End Patch",
    ].join("\n");
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    let swapped = false;
    const { executeApplyPatch } = await importApplyPatchWithFs({
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
      expectApplyPatchError(
        () =>
          executeApplyPatch(workspace, patch, {
            readBeforeEdit: { hasRead: () => true },
          }),
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

  test(`Given an update parent is swapped to an ignored directory during publish,
    When apply_patch verifies the published file identity,
    Then it restores the ignored file before reporting the ignored path`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-patch-publish-ignore-"),
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
    const patch = [
      "*** Begin Patch",
      "*** Update File: race/note.txt",
      "@@",
      "-old",
      "+new",
      "*** End Patch",
    ].join("\n");
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    let swapped = false;
    const { executeApplyPatch } = await importApplyPatchWithFs({
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
      expectApplyPatchError(
        () =>
          executeApplyPatch(workspace, patch, {
            readBeforeEdit: { hasRead: () => true },
          }),
        "tool_path_ignored",
        "ignored path",
      );
      expect(await readFile(ignoredTargetPath, "utf8")).toBe("old\n");
      expect(swapped).toBe(true);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an update source file opens through an outside-swapped parent restored before validation,
    When apply_patch verifies the opened descriptor before reading hunks,
    Then it rejects before matching outside content`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-patch-source-race-"));
    const parentPath = join(workspace, "race");
    const backupParentPath = join(workspace, "race-backup");
    const targetPath = join(parentPath, "note.txt");
    const outside = await mkdtemp(join(tmpdir(), "keel-patch-source-outside-"));
    await mkdir(parentPath);
    await writeFile(targetPath, "old\n", "utf8");
    await writeFile(join(outside, "note.txt"), "outside\n", "utf8");
    const patch = [
      "*** Begin Patch",
      "*** Update File: race/note.txt",
      "@@",
      "-outside",
      "+new",
      "*** End Patch",
    ].join("\n");
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    let racedOpen = false;
    const { executeApplyPatch } = await importApplyPatchWithFs({
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
      expectApplyPatchError(
        () =>
          executeApplyPatch(workspace, patch, {
            readBeforeEdit: { hasRead: () => true },
          }),
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

  test(`Given a validated update target is swapped to an ignored workspace path before reading,
    When apply_patch verifies the opened descriptor and publish target,
    Then it rejects without patching ignored content`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-patch-ignore-race-"));
    const parentPath = join(workspace, "race");
    const ignoredPath = join(workspace, "private");
    const targetPath = join(parentPath, "note.txt");
    const ignoredTargetPath = join(ignoredPath, "note.txt");
    await writeFile(join(workspace, ".gitignore"), "private/\n", "utf8");
    await mkdir(parentPath);
    await mkdir(ignoredPath);
    await writeFile(targetPath, "old\n", "utf8");
    await writeFile(ignoredTargetPath, "old\n", "utf8");
    const patch = [
      "*** Begin Patch",
      "*** Update File: race/note.txt",
      "@@",
      "-old",
      "+new",
      "*** End Patch",
    ].join("\n");
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    let swapped = false;
    const { executeApplyPatch } = await importApplyPatchWithFs({
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
      expectApplyPatchError(
        () =>
          executeApplyPatch(workspace, patch, {
            readBeforeEdit: { hasRead: () => true },
          }),
        "tool_path_ignored",
        "ignored path",
      );
      expect(await readFile(ignoredTargetPath, "utf8")).toBe("old\n");
      expect(swapped).toBe(true);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an update target resolves to an ignored directory before temp creation,
    When apply_patch performs the pre-write access check,
    Then it rejects before writing replacement content`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-patch-prewrite-ignore-"),
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
    const patch = [
      "*** Begin Patch",
      "*** Update File: race/note.txt",
      "@@",
      "-old",
      "+new",
      "*** End Patch",
    ].join("\n");
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    let targetRealpathCalls = 0;
    let swapped = false;
    const { executeApplyPatch } = await importApplyPatchWithFs({
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
      expectApplyPatchError(
        () =>
          executeApplyPatch(workspace, patch, {
            readBeforeEdit: { hasRead: () => true },
          }),
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
