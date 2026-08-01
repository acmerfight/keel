import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { KeelError } from "../../src/core/error.ts";
import { executeBash } from "../../src/tools/bash.ts";

async function createWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "keel-bash-tool-"));
}

async function expectKeelError(
  action: () => Promise<unknown>,
): Promise<KeelError> {
  try {
    await action();
  } catch (error) {
    if (error instanceof KeelError) return error;
    throw error;
  }
  throw new Error("Expected KeelError");
}

describe("Bash Tool", () => {
  test(`Given a workspace command writes to stdout and stderr,
    When the bash tool runs it,
    Then it returns both streams and the exit code`, async () => {
    // Given
    const workspace = await createWorkspace();

    try {
      // When
      const result = await executeBash(
        workspace,
        `node -e "console.log('out'); console.error('err')"`,
      );

      // Then
      expect(result.content).toContain("Exit code: 0");
      expect(result.content).toContain("stdout:\nout\n");
      expect(result.content).toContain("stderr:\nerr\n");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a workspace command exits with a nonzero status,
    When the bash tool runs it,
    Then it returns the failure output instead of throwing`, async () => {
    // Given
    const workspace = await createWorkspace();

    try {
      // When
      const result = await executeBash(
        workspace,
        `node -e "console.error('failed'); process.exit(7)"`,
      );

      // Then
      expect(result.content).toContain("Exit code: 7");
      expect(result.content).toContain("stderr:\nfailed\n");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a workspace command produces more output than the budget,
    When the bash tool captures the result,
    Then it returns a tail-truncated output`, async () => {
    // Given
    const workspace = await createWorkspace();

    try {
      // When
      const result = await executeBash(
        workspace,
        `node -e "console.log('start'); console.log('x'.repeat(50000)); console.log('end')"`,
      );

      // Then
      expect(result.content).toContain(
        "[bash stdout truncated: showing last 20000 bytes]",
      );
      expect(result.content).toContain("end\n");
      expect(result.content).not.toContain("stdout:\nstart\n");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a workspace command writes a large foreground output burst,
    When the bash tool resolves after process exit,
    Then it drains the foreground tail before returning`, async () => {
    // Given
    const workspace = await createWorkspace();

    try {
      // When
      const result = await executeBash(
        workspace,
        `node -e "process.stdout.write('x'.repeat(1000000)); console.log('end')"`,
      );

      // Then
      expect(result.content).toContain(
        "[bash stdout truncated: showing last 20000 bytes]",
      );
      expect(result.content).toContain("end\n");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a workspace command produces exactly the output budget,
    When the bash tool captures the result,
    Then it returns the full output without a truncation notice`, async () => {
    // Given
    const workspace = await createWorkspace();

    try {
      // When
      const result = await executeBash(
        workspace,
        `node -e "process.stdout.write('x'.repeat(20000))"`,
      );

      // Then
      const prefix = "Exit code: 0\n\nstdout:\n";
      expect(result.content.startsWith(prefix)).toBe(true);
      expect(result.content).toHaveLength(prefix.length + 20_001);
      expect(result.content).not.toContain("[bash stdout truncated");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a workspace command exceeds the output budget across multiple chunks,
    When the bash tool captures the result,
    Then it keeps only the latest output`, async () => {
    // Given
    const workspace = await createWorkspace();

    try {
      // When
      const result = await executeBash(
        workspace,
        `node -e "let i = 0; const chunk = 'x'.repeat(5000); const timer = setInterval(() => { process.stdout.write(chunk); i++; if (i === 5) { clearInterval(timer); process.stdout.write('end\\n'); } }, 5)"`,
      );

      // Then
      expect(result.content).toContain(
        "[bash stdout truncated: showing last 20000 bytes]",
      );
      expect(result.content).toContain("end\n");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a workspace command exceeds its timeout,
    When the bash tool runs it,
    Then it stops the command and reports the timeout`, async () => {
    // Given
    const workspace = await createWorkspace();

    try {
      // When
      const result = await executeBash(
        workspace,
        `node -e "setTimeout(() => {}, 1000)"`,
        { timeoutMs: 50 },
      );

      // Then
      expect(result.content).toContain("Command timed out after 50ms");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a workspace command backgrounds a child with inherited output,
    When the foreground shell exits before the timeout,
    Then the bash tool reports completion without a false timeout`, async () => {
    // Given
    const workspace = await createWorkspace();
    const startedAt = Date.now();

    try {
      // When
      const result = await executeBash(
        workspace,
        "echo hi; (sleep 3) & echo done",
        { timeoutMs: 1_000 },
      );

      // Then
      expect(Date.now() - startedAt).toBeLessThan(2_500);
      expect(result.content).not.toContain("Command timed out");
      expect(result.content).toContain("Exit code: 0");
      expect(result.content).toContain("stdout:\nhi\ndone\n");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a workspace command produces no output,
    When the bash tool runs it,
    Then it returns a successful empty-output result`, async () => {
    // Given
    const workspace = await createWorkspace();

    try {
      // When
      const result = await executeBash(workspace, `node -e ""`);

      // Then
      expect(result.content).toBe("Exit code: 0\n\n(no output)");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a workspace command terminates from a signal,
    When the bash tool reports the result,
    Then it includes the terminating signal`, async () => {
    // Given
    const workspace = await createWorkspace();

    try {
      // When
      const result = await executeBash(workspace, "kill -TERM $$");

      // Then
      expect(result.content).toContain("Exit code: unknown");
      expect(result.content).toContain("Signal: SIGTERM");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an invalid timeout,
    When the bash tool validates the request,
    Then it rejects with a recovery hint suggesting a valid range`, async () => {
    // Given
    const workspace = await createWorkspace();

    try {
      // When
      const error = await expectKeelError(() =>
        executeBash(workspace, `node -e ""`, { timeoutMs: 0 }),
      );

      // Then
      expect(error.code).toBe("tool_invalid_bash_timeout");
      expect(error.message).toBe(
        "bash failed: timeout must be an integer between 1 and 60000ms",
      );
      expect(error.recovery).toBeDefined();
      expect(error.recovery).toContain("1");
      expect(error.recovery).toContain("60000");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a request is already aborted,
    When the bash tool receives it,
    Then it rejects with a recovery hint indicating the task was cancelled`, async () => {
    // Given
    const workspace = await createWorkspace();
    const controller = new AbortController();
    controller.abort();

    try {
      // When
      const error = await expectKeelError(() =>
        executeBash(workspace, `node -e ""`, { signal: controller.signal }),
      );

      // Then
      expect(error.code).toBe("tool_aborted");
      expect(error.message).toBe("bash failed: command aborted");
      expect(error.recovery).toBeDefined();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a running request is aborted,
    When the bash tool receives the abort signal,
    Then it stops the command and rejects with a recovery hint`, async () => {
    // Given
    const workspace = await createWorkspace();
    const controller = new AbortController();

    try {
      // When
      const pending = executeBash(
        workspace,
        `node -e "setTimeout(() => {}, 1000)"`,
        { signal: controller.signal },
      );
      controller.abort();
      const error = await expectKeelError(() => pending);

      // Then
      expect(error.code).toBe("tool_aborted");
      expect(error.message).toBe("bash failed: command aborted");
      expect(error.recovery).toBeDefined();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the workspace directory cannot be opened,
    When the bash tool starts the process,
    Then it returns an unavailable-tool error with a recovery hint`, async () => {
    // Given
    const workspace = await createWorkspace();
    const missingWorkspace = join(workspace, "missing");

    try {
      // When
      const error = await expectKeelError(() =>
        executeBash(missingWorkspace, `node -e ""`),
      );

      // Then
      expect(error.code).toBe("tool_unavailable");
      expect(error.message).toContain("bash failed: could not start shell:");
      expect(error.recovery).toBeDefined();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an empty command,
    When the bash tool validates the request,
    Then it rejects the command before starting a process`, async () => {
    // Given
    const workspace = await createWorkspace();

    try {
      // When
      const error = await expectKeelError(() => executeBash(workspace, ""));

      // Then
      expect(error.code).toBe("tool_empty_command");
      expect(error.message).toBe("bash failed: command is empty");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
