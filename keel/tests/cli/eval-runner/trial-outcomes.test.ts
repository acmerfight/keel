import { describe, expect, test } from "vitest";
import {
  CLI_ENTRY,
  createEvalDir,
  createTask,
  FIX_NOTE_TASK,
  KEEL_PROVIDER_ENV,
  readResultLines,
  rm,
  runEvalCommand,
} from "./fixtures.ts";

describe("Eval Runner", () => {
  test(`Given a solvable task,
    When the eval runner executes one trial,
    Then it records a verified result line`, async () => {
    // Given
    const { root, suiteDir, outFile } = await createEvalDir();
    await createTask(suiteDir, "fix-note", FIX_NOTE_TASK);

    try {
      // When
      const exitCode = await runEvalCommand({
        suiteDir,
        outFile,
        trials: 1,
        check: false,
        cliEntry: CLI_ENTRY,
      });

      // Then
      expect(exitCode).toBe(0);
      expect(await readResultLines(outFile)).toMatchObject([
        { taskId: "fix-note", trial: 1, pass: true, outcome: "verified" },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test(`Given a verifier rejects the agent result,
    When the eval runner executes the task,
    Then it records a verify failure`, async () => {
    // Given
    const { root, suiteDir, outFile } = await createEvalDir();
    await createTask(suiteDir, "rejects-work", {
      ...FIX_NOTE_TASK,
      verify: "exit 1\n",
    });

    try {
      // When
      const exitCode = await runEvalCommand({
        suiteDir,
        outFile,
        trials: 1,
        check: false,
        cliEntry: CLI_ENTRY,
      });

      // Then
      expect(exitCode).toBe(1);
      expect(await readResultLines(outFile)).toMatchObject([
        { taskId: "rejects-work", pass: false, outcome: "verify_failed" },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test(`Given one task is selected from a suite,
    When the eval runner executes multiple trials,
    Then only the selected task is recorded for each trial`, async () => {
    // Given
    const { root, suiteDir, outFile } = await createEvalDir();
    await createTask(suiteDir, "fix-note", FIX_NOTE_TASK);
    await createTask(suiteDir, "other-task", FIX_NOTE_TASK);

    try {
      // When
      const exitCode = await runEvalCommand({
        suiteDir,
        outFile,
        trials: 2,
        taskId: "fix-note",
        check: false,
        cliEntry: CLI_ENTRY,
      });

      // Then
      expect(exitCode).toBe(0);
      const lines = await readResultLines(outFile);
      expect(lines.map((line) => line.taskId)).toEqual([
        "fix-note",
        "fix-note",
      ]);
      expect(lines.map((line) => line.trial)).toEqual([1, 2]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test(`Given the agent exceeds the task timeout,
    When the eval runner executes the task,
    Then it records a timeout result`, async () => {
    // Given
    const { root, suiteDir, outFile } = await createEvalDir();
    await createTask(suiteDir, "too-slow", { ...FIX_NOTE_TASK, timeoutMs: 1 });

    try {
      // When
      const exitCode = await runEvalCommand({
        suiteDir,
        outFile,
        trials: 1,
        check: false,
        cliEntry: CLI_ENTRY,
      });

      // Then
      expect(exitCode).toBe(1);
      expect(await readResultLines(outFile)).toMatchObject([
        { taskId: "too-slow", pass: false, outcome: "timeout" },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test(`Given a verifier exceeds its script timeout,
    When the eval runner executes the task,
    Then it records a timeout after the agent report is available`, async () => {
    // Given
    const { root, suiteDir, outFile } = await createEvalDir();
    await createTask(suiteDir, "slow-verifier", {
      ...FIX_NOTE_TASK,
      verify: "sleep 10\n",
      scriptTimeoutMs: 1,
    });

    try {
      // When
      const exitCode = await runEvalCommand({
        suiteDir,
        outFile,
        trials: 1,
        check: false,
        cliEntry: CLI_ENTRY,
      });

      // Then
      expect(exitCode).toBe(1);
      expect(await readResultLines(outFile)).toMatchObject([
        { taskId: "slow-verifier", pass: false, outcome: "timeout" },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test(`Given the agent process exits before writing a report,
    When the eval runner executes the task,
    Then it records a crashed result`, async () => {
    // Given
    const { root, suiteDir, outFile } = await createEvalDir();
    await createTask(suiteDir, "provider-crash", FIX_NOTE_TASK);
    process.env[KEEL_PROVIDER_ENV] = "unknown";

    try {
      // When
      const exitCode = await runEvalCommand({
        suiteDir,
        outFile,
        trials: 1,
        check: false,
        cliEntry: CLI_ENTRY,
      });

      // Then
      expect(exitCode).toBe(1);
      expect(await readResultLines(outFile)).toMatchObject([
        { taskId: "provider-crash", pass: false, outcome: "crashed" },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test(`Given a task enables bash and a max cost budget,
    When the eval runner executes the task,
    Then it passes those task options into the CLI run`, async () => {
    // Given
    const { root, suiteDir, outFile } = await createEvalDir();
    await createTask(suiteDir, "task-options", {
      ...FIX_NOTE_TASK,
      solution: "printf 'hello new world\\n' > note.txt\n",
      verify: 'grep -q "hello new world" note.txt\n',
      maxCostUsd: 1,
      allowBash: true,
    });

    try {
      // When
      const exitCode = await runEvalCommand({
        suiteDir,
        outFile,
        trials: 1,
        check: false,
        cliEntry: CLI_ENTRY,
      });

      // Then
      expect(exitCode).toBe(0);
      expect(await readResultLines(outFile)).toMatchObject([
        { taskId: "task-options", pass: true, outcome: "verified" },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
