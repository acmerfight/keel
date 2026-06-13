import { describe, expect, test } from "vitest";
import { runCli } from "../../src/testing/cli-harness.ts";

describe("CLI Eval Bundled Suite", () => {
  test(`Given the eval suite shipped with keel,
    When the suite is checked,
    Then every task's reference solution passes its verifier`, async () => {
    // Given — the bundled suite at evals/tasks

    // When
    const result = await runCli(["eval", "--check"], {
      timeoutMs: 120_000,
    });

    // Then
    expect(result.stdout).not.toContain("BROKEN");
    expect(result.exitCode).toBe(0);
  });
});
