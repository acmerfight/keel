import { describe, expect, test } from "vitest";
import {
  createEvalDir,
  createTask,
  FIX_NOTE_TASK,
  readResultLines,
  rm,
  runCli,
} from "./fixtures.ts";

describe("CLI Eval", () => {
  test(`Given a task that exceeds its time limit,
    When user runs keel eval,
    Then the trial is recorded as a timeout failure and the eval exits as failed`, async () => {
    // Given
    const { root, suiteDir, outFile } = await createEvalDir();
    await createTask(suiteDir, "too-slow", { ...FIX_NOTE_TASK, timeoutMs: 1 });

    try {
      // When
      const result = await runCli(
        ["eval", "--suite", suiteDir, "--out", outFile],
        { cwd: root, env: { KEEL_PROVIDER: "fake" }, timeoutMs: 60_000 },
      );

      // Then
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).toContain("too-slow: 0/1 pass");

      const lines = await readResultLines(outFile);
      expect(lines[0]).toMatchObject({ pass: false, outcome: "timeout" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test(`Given a verifier exceeds its time limit,
    When user runs keel eval,
    Then the trial is recorded as a timeout failure and the eval exits as failed`, async () => {
    // Given
    const { root, suiteDir, outFile } = await createEvalDir();
    await createTask(suiteDir, "slow-verifier", {
      ...FIX_NOTE_TASK,
      verify: "sleep 10\n",
      scriptTimeoutMs: 1,
    });

    try {
      // When
      const result = await runCli(
        ["eval", "--suite", suiteDir, "--out", outFile],
        { cwd: root, env: { KEEL_PROVIDER: "fake" }, timeoutMs: 60_000 },
      );

      // Then
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).toContain("slow-verifier: 0/1 pass");

      const lines = await readResultLines(outFile);
      expect(lines[0]).toMatchObject({ pass: false, outcome: "timeout" });
      expect(lines[0]?.report).toBeDefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test(`Given the agent process crashes before writing a run report,
    When user runs keel eval,
    Then the trial is recorded as crashed and the eval exits as failed`, async () => {
    // Given
    const { root, suiteDir, outFile } = await createEvalDir();
    await createTask(suiteDir, "provider-crash", FIX_NOTE_TASK);

    try {
      // When
      const result = await runCli(
        ["eval", "--suite", suiteDir, "--out", outFile],
        { cwd: root, env: { KEEL_PROVIDER: "unknown" }, timeoutMs: 60_000 },
      );

      // Then
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).toContain("provider-crash: 0/1 pass");

      const lines = await readResultLines(outFile);
      expect(lines[0]).toMatchObject({ pass: false, outcome: "crashed" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
