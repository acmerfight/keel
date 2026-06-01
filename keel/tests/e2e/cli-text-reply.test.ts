import { execFile } from "node:child_process";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const CLI_PATH = join(import.meta.dirname, "../../src/cli/index.ts");

function runCli(
  args: readonly string[],
  env: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const child = execFile(
      "node",
      ["--experimental-strip-types", CLI_PATH, ...args],
      {
        env: { ...process.env, ...env },
        timeout: 5000,
      },
      (error, stdout, stderr) => {
        resolve({
          stdout,
          stderr,
          exitCode: error?.code ? Number(error.code) : (child.exitCode ?? 0),
        });
      },
    );
  });
}

describe("CLI Text Reply", () => {
  test(`Given a user message and a configured provider,
    When user runs the CLI with the message,
    Then the agent's text reply is printed to stdout`, async () => {
    // Given — fake provider is used when KEEL_PROVIDER=fake
    const env = { KEEL_PROVIDER: "fake" };

    // When
    const result = await runCli(["hello"], env);

    // Then
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).not.toBe("");
    expect(result.stdout.trim()).not.toBe("keel v0.0.1");
  });

  test(`Given no provider API key and no fake provider,
    When user runs the CLI,
    Then the CLI exits with an error message`, async () => {
    // Given — no DEEPSEEK_API_KEY, no KEEL_PROVIDER=fake
    const env = {
      KEEL_PROVIDER: "deepseek",
      DEEPSEEK_API_KEY: "",
    };

    // When
    const result = await runCli(["hello"], env);

    // Then
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/api key/i);
  });
});
