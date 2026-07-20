import { describe, expect, test } from "vitest";
import {
  createEvalDir,
  createTask,
  FIX_NOTE_TASK,
  join,
  mkdir,
  mkdtemp,
  rm,
  runCli,
  tmpdir,
  writeFile,
} from "./fixtures.ts";

describe("CLI Eval", () => {
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
    await writeFile(
      join(taskDir, "task.json"),
      '{"kind":"standard","prompt":""}',
      "utf8",
    );

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
      JSON.stringify({ kind: "standard", prompt: "do the task" }),
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
