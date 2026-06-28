import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { KeelErrorCode } from "../../src/core/error.ts";
import { executeGlob } from "../../src/tools/glob.ts";

async function expectGlobError(
  action: () => unknown | Promise<unknown>,
  code: KeelErrorCode,
  message: string,
  recovery?: string,
): Promise<void> {
  try {
    await action();
    throw new Error("Expected glob tool to throw");
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

describe("Glob Tool File Discovery", () => {
  test(`Given workspace files match a file-name pattern,
    When the glob tool searches the workspace,
    Then it returns matching workspace-relative file paths in sorted order`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-glob-"));
    await mkdir(join(workspace, "src"), { recursive: true });
    await mkdir(join(workspace, "tests"), { recursive: true });
    await writeFile(join(workspace, "src", "app.ts"), "app\n", "utf8");
    await writeFile(
      join(workspace, "src", "app.test.ts"),
      "app test\n",
      "utf8",
    );
    await writeFile(
      join(workspace, "tests", "helper.test.ts"),
      "helper test\n",
      "utf8",
    );

    try {
      // When
      const result = await executeGlob(workspace, "**/*.test.ts");

      // Then
      expect(result.content).toBe(
        ["src/app.test.ts", "tests/helper.test.ts"].join("\n"),
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a narrower search directory is requested,
    When the glob tool searches that path,
    Then it only returns matches from that directory`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-glob-"));
    await mkdir(join(workspace, "src"), { recursive: true });
    await mkdir(join(workspace, "docs"), { recursive: true });
    await writeFile(join(workspace, "src", "api.test.ts"), "api\n", "utf8");
    await writeFile(join(workspace, "docs", "api.test.ts"), "docs\n", "utf8");

    try {
      // When
      const result = await executeGlob(workspace, "**/*.test.ts", {
        path: "src",
      });

      // Then
      expect(result.content).toBe("src/api.test.ts");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given project gitignore excludes matching files,
    When the glob tool searches the workspace,
    Then ignored paths are omitted from the result`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-glob-"));
    await mkdir(join(workspace, "src"), { recursive: true });
    await mkdir(join(workspace, "dist"), { recursive: true });
    await writeFile(join(workspace, ".gitignore"), "dist/\n", "utf8");
    await writeFile(join(workspace, "src", "visible.test.ts"), "ok\n", "utf8");
    await writeFile(
      join(workspace, "dist", "generated.test.ts"),
      "ignored\n",
      "utf8",
    );

    try {
      // When
      const result = await executeGlob(workspace, "**/*.test.ts");

      // Then
      expect(result.content).toBe("src/visible.test.ts");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given many files match the pattern,
    When the glob tool searches the workspace,
    Then it caps the output and tells the model to narrow the pattern`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-glob-"));
    await mkdir(join(workspace, "cases"), { recursive: true });
    for (let index = 0; index < 51; index++) {
      await writeFile(
        join(workspace, "cases", `case-${String(index).padStart(2, "0")}.ts`),
        "case\n",
        "utf8",
      );
    }

    try {
      // When
      const result = await executeGlob(workspace, "**/*.ts");

      // Then
      const lines = result.content.split("\n");
      expect(lines).toHaveLength(51);
      expect(lines[0]).toBe("cases/case-00.ts");
      expect(lines[49]).toBe("cases/case-49.ts");
      expect(lines[50]).toBe(
        "[glob output truncated: showing first 50 files. Narrow the pattern or path to see more.]",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test.each([49, 50])(`Given %i files match the pattern,
    When the glob tool searches the workspace,
    Then it returns every file without claiming the output was truncated`, async (fileCount) => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-glob-"));
    await mkdir(join(workspace, "cases"), { recursive: true });
    for (let index = 0; index < fileCount; index++) {
      await writeFile(
        join(workspace, "cases", `case-${String(index).padStart(2, "0")}.ts`),
        "case\n",
        "utf8",
      );
    }

    try {
      // When
      const result = await executeGlob(workspace, "**/*.ts");

      // Then
      const lines = result.content.split("\n");
      expect(lines).toHaveLength(fileCount);
      expect(lines[0]).toBe("cases/case-00.ts");
      expect(lines[fileCount - 1]).toBe(
        `cases/case-${String(fileCount - 1).padStart(2, "0")}.ts`,
      );
      expect(result.content).not.toContain("[glob output truncated");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given no files match the pattern,
    When the glob tool searches the workspace,
    Then it reports that no files were found`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-glob-"));
    await writeFile(join(workspace, "README.md"), "hello\n", "utf8");

    try {
      // When
      const result = await executeGlob(workspace, "**/*.test.ts");

      // Then
      expect(result.content).toBe('No files found for pattern "**/*.test.ts"');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the file pattern is empty,
    When the glob tool validates the request,
    Then it returns a recoverable pattern error`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-glob-"));

    try {
      // When / Then
      await expectGlobError(
        () => executeGlob(workspace, ""),
        "tool_empty_pattern",
        "pattern is empty",
        "non-empty glob pattern",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the file pattern spans multiple lines,
    When the glob tool validates the request,
    Then it asks for a single-line pattern`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-glob-"));

    try {
      // When / Then
      await expectGlobError(
        () => executeGlob(workspace, "**/*.ts\n**/*.tsx"),
        "tool_invalid_pattern",
        "pattern spans multiple lines",
        "single-line glob pattern",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the file pattern has invalid glob syntax,
    When ripgrep rejects the pattern,
    Then the glob tool returns a recoverable pattern error`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-glob-"));
    await writeFile(join(workspace, "note.ts"), "hello\n", "utf8");

    try {
      // When / Then
      await expectGlobError(
        () => executeGlob(workspace, "["),
        "tool_invalid_pattern",
        "invalid pattern",
        "valid single-line glob pattern",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform === "win32")(
    `Given a workspace directory cannot be traversed,
    When ripgrep reports a filesystem failure during glob discovery,
    Then the glob tool surfaces the search failure instead of reporting no files`,
    async () => {
      // Given
      const workspace = await mkdtemp(join(tmpdir(), "keel-glob-"));
      const lockedPath = join(workspace, "locked");
      await mkdir(lockedPath);
      await chmod(lockedPath, 0);

      try {
        // When / Then
        await expectGlobError(
          () => executeGlob(workspace, "**/*.ts"),
          "tool_unavailable",
          "ripgrep exited with code 2",
        );
      } finally {
        await chmod(lockedPath, 0o700);
        await rm(workspace, { recursive: true, force: true });
      }
    },
  );

  test(`Given the search path points outside the workspace,
    When the glob tool validates the request,
    Then it rejects the path before listing files`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-glob-"));
    const outside = await mkdtemp(join(tmpdir(), "keel-glob-outside-"));

    try {
      // When / Then
      await expectGlobError(
        () => executeGlob(workspace, "**/*.ts", { path: outside }),
        "tool_path_outside_workspace",
        "outside the workspace",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test(`Given the requested search directory is excluded by built-in policy,
    When the glob tool validates the path,
    Then it rejects that ignored path`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-glob-"));
    await mkdir(join(workspace, "node_modules"), { recursive: true });
    await writeFile(
      join(workspace, "node_modules", "package.test.ts"),
      "ignored\n",
      "utf8",
    );

    try {
      // When / Then
      await expectGlobError(
        () => executeGlob(workspace, "**/*.ts", { path: "node_modules" }),
        "tool_path_ignored",
        "ignored path",
        "project policy",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the requested search directory is excluded by gitignore,
    When the glob tool validates the path,
    Then it rejects that ignored directory`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-glob-"));
    await mkdir(join(workspace, "generated"), { recursive: true });
    await writeFile(join(workspace, ".gitignore"), "generated/\n", "utf8");
    await writeFile(
      join(workspace, "generated", "api.test.ts"),
      "ignored\n",
      "utf8",
    );

    try {
      // When / Then
      await expectGlobError(
        () => executeGlob(workspace, "**/*.ts", { path: "generated" }),
        "tool_path_ignored",
        "ignored path",
        "excluded by project",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the requested search path is a file,
    When the glob tool validates the path,
    Then it asks the model to search a directory instead`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-glob-"));
    await writeFile(join(workspace, "note.ts"), "hello\n", "utf8");

    try {
      // When / Then
      await expectGlobError(
        () => executeGlob(workspace, "**/*.ts", { path: "note.ts" }),
        "tool_not_directory",
        "not a directory",
        "Use a workspace directory",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
