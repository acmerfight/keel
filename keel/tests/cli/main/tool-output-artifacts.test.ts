import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { runCliMain } from "../../../src/cli/index.ts";
import { createRuntime } from "../../../src/testing/cli-runtime-fixtures.ts";

describe("CLI Main - Artifact Commands", () => {
  test.each([
    ["already ends with a newline", "already newline\n", "already newline\n"],
    ["does not end with a newline", "no final newline", "no final newline\n"],
  ])(
    `Given a stored artifact %s,
    When CLI main shows the artifact,
    Then stdout contains exactly one final newline`,
    async (_name, content, expected) => {
      // Given
      const home = await mkdtemp(join(tmpdir(), "keel-artifact-home-"));
      const scopeDirectory = join(
        home,
        "artifacts",
        "tool-output",
        "show-newline",
      );
      await mkdir(scopeDirectory, { recursive: true });
      await writeFile(join(scopeDirectory, "artifact.txt"), content);

      try {
        // When
        const show = createRuntime(
          ["artifacts", "show", "tool-output:show-newline/artifact"],
          {
            env: { KEEL_HOME: home },
          },
        );
        const exitCode = await runCliMain(show.runtime);

        // Then
        expect(exitCode).toBe(0);
        expect(show.stdout()).toBe(expected);
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    },
  );

  test(`Given artifact commands have missing, unknown, or extra arguments,
    When CLI main parses the command,
    Then it reports the command-specific validation error`, async () => {
    // Given / When
    const noSubcommand = createRuntime(["artifacts"]);
    const noSubcommandExitCode = await runCliMain(noSubcommand.runtime);
    const unknownSubcommand = createRuntime(["artifacts", "list"]);
    const unknownSubcommandExitCode = await runCliMain(
      unknownSubcommand.runtime,
    );
    const missingRef = createRuntime(["artifacts", "show"]);
    const missingRefExitCode = await runCliMain(missingRef.runtime);
    const extra = createRuntime([
      "artifacts",
      "show",
      "tool-output:run/id",
      "x",
    ]);
    const extraExitCode = await runCliMain(extra.runtime);

    // Then
    expect(noSubcommandExitCode).toBe(1);
    expect(noSubcommand.stderr()).toBe(
      "Error: artifacts requires a subcommand: show.\n",
    );
    expect(unknownSubcommandExitCode).toBe(1);
    expect(unknownSubcommand.stderr()).toBe(
      'Error: unknown artifacts subcommand "list"\n',
    );
    expect(missingRefExitCode).toBe(1);
    expect(missingRef.stderr()).toBe("Error: artifacts show requires <ref>.\n");
    expect(extraExitCode).toBe(1);
    expect(extra.stderr()).toBe('Error: unknown artifacts show option "x"\n');
  });

  test(`Given an artifact ref is valid but its managed file is missing,
    When CLI main runs artifacts show,
    Then it reports the store error on stderr and exits unsuccessfully`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-artifact-home-"));
    const show = createRuntime(
      ["artifacts", "show", "tool-output:missing-scope/missing-id"],
      { env: { KEEL_HOME: home } },
    );

    try {
      // When
      const exitCode = await runCliMain(show.runtime);

      // Then
      expect(exitCode).toBe(1);
      expect(show.stdout()).toBe("");
      expect(show.stderr()).toContain(
        "Error: cannot read artifact tool-output:missing-scope/missing-id:",
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given expired and recent tool-output artifacts exist under KEEL_HOME,
    When CLI main starts a one-shot agent run,
    Then startup retention cleanup removes only the expired artifact`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-artifact-home-"));
    const scope = join(home, "artifacts", "tool-output", "session-cleanup");
    await mkdir(scope, { recursive: true });
    const expired = join(scope, "expired.txt");
    const recent = join(scope, "recent.txt");
    await writeFile(expired, "expired artifact", "utf8");
    await writeFile(recent, "recent artifact", "utf8");
    const dayMs = 24 * 60 * 60 * 1000;
    const now = Date.UTC(2026, 0, 31);
    await utimes(
      expired,
      new Date(now - 31 * dayMs),
      new Date(now - 31 * dayMs),
    );
    await utimes(recent, new Date(now - dayMs), new Date(now - dayMs));
    const run = createRuntime(["hello"], {
      env: { KEEL_HOME: home, KEEL_PROVIDER: "fake" },
      now: () => now,
    });

    try {
      // When
      const exitCode = await runCliMain(run.runtime);

      // Then
      expect(exitCode).toBe(0);
      expect(run.stdout()).toBe("Hello from fake provider.\n");
      expect(await readdir(scope)).toEqual(["recent.txt"]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
