import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, test, vi } from "vitest";

class MockRipgrepProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn();
}

function mockRipgrepResult(options: {
  readonly lines?: readonly string[];
  readonly stderr?: string;
  readonly code: number | null;
}): void {
  vi.resetModules();
  const spawn = () => {
    const child = new MockRipgrepProcess();
    queueMicrotask(() => {
      for (const line of options.lines ?? []) {
        child.stdout.write(`${line}\n`);
      }
      if (options.stderr !== undefined) {
        child.stderr.write(options.stderr);
      }
      child.stdout.end();
      child.stderr.end();
      child.emit("close", options.code);
    });
    return child;
  };
  vi.doMock("node:child_process", () => ({ spawn }));
}

afterEach(() => {
  vi.doUnmock("node:child_process");
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("Glob Subprocess Race Handling", () => {
  test.sequential(`Given ripgrep reports hidden and built-in ignored paths after its policy scan,
    When glob validates the streamed matches,
    Then it omits the raced paths and returns only the visible file`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-glob-race-"));
    const hiddenPath = join(workspace, "private");
    mockRipgrepResult({
      lines: [
        "private/secret.ts",
        "node_modules/package/index.ts",
        "src/visible.ts",
      ],
      code: 0,
    });
    const { executeGlob } = await import("../../src/tools/glob.ts");

    try {
      // When
      const result = await executeGlob(workspace, "**/*.ts", {
        hiddenPaths: [hiddenPath],
      });

      // Then
      expect(result.content).toBe("src/visible.ts");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test.sequential(`Given ripgrep closes without a numeric exit code and leaves a diagnostic,
    When glob reports the subprocess failure,
    Then it preserves both the unknown exit status and stderr`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-glob-race-"));
    mockRipgrepResult({
      stderr: "terminated by an external signal\n",
      code: null,
    });
    const { executeGlob } = await import("../../src/tools/glob.ts");

    try {
      // When / Then
      await expect(executeGlob(workspace, "**/*.ts")).rejects.toMatchObject({
        code: "tool_unavailable",
        message:
          "glob failed: ripgrep exited with code unknown: terminated by an external signal",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test.sequential(`Given ripgrep exits with code two but no invalid-pattern diagnostic,
    When glob reports the subprocess failure,
    Then it keeps the failure generic without an empty stderr suffix`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-glob-race-"));
    mockRipgrepResult({ code: 2 });
    const { executeGlob } = await import("../../src/tools/glob.ts");

    try {
      // When / Then
      await expect(executeGlob(workspace, "**/*.ts")).rejects.toMatchObject({
        code: "tool_unavailable",
        message: "glob failed: ripgrep exited with code 2",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
