import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { USAGE } from "../../src/cli/args.ts";
import { runCliMain } from "../../src/cli/index.ts";
import { createRuntime } from "../../src/testing/cli-runtime-fixtures.ts";

describe("CLI Args", () => {
  test.each([["--help"], ["-h"]])(`Given the %s help flag,
    When the user runs the CLI,
    Then usage is printed to stdout instead of starting a prompt`, async (flag) => {
    // Given
    const fixture = createRuntime([flag], {
      env: { KEEL_PROVIDER: "fake" },
    });

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(0);
    expect(fixture.stdout()).toBe(`${USAGE}\n`);
    expect(fixture.stderr()).toBe("");
  });

  test(`Given the undo list command,
    When the user runs the CLI,
    Then undo checkpoints are listed without starting a provider run`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-args-undo-list-"));
    const fixture = createRuntime(["/undo", "--list"], {
      cwd: workspace,
      env: { KEEL_PROVIDER: "fake" },
    });

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(0);
      expect(fixture.stdout()).toBe("No undo checkpoints.\n");
      expect(fixture.stderr()).toBe("");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an unknown undo option,
    When the user runs the CLI,
    Then the CLI rejects the option before running undo`, async () => {
    // Given
    const fixture = createRuntime(["/undo", "--all"]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe('Error: unknown undo option "--all"\n');
  });

  test(`Given an invalid undo target index,
    When the user runs the CLI,
    Then the CLI rejects it before running undo`, async () => {
    // Given
    const fixture = createRuntime(["/undo", "--to", "0"]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe(
      "Error: /undo --to requires a positive integer.\n",
    );
  });

  test(`Given an unsafe undo target index,
    When the user runs the CLI,
    Then the CLI rejects it before running undo`, async () => {
    // Given
    const fixture = createRuntime(["/undo", "--to", "9007199254740992"]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe(
      "Error: /undo --to requires a positive integer.\n",
    );
  });

  test(`Given an invalid inline undo target index,
    When the user runs the CLI,
    Then the CLI rejects it before running undo`, async () => {
    // Given
    const fixture = createRuntime(["/undo", "--to=0"]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe(
      "Error: /undo --to requires a positive integer.\n",
    );
  });

  test(`Given the undo target index uses inline option syntax,
    When the user runs the CLI,
    Then the command is parsed as undo before resolving a provider`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-args-undo-to-"));
    const fixture = createRuntime(["/undo", "--to=1"], {
      cwd: workspace,
      env: { KEEL_PROVIDER: "fake" },
    });

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(1);
      expect(fixture.stdout()).toBe("");
      expect(fixture.stderr()).toBe(
        "No earlier checkpoints. Ask me to undo more, or use git to reset.\n",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test.each([
    [["/undo", "--to", "1", "extra"], 'Error: unknown undo option "extra"\n'],
    [["/undo", "--to=1", "extra"], 'Error: unknown undo option "extra"\n'],
  ])(`Given undo target command %j has an extra argument,
    When the user runs the CLI,
    Then the CLI rejects the extra argument before running undo`, async (args, message) => {
    // Given
    const fixture = createRuntime(args);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe(message);
  });

  test(`Given an extra undo list argument,
    When the user runs the CLI,
    Then the CLI reports the extra argument instead of listing checkpoints`, async () => {
    // Given
    const fixture = createRuntime(["/undo", "--list", "extra"]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe('Error: unknown undo option "extra"\n');
  });

  test(`Given an unknown run option,
    When the user runs the CLI,
    Then usage is printed to stderr before resolving a provider`, async () => {
    // Given
    const fixture = createRuntime(["--bogus"], {
      env: { KEEL_PROVIDER: "fake" },
    });

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe(
      `Error: unknown option "--bogus"\n\n${USAGE}\n`,
    );
  });

  test(`Given a mistyped model option before a prompt,
    When the user runs the CLI,
    Then the typo is reported instead of sending the prompt`, async () => {
    // Given
    const fixture = createRuntime(["--modle", "deepseek", "fix it"], {
      env: { KEEL_PROVIDER: "fake" },
    });

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe(
      `Error: unknown option "--modle"\n\n${USAGE}\n`,
    );
  });

  test(`Given a run option value is followed by another known flag,
    When the user runs the CLI,
    Then the CLI rejects the missing value instead of swallowing the flag`, async () => {
    // Given
    const fixture = createRuntime(["--model", "--max-cost", "5", "fix it"]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe(
      'Error: --model requires a value, but got option "--max-cost".\n',
    );
  });

  test(`Given a run option value is followed by another known flag with an inline value,
    When the user runs the CLI,
    Then the CLI rejects the missing value instead of swallowing the inline flag token`, async () => {
    // Given
    const fixture = createRuntime(["--model", "--max-cost=5", "fix it"]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe(
      'Error: --model requires a value, but got option "--max-cost=5".\n',
    );
  });

  test.each([
    ["--report", "--model"],
    ["--transcript", "--session"],
    ["--session", "--resume"],
    ["--fork", "--fork-before-message"],
    ["--skill", "--provider"],
  ])(`Given the %s run option is followed by the %s flag,
    When the user runs the CLI,
    Then the CLI rejects the missing value instead of treating the flag as data`, async (option, nextFlag) => {
    // Given
    const fixture = createRuntime([option, nextFlag, "value", "fix it"]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toContain(
      `Error: ${option} requires a value, but got option "${nextFlag}".`,
    );
  });

  test(`Given a doctor model option is followed by the offline flag,
    When the user runs the CLI,
    Then the CLI rejects the missing model instead of disabling offline mode`, async () => {
    // Given
    const fixture = createRuntime(["--doctor", "--model", "--offline"]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe(
      'Error: --model requires a value, but got option "--offline".\n',
    );
  });

  test(`Given an eval output option is followed by the check flag,
    When the user runs the CLI,
    Then the CLI rejects the missing output path instead of disabling the flag`, async () => {
    // Given
    const fixture = createRuntime(["eval", "--out", "--check"]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe(
      'Error: --out requires a value, but got option "--check".\n',
    );
  });

  test.each([
    ["--trials", "--check"],
    ["--provider", "--model"],
  ])(`Given the %s eval option is followed by the %s flag,
    When the user runs the CLI,
    Then the CLI rejects the missing value instead of returning a type-specific error`, async (option, nextFlag) => {
    // Given
    const fixture = createRuntime(["eval", option, nextFlag, "value"]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe(
      `Error: ${option} requires a value, but got option "${nextFlag}".\n`,
    );
  });

  test.each([
    ["--suite=", "Error: --suite requires a value.\n"],
    ["--out=", "Error: --out requires a value.\n"],
    ["--task=", "Error: --task requires a value.\n"],
    ["--trials=0", "Error: --trials must be a positive integer.\n"],
  ])(`Given eval run option %s has an invalid inline value,
    When the user runs the CLI,
    Then the CLI prints the option-specific validation error`, async (arg, message) => {
    // Given
    const fixture = createRuntime(["eval", arg]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe(message);
  });

  test(`Given an eval compare base option is followed by the head flag,
    When the user runs the CLI,
    Then the CLI rejects the missing base path instead of treating the flag as data`, async () => {
    // Given
    const fixture = createRuntime([
      "eval",
      "compare",
      "--base",
      "--head",
      "head.jsonl",
    ]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe(
      'Error: --base requires a value, but got option "--head".\n',
    );
  });

  test(`Given a sessions fork before-message option is followed by another before-message flag,
    When the user runs the CLI,
    Then the CLI rejects the missing message id instead of treating the flag as data`, async () => {
    // Given
    const fixture = createRuntime([
      "sessions",
      "fork",
      "source",
      "target",
      "--before-message",
      "--before-message",
    ]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe(
      'Error: --before-message requires a value, but got option "--before-message".\n',
    );
  });
});
