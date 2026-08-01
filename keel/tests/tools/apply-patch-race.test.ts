import {
  access,
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, join, sep } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { KeelErrorCode } from "../../src/core/error.ts";
import {
  createGitWorkspace,
  runGit as git,
} from "../../src/testing/cli-harness.ts";
import { createTemporaryDirectory } from "../../src/testing/temporary-directory.ts";
import {
  createProjectInstructionVisibilityState,
  type ProjectInstructionVisibilityState,
} from "../../src/tools/scoped-project-instructions.ts";

type PathLike = Parameters<typeof import("node:fs").realpathSync>[0];
type FsModule = typeof import("node:fs");

interface FsOverrides {
  readonly linkSync?: FsModule["linkSync"];
  readonly lstatSync?: (
    path: PathLike,
  ) => ReturnType<typeof import("node:fs").lstatSync>;
  readonly mkdirSync?: FsModule["mkdirSync"];
  readonly openSync?: FsModule["openSync"];
  readonly realpathSync?: (path: PathLike) => string;
  readonly renameSync?: FsModule["renameSync"];
  readonly rmSync?: FsModule["rmSync"];
  readonly statSync?: (
    path: PathLike,
  ) => ReturnType<typeof import("node:fs").statSync>;
}

function expectApplyPatchError(
  action: () => unknown,
  code: KeelErrorCode,
  message: string,
  recovery?: string,
): void {
  try {
    action();
    throw new Error("Expected apply_patch tool to throw");
  } catch (error) {
    expect(error).toMatchObject({
      name: "KeelError",
      code,
      message: expect.stringContaining(message),
      ...(recovery === undefined
        ? {}
        : { recovery: expect.stringContaining(recovery) }),
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
    "keel/undo-checkpoints.json",
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
    const outside = await createTemporaryDirectory(
      "keel-patch-parent-outside-",
    );
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
    const workspace = await createTemporaryDirectory("keel-patch-race-");
    const parentPath = join(workspace, "race");
    const targetPath = join(parentPath, "new.txt");
    const outside = await createTemporaryDirectory("keel-patch-toc-outside-");
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

  test(`Given an add-file operation creates fresh parents before publish fails,
    When apply_patch aborts the add,
    Then it removes the fresh empty parent directories`, async () => {
    // Given
    const workspace = await createTemporaryDirectory("keel-patch-add-parent-");
    const patch = [
      "*** Begin Patch",
      "*** Add File: fresh/nested/new.txt",
      "+created",
      "*** End Patch",
    ].join("\n");
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const publishError = new Error("publish failed");
    const { executeApplyPatch } = await importApplyPatchWithFs({
      linkSync: () => {
        throw publishError;
      },
    });

    try {
      // When / Then
      expect(() => executeApplyPatch(workspace, patch)).toThrow(publishError);
      expect(await pathExists(join(workspace, "fresh"))).toBe(false);
      expect(await readdir(workspace)).toEqual(
        expect.not.arrayContaining([expect.stringContaining(".keel-write-")]),
      );
      expect(actualFs.existsSync(join(workspace, "fresh", "nested"))).toBe(
        false,
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given add-file parent validation fails after creating fresh parents,
    When apply_patch aborts before writing the file,
    Then it removes the fresh empty parent directories`, async () => {
    // Given
    const workspace = await createTemporaryDirectory(
      "keel-patch-add-parent-validate-",
    );
    const patch = [
      "*** Begin Patch",
      "*** Add File: fresh/nested/new.txt",
      "+created",
      "*** End Patch",
    ].join("\n");
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const validationError = new Error("parent validation failed");
    let nestedRealpathCalls = 0;
    const { executeApplyPatch } = await importApplyPatchWithFs({
      realpathSync: (path) => {
        if (String(path).endsWith(join("fresh", "nested"))) {
          nestedRealpathCalls++;
          if (nestedRealpathCalls === 2) {
            throw validationError;
          }
        }
        return actualFs.realpathSync(path);
      },
    });

    try {
      // When / Then
      expect(() => executeApplyPatch(workspace, patch)).toThrow(
        validationError,
      );
      expect(await pathExists(join(workspace, "fresh"))).toBe(false);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given another process creates an add target after validation,
    When apply_patch publishes the new file,
    Then it reports the existing file and preserves the concurrent content`, async () => {
    // Given
    const workspace = await createTemporaryDirectory("keel-patch-add-exists-");
    const targetPath = join(workspace, "new.txt");
    const patch = [
      "*** Begin Patch",
      "*** Add File: new.txt",
      "+created",
      "*** End Patch",
    ].join("\n");
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    let raced = false;
    const { executeApplyPatch } = await importApplyPatchWithFs({
      linkSync: (existingPath, newPath) => {
        if (!raced && String(newPath) === targetPath) {
          raced = true;
          actualFs.writeFileSync(targetPath, "user\n", "utf8");
        }
        return actualFs.linkSync(existingPath, newPath);
      },
    });

    try {
      // When / Then
      expectApplyPatchError(
        () => executeApplyPatch(workspace, patch),
        "tool_file_exists",
        "file already exists: new.txt",
      );
      expect(await readFile(targetPath, "utf8")).toBe("user\n");
      expect(
        (await readdir(workspace)).some((path) =>
          path.startsWith(".keel-write-"),
        ),
      ).toBe(false);
      expect(raced).toBe(true);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given another process creates a move destination after validation,
    When apply_patch publishes the destination,
    Then it reports the existing file without deleting the source or concurrent destination`, async () => {
    // Given
    const workspace = await createTemporaryDirectory("keel-patch-move-exists-");
    const sourcePath = join(workspace, "old.txt");
    const destinationPath = join(workspace, "new.txt");
    await writeFile(sourcePath, "old\n", "utf8");
    const patch = [
      "*** Begin Patch",
      "*** Update File: old.txt",
      "*** Move to: new.txt",
      "*** End Patch",
    ].join("\n");
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    let raced = false;
    const { executeApplyPatch } = await importApplyPatchWithFs({
      linkSync: (existingPath, newPath) => {
        if (!raced && String(newPath) === destinationPath) {
          raced = true;
          actualFs.writeFileSync(destinationPath, "user\n", "utf8");
        }
        return actualFs.linkSync(existingPath, newPath);
      },
    });

    try {
      // When / Then
      expectApplyPatchError(
        () =>
          executeApplyPatch(workspace, patch, {
            readBeforeEdit: { revisionStatus: () => "current" },
          }),
        "tool_file_exists",
        "file already exists: new.txt",
      );
      expect(await readFile(sourcePath, "utf8")).toBe("old\n");
      expect(await readFile(destinationPath, "utf8")).toBe("user\n");
      expect(raced).toBe(true);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given another process creates a copy target after validation,
    When apply_patch publishes the copied file,
    Then it reports the copy-specific guidance and preserves the concurrent content`, async () => {
    // Given
    const workspace = await createTemporaryDirectory("keel-patch-copy-exists-");
    const sourcePath = join(workspace, "source.txt");
    const targetPath = join(workspace, "copied.txt");
    await writeFile(sourcePath, "source\n", "utf8");
    const patch = [
      "diff --git a/source.txt b/copied.txt",
      "similarity index 100%",
      "copy from source.txt",
      "copy to copied.txt",
    ].join("\n");
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    let raced = false;
    const { executeApplyPatch } = await importApplyPatchWithFs({
      linkSync: (existingPath, newPath) => {
        if (!raced && String(newPath) === targetPath) {
          raced = true;
          actualFs.writeFileSync(targetPath, "user\n", "utf8");
        }
        return actualFs.linkSync(existingPath, newPath);
      },
    });

    try {
      // When / Then
      expectApplyPatchError(
        () =>
          executeApplyPatch(workspace, patch, {
            readBeforeEdit: { revisionStatus: () => "current" },
          }),
        "tool_file_exists",
        "file already exists: copied.txt",
        "copying over it",
      );
      expect(await readFile(sourcePath, "utf8")).toBe("source\n");
      expect(await readFile(targetPath, "utf8")).toBe("user\n");
      expect(raced).toBe(true);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an add target becomes ignored after patch preparation,
    When apply_patch revalidates the target before mutation,
    Then it reports the new ignore rule without creating the file`, async () => {
    // Given
    const workspace = await createTemporaryDirectory("keel-patch-add-ignored-");
    const targetPath = join(workspace, "new.txt");
    const patch = [
      "*** Begin Patch",
      "*** Add File: new.txt",
      "+created",
      "*** End Patch",
    ].join("\n");
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    let ignored = false;
    const projectInstructions: ProjectInstructionVisibilityState = {
      ...createProjectInstructionVisibilityState(workspace),
      assertMutationAllowed: () => {
        if (!ignored) {
          ignored = true;
          actualFs.writeFileSync(
            join(workspace, ".gitignore"),
            "new.txt\n",
            "utf8",
          );
        }
      },
    };
    const { executeApplyPatch } = await import(
      "../../src/tools/apply-patch.ts"
    );

    try {
      // When / Then
      expectApplyPatchError(
        () => executeApplyPatch(workspace, patch, { projectInstructions }),
        "tool_path_ignored",
        "ignored path: new.txt",
      );
      expect(await pathExists(targetPath)).toBe(false);
      expect(ignored).toBe(true);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an update temp file moves after its descriptor is opened,
    When apply_patch resolves the temp path before writing,
    Then it removes the moved temp identity and preserves the original file`, async () => {
    // Given
    const workspace = await createTemporaryDirectory(
      "keel-patch-update-temp-moved-",
    );
    const targetPath = join(workspace, "note.txt");
    const movedTempPath = join(workspace, "moved-temp.txt");
    await writeFile(targetPath, "old\n", "utf8");
    const patch = [
      "*** Begin Patch",
      "*** Update File: note.txt",
      "@@",
      "-old",
      "+new",
      "*** End Patch",
    ].join("\n");
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    let moved = false;
    const { executeApplyPatch } = await importApplyPatchWithFs({
      realpathSync: (path) => {
        if (!moved && String(path).includes(".keel-edit-")) {
          moved = true;
          actualFs.renameSync(path, movedTempPath);
        }
        return actualFs.realpathSync(path);
      },
    });

    try {
      // When / Then
      expect(() =>
        executeApplyPatch(workspace, patch, {
          readBeforeEdit: { revisionStatus: () => "current" },
        }),
      ).toThrow();
      expect(await readFile(targetPath, "utf8")).toBe("old\n");
      expect(await pathExists(movedTempPath)).toBe(false);
      expect(moved).toBe(true);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an earlier add target is swapped outside before rollback,
    When a later patch operation fails during publish,
    Then rollback removes the created workspace file without touching outside content`, async () => {
    // Given
    const workspace = await createTemporaryDirectory(
      "keel-patch-rollback-race-",
    );
    const parentPath = join(workspace, "race");
    const backupParentPath = join(workspace, "race-backup");
    const outside = await createTemporaryDirectory(
      "keel-patch-rollback-outside-",
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

  test(`Given an earlier update succeeds before a later operation fails,
    When apply_patch rolls back the transaction,
    Then it restores the owned target while preserving a discovered path that loses the identity`, async () => {
    // Given
    const workspace = await createTemporaryDirectory(
      "keel-patch-update-rollback-",
    );
    const targetPath = join(workspace, "updated.txt");
    const aliasPath = join(workspace, "updated-alias.txt");
    const aliasReplacementPath = join(workspace, "alias-replacement.txt");
    const lateTargetPath = join(workspace, "late.txt");
    await writeFile(targetPath, "old\n", "utf8");
    await writeFile(aliasReplacementPath, "user\n", "utf8");
    const patch = [
      "*** Begin Patch",
      "*** Update File: updated.txt",
      "@@",
      "-old",
      "+new",
      "*** Add File: late.txt",
      "+late",
      "*** End Patch",
    ].join("\n");
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const publishError = new Error("late publish failed");
    let rollbackStarted = false;
    let aliasReplaced = false;
    const { executeApplyPatch } = await importApplyPatchWithFs({
      linkSync: (existingPath, newPath) => {
        if (String(newPath) === lateTargetPath) {
          actualFs.linkSync(targetPath, aliasPath);
          rollbackStarted = true;
          throw publishError;
        }
        return actualFs.linkSync(existingPath, newPath);
      },
      lstatSync: (path) => {
        const stat = actualFs.lstatSync(path);
        if (rollbackStarted && !aliasReplaced && String(path) === aliasPath) {
          aliasReplaced = true;
          actualFs.rmSync(aliasPath, { force: true });
          actualFs.renameSync(aliasReplacementPath, aliasPath);
        }
        return stat;
      },
    });

    try {
      // When / Then
      expect(() =>
        executeApplyPatch(workspace, patch, {
          readBeforeEdit: { revisionStatus: () => "current" },
        }),
      ).toThrow(publishError);
      expect(await readFile(targetPath, "utf8")).toBe("old\n");
      expect(await readFile(aliasPath, "utf8")).toBe("user\n");
      expect(await pathExists(lateTargetPath)).toBe(false);
      expect(aliasReplaced).toBe(true);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an update target is replaced after rollback first confirms its identity,
    When rollback rechecks the discovered target before restoration,
    Then it preserves the concurrent replacement`, async () => {
    // Given
    const workspace = await createTemporaryDirectory(
      "keel-patch-update-rollback-recheck-",
    );
    const targetPath = join(workspace, "updated.txt");
    const replacementPath = join(workspace, "replacement.txt");
    const lateTargetPath = join(workspace, "late.txt");
    await writeFile(targetPath, "old\n", "utf8");
    await writeFile(replacementPath, "user\n", "utf8");
    const patch = [
      "*** Begin Patch",
      "*** Update File: updated.txt",
      "@@",
      "-old",
      "+new",
      "*** Add File: late.txt",
      "+late",
      "*** End Patch",
    ].join("\n");
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const publishError = new Error("late publish failed");
    let rollbackStarted = false;
    let replaced = false;
    const { executeApplyPatch } = await importApplyPatchWithFs({
      linkSync: (existingPath, newPath) => {
        if (String(newPath) === lateTargetPath) {
          rollbackStarted = true;
          throw publishError;
        }
        return actualFs.linkSync(existingPath, newPath);
      },
      statSync: (path) => {
        const stat = actualFs.statSync(path);
        if (rollbackStarted && !replaced && String(path) === targetPath) {
          replaced = true;
          actualFs.rmSync(targetPath, { force: true });
          actualFs.renameSync(replacementPath, targetPath);
        }
        return stat;
      },
    });

    try {
      // When / Then
      expect(() =>
        executeApplyPatch(workspace, patch, {
          readBeforeEdit: { revisionStatus: () => "current" },
        }),
      ).toThrow(publishError);
      expect(await readFile(targetPath, "utf8")).toBe("user\n");
      expect(await pathExists(lateTargetPath)).toBe(false);
      expect(replaced).toBe(true);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an earlier add is moved outside the workspace and disappears during rollback,
    When a later patch operation fails,
    Then rollback tolerates the missing Keel identity without touching unrelated outside content`, async () => {
    // Given
    const workspace = await createTemporaryDirectory(
      "keel-patch-rollback-outside-missing-",
    );
    const parentPath = join(workspace, "race");
    const targetPath = join(parentPath, "new.txt");
    const lateTargetPath = join(workspace, "late.txt");
    const outside = await createTemporaryDirectory(
      "keel-patch-rollback-owned-outside-",
    );
    const outsideParentPath = join(outside, "moved-race");
    const outsideMarkerPath = join(outside, "marker.txt");
    await mkdir(parentPath);
    await writeFile(outsideMarkerPath, "outside\n", "utf8");
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
    let rollbackStarted = false;
    let disappeared = false;
    const { executeApplyPatch } = await importApplyPatchWithFs({
      linkSync: (existingPath, newPath) => {
        if (String(newPath) === lateTargetPath) {
          actualFs.renameSync(parentPath, outsideParentPath);
          actualFs.symlinkSync(outsideParentPath, parentPath, "dir");
          rollbackStarted = true;
          throw publishError;
        }
        return actualFs.linkSync(existingPath, newPath);
      },
      statSync: (path) => {
        const stat = actualFs.statSync(path);
        if (rollbackStarted && !disappeared && String(path) === targetPath) {
          disappeared = true;
          actualFs.rmSync(targetPath, { force: true });
        }
        return stat;
      },
    });

    try {
      // When / Then
      expect(() => executeApplyPatch(workspace, patch)).toThrow(publishError);
      expect(await pathExists(join(outsideParentPath, "new.txt"))).toBe(false);
      expect(await readFile(outsideMarkerPath, "utf8")).toBe("outside\n");
      expect(disappeared).toBe(true);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test(`Given an earlier add creates fresh parents before a later operation fails,
    When apply_patch rolls back the earlier add,
    Then it removes the fresh empty parent directories`, async () => {
    // Given
    const workspace = await createTemporaryDirectory(
      "keel-patch-add-parent-rollback-",
    );
    const patch = [
      "*** Begin Patch",
      "*** Add File: fresh/nested/new.txt",
      "+created",
      "*** Add File: late.txt",
      "+late",
      "*** End Patch",
    ].join("\n");
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const publishError = new Error("late publish failed");
    const { executeApplyPatch } = await importApplyPatchWithFs({
      linkSync: (existingPath, newPath) => {
        if (String(newPath).endsWith("late.txt")) {
          throw publishError;
        }
        return actualFs.linkSync(existingPath, newPath);
      },
    });

    try {
      // When / Then
      expect(() => executeApplyPatch(workspace, patch)).toThrow(publishError);
      expect(await pathExists(join(workspace, "fresh"))).toBe(false);
      expect(await pathExists(join(workspace, "late.txt"))).toBe(false);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given rollback target verification hits an unexpected filesystem failure,
    When a later patch operation fails after an earlier add was published,
    Then apply_patch surfaces the rollback verification failure`, async () => {
    // Given
    const workspace = await createTemporaryDirectory(
      "keel-patch-rollback-unexpected-",
    );
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
    const rollbackError = new Error("rollback realpath failed");
    let rollbackStarted = false;
    const { executeApplyPatch } = await importApplyPatchWithFs({
      linkSync: (existingPath, newPath) => {
        if (String(newPath).endsWith("late.txt")) {
          rollbackStarted = true;
          throw publishError;
        }
        return actualFs.linkSync(existingPath, newPath);
      },
      realpathSync: (path) => {
        if (rollbackStarted && String(path).endsWith(join("race", "new.txt"))) {
          throw rollbackError;
        }
        return actualFs.realpathSync(path);
      },
    });

    try {
      // When / Then
      expect(() => executeApplyPatch(workspace, patch)).toThrow(rollbackError);
      expect(rollbackStarted).toBe(true);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an earlier update target is removed before rollback,
    When a later patch operation fails,
    Then rollback skips the missing update target and preserves the original failure`, async () => {
    // Given
    const workspace = await createTemporaryDirectory(
      "keel-patch-update-rollback-missing-",
    );
    const workspacePath = await realpath(workspace);
    const updatePath = join(workspacePath, "updated.txt");
    await writeFile(updatePath, "old\n", "utf8");
    const patch = [
      "*** Begin Patch",
      "*** Update File: updated.txt",
      "@@",
      "-old",
      "+new",
      "*** Add File: late.txt",
      "+late",
      "*** End Patch",
    ].join("\n");
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const publishError = new Error("late publish failed");
    const { executeApplyPatch } = await importApplyPatchWithFs({
      linkSync: (existingPath, newPath) => {
        if (String(newPath).endsWith("late.txt")) {
          actualFs.rmSync(updatePath, { force: true });
          throw publishError;
        }
        return actualFs.linkSync(existingPath, newPath);
      },
    });

    try {
      // When / Then
      expect(() =>
        executeApplyPatch(workspace, patch, {
          readBeforeEdit: {
            revisionStatus: (targetPath) =>
              targetPath === updatePath ? "current" : "unread",
          },
        }),
      ).toThrow(publishError);
      expect(await pathExists(updatePath)).toBe(false);
      expect(await pathExists(join(workspacePath, "late.txt"))).toBe(false);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an earlier add is changed in place before rollback,
    When a later patch operation fails,
    Then rollback preserves the concurrent content instead of removing the file`, async () => {
    // Given
    const workspace = await createTemporaryDirectory(
      "keel-patch-add-rollback-changed-",
    );
    const firstTargetPath = join(workspace, "first.txt");
    const lateTargetPath = join(workspace, "late.txt");
    const patch = [
      "*** Begin Patch",
      "*** Add File: first.txt",
      "+created",
      "*** Add File: late.txt",
      "+late",
      "*** End Patch",
    ].join("\n");
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const publishError = new Error("late publish failed");
    let changed = false;
    const { executeApplyPatch } = await importApplyPatchWithFs({
      linkSync: (existingPath, newPath) => {
        if (String(newPath) === lateTargetPath) {
          changed = true;
          actualFs.writeFileSync(firstTargetPath, "user\n", "utf8");
          throw publishError;
        }
        return actualFs.linkSync(existingPath, newPath);
      },
    });

    try {
      // When / Then
      expect(() => executeApplyPatch(workspace, patch)).toThrow(publishError);
      expect(await readFile(firstTargetPath, "utf8")).toBe("user\n");
      expect(await pathExists(lateTargetPath)).toBe(false);
      expect(changed).toBe(true);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an earlier update identity is replaced after rollback discovers its moved path,
    When a later patch operation fails,
    Then rollback preserves both concurrent replacements`, async () => {
    // Given
    const workspace = await createTemporaryDirectory(
      "keel-patch-update-rollback-identity-",
    );
    const targetPath = join(workspace, "updated.txt");
    const movedPath = join(workspace, "moved-updated.txt");
    const movedReplacementPath = join(workspace, "moved-replacement.txt");
    const lateTargetPath = join(workspace, "late.txt");
    await writeFile(targetPath, "old\n", "utf8");
    await writeFile(movedReplacementPath, "user-at-moved-path\n", "utf8");
    const patch = [
      "*** Begin Patch",
      "*** Update File: updated.txt",
      "@@",
      "-old",
      "+new",
      "*** Add File: late.txt",
      "+late",
      "*** End Patch",
    ].join("\n");
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const publishError = new Error("late publish failed");
    let rollbackStarted = false;
    let replacedAfterDiscovery = false;
    const { executeApplyPatch } = await importApplyPatchWithFs({
      linkSync: (existingPath, newPath) => {
        if (String(newPath) === lateTargetPath) {
          rollbackStarted = true;
          actualFs.renameSync(targetPath, movedPath);
          actualFs.writeFileSync(targetPath, "user-at-target\n", "utf8");
          throw publishError;
        }
        return actualFs.linkSync(existingPath, newPath);
      },
      lstatSync: (path) => {
        const stat = actualFs.lstatSync(path);
        if (
          rollbackStarted &&
          !replacedAfterDiscovery &&
          String(path) === movedPath
        ) {
          replacedAfterDiscovery = true;
          actualFs.rmSync(movedPath, { force: true });
          actualFs.renameSync(movedReplacementPath, movedPath);
        }
        return stat;
      },
    });

    try {
      // When / Then
      expect(() =>
        executeApplyPatch(workspace, patch, {
          readBeforeEdit: { revisionStatus: () => "current" },
        }),
      ).toThrow(publishError);
      expect(await readFile(targetPath, "utf8")).toBe("user-at-target\n");
      expect(await readFile(movedPath, "utf8")).toBe("user-at-moved-path\n");
      expect(replacedAfterDiscovery).toBe(true);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an earlier add target parent is replaced by a file before rollback,
    When a later patch operation fails during publish,
    Then rollback tolerates the ENOTDIR target verification race`, async () => {
    // Given
    const workspace = await createTemporaryDirectory(
      "keel-patch-rollback-enotdir-",
    );
    const parentPath = join(workspace, "race");
    const movedParentPath = join(workspace, "race-moved");
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
    let replacedParent = false;
    const { executeApplyPatch } = await importApplyPatchWithFs({
      linkSync: (existingPath, newPath) => {
        if (String(newPath).endsWith("late.txt")) {
          replacedParent = true;
          actualFs.renameSync(parentPath, movedParentPath);
          actualFs.writeFileSync(parentPath, "not a directory\n", "utf8");
          throw publishError;
        }
        return actualFs.linkSync(existingPath, newPath);
      },
    });

    try {
      // When / Then
      expect(() => executeApplyPatch(workspace, patch)).toThrow(publishError);
      expect(replacedParent).toBe(true);
      expect(await readFile(parentPath, "utf8")).toBe("not a directory\n");
      expect(await pathExists(join(movedParentPath, "new.txt"))).toBe(false);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an add target is swapped outside immediately after publish,
    When apply_patch verifies the published target before checkpointing,
    Then it rejects without returning an outside checkpoint path`, async () => {
    // Given
    const workspace = await createTemporaryDirectory(
      "keel-patch-checkpoint-race-",
    );
    const parentPath = join(workspace, "race");
    const backupParentPath = join(workspace, "race-backup");
    const outside = await createTemporaryDirectory(
      "keel-patch-checkpoint-outside-",
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
    const workspace = await createTemporaryDirectory("keel-patch-verify-race-");
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
    const workspace = await createTemporaryDirectory(
      "keel-patch-checkpoint-id-",
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
    const workspace = await createTemporaryDirectory("keel-patch-add-ignore-");
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
    const workspace = await createTemporaryDirectory("keel-patch-read-race-");
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
            readBeforeEdit: {
              revisionStatus: (path) =>
                path === readTargetPath ? "current" : "unread",
            },
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
    const workspace = await createTemporaryDirectory("keel-patch-open-ignore-");
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
            readBeforeEdit: { revisionStatus: () => "current" },
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

  test(`Given a copy source opens through an ignored workspace symlink,
    When apply_patch rechecks the opened descriptor path,
    Then it rejects before reading ignored content for copying`, async () => {
    // Given
    const workspace = await createTemporaryDirectory(
      "keel-patch-copy-open-ignore-",
    );
    const sourcePath = join(workspace, "note.txt");
    const copiedPath = join(workspace, "copied.txt");
    const ignoredPath = join(workspace, "private");
    const ignoredSourcePath = join(ignoredPath, "note.txt");
    await mkdir(ignoredPath);
    await writeFile(join(workspace, ".gitignore"), "private/\n", "utf8");
    await writeFile(sourcePath, "old\n", "utf8");
    await writeFile(ignoredSourcePath, "ignored\n", "utf8");
    const patch = [
      "diff --git a/note.txt b/copied.txt",
      "similarity index 100%",
      "copy from note.txt",
      "copy to copied.txt",
    ].join("\n");
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    let swapped = false;
    const { executeApplyPatch } = await importApplyPatchWithFs({
      openSync: (path, flags, mode) => {
        if (!swapped && String(path).endsWith("note.txt")) {
          swapped = true;
          actualFs.rmSync(sourcePath, { force: true });
          actualFs.symlinkSync(ignoredSourcePath, sourcePath);
        }
        return actualFs.openSync(path, flags, mode);
      },
    });

    try {
      // When / Then
      expectApplyPatchError(
        () =>
          executeApplyPatch(workspace, patch, {
            readBeforeEdit: { revisionStatus: () => "current" },
          }),
        "tool_path_ignored",
        "ignored path",
      );
      expect(await readFile(ignoredSourcePath, "utf8")).toBe("ignored\n");
      expect(await pathExists(copiedPath)).toBe(false);
      expect(swapped).toBe(true);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a delete target opens through an ignored workspace symlink,
    When apply_patch rechecks the opened descriptor path,
    Then it rejects before recording or removing ignored content`, async () => {
    // Given
    const workspace = await createTemporaryDirectory(
      "keel-patch-delete-open-ignore-",
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
            readBeforeEdit: { revisionStatus: () => "current" },
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
    const workspace = await createTemporaryDirectory(
      "keel-patch-delete-open-unread-",
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
            readBeforeEdit: {
              revisionStatus: (path) =>
                path === readTargetPath ? "current" : "unread",
            },
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
    const workspace = await createTemporaryDirectory("keel-patch-open-unread-");
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
            readBeforeEdit: {
              revisionStatus: (path) =>
                path === readTargetPath ? "current" : "unread",
            },
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

  test(`Given a copy source opens as a different workspace file after initial read validation,
    When apply_patch rechecks read-before-edit on the opened descriptor path,
    Then it rejects without copying the unread file`, async () => {
    // Given
    const workspace = await createTemporaryDirectory(
      "keel-patch-copy-open-unread-",
    );
    const sourcePath = join(workspace, "note.txt");
    const alternatePath = join(workspace, "alternate.txt");
    const copiedPath = join(workspace, "copied.txt");
    await writeFile(sourcePath, "old\n", "utf8");
    await writeFile(alternatePath, "alternate\n", "utf8");
    const patch = [
      "diff --git a/note.txt b/copied.txt",
      "similarity index 100%",
      "copy from note.txt",
      "copy to copied.txt",
    ].join("\n");
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const readSourcePath = actualFs.realpathSync(sourcePath);
    let swapped = false;
    const { executeApplyPatch } = await importApplyPatchWithFs({
      openSync: (path, flags, mode) => {
        if (!swapped && String(path) === readSourcePath) {
          swapped = true;
          actualFs.rmSync(sourcePath, { force: true });
          actualFs.symlinkSync(alternatePath, sourcePath);
        }
        return actualFs.openSync(path, flags, mode);
      },
    });

    try {
      // When / Then
      expectApplyPatchError(
        () =>
          executeApplyPatch(workspace, patch, {
            readBeforeEdit: {
              revisionStatus: (path) =>
                path === readSourcePath ? "current" : "unread",
            },
          }),
        "tool_file_not_read",
        "file has not been read",
      );
      expect(await readFile(alternatePath, "utf8")).toBe("alternate\n");
      expect(await pathExists(copiedPath)).toBe(false);
      expect(swapped).toBe(true);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a validated delete target resolves to an ignored workspace path before removal,
    When apply_patch performs the delete access check,
    Then it rejects without deleting ignored content`, async () => {
    // Given
    const workspace = await createTemporaryDirectory(
      "keel-patch-delete-apply-ignore-",
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
            readBeforeEdit: {
              revisionStatus: (path) =>
                path === readTargetPath ? "current" : "unread",
            },
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
    const workspace = await createTemporaryDirectory("keel-patch-delete-swap-");
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
            readBeforeEdit: {
              revisionStatus: (path) =>
                path === readTargetPath ? "current" : "unread",
            },
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
    const workspace = await createTemporaryDirectory("keel-patch-rename-race-");
    const parentPath = join(workspace, "race");
    const outside = await createTemporaryDirectory(
      "keel-patch-rename-outside-",
    );
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
            readBeforeEdit: { revisionStatus: () => "current" },
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
    const workspace = await createTemporaryDirectory(
      "keel-patch-publish-ignore-",
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
            readBeforeEdit: { revisionStatus: () => "current" },
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

  test.skipIf(process.platform === "win32")(
    `Given a move destination parent is swapped to an ignored directory during publish,
    When apply_patch verifies the published destination,
    Then it removes the ignored destination before reporting the ignored path`,
    async () => {
      // Given
      const workspace = await createTemporaryDirectory(
        "keel-patch-move-publish-ignore-",
      );
      const parentPath = join(workspace, "race");
      const backupParentPath = join(workspace, "race-backup");
      const ignoredPath = join(workspace, "private");
      const sourcePath = join(workspace, "old.txt");
      const ignoredTargetPath = join(ignoredPath, "new.txt");
      await writeFile(join(workspace, ".gitignore"), "private/\n", "utf8");
      await mkdir(parentPath);
      await mkdir(ignoredPath);
      await writeFile(sourcePath, "old\n", "utf8");
      const patch = [
        "*** Begin Patch",
        "*** Update File: old.txt",
        "*** Move to: race/new.txt",
        "*** End Patch",
      ].join("\n");
      const actualFs =
        await vi.importActual<typeof import("node:fs")>("node:fs");
      let swapped = false;
      const { executeApplyPatch } = await importApplyPatchWithFs({
        linkSync: (oldPath, newPath) => {
          if (
            !swapped &&
            String(oldPath).includes(".keel-write-") &&
            String(newPath).endsWith(join("race", "new.txt"))
          ) {
            swapped = true;
            actualFs.renameSync(parentPath, backupParentPath);
            actualFs.symlinkSync(ignoredPath, parentPath, "dir");
            return actualFs.linkSync(
              join(backupParentPath, basename(String(oldPath))),
              newPath,
            );
          }
          return actualFs.linkSync(oldPath, newPath);
        },
      });

      try {
        // When / Then
        expectApplyPatchError(
          () =>
            executeApplyPatch(workspace, patch, {
              readBeforeEdit: { revisionStatus: () => "current" },
            }),
          "tool_path_ignored",
          "ignored path",
        );
        expect(await readFile(sourcePath, "utf8")).toBe("old\n");
        expect(await pathExists(ignoredTargetPath)).toBe(false);
        expect(swapped).toBe(true);
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(process.platform === "win32")(
    `Given a move source parent is swapped to an ignored directory after destination publish,
    When apply_patch rechecks the source before deleting it,
    Then it removes the new destination before reporting the ignored source`,
    async () => {
      // Given
      const workspace = await createTemporaryDirectory(
        "keel-patch-move-source-ignore-",
      );
      const sourceParentPath = join(workspace, "src");
      const backupSourceParentPath = join(workspace, "src-backup");
      const ignoredPath = join(workspace, "private");
      const sourcePath = join(sourceParentPath, "old.txt");
      const ignoredSourcePath = join(ignoredPath, "old.txt");
      const destinationPath = join(workspace, "new.txt");
      await writeFile(join(workspace, ".gitignore"), "private/\n", "utf8");
      await mkdir(sourceParentPath);
      await mkdir(ignoredPath);
      await writeFile(sourcePath, "old\n", "utf8");
      await writeFile(ignoredSourcePath, "ignored\n", "utf8");
      const patch = [
        "*** Begin Patch",
        "*** Update File: src/old.txt",
        "*** Move to: new.txt",
        "*** End Patch",
      ].join("\n");
      const actualFs =
        await vi.importActual<typeof import("node:fs")>("node:fs");
      let swapped = false;
      const { executeApplyPatch } = await importApplyPatchWithFs({
        linkSync: (oldPath, newPath) => {
          const result = actualFs.linkSync(oldPath, newPath);
          if (
            !swapped &&
            String(oldPath).includes(".keel-write-") &&
            String(newPath).endsWith("new.txt")
          ) {
            swapped = true;
            actualFs.renameSync(sourceParentPath, backupSourceParentPath);
            actualFs.symlinkSync(ignoredPath, sourceParentPath, "dir");
          }
          return result;
        },
      });

      try {
        // When / Then
        expectApplyPatchError(
          () =>
            executeApplyPatch(workspace, patch, {
              readBeforeEdit: { revisionStatus: () => "current" },
            }),
          "tool_path_ignored",
          "ignored path: src/old.txt",
        );
        expect(
          await readFile(join(backupSourceParentPath, "old.txt"), "utf8"),
        ).toBe("old\n");
        expect(await readFile(ignoredSourcePath, "utf8")).toBe("ignored\n");
        expect(await pathExists(destinationPath)).toBe(false);
        expect(swapped).toBe(true);
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    },
  );

  test(`Given a move source file is replaced after destination publish,
    When apply_patch rechecks the source identity before deleting it,
    Then it removes the new destination before reporting the changed source`, async () => {
    // Given
    const workspace = await createTemporaryDirectory(
      "keel-patch-move-source-replaced-",
    );
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const workspacePath = actualFs.realpathSync(workspace);
    const sourcePath = join(workspacePath, "old.txt");
    const destinationPath = join(workspacePath, "new.txt");
    const replacementSourcePath = join(workspacePath, "replacement-old.txt");
    await writeFile(sourcePath, "old\n", "utf8");
    await writeFile(replacementSourcePath, "changed\n", "utf8");
    const patch = [
      "*** Begin Patch",
      "*** Update File: old.txt",
      "*** Move to: new.txt",
      "*** End Patch",
    ].join("\n");
    let replaced = false;
    const projectInstructions: ProjectInstructionVisibilityState = {
      ...createProjectInstructionVisibilityState(workspace),
      assertMutationAllowed: (targetPaths: readonly string[]) => {
        if (
          !replaced &&
          targetPaths.length === 1 &&
          targetPaths[0] === sourcePath
        ) {
          replaced = true;
          actualFs.renameSync(replacementSourcePath, sourcePath);
        }
      },
    };
    const { executeApplyPatch } = await import(
      "../../src/tools/apply-patch.ts"
    );

    try {
      // When / Then
      expectApplyPatchError(
        () =>
          executeApplyPatch(workspace, patch, {
            readBeforeEdit: { revisionStatus: () => "current" },
            projectInstructions,
          }),
        "tool_path_outside_workspace",
        "path changed outside the verified workspace target",
      );
      expect(await readFile(sourcePath, "utf8")).toBe("changed\n");
      expect(await pathExists(destinationPath)).toBe(false);
      expect(replaced).toBe(true);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a move source and destination are both replaced after destination publish,
    When apply_patch rechecks the source identity before deleting it,
    Then it preserves the user-replaced destination while reporting the changed source`, async () => {
    // Given
    const workspace = await createTemporaryDirectory(
      "keel-patch-move-source-and-destination-replaced-",
    );
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const workspacePath = actualFs.realpathSync(workspace);
    const sourcePath = join(workspacePath, "old.txt");
    const destinationPath = join(workspacePath, "new.txt");
    const replacementSourcePath = join(workspacePath, "replacement-old.txt");
    const replacementDestinationPath = join(
      workspacePath,
      "replacement-new.txt",
    );
    await writeFile(sourcePath, "old\n", "utf8");
    await writeFile(replacementSourcePath, "changed\n", "utf8");
    await writeFile(replacementDestinationPath, "user\n", "utf8");
    const patch = [
      "*** Begin Patch",
      "*** Update File: old.txt",
      "*** Move to: new.txt",
      "*** End Patch",
    ].join("\n");
    let replaced = false;
    const projectInstructions: ProjectInstructionVisibilityState = {
      ...createProjectInstructionVisibilityState(workspace),
      assertMutationAllowed: (targetPaths: readonly string[]) => {
        if (
          !replaced &&
          targetPaths.length === 1 &&
          targetPaths[0] === sourcePath
        ) {
          replaced = true;
          actualFs.rmSync(destinationPath, { force: true });
          actualFs.renameSync(replacementDestinationPath, destinationPath);
          actualFs.renameSync(replacementSourcePath, sourcePath);
        }
      },
    };
    const { executeApplyPatch } = await import(
      "../../src/tools/apply-patch.ts"
    );

    try {
      // When / Then
      expectApplyPatchError(
        () =>
          executeApplyPatch(workspace, patch, {
            readBeforeEdit: { revisionStatus: () => "current" },
            projectInstructions,
          }),
        "tool_path_outside_workspace",
        "path changed outside the verified workspace target",
      );
      expect(await readFile(sourcePath, "utf8")).toBe("changed\n");
      expect(await readFile(destinationPath, "utf8")).toBe("user\n");
      expect(replaced).toBe(true);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a move destination is replaced after the source is removed,
    When apply_patch verifies the moved destination identity,
    Then rollback restores the source without deleting the user-replaced destination`, async () => {
    // Given
    const workspace = await createTemporaryDirectory(
      "keel-patch-move-verify-destination-replaced-",
    );
    const sourcePath = join(workspace, "old.txt");
    const destinationPath = join(workspace, "new.txt");
    const replacementDestinationPath = join(workspace, "replacement-new.txt");
    await writeFile(sourcePath, "old\n", "utf8");
    await writeFile(replacementDestinationPath, "user\n", "utf8");
    const patch = [
      "*** Begin Patch",
      "*** Update File: old.txt",
      "*** Move to: new.txt",
      "*** End Patch",
    ].join("\n");
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    let replaced = false;
    const { executeApplyPatch } = await importApplyPatchWithFs({
      rmSync: (path, options) => {
        const result = actualFs.rmSync(path, options);
        if (!replaced && basename(String(path)) === "old.txt") {
          replaced = true;
          actualFs.rmSync(destinationPath, { force: true });
          actualFs.renameSync(replacementDestinationPath, destinationPath);
        }
        return result;
      },
    });

    try {
      // When / Then
      expectApplyPatchError(
        () =>
          executeApplyPatch(workspace, patch, {
            readBeforeEdit: { revisionStatus: () => "current" },
          }),
        "tool_path_outside_workspace",
        "path changed outside the verified workspace target",
      );
      expect(await readFile(sourcePath, "utf8")).toBe("old\n");
      expect(await readFile(destinationPath, "utf8")).toBe("user\n");
      expect(replaced).toBe(true);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a deleted file identity is recreated immediately after removal,
    When apply_patch verifies the deletion,
    Then it reports the race without overwriting the recreated file`, async () => {
    // Given
    const workspace = await createTemporaryDirectory(
      "keel-patch-delete-recreated-",
    );
    const targetPath = join(workspace, "old.txt");
    const backupPath = join(workspace, "old-backup.txt");
    await writeFile(targetPath, "old\n", "utf8");
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    actualFs.linkSync(targetPath, backupPath);
    const patch = [
      "*** Begin Patch",
      "*** Delete File: old.txt",
      "*** End Patch",
    ].join("\n");
    let recreated = false;
    const { executeApplyPatch } = await importApplyPatchWithFs({
      rmSync: (path, options) => {
        const result = actualFs.rmSync(path, options);
        if (!recreated && String(path) === targetPath) {
          recreated = true;
          actualFs.linkSync(backupPath, targetPath);
        }
        return result;
      },
    });

    try {
      // When / Then
      expectApplyPatchError(
        () =>
          executeApplyPatch(workspace, patch, {
            readBeforeEdit: { revisionStatus: () => "current" },
          }),
        "tool_path_outside_workspace",
        "path changed outside",
      );
      expect(await readFile(targetPath, "utf8")).toBe("old\n");
      expect(recreated).toBe(true);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a deleted file identity reappears between verification and checkpointing,
    When apply_patch records the deletion checkpoint,
    Then it reports the race without overwriting the recreated file`, async () => {
    // Given
    const workspace = await createTemporaryDirectory(
      "keel-patch-delete-checkpoint-race-",
    );
    const targetPath = join(workspace, "old.txt");
    const backupPath = join(workspace, "old-backup.txt");
    await writeFile(targetPath, "old\n", "utf8");
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    actualFs.linkSync(targetPath, backupPath);
    const patch = [
      "*** Begin Patch",
      "*** Delete File: old.txt",
      "*** End Patch",
    ].join("\n");
    let recreated = false;
    const { executeApplyPatch } = await importApplyPatchWithFs({
      statSync: (path) => {
        try {
          return actualFs.statSync(path);
        } catch (error) {
          if (!recreated && String(path) === targetPath) {
            recreated = true;
            actualFs.linkSync(backupPath, targetPath);
          }
          throw error;
        }
      },
    });

    try {
      // When / Then
      expectApplyPatchError(
        () =>
          executeApplyPatch(workspace, patch, {
            readBeforeEdit: { revisionStatus: () => "current" },
          }),
        "tool_path_outside_workspace",
        "path changed outside",
      );
      expect(await readFile(targetPath, "utf8")).toBe("old\n");
      expect(recreated).toBe(true);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a moved source identity is recreated immediately after removal,
    When apply_patch verifies the move,
    Then rollback removes its destination without overwriting the recreated source`, async () => {
    // Given
    const workspace = await createTemporaryDirectory(
      "keel-patch-move-source-recreated-",
    );
    const sourcePath = join(workspace, "old.txt");
    const backupPath = join(workspace, "old-backup.txt");
    const destinationPath = join(workspace, "new.txt");
    await writeFile(sourcePath, "old\n", "utf8");
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    actualFs.linkSync(sourcePath, backupPath);
    const patch = [
      "*** Begin Patch",
      "*** Update File: old.txt",
      "*** Move to: new.txt",
      "*** End Patch",
    ].join("\n");
    let recreated = false;
    const { executeApplyPatch } = await importApplyPatchWithFs({
      rmSync: (path, options) => {
        const result = actualFs.rmSync(path, options);
        if (!recreated && String(path) === sourcePath) {
          recreated = true;
          actualFs.linkSync(backupPath, sourcePath);
        }
        return result;
      },
    });

    try {
      // When / Then
      expectApplyPatchError(
        () =>
          executeApplyPatch(workspace, patch, {
            readBeforeEdit: { revisionStatus: () => "current" },
          }),
        "tool_path_outside_workspace",
        "path changed outside",
      );
      expect(await readFile(sourcePath, "utf8")).toBe("old\n");
      expect(await pathExists(destinationPath)).toBe(false);
      expect(recreated).toBe(true);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an update source file opens through an outside-swapped parent restored before validation,
    When apply_patch verifies the opened descriptor before reading hunks,
    Then it rejects before matching outside content`, async () => {
    // Given
    const workspace = await createTemporaryDirectory("keel-patch-source-race-");
    const parentPath = join(workspace, "race");
    const backupParentPath = join(workspace, "race-backup");
    const targetPath = join(parentPath, "note.txt");
    const outside = await createTemporaryDirectory(
      "keel-patch-source-outside-",
    );
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
            readBeforeEdit: { revisionStatus: () => "current" },
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
    const workspace = await createTemporaryDirectory("keel-patch-ignore-race-");
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
            readBeforeEdit: { revisionStatus: () => "current" },
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
    const workspace = await createTemporaryDirectory(
      "keel-patch-prewrite-ignore-",
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
            readBeforeEdit: { revisionStatus: () => "current" },
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
