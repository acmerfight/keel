import { describe, expect, test, vi } from "vitest";
import {
  CLI_ENTRY,
  createEvalDir,
  createTask,
  join,
  readFile,
  readResultLines,
  rm,
  runEvalCommand,
  VALID_REPORT,
  writeFile,
} from "./fixtures.ts";

describe("Eval Runner Memory Pairs", () => {
  test.each([
    {
      name: "duplicates an alias",
      memorySetup: [
        {
          operation: "add",
          alias: "fact",
          text: "First fact.",
          lifecycle: "current",
        },
        {
          operation: "add",
          alias: "fact",
          text: "Second fact.",
          lifecycle: "current",
        },
      ],
    },
    {
      name: "targets an inactive alias",
      memorySetup: [
        {
          operation: "update",
          target: "missing",
          alias: "replacement",
          text: "Replacement fact.",
          lifecycle: "current",
        },
      ],
    },
  ])(`Given memory setup $name,
    When the eval runner loads the strict task definition,
    Then it rejects the fixture before executing a provider`, async ({
    memorySetup,
  }) => {
    // Given
    const { root, suiteDir, outFile } = await createEvalDir();
    const taskId = "invalid-memory-setup";
    await createTask(suiteDir, taskId, {
      prompt: "create result.json",
      verify: "test -f result.json\n",
    });
    await writeFile(
      join(suiteDir, taskId, "task.json"),
      JSON.stringify({
        kind: "memory_pair",
        corpusVersion: "memory-v1",
        prompt: "create result.json",
        timeoutMs: 60_000,
        scriptTimeoutMs: 10_000,
        allowBash: false,
        maxCostUsd: 0.05,
        passPolicy: "both_must_pass",
        forbiddenAttempts: [],
        requiredToolEvidence: [],
        memorySetup,
      }),
      "utf8",
    );

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
      await expect(readFile(outFile, "utf8")).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test(`Given a forbidden-attempt rule names a nonexistent tool,
    When the eval runner loads the strict task definition,
    Then it rejects the typo before executing a provider`, async () => {
    const { root, suiteDir, outFile } = await createEvalDir();
    const taskId = "invalid-forbidden-tool";
    await createTask(suiteDir, taskId, {
      prompt: "create result.json",
      verify: "test -f result.json\n",
    });
    await writeFile(
      join(suiteDir, taskId, "task.json"),
      JSON.stringify({
        kind: "memory_pair",
        corpusVersion: "memory-v1",
        prompt: "create result.json",
        timeoutMs: 60_000,
        scriptTimeoutMs: 10_000,
        allowBash: false,
        maxCostUsd: 0.05,
        passPolicy: "both_must_pass",
        memorySetup: [
          {
            operation: "add",
            alias: "fact",
            text: "The durable fact is alpha.",
            lifecycle: "current",
          },
        ],
        forbiddenAttempts: [
          {
            source: "tool_arguments",
            tools: ["wirte"],
            contains: "PWNED",
            failure: "invalid tool name",
          },
        ],
        requiredToolEvidence: [],
      }),
      "utf8",
    );

    try {
      expect(
        await runEvalCommand({
          suiteDir,
          outFile,
          trials: 1,
          check: false,
          cliEntry: CLI_ENTRY,
        }),
      ).toBe(1);
      await expect(readFile(outFile, "utf8")).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test(`Given a memory task omits the required tool-evidence contract,
    When the eval runner loads the task definition,
    Then it rejects the task instead of defaulting the field`, async () => {
    const { root, suiteDir, outFile } = await createEvalDir();
    const taskId = "missing-required-tool-evidence";
    await createTask(suiteDir, taskId, {
      prompt: "create result.json",
      verify: "test -f result.json\n",
    });
    await writeFile(
      join(suiteDir, taskId, "task.json"),
      JSON.stringify({
        kind: "memory_pair",
        corpusVersion: "memory-v1",
        prompt: "create result.json",
        timeoutMs: 60_000,
        scriptTimeoutMs: 10_000,
        allowBash: false,
        maxCostUsd: 0.05,
        passPolicy: "both_must_pass",
        memorySetup: [
          {
            operation: "add",
            alias: "fact",
            text: "The durable fact is alpha.",
            lifecycle: "current",
          },
        ],
        forbiddenAttempts: [],
      }),
      "utf8",
    );

    try {
      expect(
        await runEvalCommand({
          suiteDir,
          outFile,
          trials: 1,
          check: false,
          cliEntry: CLI_ENTRY,
        }),
      ).toBe(1);
      await expect(readFile(outFile, "utf8")).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test(`Given a task defines governed project memory,
    When the eval runner executes one trial,
    Then it records isolated disabled and enabled runs with the same configured memory`, async () => {
    // Given
    const { root, suiteDir, outFile } = await createEvalDir();
    const transcriptDir = join(root, "transcripts");
    const taskId = "release-validation-memory";
    await createTask(suiteDir, taskId, {
      prompt: "create result.json",
      verify: "test -f result.json\n",
      solution: "printf '{\"created\":true}\\n' > result.json\n",
      timeoutMs: 60_000,
    });
    await writeFile(
      join(suiteDir, taskId, "task.json"),
      JSON.stringify({
        kind: "memory_pair",
        corpusVersion: "memory-v1",
        prompt: "create result.json",
        timeoutMs: 60_000,
        scriptTimeoutMs: 10_000,
        allowBash: false,
        maxCostUsd: 0.05,
        passPolicy: "both_must_pass",
        forbiddenAttempts: [],
        requiredToolEvidence: [],
        memorySetup: [
          {
            operation: "add",
            alias: "release-command",
            text: "Release validation command is pnpm test:coverage.",
            lifecycle: "current",
          },
        ],
      }),
      "utf8",
    );

    try {
      // When
      const exitCode = await runEvalCommand({
        suiteDir,
        outFile,
        trials: 1,
        transcriptDir,
        check: false,
        cliEntry: CLI_ENTRY,
      });

      // Then
      expect(exitCode).toBe(0);
      const lines = (await readFile(outFile, "utf8"))
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(lines).toHaveLength(2);
      expect(lines).toMatchObject([
        {
          schemaVersion: 2,
          corpusVersion: "memory-v1",
          taskId,
          trial: 1,
          condition: "memory_disabled",
          requiredToPass: true,
          pass: true,
          structuralFailures: [],
          memory: {
            mode: "disabled",
            configuredIds: [expect.stringMatching(/^mem_/u)],
            scope: { kind: "project", id: expect.any(String) },
          },
          report: {
            memory: {
              enabled: false,
              scope: null,
              loadedIds: [],
              loadedEntries: [],
              renderedBytes: 0,
              operations: [],
            },
          },
        },
        {
          schemaVersion: 2,
          corpusVersion: "memory-v1",
          taskId,
          trial: 1,
          condition: "memory_enabled",
          requiredToPass: true,
          pass: true,
          structuralFailures: [],
          memory: {
            mode: "enabled",
            configuredIds: [expect.stringMatching(/^mem_/u)],
            scope: { kind: "project", id: expect.any(String) },
          },
          report: {
            memory: {
              enabled: true,
              scope: { kind: "project", id: expect.any(String) },
              loadedIds: [expect.stringMatching(/^mem_/u)],
              loadedEntries: [
                expect.objectContaining({
                  id: expect.stringMatching(/^mem_/u),
                  status: "current",
                }),
              ],
              renderedBytes: expect.any(Number),
              operations: [],
            },
          },
        },
      ]);
      expect(lines[0].memory.configuredIds).toEqual(
        lines[1].memory.configuredIds,
      );
      expect(lines[0].memory.scope).toEqual(lines[1].memory.scope);
      expect(lines[0].transcriptPath).toContain("-memory-disabled.jsonl");
      expect(lines[1].transcriptPath).toContain("-memory-enabled.jsonl");
      const workspaceRoots = await Promise.all(
        lines.map(async (line) => {
          const firstRecord =
            (await readFile(line.transcriptPath, "utf8")).split("\n", 1)[0] ??
            "";
          const systemPrompt = JSON.parse(firstRecord).systemPrompt;
          return systemPrompt.match(/^- Workspace root: (.+)$/mu)?.[1];
        }),
      );
      expect(workspaceRoots).toEqual([
        expect.stringContaining("/workspace"),
        workspaceRoots[0],
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test(`Given only the enabled arm lacks required tool evidence,
    When the paired runner reports its aggregate score,
    Then it records and prints the negative enabled-minus-disabled delta`, async () => {
    const { root, suiteDir, outFile } = await createEvalDir();
    const taskId = "missing-enabled-tool-evidence";
    await createTask(suiteDir, taskId, {
      prompt: "create result.json",
      verify: "test -f result.json\n",
      solution: "printf '{\"created\":true}\\n' > result.json\n",
      timeoutMs: 60_000,
    });
    await writeFile(
      join(suiteDir, taskId, "task.json"),
      JSON.stringify({
        kind: "memory_pair",
        corpusVersion: "memory-v1",
        prompt: "create result.json",
        timeoutMs: 60_000,
        scriptTimeoutMs: 10_000,
        allowBash: false,
        maxCostUsd: 0.05,
        passPolicy: "both_must_pass",
        forbiddenAttempts: [],
        requiredToolEvidence: [
          {
            condition: "memory_enabled",
            tool: "read",
            path: "never-read.md",
            beforeTools: ["write"],
            failure: "required repository read was missing",
          },
        ],
        memorySetup: [
          {
            operation: "add",
            alias: "fact",
            text: "The durable fact is alpha.",
            lifecycle: "current",
          },
        ],
      }),
      "utf8",
    );
    let stdout = "";
    const writeStdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        stdout += chunk.toString();
        return true;
      });

    try {
      expect(
        await runEvalCommand({
          suiteDir,
          outFile,
          trials: 1,
          check: false,
          cliEntry: CLI_ENTRY,
        }),
      ).toBe(1);
      const lines = await readResultLines(outFile);
      expect(lines.map((line) => line.pass)).toEqual([true, false]);
      expect(lines[1]?.behavioralFailures).toContain(
        "required repository read was missing",
      );
      expect(lines[0]?.pairDelta?.successPercentagePoints).toBe(-100);
      expect(stdout).toContain("delta -100.0pp");
    } finally {
      writeStdout.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  test(`Given a non-required disabled baseline crashes,
    When the enabled condition still verifies,
    Then the harness failure fails the paired gate`, async () => {
    // Given
    const { root, suiteDir, outFile } = await createEvalDir();
    const taskId = "crashed-memory-baseline";
    await createTask(suiteDir, taskId, {
      prompt: "leave the workspace unchanged",
      verify: "exit 0\n",
      solution: "exit 0\n",
    });
    await writeFile(
      join(suiteDir, taskId, "task.json"),
      JSON.stringify({
        kind: "memory_pair",
        corpusVersion: "memory-v1",
        prompt: "leave the workspace unchanged",
        timeoutMs: 60_000,
        scriptTimeoutMs: 10_000,
        allowBash: false,
        maxCostUsd: 0.05,
        passPolicy: "enabled_must_pass",
        forbiddenAttempts: [],
        requiredToolEvidence: [],
        memorySetup: [
          {
            operation: "add",
            alias: "fact",
            text: "The durable fact is alpha.",
            lifecycle: "current",
          },
        ],
      }),
      "utf8",
    );
    const enabledReport = {
      ...VALID_REPORT,
      memory: {
        enabled: true,
        scope: { kind: "project", id: "aaaa" },
        loadedIds: ["mem_aaaa"],
        loadedEntries: [
          {
            id: "mem_aaaa",
            status: "current",
            source: { type: "user_explicit", channel: "cli" },
            createdAt: "2026-07-16T00:00:00.000Z",
            lastVerifiedAt: "2026-07-16T00:00:00.000Z",
            supersedes: [],
            supersededBy: null,
            reviewAfter: null,
            expiresAt: null,
          },
        ],
        renderedBytes: 64,
        estimatedTokens: 16,
        operations: [],
      },
    };
    const cliEntry = join(root, "crashed-baseline-cli.js");
    await writeFile(
      cliEntry,
      [
        "import { mkdirSync, writeFileSync } from 'node:fs';",
        "import { dirname } from 'node:path';",
        "const args = process.argv.slice(2);",
        "if (args[0] === 'memory') {",
        "  process.stdout.write('Saved project memory mem_aaaa for aaaa.\\n');",
        "} else if (args.includes('--no-memory')) {",
        "  process.stderr.write('disabled baseline crashed');",
        "  process.exitCode = 1;",
        "} else {",
        "  const reportIndex = args.indexOf('--report');",
        "  const transcriptIndex = args.indexOf('--transcript');",
        "  mkdirSync(dirname(args[transcriptIndex + 1]), { recursive: true });",
        `  writeFileSync(args[reportIndex + 1], ${JSON.stringify(JSON.stringify(enabledReport))}, 'utf8');`,
        `  writeFileSync(args[transcriptIndex + 1], ${JSON.stringify('{"schemaVersion":2,"type":"transcript","provider":"fake","model":"fake","systemPrompt":"The durable fact is alpha."}\n')}, 'utf8');`,
        "}",
      ].join("\n"),
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
      const lines = (await readFile(outFile, "utf8"))
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(lines).toMatchObject([
        {
          provider: "fake",
          model: "fake",
          condition: "memory_disabled",
          requiredToPass: false,
          pass: false,
          outcome: "crashed",
        },
        {
          provider: "fake",
          model: "fake",
          condition: "memory_enabled",
          requiredToPass: true,
          pass: true,
          outcome: "verified",
        },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test(`Given a memory fixture violates the shipped secret boundary,
    When the paired evaluation tries to configure it,
    Then setup fails closed as an explicit structural failure`, async () => {
    // Given
    const { root, suiteDir, outFile } = await createEvalDir();
    const taskId = "reject-secret-fixture";
    await createTask(suiteDir, taskId, {
      prompt: "create result.json",
      verify: "test -f result.json\n",
      timeoutMs: 60_000,
    });
    await writeFile(
      join(suiteDir, taskId, "task.json"),
      JSON.stringify({
        kind: "memory_pair",
        corpusVersion: "memory-v1",
        prompt: "create result.json",
        timeoutMs: 60_000,
        scriptTimeoutMs: 10_000,
        allowBash: false,
        maxCostUsd: 0.05,
        passPolicy: "both_must_pass",
        forbiddenAttempts: [],
        requiredToolEvidence: [],
        memorySetup: [
          {
            operation: "add",
            alias: "secret",
            text: "Use token sk-abcdefghijklmnopqrstuvwxyz1234567890.",
            lifecycle: "current",
          },
        ],
      }),
      "utf8",
    );

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
      const lines = await readResultLines(outFile);
      expect(lines).toHaveLength(2);
      expect(
        lines.every(
          (line) =>
            line.pass === false &&
            line.memory.mode === "setup_failed" &&
            line.structuralFailures.some((failure: string) =>
              failure.startsWith("memory fixture setup failed:"),
            ),
        ),
      ).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test(`Given memory setup updates one fact and forgets another,
    When the paired evaluation runs through the public lifecycle commands,
    Then only the latest non-forgotten IDs are configured and loaded`, async () => {
    // Given
    const { root, suiteDir, outFile } = await createEvalDir();
    const taskId = "lifecycle-fixture";
    await createTask(suiteDir, taskId, {
      prompt: "create result.json",
      verify: "test -f result.json\n",
      timeoutMs: 60_000,
    });
    await writeFile(
      join(suiteDir, taskId, "task.json"),
      JSON.stringify({
        kind: "memory_pair",
        corpusVersion: "memory-v1",
        prompt: "create result.json",
        timeoutMs: 60_000,
        scriptTimeoutMs: 10_000,
        allowBash: false,
        maxCostUsd: 0.05,
        passPolicy: "both_must_pass",
        forbiddenAttempts: [],
        requiredToolEvidence: [],
        memorySetup: [
          {
            operation: "add",
            alias: "old-branch",
            text: "The release branch is old/release.",
            lifecycle: "current",
          },
          {
            operation: "update",
            target: "old-branch",
            alias: "current-branch",
            text: "The release branch is current/release.",
            lifecycle: "stale",
          },
          {
            operation: "add",
            alias: "retired-port",
            text: "The retired port is 7000.",
            lifecycle: "current",
          },
          { operation: "forget", target: "retired-port" },
        ],
      }),
      "utf8",
    );

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
      const lines = (await readFile(outFile, "utf8"))
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(lines[0].memory.configuredIds).toHaveLength(1);
      expect(lines[1]).toMatchObject({
        condition: "memory_enabled",
        structuralFailures: [],
        memory: { configuredIds: lines[0].memory.configuredIds },
        report: {
          memory: {
            loadedIds: lines[0].memory.configuredIds,
            loadedEntries: [
              {
                id: lines[0].memory.configuredIds[0],
                status: "stale",
              },
            ],
          },
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test.each([
    {
      name: "cannot initialize its temporary Git project",
      files: { ".git": "not a gitdir file\n" },
      memorySetup: [
        {
          operation: "add",
          alias: "fact",
          text: "The durable fact is alpha.",
          lifecycle: "current",
        },
      ],
    },
    {
      name: "rejects a secret-like update",
      files: {},
      memorySetup: [
        {
          operation: "add",
          alias: "old-fact",
          text: "The durable fact is alpha.",
          lifecycle: "current",
        },
        {
          operation: "update",
          target: "old-fact",
          alias: "secret-update",
          text: "Use token sk-abcdefghijklmnopqrstuvwxyz1234567890.",
          lifecycle: "current",
        },
      ],
    },
  ])(`Given memory setup $name,
    When the paired fixture is prepared,
    Then both conditions fail closed with one setup failure`, async ({
    files,
    memorySetup,
  }) => {
    // Given
    const { root, suiteDir, outFile } = await createEvalDir();
    const taskId = "failed-lifecycle-setup";
    await createTask(suiteDir, taskId, {
      prompt: "create result.json",
      files,
      verify: "test -f result.json\n",
      timeoutMs: 60_000,
    });
    await writeFile(
      join(suiteDir, taskId, "task.json"),
      JSON.stringify({
        kind: "memory_pair",
        corpusVersion: "memory-v1",
        prompt: "create result.json",
        timeoutMs: 60_000,
        scriptTimeoutMs: 10_000,
        allowBash: false,
        maxCostUsd: 0.05,
        passPolicy: "both_must_pass",
        forbiddenAttempts: [],
        requiredToolEvidence: [],
        memorySetup,
      }),
      "utf8",
    );

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
      const lines = await readResultLines(outFile);
      expect(lines).toHaveLength(2);
      expect(
        lines.every(
          (line) =>
            line.memory.mode === "setup_failed" &&
            line.structuralFailures.length === 1 &&
            line.structuralFailures.some((failure) =>
              failure.startsWith("memory fixture setup failed:"),
            ),
        ),
      ).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test.each([
    {
      name: "changes project scope between public command results",
      script: [
        "import { existsSync, readFileSync, writeFileSync } from 'node:fs';",
        "const state = new URL('./call-count', import.meta.url);",
        "const count = existsSync(state) ? Number(readFileSync(state, 'utf8')) + 1 : 1;",
        "writeFileSync(state, String(count), 'utf8');",
        "const id = count === 1 ? 'aaaa' : 'bbbb';",
        "process.stdout.write('Saved project memory mem_' + id + ' for ' + id + '.\\n');",
      ],
      memorySetup: [
        {
          operation: "add",
          alias: "first",
          text: "First durable fact.",
          lifecycle: "current",
        },
        {
          operation: "add",
          alias: "second",
          text: "Second durable fact.",
          lifecycle: "current",
        },
      ],
      expected: "memory fixture changed project scope while seeding",
    },
    {
      name: "cannot forget the configured target",
      script: [
        "const operation = process.argv[3];",
        "if (operation === 'add') {",
        "  process.stdout.write('Saved project memory mem_aaaa for aaaa.\\n');",
        "} else {",
        "  process.stderr.write('forget unavailable');",
        "  process.exitCode = 1;",
        "}",
      ],
      memorySetup: [
        {
          operation: "add",
          alias: "fact",
          text: "Durable fact.",
          lifecycle: "current",
        },
        { operation: "forget", target: "fact" },
      ],
      expected: "memory forget failed (exit 1)",
    },
  ])(`Given the memory CLI $name,
    When fixture setup validates the command evidence,
    Then the pair fails closed with a concrete setup error`, async ({
    script,
    memorySetup,
    expected,
  }) => {
    // Given
    const { root, suiteDir, outFile } = await createEvalDir();
    const taskId = "invalid-memory-cli-evidence";
    await createTask(suiteDir, taskId, {
      prompt: "create result.json",
      verify: "test -f result.json\n",
    });
    await writeFile(
      join(suiteDir, taskId, "task.json"),
      JSON.stringify({
        kind: "memory_pair",
        corpusVersion: "memory-v1",
        prompt: "create result.json",
        timeoutMs: 60_000,
        scriptTimeoutMs: 10_000,
        allowBash: false,
        maxCostUsd: 0.05,
        passPolicy: "both_must_pass",
        forbiddenAttempts: [],
        requiredToolEvidence: [],
        memorySetup,
      }),
      "utf8",
    );
    const cliEntry = join(root, "memory-proxy.js");
    await writeFile(cliEntry, script.join("\n"), "utf8");

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
      const lines = (await readFile(outFile, "utf8"))
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(
        lines.every((line) =>
          line.structuralFailures.some((failure: string) =>
            failure.includes(expected),
          ),
        ),
      ).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
