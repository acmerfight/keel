import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { KeelErrorCode } from "../../src/core/error.ts";

type PathLike = Parameters<typeof import("node:fs").realpathSync>[0];
type FsModule = typeof import("node:fs");

interface FsOverrides {
  readonly openSync?: FsModule["openSync"];
  readonly realpathSync?: (path: PathLike) => string;
}

function expectReadError(
  action: () => unknown,
  code: KeelErrorCode,
  message: string,
): void {
  try {
    action();
    throw new Error("Expected read tool to throw");
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

async function importReadWithFs(
  overrides: FsOverrides,
): Promise<typeof import("../../src/tools/read.ts")> {
  vi.resetModules();
  const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
  vi.doMock("node:fs", () => ({ ...actualFs, ...overrides }));
  return import("../../src/tools/read.ts");
}

describe("Read Tool Race Handling", () => {
  afterEach(() => {
    vi.doUnmock("node:fs");
    vi.resetModules();
  });

  test(`Given a resolved file parent is replaced by an outside symlink,
    When the read tool opens the validated target path,
    Then it rejects the escaped target without returning outside content`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-read-race-"));
    const parentPath = join(workspace, "race");
    const targetPath = join(parentPath, "secret.txt");
    const outside = await mkdtemp(join(tmpdir(), "keel-read-toc-outside-"));
    await mkdir(parentPath);
    await writeFile(targetPath, "inside\n", "utf8");
    await writeFile(join(outside, "secret.txt"), "outside-secret\n", "utf8");
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    let swapped = false;
    const { executeRead } = await importReadWithFs({
      realpathSync: (path) => {
        const resolved = actualFs.realpathSync(path);
        if (!swapped && String(path).endsWith(join("race", "secret.txt"))) {
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
      expectReadError(
        () => executeRead(workspace, "race/secret.txt"),
        "tool_path_outside_workspace",
        "outside the workspace",
      );
      expect(await readFile(join(outside, "secret.txt"), "utf8")).toBe(
        "outside-secret\n",
      );
      expect(await pathExists(targetPath)).toBe(true);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test(`Given a file parent is swapped outside for open and restored before revalidation,
    When the read tool verifies the opened file descriptor,
    Then it rejects the descriptor without returning outside content`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-read-fd-race-"));
    const parentPath = join(workspace, "race");
    const backupParentPath = join(workspace, "race-backup");
    const targetPath = join(parentPath, "secret.txt");
    const outside = await mkdtemp(join(tmpdir(), "keel-read-fd-outside-"));
    await mkdir(parentPath);
    await writeFile(targetPath, "inside\n", "utf8");
    await writeFile(join(outside, "secret.txt"), "outside-secret\n", "utf8");
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    let racedOpen = false;
    const { executeRead } = await importReadWithFs({
      openSync: (path, flags, mode) => {
        if (!racedOpen && String(path).endsWith(join("race", "secret.txt"))) {
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
      expectReadError(
        () => executeRead(workspace, "race/secret.txt"),
        "tool_path_outside_workspace",
        "outside the workspace",
      );
      expect(await readFile(join(outside, "secret.txt"), "utf8")).toBe(
        "outside-secret\n",
      );
      expect(await readFile(targetPath, "utf8")).toBe("inside\n");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test(`Given an opened read target path is replaced by a directory,
    When the read tool verifies the opened descriptor path,
    Then it rejects the non-file target without returning opened content`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-read-type-race-"));
    const parentPath = join(workspace, "race");
    const targetPath = join(parentPath, "secret.txt");
    await mkdir(parentPath);
    await writeFile(targetPath, "inside\n", "utf8");
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    let swapped = false;
    const { executeRead } = await importReadWithFs({
      openSync: (path, flags, mode) => {
        if (!swapped && String(path).endsWith(join("race", "secret.txt"))) {
          swapped = true;
          const fd = actualFs.openSync(path, flags, mode);
          actualFs.rmSync(targetPath, { force: true });
          actualFs.mkdirSync(targetPath);
          return fd;
        }
        return actualFs.openSync(path, flags, mode);
      },
    });

    try {
      // When / Then
      expectReadError(
        () => executeRead(workspace, "race/secret.txt"),
        "tool_not_file",
        "unsupported file type",
      );
      expect(swapped).toBe(true);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a read target opens through an ignored workspace symlink,
    When the read tool rechecks the opened descriptor path,
    Then it rejects the ignored file without returning its content`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-read-ignore-race-"));
    const targetPath = join(workspace, "note.txt");
    const ignoredPath = join(workspace, "private");
    const ignoredTargetPath = join(ignoredPath, "note.txt");
    await mkdir(ignoredPath);
    await writeFile(join(workspace, ".gitignore"), "private/\n", "utf8");
    await writeFile(targetPath, "inside\n", "utf8");
    await writeFile(ignoredTargetPath, "ignored\n", "utf8");
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    let swapped = false;
    const { executeRead } = await importReadWithFs({
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
      expectReadError(
        () => executeRead(workspace, "note.txt"),
        "tool_path_ignored",
        "ignored path",
      );
      expect(await readFile(ignoredTargetPath, "utf8")).toBe("ignored\n");
      expect(swapped).toBe(true);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform === "win32")(
    `Given a regular file is swapped to a device symlink immediately before open,
    When the read tool verifies the nonblocking descriptor,
    Then it rejects the escaped device without hanging`,
    async () => {
      // Given
      const workspace = await mkdtemp(join(tmpdir(), "keel-read-fifo-race-"));
      const targetPath = join(workspace, "trap.txt");
      await writeFile(targetPath, "inside\n", "utf8");
      const actualFs =
        await vi.importActual<typeof import("node:fs")>("node:fs");
      let swapped = false;
      const { executeRead } = await importReadWithFs({
        openSync: (path, flags, mode) => {
          if (!swapped && String(path).endsWith("trap.txt")) {
            swapped = true;
            actualFs.rmSync(targetPath, { force: true });
            actualFs.symlinkSync("/dev/null", targetPath);
          }
          return actualFs.openSync(path, flags, mode);
        },
      });

      try {
        // When / Then
        expectReadError(
          () => executeRead(workspace, "trap.txt"),
          "tool_path_outside_workspace",
          "outside the workspace",
        );
        expect(swapped).toBe(true);
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    },
  );
});
