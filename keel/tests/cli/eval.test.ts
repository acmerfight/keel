import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { runCli } from "../../src/testing/cli-harness.ts";
import {
  evalResultLine as resultLine,
  evalRunReport as runReport,
  writeEvalResultFile as writeResultFile,
} from "../../src/testing/eval-fixtures.ts";

const runReportSchema = z.object({
  schemaVersion: z.literal(1),
  provider: z.string(),
  model: z.string(),
  turns: z.number().int().positive(),
  stopReason: z.string(),
  usage: z.object({
    inputTokens: z.number().int().nonnegative(),
    cachedInputTokens: z.number().int().nonnegative(),
    uncachedInputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
  }),
  durationMs: z.number().nonnegative(),
  costUsd: z.number(),
});

const resultLineSchema = z.object({
  schemaVersion: z.literal(1),
  timestamp: z.string(),
  keelVersion: z.string(),
  taskId: z.string(),
  trial: z.number().int().positive(),
  pass: z.boolean(),
  outcome: z.enum(["verified", "verify_failed", "timeout", "crashed"]),
  wallMs: z.number().nonnegative(),
  report: runReportSchema.optional(),
  transcriptPath: z.string().optional(),
});

interface TaskFixture {
  readonly prompt: string;
  readonly files?: Record<string, string>;
  readonly verify: string;
  readonly solution?: string;
  readonly timeoutMs?: number;
  readonly scriptTimeoutMs?: number;
}

async function createTask(
  suiteDir: string,
  id: string,
  fixture: TaskFixture,
): Promise<void> {
  const taskDir = join(suiteDir, id);
  await mkdir(join(taskDir, "workspace"), { recursive: true });
  await writeFile(
    join(taskDir, "task.json"),
    JSON.stringify({
      prompt: fixture.prompt,
      ...(fixture.timeoutMs !== undefined
        ? { timeoutMs: fixture.timeoutMs }
        : {}),
      ...(fixture.scriptTimeoutMs !== undefined
        ? { scriptTimeoutMs: fixture.scriptTimeoutMs }
        : {}),
    }),
    "utf8",
  );
  for (const [name, content] of Object.entries(fixture.files ?? {})) {
    await writeFile(join(taskDir, "workspace", name), content, "utf8");
  }
  await writeFile(join(taskDir, "verify.sh"), fixture.verify, "utf8");
  await writeFile(
    join(taskDir, "solution.sh"),
    fixture.solution ?? "exit 1\n",
    "utf8",
  );
}

async function createEvalDir(): Promise<{
  readonly root: string;
  readonly suiteDir: string;
  readonly outFile: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "keel-eval-"));
  const suiteDir = join(root, "tasks");
  await mkdir(suiteDir, { recursive: true });
  return { root, suiteDir, outFile: join(root, "results.jsonl") };
}

async function readResultLines(
  outFile: string,
): Promise<readonly z.infer<typeof resultLineSchema>[]> {
  const raw = await readFile(outFile, "utf8");
  return raw
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => resultLineSchema.parse(JSON.parse(line)));
}

const FIX_NOTE_TASK: TaskFixture = {
  prompt: "replace old with new in note.txt",
  files: { "note.txt": "hello old world\n" },
  verify: 'grep -q "hello new world" note.txt\n',
  solution: "printf 'hello new world\\n' > note.txt\n",
};

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
        provider: "fake",
        model: "fake",
        turns: 3,
        stopReason: "completed",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test(`Given two eval result files where the new run regresses,
    When user compares the eval results,
    Then the CLI reports score and efficiency deltas with regression transcripts`, async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "keel-eval-compare-"));
    const baseFile = join(root, "base.jsonl");
    const headFile = join(root, "head.jsonl");

    await writeResultFile(baseFile, [
      resultLine({
        taskId: "edit-note",
        trial: 1,
        pass: true,
        report: runReport({ turns: 3, inputTokens: 100, outputTokens: 20 }),
        wallMs: 1000,
        transcriptPath: "/tmp/base/edit-note-1.jsonl",
      }),
      resultLine({
        taskId: "edit-note",
        trial: 2,
        pass: true,
        report: runReport({ turns: 3, inputTokens: 100, outputTokens: 20 }),
        wallMs: 1000,
        transcriptPath: "/tmp/base/edit-note-2.jsonl",
      }),
      resultLine({
        taskId: "stable-task",
        trial: 1,
        pass: true,
        report: runReport({
          turns: 2,
          inputTokens: 50,
          outputTokens: 10,
          costUsd: 0.0005,
        }),
        wallMs: 500,
      }),
      resultLine({
        taskId: "harness-task",
        trial: 1,
        pass: true,
        report: runReport({
          turns: 2,
          inputTokens: 60,
          outputTokens: 10,
          costUsd: 0.0006,
        }),
        wallMs: 700,
      }),
    ]);
    await writeResultFile(headFile, [
      resultLine({
        taskId: "edit-note",
        trial: 1,
        pass: true,
        report: runReport({
          turns: 4,
          inputTokens: 150,
          outputTokens: 30,
          costUsd: 0.002,
        }),
        wallMs: 1200,
        transcriptPath: "/tmp/head/edit-note-1.jsonl",
      }),
      resultLine({
        taskId: "edit-note",
        trial: 2,
        pass: false,
        report: runReport({
          turns: 4,
          inputTokens: 150,
          outputTokens: 30,
          costUsd: 0.002,
        }),
        wallMs: 1200,
        transcriptPath: "/tmp/head/edit-note-2.jsonl",
      }),
      resultLine({
        taskId: "stable-task",
        trial: 1,
        pass: true,
        report: runReport({
          turns: 3,
          inputTokens: 80,
          outputTokens: 15,
          costUsd: 0.0009,
        }),
        wallMs: 800,
      }),
      resultLine({
        taskId: "harness-task",
        trial: 1,
        pass: false,
        outcome: "timeout",
        wallMs: 5000,
        transcriptPath: "/tmp/head/harness-task-1.jsonl",
      }),
    ]);

    try {
      // When
      const result = await runCli(
        ["eval", "compare", "--base", baseFile, "--head", headFile],
        {
          cwd: root,
          env: { KEEL_PROVIDER: "unknown" },
          timeoutMs: 60_000,
        },
      );

      // Then
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("Eval comparison:");
      expect(result.stdout).toContain(`base: ${baseFile}`);
      expect(result.stdout).toContain(`head: ${headFile}`);
      expect(result.stdout).toContain("task: edit-note");
      expect(result.stdout).toContain("status: REGRESSION");
      expect(result.stdout).toContain(
        "pass: 2/2 (100.0%) -> 1/2 (50.0%) (-50.0pp)",
      );
      expect(result.stdout).toContain("turns avg: 3.0 -> 4.0 (+1.0)");
      expect(result.stdout).toContain(
        "input tokens avg: 100.0 -> 150.0 (+50.0)",
      );
      expect(result.stdout).toContain(
        "output tokens avg: 20.0 -> 30.0 (+10.0)",
      );
      expect(result.stdout).toContain(
        "cost avg: $0.001000 -> $0.002000 (+$0.001000)",
      );
      expect(result.stdout).toContain("wall avg: 1000ms -> 1200ms (+200ms)");
      expect(result.stdout).toContain("regression transcripts:");
      expect(result.stdout).toContain("/tmp/head/edit-note-2.jsonl");
      expect(result.stdout).toContain("task: stable-task");
      expect(result.stdout).toContain("status: EFFICIENCY REGRESSION");
      expect(result.stdout).toContain("task: harness-task");
      expect(result.stdout).toContain("status: HARNESS FAILURE");
      expect(result.stdout).toContain("head harness failures: 1");
      expect(result.stdout).toContain("/tmp/head/harness-task-1.jsonl");
      expect(result.stdout).toContain(
        "suite pass: 4/4 (100.0%) -> 2/4 (50.0%) (-50.0pp)",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test(`Given one eval result file has invalid JSONL,
    When user compares the eval results,
    Then the CLI exits with an error naming the bad line`, async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "keel-eval-compare-invalid-"));
    const baseFile = join(root, "base.jsonl");
    const headFile = join(root, "head.jsonl");
    await writeFile(baseFile, "not-json\n", "utf8");
    await writeResultFile(headFile, [
      resultLine({
        taskId: "edit-note",
        trial: 1,
        pass: true,
        report: runReport(),
      }),
    ]);

    try {
      // When
      const result = await runCli(
        ["eval", "compare", "--base", baseFile, "--head", headFile],
        { cwd: root, env: { KEEL_PROVIDER: "unknown" } },
      );

      // Then
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(baseFile);
      expect(result.stderr).toContain("line 1 is not valid JSON");
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
        provider: "fake",
        model: "fake",
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
        schemaVersion: 1,
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

  test(`Given every task ships a reference solution,
    When user checks the suite,
    Then verifiers that accept their reference solution are reported ok without spending tokens`, async () => {
    // Given
    const { root, suiteDir, outFile } = await createEvalDir();
    await createTask(suiteDir, "fix-note", FIX_NOTE_TASK);

    try {
      // When — no provider configured: --check must not need one
      const result = await runCli(
        ["eval", "--suite", suiteDir, "--out", outFile, "--check"],
        {
          cwd: root,
          env: { KEEL_PROVIDER: "deepseek", DEEPSEEK_API_KEY: "" },
          timeoutMs: 60_000,
        },
      );

      // Then
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("fix-note: verifier ok");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test(`Given a task whose verifier rejects its own reference solution,
    When user checks the suite,
    Then the broken task is named and the check fails`, async () => {
    // Given
    const { root, suiteDir, outFile } = await createEvalDir();
    await createTask(suiteDir, "broken-task", {
      ...FIX_NOTE_TASK,
      verify: "exit 1\n",
    });

    try {
      // When
      const result = await runCli(
        ["eval", "--suite", suiteDir, "--out", outFile, "--check"],
        { cwd: root, env: { KEEL_PROVIDER: "fake" }, timeoutMs: 60_000 },
      );

      // Then
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).toContain("broken-task: verifier BROKEN");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test(`Given the suite directory does not exist,
    When user runs keel eval,
    Then the CLI exits with an error naming the missing directory`, async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "keel-eval-missing-"));

    try {
      // When
      const result = await runCli(
        ["eval", "--suite", join(root, "nope"), "--out", join(root, "o.jsonl")],
        { cwd: root, env: { KEEL_PROVIDER: "fake" } },
      );

      // Then
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("nope");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test(`Given a task definition that is not valid,
    When user runs keel eval,
    Then the CLI exits with an error naming the invalid task`, async () => {
    // Given
    const { root, suiteDir, outFile } = await createEvalDir();
    const taskDir = join(suiteDir, "bad-task");
    await mkdir(taskDir, { recursive: true });
    await writeFile(join(taskDir, "task.json"), '{"prompt":""}', "utf8");

    try {
      // When
      const result = await runCli(
        ["eval", "--suite", suiteDir, "--out", outFile],
        { cwd: root, env: { KEEL_PROVIDER: "fake" } },
      );

      // Then
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("bad-task");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test(`Given a task is missing its workspace directory,
    When user runs keel eval,
    Then the CLI exits with an error naming the invalid task`, async () => {
    // Given
    const { root, suiteDir, outFile } = await createEvalDir();
    const taskDir = join(suiteDir, "missing-workspace");
    await mkdir(taskDir, { recursive: true });
    await writeFile(
      join(taskDir, "task.json"),
      JSON.stringify({ prompt: "do the task" }),
      "utf8",
    );
    await writeFile(join(taskDir, "verify.sh"), "exit 0\n", "utf8");
    await writeFile(join(taskDir, "solution.sh"), "exit 0\n", "utf8");

    try {
      // When
      const result = await runCli(
        ["eval", "--suite", suiteDir, "--out", outFile],
        { cwd: root, env: { KEEL_PROVIDER: "fake" } },
      );

      // Then
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("missing-workspace");
      expect(result.stderr).toContain("workspace");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
