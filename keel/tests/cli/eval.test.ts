import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { runCli } from "../../src/testing/cli-harness.ts";

const runReportSchema = z.object({
  schemaVersion: z.literal(1),
  provider: z.string(),
  model: z.string(),
  turns: z.number().int().positive(),
  stopReason: z.string(),
  usage: z.object({
    inputTokens: z.number(),
    cachedInputTokens: z.number(),
    uncachedInputTokens: z.number(),
    outputTokens: z.number(),
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
        turns: 2,
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
