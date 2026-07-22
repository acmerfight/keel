import { describe, expect, test } from "vitest";
import { evalResultLineSchema } from "../../../src/eval/result-schema.ts";
import {
  createEvalDir,
  createTask,
  FIX_NOTE_TASK,
  join,
  readFile,
  readResultLines,
  rm,
  runCli,
  writeFile,
  z,
} from "./fixtures.ts";

function parsePairedMemoryResult(input: unknown) {
  const result = evalResultLineSchema.parse(input);
  if (
    result.condition === "standard" ||
    result.transcriptPath === undefined ||
    result.report === undefined
  ) {
    throw new Error("expected a paired memory result with artifacts");
  }
  return {
    ...result,
    condition: result.condition,
    transcriptPath: result.transcriptPath,
    report: result.report,
  };
}

const transcriptHeaderSchema = z.object({
  schemaVersion: z.literal(1),
  type: z.literal("transcript"),
  systemPrompt: z.string(),
});

describe("CLI Eval", () => {
  test(`Given one eval task has configured project memory,
    When user runs keel eval for that task,
    Then the same trial reports memory-disabled and memory-enabled outcomes`, async () => {
    // Given
    const { root, suiteDir, outFile } = await createEvalDir();
    const taskId = "memory-release-command";
    const memory = "The release validation command is pnpm test:coverage.";
    const transcriptDir = join(root, "transcripts");
    await createTask(suiteDir, taskId, {
      prompt: "create result.json",
      verify: "test -f result.json\n",
      solution: "printf '{\"created\":true}\\n' > result.json\n",
    });
    await writeFile(
      join(suiteDir, taskId, "task.json"),
      JSON.stringify({
        kind: "memory_pair",
        prompt: "create result.json",
        timeoutMs: 60_000,
        scriptTimeoutMs: 10_000,
        allowBash: false,
        maxCostUsd: 0.05,
        memory,
      }),
      "utf8",
    );

    try {
      // When
      const result = await runCli(
        [
          "eval",
          "--task",
          taskId,
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
      expect(result.stdout).toContain(`${taskId}: disabled 1/1, enabled 1/1`);
      const lines = (await readFile(outFile, "utf8"))
        .trimEnd()
        .split("\n")
        .map((line) => parsePairedMemoryResult(JSON.parse(line)));
      expect(lines).toHaveLength(2);
      expect(lines).toMatchObject([
        {
          taskId,
          trial: 1,
          condition: "memory_disabled",
          requiredToPass: false,
          report: {
            memory: { status: "disabled", loadedIds: [], renderedBytes: 0 },
          },
        },
        {
          taskId,
          trial: 1,
          condition: "memory_enabled",
          requiredToPass: true,
          report: {
            memory: {
              status: "available",
              loadedIds: [expect.any(String)],
            },
          },
        },
      ]);
      expect(lines[1]?.report.memory.renderedBytes).toBeGreaterThan(0);
      const [disabled, enabled] = await Promise.all(
        lines.map(async (line) => {
          const firstLine = (await readFile(line.transcriptPath, "utf8")).split(
            "\n",
            1,
          )[0];
          return transcriptHeaderSchema.parse(JSON.parse(firstLine ?? ""));
        }),
      );
      expect(disabled?.systemPrompt).not.toContain(memory);
      expect(enabled?.systemPrompt).toContain(memory);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

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
        agentLoopTurns: 3,
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
