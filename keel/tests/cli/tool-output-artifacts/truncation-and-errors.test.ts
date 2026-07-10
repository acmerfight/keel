import { describe, expect, test } from "vitest";
import { runCli } from "./fixtures.ts";

describe("CLI Tool Output Artifact Smoke", () => {
  test(`Given the artifact ref is malformed,
    When the user runs artifacts show through the real CLI,
    Then it exits with an error without reading outside KEEL_HOME`, async () => {
    // Given / When
    const result = await runCli(["artifacts", "show", "../secret"], {
      env: { KEEL_HOME: "/tmp/unused-keel-home" },
    });

    // Then
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      'Error: invalid artifact ref "../secret". Use tool-output:<scope>/<id>.\n',
    );
  });
});
