import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { runCliMain } from "../../../src/cli/index.ts";
import { createRuntime } from "../../../src/testing/cli-runtime-fixtures.ts";

describe("CLI Main - Session Flag Validation", () => {
  test(`Given ephemeral mode is combined with a named session,
    When the CLI main parses the request,
    Then it returns a validation error before starting interactive mode`, async () => {
    // Given
    const fixture = createRuntime(["--ephemeral", "--session", "demo"]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe(
      "Error: --ephemeral cannot be combined with --session, --resume, --fork, --fork-before-message, or --fork-points.\n",
    );
  });

  test(`Given ephemeral mode is combined with a resumed session,
    When the CLI main parses the request,
    Then it returns a validation error before starting interactive mode`, async () => {
    // Given
    const fixture = createRuntime(["--ephemeral", "--resume", "demo"]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe(
      "Error: --ephemeral cannot be combined with --session, --resume, --fork, --fork-before-message, or --fork-points.\n",
    );
  });

  test.each([
    {
      label: "fork target",
      args: ["--ephemeral", "--fork", "target"],
    },
    {
      label: "fork points",
      args: ["--ephemeral", "--fork-points"],
    },
    {
      label: "fork point selector",
      args: ["--ephemeral", "--fork-before-message", "msg_demo"],
    },
  ])(`Given ephemeral mode is combined with a $label,
    When the CLI main parses the request,
    Then it returns a validation error before starting interactive mode`, async (testCase) => {
    // Given
    const fixture = createRuntime(testCase.args);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe(
      "Error: --ephemeral cannot be combined with --session, --resume, --fork, --fork-before-message, or --fork-points.\n",
    );
  });

  test(`Given ephemeral mode is passed with a one-shot prompt,
    When the CLI main parses the request,
    Then it returns a validation error because ephemeral mode is interactive-only`, async () => {
    // Given
    const fixture = createRuntime(["--ephemeral", "hello"], {
      env: { KEEL_PROVIDER: "fake" },
    });

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe(
      "Error: --ephemeral is only supported for interactive sessions.\n",
    );
  });

  test(`Given resume is passed without a session id,
    When the CLI main parses the request,
    Then it returns a validation error before starting interactive mode`, async () => {
    // Given
    const fixture = createRuntime(["--resume="]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe("Error: --resume requires a value.\n");
  });

  test(`Given session is passed without a session id,
    When the CLI main parses the request,
    Then it returns a validation error before starting interactive mode`, async () => {
    // Given
    const fixture = createRuntime(["--session"]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe("Error: --session requires a value.\n");
  });

  test(`Given session is passed with an empty equals value,
    When the CLI main parses the request,
    Then it returns a validation error before starting interactive mode`, async () => {
    // Given
    const fixture = createRuntime(["--session="]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe("Error: --session requires a value.\n");
  });

  test(`Given resume is passed without a session id and no saved sessions exist,
    When the CLI main resolves the latest session,
    Then it reports that there is no resumable session for the workspace`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-session-"));
    const home = await mkdtemp(join(tmpdir(), "keel-cli-home-"));
    const fixture = createRuntime(["--resume"], {
      cwd: workspace,
      env: {
        KEEL_PROVIDER: "fake",
        KEEL_FORCE_INTERACTIVE: "1",
        KEEL_HOME: home,
      },
    });

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(1);
      expect(fixture.stdout()).toBe("");
      expect(fixture.stderr()).toBe(
        `Error: no saved sessions for workspace ${await realpath(workspace)}. Complete an interactive turn before running keel --resume.\n`,
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given fork is passed without a target session id,
    When the CLI main parses the request,
    Then it returns a validation error before starting interactive mode`, async () => {
    // Given
    const fixture = createRuntime(["--resume", "demo", "--fork"]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe("Error: --fork requires a value.\n");
  });

  test(`Given fork is passed with an empty equals value,
    When the CLI main parses the request,
    Then it returns a validation error before starting interactive mode`, async () => {
    // Given
    const fixture = createRuntime(["--resume", "demo", "--fork="]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe("Error: --fork requires a value.\n");
  });

  test(`Given fork is passed without a source session,
    When the CLI main parses the request,
    Then it returns a validation error before starting interactive mode`, async () => {
    // Given
    const fixture = createRuntime(["--fork", "target"]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe("Error: --fork requires --resume <id>.\n");
  });

  test(`Given latest resume is combined with a fork target,
    When the CLI main parses the request,
    Then it requires an explicit source session id`, async () => {
    // Given
    const fixture = createRuntime(["--resume", "--fork", "target"]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe("Error: --fork requires --resume <id>.\n");
  });

  test(`Given fork-before-message is passed without a value,
    When the CLI main parses the request,
    Then it returns a validation error before starting interactive mode`, async () => {
    // Given
    const fixture = createRuntime([
      "--resume",
      "source",
      "--fork",
      "target",
      "--fork-before-message",
    ]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe(
      "Error: --fork-before-message requires a value.\n",
    );
  });

  test(`Given fork-before-message is passed with an empty equals value,
    When the CLI main parses the request,
    Then it returns a validation error before starting interactive mode`, async () => {
    // Given
    const fixture = createRuntime([
      "--resume",
      "source",
      "--fork",
      "target",
      "--fork-before-message=",
    ]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe(
      "Error: --fork-before-message requires a value.\n",
    );
  });

  test(`Given fork-before-message is passed without a fork target,
    When the CLI main parses the request,
    Then it returns a validation error before starting interactive mode`, async () => {
    // Given
    const fixture = createRuntime([
      "--resume",
      "source",
      "--fork-before-message",
      "msg_demo",
    ]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe(
      "Error: --fork-before-message requires --resume <id> --fork <new-id>.\n",
    );
  });

  test(`Given fork-points is passed without a source session,
    When the CLI main parses the request,
    Then it returns a validation error before reading sessions`, async () => {
    // Given
    const fixture = createRuntime(["--fork-points"]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe(
      "Error: --fork-points requires --resume <id>.\n",
    );
  });

  test(`Given latest resume is combined with fork-points,
    When the CLI main parses the request,
    Then it requires an explicit source session id`, async () => {
    // Given
    const fixture = createRuntime(["--resume", "--fork-points"]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe(
      "Error: --fork-points requires --resume <id>.\n",
    );
  });

  test(`Given fork-points is combined with a fork target,
    When the CLI main parses the request,
    Then it returns a validation error before reading sessions`, async () => {
    // Given
    const fixture = createRuntime([
      "--resume",
      "source",
      "--fork-points",
      "--fork",
      "target",
    ]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe(
      "Error: --fork-points cannot be combined with --fork.\n",
    );
  });

  test(`Given fork-points is combined with a fork point,
    When the CLI main parses the request,
    Then it returns a validation error before reading sessions`, async () => {
    // Given
    const fixture = createRuntime([
      "--resume",
      "source",
      "--fork-points",
      "--fork-before-message",
      "msg_demo",
    ]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe(
      "Error: --fork-points cannot be combined with --fork-before-message.\n",
    );
  });

  test(`Given fork-points is combined with a prompt,
    When the CLI main parses the request,
    Then it returns a validation error before reading sessions`, async () => {
    // Given
    const fixture = createRuntime([
      "--resume",
      "source",
      "--fork-points",
      "hello",
    ]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe(
      "Error: --fork-points cannot be combined with a message.\n",
    );
  });

  test(`Given fork-points is combined with transcript output,
    When the CLI main parses the request,
    Then it returns a validation error before reading sessions`, async () => {
    // Given
    const fixture = createRuntime([
      "--resume",
      "source",
      "--fork-points",
      "--transcript",
      "out.jsonl",
    ]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe(
      "Error: --fork-points cannot be combined with --transcript.\n",
    );
  });

  test(`Given fork-points names a missing source session,
    When the CLI main reads fork points,
    Then it reports the resume error without starting interactive mode`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-session-"));
    const home = await mkdtemp(join(tmpdir(), "keel-cli-home-"));
    const fixture = createRuntime(["--resume", "missing", "--fork-points"], {
      cwd: workspace,
      env: {
        KEEL_HOME: home,
      },
    });

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(1);
      expect(fixture.stdout()).toBe("");
      expect(fixture.stderr()).toContain(
        'Error: cannot resume session "missing": session ledger not found at ',
      );
      expect(fixture.stderr()).toContain(
        join(home, "sessions", "missing", "ledger.jsonl"),
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given session and resume flags are combined,
    When the CLI main parses the request,
    Then it returns a validation error before starting interactive mode`, async () => {
    // Given
    const fixture = createRuntime(["--session", "demo", "--resume", "demo"]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe(
      "Error: --session cannot be combined with --resume.\n",
    );
  });

  test(`Given a session flag is used with a one-shot prompt,
    When the CLI main parses the request,
    Then it returns a validation error because sessions are interactive-only`, async () => {
    // Given
    const fixture = createRuntime(["--session=demo", "hello"], {
      env: { KEEL_PROVIDER: "fake" },
    });

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe(
      "Error: --session and --resume are only supported for interactive sessions.\n",
    );
  });
});
