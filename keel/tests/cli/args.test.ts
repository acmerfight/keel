import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { parseCliArgs, USAGE } from "../../src/cli/args.ts";
import { runCliMain } from "../../src/cli/index.ts";
import {
  SESSION_GOAL_COMPLETION_CRITERION_MAX_LENGTH,
  SESSION_GOAL_OBJECTIVE_MAX_LENGTH,
} from "../../src/core/session-goal.ts";
import { createRuntime } from "../../src/testing/cli-runtime-fixtures.ts";

describe("CLI Args", () => {
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
    ["--model", "--pick"],
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

  test.each([
    [
      ["goal", "--objective", "Ship it", "--bash-policy", "trusted"],
      "Error: goal requires --verify <command>.\n",
    ],
    [
      [
        "goal",
        "--objective",
        "Ship it",
        "--verify",
        "pnpm test",
        "--bash-policy",
        "trusted",
        "--allow-bash",
      ],
      "Error: --allow-bash cannot be combined with --bash-policy; use --bash-policy trusted instead.\n",
    ],
    [
      ["goal", "--verify", "pnpm test", "--bash-policy", "trusted"],
      "Error: goal requires --objective <objective>.\n",
    ],
    [
      [
        "goal",
        "--objective",
        "Ship it",
        "--verify",
        "pnpm test",
        "--verify",
        "pnpm test:unit",
      ],
      'Error: duplicate goal option "--verify".\n',
    ],
    [
      ["goal", "--objective", "Ship it", "--verify", "pnpm test", "--bogus"],
      'Error: unknown goal option "--bogus".\n',
    ],
  ])(`Given headless Goal arguments %j are incomplete or ambiguous,
    When the user runs the CLI,
    Then Keel rejects them before provider resolution`, async (args, message) => {
    // Given
    const fixture = createRuntime(args, {
      env: { KEEL_PROVIDER: "deepseek", DEEPSEEK_API_KEY: "" },
    });

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe(message);
  });

  test.each([
    [
      "--timeout",
      "61s",
      "Error: --timeout must be a positive duration up to 1m using ms, s, or m.\n",
    ],
    ["--turns", "0", "Error: --turns must be a positive integer.\n"],
    ["--tokens", "0", "Error: --tokens must be a positive integer.\n"],
    [
      "--time",
      "0s",
      "Error: --time must be a positive duration using ms, s, m, or h.\n",
    ],
    [
      "--bash-policy",
      "always",
      "Error: --bash-policy must be one of: ask, deny, trusted.\n",
    ],
    [
      "--provider",
      "unknown",
      "Error: --provider must be one of: fake, deepseek, kimi, qwen.\n",
    ],
    ["--max-cost", "0", "Error: --max-cost must be a positive number.\n"],
  ])(`Given a headless Goal has invalid %s value %s,
    When the user runs the CLI,
    Then Keel rejects the malformed contract before provider resolution`, async (option, value, message) => {
    // Given
    const fixture = createRuntime([
      "goal",
      "--objective",
      "Ship it",
      "--verify",
      "pnpm test",
      option,
      value,
    ]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe(message);
  });

  test(`Given a headless Goal option is missing its separated value,
    When the next token never arrives,
    Then Keel reports the missing value instead of accepting an incomplete contract`, async () => {
    // Given
    const fixture = createRuntime([
      "goal",
      "--objective",
      "Ship it",
      "--verify",
    ]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe("Error: --verify requires a value.\n");
  });

  test(`Given a headless Goal omits shell authorization,
    When the complete contract is parsed,
    Then Keel rejects execution before creating a session or spending provider tokens`, async () => {
    // Given
    const fixture = createRuntime([
      "goal",
      "--objective=Ship it",
      "--verify=pnpm test",
      "--turns=2",
    ]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe(
      "Error: headless command Goals require --bash-policy trusted or a matching saved project approval with --bash-policy ask.\n",
    );
  });

  test(`Given every headless Goal contract option uses inline syntax,
    When the CLI parses the command,
    Then it produces one normalized command-backed Goal contract`, () => {
    // Given
    const args = [
      "goal",
      "--objective=Ship checkout",
      "--verify=pnpm test checkout",
      "--timeout=45s",
      "--turns=12",
      "--tokens=50000",
      "--time=2h",
      "--allow-bash",
      "--provider=fake",
      "--model=test-model",
      "--skill=release",
      "--max-cost=1.25",
      "--report=goal.json",
      "--session=checkout",
    ];

    // When
    const parsed = parseCliArgs(args);

    // Then
    expect(parsed).toEqual({
      ok: true,
      value: {
        command: "goal",
        objective: "Ship checkout",
        verificationCommand: "pnpm test checkout",
        verificationTimeoutMs: 45_000,
        budget: {
          turns: 12,
          tokens: 50_000,
          activeTimeMs: 7_200_000,
        },
        bashMode: "trusted",
        providerId: "fake",
        model: "test-model",
        skillName: "release",
        maxCostUsd: 1.25,
        reportFile: "goal.json",
        sessionId: "checkout",
      },
    });
  });

  test(`Given headless Goal text is at or beyond its durable schema boundary,
    When the CLI parses the normalized contract,
    Then exact limits are accepted and the first excess character is rejected`, () => {
    // Given
    const objectiveAtLimit = "o".repeat(SESSION_GOAL_OBJECTIVE_MAX_LENGTH);
    const verifierAtLimit = "v".repeat(
      SESSION_GOAL_COMPLETION_CRITERION_MAX_LENGTH,
    );

    // When
    const accepted = parseCliArgs([
      "goal",
      "--objective",
      `  ${objectiveAtLimit}  `,
      "--verify",
      `  ${verifierAtLimit}  `,
    ]);
    const oversizedObjective = parseCliArgs([
      "goal",
      "--objective",
      `${objectiveAtLimit}o`,
      "--verify",
      "true",
    ]);
    const oversizedVerifier = parseCliArgs([
      "goal",
      "--objective",
      "Ship it",
      "--verify",
      `${verifierAtLimit}v`,
    ]);

    // Then
    expect(accepted).toMatchObject({
      ok: true,
      value: {
        objective: objectiveAtLimit,
        verificationCommand: verifierAtLimit,
      },
    });
    expect(oversizedObjective).toEqual({
      ok: false,
      message: `Error: /goal objective must be ${SESSION_GOAL_OBJECTIVE_MAX_LENGTH} characters or fewer.`,
    });
    expect(oversizedVerifier).toEqual({
      ok: false,
      message: `Error: /goal completion criterion must be ${SESSION_GOAL_COMPLETION_CRITERION_MAX_LENGTH} characters or fewer.`,
    });
  });

  test.each([
    [
      [
        "goal",
        "--objective",
        "Ship it",
        "--verify",
        "pnpm test",
        "--allow-bash",
        "--bash-policy",
        "trusted",
      ],
      "Error: --allow-bash cannot be combined with --bash-policy; use --bash-policy trusted instead.\n",
    ],
    [
      [
        "goal",
        "--objective",
        "Ship it",
        "--verify",
        "pnpm test",
        "--allow-bash=yes",
      ],
      "Error: --allow-bash does not accept a value.\n",
    ],
  ])(`Given a headless Goal has conflicting shell option arguments %j,
    When the CLI parses the command,
    Then it reports the authorization contract error`, async (args, message) => {
    // Given
    const fixture = createRuntime(args);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe(message);
  });
});
