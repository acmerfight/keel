import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  GIT_PREVIEW_OUTPUT_MAX_BYTES,
  runGitProcess,
} from "../../src/tools/git-process.ts";

async function createGitWorkspace(prefix: string): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), prefix));
  execFileSync("git", ["init"], { cwd: workspace });
  return workspace;
}

async function writeBlob(
  workspace: string,
  byteCount: number,
): Promise<string> {
  await writeFile(join(workspace, "payload.txt"), "x".repeat(byteCount));
  return execFileSync("git", ["hash-object", "-w", "payload.txt"], {
    cwd: workspace,
    encoding: "utf8",
  }).trim();
}

describe("git process output capture", () => {
  test(`Given git stdout remains under the preview cap,
    When runGitProcess captures command output,
    Then the preview is complete and not marked truncated`, async () => {
    // Given
    const workspace = await createGitWorkspace("keel-git-process-under-");
    const objectId = await writeBlob(workspace, 99999);

    try {
      // When
      const result = await runGitProcess("git_process_test", workspace, [
        "cat-file",
        "-p",
        objectId,
      ]);

      // Then
      expect(result.exitCode).toBe(0);
      expect(result.stdout.text).toHaveLength(99999);
      expect(result.stdout.truncated).toBe(false);
      expect(result.artifactStdout.text).toHaveLength(99999);
      expect(result.artifactStdout.truncated).toBe(false);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given git stdout exactly reaches the preview cap,
    When runGitProcess captures command output,
    Then the preview is complete and not marked truncated`, async () => {
    // Given
    expect(GIT_PREVIEW_OUTPUT_MAX_BYTES).toBe(100000);
    const workspace = await createGitWorkspace("keel-git-process-exact-");
    const objectId = await writeBlob(workspace, 100000);

    try {
      // When
      const result = await runGitProcess("git_process_test", workspace, [
        "cat-file",
        "-p",
        objectId,
      ]);

      // Then
      expect(result.exitCode).toBe(0);
      expect(result.stdout.text).toHaveLength(100000);
      expect(result.stdout.truncated).toBe(false);
      expect(result.artifactStdout.text).toHaveLength(100000);
      expect(result.artifactStdout.truncated).toBe(false);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given git stdout exceeds the preview cap,
    When runGitProcess captures command output,
    Then the preview is capped while the artifact keeps the complete output`, async () => {
    // Given
    const workspace = await createGitWorkspace("keel-git-process-overflow-");
    const objectId = await writeBlob(workspace, 100001);

    try {
      // When
      const result = await runGitProcess("git_process_test", workspace, [
        "cat-file",
        "-p",
        objectId,
      ]);

      // Then
      expect(result.exitCode).toBe(0);
      expect(result.stdout.text).toHaveLength(100000);
      expect(result.stdout.truncated).toBe(true);
      expect(result.artifactStdout.text).toHaveLength(100001);
      expect(result.artifactStdout.truncated).toBe(false);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
