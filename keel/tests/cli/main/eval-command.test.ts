import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { runCliMain } from "../../../src/cli/index.ts";
import { createRuntime } from "../../../src/testing/cli-runtime-fixtures.ts";
import { evalResultLineJson } from "../../../src/testing/eval-fixtures.ts";

describe("CLI Main - Eval Command", () => {
  test(`Given an unknown eval option,
    When the CLI main parses the eval request,
    Then it returns an eval option validation error`, async () => {
    // Given
    const fixture = createRuntime(["eval", "--wat"]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe('Error: unknown eval option "--wat"\n');
  });

  test(`Given eval compare has base and head result files,
    When the CLI main runs the compare request,
    Then it prints the comparison report`, async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "keel-cli-main-eval-compare-"));
    const baseFile = join(root, "base.jsonl");
    const headFile = join(root, "head.jsonl");
    await writeFile(
      baseFile,
      evalResultLineJson({ taskId: "same-task", trial: 1, pass: true }),
      "utf8",
    );
    await writeFile(
      headFile,
      evalResultLineJson({ taskId: "same-task", trial: 1, pass: true }),
      "utf8",
    );
    const fixture = createRuntime([
      "eval",
      "compare",
      "--base",
      baseFile,
      "--head",
      headFile,
    ]);
    let processStdout = "";
    const writeStdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        processStdout += chunk.toString();
        return true;
      });

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(0);
      expect(fixture.stdout()).toBe("");
      expect(fixture.stderr()).toBe("");
      expect(processStdout).toContain("Eval comparison:\n");
      expect(processStdout).toContain(`base: ${baseFile}\n`);
      expect(processStdout).toContain(`head: ${headFile}\n`);
      expect(processStdout).toContain("task: same-task\n");
      expect(processStdout).toContain("  status: UNCHANGED\n");
    } finally {
      writeStdout.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  test(`Given eval compare uses equals-style base and head options,
    When the CLI main parses an extra compare option,
    Then it returns a compare option validation error`, async () => {
    // Given
    const fixture = createRuntime([
      "eval",
      "compare",
      "--base=base.jsonl",
      "--head=head.jsonl",
      "--wat",
    ]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe(
      'Error: unknown eval compare option "--wat"\n',
    );
  });

  test(`Given eval compare has an empty equals-style base option,
    When the CLI main parses the compare request,
    Then it returns an option value validation error`, async () => {
    // Given
    const fixture = createRuntime(["eval", "compare", "--base="]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe("Error: --base requires a value.\n");
  });

  test(`Given eval compare has an empty equals-style head option,
    When the CLI main parses the compare request,
    Then it returns an option value validation error`, async () => {
    // Given
    const fixture = createRuntime([
      "eval",
      "compare",
      "--base",
      "base.jsonl",
      "--head=",
    ]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe("Error: --head requires a value.\n");
  });

  test(`Given eval compare has a base option without a following value,
    When the CLI main parses the compare request,
    Then it returns an option value validation error`, async () => {
    // Given
    const fixture = createRuntime(["eval", "compare", "--base"]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe("Error: --base requires a value.\n");
  });

  test(`Given eval compare has a head option without a following value,
    When the CLI main parses the compare request,
    Then it returns an option value validation error`, async () => {
    // Given
    const fixture = createRuntime([
      "eval",
      "compare",
      "--base",
      "base.jsonl",
      "--head",
    ]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe("Error: --head requires a value.\n");
  });

  test(`Given eval compare is missing the base result file,
    When the CLI main parses the eval compare request,
    Then it returns a compare option validation error`, async () => {
    // Given
    const fixture = createRuntime(["eval", "compare", "--head", "head.jsonl"]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe(
      "Error: eval compare requires --base <file>.\n",
    );
  });

  test(`Given eval compare is missing the head result file,
    When the CLI main parses the eval compare request,
    Then it returns a compare option validation error`, async () => {
    // Given
    const fixture = createRuntime(["eval", "compare", "--base", "base.jsonl"]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe(
      "Error: eval compare requires --head <file>.\n",
    );
  });

  test(`Given an eval option is missing its value,
    When the CLI main parses the eval request,
    Then it returns an option value validation error`, async () => {
    // Given
    const fixture = createRuntime(["eval", "--suite"]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe("Error: --suite requires a value.\n");
  });

  test(`Given an eval output option is missing its value,
    When the CLI main parses the eval request,
    Then it returns an option value validation error`, async () => {
    // Given
    const fixture = createRuntime(["eval", "--out"]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe("Error: --out requires a value.\n");
  });

  test(`Given an eval transcript directory option is missing its value,
    When the CLI main parses the eval request,
    Then it returns an option value validation error`, async () => {
    // Given
    const fixture = createRuntime(["eval", "--transcript-dir"]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe(
      "Error: --transcript-dir requires a value.\n",
    );
  });

  test(`Given an eval transcript directory option uses an empty equals value,
    When the CLI main parses the eval request,
    Then it returns an option value validation error`, async () => {
    // Given
    const fixture = createRuntime(["eval", "--transcript-dir="]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe(
      "Error: --transcript-dir requires a value.\n",
    );
  });

  test(`Given an eval task option is missing its value,
    When the CLI main parses the eval request,
    Then it returns an option value validation error`, async () => {
    // Given
    const fixture = createRuntime(["eval", "--task"]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe("Error: --task requires a value.\n");
  });

  test(`Given an eval provider option is invalid,
    When the CLI main parses the eval request,
    Then it returns a provider validation error`, async () => {
    // Given
    const fixture = createRuntime(["eval", "--provider", "anthropic"]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe(
      "Error: --provider must be one of: fake, deepseek, kimi, qwen.\n",
    );
  });

  test(`Given an inline eval provider option is invalid,
    When the CLI main parses the eval request,
    Then it returns a provider validation error`, async () => {
    // Given
    const fixture = createRuntime(["eval", "--provider=anthropic"]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe(
      "Error: --provider must be one of: fake, deepseek, kimi, qwen.\n",
    );
  });

  test(`Given an eval model option is missing its value,
    When the CLI main parses the eval request,
    Then it returns an option value validation error`, async () => {
    // Given
    const fixture = createRuntime(["eval", "--model"]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe("Error: --model requires a value.\n");
  });

  test(`Given an inline eval model option is missing its value,
    When the CLI main parses the eval request,
    Then it returns an option value validation error`, async () => {
    // Given
    const fixture = createRuntime(["eval", "--model="]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe("Error: --model requires a value.\n");
  });

  test(`Given eval provider and model options are valid,
    When the CLI main dispatches to the eval runner,
    Then it accepts the separated provider selection flags`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-cli-main-eval-model-"),
    );
    const fixture = createRuntime(
      [
        "eval",
        "--provider",
        "fake",
        "--model",
        "ignored",
        "--suite",
        join(workspace, "missing-suite"),
        "--out",
        join(workspace, "results.jsonl"),
      ],
      { cwd: workspace },
    );

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(1);
      expect(fixture.stderr()).toBe("");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given eval provider and model equals options are valid,
    When the CLI main dispatches to the eval runner,
    Then it accepts the inline provider selection flags`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-cli-main-eval-model-equals-"),
    );
    const fixture = createRuntime(
      [
        "eval",
        "--provider=fake",
        "--model=ignored",
        "--suite",
        join(workspace, "missing-suite"),
        "--out",
        join(workspace, "results.jsonl"),
      ],
      { cwd: workspace },
    );

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(1);
      expect(fixture.stderr()).toBe("");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given eval transcript directory uses equals syntax,
    When the CLI main dispatches to the eval runner,
    Then it accepts the inline transcript artifact option`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-cli-main-eval-transcript-equals-"),
    );
    const fixture = createRuntime(
      [
        "eval",
        "--suite",
        join(workspace, "missing-suite"),
        "--out",
        join(workspace, "results.jsonl"),
        `--transcript-dir=${join(workspace, "transcripts")}`,
      ],
      { cwd: workspace },
    );

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(1);
      expect(fixture.stderr()).toBe("");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test.each(["0", "0x10", " 5 "])(`Given invalid eval trial count %s,
    When the CLI main parses the eval request,
    Then it returns a trial validation error`, async (trials) => {
    // Given
    const fixture = createRuntime(["eval", "--trials", trials]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe(
      "Error: --trials must be a positive integer.\n",
    );
  });

  test(`Given eval options are valid but the suite is missing,
    When the CLI main dispatches to the eval runner,
    Then it returns the eval configuration failure`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-main-eval-"));
    const fixture = createRuntime(
      [
        "eval",
        "--suite",
        join(workspace, "missing-suite"),
        "--out",
        join(workspace, "results.jsonl"),
        "--trials",
        "1",
        "--task",
        "fix-note",
        "--transcript-dir",
        join(workspace, "transcripts"),
        "--check",
      ],
      { cwd: workspace },
    );

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(1);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given eval runs without a task filter,
    When the CLI main dispatches to the eval runner,
    Then it omits the optional task selection`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-main-eval-all-"));
    const fixture = createRuntime(
      [
        "eval",
        "--suite",
        join(workspace, "missing-suite"),
        "--out",
        join(workspace, "results.jsonl"),
      ],
      { cwd: workspace },
    );

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(1);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
