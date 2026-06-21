import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import type { KeelErrorCode } from "../../src/core/error.ts";
import {
  createGitWorkspace,
  runGit as git,
} from "../../src/testing/cli-harness.ts";
import { executeEdit } from "../../src/tools/edit.ts";

const EDIT_FILE_SIZE_LIMIT_BYTES = 10 * 1024 * 1024;

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

function expectEditError(
  action: () => unknown,
  code: KeelErrorCode,
  message: string,
  recovery?: string,
): void {
  try {
    action();
    throw new Error("Expected edit tool to throw");
  } catch (error) {
    expect(error).toMatchObject({
      name: "KeelError",
      code,
      message: expect.stringContaining(message),
      ...(recovery !== undefined
        ? { recovery: expect.stringContaining(recovery) }
        : {}),
    });
  }
}

function singleEdit(oldText: string, newText: string, replaceAll?: boolean) {
  return [
    {
      oldText,
      newText,
      ...(replaceAll !== undefined ? { replaceAll } : {}),
    },
  ];
}

describe("Edit Tool", () => {
  test(`Given an edit target is larger than the file safety limit,
    When the edit tool validates the target,
    Then it rejects the file before text decoding and leaves it unchanged`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-edit-tool-"));
    const filePath = join(workspace, "large.log");
    await writeFile(filePath, "");
    await truncate(filePath, EDIT_FILE_SIZE_LIMIT_BYTES + 1);

    try {
      // When / Then
      expectEditError(
        () => executeEdit(workspace, "large.log", singleEdit("old", "new")),
        "tool_file_too_large",
        "10,485,761 bytes; limit 10,485,760 bytes (10 MiB)",
        "Use grep or read a smaller region",
      );
      expect((await readFile(filePath)).byteLength).toBe(
        EDIT_FILE_SIZE_LIMIT_BYTES + 1,
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an edit cannot create its replacement file in the target directory,
    When the edit tool writes the update,
    Then the original file remains unchanged and no edit checkpoint is recorded`, async () => {
    // Given
    const workspace = await createGitWorkspace("keel-edit-tool-atomic-");
    const filePath = join(workspace, "note.txt");
    await writeFile(filePath, "old value\n", "utf8");
    const checkpoint = await checkpointPath(workspace);

    try {
      await chmod(workspace, 0o555);

      // When / Then
      expect(() =>
        executeEdit(workspace, "note.txt", singleEdit("old", "new")),
      ).toThrow();
      expect(await readFile(filePath, "utf8")).toBe("old value\n");
      await chmod(workspace, 0o755);
      expect(await pathExists(checkpoint)).toBe(false);
    } finally {
      await chmod(workspace, 0o755).catch(() => undefined);
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an edit target file is read-only in a writable directory,
    When the edit tool writes the update,
    Then it preserves the direct-overwrite permission failure and leaves the file unchanged`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-edit-tool-"));
    const filePath = join(workspace, "note.txt");
    await writeFile(filePath, "old value\n", "utf8");
    await chmod(filePath, 0o444);

    try {
      // When / Then
      expect(() =>
        executeEdit(workspace, "note.txt", singleEdit("old", "new")),
      ).toThrow();
      expect(await readFile(filePath, "utf8")).toBe("old value\n");
    } finally {
      await chmod(filePath, 0o644).catch(() => undefined);
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an edit succeeds through a temporary replacement file,
    When the edit tool finishes,
    Then only the target file and successful checkpoint remain`, async () => {
    // Given
    const workspace = await createGitWorkspace("keel-edit-tool-atomic-");
    const filePath = join(workspace, "note.txt");
    await writeFile(filePath, "old value\n", "utf8");
    const checkpoint = await checkpointPath(workspace);

    try {
      // When
      const result = executeEdit(
        workspace,
        "note.txt",
        singleEdit("old", "new"),
      );

      // Then
      expect(result.content).toBe("Edited note.txt");
      expect(await readFile(filePath, "utf8")).toBe("new value\n");
      expect(await readFile(checkpoint, "utf8")).toContain("old value");
      expect(await readFile(checkpoint, "utf8")).toContain("new value");
      expect(await readdir(workspace)).toEqual(
        expect.not.arrayContaining([expect.stringContaining(".keel-edit-")]),
      );
      expect(await readdir(dirname(checkpoint))).toContain(
        "last-edit-checkpoint.json",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given one file has multiple independent targets,
    When the edit tool receives multiple edits,
    Then it updates every target with one checkpoint operation`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-edit-tool-"));
    await writeFile(
      join(workspace, "settings.ts"),
      "export const timeoutMs = 30000;\nexport const retryCount = 2;\n",
      "utf8",
    );

    try {
      // When
      const result = executeEdit(workspace, "settings.ts", [
        {
          oldText: "export const timeoutMs = 30000;",
          newText: "export const timeoutMs = 45000;",
        },
        {
          oldText: "export const retryCount = 2;",
          newText: "export const retryCount = 3;",
        },
      ]);

      // Then
      expect(result.content).toBe("Edited settings.ts");
      expect(result.checkpointOperation).toMatchObject({
        operation: "edit",
      });
      expect(await readFile(join(workspace, "settings.ts"), "utf8")).toBe(
        "export const timeoutMs = 45000;\nexport const retryCount = 3;\n",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given one edit in a multi-edit request is stale,
    When the edit tool validates the request,
    Then it rejects the request and leaves the file unchanged`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-edit-tool-"));
    const original =
      "export const timeoutMs = 30000;\nexport const retryCount = 2;\n";
    await writeFile(join(workspace, "settings.ts"), original, "utf8");

    try {
      // When / Then
      expectEditError(
        () =>
          executeEdit(workspace, "settings.ts", [
            {
              oldText: "export const timeoutMs = 30000;",
              newText: "export const timeoutMs = 45000;",
            },
            {
              oldText: "export const retryCount = 4;",
              newText: "export const retryCount = 3;",
            },
          ]),
        "tool_old_string_not_found",
        "old string not found",
      );
      expect(await readFile(join(workspace, "settings.ts"), "utf8")).toBe(
        original,
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given two edits target overlapping text,
    When the edit tool validates the request,
    Then it rejects the request and leaves the file unchanged`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-edit-tool-"));
    const original = "one\ntwo\nthree\n";
    await writeFile(join(workspace, "note.txt"), original, "utf8");

    try {
      // When / Then
      expectEditError(
        () =>
          executeEdit(workspace, "note.txt", [
            { oldText: "one\ntwo\n", newText: "ONE\nTWO\n" },
            { oldText: "two\nthree\n", newText: "TWO\nTHREE\n" },
          ]),
        "tool_edit_overlap",
        "overlap",
      );
      expect(await readFile(join(workspace, "note.txt"), "utf8")).toBe(
        original,
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given two edits target the same exact span,
    When the edit tool sorts and validates the request,
    Then it rejects the duplicate target before writing`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-edit-tool-"));
    const original = "alpha\nbeta\n";
    await writeFile(join(workspace, "note.txt"), original, "utf8");

    try {
      // When / Then
      expectEditError(
        () =>
          executeEdit(workspace, "note.txt", [
            { oldText: "alpha", newText: "ALPHA" },
            { oldText: "alpha", newText: "Alpha" },
          ]),
        "tool_edit_overlap",
        "overlap",
      );
      expect(await readFile(join(workspace, "note.txt"), "utf8")).toBe(
        original,
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an editable file has permissions wider than the process umask,
    When the edit tool atomically replaces the file,
    Then it preserves the original file mode`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-edit-tool-"));
    const filePath = join(workspace, "note.txt");
    await writeFile(filePath, "old value\n", "utf8");
    await chmod(filePath, 0o666);

    try {
      // When
      const originalUmask = process.umask(0o077);
      try {
        executeEdit(workspace, "note.txt", singleEdit("old", "new"));
      } finally {
        process.umask(originalUmask);
      }

      // Then
      expect(await readFile(filePath, "utf8")).toBe("new value\n");
      expect((await stat(filePath)).mode & 0o777).toBe(0o666);
    } finally {
      await chmod(filePath, 0o644).catch(() => undefined);
      await rm(workspace, { recursive: true, force: true });
    }
  });

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
        () => executeEdit(workspace, outsidePath, singleEdit("old", "new")),
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
        () => executeEdit(workspace, outsidePath, singleEdit("old", "new")),
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
        () => executeEdit(workspace, "link.txt", singleEdit("old", "new")),
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
        () => executeEdit(workspace, "secret.txt", singleEdit("old", "new")),
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

  test(`Given a project gitignore excludes a symlink to a visible file,
    When the edit tool is called through that ignored symlink,
    Then it rejects the request path and leaves the target file unchanged`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-edit-tool-"));
    await writeFile(
      join(workspace, ".gitignore"),
      "ignored-link.txt\n",
      "utf8",
    );
    await writeFile(join(workspace, "visible.txt"), "old visible\n", "utf8");
    await symlink("visible.txt", join(workspace, "ignored-link.txt"));

    try {
      // When / Then
      expectEditError(
        () =>
          executeEdit(workspace, "ignored-link.txt", singleEdit("old", "new")),
        "tool_path_ignored",
        "ignored path",
      );
      expect(await readFile(join(workspace, "visible.txt"), "utf8")).toBe(
        "old visible\n",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a project gitignore excludes a visible symlink target,
    When the edit tool is called through the symlink,
    Then it rejects the resolved target and leaves the file unchanged`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-edit-tool-"));
    await writeFile(join(workspace, ".gitignore"), "secret.txt\n", "utf8");
    await writeFile(join(workspace, "secret.txt"), "old secret\n", "utf8");
    await symlink("secret.txt", join(workspace, "visible-link.txt"));

    try {
      // When / Then
      expectEditError(
        () =>
          executeEdit(workspace, "visible-link.txt", singleEdit("old", "new")),
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
        () =>
          executeEdit(workspace, "src/secret.txt", singleEdit("old", "new")),
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
        () =>
          executeEdit(
            workspace,
            "secret-dir/secret.txt",
            singleEdit("old", "new"),
          ),
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
      const result = executeEdit(
        workspace,
        "keep.txt",
        singleEdit("old", "new"),
      );

      // Then
      expect(result.content).toBe("Edited keep.txt");
      expect(await readFile(join(workspace, "keep.txt"), "utf8")).toBe(
        "new visible\n",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a CRLF file and an edit target copied with LF line endings,
    When the edit tool applies the replacement,
    Then it preserves the file's CRLF line endings`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-edit-tool-"));
    await writeFile(
      join(workspace, "note.ts"),
      'const value = "old";\r\nconst after = true;\r\n',
      "utf8",
    );

    try {
      // When
      const result = executeEdit(
        workspace,
        "note.ts",
        singleEdit('const value = "old";\n', 'const value = "new";\n'),
      );

      // Then
      expect(result.content).toBe("Edited note.ts");
      expect(await readFile(join(workspace, "note.ts"), "utf8")).toBe(
        'const value = "new";\r\nconst after = true;\r\n',
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a mixed-line-ending file and the matched span uses LF,
    When the edit tool applies the replacement,
    Then it preserves the matched span's line ending instead of normalizing the file`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-edit-tool-"));
    await writeFile(
      join(workspace, "note.ts"),
      "header\r\nconst value = old;\nfooter\r\n",
      "utf8",
    );

    try {
      // When
      const result = executeEdit(
        workspace,
        "note.ts",
        singleEdit("const value = old;\n", "const value = new;\n"),
      );

      // Then
      expect(result.content).toBe("Edited note.ts");
      expect(await readFile(join(workspace, "note.ts"), "utf8")).toBe(
        "header\r\nconst value = new;\nfooter\r\n",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the matched source span has no line ending and the replacement inserts one,
    When the edit tool applies the replacement,
    Then it uses the matched line's line ending`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-edit-tool-"));
    await writeFile(
      join(workspace, "note.ts"),
      "const value = old;\r\nnext();\r\n",
      "utf8",
    );

    try {
      // When
      const result = executeEdit(
        workspace,
        "note.ts",
        singleEdit("old", "new\nwrapped"),
      );

      // Then
      expect(result.content).toBe("Edited note.ts");
      expect(await readFile(join(workspace, "note.ts"), "utf8")).toBe(
        "const value = new\r\nwrapped;\r\nnext();\r\n",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the matched source span is on a final line without its own line ending,
    When the edit tool applies a replacement with a line ending,
    Then it uses the previous line's line ending`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-edit-tool-"));
    await writeFile(
      join(workspace, "note.ts"),
      "header\r\nconst value = old",
      "utf8",
    );

    try {
      // When
      const result = executeEdit(
        workspace,
        "note.ts",
        singleEdit("old", "new\nwrapped"),
      );

      // Then
      expect(result.content).toBe("Edited note.ts");
      expect(await readFile(join(workspace, "note.ts"), "utf8")).toBe(
        "header\r\nconst value = new\r\nwrapped",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the file has no existing line endings and the replacement inserts one,
    When the edit tool applies the replacement,
    Then it uses LF as the default line ending`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-edit-tool-"));
    await writeFile(join(workspace, "note.ts"), "old", "utf8");

    try {
      // When
      const result = executeEdit(
        workspace,
        "note.ts",
        singleEdit("old", "new\r\nwrapped"),
      );

      // Then
      expect(result.content).toBe("Edited note.ts");
      expect(await readFile(join(workspace, "note.ts"), "utf8")).toBe(
        "new\nwrapped",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a UTF-8 BOM file and an edit target copied with LF line endings,
    When the edit tool applies the replacement,
    Then it preserves the BOM and the file's line endings`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-edit-tool-"));
    await writeFile(
      join(workspace, "note.txt"),
      Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from("title: old\r\nnext: keep\r\n", "utf8"),
      ]),
    );

    try {
      // When
      const result = executeEdit(
        workspace,
        "note.txt",
        singleEdit("title: old\n", "title: new\n"),
      );

      // Then
      expect(result.content).toBe("Edited note.txt");
      expect(await readFile(join(workspace, "note.txt"))).toEqual(
        Buffer.concat([
          Buffer.from([0xef, 0xbb, 0xbf]),
          Buffer.from("title: new\r\nnext: keep\r\n", "utf8"),
        ]),
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a file has repeated exact text,
    When replaceAll is enabled,
    Then every exact occurrence is replaced`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-edit-tool-"));
    await writeFile(join(workspace, "note.txt"), "old one\nold two\n", "utf8");

    try {
      // When
      const result = executeEdit(
        workspace,
        "note.txt",
        singleEdit("old", "new", true),
      );

      // Then
      expect(result.content).toBe("Edited note.txt");
      expect(await readFile(join(workspace, "note.txt"), "utf8")).toBe(
        "new one\nnew two\n",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a CRLF file has repeated blocks and replaceAll receives an LF target,
    When replaceAll is enabled,
    Then every occurrence is replaced while preserving CRLF`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-edit-tool-"));
    await writeFile(
      join(workspace, "note.ts"),
      [
        "const first = old;",
        "next();",
        "---",
        "const first = old;",
        "next();",
        "",
      ].join("\r\n"),
      "utf8",
    );

    try {
      // When
      const result = executeEdit(
        workspace,
        "note.ts",
        singleEdit(
          ["const first = old;", "next();", ""].join("\n"),
          ["const first = new;", "next();", ""].join("\n"),
          true,
        ),
      );

      // Then
      expect(result.content).toBe("Edited note.ts");
      expect(await readFile(join(workspace, "note.ts"), "utf8")).toBe(
        [
          "const first = new;",
          "next();",
          "---",
          "const first = new;",
          "next();",
          "",
        ].join("\r\n"),
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a CRLF file has repeated single-line targets and replaceAll inserts lines,
    When replaceAll is enabled,
    Then every replacement uses the matched line's CRLF ending`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-edit-tool-"));
    await writeFile(
      join(workspace, "note.ts"),
      "const first = old;\r\nconst second = old;\r\n",
      "utf8",
    );

    try {
      // When
      const result = executeEdit(
        workspace,
        "note.ts",
        singleEdit("old", "new\nwrapped", true),
      );

      // Then
      expect(result.content).toBe("Edited note.ts");
      expect(await readFile(join(workspace, "note.ts"), "utf8")).toBe(
        "const first = new\r\nwrapped;\r\nconst second = new\r\nwrapped;\r\n",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a file has repeated exact text,
    When replaceAll is omitted,
    Then the edit is rejected as ambiguous and the file is unchanged`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-edit-tool-"));
    await writeFile(join(workspace, "note.txt"), "old one\nold two\n", "utf8");

    try {
      // When / Then
      expectEditError(
        () => executeEdit(workspace, "note.txt", singleEdit("old", "new")),
        "tool_old_string_not_unique",
        "old string appears 2 times",
      );
      expect(await readFile(join(workspace, "note.txt"), "utf8")).toBe(
        "old one\nold two\n",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given replaceAll is enabled but the exact text is absent,
    When the edit tool validates the request,
    Then it reports not found and leaves the file unchanged`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-edit-tool-"));
    await writeFile(join(workspace, "note.txt"), "keep this\n", "utf8");

    try {
      // When / Then
      expectEditError(
        () =>
          executeEdit(
            workspace,
            "note.txt",
            singleEdit("missing", "new", true),
          ),
        "tool_old_string_not_found",
        "old string not found",
      );
      expect(await readFile(join(workspace, "note.txt"), "utf8")).toBe(
        "keep this\n",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an empty editable file,
    When the edit tool searches for a non-empty target,
    Then it reports not found and leaves the file unchanged`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-edit-tool-"));
    await writeFile(join(workspace, "empty.txt"), "", "utf8");

    try {
      // When / Then
      expectEditError(
        () => executeEdit(workspace, "empty.txt", singleEdit("missing", "new")),
        "tool_old_string_not_found",
        "old string not found",
      );
      expect(await readFile(join(workspace, "empty.txt"), "utf8")).toBe("");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the replacement is identical to the target text,
    When the edit tool validates the request,
    Then it rejects the no-op and leaves the file unchanged`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-edit-tool-"));
    await writeFile(join(workspace, "note.txt"), "keep me\n", "utf8");

    try {
      // When / Then
      expectEditError(
        () => executeEdit(workspace, "note.txt", singleEdit("keep", "keep")),
        "tool_edit_no_op",
        "old string and new string are identical",
      );
      expect(await readFile(join(workspace, "note.txt"), "utf8")).toBe(
        "keep me\n",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the replacement only differs from the target by line endings,
    When the edit tool validates the request,
    Then it rejects the normalized no-op and leaves the file unchanged`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-edit-tool-"));
    await writeFile(join(workspace, "note.txt"), "keep me\r\n", "utf8");

    try {
      // When / Then
      expectEditError(
        () =>
          executeEdit(
            workspace,
            "note.txt",
            singleEdit("keep me\r\n", "keep me\n"),
          ),
        "tool_edit_no_op",
        "old string and new string are identical",
      );
      expect(await readFile(join(workspace, "note.txt"), "utf8")).toBe(
        "keep me\r\n",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an edit target differs only by trailing line whitespace,
    When the edit tool locates the target,
    Then it replaces the original span without changing unrelated bytes`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-edit-tool-"));
    await writeFile(
      join(workspace, "note.ts"),
      [
        "prefix  ",
        "function oldValue() {",
        "  return value;  ",
        "}",
        "suffix\t ",
        "",
      ].join("\n"),
      "utf8",
    );

    try {
      // When
      const result = executeEdit(
        workspace,
        "note.ts",
        singleEdit(
          ["function oldValue() {", "  return value;", "}"].join("\n"),
          ["function newValue() {", "  return next;", "}"].join("\n"),
        ),
      );

      // Then
      expect(result.content).toBe("Edited note.ts");
      expect(await readFile(join(workspace, "note.ts"), "utf8")).toBe(
        [
          "prefix  ",
          "function newValue() {",
          "  return next;",
          "}",
          "suffix\t ",
          "",
        ].join("\n"),
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an ASCII punctuation span is copied with smart punctuation,
    When the edit tool locates the target,
    Then it replaces the original span without changing unrelated bytes`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-edit-tool-"));
    await writeFile(
      join(workspace, "copy.ts"),
      [
        "const before = true;",
        'const label = "don\'t wait...";',
        "const after = true;",
        "",
      ].join("\n"),
      "utf8",
    );

    try {
      // When
      const result = executeEdit(
        workspace,
        "copy.ts",
        singleEdit("const label = “don’t wait…”;", 'const label = "done";'),
      );

      // Then
      expect(result.content).toBe("Edited copy.ts");
      expect(await readFile(join(workspace, "copy.ts"), "utf8")).toBe(
        [
          "const before = true;",
          'const label = "done";',
          "const after = true;",
          "",
        ].join("\n"),
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an inline ASCII punctuation span is copied with smart punctuation,
    When the edit tool locates the target,
    Then it replaces only that inline span`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-edit-tool-"));
    await writeFile(
      join(workspace, "copy.ts"),
      ['const label = "don\'t wait...";', ""].join("\n"),
      "utf8",
    );

    try {
      // When
      const result = executeEdit(
        workspace,
        "copy.ts",
        singleEdit("don’t wait…", "go now"),
      );

      // Then
      expect(result.content).toBe("Edited copy.ts");
      expect(await readFile(join(workspace, "copy.ts"), "utf8")).toBe(
        ['const label = "go now";', ""].join("\n"),
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a smart punctuation span is copied with ASCII punctuation,
    When the edit tool locates the target,
    Then it replaces the original span`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-edit-tool-"));
    await writeFile(
      join(workspace, "copy.ts"),
      [
        "const before = true;",
        'const label = "range 1–5 — ready…";',
        "const after = true;",
        "",
      ].join("\n"),
      "utf8",
    );

    try {
      // When
      const result = executeEdit(
        workspace,
        "copy.ts",
        singleEdit(
          'const label = "range 1-5 - ready...";',
          'const label = "range 1-10 - done";',
        ),
      );

      // Then
      expect(result.content).toBe("Edited copy.ts");
      expect(await readFile(join(workspace, "copy.ts"), "utf8")).toBe(
        [
          "const before = true;",
          'const label = "range 1-10 - done";',
          "const after = true;",
          "",
        ].join("\n"),
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a smart punctuation span reaches the end of the file,
    When the edit tool locates the target with ASCII punctuation,
    Then it maps the replacement to the original terminal span`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-edit-tool-"));
    await writeFile(join(workspace, "copy.txt"), "range 1–5…", "utf8");

    try {
      // When
      const result = executeEdit(
        workspace,
        "copy.txt",
        singleEdit("range 1-5...", "done"),
      );

      // Then
      expect(result.content).toBe("Edited copy.txt");
      expect(await readFile(join(workspace, "copy.txt"), "utf8")).toBe("done");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given punctuation matching finds multiple candidate spans,
    When the edit tool validates the target,
    Then it rejects the edit as ambiguous and leaves the file unchanged`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-edit-tool-"));
    const original = [
      'const label = "range 1-5";',
      'const label = "range 1–5";',
      "",
    ].join("\n");
    await writeFile(join(workspace, "copy.ts"), original, "utf8");

    try {
      // When / Then
      expectEditError(
        () =>
          executeEdit(
            workspace,
            "copy.ts",
            singleEdit(
              'const label = "range 1—5";',
              'const label = "range 1-10";',
            ),
          ),
        "tool_old_string_not_unique",
        "old string appears 2 times",
      );
      expect(await readFile(join(workspace, "copy.ts"), "utf8")).toBe(original);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given punctuation normalization only matches inside an ellipsis,
    When the edit tool validates the target,
    Then it does not replace a partial punctuation expansion`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-edit-tool-"));
    const original = ['const label = "wait…";', ""].join("\n");
    await writeFile(join(workspace, "copy.ts"), original, "utf8");

    try {
      // When / Then
      expectEditError(
        () => executeEdit(workspace, "copy.ts", singleEdit(".", "!")),
        "tool_old_string_not_found",
        "old string not found",
      );
      expect(await readFile(join(workspace, "copy.ts"), "utf8")).toBe(original);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an ellipsis follows a literal period,
    When the edit tool skips a partial punctuation expansion,
    Then it can still match the adjacent complete ellipsis`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-edit-tool-"));
    await writeFile(join(workspace, "copy.txt"), "x.…", "utf8");

    try {
      // When
      const result = executeEdit(
        workspace,
        "copy.txt",
        singleEdit("...", "done"),
      );

      // Then
      expect(result.content).toBe("Edited copy.txt");
      expect(await readFile(join(workspace, "copy.txt"), "utf8")).toBe(
        "x.done",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given replaceAll is enabled for a punctuation-only mismatch,
    When the edit tool validates exact occurrences,
    Then it reports not found and leaves the file unchanged`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-edit-tool-"));
    const original = ['const label = "range 1–5";', ""].join("\n");
    await writeFile(join(workspace, "copy.ts"), original, "utf8");

    try {
      // When / Then
      expectEditError(
        () =>
          executeEdit(
            workspace,
            "copy.ts",
            singleEdit(
              'const label = "range 1-5";',
              'const label = "range 1-10";',
              true,
            ),
          ),
        "tool_old_string_not_found",
        "old string not found",
      );
      expect(await readFile(join(workspace, "copy.ts"), "utf8")).toBe(original);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an edit target differs only by common indentation,
    When the edit tool locates the target,
    Then it applies the requested replacement`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-edit-tool-"));
    await writeFile(
      join(workspace, "note.ts"),
      ["if (ready) {", "    callOld();", "    finish();", "}", ""].join("\n"),
      "utf8",
    );

    try {
      // When
      const result = executeEdit(
        workspace,
        "note.ts",
        singleEdit(
          ["  callOld();", "  finish();"].join("\n"),
          ["    callNew();", "    finish();"].join("\n"),
        ),
      );

      // Then
      expect(result.content).toBe("Edited note.ts");
      expect(await readFile(join(workspace, "note.ts"), "utf8")).toBe(
        ["if (ready) {", "    callNew();", "    finish();", "}", ""].join("\n"),
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an indented file has no trailing newline,
    When the edit target differs only by common indentation,
    Then the edit tool still replaces the final span`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-edit-tool-"));
    await writeFile(
      join(workspace, "note.ts"),
      ["  callOld();", "  finish();"].join("\n"),
      "utf8",
    );

    try {
      // When
      const result = executeEdit(
        workspace,
        "note.ts",
        singleEdit(
          ["callOld();", "finish();"].join("\n"),
          ["callNew();", "finish();"].join("\n"),
        ),
      );

      // Then
      expect(result.content).toBe("Edited note.ts");
      expect(await readFile(join(workspace, "note.ts"), "utf8")).toBe(
        ["callNew();", "finish();"].join("\n"),
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an edit target includes a trailing newline but the final file span does not,
    When fuzzy matching checks the final candidate span,
    Then it rejects the edit and leaves the file unchanged`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-edit-tool-"));
    const original = ["  callOld();", "  finish();"].join("\n");
    await writeFile(join(workspace, "note.ts"), original, "utf8");

    try {
      // When / Then
      expectEditError(
        () =>
          executeEdit(
            workspace,
            "note.ts",
            singleEdit(
              ["callOld();", "finish();", ""].join("\n"),
              ["callNew();", "finish();", ""].join("\n"),
            ),
          ),
        "tool_old_string_not_found",
        "old string not found",
      );
      expect(await readFile(join(workspace, "note.ts"), "utf8")).toBe(original);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a fuzzy edit target includes a trailing newline and the candidate span has one,
    When the edit tool applies the replacement,
    Then the matched span includes that trailing newline`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-edit-tool-"));
    await writeFile(
      join(workspace, "note.ts"),
      ["  callOld();", "  finish();", "next();", ""].join("\n"),
      "utf8",
    );

    try {
      // When
      const result = executeEdit(
        workspace,
        "note.ts",
        singleEdit(
          ["callOld();", "finish();", ""].join("\n"),
          ["callNew();", "finish();", ""].join("\n"),
        ),
      );

      // Then
      expect(result.content).toBe("Edited note.ts");
      expect(await readFile(join(workspace, "note.ts"), "utf8")).toBe(
        ["callNew();", "finish();", "next();", ""].join("\n"),
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an edit target differs by common indentation and contains a blank line,
    When the edit tool locates the target,
    Then it ignores the blank line when comparing indentation`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-edit-tool-"));
    await writeFile(
      join(workspace, "note.ts"),
      ["if (ready) {", "    callOld();", "", "    finish();", "}", ""].join(
        "\n",
      ),
      "utf8",
    );

    try {
      // When
      const result = executeEdit(
        workspace,
        "note.ts",
        singleEdit(
          ["  callOld();", "", "  finish();"].join("\n"),
          ["    callNew();", "", "    finish();"].join("\n"),
        ),
      );

      // Then
      expect(result.content).toBe("Edited note.ts");
      expect(await readFile(join(workspace, "note.ts"), "utf8")).toBe(
        ["if (ready) {", "    callNew();", "", "    finish();", "}", ""].join(
          "\n",
        ),
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given trailing-whitespace matching finds multiple candidate spans,
    When the edit tool validates the fuzzy target,
    Then it rejects the edit as ambiguous and leaves the file unchanged`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-edit-tool-"));
    const original = [
      "return old;  ",
      "next();",
      "---",
      "return old;  ",
      "next();",
      "",
    ].join("\n");
    await writeFile(join(workspace, "note.ts"), original, "utf8");

    try {
      // When / Then
      expectEditError(
        () =>
          executeEdit(
            workspace,
            "note.ts",
            singleEdit(
              ["return old;", "next();"].join("\n"),
              ["return new;", "next();"].join("\n"),
            ),
          ),
        "tool_old_string_not_unique",
        "old string appears 2 times",
      );
      expect(await readFile(join(workspace, "note.ts"), "utf8")).toBe(original);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the exact target appears multiple times,
    When the edit tool validates the request,
    Then it rejects the edit before considering fuzzy fallbacks`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-edit-tool-"));
    const original = [
      "return old;",
      "next();",
      "---",
      "return old;",
      "next();",
      "",
    ].join("\n");
    await writeFile(join(workspace, "note.ts"), original, "utf8");

    try {
      // When / Then
      expectEditError(
        () =>
          executeEdit(
            workspace,
            "note.ts",
            singleEdit(
              ["return old;", "next();"].join("\n"),
              ["return new;", "next();"].join("\n"),
            ),
          ),
        "tool_old_string_not_unique",
        "old string appears 2 times",
      );
      expect(await readFile(join(workspace, "note.ts"), "utf8")).toBe(original);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an edit request targets a directory,
    When the edit tool validates the target,
    Then it rejects the path as a recoverable tool error`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-edit-tool-"));
    await mkdir(join(workspace, "notes"));

    try {
      // When / Then
      expectEditError(
        () => executeEdit(workspace, "notes", singleEdit("old", "new")),
        "tool_not_file",
        "not a file",
        "directory, not a file",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an edit request targets a binary file,
    When the edit tool validates the target,
    Then it rejects the file without rewriting bytes`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-edit-tool-"));
    const filePath = join(workspace, "image.png");
    const original = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]);
    await writeFile(filePath, original);

    try {
      // When / Then
      expectEditError(
        () => executeEdit(workspace, "image.png", singleEdit("PNG", "text")),
        "tool_binary_file",
        "binary file",
        "cannot be edited as text",
      );
      expect(await readFile(filePath)).toEqual(original);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an edit request targets a text-named PDF,
    When the edit tool sniffs the target bytes,
    Then it rejects the file by magic bytes without rewriting bytes`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-edit-tool-"));
    const filePath = join(workspace, "document.txt");
    const original = Buffer.from("%PDF-1.7\nold text\n");
    await writeFile(filePath, original);

    try {
      // When / Then
      expectEditError(
        () => executeEdit(workspace, "document.txt", singleEdit("old", "new")),
        "tool_binary_file",
        "binary file",
        "cannot be edited as text",
      );
      expect(await readFile(filePath)).toEqual(original);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an edit request targets a text-named WebP file,
    When the edit tool sniffs the target bytes,
    Then it rejects the RIFF WebP file by magic bytes without rewriting bytes`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-edit-tool-"));
    const filePath = join(workspace, "image.txt");
    const original = Buffer.from([
      0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
    ]);
    await writeFile(filePath, original);

    try {
      // When / Then
      expectEditError(
        () => executeEdit(workspace, "image.txt", singleEdit("RIFF", "text")),
        "tool_binary_file",
        "binary file",
        "cannot be edited as text",
      );
      expect(await readFile(filePath)).toEqual(original);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an edit request targets invalid UTF-8,
    When the edit tool decodes the target,
    Then it rejects the file without rewriting bytes`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-edit-tool-"));
    const filePath = join(workspace, "invalid.txt");
    const original = Buffer.concat([
      Buffer.from("old text\n"),
      Buffer.from([0xff]),
    ]);
    await writeFile(filePath, original);

    try {
      // When / Then
      expectEditError(
        () => executeEdit(workspace, "invalid.txt", singleEdit("old", "new")),
        "tool_binary_file",
        "binary file",
        "cannot be edited as text",
      );
      expect(await readFile(filePath)).toEqual(original);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
