import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { restoreTextFileByIdentityBestEffort } from "../../src/tools/atomic-write.ts";

describe("Atomic File Rollback", () => {
  test(`Given a published replacement disappears before rollback,
    When cleanup attempts to restore the file by its owned identity,
    Then it tolerates the missing target without recreating it`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-atomic-rollback-"));
    const targetPath = join(workspace, "missing.txt");

    try {
      // When / Then
      expect(() =>
        restoreTextFileByIdentityBestEffort(
          targetPath,
          { dev: 1, ino: 1 },
          { beforeContent: "old\n", afterContent: "new\n" },
          0o644,
        ),
      ).not.toThrow();
      expect(existsSync(targetPath)).toBe(false);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
