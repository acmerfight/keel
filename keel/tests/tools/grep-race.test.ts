import { access, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

afterEach(() => {
  vi.doUnmock("node:fs");
  vi.resetModules();
});

describe("Grep Tool Race Handling", () => {
  test.skipIf(process.platform !== "linux")(
    `Given a matching file name contains invalid UTF-8 bytes,
    When the grep tool searches the real workspace,
    Then it reports the match without exposing an unverifiable target path`,
    async () => {
      // Given
      const workspace = await mkdtemp(join(tmpdir(), "keel-grep-race-"));
      const invalidPath = Buffer.concat([
        Buffer.from(`${workspace}${sep}bad-`),
        Buffer.from([0xff]),
        Buffer.from(".txt"),
      ]);
      const replacement = Buffer.from([0xef, 0xbf, 0xbd]).toString("utf8");
      await writeFile(invalidPath, "needle\n", "utf8");
      const { executeGrep } = await import("../../src/tools/grep.ts");

      try {
        // When
        const result = await executeGrep(workspace, "needle");

        // Then
        expect(result.content).toBe(`bad-${replacement}.txt:1:needle`);
        expect(result.matchTargetPaths).toEqual([]);
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    },
  );

  test(`Given a matching file disappears after ripgrep reads it,
    When the grep tool resolves the real search results,
    Then it skips the missing target without failing`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-grep-race-"));
    const targetPath = join(workspace, "gone.ts");
    const targetRealPath = join(await realpath(workspace), "gone.ts");
    await writeFile(targetPath, "needle\n", "utf8");
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.doMock("node:fs", () => ({
      ...actualFs,
      existsSync: (path: Parameters<typeof actualFs.existsSync>[0]) => {
        if (path === targetRealPath && actualFs.existsSync(targetRealPath)) {
          actualFs.rmSync(targetRealPath);
        }
        return actualFs.existsSync(path);
      },
    }));
    const { executeGrep } = await import("../../src/tools/grep.ts");

    try {
      // When
      const result = await executeGrep(workspace, "needle");

      // Then
      expect(result.content).toBe('No matches found for "needle"');
      expect(result.matchTargetPaths).toEqual([]);
      await expect(access(targetPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
