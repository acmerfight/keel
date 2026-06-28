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
});
