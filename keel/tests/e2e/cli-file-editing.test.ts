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

describe("CLI File Editing", () => {
  test(`Given a workspace file contains an old word,
    When user runs the CLI fake edit demo,
    Then the file is updated on disk`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-edit-"));
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
      expect(result.stderr).toBe("");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
