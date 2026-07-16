import { describe, expect, test, vi } from "vitest";
import {
  CLI_ENTRY,
  createEvalDir,
  createTask,
  FIX_NOTE_TASK,
  join,
  mkdir,
  mkdtemp,
  rm,
  runEvalCommand,
  tmpdir,
  writeFile,
} from "./fixtures.ts";

const VALID_TASK_CONFIG = JSON.stringify({
  kind: "standard",
  corpusVersion: "test-v1",
  prompt: "do the task",
  timeoutMs: 60_000,
  scriptTimeoutMs: 10_000,
  allowBash: false,
  maxCostUsd: 0.05,
});

describe("Eval Runner", () => {
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
    await writeFile(
      join(taskDir, "task.json"),
      JSON.stringify({
        kind: "standard",
        corpusVersion: "test-v1",
        prompt: "",
        timeoutMs: 60_000,
        scriptTimeoutMs: 10_000,
        allowBash: false,
        maxCostUsd: 0.05,
      }),
      "utf8",
    );

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
        "task.json": VALID_TASK_CONFIG,
        "verify.sh": "exit 0\n",
        "solution.sh": "exit 0\n",
      },
    },
    {
      id: "missing-verify",
      files: {
        "task.json": VALID_TASK_CONFIG,
        "solution.sh": "exit 0\n",
      },
    },
    {
      id: "missing-solution",
      files: {
        "task.json": VALID_TASK_CONFIG,
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
