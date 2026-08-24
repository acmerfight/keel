import type { PathLike } from "node:fs";
import { renameSync, symlinkSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

type FsPromisesModule = typeof import("node:fs/promises");

async function importArtifactCleanupWithScopeSwap(options: {
  readonly root: string;
  readonly scope: string;
  readonly outside: string;
}): Promise<typeof import("../../../src/cli/tool-output-artifacts.ts")> {
  vi.resetModules();
  const actualFs = await vi.importActual<FsPromisesModule>("node:fs/promises");
  let swapped = false;
  vi.doMock("node:fs/promises", () => ({
    ...actualFs,
    readdir: async (path: PathLike) => {
      const entries = await actualFs.readdir(path, { withFileTypes: true });
      if (!swapped && String(path) === options.root) {
        swapped = true;
        renameSync(options.scope, join(options.root, "parked-scope"));
        symlinkSync(options.outside, options.scope, "dir");
      }
      return entries;
    },
  }));
  return import("../../../src/cli/tool-output-artifacts.ts");
}

describe("CLI tool-output artifact cleanup race handling", () => {
  afterEach(() => {
    vi.doUnmock("node:fs/promises");
    vi.restoreAllMocks();
    vi.resetModules();
  });

  test(`Given cleanup has listed a legitimate scope before it is replaced by a link,
    When cleanup continues after the asynchronous directory read,
    Then it revalidates the scope and preserves old matching files outside state`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-artifact-cleanup-race-"));
    const outside = await mkdtemp(join(tmpdir(), "keel-artifact-cleanup-out-"));
    const root = join(home, "artifacts", "tool-output");
    const scope = join(root, "active-scope");
    const victim = join(outside, "victim.txt");
    await mkdir(scope, { recursive: true });
    await writeFile(victim, "outside content must survive", "utf8");
    await utimes(victim, 0, 0);
    const artifacts = await importArtifactCleanupWithScopeSwap({
      root,
      scope,
      outside,
    });

    try {
      // When
      await artifacts.cleanupExpiredToolOutputArtifacts({
        runtime: {
          env: (key) => (key === "KEEL_HOME" ? home : undefined),
          now: () => 10 * 24 * 60 * 60 * 1000,
        },
      });

      // Then
      await expect(stat(victim)).resolves.toBeDefined();
      await expect(readFile(victim, "utf8")).resolves.toBe(
        "outside content must survive",
      );
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});
