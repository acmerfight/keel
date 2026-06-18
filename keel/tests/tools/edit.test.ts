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
        () => executeEdit(workspace, "ignored-link.txt", "old", "new"),
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
        () => executeEdit(workspace, "visible-link.txt", "old", "new"),
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
        'const value = "old";\n',
        'const value = "new";\n',
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
        "const value = old;\n",
        "const value = new;\n",
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
        "title: old\n",
        "title: new\n",
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
      const result = executeEdit(workspace, "note.txt", "old", "new", {
        replaceAll: true,
      });

      // Then
      expect(result.content).toBe("Edited note.txt");
      expect(await readFile(join(workspace, "note.txt"), "utf8")).toBe(
        "new one\nnew two\n",
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
        () => executeEdit(workspace, "note.txt", "old", "new"),
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
          executeEdit(workspace, "note.txt", "missing", "new", {
            replaceAll: true,
          }),
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

  test(`Given the replacement is identical to the target text,
    When the edit tool validates the request,
    Then it rejects the no-op and leaves the file unchanged`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-edit-tool-"));
    await writeFile(join(workspace, "note.txt"), "keep me\n", "utf8");

    try {
      // When / Then
      expectEditError(
        () => executeEdit(workspace, "note.txt", "keep", "keep"),
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
        ["function oldValue() {", "  return value;", "}"].join("\n"),
        ["function newValue() {", "  return next;", "}"].join("\n"),
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
        ["  callOld();", "  finish();"].join("\n"),
        ["    callNew();", "    finish();"].join("\n"),
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
        ["callOld();", "finish();"].join("\n"),
        ["callNew();", "finish();"].join("\n"),
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
            ["callOld();", "finish();", ""].join("\n"),
            ["callNew();", "finish();", ""].join("\n"),
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
        ["callOld();", "finish();", ""].join("\n"),
        ["callNew();", "finish();", ""].join("\n"),
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
        ["  callOld();", "", "  finish();"].join("\n"),
        ["    callNew();", "", "    finish();"].join("\n"),
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
            ["return old;", "next();"].join("\n"),
            ["return new;", "next();"].join("\n"),
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
            ["return old;", "next();"].join("\n"),
            ["return new;", "next();"].join("\n"),
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
        () => executeEdit(workspace, "notes", "old", "new"),
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
        () => executeEdit(workspace, "image.png", "PNG", "text"),
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
        () => executeEdit(workspace, "document.txt", "old", "new"),
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
        () => executeEdit(workspace, "image.txt", "RIFF", "text"),
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
        () => executeEdit(workspace, "invalid.txt", "old", "new"),
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
