import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, test, vi } from "vitest";

class MockRipgrepProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn();
}

function mockUncooperativeRipgrep(): {
  readonly child: MockRipgrepProcess;
  readonly spawn: ReturnType<typeof vi.fn>;
} {
  vi.resetModules();
  const child = new MockRipgrepProcess();
  const spawn = vi.fn(() => child);
  vi.doMock("node:child_process", () => ({ spawn }));
  return { child, spawn };
}

afterEach(() => {
  vi.useRealTimers();
  vi.doUnmock("node:child_process");
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("Ripgrep Process Stop Races", () => {
  test.sequential(`Given multiple streamed matches request stop while ripgrep ignores SIGTERM,
    When the kill grace period expires,
    Then Keel arms one fallback and sends a single SIGKILL`, async () => {
    // Given
    vi.useFakeTimers();
    const ripgrep = mockUncooperativeRipgrep();
    const { runRipgrepProcess } = await import(
      "../../src/tools/ripgrep-process.ts"
    );
    const resultPromise = runRipgrepProcess({
      toolName: "glob",
      workspacePath: process.cwd(),
      args: ["--files"],
      timeoutMs: 10_000,
      onStdoutLine: (_line, stopRipgrep) => {
        stopRipgrep();
      },
    });
    for (
      let attempt = 0;
      attempt < 10 && ripgrep.spawn.mock.calls.length === 0;
      attempt++
    ) {
      await Promise.resolve();
    }
    expect(ripgrep.spawn).toHaveBeenCalledOnce();

    // When
    ripgrep.child.stdout.write("first.ts\nsecond.ts\n");
    expect(ripgrep.child.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
    expect(ripgrep.child.kill).toHaveBeenNthCalledWith(2, "SIGTERM");
    await vi.advanceTimersByTimeAsync(1_000);

    // Then
    expect(ripgrep.child.kill).toHaveBeenCalledTimes(3);
    expect(ripgrep.child.kill).toHaveBeenLastCalledWith("SIGKILL");
    ripgrep.child.stdout.end();
    ripgrep.child.stderr.end();
    ripgrep.child.emit("close", 0);
    await expect(resultPromise).resolves.toEqual({ code: 0, stderr: "" });
  });
});
