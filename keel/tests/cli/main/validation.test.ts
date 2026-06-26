import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { runCliMain } from "../../../src/cli/index.ts";
import { createRuntime } from "../../../src/testing/cli-runtime-fixtures.ts";

describe("CLI Main - Validation", () => {
  test(`Given no user message and no interactive terminal,
    When the CLI main is invoked in-process,
    Then it returns usage instructions without starting a subprocess`, async () => {
    // Given
    const fixture = createRuntime([]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toContain("Usage: keel");
  });

  test(`Given a report option without a file path,
    When the CLI main parses the request,
    Then it returns a validation error before resolving a provider`, async () => {
    // Given
    const fixture = createRuntime(["--report"]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe("Error: --report requires a file path.\n");
  });

  test(`Given a report option with an empty equals path,
    When the CLI main parses the request,
    Then it returns a validation error before resolving a provider`, async () => {
    // Given
    const fixture = createRuntime(["--report=", "hello"]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe("Error: --report requires a file path.\n");
  });

  test(`Given a transcript option without a file path,
    When the CLI main parses the request,
    Then it returns a validation error before resolving a provider`, async () => {
    // Given
    const fixture = createRuntime(["--transcript"]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe("Error: --transcript requires a value.\n");
  });

  test(`Given a transcript option uses an empty equals path,
    When the CLI main parses the request,
    Then it returns a validation error before resolving a provider`, async () => {
    // Given
    const fixture = createRuntime(["--transcript=", "hello"], {
      env: { KEEL_PROVIDER: "fake" },
    });

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe("Error: --transcript requires a value.\n");
  });

  test(`Given a transcript path without a one-shot prompt,
    When the CLI main parses the request,
    Then it rejects transcript capture before starting interactive mode`, async () => {
    // Given
    const fixture = createRuntime(["--transcript", "run.jsonl"], {
      env: { KEEL_FORCE_INTERACTIVE: "1" },
    });

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe(
      "Error: --transcript is only supported for one-shot runs.\n",
    );
  });

  test.each(["0", "abc"])(`Given invalid max cost value %s,
    When the CLI main parses the request,
    Then it returns a validation error before resolving a provider`, async (maxCost) => {
    // Given
    const fixture = createRuntime(["--max-cost", maxCost, "hello"], {
      env: { KEEL_PROVIDER: "deepseek", DEEPSEEK_API_KEY: "" },
    });

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe(
      "Error: --max-cost must be a positive number.\n",
    );
  });

  test(`Given invalid max cost uses equals syntax,
    When the CLI main parses the request,
    Then it returns a validation error before resolving a provider`, async () => {
    // Given
    const fixture = createRuntime(["--max-cost=abc", "hello"], {
      env: { KEEL_PROVIDER: "deepseek", DEEPSEEK_API_KEY: "" },
    });

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe(
      "Error: --max-cost must be a positive number.\n",
    );
  });

  test(`Given an unsupported provider flag,
    When the CLI main parses the request,
    Then it returns a validation error before resolving a provider`, async () => {
    // Given
    const fixture = createRuntime(["--provider", "anthropic", "hello"], {
      env: { KEEL_PROVIDER: "fake" },
    });

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe(
      "Error: --provider must be one of: fake, deepseek, kimi, qwen.\n",
    );
  });

  test(`Given an unsupported provider flag uses equals syntax,
    When the CLI main parses the request,
    Then it returns a validation error before resolving a provider`, async () => {
    // Given
    const fixture = createRuntime(["--provider=anthropic", "hello"], {
      env: { KEEL_PROVIDER: "fake" },
    });

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe(
      "Error: --provider must be one of: fake, deepseek, kimi, qwen.\n",
    );
  });

  test(`Given a provider flag without a value,
    When the CLI main parses the request,
    Then it returns a validation error before resolving a provider`, async () => {
    // Given
    const fixture = createRuntime(["--provider"], {
      env: { KEEL_PROVIDER: "fake" },
    });

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe("Error: --provider requires a value.\n");
  });

  test(`Given a model flag without a value,
    When the CLI main parses the request,
    Then it returns a validation error before resolving a provider`, async () => {
    // Given
    const fixture = createRuntime(["--model"], {
      env: { KEEL_PROVIDER: "fake" },
    });

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe("Error: --model requires a value.\n");
  });

  test(`Given a model flag with an empty equals value,
    When the CLI main parses the request,
    Then it returns a validation error before resolving a provider`, async () => {
    // Given
    const fixture = createRuntime(["--model=", "hello"], {
      env: { KEEL_PROVIDER: "fake" },
    });

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe("Error: --model requires a value.\n");
  });

  test(`Given provider and model flags use equals syntax,
    When the CLI main runs in-process,
    Then the selected provider overrides provider env`, async () => {
    // Given
    const fixture = createRuntime(
      ["--provider=fake", "--model=ignored", "hello"],
      {
        env: { KEEL_PROVIDER: "deepseek" },
      },
    );

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(0);
    expect(fixture.stdout()).toBe("Hello from fake provider.\n");
    expect(fixture.stderr()).toBe("");
  });

  test(`Given a one-shot transcript path,
    When the CLI main runs in-process,
    Then it writes the provider-visible transcript`, async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "keel-cli-main-transcript-"));
    const transcriptPath = join(root, "artifacts", "run.jsonl");
    const fixture = createRuntime([`--transcript=${transcriptPath}`, "hello"], {
      cwd: root,
      env: { KEEL_PROVIDER: "fake" },
    });

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(0);
      expect(fixture.stdout()).toBe("Hello from fake provider.\n");
      expect(fixture.stderr()).toBe("");
      const records = (await readFile(transcriptPath, "utf8"))
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(records).toMatchObject([
        {
          schemaVersion: 1,
          type: "transcript",
          provider: "fake",
          model: "fake",
          systemPrompt: expect.stringContaining("You are keel"),
        },
        { type: "message", message: { role: "user", content: "hello" } },
        {
          type: "message",
          message: {
            role: "assistant",
            content: "Hello from fake provider.",
          },
        },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
