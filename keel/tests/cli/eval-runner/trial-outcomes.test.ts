import { describe, expect, test, vi } from "vitest";
import { runReportSchema } from "../../../src/eval/report-schema.ts";
import {
  CLI_ENTRY,
  createDelegationPairTask,
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
  test(`Given a pre-registered delegation calibration task,
    When the user runs paired trials,
    Then task outcome, harness status, and selection stay independent while arms use pristine workspaces in alternating order`, async () => {
    // Given
    const { root, suiteDir, outFile } = await createEvalDir();
    const taskId = "delegation-calibration";
    const callLog = join(root, "calls.log");
    await createDelegationPairTask(suiteDir, taskId, {
      prompt: "inspect both independent notes and write result.txt",
      files: { "first.txt": "alpha\n", "second.txt": "beta\n" },
      verify: "test -f result.txt\n",
      solution: "printf 'alpha beta\n' > result.txt\n",
      timeoutMs: 10_000,
      scriptTimeoutMs: 10_000,
      maxCostUsd: 0.01,
      agentPolicy: "auto",
      delegationPolicy: "require_one",
    });
    const childOperation = {
      ...VALID_REPORT.modelOperations[0],
      purpose: "subagent_turn",
      attribution: {
        type: "subagent",
        delegationId: "main:delegate-1",
        childRunId: "subagent-1",
        profile: "explorer",
        effort: null,
      },
    };
    const treatmentReport = {
      ...VALID_REPORT,
      subagents: {
        status: "observed" as const,
        runs: [
          {
            delegationId: "main:delegate-1",
            childRunId: "subagent-1",
            status: "completed" as const,
          },
        ],
      },
      modelOperations: [childOperation],
    };
    const cliEntry = join(root, "delegation-pair-cli.mjs");
    await writeFile(
      cliEntry,
      `import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
const args = process.argv.slice(2);
const policyIndex = args.indexOf("--agent-policy");
const treatment = args[policyIndex + 1] !== "off";
appendFileSync(${JSON.stringify(callLog)}, (treatment ? "treatment" : "control") + ":" + String(existsSync("result.txt")) + "\\n");
if (treatment) writeFileSync("result.txt", "alpha beta\\n");
const reportIndex = args.indexOf("--report");
writeFileSync(args[reportIndex + 1], JSON.stringify(treatment ? ${JSON.stringify(treatmentReport)} : ${JSON.stringify(VALID_REPORT)}));
const transcriptIndex = args.indexOf("--transcript");
mkdirSync(dirname(args[transcriptIndex + 1]), { recursive: true });
writeFileSync(args[transcriptIndex + 1], '{"schemaVersion":1,"type":"transcript","provider":"fake","model":"fake","systemPrompt":"test"}\\n');
`,
      "utf8",
    );
    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    try {
      // When
      const exitCode = await runEvalCommand({
        suiteDir,
        outFile,
        trials: 2,
        check: false,
        cliEntry,
        transcriptDir: join(root, "transcripts"),
      });

      // Then
      expect(exitCode).toBe(0);
      expect(await readResultLines(outFile)).toMatchObject([
        {
          taskId,
          trial: 1,
          condition: "delegation_control",
          requiredToPass: false,
          harnessOutcome: "completed",
          taskOutcome: "verify_failed",
          pass: false,
          transcriptPath: expect.stringContaining("delegation-control.jsonl"),
        },
        {
          taskId,
          trial: 1,
          condition: "delegation_treatment",
          requiredToPass: true,
          harnessOutcome: "completed",
          taskOutcome: "verified",
          pass: true,
          delegationSelection: {
            status: "observed",
            policy: "require_one",
            childRuns: 1,
            satisfied: true,
          },
          transcriptPath: expect.stringContaining("delegation-treatment.jsonl"),
        },
        {
          taskId,
          trial: 2,
          condition: "delegation_control",
          harnessOutcome: "completed",
          taskOutcome: "verify_failed",
        },
        {
          taskId,
          trial: 2,
          condition: "delegation_treatment",
          harnessOutcome: "completed",
          taskOutcome: "verified",
          delegationSelection: {
            status: "observed",
            policy: "require_one",
            childRuns: 1,
            satisfied: true,
          },
        },
      ]);
      await expect(readFile(callLog, "utf8")).resolves.toBe(
        "control:false\ntreatment:false\ntreatment:false\ncontrol:false\n",
      );
      expect(
        stdout.mock.calls.map(([chunk]) => String(chunk)).join(""),
      ).toContain(
        `${taskId}: control 0/2, treatment 2/2, expected selection 2/2`,
      );
    } finally {
      stdout.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  test(`Given subagent attribution is part of the current report schema,
    When a report mismatches child purpose and identity,
    Then invalid combinations are rejected while attributed child compaction remains valid`, () => {
    // Given
    const mainOperation = VALID_REPORT.modelOperations[0];
    const attribution = {
      type: "subagent" as const,
      delegationId: "main:delegate-1",
      childRunId: "subagent-1",
      profile: "explorer",
      effort: null,
    };

    // When
    const childWithoutAttribution = runReportSchema.safeParse({
      ...VALID_REPORT,
      modelOperations: [{ ...mainOperation, purpose: "subagent_turn" }],
    });
    const mainWithChildAttribution = runReportSchema.safeParse({
      ...VALID_REPORT,
      modelOperations: [{ ...mainOperation, attribution }],
    });
    const attributedChildCompaction = runReportSchema.safeParse({
      ...VALID_REPORT,
      modelOperations: [
        {
          ...mainOperation,
          purpose: "context_compaction",
          attribution,
        },
      ],
    });

    // Then
    expect(childWithoutAttribution.success).toBe(false);
    expect(mainWithChildAttribution.success).toBe(false);
    expect(attributedChildCompaction.success).toBe(true);
  });

  test(`Given delegation pair arms can fail at different independent gates,
    When the runner has no transcript directory,
    Then harness, task, and unavailable selection failures stay separately observable`, async () => {
    // Given
    const { root, suiteDir, outFile } = await createEvalDir();
    for (const taskId of [
      "control-only",
      "missing-report",
      "selection-missing",
    ]) {
      await createDelegationPairTask(suiteDir, taskId, {
        prompt: taskId,
        verify: "test -f result.txt\n",
        solution: "touch result.txt\n",
        timeoutMs: 10_000,
        scriptTimeoutMs: 10_000,
        maxCostUsd: 0.01,
        agentPolicy: "auto",
        delegationPolicy: "require_one",
      });
    }
    const cliEntry = join(root, "delegation-failure-cli.mjs");
    await writeFile(
      cliEntry,
      `import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const policyIndex = args.indexOf("--agent-policy");
const treatment = args[policyIndex + 1] !== "off";
const prompt = args.at(-1);
if (prompt !== "missing-report") {
  const reportIndex = args.indexOf("--report");
  writeFileSync(args[reportIndex + 1], ${JSON.stringify(JSON.stringify(VALID_REPORT))});
}
if (prompt === "selection-missing" || (prompt === "control-only" && !treatment)) {
  writeFileSync("result.txt", "done\\n");
}
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
      expect(exitCode).toBe(1);
      expect(await readResultLines(outFile)).toMatchObject([
        {
          taskId: "control-only",
          condition: "delegation_control",
          harnessOutcome: "completed",
          taskOutcome: "verified",
        },
        {
          taskId: "control-only",
          condition: "delegation_treatment",
          harnessOutcome: "completed",
          taskOutcome: "verify_failed",
          delegationSelection: { status: "observed", satisfied: false },
        },
        {
          taskId: "missing-report",
          condition: "delegation_control",
          harnessOutcome: "crashed",
        },
        {
          taskId: "missing-report",
          condition: "delegation_treatment",
          harnessOutcome: "crashed",
          delegationSelection: { status: "unavailable" },
        },
        {
          taskId: "selection-missing",
          condition: "delegation_control",
          harnessOutcome: "completed",
          taskOutcome: "verified",
        },
        {
          taskId: "selection-missing",
          condition: "delegation_treatment",
          harnessOutcome: "completed",
          taskOutcome: "verified",
          delegationSelection: { status: "observed", satisfied: false },
        },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test(`Given a result destination becomes unwritable after paired arms run,
    When the runner appends their result lines,
    Then it returns a harness error instead of reporting a successful task`, async () => {
    // Given
    const { root, suiteDir, outFile } = await createEvalDir();
    await createDelegationPairTask(suiteDir, "unwritable-results", {
      prompt: "unwritable-results",
      verify: "test -f result.txt\n",
      solution: "touch result.txt\n",
      timeoutMs: 10_000,
      scriptTimeoutMs: 10_000,
      maxCostUsd: 0.01,
      agentPolicy: "auto",
      delegationPolicy: "forbid",
    });
    const cliEntry = join(root, "delegation-unwritable-cli.mjs");
    await writeFile(
      cliEntry,
      `import { mkdirSync, rmSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const reportIndex = args.indexOf("--report");
writeFileSync(args[reportIndex + 1], ${JSON.stringify(JSON.stringify(VALID_REPORT))});
writeFileSync("result.txt", "done\\n");
rmSync(${JSON.stringify(outFile)}, { recursive: true, force: true });
mkdirSync(${JSON.stringify(outFile)});
`,
      "utf8",
    );
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

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
      expect(exitCode).toBe(1);
      expect(
        stderr.mock.calls.map(([chunk]) => String(chunk)).join(""),
      ).toContain("cannot write eval results");
    } finally {
      stderr.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

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
          harnessOutcome: "completed",
          taskOutcome: "verify_failed",
          transcriptPath: expect.stringContaining("memory-disabled.jsonl"),
        },
        {
          condition: "memory_enabled",
          requiredToPass: true,
          harnessOutcome: "completed",
          taskOutcome: "verified",
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
      disabledObservation: { harnessOutcome: "crashed" },
      enabledObservation: {
        harnessOutcome: "completed",
        taskOutcome: "verified",
      },
      expectedExitCode: 1,
    },
    {
      name: "disabled verifier times out",
      scriptTimeoutMs: 500,
      verify:
        "if test -f disabled-arm; then sleep 5; fi\ntest -f release-command.txt\n",
      action:
        'writeFileSync(disabled ? "disabled-arm" : "release-command.txt", "pnpm test:coverage\\n");',
      disabledObservation: { harnessOutcome: "timeout" },
      enabledObservation: {
        harnessOutcome: "completed",
        taskOutcome: "verified",
      },
      expectedExitCode: 1,
    },
    {
      name: "enabled arm fails verification",
      scriptTimeoutMs: 10_000,
      verify: "test -f release-command.txt\n",
      action: "",
      disabledObservation: {
        harnessOutcome: "completed",
        taskOutcome: "verify_failed",
      },
      enabledObservation: {
        harnessOutcome: "completed",
        taskOutcome: "verify_failed",
      },
      expectedExitCode: 1,
    },
    {
      name: "both arms verify independently",
      scriptTimeoutMs: 10_000,
      verify: "test -f release-command.txt\n",
      action: 'writeFileSync("release-command.txt", "pnpm test:coverage\\n");',
      disabledObservation: {
        harnessOutcome: "completed",
        taskOutcome: "verified",
      },
      enabledObservation: {
        harnessOutcome: "completed",
        taskOutcome: "verified",
      },
      expectedExitCode: 0,
    },
    {
      name: "verifier is terminated by a signal",
      scriptTimeoutMs: 10_000,
      verify: "kill -TERM $$\n",
      action: "",
      disabledObservation: { harnessOutcome: "crashed" },
      enabledObservation: { harnessOutcome: "crashed" },
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
      disabledObservation,
      enabledObservation,
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
          { condition: "memory_disabled", ...disabledObservation },
          { condition: "memory_enabled", ...enabledObservation },
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
        {
          taskId: "fix-note",
          trial: 1,
          pass: true,
          harnessOutcome: "completed",
          taskOutcome: "verified",
        },
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
        {
          taskId: "rejects-work",
          pass: false,
          harnessOutcome: "completed",
          taskOutcome: "verify_failed",
        },
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
        { taskId: "too-slow", pass: false, harnessOutcome: "timeout" },
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
        { taskId: "slow-verifier", pass: false, harnessOutcome: "timeout" },
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
          harnessOutcome: "crashed",
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
        { taskId: "provider-crash", pass: false, harnessOutcome: "crashed" },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test(`Given the agent exits non-zero after writing a valid failure report,
    When the eval runner records the crashed trial,
    Then it preserves the report for failure diagnosis`, async () => {
    // Given
    const { root, suiteDir, outFile } = await createEvalDir();
    await createTask(suiteDir, "reported-provider-crash", FIX_NOTE_TASK);
    const failureReport = {
      ...VALID_REPORT,
      stopReason: "failed",
      failure: {
        category: "provider_network_error",
        message: "DeepSeek stream failed",
      },
    };
    const cliEntry = join(root, "reported-provider-crash.mjs");
    await writeFile(
      cliEntry,
      `import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const reportIndex = args.indexOf("--report");
writeFileSync(args[reportIndex + 1], ${JSON.stringify(JSON.stringify(failureReport))});
process.exitCode = 1;
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
      expect(exitCode).toBe(1);
      expect(await readResultLines(outFile)).toMatchObject([
        {
          taskId: "reported-provider-crash",
          pass: false,
          harnessOutcome: "crashed",
          report: {
            stopReason: "failed",
            failure: {
              category: "provider_network_error",
              message: "DeepSeek stream failed",
            },
          },
        },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test(`Given a task configures a max cost budget,
    When the eval runner executes the task,
    Then it passes that task option into the CLI run`, async () => {
    // Given
    const { root, suiteDir, outFile } = await createEvalDir();
    await createTask(suiteDir, "task-options", {
      ...FIX_NOTE_TASK,
      solution: "printf 'hello new world\\n' > note.txt\n",
      verify: 'grep -q "hello new world" note.txt\n',
      maxCostUsd: 1,
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
        {
          taskId: "task-options",
          pass: true,
          harnessOutcome: "completed",
          taskOutcome: "verified",
        },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test(`Given fixed delegation-policy tasks require one, multiple, any, forbid, or bound child identities,
    When the eval runner scores reports with child attribution,
    Then task outcomes remain verified while independent selection observations fail the gate`, async () => {
    const { root, suiteDir, outFile } = await createEvalDir();
    const taskCases = [
      ["positive", "require_one"],
      ["sequential", "forbid"],
      ["duplicate", "at_most_one"],
      ["duplicate-overflow", "at_most_one"],
      ["failed-multiple", "require_multiple"],
      ["missing-required", "require_one"],
      ["parallel", "require_multiple"],
      ["parallel-any", "require_any"],
      ["parallel-single", "require_multiple"],
    ] as const;
    for (const [prompt, delegationPolicy] of taskCases) {
      await createTask(suiteDir, prompt, {
        prompt,
        verify: "exit 0\n",
        solution: "exit 0\n",
        maxCostUsd: 0.1,
        agentPolicy: "auto",
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
        profile: "explorer",
        effort: null,
      },
    };
    const observedChildRuns = (
      ...runs: readonly (readonly [string, "completed" | "failed"])[]
    ) => ({
      status: "observed" as const,
      runs: runs.map(([childRunId, status]) => ({
        delegationId: "main:delegate-1",
        childRunId,
        status,
      })),
    });
    const reports = {
      positive: {
        ...VALID_REPORT,
        subagents: observedChildRuns(["subagent-1", "completed"]),
        modelOperations: [{ ...childOperation, ordinal: 1 }],
        modelOperationCount: 1,
      },
      sequential: VALID_REPORT,
      duplicate: {
        ...VALID_REPORT,
        subagents: observedChildRuns(["subagent-1", "completed"]),
        modelOperations: [
          { ...childOperation, ordinal: 1 },
          { ...childOperation, ordinal: 2 },
        ],
        modelOperationCount: 2,
        providerRequestAttemptCount: 2,
      },
      "duplicate-overflow": {
        ...VALID_REPORT,
        subagents: observedChildRuns(
          ["subagent-1", "completed"],
          ["subagent-2", "completed"],
        ),
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
      "failed-multiple": {
        ...VALID_REPORT,
        subagents: observedChildRuns(
          ["subagent-1", "failed"],
          ["subagent-2", "failed"],
        ),
        modelOperations: [
          { ...childOperation, ordinal: 1, outcome: "terminal_error" },
          {
            ...childOperation,
            ordinal: 2,
            outcome: "terminal_error",
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
      parallel: {
        ...VALID_REPORT,
        subagents: observedChildRuns(
          ["subagent-1", "completed"],
          ["subagent-2", "completed"],
        ),
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
      "parallel-any": {
        ...VALID_REPORT,
        subagents: observedChildRuns(
          ["subagent-1", "completed"],
          ["subagent-2", "completed"],
        ),
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
      "parallel-single": {
        ...VALID_REPORT,
        subagents: observedChildRuns(["subagent-1", "completed"]),
        modelOperations: [{ ...childOperation, ordinal: 1 }],
        modelOperationCount: 1,
      },
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
        {
          taskId: "duplicate",
          taskOutcome: "verified",
          delegationSelection: {
            status: "observed",
            childRuns: 1,
            satisfied: true,
          },
        },
        {
          taskId: "duplicate-overflow",
          taskOutcome: "verified",
          delegationSelection: {
            status: "observed",
            childRuns: 2,
            satisfied: false,
          },
        },
        {
          taskId: "failed-multiple",
          taskOutcome: "verified",
          delegationSelection: {
            status: "observed",
            childRuns: 0,
            satisfied: false,
          },
        },
        {
          taskId: "missing-required",
          taskOutcome: "verified",
          delegationSelection: {
            status: "observed",
            childRuns: 0,
            satisfied: false,
          },
        },
        {
          taskId: "parallel",
          taskOutcome: "verified",
          delegationSelection: {
            status: "observed",
            childRuns: 2,
            satisfied: true,
          },
        },
        {
          taskId: "parallel-any",
          taskOutcome: "verified",
          delegationSelection: {
            status: "observed",
            childRuns: 2,
            satisfied: true,
          },
        },
        {
          taskId: "parallel-single",
          taskOutcome: "verified",
          delegationSelection: {
            status: "observed",
            childRuns: 1,
            satisfied: false,
          },
        },
        {
          taskId: "positive",
          taskOutcome: "verified",
          delegationSelection: {
            status: "observed",
            childRuns: 1,
            satisfied: true,
          },
        },
        {
          taskId: "sequential",
          taskOutcome: "verified",
          delegationSelection: {
            status: "observed",
            childRuns: 0,
            satisfied: true,
          },
        },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test(`Given a standard eval requires one exact subagent execution,
    When one verified trial uses that profile tuple and another uses the wrong effort,
    Then the exact trial passes selection and the mismatched trial fails the suite gate`, async () => {
    const { root, suiteDir, outFile } = await createEvalDir();
    const delegationExpectation = {
      profile: "repo:focused-review",
      providerId: "deepseek",
      model: "deepseek-v4-pro",
      effort: "max",
    } as const;
    for (const prompt of ["exact-execution", "wrong-effort"] as const) {
      await createTask(suiteDir, prompt, {
        prompt,
        verify: "exit 0\n",
        solution: "exit 0\n",
        maxCostUsd: 0.1,
        agentPolicy: "explicit",
        delegationPolicy: "require_one",
        delegationExpectation,
      });
    }
    const childOperation = {
      ...VALID_REPORT.modelOperations[0],
      provider: "deepseek",
      model: "deepseek-v4-pro",
      purpose: "subagent_turn",
      attribution: {
        type: "subagent",
        delegationId: "main:delegate-1",
        childRunId: "subagent-1",
        profile: "repo:focused-review",
        effort: "max",
      },
    };
    const reports = {
      "exact-execution": {
        ...VALID_REPORT,
        subagents: {
          status: "observed",
          runs: [
            {
              delegationId: "main:delegate-1",
              childRunId: "subagent-1",
              status: "completed",
            },
          ],
        },
        modelOperations: [childOperation],
        modelOperationCount: 1,
      },
      "wrong-effort": {
        ...VALID_REPORT,
        subagents: {
          status: "observed",
          runs: [
            {
              delegationId: "main:delegate-1",
              childRunId: "subagent-1",
              status: "completed",
            },
          ],
        },
        modelOperations: [
          {
            ...childOperation,
            attribution: { ...childOperation.attribution, effort: "high" },
          },
        ],
        modelOperationCount: 1,
      },
    };
    const cliEntry = join(root, "delegation-execution-cli.mjs");
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
        {
          taskId: "exact-execution",
          taskOutcome: "verified",
          delegationSelection: {
            status: "observed",
            expectedExecution: delegationExpectation,
            matchingChildRuns: 1,
            satisfied: true,
          },
        },
        {
          taskId: "wrong-effort",
          taskOutcome: "verified",
          delegationSelection: {
            status: "observed",
            expectedExecution: delegationExpectation,
            matchingChildRuns: 0,
            satisfied: false,
          },
        },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
