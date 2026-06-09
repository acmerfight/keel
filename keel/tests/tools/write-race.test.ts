import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { KeelErrorCode } from "../../src/core/error.ts";

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

async function importWriteWithFs(
  overrides: Partial<typeof import("node:fs")>,
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
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-write-race-"));
    const { executeWrite } = await importWriteWithFs({
      writeFileSync: () => {
        throw errno("EEXIST");
      },
    });

    try {
      // When / Then
      expectWriteError(
        () => executeWrite(workspace, "race.txt", "content\n"),
        "tool_file_exists",
        "file already exists",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a parent segment becomes non-directory during creation,
    When the write tool creates parent directories,
    Then it reports a recoverable not-directory error`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-write-race-"));
    const { executeWrite } = await importWriteWithFs({
      mkdirSync: () => {
        throw errno("ENOTDIR");
      },
    });

    try {
      // When / Then
      expectWriteError(
        () => executeWrite(workspace, "nested/race.txt", "content\n"),
        "tool_not_directory",
        "parent path is not a directory",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given parent directory creation fails unexpectedly,
    When the write tool cannot normalize that failure,
    Then it preserves the original terminal error`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-write-race-"));
    const originalError = errno("EIO");
    const { executeWrite } = await importWriteWithFs({
      mkdirSync: () => {
        throw originalError;
      },
    });

    try {
      // When / Then
      expect(() =>
        executeWrite(workspace, "nested/io.txt", "content\n"),
      ).toThrow(originalError);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a parent directory realpath escapes after directory creation,
    When the write tool revalidates the parent before writing,
    Then it rejects the escaped parent path`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-write-race-"));
    const outside = await mkdtemp(join(tmpdir(), "keel-write-outside-"));
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
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
      await rm(workspace, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test(`Given exclusive file creation reports a parent path collision,
    When the write tool normalizes the write failure,
    Then it reports a recoverable not-directory error`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-write-race-"));
    const { executeWrite } = await importWriteWithFs({
      writeFileSync: () => {
        throw errno("ENOTDIR");
      },
    });

    try {
      // When / Then
      expectWriteError(
        () => executeWrite(workspace, "race.txt", "content\n"),
        "tool_not_directory",
        "parent path is not a directory",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given create-path existence validation sees an unexpected filesystem error,
    When the write tool validates the target,
    Then it preserves the original terminal error`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-write-race-"));
    const originalError = errno("EIO");
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const { executeWrite } = await importWriteWithFs({
      lstatSync: (path) => {
        if (String(path).endsWith("target.txt")) throw originalError;
        return actualFs.lstatSync(path);
      },
    });

    try {
      // When / Then
      expect(() => executeWrite(workspace, "target.txt", "content\n")).toThrow(
        originalError,
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an existing ancestor is no longer a directory after target validation,
    When the write tool validates that ancestor,
    Then it reports a recoverable not-directory error`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-write-race-"));
    await writeFile(join(workspace, "parent"), "not a directory\n", "utf8");
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const { executeWrite } = await importWriteWithFs({
      lstatSync: (path) => {
        if (String(path).endsWith(join("parent", "child.txt"))) {
          throw errno("ENOENT");
        }
        return actualFs.lstatSync(path);
      },
    });

    try {
      // When / Then
      expectWriteError(
        () => executeWrite(workspace, "parent/child.txt", "content\n"),
        "tool_not_directory",
        "parent path is not a directory",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the filesystem reports an unexpected write failure,
    When the write tool cannot normalize that failure,
    Then it preserves the original terminal error`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-write-race-"));
    const originalError = errno("EIO");
    const { executeWrite } = await importWriteWithFs({
      writeFileSync: () => {
        throw originalError;
      },
    });

    try {
      // When / Then
      expect(() => executeWrite(workspace, "io.txt", "content\n")).toThrow(
        originalError,
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
