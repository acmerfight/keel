import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { KeelErrorCode } from "../../src/core/error.ts";
import { executeEdit } from "../../src/tools/edit.ts";

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

describe("Edit Tool", () => {
  test(`Given an edit request uses an absolute path outside the workspace,
    When the edit tool validates the path,
    Then it rejects the path and leaves the outside file unchanged`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-edit-tool-"));
    const outside = await mkdtemp(join(tmpdir(), "keel-edit-outside-"));
    const outsidePath = join(outside, "secret.txt");
    await writeFile(outsidePath, "old secret\n", "utf8");

    try {
      // When / Then
      expectEditError(
        () => executeEdit(workspace, outsidePath, "old", "new"),
        "tool_path_outside_workspace",
        "outside the workspace",
      );
      expect(await readFile(outsidePath, "utf8")).toBe("old secret\n");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test(`Given an edit request uses a missing absolute path outside the workspace,
    When the edit tool validates the path,
    Then it rejects the workspace escape without revealing path existence`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-edit-tool-"));
    const outside = await mkdtemp(join(tmpdir(), "keel-edit-outside-"));
    const outsidePath = join(outside, "missing.txt");

    try {
      // When / Then
      expectEditError(
        () => executeEdit(workspace, outsidePath, "old", "new"),
        "tool_path_outside_workspace",
        "outside the workspace",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test(`Given a symlink inside the workspace points outside,
    When the edit tool resolves the target,
    Then it rejects the escaped path and leaves the outside file unchanged`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-edit-tool-"));
    const outside = await mkdtemp(join(tmpdir(), "keel-edit-outside-"));
    const outsidePath = join(outside, "secret.txt");
    await writeFile(outsidePath, "old secret\n", "utf8");
    await symlink(outsidePath, join(workspace, "link.txt"));

    try {
      // When / Then
      expectEditError(
        () => executeEdit(workspace, "link.txt", "old", "new"),
        "tool_path_outside_workspace",
        "outside the workspace",
      );
      expect(await readFile(outsidePath, "utf8")).toBe("old secret\n");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test(`Given a project gitignore excludes a file,
    When the edit tool is called for that file,
    Then it rejects the request and leaves the file unchanged`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-edit-tool-"));
    await writeFile(join(workspace, ".gitignore"), "secret.txt\n", "utf8");
    await writeFile(join(workspace, "secret.txt"), "old secret\n", "utf8");

    try {
      // When / Then
      expectEditError(
        () => executeEdit(workspace, "secret.txt", "old", "new"),
        "tool_path_ignored",
        "ignored path",
      );
      expect(await readFile(join(workspace, "secret.txt"), "utf8")).toBe(
        "old secret\n",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a nested gitignore excludes a file,
    When the edit tool is called for that nested file,
    Then it rejects the request and leaves the file unchanged`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-edit-tool-"));
    await mkdir(join(workspace, "src"));
    await writeFile(join(workspace, "src", ".gitignore"), "secret.txt\n");
    await writeFile(join(workspace, "src", "secret.txt"), "old secret\n");

    try {
      // When / Then
      expectEditError(
        () => executeEdit(workspace, "src/secret.txt", "old", "new"),
        "tool_path_ignored",
        "ignored path",
      );
      expect(await readFile(join(workspace, "src", "secret.txt"), "utf8")).toBe(
        "old secret\n",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a project gitignore excludes a directory,
    When the edit tool is called for a file inside that directory,
    Then it rejects the request and leaves the file unchanged`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-edit-tool-"));
    await mkdir(join(workspace, "secret-dir"));
    await writeFile(join(workspace, ".gitignore"), "secret-dir/\n", "utf8");
    await writeFile(
      join(workspace, "secret-dir", "secret.txt"),
      "old secret\n",
      "utf8",
    );

    try {
      // When / Then
      expectEditError(
        () => executeEdit(workspace, "secret-dir/secret.txt", "old", "new"),
        "tool_path_ignored",
        "ignored path",
      );
      expect(
        await readFile(join(workspace, "secret-dir", "secret.txt"), "utf8"),
      ).toBe("old secret\n");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a gitignore rule re-includes a file,
    When the edit tool is called for that re-included file,
    Then it edits the file`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-edit-tool-"));
    await writeFile(join(workspace, ".gitignore"), "*.txt\n!keep.txt\n");
    await writeFile(join(workspace, "keep.txt"), "old visible\n");

    try {
      // When
      const result = executeEdit(workspace, "keep.txt", "old", "new");

      // Then
      expect(result.content).toBe("Edited keep.txt");
      expect(await readFile(join(workspace, "keep.txt"), "utf8")).toBe(
        "new visible\n",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
