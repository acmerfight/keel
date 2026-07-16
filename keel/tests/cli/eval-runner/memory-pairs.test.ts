import { describe, expect, test } from "vitest";
import {
  CLI_ENTRY,
  createEvalDir,
  createTask,
  join,
  readFile,
  rm,
  runEvalCommand,
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

  test(`Given a task defines governed project memory,
    When the eval runner executes one trial,
    Then it records isolated disabled and enabled runs with the same configured memory`, async () => {
    // Given
    const { root, suiteDir, outFile } = await createEvalDir();
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
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test(`Given a memory-dependent task only requires the enabled condition to pass,
    When the disabled baseline fails and the enabled run succeeds,
    Then the baseline remains measured without failing the paired gate`, async () => {
    // Given
    const { root, suiteDir, outFile } = await createEvalDir();
    const taskId = "memory-dependent-policy";
    await createTask(suiteDir, taskId, {
      prompt: "answer without changing files",
      verify:
        'case "$PWD" in */enabled-workspace) exit 0 ;; *) exit 1 ;; esac\n',
      solution: "exit 0\n",
      timeoutMs: 60_000,
    });
    await writeFile(
      join(suiteDir, taskId, "task.json"),
      JSON.stringify({
        kind: "memory_pair",
        corpusVersion: "memory-v1",
        prompt: "answer without changing files",
        timeoutMs: 60_000,
        scriptTimeoutMs: 10_000,
        allowBash: false,
        maxCostUsd: 0.05,
        passPolicy: "enabled_must_pass",
        memorySetup: [
          {
            operation: "add",
            alias: "codename",
            text: "The non-derivable project codename is Tern.",
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
      expect(exitCode).toBe(0);
      const lines = (await readFile(outFile, "utf8"))
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(lines).toMatchObject([
        {
          condition: "memory_disabled",
          requiredToPass: false,
          pass: false,
          outcome: "verify_failed",
          structuralFailures: [],
          pairDelta: { successPercentagePoints: 100 },
        },
        {
          condition: "memory_enabled",
          requiredToPass: true,
          pass: true,
          outcome: "verified",
          structuralFailures: [],
          pairDelta: { successPercentagePoints: 100 },
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
      const lines = (await readFile(outFile, "utf8"))
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(lines).toHaveLength(2);
      expect(
        lines.every(
          (line) =>
            line.pass === false &&
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
            lifecycle: "current",
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
                status: "current",
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
      const lines = (await readFile(outFile, "utf8"))
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(lines).toHaveLength(2);
      expect(
        lines.every(
          (line) =>
            line.structuralFailures.length === 1 &&
            line.structuralFailures[0].startsWith(
              "memory fixture setup failed:",
            ),
        ),
      ).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
