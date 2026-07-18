import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  expectGitExitCode,
  GIT_PREVIEW_OUTPUT_MAX_BYTES,
  runGitProcess,
} from "../../src/tools/git-process.ts";

const PATH_ENV = "PATH";

async function createGitWorkspace(prefix: string): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), prefix));
  execFileSync("git", ["init", "--quiet", "--initial-branch=main"], {
    cwd: workspace,
  });
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

async function withProcessPath<T>(
  path: string,
  callback: () => Promise<T>,
): Promise<T> {
  const originalPath = process.env[PATH_ENV];
  process.env[PATH_ENV] = path;
  try {
    return await callback();
  } finally {
    if (originalPath === undefined) {
      delete process.env[PATH_ENV];
    } else {
      process.env[PATH_ENV] = originalPath;
    }
  }
}

async function withFakeGit<T>(
  source: string,
  callback: () => Promise<T>,
): Promise<T> {
  const bin = await mkdtemp(join(tmpdir(), "keel-fake-git-process-"));
  const fakeGitPath = join(bin, "git");
  await writeFile(fakeGitPath, `#!/usr/bin/env node\n${source}\n`, "utf8");
  await chmod(fakeGitPath, 0o755);
  const originalPath = process.env[PATH_ENV];
  const path =
    originalPath === undefined ? bin : `${bin}${delimiter}${originalPath}`;

  try {
    return await withProcessPath(path, callback);
  } finally {
    await rm(bin, { recursive: true, force: true });
  }
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

describe("git process lifecycle", () => {
  test(`Given a running git process,
    When the caller aborts it,
    Then runGitProcess rejects once with the aborted tool contract`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-git-process-abort-"));
    const controller = new AbortController();

    try {
      await withFakeGit("setInterval(() => {}, 1_000);", async () => {
        const pending = runGitProcess("git_process_test", workspace, ["wait"], {
          signal: controller.signal,
        });

        // When
        controller.abort();

        // Then
        await expect(pending).rejects.toMatchObject({
          code: "tool_aborted",
          message: "git_process_test failed: command aborted",
        });
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a git process exceeds its execution deadline,
    When runGitProcess stops it,
    Then exit validation reports the configured timeout`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-git-process-timeout-"),
    );

    try {
      await withFakeGit("setInterval(() => {}, 1_000);", async () => {
        // When
        const result = await runGitProcess(
          "git_process_test",
          workspace,
          ["wait"],
          { timeoutMs: 10 },
        );

        // Then
        expect(result).toMatchObject({
          exitCode: null,
          timedOut: true,
          timeoutMs: 10,
        });
        expect(() =>
          expectGitExitCode("git_process_test", "wait", result, new Set([0])),
        ).toThrowError(
          "git_process_test failed: git wait timed out after 10ms",
        );
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a timed-out git process handles termination with exit zero,
    When the caller validates the numeric exit code,
    Then timeout attribution still takes precedence`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-git-process-timeout-exit-zero-"),
    );
    const source = [
      'process.on("SIGTERM", () => process.exit(0));',
      "setInterval(() => {}, 1_000);",
    ].join("\n");

    try {
      await withFakeGit(source, async () => {
        // When
        const result = await runGitProcess(
          "git_process_test",
          workspace,
          ["wait"],
          { timeoutMs: 2_000 },
        );

        // Then
        expect(result).toMatchObject({
          exitCode: 0,
          timedOut: true,
          timeoutMs: 2_000,
        });
        expect(() =>
          expectGitExitCode("git_process_test", "wait", result, new Set([0])),
        ).toThrowError(
          "git_process_test failed: git wait timed out after 2000ms",
        );
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given git is unavailable on the process path,
    When runGitProcess starts a command,
    Then it rejects with an actionable unavailable-tool error`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-git-process-missing-"),
    );
    const emptyBin = await mkdtemp(join(tmpdir(), "keel-empty-path-"));

    try {
      // When / Then
      await withProcessPath(emptyBin, async () => {
        await expect(
          runGitProcess("git_process_test", workspace, ["status"]),
        ).rejects.toMatchObject({
          code: "tool_unavailable",
          message: expect.stringContaining(
            "git_process_test failed: could not start git",
          ),
        });
      });
    } finally {
      await rm(emptyBin, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given git exits with a rejected numeric code and stderr,
    When the caller validates the result,
    Then it receives the command failure details`, async () => {
    // Given
    const workspace = await createGitWorkspace("keel-git-process-rejected-");

    try {
      const result = await runGitProcess("git_process_test", workspace, [
        "not-a-command",
      ]);

      // When / Then
      expect(() =>
        expectGitExitCode(
          "git_process_test",
          "not-a-command",
          result,
          new Set([0]),
        ),
      ).toThrowError(/exited with code 1: git:/u);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given git terminates from an external signal without timing out,
    When the caller validates the result,
    Then it reports the unknown exit code without inventing stderr`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-git-process-signal-"));

    try {
      await withFakeGit('process.kill(process.pid, "SIGTERM");', async () => {
        const result = await runGitProcess("git_process_test", workspace, [
          "signal",
        ]);

        // When / Then
        expect(result).toMatchObject({ exitCode: null, timedOut: false });
        expect(() =>
          expectGitExitCode("git_process_test", "signal", result, new Set([0])),
        ).toThrowError(
          "git_process_test failed: git signal exited with code unknown",
        );
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
