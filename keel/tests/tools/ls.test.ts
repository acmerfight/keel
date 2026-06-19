import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import type { KeelErrorCode } from "../../src/core/error.ts";
import { executeLs } from "../../src/tools/ls.ts";

const execFileAsync = promisify(execFile);

async function expectLsError(
  action: () => unknown | Promise<unknown>,
  code: KeelErrorCode,
  message: string,
  recovery?: string,
): Promise<void> {
  try {
    await action();
    throw new Error("Expected ls tool to throw");
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

describe("Ls Tool Directory Discovery", () => {
  test(`Given a workspace directory contains files, subdirectories, and dotfiles,
    When the ls tool lists the directory,
    Then it returns direct entries with directories first in stable order`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-ls-"));
    await mkdir(join(workspace, "src"), { recursive: true });
    await mkdir(join(workspace, ".config"), { recursive: true });
    await writeFile(join(workspace, "README.md"), "docs\n", "utf8");
    await writeFile(join(workspace, "package.json"), "{}\n", "utf8");
    await writeFile(join(workspace, "src", "app.ts"), "app\n", "utf8");

    try {
      // When
      const result = await executeLs(workspace);

      // Then
      expect(result.content).toBe(
        [".config/", "src/", "README.md", "package.json"].join("\n"),
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given project policy excludes directory children,
    When the ls tool lists the parent directory,
    Then ignored entries are omitted from the output`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-ls-"));
    await mkdir(join(workspace, "src", "generated"), { recursive: true });
    await writeFile(join(workspace, ".gitignore"), "src/generated/\n", "utf8");
    await writeFile(join(workspace, "src", "app.ts"), "app\n", "utf8");
    await writeFile(
      join(workspace, "src", "generated", "api.ts"),
      "ignored\n",
      "utf8",
    );

    try {
      // When
      const result = await executeLs(workspace, { path: "src" });

      // Then
      expect(result.content).toBe("app.ts");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a built-in ignored directory exists at the workspace root,
    When the ls tool lists the workspace,
    Then that directory is omitted before returning entries`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-ls-"));
    await mkdir(join(workspace, "node_modules"), { recursive: true });
    await mkdir(join(workspace, "src"), { recursive: true });
    await writeFile(
      join(workspace, "node_modules", "package.json"),
      "{}\n",
      "utf8",
    );

    try {
      // When
      const result = await executeLs(workspace);

      // Then
      expect(result.content).toBe("src/");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the requested directory is under a built-in ignored segment,
    When the ls tool validates the request,
    Then it rejects the path before listing entries`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-ls-"));
    await mkdir(join(workspace, "node_modules"), { recursive: true });

    try {
      // When / Then
      await expectLsError(
        () => executeLs(workspace, { path: "node_modules" }),
        "tool_path_ignored",
        "ignored path",
        "excluded by project policy",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the requested directory is excluded by project ignore rules,
    When the ls tool validates the request,
    Then it asks the model to choose a different path`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-ls-"));
    await mkdir(join(workspace, "src", "generated"), { recursive: true });
    await writeFile(join(workspace, ".gitignore"), "src/generated/\n", "utf8");

    try {
      // When / Then
      await expectLsError(
        () => executeLs(workspace, { path: "src/generated" }),
        "tool_path_ignored",
        "ignored path",
        "excluded by project .gitignore",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a directory has more entries than requested,
    When the ls tool lists it with a limit,
    Then it caps the output and tells the model how to see more`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-ls-"));
    await mkdir(join(workspace, "cases"), { recursive: true });
    for (let index = 0; index < 5; index++) {
      await writeFile(
        join(workspace, "cases", `case-${index}.ts`),
        "case\n",
        "utf8",
      );
    }

    try {
      // When
      const result = await executeLs(workspace, { path: "cases", limit: 3 });

      // Then
      expect(result.content).toBe(
        [
          "case-0.ts",
          "case-1.ts",
          "case-2.ts",
          "[ls output truncated: showing first 3 entries. Narrow the path or increase limit to see more.]",
        ].join("\n"),
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a directory has more entries than the maximum limit,
    When the ls tool truncates at that maximum,
    Then it asks the model to narrow the path instead of increasing limit`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-ls-"));
    await mkdir(join(workspace, "many"), { recursive: true });
    for (let index = 0; index <= 1000; index++) {
      await writeFile(
        join(workspace, "many", `entry-${String(index).padStart(4, "0")}.ts`),
        "entry\n",
        "utf8",
      );
    }

    try {
      // When
      const result = executeLs(workspace, { path: "many", limit: 1000 });

      // Then
      const lines = result.content.split("\n");
      expect(lines).toHaveLength(1001);
      expect(lines.at(-1)).toBe(
        "[ls output truncated: showing first 1000 entries. Narrow the path to see more.]",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the caller supplies an invalid entry limit,
    When the ls tool validates options,
    Then it rejects the request before reading the directory`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-ls-"));

    try {
      // When / Then
      await expectLsError(
        () => executeLs(workspace, { limit: 0 }),
        "tool_invalid_ls_options",
        "limit must be a positive integer",
        "Use a positive integer",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the requested directory is empty,
    When the ls tool lists it,
    Then it reports an empty directory`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-ls-"));
    await mkdir(join(workspace, "empty"), { recursive: true });

    try {
      // When
      const result = await executeLs(workspace, { path: "empty" });

      // Then
      expect(result.content).toBe("(empty directory)");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the requested directory points outside the workspace,
    When the ls tool validates the request,
    Then it rejects the path before listing entries`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-ls-"));
    const outside = await mkdtemp(join(tmpdir(), "keel-ls-outside-"));

    try {
      // When / Then
      await expectLsError(
        () => executeLs(workspace, { path: outside }),
        "tool_path_outside_workspace",
        "outside the workspace",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test(`Given the requested path is a file,
    When the ls tool validates the request,
    Then it asks the model to list a directory instead`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-ls-"));
    await writeFile(join(workspace, "note.txt"), "hello\n", "utf8");

    try {
      // When / Then
      await expectLsError(
        () => executeLs(workspace, { path: "note.txt" }),
        "tool_not_directory",
        "not a directory",
        "Use a workspace directory",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform === "win32")(
    `Given a directory child is a symlink escaping the workspace,
    When the ls tool lists the directory,
    Then the escaping entry is omitted from the output`,
    async () => {
      // Given
      const workspace = await mkdtemp(join(tmpdir(), "keel-ls-"));
      const outside = await mkdtemp(join(tmpdir(), "keel-ls-outside-"));
      await writeFile(join(outside, "secret.txt"), "secret\n", "utf8");
      await writeFile(join(workspace, "visible.txt"), "visible\n", "utf8");
      await symlink(outside, join(workspace, "escape"), "dir");

      try {
        // When
        const result = await executeLs(workspace);

        // Then
        expect(result.content).toBe("visible.txt");
      } finally {
        await rm(workspace, { recursive: true, force: true });
        await rm(outside, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(process.platform === "win32")(
    `Given the requested path is a symlink to a gitignored file,
    When the ls tool validates the resolved target,
    Then it rejects the ignored path before revealing its type`,
    async () => {
      // Given
      const workspace = await mkdtemp(join(tmpdir(), "keel-ls-"));
      await writeFile(join(workspace, ".gitignore"), "secret.txt\n", "utf8");
      await writeFile(join(workspace, "secret.txt"), "secret\n", "utf8");
      await symlink(join(workspace, "secret.txt"), join(workspace, "link"));

      try {
        // When / Then
        await expectLsError(
          () => executeLs(workspace, { path: "link" }),
          "tool_path_ignored",
          "ignored path",
          "excluded by project .gitignore",
        );
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(process.platform === "win32")(
    `Given a directory child is a symlink to a built-in ignored directory,
    When the ls tool lists the parent directory,
    Then the resolved ignored entry is omitted from the output`,
    async () => {
      // Given
      const workspace = await mkdtemp(join(tmpdir(), "keel-ls-"));
      await mkdir(join(workspace, "node_modules", "pkg"), {
        recursive: true,
      });
      await writeFile(join(workspace, "visible.txt"), "visible\n", "utf8");
      await symlink(
        join(workspace, "node_modules", "pkg"),
        join(workspace, "pkg-link"),
        "dir",
      );

      try {
        // When
        const result = executeLs(workspace);

        // Then
        expect(result.content).toBe("visible.txt");
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(process.platform === "win32")(
    `Given a directory child is a dangling symlink,
    When the ls tool lists the directory,
    Then the broken entry is omitted from the output`,
    async () => {
      // Given
      const workspace = await mkdtemp(join(tmpdir(), "keel-ls-"));
      await writeFile(join(workspace, "visible.txt"), "visible\n", "utf8");
      await symlink(
        join(workspace, "missing-target"),
        join(workspace, "broken"),
      );

      try {
        // When
        const result = await executeLs(workspace);

        // Then
        expect(result.content).toBe("visible.txt");
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(process.platform === "win32")(
    `Given a directory child is not a regular file or directory,
    When the ls tool lists the directory,
    Then the special entry is omitted from the output`,
    async () => {
      // Given
      const workspace = await mkdtemp(join(tmpdir(), "keel-ls-"));
      await writeFile(join(workspace, "visible.txt"), "visible\n", "utf8");
      await execFileAsync("mkfifo", [join(workspace, "pipe")]);

      try {
        // When
        const result = await executeLs(workspace);

        // Then
        expect(result.content).toBe("visible.txt");
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    },
  );
});
