import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { KeelErrorCode } from "../../src/core/error.ts";

type PathLike = Parameters<typeof import("node:fs").realpathSync>[0];

interface FsOverrides {
  readonly lstatSync?: (
    path: PathLike,
  ) => ReturnType<typeof import("node:fs").lstatSync>;
  readonly mkdirSync?: (path: PathLike) => void;
  readonly realpathSync?: (path: PathLike) => string;
  readonly writeFileSync?: (
    path: PathLike,
    data: string,
    options?: unknown,
  ) => void;
}

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

  test(`Given the target appears after write validation,
    When the write tool reaches exclusive file creation,
    Then it reports a recoverable file-exists error`, async () => {
    await withWriteWorkspace(async (workspace) => {
      // Given
      const { executeWrite } = await importWriteWithFs({
        writeFileSync: () => {
          throw errno("EEXIST");
        },
      });

      // When / Then
      expectWriteError(
        () => executeWrite(workspace, "race.txt", "content\n"),
        "tool_file_exists",
        "file already exists",
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

  test(`Given exclusive file creation reports a parent path collision,
    When the write tool normalizes the write failure,
    Then it reports a recoverable not-directory error`, async () => {
    await withWriteWorkspace(async (workspace) => {
      // Given
      const { executeWrite } = await importWriteWithFs({
        writeFileSync: () => {
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
