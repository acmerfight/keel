import { describe, expect, test } from "vitest";
import { parseCliArgs, USAGE } from "../../src/cli/args.ts";

describe("CLI Args", () => {
  test.each([["--help"], ["-h"]])(`Given the %s help flag,
    When the top-level CLI args are parsed,
    Then the parser returns a help command instead of a run prompt`, (flag) => {
    // Given
    const args = [flag];

    // When
    const result = parseCliArgs(args);

    // Then
    expect(result).toEqual({ ok: true, value: { command: "help" } });
  });

  test(`Given an unknown run option,
    When the top-level CLI args are parsed,
    Then the parser returns a usage error instead of a run prompt`, () => {
    // Given
    const args = ["--bogus"];

    // When
    const result = parseCliArgs(args);

    // Then
    expect(result).toEqual({
      ok: false,
      message: `Error: unknown option "--bogus"\n\n${USAGE}`,
    });
  });

  test(`Given a mistyped model option before a prompt,
    When the top-level CLI args are parsed,
    Then the parser rejects the typo before the prompt can run`, () => {
    // Given
    const args = ["--modle", "deepseek", "fix it"];

    // When
    const result = parseCliArgs(args);

    // Then
    expect(result).toEqual({
      ok: false,
      message: `Error: unknown option "--modle"\n\n${USAGE}`,
    });
  });

  test(`Given an explicit end-of-options marker before a dash-leading prompt,
    When the top-level CLI args are parsed,
    Then the prompt is preserved as the run message`, () => {
    // Given
    const args = ["--provider=fake", "--", "-starts-with-dash message"];

    // When
    const result = parseCliArgs(args);

    // Then
    expect(result).toEqual({
      ok: true,
      value: {
        command: "run",
        bashMode: "disabled",
        providerId: "fake",
        userMessage: "-starts-with-dash message",
      },
    });
  });

  test(`Given an end-of-options marker without a following prompt,
    When the top-level CLI args are parsed,
    Then the parser keeps the run request message-less`, () => {
    // Given
    const args = ["--provider=fake", "--"];

    // When
    const result = parseCliArgs(args);

    // Then
    expect(result).toEqual({
      ok: true,
      value: {
        command: "run",
        bashMode: "disabled",
        providerId: "fake",
      },
    });
  });

  test(`Given a run option value is followed by another known flag,
    When the top-level CLI args are parsed,
    Then the parser rejects the missing value instead of swallowing the flag`, () => {
    // Given
    const args = ["--model", "--max-cost", "5", "fix it"];

    // When
    const result = parseCliArgs(args);

    // Then
    expect(result).toEqual({
      ok: false,
      message: 'Error: --model requires a value, but got option "--max-cost".',
    });
  });

  test(`Given a run option value is followed by another known flag with an inline value,
    When the top-level CLI args are parsed,
    Then the parser rejects the missing value instead of swallowing the flag token`, () => {
    // Given
    const args = ["--model", "--max-cost=5", "fix it"];

    // When
    const result = parseCliArgs(args);

    // Then
    expect(result).toEqual({
      ok: false,
      message:
        'Error: --model requires a value, but got option "--max-cost=5".',
    });
  });

  test.each([
    ["--report", "--model"],
    ["--transcript", "--session"],
    ["--session", "--resume"],
    ["--resume", "--fork"],
    ["--fork", "--fork-before-message"],
    ["--skill", "--provider"],
  ])(`Given the %s run option is followed by the %s flag,
    When the top-level CLI args are parsed,
    Then the parser rejects the missing value instead of treating the flag as data`, (option, nextFlag) => {
    // Given
    const args = [option, nextFlag, "value", "fix it"];

    // When
    const result = parseCliArgs(args);

    // Then
    expect(result).toMatchObject({
      ok: false,
      message: expect.stringContaining(
        `Error: ${option} requires a value, but got option "${nextFlag}".`,
      ),
    });
  });

  test(`Given a doctor model option is followed by the offline flag,
    When the top-level CLI args are parsed,
    Then the parser rejects the missing model instead of disabling the flag`, () => {
    // Given
    const args = ["--doctor", "--model", "--offline"];

    // When
    const result = parseCliArgs(args);

    // Then
    expect(result).toEqual({
      ok: false,
      message: 'Error: --model requires a value, but got option "--offline".',
    });
  });

  test(`Given an eval output option is followed by the check flag,
    When the top-level CLI args are parsed,
    Then the parser rejects the missing output path instead of disabling the flag`, () => {
    // Given
    const args = ["eval", "--out", "--check"];

    // When
    const result = parseCliArgs(args);

    // Then
    expect(result).toEqual({
      ok: false,
      message: 'Error: --out requires a value, but got option "--check".',
    });
  });

  test(`Given an eval compare base option is followed by the head flag,
    When the top-level CLI args are parsed,
    Then the parser rejects the missing base path instead of treating the flag as data`, () => {
    // Given
    const args = ["eval", "compare", "--base", "--head", "head.jsonl"];

    // When
    const result = parseCliArgs(args);

    // Then
    expect(result).toEqual({
      ok: false,
      message: 'Error: --base requires a value, but got option "--head".',
    });
  });

  test(`Given a sessions fork before-message option is followed by another before-message flag,
    When the top-level CLI args are parsed,
    Then the parser rejects the missing message id instead of treating the flag as data`, () => {
    // Given
    const args = [
      "sessions",
      "fork",
      "source",
      "target",
      "--before-message",
      "--before-message",
    ];

    // When
    const result = parseCliArgs(args);

    // Then
    expect(result).toEqual({
      ok: false,
      message:
        'Error: --before-message requires a value, but got option "--before-message".',
    });
  });
});
