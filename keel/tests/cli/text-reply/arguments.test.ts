import { describe, expect, test } from "vitest";
import { runCli, USAGE } from "./fixtures.ts";

describe("CLI Text Reply", () => {
  test.each([["--help"], ["-h"]])(
    `Given the %s help flag,
    When user runs the CLI process,
    Then the CLI prints usage and exits successfully`,
    async (flag) => {
      // Given
      const args = [flag];

      // When
      const result = await runCli(args, { KEEL_PROVIDER: "fake" });

      // Then
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(`${USAGE}\n`);
      expect(result.stderr).toBe("");
    },
  );

  test(`Given an unknown run option,
    When user runs the CLI process,
    Then the CLI rejects it before starting the agent`, async () => {
    // Given
    const args = ["--bogus"];

    // When
    const result = await runCli(args, { KEEL_PROVIDER: "fake" });

    // Then
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(`Error: unknown option "--bogus"\n\n${USAGE}\n`);
  });

  test(`Given an end-of-options marker before a dash-leading prompt,
    When user runs the CLI process,
    Then the CLI sends that prompt to the agent`, async () => {
    // Given
    const args = ["--provider=fake", "--", "-starts-with-dash message"];

    // When
    const result = await runCli(args, { KEEL_PROVIDER: "deepseek" });

    // Then
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("Hello from fake provider.\n");
    expect(result.stderr).toBe("");
  });

  test(`Given no user message and no interactive terminal,
    When user runs the CLI,
    Then the CLI exits with usage instructions`, async () => {
    // Given
    const args: readonly string[] = [];

    // When
    const result = await runCli(args);

    // Then
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toBe(`${USAGE}\n`);
  });

  test.each(["0", "abc"])(
    `Given an invalid max cost value %s,
    When user runs the CLI,
    Then the CLI exits with a validation error before requiring a provider`,
    async (maxCost) => {
      // Given
      const args: readonly string[] = ["--max-cost", maxCost, "hello"];

      // When
      const result = await runCli(args, {
        KEEL_PROVIDER: "deepseek",
        DEEPSEEK_API_KEY: "",
      });

      // Then
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe(
        "Error: --max-cost must be a positive number.\n",
      );
    },
  );
});
