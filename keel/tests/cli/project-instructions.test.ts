import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { runCliMain } from "../../src/cli/index.ts";
import { createRuntime } from "../../src/testing/cli-runtime-fixtures.ts";

async function runOneShot(workspace: string) {
  const fixture = createRuntime(["hello"], {
    cwd: workspace,
    env: { KEEL_PROVIDER: "fake" },
  });
  const exitCode = await runCliMain(fixture.runtime);
  return { exitCode, stdout: fixture.stdout(), stderr: fixture.stderr() };
}

describe("Project Instructions", () => {
  test(`Given root AGENTS is a symlink escaping the workspace,
    When the user starts a one-shot run,
    Then startup rejects the outside file before provider output is printed`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-agents-workspace-"));
    const outside = await mkdtemp(join(tmpdir(), "keel-agents-outside-"));
    await writeFile(join(outside, "secret.txt"), "SECRET_OUTSIDE_WORKSPACE");
    await symlink(join(outside, "secret.txt"), join(workspace, "AGENTS.md"));

    try {
      // When
      const result = await runOneShot(workspace);

      // Then
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("cannot load AGENTS.md");
      expect(result.stderr).toContain("outside the workspace");
      expect(result.stderr).not.toContain("SECRET_OUTSIDE_WORKSPACE");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test(`Given root AGENTS is a symlink to an ignored workspace file,
    When the user starts a one-shot run,
    Then startup rejects the ignored file before provider output is printed`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-ignored-agents-"));
    await writeFile(join(workspace, ".gitignore"), "secret.env\n", "utf8");
    await writeFile(join(workspace, "secret.env"), "SECRET_FROM_GITIGNORE");
    await symlink(join(workspace, "secret.env"), join(workspace, "AGENTS.md"));

    try {
      // When
      const result = await runOneShot(workspace);

      // Then
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("cannot load AGENTS.md");
      expect(result.stderr).toContain("ignored path");
      expect(result.stderr).not.toContain("SECRET_FROM_GITIGNORE");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test.each([
    {
      name: "a dangling symlink",
      prefix: "keel-dangling-agents-",
      setup: async (workspace: string) => {
        await symlink(
          join(workspace, "missing.md"),
          join(workspace, "AGENTS.md"),
        );
      },
      expected: "cannot load AGENTS.md",
    },
    {
      name: "a symlink loop",
      prefix: "keel-loop-agents-",
      setup: async (workspace: string) => {
        await symlink("AGENTS.md", join(workspace, "AGENTS.md"));
      },
      expected: "cannot load AGENTS.md",
    },
    {
      name: "too large",
      prefix: "keel-large-agents-",
      setup: async (workspace: string) => {
        await writeFile(
          join(workspace, "AGENTS.md"),
          "x".repeat(50 * 1024 + 1),
        );
      },
      expected: "too large",
    },
    {
      name: "binary data",
      prefix: "keel-binary-agents-",
      setup: async (workspace: string) => {
        await writeFile(
          join(workspace, "AGENTS.md"),
          Buffer.from([0x00, 0x01, 0x02, 0x03]),
        );
      },
      expected: "binary or not valid UTF-8",
    },
    {
      name: "a directory",
      prefix: "keel-directory-agents-",
      setup: async (workspace: string) => {
        await mkdir(join(workspace, "AGENTS.md"));
      },
      expected: "regular file",
    },
    {
      name: "invalid UTF-8 text",
      prefix: "keel-invalid-agents-",
      setup: async (workspace: string) => {
        await writeFile(
          join(workspace, "AGENTS.md"),
          Buffer.from([0xc3, 0x28]),
        );
      },
      expected: "binary or not valid UTF-8",
    },
  ])(
    `Given root AGENTS is $name,
    When the user starts a one-shot run,
    Then startup reports the project instructions error before provider output is printed`,
    async ({ prefix, setup, expected }) => {
      // Given
      const workspace = await mkdtemp(join(tmpdir(), prefix));
      await setup(workspace);

      try {
        // When
        const result = await runOneShot(workspace);

        // Then
        expect(result.exitCode).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain(expected);
        expect(result.stderr).not.toContain("Hello from fake provider");
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    },
  );

  test(`Given root AGENTS instructions are empty,
    When the user starts a one-shot run,
    Then the empty file is ignored and the provider reply is printed`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-empty-agents-"));
    await writeFile(join(workspace, "AGENTS.md"), "\n\n", "utf8");

    try {
      // When
      const result = await runOneShot(workspace);

      // Then
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("Hello from fake provider.\n");
      expect(result.stderr).toBe("");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
