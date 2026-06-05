import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { KeelErrorCode } from "../../src/core/error.ts";
import { executeGrep } from "../../src/tools/grep.ts";

function expectGrepError(
  action: () => unknown,
  code: KeelErrorCode,
  message: string,
): void {
  try {
    action();
    throw new Error("Expected grep tool to throw");
  } catch (error) {
    expect(error).toMatchObject({
      name: "KeelError",
      code,
      message: expect.stringContaining(message),
    });
  }
}

describe("Grep Tool", () => {
  test(`Given workspace files contain a searched symbol,
    When the grep tool searches the workspace,
    Then it returns matching file paths, line numbers, and snippets`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-grep-"));
    await mkdir(join(workspace, "src"), { recursive: true });
    await writeFile(
      join(workspace, "src", "app.ts"),
      "export function handleSubmit() {}\n",
      "utf8",
    );
    await writeFile(
      join(workspace, "src", "login.ts"),
      "await handleSubmit();\n",
      "utf8",
    );

    try {
      // When
      const result = executeGrep(workspace, "handleSubmit");

      // Then
      expect(result.content).toContain(
        "src/app.ts:1:export function handleSubmit() {}",
      );
      expect(result.content).toContain("src/login.ts:1:await handleSubmit();");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a narrower search path is requested,
    When the grep tool searches the workspace,
    Then it only returns matches from that path`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-grep-"));
    await mkdir(join(workspace, "src"), { recursive: true });
    await mkdir(join(workspace, "docs"), { recursive: true });
    await writeFile(join(workspace, "src", "app.ts"), "needle\n", "utf8");
    await writeFile(join(workspace, "docs", "guide.md"), "needle\n", "utf8");

    try {
      // When
      const result = executeGrep(workspace, "needle", { path: "src" });

      // Then
      expect(result.content).toContain("src/app.ts:1:needle");
      expect(result.content).not.toContain("docs/guide.md");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a specific workspace file is requested,
    When the grep tool searches that file,
    Then it returns only matches from that file`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-grep-"));
    await mkdir(join(workspace, "src"), { recursive: true });
    await writeFile(join(workspace, "src", "app.ts"), "one\nneedle\n", "utf8");
    await writeFile(join(workspace, "other.ts"), "needle\n", "utf8");

    try {
      // When
      const result = executeGrep(workspace, "needle", {
        path: "src/app.ts",
      });

      // Then
      expect(result.content).toBe("src/app.ts:2:needle");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given no workspace files contain the searched text,
    When the grep tool searches the workspace,
    Then it reports that no matches were found`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-grep-"));
    await writeFile(join(workspace, "app.ts"), "content\n", "utf8");

    try {
      // When
      const result = executeGrep(workspace, "missing");

      // Then
      expect(result.content).toBe('No matches found for "missing"');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given recursive search sees duplicate and escaped symlinks,
    When the grep tool searches the workspace,
    Then it searches each real workspace target once and skips escaped symlinks`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-grep-"));
    const outside = await mkdtemp(join(tmpdir(), "keel-grep-outside-"));
    await mkdir(join(workspace, "src"), { recursive: true });
    await writeFile(join(workspace, "app.ts"), "needle root\n", "utf8");
    await writeFile(join(workspace, "src", "other.ts"), "needle src\n", "utf8");
    await writeFile(join(outside, "secret.txt"), "needle secret\n", "utf8");
    await symlink(join(workspace, "app.ts"), join(workspace, "link-app.ts"));
    await symlink(join(workspace, "src"), join(workspace, "alias-src"));
    await symlink(
      join(workspace, "missing.txt"),
      join(workspace, "broken.txt"),
    );
    await symlink(
      join(outside, "secret.txt"),
      join(workspace, "secret-link.txt"),
    );

    try {
      // When
      const result = executeGrep(workspace, "needle");

      // Then
      expect(result.content.split("\n")).toEqual([
        "src/other.ts:1:needle src",
        "app.ts:1:needle root",
      ]);
      expect(result.content).not.toContain("secret");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test(`Given a grep request uses an absolute path outside the workspace,
    When the grep tool resolves the target,
    Then it rejects the path before searching`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-grep-"));
    const outside = await mkdtemp(join(tmpdir(), "keel-grep-outside-"));
    const outsidePath = join(outside, "secret.txt");
    await writeFile(outsidePath, "secret\n", "utf8");

    try {
      // When / Then
      expectGrepError(
        () => executeGrep(workspace, "secret", { path: outsidePath }),
        "tool_path_outside_workspace",
        "outside the workspace",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test(`Given a symlink inside the workspace points outside,
    When the grep tool resolves the requested symlink,
    Then it rejects the escaped path before searching`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-grep-"));
    const outside = await mkdtemp(join(tmpdir(), "keel-grep-outside-"));
    const outsidePath = join(outside, "secret.txt");
    await writeFile(outsidePath, "secret\n", "utf8");
    await symlink(outsidePath, join(workspace, "link.txt"));

    try {
      // When / Then
      expectGrepError(
        () => executeGrep(workspace, "secret", { path: "link.txt" }),
        "tool_path_outside_workspace",
        "outside the workspace",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test(`Given ignored generated directories contain matching text,
    When the grep tool searches the workspace,
    Then it skips those generated matches`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-grep-"));
    await mkdir(join(workspace, "src"), { recursive: true });
    await mkdir(join(workspace, "node_modules", "pkg"), { recursive: true });
    await mkdir(join(workspace, "coverage"), { recursive: true });
    await writeFile(join(workspace, "src", "app.ts"), "needle\n", "utf8");
    await writeFile(
      join(workspace, "node_modules", "pkg", "index.js"),
      "needle\n",
      "utf8",
    );
    await writeFile(join(workspace, "coverage", "lcov.info"), "needle\n");

    try {
      // When
      const result = executeGrep(workspace, "needle");

      // Then
      expect(result.content).toContain("src/app.ts:1:needle");
      expect(result.content).not.toContain("node_modules");
      expect(result.content).not.toContain("coverage");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given binary files contain matching bytes,
    When the grep tool searches the workspace,
    Then it skips binary file contents`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-grep-"));
    await writeFile(join(workspace, "app.ts"), "needle\n", "utf8");
    await writeFile(
      join(workspace, "blob.txt"),
      Buffer.from([110, 101, 101, 100, 108, 101, 0]),
    );

    try {
      // When
      const result = executeGrep(workspace, "needle");

      // Then
      expect(result.content).toContain("app.ts:1:needle");
      expect(result.content).not.toContain("blob.txt");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given more files match than the output budget allows,
    When the grep tool searches the workspace,
    Then it caps the output and reports the omitted matches`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-grep-"));
    for (let i = 0; i < 60; i++) {
      await writeFile(
        join(workspace, `${String(i).padStart(2, "0")}.txt`),
        "needle\n",
        "utf8",
      );
    }

    try {
      // When
      const result = executeGrep(workspace, "needle");

      // Then
      expect(result.content).toContain("00.txt:1:needle");
      expect(result.content).toContain("49.txt:1:needle");
      expect(result.content).not.toContain("50.txt:1:needle");
      expect(result.content).toContain(
        "[grep output truncated: showing 50 of 60 matches]",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an empty search pattern,
    When the grep tool validates the request,
    Then it rejects the request before searching`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-grep-"));
    await writeFile(join(workspace, "app.ts"), "content\n", "utf8");

    try {
      // When / Then
      expectGrepError(
        () => executeGrep(workspace, ""),
        "tool_empty_pattern",
        "pattern is empty",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
