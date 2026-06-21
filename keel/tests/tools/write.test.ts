import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import type { KeelErrorCode } from "../../src/core/error.ts";
import { executeWrite } from "../../src/tools/write.ts";

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

describe("Write Tool", () => {
  test(`Given a missing workspace file,
    When the write tool creates it,
    Then the file exists on disk with the requested content`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-write-tool-"));

    try {
      // When
      const result = executeWrite(workspace, "config.json", '{"ok":true}\n');

      // Then
      expect(result.content).toBe("Wrote config.json");
      expect(await readFile(join(workspace, "config.json"), "utf8")).toBe(
        '{"ok":true}\n',
      );
      expect(await readdir(workspace)).toEqual(
        expect.not.arrayContaining([expect.stringContaining(".keel-write-")]),
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the workspace path is itself a symlink,
    When the write request uses an absolute path inside that symlinked workspace,
    Then it creates the file under the real workspace path`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-write-tool-"));
    const parent = await mkdtemp(join(tmpdir(), "keel-write-link-parent-"));
    const workspaceLink = join(parent, "workspace-link");
    await symlink(workspace, workspaceLink);
    const requestedPath = resolve(workspaceLink, "linked-absolute.txt");

    try {
      // When
      const result = executeWrite(workspaceLink, requestedPath, "linked\n");

      // Then
      expect(result.content).toBe(`Wrote ${requestedPath}`);
      expect(
        await readFile(join(workspace, "linked-absolute.txt"), "utf8"),
      ).toBe("linked\n");
      await expect(readFile(requestedPath, "utf8")).resolves.toBe("linked\n");
    } finally {
      await rm(parent, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the requested file is inside missing parent directories,
    When the write tool creates it,
    Then it creates the parent directories and writes the file`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-write-tool-"));

    try {
      // When
      const result = executeWrite(
        workspace,
        "src/config/settings.json",
        "{}\n",
      );

      // Then
      expect(result.content).toBe("Wrote src/config/settings.json");
      expect(
        await readFile(
          join(workspace, "src", "config", "settings.json"),
          "utf8",
        ),
      ).toBe("{}\n");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the requested content is empty,
    When the write tool creates the file,
    Then it creates a zero-byte file`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-write-tool-"));

    try {
      // When
      const result = executeWrite(workspace, "empty.txt", "");

      // Then
      expect(result.content).toBe("Wrote empty.txt");
      const stat = await lstat(join(workspace, "empty.txt"));
      expect(stat.size).toBe(0);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the target file already exists,
    When the write tool is called for that path,
    Then it rejects the request and leaves the file unchanged`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-write-tool-"));
    await writeFile(join(workspace, "config.json"), '{"old":true}\n', "utf8");

    try {
      // When / Then
      expectWriteError(
        () => executeWrite(workspace, "config.json", '{"new":true}\n'),
        "tool_file_exists",
        "file already exists",
      );
      expect(await readFile(join(workspace, "config.json"), "utf8")).toBe(
        '{"old":true}\n',
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the target path is an existing symlink,
    When the write tool is called for that path,
    Then it rejects the request and leaves the symlink target unchanged`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-write-tool-"));
    const outside = await mkdtemp(join(tmpdir(), "keel-write-outside-"));
    const outsidePath = join(outside, "secret.txt");
    await writeFile(outsidePath, "do not overwrite\n", "utf8");
    await symlink(outsidePath, join(workspace, "link.txt"));

    try {
      // When / Then
      expectWriteError(
        () => executeWrite(workspace, "link.txt", "new content\n"),
        "tool_file_exists",
        "file already exists",
      );
      expect(await readFile(outsidePath, "utf8")).toBe("do not overwrite\n");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test(`Given an existing parent path is a symlink to outside the workspace,
    When the write tool creates a child file through that parent,
    Then it rejects the escaped path without leaking the workspace root`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-write-tool-"));
    const outside = await mkdtemp(join(tmpdir(), "keel-write-outside-"));
    await symlink(outside, join(workspace, "linked-dir"));

    try {
      // When / Then
      try {
        executeWrite(workspace, "linked-dir/secret.txt", "leak\n");
        throw new Error("Expected write tool to throw");
      } catch (error) {
        expect(error).toMatchObject({
          name: "KeelError",
          code: "tool_path_outside_workspace",
          message: expect.stringContaining("outside the workspace"),
          recovery: expect.stringContaining("workspace-relative path"),
        });
        expect(error).toMatchObject({
          recovery: expect.not.stringContaining(await realpath(workspace)),
        });
      }
      await expect(
        readFile(join(outside, "secret.txt"), "utf8"),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test(`Given an existing parent path is a symlink to a gitignored workspace directory,
    When the write tool creates a child file through that parent,
    Then it rejects the ignored real target without creating the file`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-write-tool-"));
    await mkdir(join(workspace, "private"));
    await writeFile(join(workspace, ".gitignore"), "private/\n", "utf8");
    await symlink("private", join(workspace, "link"));

    try {
      // When / Then
      expectWriteError(
        () => executeWrite(workspace, "link/secret.txt", "secret\n"),
        "tool_path_ignored",
        "ignored path",
      );
      await expect(
        readFile(join(workspace, "private", "secret.txt"), "utf8"),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an absolute path outside the workspace,
    When the write tool validates the path,
    Then it rejects the workspace escape without creating the outside file`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-write-tool-"));
    const outside = await mkdtemp(join(tmpdir(), "keel-write-outside-"));
    const outsidePath = join(outside, "secret.txt");

    try {
      // When / Then
      expectWriteError(
        () => executeWrite(workspace, outsidePath, "secret\n"),
        "tool_path_outside_workspace",
        "outside the workspace",
      );
      await expect(readFile(outsidePath, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test(`Given a relative path escapes the workspace,
    When the write tool validates the path,
    Then it rejects the workspace escape without creating the outside file`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-write-tool-"));
    const outsidePath = join(workspace, "..", "secret.txt");

    try {
      // When / Then
      expectWriteError(
        () => executeWrite(workspace, "../secret.txt", "secret\n"),
        "tool_path_outside_workspace",
        "outside the workspace",
      );
      await expect(readFile(outsidePath, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a project gitignore excludes the requested file,
    When the write tool is called for that file,
    Then it rejects the ignored path without creating the file`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-write-tool-"));
    await writeFile(join(workspace, ".gitignore"), "secret.txt\n", "utf8");

    try {
      // When / Then
      expectWriteError(
        () => executeWrite(workspace, "secret.txt", "secret\n"),
        "tool_path_ignored",
        "ignored path",
      );
      await expect(
        readFile(join(workspace, "secret.txt"), "utf8"),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a project gitignore excludes a missing directory namespace,
    When the write tool is called for a file inside that namespace,
    Then it rejects the ignored path without creating parent directories`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-write-tool-"));
    await writeFile(join(workspace, ".gitignore"), "secret-dir/\n", "utf8");

    try {
      // When / Then
      expectWriteError(
        () => executeWrite(workspace, "secret-dir/secret.txt", "secret\n"),
        "tool_path_ignored",
        "ignored path",
      );
      await expect(lstat(join(workspace, "secret-dir"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a gitignore rule re-includes the requested file,
    When the write tool is called for that re-included file,
    Then it creates the file`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-write-tool-"));
    await writeFile(join(workspace, ".gitignore"), "*.txt\n!keep.txt\n");

    try {
      // When
      const result = executeWrite(workspace, "keep.txt", "visible\n");

      // Then
      expect(result.content).toBe("Wrote keep.txt");
      expect(await readFile(join(workspace, "keep.txt"), "utf8")).toBe(
        "visible\n",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an existing parent segment is a regular file,
    When the write tool is called for a child below that path,
    Then it reports a recoverable path error and leaves the parent file unchanged`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-write-tool-"));
    await writeFile(join(workspace, "config"), "not a directory\n", "utf8");

    try {
      // When / Then
      expectWriteError(
        () => executeWrite(workspace, "config/settings.json", "{}\n"),
        "tool_not_directory",
        "parent path is not a directory",
      );
      expect(await readFile(join(workspace, "config"), "utf8")).toBe(
        "not a directory\n",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
