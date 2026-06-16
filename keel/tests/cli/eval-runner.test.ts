import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { runEvalCommand } from "../../src/eval/run.ts";

const resultLineSchema = z.object({
  schemaVersion: z.literal(1),
  taskId: z.string(),
  trial: z.number().int().positive(),
  pass: z.boolean(),
  outcome: z.enum(["verified", "verify_failed", "timeout", "crashed"]),
});

interface TaskFixture {
  readonly prompt: string;
  readonly files?: Record<string, string>;
  readonly verify: string;
  readonly solution?: string;
  readonly timeoutMs?: number;
  readonly scriptTimeoutMs?: number;
  readonly allowBash?: boolean;
  readonly maxCostUsd?: number;
}

async function createEvalDir(): Promise<{
  readonly root: string;
  readonly suiteDir: string;
  readonly outFile: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "keel-eval-runner-"));
  const suiteDir = join(root, "tasks");
  await mkdir(suiteDir, { recursive: true });
  return { root, suiteDir, outFile: join(root, "results.jsonl") };
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
      ...(fixture.allowBash !== undefined
        ? { allowBash: fixture.allowBash }
        : {}),
      ...(fixture.maxCostUsd !== undefined
        ? { maxCostUsd: fixture.maxCostUsd }
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

async function readResultLines(
  outFile: string,
): Promise<readonly z.infer<typeof resultLineSchema>[]> {
  const raw = await readFile(outFile, "utf8");
  return raw
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => resultLineSchema.parse(JSON.parse(line)));
}

const CLI_ENTRY = join(process.cwd(), "src/cli/index.ts");
const KEEL_PROVIDER_ENV = "KEEL_PROVIDER";
const REPORT_CONTENT_ENV = "REPORT_CONTENT";
const FIX_NOTE_TASK: TaskFixture = {
  prompt: "replace old with new in note.txt",
  files: { "note.txt": "hello old world\n" },
  verify: 'grep -q "hello new world" note.txt\n',
  solution: "printf 'hello new world\\n' > note.txt\n",
};
const VALID_REPORT = {
  schemaVersion: 1,
  provider: "fake",
  model: "fake",
  turns: 1,
  stopReason: "completed",
  usage: {
    inputTokens: 1,
    cachedInputTokens: 0,
    uncachedInputTokens: 1,
    outputTokens: 1,
  },
  durationMs: 1,
  costUsd: 0,
};

let previousKeelProvider: string | undefined;

beforeEach(() => {
  previousKeelProvider = process.env[KEEL_PROVIDER_ENV];
  process.env[KEEL_PROVIDER_ENV] = "fake";
});

afterEach(() => {
  if (previousKeelProvider === undefined) {
    delete process.env[KEEL_PROVIDER_ENV];
    return;
  }
  process.env[KEEL_PROVIDER_ENV] = previousKeelProvider;
});

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

  test.each([
    {
      name: "invalid JSON",
      reportContent: "{not-json",
    },
    {
      name: "wrong schema",
      reportContent: JSON.stringify({ schemaVersion: 1 }),
    },
    {
      name: "negative usage",
      reportContent: JSON.stringify({
        ...VALID_REPORT,
        usage: { ...VALID_REPORT.usage, outputTokens: -1 },
      }),
    },
    {
      name: "fractional usage",
      reportContent: JSON.stringify({
        ...VALID_REPORT,
        usage: { ...VALID_REPORT.usage, inputTokens: 1.5 },
      }),
    },
  ])(`Given the agent writes a $name report,
    When the eval runner reads the report,
    Then it records a crashed result`, async ({ reportContent }) => {
    // Given
    const { root, suiteDir, outFile } = await createEvalDir();
    await createTask(suiteDir, "bad-report", FIX_NOTE_TASK);
    const cliEntry = join(root, "bad-report-cli.js");
    await writeFile(
      cliEntry,
      [
        "import { writeFileSync } from 'node:fs';",
        "const reportIndex = process.argv.indexOf('--report');",
        "writeFileSync(process.argv[reportIndex + 1], process.env.REPORT_CONTENT ?? '', 'utf8');",
      ].join("\n"),
      "utf8",
    );
    const previousReportContent = process.env[REPORT_CONTENT_ENV];
    process.env[REPORT_CONTENT_ENV] = reportContent;

    try {
      // When
      const exitCode = await runEvalCommand({
        suiteDir,
        outFile,
        trials: 1,
        check: false,
        cliEntry,
      });

      // Then
      expect(exitCode).toBe(1);
      expect(await readResultLines(outFile)).toMatchObject([
        { taskId: "bad-report", pass: false, outcome: "crashed" },
      ]);
    } finally {
      if (previousReportContent === undefined) {
        delete process.env[REPORT_CONTENT_ENV];
      } else {
        process.env[REPORT_CONTENT_ENV] = previousReportContent;
      }
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

  test(`Given each task has a reference solution,
    When the eval runner checks the suite,
    Then it returns success only when verifiers accept their solutions`, async () => {
    // Given
    const { root, suiteDir, outFile } = await createEvalDir();
    await createTask(suiteDir, "fix-note", FIX_NOTE_TASK);

    try {
      // When
      const exitCode = await runEvalCommand({
        suiteDir,
        outFile,
        trials: 1,
        check: true,
        cliEntry: CLI_ENTRY,
      });

      // Then
      expect(exitCode).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test(`Given a reference solution exits with failure,
    When the eval runner checks the suite,
    Then it returns a broken verifier result`, async () => {
    // Given
    const { root, suiteDir, outFile } = await createEvalDir();
    await createTask(suiteDir, "failing-solution", {
      ...FIX_NOTE_TASK,
      solution: "exit 1\n",
    });

    try {
      // When
      const exitCode = await runEvalCommand({
        suiteDir,
        outFile,
        trials: 1,
        check: true,
        cliEntry: CLI_ENTRY,
      });

      // Then
      expect(exitCode).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test(`Given a reference solution is rejected,
    When the eval runner checks the suite,
    Then it returns a broken verifier result`, async () => {
    // Given
    const { root, suiteDir, outFile } = await createEvalDir();
    await createTask(suiteDir, "broken-task", {
      ...FIX_NOTE_TASK,
      solution: "exit 0\n",
      verify: "exit 1\n",
    });

    try {
      // When
      const exitCode = await runEvalCommand({
        suiteDir,
        outFile,
        trials: 1,
        check: true,
        cliEntry: CLI_ENTRY,
      });

      // Then
      expect(exitCode).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test(`Given the requested task does not exist,
    When the eval runner selects tasks,
    Then it returns a configuration failure`, async () => {
    // Given
    const { root, suiteDir, outFile } = await createEvalDir();
    await createTask(suiteDir, "fix-note", FIX_NOTE_TASK);

    try {
      // When
      const exitCode = await runEvalCommand({
        suiteDir,
        outFile,
        trials: 1,
        taskId: "missing-task",
        check: false,
        cliEntry: CLI_ENTRY,
      });

      // Then
      expect(exitCode).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test(`Given the suite path is missing,
    When the eval runner loads tasks,
    Then it returns a configuration failure`, async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "keel-eval-missing-"));

    try {
      // When
      const exitCode = await runEvalCommand({
        suiteDir: join(root, "missing-suite"),
        outFile: join(root, "results.jsonl"),
        trials: 1,
        check: false,
        cliEntry: CLI_ENTRY,
      });

      // Then
      expect(exitCode).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test(`Given the suite contains no task directories,
    When the eval runner loads tasks,
    Then it returns a configuration failure`, async () => {
    // Given
    const { root, suiteDir, outFile } = await createEvalDir();

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
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test(`Given a task definition is invalid,
    When the eval runner loads the suite,
    Then it returns a configuration failure`, async () => {
    // Given
    const { root, suiteDir, outFile } = await createEvalDir();
    const taskDir = join(suiteDir, "bad-task");
    await mkdir(taskDir, { recursive: true });
    await writeFile(join(taskDir, "task.json"), '{"prompt":""}', "utf8");

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
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test(`Given a task definition contains malformed JSON,
    When the eval runner loads the suite,
    Then it reports the parser message without duplicating the error name`, async () => {
    // Given
    const { root, suiteDir, outFile } = await createEvalDir();
    const taskDir = join(suiteDir, "malformed-task");
    await mkdir(taskDir, { recursive: true });
    await writeFile(join(taskDir, "task.json"), "{not-json", "utf8");
    let stderr = "";
    const writeStderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        stderr += chunk.toString();
        return true;
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
      expect(stderr).toContain(
        'Error: eval task "malformed-task" has unreadable task.json:',
      );
      expect(stderr).not.toContain("SyntaxError:");
    } finally {
      writeStderr.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  test(`Given a task definition cannot be read as a file,
    When the eval runner loads the suite,
    Then it returns a configuration failure`, async () => {
    // Given
    const { root, suiteDir, outFile } = await createEvalDir();
    const taskDir = join(suiteDir, "unreadable-task");
    await mkdir(join(taskDir, "task.json"), { recursive: true });

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
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test(`Given a task is missing task.json,
    When the eval runner loads the suite,
    Then it returns a configuration failure`, async () => {
    // Given
    const { root, suiteDir, outFile } = await createEvalDir();
    await mkdir(join(suiteDir, "missing-config"), { recursive: true });

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
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test.each([
    {
      id: "missing-workspace",
      files: {
        "task.json": JSON.stringify({ prompt: "do the task" }),
        "verify.sh": "exit 0\n",
        "solution.sh": "exit 0\n",
      },
    },
    {
      id: "missing-verify",
      files: {
        "task.json": JSON.stringify({ prompt: "do the task" }),
        "solution.sh": "exit 0\n",
      },
    },
    {
      id: "missing-solution",
      files: {
        "task.json": JSON.stringify({ prompt: "do the task" }),
        "verify.sh": "exit 0\n",
      },
    },
  ])(`Given task $id is missing a required file or directory,
    When the eval runner loads the suite,
    Then it returns a configuration failure`, async ({ id, files }) => {
    // Given
    const { root, suiteDir, outFile } = await createEvalDir();
    const taskDir = join(suiteDir, id);
    await mkdir(taskDir, { recursive: true });
    if (id !== "missing-workspace") {
      await mkdir(join(taskDir, "workspace"), { recursive: true });
    }
    for (const [name, content] of Object.entries(files)) {
      await writeFile(join(taskDir, name), content, "utf8");
    }

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
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
