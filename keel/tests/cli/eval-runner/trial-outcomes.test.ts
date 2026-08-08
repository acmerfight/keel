import { describe, expect, test } from "vitest";
import {
  CLI_ENTRY,
  createEvalDir,
  createMemoryPairTask,
  createTask,
  FIX_NOTE_TASK,
  join,
  KEEL_PROVIDER_ENV,
  mkdir,
  readFile,
  readResultLines,
  rm,
  runEvalCommand,
  VALID_REPORT,
  writeFile,
} from "./fixtures.ts";

const DEEPSEEK_API_KEY_ENV = "DEEPSEEK_API_KEY";
const KEEL_HOME_ENV = "KEEL_HOME";
const PATH_ENV = "PATH";

describe("Eval Runner", () => {
  test(`Given provider selection is stored in the user's Keel home,
    When a memory pair isolates its memory store,
    Then both arms preserve the configured provider`, async () => {
    // Given
    const { root, suiteDir, outFile } = await createEvalDir();
    const taskId = "configured-provider";
    const configuredHome = join(root, "configured-home");
    const configPath = join(configuredHome, "config.json");
    const mutateConfigScript = join(root, "mutate-provider-config.mjs");
    await mkdir(configuredHome, { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({ schemaVersion: 1, provider: { id: "fake" } }),
      "utf8",
    );
    await writeFile(
      mutateConfigScript,
      `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(configPath)}, ${JSON.stringify(
        JSON.stringify({ schemaVersion: 1, provider: { id: "qwen" } }),
      )});
`,
      "utf8",
    );
    await createMemoryPairTask(suiteDir, taskId, {
      prompt: "create result.json",
      verify: `test -f result.json\nnode ${JSON.stringify(mutateConfigScript)}\n`,
      solution: "printf '{\"created\":true}\\n' > result.json\n",
      timeoutMs: 10_000,
      scriptTimeoutMs: 10_000,
      allowBash: false,
      maxCostUsd: 0.01,
      memory: "A project fact.",
    });
    await writeFile(
      join(configuredHome, "auth.json"),
      JSON.stringify({
        schemaVersion: 1,
        providers: { deepseek: { apiKey: "persisted-test-key" } },
      }),
      "utf8",
    );
    const previousProvider = process.env[KEEL_PROVIDER_ENV];
    const previousHome = process.env[KEEL_HOME_ENV];
    const previousDeepseekKey = process.env[DEEPSEEK_API_KEY_ENV];
    delete process.env[KEEL_PROVIDER_ENV];
    process.env[KEEL_HOME_ENV] = configuredHome;
    process.env[DEEPSEEK_API_KEY_ENV] = "";

    try {
      // When
      const exitCode = await runEvalCommand({
        suiteDir,
        outFile,
        trials: 1,
        check: false,
        cliEntry: CLI_ENTRY,
      });

      // Then
      expect(exitCode).toBe(0);
      expect(await readResultLines(outFile)).toMatchObject([
        { report: { modelsUsed: [{ provider: "fake", model: "fake" }] } },
        { report: { modelsUsed: [{ provider: "fake", model: "fake" }] } },
      ]);
      await expect(readFile(configPath, "utf8")).resolves.toContain("qwen");
    } finally {
      if (previousProvider === undefined) delete process.env[KEEL_PROVIDER_ENV];
      else process.env[KEEL_PROVIDER_ENV] = previousProvider;
      if (previousHome === undefined) delete process.env[KEEL_HOME_ENV];
      else process.env[KEEL_HOME_ENV] = previousHome;
      if (previousDeepseekKey === undefined)
        delete process.env[DEEPSEEK_API_KEY_ENV];
      else process.env[DEEPSEEK_API_KEY_ENV] = previousDeepseekKey;
      await rm(root, { recursive: true, force: true });
    }
  });

  test(`Given a memory-paired task needs the seeded memory,
    When the disabled arm fails verification and the enabled arm passes,
    Then the paired trial passes and records both conditions`, async () => {
    // Given
    const { root, suiteDir, outFile } = await createEvalDir();
    const taskId = "memory-dependent";
    await createMemoryPairTask(suiteDir, taskId, {
      prompt: "write the remembered release command",
      verify: "test -f release-command.txt\n",
      solution: "printf 'pnpm test:coverage\\n' > release-command.txt\n",
      timeoutMs: 10_000,
      scriptTimeoutMs: 10_000,
      allowBash: false,
      maxCostUsd: 0.01,
      memory: "The release command is pnpm test:coverage.",
    });
    const cliEntry = join(root, "memory-pair-cli.mjs");
    await writeFile(
      cliEntry,
      `import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
const args = process.argv.slice(2);
if (args[0] === "memory" && args[1] === "add") process.exit(0);
const reportIndex = args.indexOf("--report");
writeFileSync(args[reportIndex + 1], JSON.stringify(${JSON.stringify(VALID_REPORT)}));
const transcriptIndex = args.indexOf("--transcript");
mkdirSync(dirname(args[transcriptIndex + 1]), { recursive: true });
writeFileSync(args[transcriptIndex + 1], '{"schemaVersion":1,"type":"transcript","provider":"fake","model":"fake","systemPrompt":"test"}\\n');
if (!args.includes("--no-memory")) writeFileSync("release-command.txt", "pnpm test:coverage\\n");
`,
      "utf8",
    );

    try {
      // When
      const exitCode = await runEvalCommand({
        suiteDir,
        outFile,
        trials: 1,
        check: false,
        cliEntry,
        transcriptDir: join(root, "transcripts"),
      });

      // Then
      expect(exitCode).toBe(0);
      expect(await readResultLines(outFile)).toMatchObject([
        {
          condition: "memory_disabled",
          requiredToPass: false,
          outcome: "verify_failed",
          transcriptPath: expect.stringContaining("memory-disabled.jsonl"),
        },
        {
          condition: "memory_enabled",
          requiredToPass: true,
          outcome: "verified",
          transcriptPath: expect.stringContaining("memory-enabled.jsonl"),
        },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test.each([
    {
      name: "disabled arm crashes",
      scriptTimeoutMs: 10_000,
      verify: "if test -f release-command.txt; then exit 0; else exit 1; fi\n",
      action:
        'if (disabled) process.exit(1); writeFileSync("release-command.txt", "pnpm test:coverage\\n");',
      disabledOutcome: "crashed",
      enabledOutcome: "verified",
      expectedExitCode: 1,
    },
    {
      name: "disabled verifier times out",
      scriptTimeoutMs: 500,
      verify:
        "if test -f disabled-arm; then sleep 5; fi\ntest -f release-command.txt\n",
      action:
        'writeFileSync(disabled ? "disabled-arm" : "release-command.txt", "pnpm test:coverage\\n");',
      disabledOutcome: "timeout",
      enabledOutcome: "verified",
      expectedExitCode: 1,
    },
    {
      name: "enabled arm fails verification",
      scriptTimeoutMs: 10_000,
      verify: "test -f release-command.txt\n",
      action: "",
      disabledOutcome: "verify_failed",
      enabledOutcome: "verify_failed",
      expectedExitCode: 1,
    },
    {
      name: "both arms verify independently",
      scriptTimeoutMs: 10_000,
      verify: "test -f release-command.txt\n",
      action: 'writeFileSync("release-command.txt", "pnpm test:coverage\\n");',
      disabledOutcome: "verified",
      enabledOutcome: "verified",
      expectedExitCode: 0,
    },
    {
      name: "verifier is terminated by a signal",
      scriptTimeoutMs: 10_000,
      verify: "kill -TERM $$\n",
      action: "",
      disabledOutcome: "crashed",
      enabledOutcome: "crashed",
      expectedExitCode: 1,
    },
  ] as const)(
    `Given a memory pair whose $name,
    When the eval runner applies the pair gate,
    Then it returns the expected gate result with explicit arm outcomes`,
    async ({
      scriptTimeoutMs,
      verify,
      action,
      disabledOutcome,
      enabledOutcome,
      expectedExitCode,
    }) => {
      // Given
      const { root, suiteDir, outFile } = await createEvalDir();
      const taskId = "invalid-memory-pair";
      await createMemoryPairTask(suiteDir, taskId, {
        prompt: "write the remembered release command",
        verify,
        solution: "printf 'pnpm test:coverage\\n' > release-command.txt\n",
        timeoutMs: 10_000,
        scriptTimeoutMs,
        allowBash: false,
        maxCostUsd: 0.01,
        memory: "The release command is pnpm test:coverage.",
      });
      const cliEntry = join(root, "invalid-memory-pair-cli.mjs");
      await writeFile(
        cliEntry,
        `import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "memory" && args[1] === "add") process.exit(0);
const disabled = args.includes("--no-memory");
${action}
const reportIndex = args.indexOf("--report");
writeFileSync(args[reportIndex + 1], JSON.stringify(${JSON.stringify(VALID_REPORT)}));
`,
        "utf8",
      );

      try {
        // When
        const exitCode = await runEvalCommand({
          suiteDir,
          outFile,
          trials: 1,
          check: false,
          cliEntry,
        });

        // Then
        expect(exitCode).toBe(expectedExitCode);
        expect(await readResultLines(outFile)).toMatchObject([
          { condition: "memory_disabled", outcome: disabledOutcome },
          { condition: "memory_enabled", outcome: enabledOutcome },
        ]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  test(`Given a solvable task,
    When the eval runner executes one trial,
    Then it records a verified result line`, async () => {
    // Given
    const { root, suiteDir, outFile } = await createEvalDir();
    await createTask(suiteDir, "fix-note", FIX_NOTE_TASK);

    try {
      // When
      const exitCode = await runEvalCommand({
        suiteDir,
        outFile,
        trials: 1,
        check: false,
        cliEntry: CLI_ENTRY,
      });

      // Then
      expect(exitCode).toBe(0);
      expect(await readResultLines(outFile)).toMatchObject([
        { taskId: "fix-note", trial: 1, pass: true, outcome: "verified" },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test(`Given a verifier rejects the agent result,
    When the eval runner executes the task,
    Then it records a verify failure`, async () => {
    // Given
    const { root, suiteDir, outFile } = await createEvalDir();
    await createTask(suiteDir, "rejects-work", {
      ...FIX_NOTE_TASK,
      verify: "exit 1\n",
    });

    try {
      // When
      const exitCode = await runEvalCommand({
        suiteDir,
        outFile,
        trials: 1,
        check: false,
        cliEntry: CLI_ENTRY,
      });

      // Then
      expect(exitCode).toBe(1);
      expect(await readResultLines(outFile)).toMatchObject([
        { taskId: "rejects-work", pass: false, outcome: "verify_failed" },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test(`Given one task is selected from a suite,
    When the eval runner executes multiple trials,
    Then only the selected task is recorded for each trial`, async () => {
    // Given
    const { root, suiteDir, outFile } = await createEvalDir();
    await createTask(suiteDir, "fix-note", FIX_NOTE_TASK);
    await createTask(suiteDir, "other-task", FIX_NOTE_TASK);

    try {
      // When
      const exitCode = await runEvalCommand({
        suiteDir,
        outFile,
        trials: 2,
        taskId: "fix-note",
        check: false,
        cliEntry: CLI_ENTRY,
      });

      // Then
      expect(exitCode).toBe(0);
      const lines = await readResultLines(outFile);
      expect(lines.map((line) => line.taskId)).toEqual([
        "fix-note",
        "fix-note",
      ]);
      expect(lines.map((line) => line.trial)).toEqual([1, 2]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test(`Given the agent exceeds the task timeout,
    When the eval runner executes the task,
    Then it records a timeout result`, async () => {
    // Given
    const { root, suiteDir, outFile } = await createEvalDir();
    await createTask(suiteDir, "too-slow", { ...FIX_NOTE_TASK, timeoutMs: 1 });

    try {
      // When
      const exitCode = await runEvalCommand({
        suiteDir,
        outFile,
        trials: 1,
        check: false,
        cliEntry: CLI_ENTRY,
      });

      // Then
      expect(exitCode).toBe(1);
      expect(await readResultLines(outFile)).toMatchObject([
        { taskId: "too-slow", pass: false, outcome: "timeout" },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test(`Given a verifier exceeds its script timeout,
    When the eval runner executes the task,
    Then it records a timeout after the agent report is available`, async () => {
    // Given
    const { root, suiteDir, outFile } = await createEvalDir();
    await createTask(suiteDir, "slow-verifier", {
      ...FIX_NOTE_TASK,
      verify: "sleep 10\n",
      scriptTimeoutMs: 1,
    });

    try {
      // When
      const exitCode = await runEvalCommand({
        suiteDir,
        outFile,
        trials: 1,
        check: false,
        cliEntry: CLI_ENTRY,
      });

      // Then
      expect(exitCode).toBe(1);
      expect(await readResultLines(outFile)).toMatchObject([
        { taskId: "slow-verifier", pass: false, outcome: "timeout" },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test(`Given bash is unavailable after an agent trial completes,
    When the eval runner starts the verifier,
    Then it records a crashed harness result`, async () => {
    // Given
    const { root, suiteDir, outFile } = await createEvalDir();
    await createTask(suiteDir, "missing-verifier-shell", FIX_NOTE_TASK);
    const previousPath = process.env[PATH_ENV];
    process.env[PATH_ENV] = "";

    try {
      // When
      const exitCode = await runEvalCommand({
        suiteDir,
        outFile,
        trials: 1,
        check: false,
        cliEntry: CLI_ENTRY,
      });

      // Then
      expect(exitCode).toBe(1);
      expect(await readResultLines(outFile)).toMatchObject([
        {
          taskId: "missing-verifier-shell",
          pass: false,
          outcome: "crashed",
        },
      ]);
    } finally {
      if (previousPath === undefined) delete process.env[PATH_ENV];
      else process.env[PATH_ENV] = previousPath;
      await rm(root, { recursive: true, force: true });
    }
  });

  test(`Given the agent process exits before writing a report,
    When the eval runner executes the task,
    Then it records a crashed result`, async () => {
    // Given
    const { root, suiteDir, outFile } = await createEvalDir();
    await createTask(suiteDir, "provider-crash", FIX_NOTE_TASK);
    process.env[KEEL_PROVIDER_ENV] = "unknown";

    try {
      // When
      const exitCode = await runEvalCommand({
        suiteDir,
        outFile,
        trials: 1,
        check: false,
        cliEntry: CLI_ENTRY,
      });

      // Then
      expect(exitCode).toBe(1);
      expect(await readResultLines(outFile)).toMatchObject([
        { taskId: "provider-crash", pass: false, outcome: "crashed" },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test(`Given a task enables bash and a max cost budget,
    When the eval runner executes the task,
    Then it passes those task options into the CLI run`, async () => {
    // Given
    const { root, suiteDir, outFile } = await createEvalDir();
    await createTask(suiteDir, "task-options", {
      ...FIX_NOTE_TASK,
      solution: "printf 'hello new world\\n' > note.txt\n",
      verify: 'grep -q "hello new world" note.txt\n',
      maxCostUsd: 1,
      allowBash: true,
    });

    try {
      // When
      const exitCode = await runEvalCommand({
        suiteDir,
        outFile,
        trials: 1,
        check: false,
        cliEntry: CLI_ENTRY,
      });

      // Then
      expect(exitCode).toBe(0);
      expect(await readResultLines(outFile)).toMatchObject([
        { taskId: "task-options", pass: true, outcome: "verified" },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test(`Given fixed delegation-policy tasks require one, forbid, or bound child identities,
    When the eval runner scores reports with child attribution,
    Then matching trajectories verify and a missing required child fails the trial`, async () => {
    const { root, suiteDir, outFile } = await createEvalDir();
    const taskCases = [
      ["positive", "require_one"],
      ["sequential", "forbid"],
      ["duplicate", "at_most_one"],
      ["duplicate-overflow", "at_most_one"],
      ["missing-required", "require_one"],
    ] as const;
    for (const [prompt, delegationPolicy] of taskCases) {
      await createTask(suiteDir, prompt, {
        prompt,
        verify: "exit 0\n",
        solution: "exit 0\n",
        maxCostUsd: 0.1,
        experimentalAgents: true,
        delegationPolicy,
      });
    }
    const childOperation = {
      ...VALID_REPORT.modelOperations[0],
      purpose: "subagent_turn",
      attribution: {
        type: "subagent",
        delegationId: "main:delegate-1",
        childRunId: "subagent-1",
      },
    };
    const reports = {
      positive: {
        ...VALID_REPORT,
        modelOperations: [{ ...childOperation, ordinal: 1 }],
        modelOperationCount: 1,
      },
      sequential: VALID_REPORT,
      duplicate: {
        ...VALID_REPORT,
        modelOperations: [
          { ...childOperation, ordinal: 1 },
          { ...childOperation, ordinal: 2 },
        ],
        modelOperationCount: 2,
        providerRequestAttemptCount: 2,
      },
      "duplicate-overflow": {
        ...VALID_REPORT,
        modelOperations: [
          { ...childOperation, ordinal: 1 },
          {
            ...childOperation,
            ordinal: 2,
            attribution: {
              ...childOperation.attribution,
              childRunId: "subagent-2",
            },
          },
        ],
        modelOperationCount: 2,
        providerRequestAttemptCount: 2,
      },
      "missing-required": VALID_REPORT,
    };
    const cliEntry = join(root, "delegation-policy-cli.mjs");
    await writeFile(
      cliEntry,
      [
        "import { writeFileSync } from 'node:fs';",
        "const args = process.argv.slice(2);",
        "const reportIndex = args.indexOf('--report');",
        `const reports = ${JSON.stringify(reports)};`,
        "writeFileSync(args[reportIndex + 1], JSON.stringify(reports[args.at(-1)]));",
      ].join("\n"),
      "utf8",
    );

    try {
      const exitCode = await runEvalCommand({
        suiteDir,
        outFile,
        trials: 1,
        check: false,
        cliEntry,
      });

      expect(exitCode).toBe(1);
      expect(await readResultLines(outFile)).toMatchObject([
        { taskId: "duplicate", outcome: "verified" },
        { taskId: "duplicate-overflow", outcome: "verify_failed" },
        { taskId: "missing-required", outcome: "verify_failed" },
        { taskId: "positive", outcome: "verified" },
        { taskId: "sequential", outcome: "verified" },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
