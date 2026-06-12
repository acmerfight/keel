import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { withGitWorkspace as withHarnessGitWorkspace } from "../../src/testing/cli-harness.ts";

async function withGitWorkspace(
  action: (workspace: string) => Promise<void>,
): Promise<void> {
  await withHarnessGitWorkspace(action, "keel-git-race-");
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

  test(`Given a created file disappears after restore stats it,
    When restoring the create checkpoint,
    Then restore blocks without consuming the checkpoint`, async () => {
    await withGitWorkspace(async (workspace) => {
      // Given
      const filePath = join(workspace, "created.txt");
      await writeFile(filePath, "created\n", "utf8");
      const actualFs =
        await vi.importActual<typeof import("node:fs")>("node:fs");
      let targetRealpathFails = false;
      const { recordLastCreateCheckpoint, restoreLastEditCheckpoint } =
        await importGitWithFs({
          realpathSync: (path) => {
            if (targetRealpathFails && String(path).endsWith("created.txt")) {
              throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
            }
            return actualFs.realpathSync(path);
          },
        });
      recordLastCreateCheckpoint({
        workspace,
        filePath,
        afterContent: "created\n",
      });
      targetRealpathFails = true;

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
    });
  });

  test.each([
    {
      operation: "an edit",
      fileName: "note.txt",
      content: "new\n",
      record: (
        gitModule: typeof import("../../src/core/git.ts"),
        workspace: string,
        filePath: string,
      ) =>
        gitModule.recordLastEditCheckpoint({
          workspace,
          filePath,
          beforeContent: "old\n",
          afterContent: "new\n",
        }),
    },
    {
      operation: "a created file",
      fileName: "created.txt",
      content: "created\n",
      record: (
        gitModule: typeof import("../../src/core/git.ts"),
        workspace: string,
        filePath: string,
      ) =>
        gitModule.recordLastCreateCheckpoint({
          workspace,
          filePath,
          afterContent: "created\n",
        }),
    },
  ])(`Given checkpoint metadata cannot be written for $operation,
    When recording the checkpoint,
    Then Keel skips the checkpoint without failing`, async ({
    fileName,
    content,
    record,
  }) => {
    await withGitWorkspace(async (workspace) => {
      // Given
      const filePath = join(workspace, fileName);
      await writeFile(filePath, content, "utf8");
      const actualFs =
        await vi.importActual<typeof import("node:fs")>("node:fs");
      const gitModule = await importGitWithFs({
        writeFileSync: (path, data, options) => {
          if (String(path).endsWith("last-edit-checkpoint.json")) {
            throw Object.assign(new Error("EACCES"), { code: "EACCES" });
          }
          return actualFs.writeFileSync(path, data, options);
        },
      });

      // When
      const result = record(gitModule, workspace, filePath);

      // Then
      expect(result).toEqual({ written: false });
    });
  });
});
