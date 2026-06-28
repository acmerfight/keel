import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { runRipgrepProcess } from "../../src/tools/ripgrep-process.ts";

type RunRipgrepProcess = typeof runRipgrepProcess;

afterEach(() => {
  vi.doUnmock("../../src/tools/ripgrep-process.ts");
  vi.resetModules();
});

describe("Grep Tool Race Handling", () => {
  test(`Given ripgrep reports a bytes-encoded path that cannot be resolved as UTF-8,
    When grep formats the results,
    Then it still reports the match without exposing an unverifiable target path`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-grep-race-"));
    const invalidPathBytes = Buffer.from([
      ...Buffer.from("bad-"),
      0xff,
      ...Buffer.from(".txt"),
    ]);
    const replacement = Buffer.from([0xef, 0xbf, 0xbd]).toString("utf8");
    const mockedRunRipgrepProcess = vi.fn<RunRipgrepProcess>(
      async (options) => {
        options.onStdoutLine(
          JSON.stringify({
            type: "match",
            data: {
              path: { bytes: invalidPathBytes.toString("base64") },
              lines: { text: "needle\n" },
              line_number: 1,
            },
          }),
          () => {},
        );
        return { code: 0, stderr: "" };
      },
    );
    vi.doMock("../../src/tools/ripgrep-process.ts", () => ({
      runRipgrepProcess: mockedRunRipgrepProcess,
    }));
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
  });

  test(`Given ripgrep reports a match that disappears before target resolution,
    When grep formats the results,
    Then it skips the raced match instead of throwing from the stdout callback`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-grep-race-"));
    const mockedRunRipgrepProcess = vi.fn<RunRipgrepProcess>(
      async (options) => {
        options.onStdoutLine(
          JSON.stringify({
            type: "match",
            data: {
              path: { text: "gone.ts" },
              lines: { text: "needle\n" },
              line_number: 1,
            },
          }),
          () => {},
        );
        return { code: 0, stderr: "" };
      },
    );
    vi.doMock("../../src/tools/ripgrep-process.ts", () => ({
      runRipgrepProcess: mockedRunRipgrepProcess,
    }));
    const { executeGrep } = await import("../../src/tools/grep.ts");

    try {
      // When
      const result = await executeGrep(workspace, "needle");

      // Then
      expect(result.content).toBe('No matches found for "needle"');
      expect(result.matchTargetPaths).toEqual([]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
