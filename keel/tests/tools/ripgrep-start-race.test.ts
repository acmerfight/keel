import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, test, vi } from "vitest";

class MockRipgrepProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn();
}

function errno(message: string, code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}

function mockRipgrepStartFailure(error: NodeJS.ErrnoException) {
  vi.resetModules();

  const spawn = vi.fn(() => {
    const child = new MockRipgrepProcess();
    queueMicrotask(() => {
      child.emit("error", error);
      child.stdout.end();
      child.stderr.end();
    });
    return child;
  });

  vi.doMock("node:child_process", () => ({ spawn }));
  return spawn;
}

afterEach(() => {
  vi.doUnmock("node:child_process");
  vi.resetModules();
  vi.restoreAllMocks();
});

describe("Ripgrep Start Failure Recovery", () => {
  test.sequential(`Given bundled ripgrep disappears after validation,
    When grep runs through the tool execution layer,
    Then it returns a recoverable search failure for the next model turn`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-rg-start-"));
    await writeFile(join(workspace, "app.ts"), "needle\n", "utf8");
    const spawn = mockRipgrepStartFailure(
      errno("spawn /test/rg ENOENT", "ENOENT"),
    );
    const { executeToolCall } = await import("../../src/tools/execution.ts");

    try {
      // When
      const result = await executeToolCall({
        workspace,
        toolCall: {
          id: "grep_1",
          tool: "grep",
          pattern: "needle",
        },
        signal: new AbortController().signal,
        allowBash: false,
      });

      // Then
      expect(spawn).toHaveBeenCalledOnce();
      expect(result.ok).toBe(false);
      expect(result.content).toContain("Tool failed: grep failed");
      expect(result.content).toContain("ripgrep could not start (ENOENT)");
      expect(result.content).toContain("Recovery:");
      expect(result.content).toContain("ls/read");
      expect(result.content).not.toContain("/test/rg");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test.sequential(`Given bundled ripgrep loses execute permission after validation,
    When glob runs through the tool execution layer,
    Then it returns a recoverable search failure instead of a fatal tool error`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-rg-start-"));
    await writeFile(join(workspace, "app.ts"), "export {}\n", "utf8");
    mockRipgrepStartFailure(errno("spawn /test/rg EACCES", "EACCES"));
    const { executeToolCall } = await import("../../src/tools/execution.ts");

    try {
      // When
      const result = await executeToolCall({
        workspace,
        toolCall: {
          id: "glob_1",
          tool: "glob",
          pattern: "**/*.ts",
        },
        signal: new AbortController().signal,
        allowBash: false,
      });

      // Then
      expect(result.ok).toBe(false);
      expect(result.content).toContain("Tool failed: glob failed");
      expect(result.content).toContain("ripgrep could not start (EACCES)");
      expect(result.content).toContain("restore execute permissions");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test.sequential(`Given the operating system denies ripgrep execution after validation,
    When glob runs through the tool execution layer,
    Then it returns the same recoverable permission guidance`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-rg-start-"));
    await writeFile(join(workspace, "app.ts"), "export {}\n", "utf8");
    mockRipgrepStartFailure(errno("spawn /test/rg EPERM", "EPERM"));
    const { executeToolCall } = await import("../../src/tools/execution.ts");

    try {
      // When
      const result = await executeToolCall({
        workspace,
        toolCall: {
          id: "glob_1",
          tool: "glob",
          pattern: "**/*.ts",
        },
        signal: new AbortController().signal,
        allowBash: false,
      });

      // Then
      expect(result.ok).toBe(false);
      expect(result.content).toContain("Tool failed: glob failed");
      expect(result.content).toContain("ripgrep could not start (EPERM)");
      expect(result.content).toContain("restore execute permissions");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test.sequential(`Given the operating system temporarily refuses another ripgrep process,
    When grep runs through the tool execution layer,
    Then it reports a recoverable resource failure for the next model turn`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-rg-start-"));
    await writeFile(join(workspace, "app.ts"), "needle\n", "utf8");
    mockRipgrepStartFailure(errno("spawn /test/rg EAGAIN", "EAGAIN"));
    const { executeToolCall } = await import("../../src/tools/execution.ts");

    try {
      // When
      const result = await executeToolCall({
        workspace,
        toolCall: {
          id: "grep_1",
          tool: "grep",
          pattern: "needle",
        },
        signal: new AbortController().signal,
        allowBash: false,
      });

      // Then
      expect(result.ok).toBe(false);
      expect(result.content).toContain("Tool failed: grep failed");
      expect(result.content).toContain("ripgrep could not start (EAGAIN)");
      expect(result.content).toContain("temporarily exhausted");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test.sequential(`Given the caller aborts while ripgrep is starting,
    When grep runs through the tool execution layer,
    Then it preserves the abort error instead of reporting a recoverable search failure`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-rg-start-"));
    await writeFile(join(workspace, "app.ts"), "needle\n", "utf8");
    mockRipgrepStartFailure(
      Object.assign(new Error("The operation was aborted"), {
        code: "ABORT_ERR",
        name: "AbortError",
      }),
    );
    const { executeToolCall } = await import("../../src/tools/execution.ts");

    try {
      // When / Then
      await expect(
        executeToolCall({
          workspace,
          toolCall: {
            id: "grep_1",
            tool: "grep",
            pattern: "needle",
          },
          signal: new AbortController().signal,
          allowBash: false,
        }),
      ).rejects.toMatchObject({
        name: "AbortError",
        code: "ABORT_ERR",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test.sequential(`Given ripgrep start fails with an unclassified operating system error,
    When glob runs through the tool execution layer,
    Then it reports a recoverable tool failure for the next model turn`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-rg-start-"));
    await writeFile(join(workspace, "app.ts"), "export {}\n", "utf8");
    mockRipgrepStartFailure(errno("spawn /test/rg EMFILE", "EMFILE"));
    const { executeToolCall } = await import("../../src/tools/execution.ts");

    try {
      // When
      const result = await executeToolCall({
        workspace,
        toolCall: {
          id: "glob_1",
          tool: "glob",
          pattern: "**/*.ts",
        },
        signal: new AbortController().signal,
        allowBash: false,
      });

      // Then
      expect(result.ok).toBe(false);
      expect(result.content).toContain("Tool failed: glob failed");
      expect(result.content).toContain("spawn /test/rg EMFILE");
      expect(result.content).toContain("Recovery:");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
