import { describe, expect, test, vi } from "vitest";
import {
  CLI_ENTRY,
  createEvalDir,
  createMemoryPairTask,
  createTask,
  FIX_NOTE_TASK,
  join,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  runEvalCommand,
  tmpdir,
  writeFile,
} from "./fixtures.ts";

const PATH_ENV = "PATH";
const KEEL_HOME_ENV = "KEEL_HOME";

describe("Eval Runner", () => {
  test(`Given Git cannot initialize a memory-pair workspace,
    When the eval runner prepares the pair,
    Then it fails setup before recording partial results`, async () => {
    // Given
    const { root, suiteDir, outFile } = await createEvalDir();
    await createMemoryPairTask(suiteDir, "git-setup-fails", {
      prompt: "use memory",
      verify: "exit 0\n",
      solution: "exit 0\n",
      timeoutMs: 10_000,
      scriptTimeoutMs: 10_000,
      allowBash: false,
      maxCostUsd: 0.01,
      memory: "A project fact.",
    });
    const previousPath = process.env[PATH_ENV];
    const previousHome = process.env[KEEL_HOME_ENV];
    process.env[PATH_ENV] = "";
    process.env[KEEL_HOME_ENV] = join(root, "empty-home");
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
      expect(stderr).toContain("git init failed");
      await expect(readFile(outFile, "utf8")).resolves.toBe("");
    } finally {
      writeStderr.mockRestore();
      if (previousPath === undefined) delete process.env[PATH_ENV];
      else process.env[PATH_ENV] = previousPath;
      if (previousHome === undefined) delete process.env[KEEL_HOME_ENV];
      else process.env[KEEL_HOME_ENV] = previousHome;
      await rm(root, { recursive: true, force: true });
    }
  });

  test(`Given the public memory-add command rejects an eval seed,
    When the eval runner prepares the pair,
    Then it fails setup before recording partial results`, async () => {
    // Given
    const { root, suiteDir, outFile } = await createEvalDir();
    await createMemoryPairTask(suiteDir, "memory-setup-fails", {
      prompt: "use memory",
      verify: "exit 0\n",
      solution: "exit 0\n",
      timeoutMs: 10_000,
      scriptTimeoutMs: 10_000,
      allowBash: false,
      maxCostUsd: 0.01,
      memory: "A project fact.",
    });
    const cliEntry = join(root, "reject-memory-add.mjs");
    await writeFile(cliEntry, "process.exit(1);\n", "utf8");
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
        cliEntry,
      });

      // Then
      expect(exitCode).toBe(1);
      expect(stderr).toContain("memory add failed");
      await expect(readFile(outFile, "utf8")).resolves.toBe("");
    } finally {
      writeStderr.mockRestore();
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
    await writeFile(
      join(taskDir, "task.json"),
      '{"kind":"standard","prompt":""}',
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

  test(`Given a task definition omits its kind,
    When the eval runner loads the suite,
    Then it rejects the incomplete task shape`, async () => {
    // Given
    const { root, suiteDir, outFile } = await createEvalDir();
    const taskDir = join(suiteDir, "missing-kind");
    await mkdir(taskDir, { recursive: true });
    await writeFile(
      join(taskDir, "task.json"),
      JSON.stringify({ prompt: "do the task" }),
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
        "task.json": JSON.stringify({
          kind: "standard",
          prompt: "do the task",
        }),
        "verify.sh": "exit 0\n",
        "solution.sh": "exit 0\n",
      },
    },
    {
      id: "missing-verify",
      files: {
        "task.json": JSON.stringify({
          kind: "standard",
          prompt: "do the task",
        }),
        "solution.sh": "exit 0\n",
      },
    },
    {
      id: "missing-solution",
      files: {
        "task.json": JSON.stringify({
          kind: "standard",
          prompt: "do the task",
        }),
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
