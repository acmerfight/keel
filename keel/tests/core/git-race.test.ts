import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

function runCommand(
  command: string,
  args: readonly string[],
  cwd: string,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = execFile(
      command,
      [...args],
      { cwd },
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

async function git(
  cwd: string,
  args: readonly string[],
): Promise<CommandResult> {
  return await runCommand("git", args, cwd);
}

async function createGitWorkspace(): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "keel-git-race-"));
  await git(workspace, ["init"]);
  await git(workspace, ["config", "user.name", "Keel Test"]);
  await git(workspace, ["config", "user.email", "keel@example.com"]);
  return workspace;
}

async function importGitWithFs(
  overrides: Partial<typeof import("node:fs")>,
): Promise<typeof import("../../src/core/git.ts")> {
  vi.resetModules();
  const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
  vi.doMock("node:fs", () => ({ ...actualFs, ...overrides }));
  return import("../../src/core/git.ts");
}

describe("Git Checkpoint Race Handling", () => {
  afterEach(() => {
    vi.doUnmock("node:fs");
    vi.resetModules();
  });

  test(`Given a created file disappears after restore resolves its real path,
    When restoring the create checkpoint,
    Then restore blocks without consuming the checkpoint`, async () => {
    // Given
    const workspace = await createGitWorkspace();
    const filePath = join(workspace, "created.txt");
    await writeFile(filePath, "created\n", "utf8");
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const { recordLastCreateCheckpoint, restoreLastEditCheckpoint } =
      await importGitWithFs({
        lstatSync: (path) => {
          if (String(path).endsWith("created.txt")) {
            throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
          }
          return actualFs.lstatSync(path);
        },
      });
    recordLastCreateCheckpoint({
      workspace,
      filePath,
      afterContent: "created\n",
    });

    try {
      // When
      const result = restoreLastEditCheckpoint(workspace);

      // Then
      expect(result).toMatchObject({
        status: "blocked",
        filePath: "created.txt",
      });
      expect(restoreLastEditCheckpoint(workspace)).toMatchObject({
        status: "blocked",
        filePath: "created.txt",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given checkpoint metadata cannot be written for an edit,
    When recording the edit checkpoint,
    Then Keel skips the checkpoint without failing`, async () => {
    // Given
    const workspace = await createGitWorkspace();
    const filePath = join(workspace, "note.txt");
    await writeFile(filePath, "new\n", "utf8");
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const { recordLastEditCheckpoint } = await importGitWithFs({
      writeFileSync: (path, data, options) => {
        if (String(path).endsWith("last-edit-checkpoint.json")) {
          throw Object.assign(new Error("EACCES"), { code: "EACCES" });
        }
        return actualFs.writeFileSync(path, data, options);
      },
    });

    try {
      // When
      const result = recordLastEditCheckpoint({
        workspace,
        filePath,
        beforeContent: "old\n",
        afterContent: "new\n",
      });

      // Then
      expect(result).toEqual({ written: false });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given checkpoint metadata cannot be written for a created file,
    When recording the create checkpoint,
    Then Keel skips the checkpoint without failing`, async () => {
    // Given
    const workspace = await createGitWorkspace();
    const filePath = join(workspace, "created.txt");
    await writeFile(filePath, "created\n", "utf8");
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const { recordLastCreateCheckpoint } = await importGitWithFs({
      writeFileSync: (path, data, options) => {
        if (String(path).endsWith("last-edit-checkpoint.json")) {
          throw Object.assign(new Error("EACCES"), { code: "EACCES" });
        }
        return actualFs.writeFileSync(path, data, options);
      },
    });

    try {
      // When
      const result = recordLastCreateCheckpoint({
        workspace,
        filePath,
        afterContent: "created\n",
      });

      // Then
      expect(result).toEqual({ written: false });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
