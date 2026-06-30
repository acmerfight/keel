import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { KeelErrorCode } from "../../src/core/error.ts";
import {
  createGitWorkspace,
  runGit as git,
} from "../../src/testing/cli-harness.ts";
import { executeApplyPatch } from "../../src/tools/apply-patch.ts";

async function createWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "keel-apply-patch-tool-"));
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
      ...(recovery !== undefined
        ? { recovery: expect.stringContaining(recovery) }
        : {}),
    });
  }
}

describe("Apply Patch Tool", () => {
  test(`Given a patch updates one read file and creates another file,
    When apply_patch validates and applies the patch,
    Then it writes every file and returns all mutated targets`, async () => {
    // Given
    const workspace = await createGitWorkspace("keel-apply-patch-");
    const workspacePath = await realpath(workspace);
    await writeFile(join(workspace, "src.ts"), "export const value = 1;\n");
    const patch = [
      "*** Begin Patch",
      "*** Update File: src.ts",
      "@@",
      "-export const value = 1;",
      "+export const value = 2;",
      "*** Add File: docs/note.md",
      "+# Note",
      "+",
      "+created by patch",
      "*** End Patch",
    ].join("\n");

    try {
      // When
      const result = executeApplyPatch(workspace, patch, {
        readBeforeEdit: {
          hasRead: (targetPath) => targetPath === join(workspacePath, "src.ts"),
        },
      });

      // Then
      expect(result.content).toBe("Applied patch:\nM src.ts\nA docs/note.md");
      expect(result.targetPaths).toEqual([
        join(workspacePath, "src.ts"),
        join(workspacePath, "docs", "note.md"),
      ]);
      expect(await readFile(join(workspace, "src.ts"), "utf8")).toBe(
        "export const value = 2;\n",
      );
      expect(await readFile(join(workspace, "docs", "note.md"), "utf8")).toBe(
        "# Note\n\ncreated by patch\n",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a patch hunk line only appears inside a longer line,
    When apply_patch validates the update hunk,
    Then it rejects the patch without mutating the file`, async () => {
    // Given
    const workspace = await createWorkspace();
    const workspacePath = await realpath(workspace);
    const targetPath = join(workspacePath, "a.ts");
    await writeFile(targetPath, "const fooBar = 1;\n", "utf8");
    const patch = [
      "*** Begin Patch",
      "*** Update File: a.ts",
      "@@",
      "-Bar = 1;",
      "+Baz = 2;",
      "*** End Patch",
    ].join("\n");

    try {
      // When / Then
      expectApplyPatchError(
        () =>
          executeApplyPatch(workspace, patch, {
            readBeforeEdit: {
              hasRead: (path) => path === targetPath,
            },
          }),
        "tool_patch_hunk_not_found",
        "expected lines not found in a.ts",
      );
      expect(await readFile(targetPath, "utf8")).toBe("const fooBar = 1;\n");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a patch hunk line appears inside a longer line and as its own line,
    When apply_patch validates the update hunk,
    Then it updates the whole-line match only`, async () => {
    // Given
    const workspace = await createWorkspace();
    const workspacePath = await realpath(workspace);
    const targetPath = join(workspacePath, "a.ts");
    await writeFile(targetPath, "const fooBar = 1;\nBar = 1;\n", "utf8");
    const patch = [
      "*** Begin Patch",
      "*** Update File: a.ts",
      "@@",
      "-Bar = 1;",
      "+Baz = 2;",
      "*** End Patch",
    ].join("\n");

    try {
      // When
      executeApplyPatch(workspace, patch, {
        readBeforeEdit: {
          hasRead: (path) => path === targetPath,
        },
      });

      // Then
      expect(await readFile(targetPath, "utf8")).toBe(
        "const fooBar = 1;\nBaz = 2;\n",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a patch hunk only names an empty removed line,
    When apply_patch validates the update hunk,
    Then it rejects the patch as having no effective old lines without mutating the file`, async () => {
    // Given
    const workspace = await createWorkspace();
    const workspacePath = await realpath(workspace);
    const targetPath = join(workspacePath, "note.txt");
    await writeFile(targetPath, "alpha\n\nbravo\n", "utf8");
    const patch = [
      "*** Begin Patch",
      "*** Update File: note.txt",
      "@@",
      "-",
      "*** End Patch",
    ].join("\n");

    try {
      // When / Then
      expectApplyPatchError(
        () =>
          executeApplyPatch(workspace, patch, {
            readBeforeEdit: {
              hasRead: (path) => path === targetPath,
            },
          }),
        "tool_invalid_patch",
        "has no effective old lines",
      );
      expect(await readFile(targetPath, "utf8")).toBe("alpha\n\nbravo\n");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a patch deletes one read text file,
    When apply_patch validates and applies the patch,
    Then it removes the file and records a delete checkpoint`, async () => {
    // Given
    const workspace = await createGitWorkspace("keel-apply-patch-delete-");
    const workspacePath = await realpath(workspace);
    const targetPath = join(workspacePath, "obsolete.txt");
    await writeFile(targetPath, "obsolete\n", "utf8");
    const patch = [
      "*** Begin Patch",
      "*** Delete File: obsolete.txt",
      "*** End Patch",
    ].join("\n");

    try {
      // When
      const result = executeApplyPatch(workspace, patch, {
        readBeforeEdit: {
          hasRead: (path) => path === targetPath,
        },
      });

      // Then
      expect(result.content).toBe("Applied patch:\nD obsolete.txt");
      expect(result.targetPaths).toEqual([targetPath]);
      expect(result.checkpointOperations).toEqual([
        {
          operation: "delete",
          filePath: targetPath,
          beforeContent: "obsolete\n",
          mode: expect.any(Number),
        },
      ]);
      await expect(readFile(targetPath, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a patch moves and updates one read text file,
    When apply_patch validates and applies the patch,
    Then it removes the old path, writes the new path, and records undo operations`, async () => {
    // Given
    const workspace = await createGitWorkspace("keel-apply-patch-move-");
    const workspacePath = await realpath(workspace);
    const sourcePath = join(workspacePath, "src", "old.ts");
    const targetPath = join(workspacePath, "src", "new.ts");
    await mkdir(join(workspacePath, "src"));
    await writeFile(sourcePath, "export const value = 1;\n", "utf8");
    if (process.platform !== "win32") {
      await chmod(sourcePath, 0o755);
    }
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/old.ts",
      "*** Move to: src/new.ts",
      "@@",
      "-export const value = 1;",
      "+export const value = 2;",
      "*** End Patch",
    ].join("\n");

    try {
      // When
      const result = executeApplyPatch(workspace, patch, {
        readBeforeEdit: {
          hasRead: (path) => path === sourcePath,
        },
      });

      // Then
      expect(result.content).toBe("Applied patch:\nR src/old.ts -> src/new.ts");
      expect(result.targetPaths).toEqual([sourcePath, targetPath]);
      await expect(readFile(sourcePath, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await readFile(targetPath, "utf8")).toBe(
        "export const value = 2;\n",
      );
      if (process.platform !== "win32") {
        expect((await stat(targetPath)).mode & 0o777).toBe(0o755);
      }
      expect(result.checkpointOperations).toEqual([
        {
          operation: "delete",
          filePath: sourcePath,
          beforeContent: "export const value = 1;\n",
          mode: expect.any(Number),
        },
        {
          operation: "create",
          filePath: targetPath,
          afterContent: "export const value = 2;\n",
        },
      ]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a patch moves a file to an existing destination,
    When apply_patch prevalidates the move,
    Then it rejects the patch without changing either file`, async () => {
    // Given
    const workspace = await createWorkspace();
    const workspacePath = await realpath(workspace);
    await writeFile(join(workspacePath, "old.txt"), "old\n", "utf8");
    await writeFile(join(workspacePath, "new.txt"), "existing\n", "utf8");
    const patch = [
      "*** Begin Patch",
      "*** Update File: old.txt",
      "*** Move to: new.txt",
      "@@",
      "-old",
      "+moved",
      "*** End Patch",
    ].join("\n");

    try {
      // When / Then
      expectApplyPatchError(
        () =>
          executeApplyPatch(workspace, patch, {
            readBeforeEdit: {
              hasRead: (path) => path === join(workspacePath, "old.txt"),
            },
          }),
        "tool_file_exists",
        "file already exists: new.txt",
      );
      expect(await readFile(join(workspacePath, "old.txt"), "utf8")).toBe(
        "old\n",
      );
      expect(await readFile(join(workspacePath, "new.txt"), "utf8")).toBe(
        "existing\n",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a patch updates a UTF-8 BOM file and adds content ending with a blank line,
    When apply_patch writes both targets,
    Then it preserves the BOM and does not append an extra newline`, async () => {
    // Given
    const workspace = await createWorkspace();
    const workspacePath = await realpath(workspace);
    await writeFile(join(workspace, "bom.txt"), "\uFEFFold\n", "utf8");
    const patch = [
      "*** Begin Patch",
      "*** Update File: bom.txt",
      "@@",
      "-old",
      "+new",
      "*** Add File: trailing.txt",
      "+line",
      "+",
      "*** End Patch",
    ].join("\n");

    try {
      // When
      executeApplyPatch(workspace, patch, {
        readBeforeEdit: {
          hasRead: (targetPath) =>
            targetPath === join(workspacePath, "bom.txt"),
        },
      });

      // Then
      expect(await readFile(join(workspace, "bom.txt"), "utf8")).toBe(
        "\uFEFFnew\n",
      );
      expect(await readFile(join(workspace, "trailing.txt"), "utf8")).toBe(
        "line\n",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a patch has one valid change followed by one invalid change,
    When apply_patch prevalidates the whole patch,
    Then it rejects the patch without writing any file`, async () => {
    // Given
    const workspace = await createWorkspace();
    const workspacePath = await realpath(workspace);
    await writeFile(join(workspace, "first.txt"), "alpha\n", "utf8");
    await writeFile(join(workspace, "second.txt"), "bravo\n", "utf8");
    const patch = [
      "*** Begin Patch",
      "*** Update File: first.txt",
      "@@",
      "-alpha",
      "+ALPHA",
      "*** Update File: second.txt",
      "@@",
      "-missing",
      "+MISSING",
      "*** Add File: created.txt",
      "+created",
      "*** End Patch",
    ].join("\n");

    try {
      // When / Then
      expectApplyPatchError(
        () =>
          executeApplyPatch(workspace, patch, {
            readBeforeEdit: {
              hasRead: (targetPath) =>
                targetPath === join(workspacePath, "first.txt") ||
                targetPath === join(workspacePath, "second.txt"),
            },
          }),
        "tool_patch_hunk_not_found",
        "expected lines not found in second.txt",
      );
      expect(await readFile(join(workspace, "first.txt"), "utf8")).toBe(
        "alpha\n",
      );
      expect(await readFile(join(workspace, "second.txt"), "utf8")).toBe(
        "bravo\n",
      );
      expect(await pathExists(join(workspace, "created.txt"))).toBe(false);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a patch updates a file with CRLF line endings,
    When apply_patch applies the hunk,
    Then it preserves the file's existing line ending style`, async () => {
    // Given
    const workspace = await createWorkspace();
    const workspacePath = await realpath(workspace);
    await writeFile(join(workspace, "win.txt"), "alpha\r\nbravo\r\n", "utf8");
    const patch = [
      "*** Begin Patch",
      "*** Update File: win.txt",
      "@@",
      "-alpha",
      "-bravo",
      "+alpha",
      "+charlie",
      "*** End Patch",
    ].join("\n");

    try {
      // When
      executeApplyPatch(workspace, patch, {
        readBeforeEdit: {
          hasRead: (targetPath) =>
            targetPath === join(workspacePath, "win.txt"),
        },
      });

      // Then
      expect(await readFile(join(workspace, "win.txt"), "utf8")).toBe(
        "alpha\r\ncharlie\r\n",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a patch replacement inserts lines without a newline inside the matched span,
    When apply_patch applies the hunk,
    Then it uses the nearest existing line ending or defaults to LF`, async () => {
    // Given
    const workspace = await createWorkspace();
    const workspacePath = await realpath(workspace);
    await writeFile(join(workspace, "after.txt"), "old\nsuffix", "utf8");
    await writeFile(join(workspace, "before.txt"), "prefix\r\nold", "utf8");
    await writeFile(join(workspace, "none.txt"), "old", "utf8");
    const patch = [
      "*** Begin Patch",
      "*** Update File: after.txt",
      "@@",
      "-old",
      "+new",
      "+line",
      "*** Update File: before.txt",
      "@@",
      "-old",
      "+new",
      "+line",
      "*** Update File: none.txt",
      "@@",
      "-old",
      "+new",
      "+line",
      "*** End Patch",
    ].join("\n");

    try {
      // When
      executeApplyPatch(workspace, patch, {
        readBeforeEdit: {
          hasRead: (targetPath) =>
            targetPath === join(workspacePath, "after.txt") ||
            targetPath === join(workspacePath, "before.txt") ||
            targetPath === join(workspacePath, "none.txt"),
        },
      });

      // Then
      expect(await readFile(join(workspace, "after.txt"), "utf8")).toBe(
        "new\nline\nsuffix",
      );
      expect(await readFile(join(workspace, "before.txt"), "utf8")).toBe(
        "prefix\r\nnew\r\nline",
      );
      expect(await readFile(join(workspace, "none.txt"), "utf8")).toBe(
        "new\nline",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a CRLF file needs an indentation-preserving fuzzy hunk,
    When apply_patch applies the replacement,
    Then it preserves source indentation and CRLF line endings`, async () => {
    // Given
    const workspace = await createWorkspace();
    const workspacePath = await realpath(workspace);
    await writeFile(
      join(workspace, "indented.txt"),
      "  alpha\r\n  omega\r\n",
      "utf8",
    );
    const patch = [
      "*** Begin Patch",
      "*** Update File: indented.txt",
      "@@",
      "-alpha",
      "-omega",
      "+alpha",
      "+omega",
      "+beta",
      "*** End Patch",
    ].join("\n");

    try {
      // When
      executeApplyPatch(workspace, patch, {
        readBeforeEdit: {
          hasRead: (targetPath) =>
            targetPath === join(workspacePath, "indented.txt"),
        },
      });

      // Then
      expect(await readFile(join(workspace, "indented.txt"), "utf8")).toBe(
        "  alpha\r\n  omega\r\n  beta\r\n",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a patch hunk omits the matched block indentation,
    When apply_patch uses indentation matching,
    Then it preserves source indentation for unchanged and changed lines`, async () => {
    // Given
    const workspace = await createWorkspace();
    const workspacePath = await realpath(workspace);
    await writeFile(
      join(workspace, "example.py"),
      ["class Example:", "    def run(self):", "        return 1", ""].join(
        "\n",
      ),
      "utf8",
    );
    const patch = [
      "*** Begin Patch",
      "*** Update File: example.py",
      "@@",
      "-def run(self):",
      "-    return 1",
      "+def run(self):",
      "+    return 2",
      "*** End Patch",
    ].join("\n");

    try {
      // When
      executeApplyPatch(workspace, patch, {
        readBeforeEdit: {
          hasRead: (targetPath) =>
            targetPath === join(workspacePath, "example.py"),
        },
      });

      // Then
      expect(await readFile(join(workspace, "example.py"), "utf8")).toBe(
        ["class Example:", "    def run(self):", "        return 2", ""].join(
          "\n",
        ),
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a patch hunk matches mixed leading whitespace,
    When apply_patch applies the replacement,
    Then it preserves each aligned source line indentation`, async () => {
    // Given
    const workspace = await createWorkspace();
    const workspacePath = await realpath(workspace);
    await writeFile(join(workspace, "note.txt"), "\talpha\n  beta\n", "utf8");
    const patch = [
      "*** Begin Patch",
      "*** Update File: note.txt",
      "@@",
      "-alpha",
      "- beta",
      "+alpha",
      "+ beta2",
      "*** End Patch",
    ].join("\n");

    try {
      // When
      executeApplyPatch(workspace, patch, {
        readBeforeEdit: {
          hasRead: (targetPath) =>
            targetPath === join(workspacePath, "note.txt"),
        },
      });

      // Then
      expect(await readFile(join(workspace, "note.txt"), "utf8")).toBe(
        "\talpha\n  beta2\n",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a patch hunk omits whitespace from an unchanged blank line,
    When apply_patch uses indentation matching,
    Then it preserves the source blank-line whitespace`, async () => {
    // Given
    const workspace = await createWorkspace();
    const workspacePath = await realpath(workspace);
    await writeFile(
      join(workspace, "note.ts"),
      ["if (ready) {", "    callOld();", "    ", "    finish();", "}", ""].join(
        "\n",
      ),
      "utf8",
    );
    const patch = [
      "*** Begin Patch",
      "*** Update File: note.ts",
      "@@",
      "-callOld();",
      "-",
      "-finish();",
      "+callNew();",
      "+",
      "+finish();",
      "*** End Patch",
    ].join("\n");

    try {
      // When
      executeApplyPatch(workspace, patch, {
        readBeforeEdit: {
          hasRead: (targetPath) =>
            targetPath === join(workspacePath, "note.ts"),
        },
      });

      // Then
      expect(await readFile(join(workspace, "note.ts"), "utf8")).toBe(
        [
          "if (ready) {",
          "    callNew();",
          "    ",
          "    finish();",
          "}",
          "",
        ].join("\n"),
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a patch hunk inserts a duplicate old line after trailing-whitespace matching,
    When apply_patch aligns the replacement,
    Then the duplicate does not steal source whitespace from unchanged lines`, async () => {
    // Given
    const workspace = await createWorkspace();
    const workspacePath = await realpath(workspace);
    await writeFile(
      join(workspace, "note.ts"),
      ["alpha  ", "bravo  ", "charlie  ", ""].join("\n"),
      "utf8",
    );
    const patch = [
      "*** Begin Patch",
      "*** Update File: note.ts",
      "@@",
      "-alpha",
      "-bravo",
      "-charlie",
      "+alpha",
      "+charlie",
      "+bravo",
      "+charlie",
      "*** End Patch",
    ].join("\n");

    try {
      // When
      executeApplyPatch(workspace, patch, {
        readBeforeEdit: {
          hasRead: (targetPath) =>
            targetPath === join(workspacePath, "note.ts"),
        },
      });

      // Then
      expect(await readFile(join(workspace, "note.ts"), "utf8")).toBe(
        ["alpha  ", "charlie", "bravo  ", "charlie  ", ""].join("\n"),
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a patch hunk changes text around unchanged smart punctuation,
    When apply_patch aligns multiple unchanged regions,
    Then it preserves source punctuation in the middle region`, async () => {
    // Given
    const workspace = await createWorkspace();
    const workspacePath = await realpath(workspace);
    await writeFile(join(workspace, "copy.txt"), "x “a” y “b” z\n", "utf8");
    const patch = [
      "*** Begin Patch",
      "*** Update File: copy.txt",
      "@@",
      '-x "a" y "b" z',
      '+X "a" y "b" Z',
      "*** End Patch",
    ].join("\n");

    try {
      // When
      executeApplyPatch(workspace, patch, {
        readBeforeEdit: {
          hasRead: (targetPath) =>
            targetPath === join(workspacePath, "copy.txt"),
        },
      });

      // Then
      expect(await readFile(join(workspace, "copy.txt"), "utf8")).toBe(
        "X “a” y “b” Z\n",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a patch hunk changes inside one normalized sequence and keeps other smart punctuation,
    When apply_patch falls back for only the changed sequence,
    Then it preserves the other source punctuation`, async () => {
    // Given
    const workspace = await createWorkspace();
    const workspacePath = await realpath(workspace);
    await writeFile(join(workspace, "copy.txt"), "“a” 1… “b”\n", "utf8");
    const patch = [
      "*** Begin Patch",
      "*** Update File: copy.txt",
      "@@",
      '-"a" 1... "b"',
      '+"a" 1.. "b"',
      "*** End Patch",
    ].join("\n");

    try {
      // When
      executeApplyPatch(workspace, patch, {
        readBeforeEdit: {
          hasRead: (targetPath) =>
            targetPath === join(workspacePath, "copy.txt"),
        },
      });

      // Then
      expect(await readFile(join(workspace, "copy.txt"), "utf8")).toBe(
        "“a” 1.. “b”\n",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a large indentation fuzzy hunk exceeds safe alignment bounds,
    When apply_patch prepares the replacement,
    Then it rejects the hunk without rewriting the file`, async () => {
    // Given
    const workspace = await createWorkspace();
    const workspacePath = await realpath(workspace);
    const lines = Array.from({ length: 1001 }, (_, index) => `line-${index}`);
    const replacementLines = lines.map((line, index) =>
      index === lines.length - 1 ? "changed" : line,
    );
    const sourceText = `${lines.map((line) => `  ${line}`).join("\n")}\n`;
    await writeFile(join(workspace, "copy.txt"), sourceText, "utf8");
    const patch = [
      "*** Begin Patch",
      "*** Update File: copy.txt",
      "@@",
      ...lines.map((line) => `-${line}`),
      ...replacementLines.map((line) => `+${line}`),
      "*** End Patch",
    ].join("\n");

    try {
      // When / Then
      expectApplyPatchError(
        () =>
          executeApplyPatch(workspace, patch, {
            readBeforeEdit: {
              hasRead: (targetPath) =>
                targetPath === join(workspacePath, "copy.txt"),
            },
          }),
        "tool_patch_hunk_not_found",
        "fuzzy hunk match cannot be applied safely",
        "copy the current text exactly",
      );
      expect(await readFile(join(workspace, "copy.txt"), "utf8")).toBe(
        sourceText,
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a patch uses hunk context lines,
    When apply_patch applies the hunk,
    Then context lines locate the update without changing those lines`, async () => {
    // Given
    const workspace = await createWorkspace();
    const workspacePath = await realpath(workspace);
    await writeFile(
      join(workspace, "note.txt"),
      "before\nold\nafter\n",
      "utf8",
    );
    const patch = [
      "*** Begin Patch",
      "*** Update File: note.txt",
      "@@",
      " before",
      "-old",
      "+new",
      " after",
      "*** End Patch",
    ].join("\n");

    try {
      // When
      executeApplyPatch(workspace, patch, {
        readBeforeEdit: {
          hasRead: (targetPath) =>
            targetPath === join(workspacePath, "note.txt"),
        },
      });

      // Then
      expect(await readFile(join(workspace, "note.txt"), "utf8")).toBe(
        "before\nnew\nafter\n",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a patch update target has not been read,
    When apply_patch validates the patch,
    Then it rejects the update before writing any file`, async () => {
    // Given
    const workspace = await createWorkspace();
    await writeFile(join(workspace, "note.txt"), "old\n", "utf8");
    const patch = [
      "*** Begin Patch",
      "*** Update File: note.txt",
      "@@",
      "-old",
      "+new",
      "*** End Patch",
    ].join("\n");

    try {
      // When / Then
      expectApplyPatchError(
        () =>
          executeApplyPatch(workspace, patch, {
            readBeforeEdit: {
              hasRead: () => false,
            },
          }),
        "tool_file_not_read",
        "file has not been read: note.txt",
        'Use read(path: "note.txt")',
      );
      expect(await readFile(join(workspace, "note.txt"), "utf8")).toBe("old\n");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a patch delete target has not been read,
    When apply_patch validates the patch,
    Then it rejects the delete before removing the file`, async () => {
    // Given
    const workspace = await createWorkspace();
    await writeFile(join(workspace, "obsolete.txt"), "obsolete\n", "utf8");
    const patch = [
      "*** Begin Patch",
      "*** Delete File: obsolete.txt",
      "*** End Patch",
    ].join("\n");

    try {
      // When / Then
      expectApplyPatchError(
        () =>
          executeApplyPatch(workspace, patch, {
            readBeforeEdit: {
              hasRead: () => false,
            },
          }),
        "tool_file_not_read",
        "file has not been read: obsolete.txt",
        'Use read(path: "obsolete.txt")',
      );
      expect(await readFile(join(workspace, "obsolete.txt"), "utf8")).toBe(
        "obsolete\n",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a patch update target is binary,
    When apply_patch reads the target as editable text,
    Then it reports an apply_patch binary-file failure`, async () => {
    // Given
    const workspace = await createWorkspace();
    const workspacePath = await realpath(workspace);
    await writeFile(join(workspace, "image.png"), Buffer.from([0x89, 0x50]));
    const patch = [
      "*** Begin Patch",
      "*** Update File: image.png",
      "@@",
      "-old",
      "+new",
      "*** End Patch",
    ].join("\n");

    try {
      // When / Then
      expectApplyPatchError(
        () =>
          executeApplyPatch(workspace, patch, {
            readBeforeEdit: {
              hasRead: (targetPath) =>
                targetPath === join(workspacePath, "image.png"),
            },
          }),
        "tool_binary_file",
        "apply_patch failed: binary file is not supported: image.png",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a patch delete target is binary,
    When apply_patch reads the target for an undo checkpoint,
    Then it rejects the delete without removing the file`, async () => {
    // Given
    const workspace = await createWorkspace();
    const workspacePath = await realpath(workspace);
    const targetPath = join(workspace, "image.png");
    await writeFile(targetPath, Buffer.from([0x89, 0x50]));
    const patch = [
      "*** Begin Patch",
      "*** Delete File: image.png",
      "*** End Patch",
    ].join("\n");

    try {
      // When / Then
      expectApplyPatchError(
        () =>
          executeApplyPatch(workspace, patch, {
            readBeforeEdit: {
              hasRead: (path) => path === join(workspacePath, "image.png"),
            },
          }),
        "tool_binary_file",
        "apply_patch failed: binary file is not supported: image.png",
      );
      expect(await pathExists(targetPath)).toBe(true);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a patch update target is too large,
    When apply_patch reads the target as editable text,
    Then it reports the apply_patch file size limit`, async () => {
    // Given
    const workspace = await createWorkspace();
    const workspacePath = await realpath(workspace);
    await writeFile(join(workspace, "large.txt"), "x".repeat(10_485_761));
    const patch = [
      "*** Begin Patch",
      "*** Update File: large.txt",
      "@@",
      "-x",
      "+y",
      "*** End Patch",
    ].join("\n");

    try {
      // When / Then
      expectApplyPatchError(
        () =>
          executeApplyPatch(workspace, patch, {
            readBeforeEdit: {
              hasRead: (targetPath) =>
                targetPath === join(workspacePath, "large.txt"),
            },
          }),
        "tool_file_too_large",
        "file is too large: large.txt",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a patch delete target is too large,
    When apply_patch reads the target for an undo checkpoint,
    Then it rejects the delete without removing the file`, async () => {
    // Given
    const workspace = await createWorkspace();
    const workspacePath = await realpath(workspace);
    const targetPath = join(workspace, "large.txt");
    await writeFile(targetPath, "x".repeat(10_485_761));
    const patch = [
      "*** Begin Patch",
      "*** Delete File: large.txt",
      "*** End Patch",
    ].join("\n");

    try {
      // When / Then
      expectApplyPatchError(
        () =>
          executeApplyPatch(workspace, patch, {
            readBeforeEdit: {
              hasRead: (path) => path === join(workspacePath, "large.txt"),
            },
          }),
        "tool_file_too_large",
        "file is too large: large.txt",
      );
      expect(await pathExists(targetPath)).toBe(true);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given malformed patch syntax,
    When apply_patch parses the patch,
    Then it reports a recoverable patch error for the invalid operation`, async () => {
    // Given
    const workspace = await createWorkspace();
    const cases = [
      {
        patch: "*** Begin Patch\n*** End Patch",
        code: "tool_invalid_patch",
        message: "patch contains no file operations",
      },
      {
        patch: "not a patch",
        code: "tool_invalid_patch",
        message: "patch must start with",
      },
      {
        patch: "*** Begin Patch\n*** Add File: \n+content\n*** End Patch",
        code: "tool_invalid_patch",
        message: "patch file header is missing a path",
      },
      {
        patch: "*** Begin Patch\n*** Add File: empty.txt\n*** End Patch",
        code: "tool_invalid_patch",
        message: "has no content lines",
      },
      {
        patch: "*** Begin Patch\n*** Delete File: \n*** End Patch",
        code: "tool_invalid_patch",
        message: "patch file header is missing a path",
      },
      {
        patch:
          "*** Begin Patch\n*** Add File: bad.txt\nmissing prefix\n*** End Patch",
        code: "tool_invalid_patch",
        message: "contains a line without + prefix",
      },
      {
        patch:
          "*** Begin Patch\n*** Update File: bad.txt\nmissing hunk\n*** End Patch",
        code: "tool_invalid_patch",
        message: "is missing a hunk header",
      },
      {
        patch:
          "*** Begin Patch\n*** Update File: bad.txt\n@@\nunchanged\n*** End Patch",
        code: "tool_invalid_patch",
        message: "has an invalid line",
      },
      {
        patch:
          "*** Begin Patch\n*** Update File: bad.txt\n@@\n+new\n*** End Patch",
        code: "tool_invalid_patch",
        message: "has no effective old lines",
      },
      {
        patch: "*** Begin Patch\n*** Update File: bad.txt\n*** End Patch",
        code: "tool_invalid_patch",
        message: "has no hunks",
      },
      {
        patch: "*** Begin Patch\n*** Unknown File: bad.txt\n*** End Patch",
        code: "tool_invalid_patch",
        message: "invalid patch header",
      },
    ] satisfies readonly {
      readonly patch: string;
      readonly code: KeelErrorCode;
      readonly message: string;
    }[];

    try {
      for (const invalid of cases) {
        // When / Then
        expectApplyPatchError(
          () => executeApplyPatch(workspace, invalid.patch),
          invalid.code,
          invalid.message,
        );
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a patch update target is a directory,
    When apply_patch validates the update target,
    Then it rejects the target as not a file`, async () => {
    // Given
    const workspace = await createWorkspace();
    const workspacePath = await realpath(workspace);
    await mkdir(join(workspace, "src"));
    const patch = [
      "*** Begin Patch",
      "*** Update File: src",
      "@@",
      "-old",
      "+new",
      "*** End Patch",
    ].join("\n");

    try {
      // When / Then
      expectApplyPatchError(
        () =>
          executeApplyPatch(workspace, patch, {
            readBeforeEdit: {
              hasRead: (targetPath) =>
                targetPath === join(workspacePath, "src"),
            },
          }),
        "tool_not_file",
        "not a file: src",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a patch delete target is a directory,
    When apply_patch validates the delete target,
    Then it rejects the target as not a file`, async () => {
    // Given
    const workspace = await createWorkspace();
    const workspacePath = await realpath(workspace);
    await mkdir(join(workspace, "src"));
    const patch = [
      "*** Begin Patch",
      "*** Delete File: src",
      "*** End Patch",
    ].join("\n");

    try {
      // When / Then
      expectApplyPatchError(
        () =>
          executeApplyPatch(workspace, patch, {
            readBeforeEdit: {
              hasRead: (targetPath) =>
                targetPath === join(workspacePath, "src"),
            },
          }),
        "tool_not_file",
        "not a file: src",
      );
      expect(await pathExists(join(workspace, "src"))).toBe(true);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a patch update target resolves through a symlink to an ignored file,
    When apply_patch validates the real target,
    Then it rejects the ignored update target`, async () => {
    // Given
    const workspace = await createWorkspace();
    const workspacePath = await realpath(workspace);
    await writeFile(join(workspace, ".gitignore"), "private/\n", "utf8");
    await mkdir(join(workspace, "private"));
    await writeFile(join(workspace, "private", "secret.txt"), "old\n", "utf8");
    await symlink("private/secret.txt", join(workspace, "visible.txt"));
    const patch = [
      "*** Begin Patch",
      "*** Update File: visible.txt",
      "@@",
      "-old",
      "+new",
      "*** End Patch",
    ].join("\n");

    try {
      // When / Then
      expectApplyPatchError(
        () =>
          executeApplyPatch(workspace, patch, {
            readBeforeEdit: {
              hasRead: (targetPath) =>
                targetPath === join(workspacePath, "private", "secret.txt"),
            },
          }),
        "tool_path_ignored",
        "ignored path: visible.txt",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a patch hunk matches more than one location,
    When apply_patch validates the update,
    Then it rejects the ambiguous patch without writing the file`, async () => {
    // Given
    const workspace = await createWorkspace();
    const workspacePath = await realpath(workspace);
    await writeFile(join(workspace, "repeat.txt"), "same\nsame\n", "utf8");
    const patch = [
      "*** Begin Patch",
      "*** Update File: repeat.txt",
      "@@",
      "-same",
      "+different",
      "*** End Patch",
    ].join("\n");

    try {
      // When / Then
      expectApplyPatchError(
        () =>
          executeApplyPatch(workspace, patch, {
            readBeforeEdit: {
              hasRead: (targetPath) =>
                targetPath === join(workspacePath, "repeat.txt"),
            },
          }),
        "tool_patch_hunk_not_found",
        "expected lines are not unique in repeat.txt",
      );
      expect(await readFile(join(workspace, "repeat.txt"), "utf8")).toBe(
        "same\nsame\n",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a patch targets the same file more than once,
    When apply_patch validates the prepared operations,
    Then it rejects the duplicate target before writing the file`, async () => {
    // Given
    const workspace = await createWorkspace();
    const workspacePath = await realpath(workspace);
    await writeFile(join(workspace, "note.txt"), "old\n", "utf8");
    const patch = [
      "*** Begin Patch",
      "*** Update File: note.txt",
      "@@",
      "-old",
      "+new",
      "*** Update File: note.txt",
      "@@",
      "-old",
      "+newer",
      "*** End Patch",
    ].join("\n");

    try {
      // When / Then
      expectApplyPatchError(
        () =>
          executeApplyPatch(workspace, patch, {
            readBeforeEdit: {
              hasRead: (targetPath) =>
                targetPath === join(workspacePath, "note.txt"),
            },
          }),
        "tool_invalid_patch",
        "multiple operations target note.txt",
      );
      expect(await readFile(join(workspace, "note.txt"), "utf8")).toBe("old\n");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a patch updates and deletes the same file,
    When apply_patch validates the prepared operations,
    Then it rejects the duplicate target before writing the file`, async () => {
    // Given
    const workspace = await createWorkspace();
    const workspacePath = await realpath(workspace);
    await writeFile(join(workspace, "note.txt"), "old\n", "utf8");
    const patch = [
      "*** Begin Patch",
      "*** Update File: note.txt",
      "@@",
      "-old",
      "+new",
      "*** Delete File: note.txt",
      "*** End Patch",
    ].join("\n");

    try {
      // When / Then
      expectApplyPatchError(
        () =>
          executeApplyPatch(workspace, patch, {
            readBeforeEdit: {
              hasRead: (targetPath) =>
                targetPath === join(workspacePath, "note.txt"),
            },
          }),
        "tool_invalid_patch",
        "multiple operations target note.txt",
      );
      expect(await readFile(join(workspace, "note.txt"), "utf8")).toBe("old\n");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform === "win32")(
    `Given a patch adds the same real file through a symlinked parent,
    When apply_patch validates the prepared operations,
    Then it rejects the duplicate real target before writing the file`,
    async () => {
      // Given
      const workspace = await createWorkspace();
      await mkdir(join(workspace, "packages", "api", "src"), {
        recursive: true,
      });
      await symlink(
        join(workspace, "packages", "api", "src"),
        join(workspace, "api-link"),
      );
      const patch = [
        "*** Begin Patch",
        "*** Add File: packages/api/src/new.ts",
        "+export const value = 1;",
        "*** Add File: api-link/new.ts",
        "+export const value = 2;",
        "*** End Patch",
      ].join("\n");

      try {
        // When / Then
        expectApplyPatchError(
          () => executeApplyPatch(workspace, patch),
          "tool_invalid_patch",
          "multiple operations target api-link/new.ts",
        );
        await expect(
          readFile(join(workspace, "packages", "api", "src", "new.ts"), "utf8"),
        ).rejects.toMatchObject({
          code: "ENOENT",
        });
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    },
  );

  test(`Given a patch add target already exists,
    When apply_patch validates the patch,
    Then it rejects the patch without clobbering the existing file`, async () => {
    // Given
    const workspace = await createWorkspace();
    await writeFile(join(workspace, "existing.txt"), "keep\n", "utf8");
    const patch = [
      "*** Begin Patch",
      "*** Add File: existing.txt",
      "+replace",
      "*** End Patch",
    ].join("\n");

    try {
      // When / Then
      expectApplyPatchError(
        () => executeApplyPatch(workspace, patch),
        "tool_file_exists",
        "file already exists: existing.txt",
      );
      expect(await readFile(join(workspace, "existing.txt"), "utf8")).toBe(
        "keep\n",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a patch add target resolves through a symlink to a gitignored directory after an earlier add,
    When apply_patch validates the real target,
    Then it rejects the ignored path and rolls back the earlier add`, async () => {
    // Given
    const workspace = await createWorkspace();
    await writeFile(join(workspace, ".gitignore"), "private/\n", "utf8");
    await mkdir(join(workspace, "private"));
    await symlink("private", join(workspace, "link"));
    const patch = [
      "*** Begin Patch",
      "*** Add File: created.txt",
      "+created",
      "*** Add File: link/secret.txt",
      "+secret",
      "*** End Patch",
    ].join("\n");

    try {
      // When / Then
      expectApplyPatchError(
        () => executeApplyPatch(workspace, patch),
        "tool_path_ignored",
        "ignored path: link/secret.txt",
      );
      await expect(
        readFile(join(workspace, "private", "secret.txt"), "utf8"),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(
        readFile(join(workspace, "created.txt"), "utf8"),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an existing undo checkpoint and a multi-file patch fails mid-batch,
    When apply_patch rolls back the applied operations,
    Then it restores touched files and preserves the previous checkpoint`, async () => {
    // Given
    const workspace = await createGitWorkspace("keel-apply-patch-rollback-");
    const workspacePath = await realpath(workspace);
    await writeFile(join(workspace, "checkpointed.txt"), "old\n", "utf8");
    await writeFile(join(workspace, "target.txt"), "alpha\n", "utf8");
    await writeFile(join(workspace, ".gitignore"), "private/\n", "utf8");
    await mkdir(join(workspace, "private"));
    await symlink("private", join(workspace, "link"));

    executeApplyPatch(
      workspace,
      [
        "*** Begin Patch",
        "*** Update File: checkpointed.txt",
        "@@",
        "-old",
        "+new",
        "*** End Patch",
      ].join("\n"),
      {
        readBeforeEdit: {
          hasRead: (targetPath) =>
            targetPath === join(workspacePath, "checkpointed.txt"),
        },
      },
    );
    const checkpoint = await checkpointPath(workspace);
    const previousCheckpoint = await readFile(checkpoint, "utf8");
    const patch = [
      "*** Begin Patch",
      "*** Add File: created.txt",
      "+created",
      "*** Update File: target.txt",
      "@@",
      "-alpha",
      "+beta",
      "*** Add File: link/secret.txt",
      "+secret",
      "*** End Patch",
    ].join("\n");

    try {
      // When / Then
      expectApplyPatchError(
        () =>
          executeApplyPatch(workspace, patch, {
            readBeforeEdit: {
              hasRead: (targetPath) =>
                targetPath === join(workspacePath, "target.txt"),
            },
          }),
        "tool_path_ignored",
        "ignored path: link/secret.txt",
      );
      await expect(
        readFile(join(workspace, "created.txt"), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(join(workspace, "target.txt"), "utf8")).toBe(
        "alpha\n",
      );
      await expect(
        readFile(join(workspace, "private", "secret.txt"), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(checkpoint, "utf8")).toBe(previousCheckpoint);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a patch add target resolves through a symlink to a gitignored directory after an earlier update,
    When apply_patch rejects the later add during execution,
    Then it rolls back the earlier update`, async () => {
    // Given
    const workspace = await createWorkspace();
    const workspacePath = await realpath(workspace);
    await writeFile(join(workspace, ".gitignore"), "private/\n", "utf8");
    await writeFile(join(workspace, "note.txt"), "old\n", "utf8");
    await mkdir(join(workspace, "private"));
    await symlink("private", join(workspace, "link"));
    const patch = [
      "*** Begin Patch",
      "*** Update File: note.txt",
      "@@",
      "-old",
      "+new",
      "*** Add File: link/secret.txt",
      "+secret",
      "*** End Patch",
    ].join("\n");

    try {
      // When / Then
      expectApplyPatchError(
        () =>
          executeApplyPatch(workspace, patch, {
            readBeforeEdit: {
              hasRead: (targetPath) =>
                targetPath === join(workspacePath, "note.txt"),
            },
          }),
        "tool_path_ignored",
        "ignored path: link/secret.txt",
      );
      expect(await readFile(join(workspace, "note.txt"), "utf8")).toBe("old\n");
      await expect(
        readFile(join(workspace, "private", "secret.txt"), "utf8"),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a patch add target resolves through a symlink to a gitignored directory after an earlier delete,
    When apply_patch rejects the later add during execution,
    Then it rolls back the earlier delete`, async () => {
    // Given
    const workspace = await createWorkspace();
    const workspacePath = await realpath(workspace);
    await writeFile(join(workspace, ".gitignore"), "private/\n", "utf8");
    await writeFile(join(workspace, "obsolete.txt"), "obsolete\n", "utf8");
    await mkdir(join(workspace, "private"));
    await symlink("private", join(workspace, "link"));
    const patch = [
      "*** Begin Patch",
      "*** Delete File: obsolete.txt",
      "*** Add File: link/secret.txt",
      "+secret",
      "*** End Patch",
    ].join("\n");

    try {
      // When / Then
      expectApplyPatchError(
        () =>
          executeApplyPatch(workspace, patch, {
            readBeforeEdit: {
              hasRead: (targetPath) =>
                targetPath === join(workspacePath, "obsolete.txt"),
            },
          }),
        "tool_path_ignored",
        "ignored path: link/secret.txt",
      );
      expect(await readFile(join(workspace, "obsolete.txt"), "utf8")).toBe(
        "obsolete\n",
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

  test(`Given a patch add target resolves through a symlink to a gitignored directory after an earlier move,
    When apply_patch rejects the later add during execution,
    Then it rolls back the earlier move`, async () => {
    // Given
    const workspace = await createWorkspace();
    const workspacePath = await realpath(workspace);
    await writeFile(join(workspace, ".gitignore"), "private/\n", "utf8");
    await writeFile(join(workspace, "old.txt"), "old\n", "utf8");
    await mkdir(join(workspace, "private"));
    await symlink("private", join(workspace, "link"));
    const patch = [
      "*** Begin Patch",
      "*** Update File: old.txt",
      "*** Move to: moved.txt",
      "*** Add File: link/secret.txt",
      "+secret",
      "*** End Patch",
    ].join("\n");

    try {
      // When / Then
      expectApplyPatchError(
        () =>
          executeApplyPatch(workspace, patch, {
            readBeforeEdit: {
              hasRead: (targetPath) =>
                targetPath === join(workspacePath, "old.txt"),
            },
          }),
        "tool_path_ignored",
        "ignored path: link/secret.txt",
      );
      expect(await readFile(join(workspace, "old.txt"), "utf8")).toBe("old\n");
      await expect(
        readFile(join(workspace, "moved.txt"), "utf8"),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(
        readFile(join(workspace, "private", "secret.txt"), "utf8"),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a patch add target resolves through a symlink outside the workspace after an earlier valid update,
    When apply_patch validates the real parent,
    Then it rejects the escape before writing any patch operation`, async () => {
    // Given
    const workspace = await createWorkspace();
    const workspacePath = await realpath(workspace);
    const outside = await createWorkspace();
    await writeFile(join(workspace, "note.txt"), "old\n", "utf8");
    await symlink(outside, join(workspace, "outside"));
    const patch = [
      "*** Begin Patch",
      "*** Update File: note.txt",
      "@@",
      "-old",
      "+new",
      "*** Add File: outside/secret.txt",
      "+secret",
      "*** End Patch",
    ].join("\n");

    try {
      // When / Then
      expectApplyPatchError(
        () =>
          executeApplyPatch(workspace, patch, {
            readBeforeEdit: {
              hasRead: (targetPath) =>
                targetPath === join(workspacePath, "note.txt"),
            },
          }),
        "tool_path_outside_workspace",
        "outside the workspace",
      );
      expect(await readFile(join(workspace, "note.txt"), "utf8")).toBe("old\n");
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
});
