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
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { KeelErrorCode } from "../../src/core/error.ts";
import {
  createGitWorkspace,
  runGit as git,
} from "../../src/testing/cli-harness.ts";

type PathLike = Parameters<typeof import("node:fs").realpathSync>[0];
type FsModule = typeof import("node:fs");

interface FsOverrides {
  readonly lstatSync?: (
    path: PathLike,
  ) => ReturnType<typeof import("node:fs").lstatSync>;
  readonly linkSync?: FsModule["linkSync"];
  readonly mkdirSync?: (path: PathLike) => void;
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
    "keel/last-edit-checkpoint.json",
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

  test(`Given debug logging is enabled and temp cleanup fails after create publish,
    When the write tool finishes the create,
    Then it reports cleanup metadata without failing or logging file contents`, async () => {
    const workspace = await createGitWorkspace("keel-write-race-");
    const targetPath = join(await realpath(workspace), "created.txt");
    const previousDebug = process.env[DEBUG_ENV_KEY];
    process.env[DEBUG_ENV_KEY] = "1";
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});

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
      expect(stderr).toHaveBeenCalledWith(
        expect.stringContaining("write temp cleanup failed"),
      );
      const debugOutput = stderr.mock.calls
        .map((call) => call.map(String).join(" "))
        .join("\n");
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
