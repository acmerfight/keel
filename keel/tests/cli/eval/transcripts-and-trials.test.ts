import { describe, expect, test } from "vitest";
import {
  createEvalDir,
  createTask,
  FIX_NOTE_TASK,
  join,
  readFile,
  readResultLines,
  rm,
  runCli,
} from "./fixtures.ts";

describe("CLI Eval", () => {
  test(`Given user asks eval to keep trial transcripts,
    When user runs keel eval,
    Then each trial result links to a readable provider-visible transcript`, async () => {
    // Given
    const { root, suiteDir, outFile } = await createEvalDir();
    const transcriptDir = join(root, "transcripts");
    await createTask(suiteDir, "fix-note", FIX_NOTE_TASK);

    try {
      // When
      const result = await runCli(
        [
          "eval",
          "--suite",
          suiteDir,
          "--out",
          outFile,
          "--transcript-dir",
          transcriptDir,
        ],
        { cwd: root, env: { KEEL_PROVIDER: "fake" }, timeoutMs: 60_000 },
      );

      // Then
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("fix-note: 1/1 pass");

      const lines = await readResultLines(outFile);
      const transcriptPath = lines[0]?.transcriptPath;
      expect(transcriptPath).toContain("fix-note-");
      expect(transcriptPath).toContain("-trial-1");

      const records = (await readFile(transcriptPath ?? "", "utf8"))
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(records[0]).toMatchObject({
        schemaVersion: 2,
        type: "transcript",
        provider: "fake",
        model: "fake",
        systemPrompt: expect.stringContaining("You are keel"),
      });
      expect(records).toContainEqual(
        expect.objectContaining({
          type: "message",
          message: expect.objectContaining({
            role: "user",
            content: FIX_NOTE_TASK.prompt,
          }),
        }),
      );
      expect(records).toContainEqual(
        expect.objectContaining({
          type: "message",
          message: expect.objectContaining({
            role: "assistant",
            toolCalls: expect.any(Array),
          }),
        }),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test(`Given agent behavior varies between runs,
    When user asks for multiple trials per task,
    Then every trial is recorded as its own result line`, async () => {
    // Given
    const { root, suiteDir, outFile } = await createEvalDir();
    await createTask(suiteDir, "fix-note", FIX_NOTE_TASK);

    try {
      // When
      const result = await runCli(
        ["eval", "--suite", suiteDir, "--out", outFile, "--trials", "2"],
        { cwd: root, env: { KEEL_PROVIDER: "fake" }, timeoutMs: 90_000 },
      );

      // Then
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("fix-note: 2/2 pass");

      const lines = await readResultLines(outFile);
      expect(lines.map((line) => line.trial)).toEqual([1, 2]);
      expect(lines.every((line) => line.pass)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  test(`Given a suite with several tasks,
    When user limits the run to one task,
    Then only that task's trials are executed`, async () => {
    // Given
    const { root, suiteDir, outFile } = await createEvalDir();
    await createTask(suiteDir, "fix-note", FIX_NOTE_TASK);
    await createTask(suiteDir, "other-task", FIX_NOTE_TASK);

    try {
      // When
      const result = await runCli(
        ["eval", "--suite", suiteDir, "--out", outFile, "--task", "fix-note"],
        { cwd: root, env: { KEEL_PROVIDER: "fake" }, timeoutMs: 60_000 },
      );

      // Then
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("fix-note: 1/1 pass");
      expect(result.stdout).not.toContain("other-task");

      const lines = await readResultLines(outFile);
      expect(lines.map((line) => line.taskId)).toEqual(["fix-note"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
