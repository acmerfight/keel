import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

type FsModule = typeof import("node:fs");
type FailurePhase = "stream" | "finish";

interface ProcessModules {
  readonly executeBash: typeof import("../../src/tools/bash.ts").executeBash;
  readonly runGitProcess: typeof import("../../src/tools/git-process.ts").runGitProcess;
}

async function importProcessesWithCaptureFailure(
  phase: FailurePhase,
  captureDirectories: string[],
): Promise<ProcessModules> {
  vi.resetModules();
  const actualFs = await vi.importActual<FsModule>("node:fs");
  const captureFds = new Set<number>();

  vi.doMock("node:fs", () => ({
    ...actualFs,
    mkdtempSync: ((prefix: string) => {
      const directory = actualFs.mkdtempSync(prefix);
      captureDirectories.push(directory);
      return directory;
    }) as FsModule["mkdtempSync"],
    openSync: ((path, flags, mode) => {
      const fd = actualFs.openSync(path, flags, mode);
      if (String(path).endsWith("output.bin")) captureFds.add(fd);
      return fd;
    }) as FsModule["openSync"],
    readFileSync: ((path, options) => {
      if (phase === "finish" && String(path).endsWith("output.bin")) {
        throw new Error("simulated artifact read failure");
      }
      return actualFs.readFileSync(path, options);
    }) as FsModule["readFileSync"],
    writeSync: ((
      fd: number,
      buffer: Uint8Array,
      offset?: number,
      length?: number,
      position?: number | null,
    ) => {
      if (phase === "stream" && captureFds.has(fd)) {
        throw new Error("simulated artifact write failure");
      }
      return actualFs.writeSync(fd, buffer, offset, length, position);
    }) as FsModule["writeSync"],
  }));

  const [{ executeBash }, { runGitProcess }] = await Promise.all([
    import("../../src/tools/bash.ts"),
    import("../../src/tools/git-process.ts"),
  ]);
  return { executeBash, runGitProcess };
}

async function createGitBlobWorkspace(): Promise<{
  readonly workspace: string;
  readonly objectId: string;
}> {
  const workspace = await mkdtemp(join(tmpdir(), "keel-git-capture-race-"));
  execFileSync("git", ["init", "--quiet", "--initial-branch=main"], {
    cwd: workspace,
  });
  await writeFile(join(workspace, "payload.txt"), "x".repeat(100_001));
  const objectId = execFileSync("git", ["hash-object", "-w", "payload.txt"], {
    cwd: workspace,
    encoding: "utf8",
  }).trim();
  return { workspace, objectId };
}

function expectCaptureDirectoriesRemoved(directories: readonly string[]): void {
  expect(directories.length).toBeGreaterThan(0);
  expect(directories.every((directory) => !existsSync(directory))).toBe(true);
}

describe("Process Output Capture Race Handling", () => {
  afterEach(() => {
    vi.doUnmock("node:fs");
    vi.resetModules();
  });

  test.each([
    {
      phase: "stream" as const,
      detail:
        "could not capture stdout artifact: simulated artifact write failure",
    },
    {
      phase: "finish" as const,
      detail:
        "could not capture output artifact: simulated artifact read failure",
    },
  ])(
    `Given git artifact storage fails during $phase,
    When git output crosses the in-memory threshold,
    Then the command rejects with an actionable error and removes temporary storage`,
    async ({ phase, detail }) => {
      const captureDirectories: string[] = [];
      const { workspace, objectId } = await createGitBlobWorkspace();

      try {
        const { runGitProcess } = await importProcessesWithCaptureFailure(
          phase,
          captureDirectories,
        );

        await expect(
          runGitProcess("git_process_test", workspace, [
            "cat-file",
            "-p",
            objectId,
          ]),
        ).rejects.toMatchObject({
          code: "tool_unavailable",
          message: `git_process_test failed: ${detail}`,
          recovery: expect.stringContaining("narrow output"),
        });
        expectCaptureDirectoriesRemoved(captureDirectories);
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    },
  );

  test.each([
    {
      phase: "stream" as const,
      detail:
        "could not capture stdout artifact: simulated artifact write failure",
    },
    {
      phase: "finish" as const,
      detail:
        "could not capture output artifact: simulated artifact read failure",
    },
  ])(
    `Given bash artifact storage fails during $phase,
    When command output crosses the in-memory threshold,
    Then the tool rejects with an actionable error and removes temporary storage`,
    async ({ phase, detail }) => {
      const workspace = await mkdtemp(
        join(tmpdir(), "keel-bash-capture-race-"),
      );
      const captureDirectories: string[] = [];

      try {
        const { executeBash } = await importProcessesWithCaptureFailure(
          phase,
          captureDirectories,
        );

        await expect(
          executeBash(
            workspace,
            `node -e "process.stdout.write('x'.repeat(20001))"`,
          ),
        ).rejects.toMatchObject({
          code: "tool_unavailable",
          message: `bash failed: ${detail}`,
          recovery: expect.stringContaining("narrower output"),
        });
        expectCaptureDirectoriesRemoved(captureDirectories);
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    },
  );
});
