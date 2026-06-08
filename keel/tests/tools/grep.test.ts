import { execFile } from "node:child_process";
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
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import type { KeelErrorCode } from "../../src/core/error.ts";
import { executeGrep } from "../../src/tools/grep.ts";

const execFileAsync = promisify(execFile);

async function initGitRepo(workspace: string): Promise<void> {
  await execFileAsync("git", ["init"], { cwd: workspace });
}

async function withEnv<T>(
  values: Record<string, string | undefined>,
  action: () => Promise<T>,
): Promise<T> {
  const originalValues = new Map<string, string | undefined>();

  for (const [key, value] of Object.entries(values)) {
    originalValues.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    return await action();
  } finally {
    for (const [key, value] of originalValues) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

async function withPath<T>(
  pathValue: string,
  action: () => Promise<T>,
): Promise<T> {
  return await withEnv({ PATH: pathValue }, action);
}

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

describe("Grep Tool Search Semantics", () => {
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

  test(`Given the workspace root is requested explicitly,
    When the grep tool searches that root path,
    Then it treats the request as a normal workspace search`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-grep-"));
    await writeFile(join(workspace, "app.ts"), "needle\n", "utf8");

    try {
      // When
      const result = await executeGrep(workspace, "needle", { path: "." });

      // Then
      expect(result.content).toBe("app.ts:1:needle");
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

  test.skipIf(process.platform === "win32")(
    `Given another workspace directory cannot be traversed,
    When the grep tool searches an explicit file path,
    Then ignore validation does not scan unrelated workspace paths`,
    async () => {
      // Given
      const workspace = await mkdtemp(join(tmpdir(), "keel-grep-"));
      const lockedPath = join(workspace, "locked");
      await initGitRepo(workspace);
      await mkdir(lockedPath);
      await writeFile(join(workspace, "app.ts"), "needle\n", "utf8");
      await chmod(lockedPath, 0);

      try {
        // When
        const result = await executeGrep(workspace, "needle", {
          path: "app.ts",
        });

        // Then
        expect(result.content).toBe("app.ts:1:needle");
      } finally {
        await chmod(lockedPath, 0o700);
        await rm(workspace, { recursive: true, force: true });
      }
    },
  );

  test(`Given an empty directory is requested explicitly,
    When the grep tool searches that directory,
    Then it reports no matches instead of treating the directory as ignored`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-grep-"));
    await mkdir(join(workspace, "empty"), { recursive: true });

    try {
      // When
      const result = await executeGrep(workspace, "needle", {
        path: "empty",
      });

      // Then
      expect(result.content).toBe('No matches found for "needle"');
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
});

describe("Grep Tool Path Validation", () => {
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

  test.skipIf(process.platform === "win32")(
    `Given the requested search path is not a regular file or directory,
    When the grep tool validates the requested path,
    Then it rejects that special path before searching`,
    async () => {
      // Given
      const workspace = await mkdtemp(join(tmpdir(), "keel-grep-"));
      await execFileAsync("mkfifo", [join(workspace, "pipe")]);

      try {
        // When / Then
        await expectGrepError(
          () => executeGrep(workspace, "needle", { path: "pipe" }),
          "tool_not_file",
          "not a file or directory",
        );
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    },
  );

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

  test(`Given a grep request uses a missing absolute path outside the workspace,
    When the grep tool validates the path,
    Then it rejects the workspace escape without revealing path existence`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-grep-"));
    const outside = await mkdtemp(join(tmpdir(), "keel-grep-outside-"));
    const outsidePath = join(outside, "missing.txt");

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

  test(`Given a project gitignore excludes a symlink to a visible file,
    When the grep tool is called through that ignored symlink,
    Then it rejects the request path before searching target content`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-grep-"));
    await writeFile(
      join(workspace, ".gitignore"),
      "ignored-link.txt\n",
      "utf8",
    );
    await writeFile(join(workspace, "visible.txt"), "needle\n", "utf8");
    await symlink("visible.txt", join(workspace, "ignored-link.txt"));

    try {
      // When / Then
      await expectGrepError(
        () => executeGrep(workspace, "needle", { path: "ignored-link.txt" }),
        "tool_path_ignored",
        "ignored path",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a project gitignore excludes a visible symlink target,
    When the grep tool is called through the symlink,
    Then it rejects the resolved target before searching content`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-grep-"));
    await writeFile(join(workspace, ".gitignore"), "secret.txt\n", "utf8");
    await writeFile(join(workspace, "secret.txt"), "needle\n", "utf8");
    await symlink("secret.txt", join(workspace, "visible-link.txt"));

    try {
      // When / Then
      await expectGrepError(
        () => executeGrep(workspace, "needle", { path: "visible-link.txt" }),
        "tool_path_ignored",
        "ignored path",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});

describe("Grep Tool Process Lifecycle", () => {
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

  test(`Given ripgrep does not finish before the grep timeout,
    When the grep tool starts a search,
    Then it reports a timeout`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-grep-"));
    const largeText = Buffer.alloc(32 * 1024 * 1024, 120);
    await writeFile(join(workspace, "large.txt"), largeText);

    try {
      // When / Then
      await expectGrepError(
        () =>
          executeGrep(workspace, "needle", {
            path: "large.txt",
            timeoutMs: 1,
          }),
        "tool_unavailable",
        "timed out",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the caller aborts a grep request before it runs,
    When the grep tool starts the search,
    Then it rejects the search as aborted`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-grep-"));
    await writeFile(join(workspace, "app.ts"), "needle\n", "utf8");
    const abortController = new AbortController();
    abortController.abort();

    try {
      // When / Then
      await expect(
        executeGrep(workspace, "needle", {
          signal: abortController.signal,
        }),
      ).rejects.toMatchObject({
        name: "AbortError",
        code: "ABORT_ERR",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});

describe("Grep Tool Ignore Policy", () => {
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

  test(`Given a gitignore rule excludes an explicitly requested file,
    When the grep tool validates the requested path,
    Then it rejects that ignored file before searching`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-grep-"));
    await initGitRepo(workspace);
    await writeFile(join(workspace, ".gitignore"), "secret.txt\n", "utf8");
    await writeFile(join(workspace, "secret.txt"), "needle\n", "utf8");

    try {
      // When / Then
      await expectGrepError(
        () => executeGrep(workspace, "needle", { path: "secret.txt" }),
        "tool_path_ignored",
        "ignored path",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a gitignore rule excludes an explicitly requested missing file,
    When the grep tool validates the requested path,
    Then it rejects that ignored path without revealing path existence`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-grep-"));
    await writeFile(join(workspace, ".gitignore"), "secret.txt\n", "utf8");

    try {
      // When / Then
      await expectGrepError(
        () => executeGrep(workspace, "needle", { path: "secret.txt" }),
        "tool_path_ignored",
        "ignored path",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a non-git workspace gitignore rule excludes an explicitly requested file,
    When the grep tool validates the requested path,
    Then it rejects that ignored file before searching`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-grep-"));
    await writeFile(join(workspace, ".gitignore"), "secret.txt\n", "utf8");
    await writeFile(join(workspace, "secret.txt"), "needle\n", "utf8");

    try {
      // When / Then
      await expectGrepError(
        () => executeGrep(workspace, "needle", { path: "secret.txt" }),
        "tool_path_ignored",
        "ignored path",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a gitignore rule excludes a missing directory namespace,
    When the grep tool validates a missing file inside that namespace,
    Then it rejects that ignored path without revealing path existence`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-grep-"));
    await writeFile(join(workspace, ".gitignore"), "secret-dir/\n", "utf8");

    try {
      // When / Then
      await expectGrepError(
        () =>
          executeGrep(workspace, "needle", { path: "secret-dir/missing.txt" }),
        "tool_path_ignored",
        "ignored path",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test.sequential(`Given git is unavailable and a gitignore rule excludes an explicitly requested file,
    When the grep tool validates the requested path,
    Then it rejects that ignored file before searching`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-grep-"));
    const pathWithoutGit = await mkdtemp(join(tmpdir(), "keel-no-git-"));
    await writeFile(join(workspace, ".gitignore"), "secret.txt\n", "utf8");
    await writeFile(join(workspace, "secret.txt"), "needle\n", "utf8");

    try {
      // When / Then
      await withPath(pathWithoutGit, () =>
        expectGrepError(
          () => executeGrep(workspace, "needle", { path: "secret.txt" }),
          "tool_path_ignored",
          "ignored path",
        ),
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(pathWithoutGit, { recursive: true, force: true });
    }
  });

  test(`Given a non-git workspace nested gitignore rule excludes an explicitly requested file,
    When the grep tool validates the requested path,
    Then it rejects that ignored nested file before searching`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-grep-"));
    await mkdir(join(workspace, "src"), { recursive: true });
    await writeFile(join(workspace, "src", ".gitignore"), "secret.txt\n");
    await writeFile(join(workspace, "src", "secret.txt"), "needle\n");

    try {
      // When / Then
      await expectGrepError(
        () => executeGrep(workspace, "needle", { path: "src/secret.txt" }),
        "tool_path_ignored",
        "ignored path",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test.sequential(`Given git is unavailable and a nested gitignore rule excludes an explicitly requested file,
    When the grep tool validates the requested path,
    Then it rejects that ignored nested file before searching`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-grep-"));
    const pathWithoutGit = await mkdtemp(join(tmpdir(), "keel-no-git-"));
    await mkdir(join(workspace, "src"), { recursive: true });
    await writeFile(join(workspace, "src", ".gitignore"), "secret.txt\n");
    await writeFile(join(workspace, "src", "secret.txt"), "needle\n");

    try {
      // When / Then
      await withPath(pathWithoutGit, () =>
        expectGrepError(
          () => executeGrep(workspace, "needle", { path: "src/secret.txt" }),
          "tool_path_ignored",
          "ignored path",
        ),
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(pathWithoutGit, { recursive: true, force: true });
    }
  });

  test.sequential(`Given git is unavailable and no gitignore rule excludes an explicitly requested file,
    When the grep tool validates the requested path,
    Then it still searches that file`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-grep-"));
    const pathWithoutGit = await mkdtemp(join(tmpdir(), "keel-no-git-"));
    await writeFile(join(workspace, ".gitignore"), "secret.txt\n", "utf8");
    await writeFile(join(workspace, "app.ts"), "needle\n", "utf8");

    try {
      // When
      const result = await withPath(pathWithoutGit, () =>
        executeGrep(workspace, "needle", { path: "app.ts" }),
      );

      // Then
      expect(result.content).toBe("app.ts:1:needle");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(pathWithoutGit, { recursive: true, force: true });
    }
  });

  test(`Given only git info excludes an explicitly requested file,
    When the grep tool validates the requested path,
    Then it does not treat local git excludes as project gitignore rules`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-grep-"));
    await initGitRepo(workspace);
    await writeFile(
      join(workspace, ".git", "info", "exclude"),
      "secret.txt\n",
      "utf8",
    );
    await writeFile(join(workspace, "secret.txt"), "needle\n", "utf8");

    try {
      // When
      const result = await executeGrep(workspace, "needle", {
        path: "secret.txt",
      });

      // Then
      expect(result.content).toBe("secret.txt:1:needle");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given only git info excludes a matching file,
    When the grep tool searches the workspace,
    Then it does not treat local git excludes as project gitignore rules`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-grep-"));
    await initGitRepo(workspace);
    await writeFile(
      join(workspace, ".git", "info", "exclude"),
      "secret.txt\n",
      "utf8",
    );
    await writeFile(join(workspace, "secret.txt"), "needle\n", "utf8");

    try {
      // When
      const result = await executeGrep(workspace, "needle");

      // Then
      expect(result.content).toBe("secret.txt:1:needle");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given only a dot-ignore rule excludes a matching file,
    When the grep tool searches the workspace,
    Then it does not treat dot-ignore files as project gitignore rules`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-grep-"));
    await writeFile(join(workspace, ".ignore"), "secret.txt\n", "utf8");
    await writeFile(join(workspace, "secret.txt"), "needle\n", "utf8");

    try {
      // When
      const result = await executeGrep(workspace, "needle");

      // Then
      expect(result.content).toBe("secret.txt:1:needle");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given only a ripgrep-ignore rule excludes a matching file,
    When the grep tool searches the workspace,
    Then it does not treat ripgrep-ignore files as project gitignore rules`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-grep-"));
    await writeFile(join(workspace, ".rgignore"), "secret.txt\n", "utf8");
    await writeFile(join(workspace, "secret.txt"), "needle\n", "utf8");

    try {
      // When
      const result = await executeGrep(workspace, "needle");

      // Then
      expect(result.content).toBe("secret.txt:1:needle");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given only a parent gitignore rule excludes a matching file,
    When the grep tool searches the workspace,
    Then it does not inherit ignore rules from outside the workspace`, async () => {
    // Given
    const parent = await mkdtemp(join(tmpdir(), "keel-grep-parent-"));
    const workspace = join(parent, "workspace");
    await mkdir(workspace);
    await writeFile(join(parent, ".gitignore"), "secret.txt\n");
    await writeFile(join(workspace, "secret.txt"), "needle\n", "utf8");

    try {
      // When
      const result = await executeGrep(workspace, "needle");

      // Then
      expect(result.content).toBe("secret.txt:1:needle");
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  test.sequential(`Given only a global gitignore rule excludes a matching file,
    When the grep tool searches the workspace,
    Then it does not depend on the developer machine global gitignore`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-grep-"));
    const home = await mkdtemp(join(tmpdir(), "keel-grep-home-"));
    const xdgConfigHome = join(home, ".config");
    await mkdir(join(xdgConfigHome, "git"), { recursive: true });
    await writeFile(
      join(xdgConfigHome, "git", "ignore"),
      "secret.txt\n",
      "utf8",
    );
    await writeFile(join(workspace, "secret.txt"), "needle\n", "utf8");

    try {
      // When
      const result = await withEnv(
        { HOME: home, XDG_CONFIG_HOME: xdgConfigHome },
        () => executeGrep(workspace, "needle"),
      );

      // Then
      expect(result.content).toBe("secret.txt:1:needle");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a gitignore rule re-includes an explicitly requested file,
    When the grep tool validates the requested path,
    Then it searches the unignored file`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-grep-"));
    await writeFile(join(workspace, ".gitignore"), "*.txt\n!keep.txt\n");
    await writeFile(join(workspace, "keep.txt"), "needle\n");

    try {
      // When
      const result = await executeGrep(workspace, "needle", {
        path: "keep.txt",
      });

      // Then
      expect(result.content).toBe("keep.txt:1:needle");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a gitignored explicit file is already in the git index,
    When the grep tool validates the requested path,
    Then it still rejects the file by ignore pattern`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-grep-"));
    await initGitRepo(workspace);
    await writeFile(join(workspace, "secret.txt"), "needle\n", "utf8");
    await execFileAsync("git", ["add", "secret.txt"], { cwd: workspace });
    await writeFile(join(workspace, ".gitignore"), "secret.txt\n", "utf8");

    try {
      // When / Then
      await expectGrepError(
        () => executeGrep(workspace, "needle", { path: "secret.txt" }),
        "tool_path_ignored",
        "ignored path",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a gitignore rule excludes an explicitly requested directory,
    When the grep tool validates the requested path,
    Then it rejects that ignored directory before searching`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-grep-"));
    await initGitRepo(workspace);
    await mkdir(join(workspace, "secret-dir", "nested"), { recursive: true });
    await writeFile(join(workspace, ".gitignore"), "secret-dir/\n", "utf8");
    await writeFile(
      join(workspace, "secret-dir", "nested", "secret.txt"),
      "needle\n",
    );

    try {
      // When / Then
      await expectGrepError(
        () => executeGrep(workspace, "needle", { path: "secret-dir" }),
        "tool_path_ignored",
        "ignored path",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a non-git workspace gitignore rule excludes an explicitly requested directory,
    When the grep tool validates the requested path,
    Then it rejects that ignored directory before searching`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-grep-"));
    await mkdir(join(workspace, "secret-dir", "nested"), { recursive: true });
    await writeFile(join(workspace, ".gitignore"), "secret-dir/\n", "utf8");
    await writeFile(
      join(workspace, "secret-dir", "nested", "secret.txt"),
      "needle\n",
    );

    try {
      // When / Then
      await expectGrepError(
        () => executeGrep(workspace, "needle", { path: "secret-dir" }),
        "tool_path_ignored",
        "ignored path",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test.sequential(`Given git is unavailable and a gitignore rule excludes an explicitly requested directory,
    When the grep tool validates the requested path,
    Then it rejects that ignored directory before searching`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-grep-"));
    const pathWithoutGit = await mkdtemp(join(tmpdir(), "keel-no-git-"));
    await mkdir(join(workspace, "secret-dir", "nested"), { recursive: true });
    await writeFile(join(workspace, ".gitignore"), "secret-dir/\n", "utf8");
    await writeFile(
      join(workspace, "secret-dir", "nested", "secret.txt"),
      "needle\n",
    );

    try {
      // When / Then
      await withPath(pathWithoutGit, () =>
        expectGrepError(
          () => executeGrep(workspace, "needle", { path: "secret-dir" }),
          "tool_path_ignored",
          "ignored path",
        ),
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(pathWithoutGit, { recursive: true, force: true });
    }
  });

  test(`Given a gitignore rule excludes only a child file in an explicit directory,
    When the grep tool searches that directory,
    Then it does not leak the ignored child file`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-grep-"));
    await mkdir(join(workspace, "src"), { recursive: true });
    await writeFile(join(workspace, ".gitignore"), "src/secret.txt\n", "utf8");
    await writeFile(join(workspace, "src", "secret.txt"), "needle\n", "utf8");

    try {
      // When
      const result = await executeGrep(workspace, "needle", { path: "src" });

      // Then
      expect(result.content).toBe('No matches found for "needle"');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an ancestor gitignore excludes a child file in an explicit nested directory,
    When the grep tool searches that nested directory,
    Then it still applies the project gitignore rule`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-grep-"));
    await mkdir(join(workspace, "src", "nested"), { recursive: true });
    await writeFile(
      join(workspace, "src", ".gitignore"),
      "nested/secret.txt\n",
      "utf8",
    );
    await writeFile(
      join(workspace, "src", "nested", "secret.txt"),
      "needle\n",
      "utf8",
    );

    try {
      // When
      const result = await executeGrep(workspace, "needle", {
        path: "src/nested",
      });

      // Then
      expect(result.content).toBe('No matches found for "needle"');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});

describe("Grep Tool Output Boundaries", () => {
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
    Then it returns the first capped matches in stable path order`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-grep-"));
    for (let i = 59; i >= 0; i--) {
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
      expect(matchLines).toEqual(
        Array.from(
          { length: 50 },
          (_, index) => `${String(index).padStart(2, "0")}.txt:1:needle`,
        ),
      );
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

  test.skipIf(process.platform === "win32")(
    `Given a matching file cannot be read,
    When the grep tool searches that file,
    Then it reports an inaccessible-path warning instead of leaking a raw fs error`,
    async () => {
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
    },
  );
});
