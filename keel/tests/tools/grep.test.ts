import { EventEmitter } from "node:events";
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, test, vi } from "vitest";
import type { KeelErrorCode } from "../../src/core/error.ts";
import { executeGrep } from "../../src/tools/grep.ts";

async function expectGrepError(
  action: () => unknown | Promise<unknown>,
  code: KeelErrorCode,
  message: string,
): Promise<void> {
  try {
    await action();
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
      const result = await executeGrep(workspace, "handleSubmit");

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
      const result = await executeGrep(workspace, "needle", { path: "src" });

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
      const result = await executeGrep(workspace, "needle", {
        path: "src/app.ts",
      });

      // Then
      expect(result.content).toBe("src/app.ts:2:needle");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the search pattern contains regex metacharacters,
    When the grep tool searches the workspace,
    Then it treats the pattern as literal text`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-grep-"));
    await writeFile(join(workspace, "exact.txt"), "a.b\n", "utf8");
    await writeFile(join(workspace, "regex.txt"), "axb\n", "utf8");

    try {
      // When
      const result = await executeGrep(workspace, "a.b");

      // Then
      expect(result.content).toBe("exact.txt:1:a.b");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a matching line is longer than the snippet budget,
    When the grep tool searches the workspace,
    Then it truncates that snippet before returning it`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-grep-"));
    const longLine = `needle ${"x".repeat(260)}`;
    await writeFile(join(workspace, "app.ts"), `${longLine}\n`, "utf8");

    try {
      // When
      const result = await executeGrep(workspace, "needle");

      // Then
      expect(result.content).toBe(`app.ts:1:${longLine.slice(0, 240)}...`);
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
      const result = await executeGrep(workspace, "missing");

      // Then
      expect(result.content).toBe('No matches found for "missing"');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the requested search path does not exist,
    When the grep tool validates the requested path,
    Then it reports that the file was not found`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-grep-"));
    await writeFile(join(workspace, "app.ts"), "needle\n", "utf8");

    try {
      // When / Then
      await expectGrepError(
        () => executeGrep(workspace, "needle", { path: "missing.ts" }),
        "tool_file_not_found",
        "file not found",
      );
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
      const result = await executeGrep(workspace, "needle");

      // Then
      expect(result.content.split("\n").sort()).toEqual(
        ["src/other.ts:1:needle src", "app.ts:1:needle root"].sort(),
      );
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
      await expectGrepError(
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
      await expectGrepError(
        () => executeGrep(workspace, "secret", { path: "link.txt" }),
        "tool_path_outside_workspace",
        "outside the workspace",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test.sequential(`Given ripgrep is unavailable on PATH but bundled with Keel,
    When the grep tool starts a search,
    Then it still searches with the bundled ripgrep binary`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-grep-"));
    const pathEnvKey = "PATH";
    const originalPath = process.env[pathEnvKey];
    await writeFile(join(workspace, "app.ts"), "needle\n", "utf8");
    process.env[pathEnvKey] = workspace;

    try {
      // When
      const result = await executeGrep(workspace, "needle");

      // Then
      expect(result.content).toBe("app.ts:1:needle");
    } finally {
      if (originalPath === undefined) {
        delete process.env[pathEnvKey];
      } else {
        process.env[pathEnvKey] = originalPath;
      }
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test.sequential(`Given the bundled ripgrep binary cannot be spawned,
    When the grep tool starts a search,
    Then it reports that the grep tool is unavailable`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-grep-"));
    await writeFile(join(workspace, "app.ts"), "needle\n", "utf8");

    class MissingRipgrepProcess extends EventEmitter {
      readonly stdout = new PassThrough();
      readonly stderr = new PassThrough();

      kill(): boolean {
        return true;
      }
    }

    vi.resetModules();
    vi.doMock("node:child_process", () => ({
      spawn() {
        const child = new MissingRipgrepProcess();
        queueMicrotask(() => {
          child.emit(
            "error",
            Object.assign(new Error("missing"), {
              code: "ENOENT",
            }),
          );
        });
        return child;
      },
    }));

    try {
      const grepModule = await import("../../src/tools/grep.ts");

      // When / Then
      await expectGrepError(
        () => grepModule.executeGrep(workspace, "needle"),
        "tool_unavailable",
        "bundled ripgrep is not available",
      );
    } finally {
      vi.doUnmock("node:child_process");
      vi.resetModules();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given ignored generated directories contain matching text,
    When the grep tool searches the workspace,
    Then it skips those generated matches`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-grep-"));
    await mkdir(join(workspace, "src"), { recursive: true });
    await mkdir(join(workspace, "node_modules", "pkg"), { recursive: true });
    await mkdir(join(workspace, "src", "node_modules", "pkg"), {
      recursive: true,
    });
    await mkdir(join(workspace, "coverage"), { recursive: true });
    await writeFile(join(workspace, "src", "app.ts"), "needle\n", "utf8");
    await writeFile(
      join(workspace, "node_modules", "pkg", "index.js"),
      "needle\n",
      "utf8",
    );
    await writeFile(
      join(workspace, "src", "node_modules", "pkg", "index.js"),
      "needle\n",
      "utf8",
    );
    await writeFile(join(workspace, "coverage", "lcov.info"), "needle\n");

    try {
      // When
      const result = await executeGrep(workspace, "needle");

      // Then
      expect(result.content).toContain("src/app.ts:1:needle");
      expect(result.content).not.toContain("node_modules");
      expect(result.content).not.toContain("coverage");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an ignored generated directory is requested explicitly,
    When the grep tool validates the requested path,
    Then it rejects that ignored path before searching`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-grep-"));
    await mkdir(join(workspace, "node_modules", "pkg"), { recursive: true });
    await writeFile(
      join(workspace, "node_modules", "pkg", "index.js"),
      "needle\n",
      "utf8",
    );

    try {
      // When / Then
      await expectGrepError(
        () => executeGrep(workspace, "needle", { path: "node_modules" }),
        "tool_path_ignored",
        "ignored path",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a gitignore rule excludes a matching file,
    When the grep tool searches the workspace,
    Then it respects that ignore rule`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-grep-"));
    await writeFile(join(workspace, ".gitignore"), "secret.txt\n", "utf8");
    await writeFile(join(workspace, "app.ts"), "needle\n", "utf8");
    await writeFile(join(workspace, "secret.txt"), "needle\n", "utf8");

    try {
      // When
      const result = await executeGrep(workspace, "needle");

      // Then
      expect(result.content).toContain("app.ts:1:needle");
      expect(result.content).not.toContain("secret.txt");
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
      const result = await executeGrep(workspace, "needle");

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
      const result = await executeGrep(workspace, "needle");

      // Then
      const lines = result.content.split("\n");
      const matchLines = lines.filter((line) => !line.startsWith("["));
      expect(matchLines).toHaveLength(50);
      expect(matchLines.every((line) => line.endsWith(":needle"))).toBe(true);
      expect(result.content).toContain(
        "[grep output truncated: showing first 50 matches]",
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
      await expectGrepError(
        () => executeGrep(workspace, ""),
        "tool_empty_pattern",
        "pattern is empty",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a matching file cannot be read,
    When the grep tool searches that file,
    Then it reports an inaccessible-path warning instead of leaking a raw fs error`, async () => {
    if (process.platform === "win32") return;

    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-grep-"));
    const unreadablePath = join(workspace, "locked.txt");
    await writeFile(unreadablePath, "needle\n", "utf8");
    await chmod(unreadablePath, 0);

    try {
      // When
      const result = await executeGrep(workspace, "needle", {
        path: "locked.txt",
      });

      // Then
      expect(result.content).toContain('No matches found for "needle"');
      expect(result.content).toContain("inaccessible");
    } finally {
      await chmod(unreadablePath, 0o600);
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
