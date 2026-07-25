import type { Dirent, PathLike, Stats } from "node:fs";
import { link, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

type FsModule = typeof import("node:fs");

interface FsOverrides {
  readonly lstatSync?: (path: PathLike) => Stats;
  readonly readdirSync?: (
    path: PathLike,
    options: { readonly withFileTypes: true },
  ) => Dirent<string>[];
}

async function importWorkspacePathWithFs(
  overrides: FsOverrides,
): Promise<typeof import("../../src/tools/workspace-path.ts")> {
  vi.resetModules();
  const actualFs = await vi.importActual<FsModule>("node:fs");
  vi.doMock("node:fs", () => ({ ...actualFs, ...overrides }));
  return import("../../src/tools/workspace-path.ts");
}

function errno(code: string): Error & { readonly code: string } {
  return Object.assign(new Error(code), { code });
}

describe("Workspace Identity Scan Race Handling", () => {
  afterEach(() => {
    vi.doUnmock("node:fs");
    vi.resetModules();
  });

  test(`Given owned paths and directories disappear during an identity scan,
    When cleanup searches the workspace for the opened identity,
    Then it skips vanished entries and still returns the surviving owned path`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-identity-scan-race-"));
    const ownedPath = join(workspace, "owned.txt");
    const vanishedPath = join(workspace, "vanished.txt");
    const vanishedDirectory = join(workspace, "vanished-directory");
    await writeFile(ownedPath, "owned\n", "utf8");
    await link(ownedPath, vanishedPath);
    await mkdir(vanishedDirectory);
    const actualFs = await vi.importActual<FsModule>("node:fs");
    const identity = {
      dev: actualFs.statSync(ownedPath).dev,
      ino: actualFs.statSync(ownedPath).ino,
    };
    const { findWorkspacePathsByIdentity } = await importWorkspacePathWithFs({
      lstatSync: (path) => {
        if (String(path) === vanishedPath) throw errno("ENOENT");
        return actualFs.lstatSync(path);
      },
      readdirSync: (path, options) => {
        if (String(path) === vanishedDirectory) throw errno("ENOENT");
        return actualFs.readdirSync(path, options);
      },
    });

    try {
      // When
      const found = findWorkspacePathsByIdentity(workspace, identity);

      // Then
      expect(found).toEqual([ownedPath]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
