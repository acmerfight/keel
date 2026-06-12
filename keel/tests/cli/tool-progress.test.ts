import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const CLI_PATH = join(import.meta.dirname, "../../src/cli/index.ts");

function runCli(
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly env?: Record<string, string>;
  },
): Promise<{
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}> {
  return new Promise((resolve) => {
    const child = execFile(
      "node",
      ["--experimental-strip-types", CLI_PATH, ...args],
      {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        timeout: 5000,
      },
      (error, stdout, stderr) => {
        resolve({
          stdout,
          stderr,
          exitCode: error?.code ? Number(error.code) : (child.exitCode ?? 0),
        });
      },
    );
  });
}

describe("CLI Tool Progress", () => {
  test(`Given a workspace file contains text to replace,
    When user runs the CLI and the agent edits the file,
    Then the user sees the running tool call without polluting the final answer`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-progress-"));
    await writeFile(join(workspace, "note.txt"), "hello old world\n", "utf8");

    try {
      // When
      const result = await runCli(["replace old with new in note.txt"], {
        cwd: workspace,
        env: { KEEL_PROVIDER: "fake" },
      });

      // Then
      expect(result.exitCode).toBe(0);
      expect(await readFile(join(workspace, "note.txt"), "utf8")).toBe(
        "hello new world\n",
      );
      expect(result.stdout).toBe("Edited note.txt\n");
      expect(result.stderr).toBe("Tool: edit note.txt\n");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a tool call path embeds a newline that forges a progress line,
    When user runs the CLI,
    Then each progress record stays on one line with the newline made visible`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-progress-"));
    await writeFile(join(workspace, "note.txt"), "hello old world\n", "utf8");
    const forgedPath = "note.txt\nTool: edit forged.txt";

    try {
      // When
      const result = await runCli([`replace old with new in ${forgedPath}`], {
        cwd: workspace,
        env: { KEEL_PROVIDER: "fake" },
      });

      // Then
      expect(result.exitCode).toBe(0);
      const escapedLabel = "edit note.txt\\nTool: edit forged.txt";
      expect(result.stderr).toBe(
        `Tool: ${escapedLabel}\nTool failed: ${escapedLabel}\n`,
      );
      expect(result.stderr).not.toContain("\nTool: edit forged.txt\n");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a tool call path embeds a terminal control sequence,
    When user runs the CLI,
    Then the control character is printed as a visible escape instead of executing`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-progress-"));
    const clearScreenPath = "\u001b[2Jnote.txt";

    try {
      // When
      const result = await runCli(
        [`replace old with new in ${clearScreenPath}`],
        {
          cwd: workspace,
          env: { KEEL_PROVIDER: "fake" },
        },
      );

      // Then
      expect(result.exitCode).toBe(0);
      expect(result.stderr).not.toContain("\u001b");
      expect(result.stderr).toContain("Tool: edit \\x1b[2Jnote.txt\n");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a tool call argument is very long,
    When user runs the CLI,
    Then the progress line is truncated to a readable length`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-progress-"));
    const longPath = `${"a".repeat(300)}.txt`;

    try {
      // When
      const result = await runCli([`replace old with new in ${longPath}`], {
        cwd: workspace,
        env: { KEEL_PROVIDER: "fake" },
      });

      // Then
      expect(result.exitCode).toBe(0);
      const lines = result.stderr.split("\n").filter((line) => line !== "");
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        expect(line.length).toBeLessThanOrEqual(200);
      }
      expect(result.stderr).toContain("...");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a tool call path literally ends with the failure marker,
    When user runs the CLI,
    Then start lines and failure lines stay distinguishable by their prefix`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-progress-"));
    const spoofedPath = "note.txt (failed)";

    try {
      // When
      const result = await runCli([`replace old with new in ${spoofedPath}`], {
        cwd: workspace,
        env: { KEEL_PROVIDER: "fake" },
      });

      // Then
      expect(result.exitCode).toBe(0);
      const lines = result.stderr.split("\n").filter((line) => line !== "");
      expect(lines[0]).toBe("Tool: edit note.txt (failed)");
      expect(lines[0]).not.toMatch(/^Tool failed: /);
      expect(lines[1]).toBe("Tool failed: edit note.txt (failed)");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an edit targets text that does not exist,
    When user runs the CLI,
    Then the user sees the tool call marked as failed`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-progress-"));
    await writeFile(join(workspace, "note.txt"), "hello world\n", "utf8");

    try {
      // When
      const result = await runCli(["replace missing with new in note.txt"], {
        cwd: workspace,
        env: { KEEL_PROVIDER: "fake" },
      });

      // Then
      expect(result.exitCode).toBe(0);
      expect(await readFile(join(workspace, "note.txt"), "utf8")).toBe(
        "hello world\n",
      );
      expect(result.stderr).toBe(
        "Tool: edit note.txt\nTool failed: edit note.txt\n",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
