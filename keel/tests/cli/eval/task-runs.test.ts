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
  test(`Given a suite with one solvable task,
    When user runs keel eval,
    Then the task passes and a schema-versioned result line records the run metrics`, async () => {
    // Given
    const { root, suiteDir, outFile } = await createEvalDir();
    await createTask(suiteDir, "fix-note", FIX_NOTE_TASK);

    try {
      // When
      const result = await runCli(
        ["eval", "--suite", suiteDir, "--out", outFile],
        { cwd: root, env: { KEEL_PROVIDER: "fake" }, timeoutMs: 60_000 },
      );

      // Then
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("fix-note: 1/1 pass");
      expect(result.stdout).toContain("suite: 1/1 tasks pass (1/1 trials)");

      const lines = await readResultLines(outFile);
      expect(lines).toHaveLength(1);
      const line = lines[0];
      expect(line).toMatchObject({
        taskId: "fix-note",
        trial: 1,
        pass: true,
        outcome: "verified",
      });
      expect(line?.report).toMatchObject({
        modelsUsed: [{ provider: "fake", model: "fake" }],
        turns: 3,
        stopReason: "completed",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test(`Given provider env would select an invalid provider,
    When user runs keel eval with a provider override,
    Then the eval uses the selected provider for the trial`, async () => {
    // Given
    const { root, suiteDir, outFile } = await createEvalDir();
    await createTask(suiteDir, "fix-note", FIX_NOTE_TASK);

    try {
      // When
      const result = await runCli(
        [
          "eval",
          "--provider",
          "fake",
          "--model",
          "ignored",
          "--suite",
          suiteDir,
          "--out",
          outFile,
        ],
        { cwd: root, env: { KEEL_PROVIDER: "unknown" }, timeoutMs: 60_000 },
      );

      // Then
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("fix-note: 1/1 pass");

      const lines = await readResultLines(outFile);
      expect(lines[0]?.report).toMatchObject({
        modelsUsed: [{ provider: "fake", model: "fake" }],
        stopReason: "completed",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test(`Given a suite path is relative to the current directory,
    When user runs keel eval,
    Then task scripts are still resolved before trial isolation changes cwd`, async () => {
    // Given
    const { root, suiteDir, outFile } = await createEvalDir();
    await createTask(suiteDir, "fix-note", FIX_NOTE_TASK);

    try {
      // When
      const result = await runCli(
        ["eval", "--suite", "tasks", "--out", outFile],
        { cwd: root, env: { KEEL_PROVIDER: "fake" }, timeoutMs: 60_000 },
      );

      // Then
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("fix-note: 1/1 pass");

      const lines = await readResultLines(outFile);
      expect(lines[0]).toMatchObject({
        taskId: "fix-note",
        pass: true,
        outcome: "verified",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test(`Given a task whose outcome check rejects the agent's work,
    When user runs keel eval,
    Then the trial is recorded as a verify failure and the eval exits as failed`, async () => {
    // Given
    const { root, suiteDir, outFile } = await createEvalDir();
    await createTask(suiteDir, "impossible", {
      ...FIX_NOTE_TASK,
      verify: "exit 1\n",
    });

    try {
      // When
      const result = await runCli(
        ["eval", "--suite", suiteDir, "--out", outFile],
        { cwd: root, env: { KEEL_PROVIDER: "fake" }, timeoutMs: 60_000 },
      );

      // Then
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).toContain("impossible: 0/1 pass");

      const lines = await readResultLines(outFile);
      expect(lines[0]).toMatchObject({
        pass: false,
        outcome: "verify_failed",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
