import { describe, expect, test } from "vitest";
import {
  createEvalDir,
  createTask,
  FIX_NOTE_TASK,
  isAbsolute,
  join,
  readFile,
  readResultLines,
  rm,
  runEvalCommand,
  writeFile,
} from "./fixtures.ts";

function modelOperationReportLines(
  provider: string,
  model: string,
): readonly string[] {
  const usage =
    "{ inputTokens: 1, cachedInputTokens: 0, uncachedInputTokens: 1, outputTokens: 1 }";
  return [
    `  modelOperations: [{ ordinal: 1, owner: { type: 'agent_run', taskOrdinal: 1, agentRunOrdinal: 1 }, purpose: 'agent_turn', provider: '${provider}', model: '${model}', outcome: 'completed', providerRequestAttempts: [{ ordinal: 1, outcome: 'completed', usage: ${usage}, costUsd: 0 }], usage: ${usage}, costUsd: 0 }],`,
    "  modelOperationCount: 1,",
    "  providerRequestAttemptCount: 1,",
  ];
}

describe("Eval Runner", () => {
  test(`Given the eval command selects a provider and model,
    When the eval runner executes a trial,
    Then it passes the provider and model flags into the CLI run`, async () => {
    // Given
    const { root, suiteDir, outFile } = await createEvalDir();
    await createTask(suiteDir, "provider-selection", {
      prompt: "record provider args",
      verify: [
        "node -e '",
        'const { readFileSync } = require("node:fs");',
        'const args = JSON.parse(readFileSync("agent-args.json", "utf8"));',
        'const provider = args.indexOf("--provider");',
        'const model = args.indexOf("--model");',
        'if (provider < 0 || args[provider + 1] !== "qwen") process.exit(1);',
        'if (model < 0 || args[model + 1] !== "qwen3.7-plus") process.exit(1);',
        "'\n",
      ].join(" "),
      solution: "printf '[]' > agent-args.json\n",
    });
    const cliEntry = join(root, "record-args-cli.js");
    await writeFile(
      cliEntry,
      [
        "import { writeFileSync } from 'node:fs';",
        "const args = process.argv.slice(2);",
        "const reportIndex = args.indexOf('--report');",
        "writeFileSync('agent-args.json', JSON.stringify(args), 'utf8');",
        "writeFileSync(args[reportIndex + 1], JSON.stringify({",
        "  schemaVersion: 17,",
        "  tasks: [{ ordinal: 1, trigger: 'user_prompt', humanInterventionCount: 0, agentRuns: [{ ordinal: 1, trigger: 'user_prompt', humanInterventionCount: 0, agentLoopTurns: 1, providerRetries: [], contextCompactions: [], stopReason: 'completed' }], outcome: 'completed' }],",
        "  humanInterventionCount: 0,",
        ...modelOperationReportLines("qwen", "qwen3.7-plus"),
        "  modelsUsed: [{ provider: 'qwen', model: 'qwen3.7-plus' }],",
        "  usageByModel: [{ provider: 'qwen', model: 'qwen3.7-plus', agentLoopTurns: 1, usage: { inputTokens: 1, cachedInputTokens: 0, uncachedInputTokens: 1, outputTokens: 1 }, costUsd: 0 }],",
        "  agentLoopTurns: 1,",
        "  stopReason: 'completed',",
        "  usage: { inputTokens: 1, cachedInputTokens: 0, uncachedInputTokens: 1, outputTokens: 1 },",
        "  durationMs: 1,",
        "  costUsd: 0,",
        "  costOvershootUsd: 0,",
        "  contextCompactions: [],",
        "  skillActivations: [], activeSkills: [], skillCatalog: { exposed: 0, omitted: 0, total: 0, budgetChars: 8000, usedChars: 0 },",
        "  skillPolicy: { mode: 'enabled', disabledPackages: 0 },",
        "  undoProtection: { status: 'not_applicable', checkpointsWritten: 0, failures: [], latestCheckpoint: null },",
        "  memory: { enabled: false, scope: null, loadedIds: [], loadedEntries: [], renderedBytes: 0, estimatedTokens: 0, operations: [] }",
        "}), 'utf8');",
      ].join("\n"),
      "utf8",
    );

    try {
      // When
      const exitCode = await runEvalCommand({
        suiteDir,
        outFile,
        trials: 1,
        providerId: "qwen",
        model: "qwen3.7-plus",
        check: false,
        cliEntry,
      });

      // Then
      expect(exitCode).toBe(0);
      expect(await readResultLines(outFile)).toMatchObject([
        {
          taskId: "provider-selection",
          pass: true,
          outcome: "verified",
          report: {
            modelsUsed: [{ provider: "qwen", model: "qwen3.7-plus" }],
          },
        },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test(`Given eval transcripts are enabled,
    When the eval runner executes a trial,
    Then it passes an absolute transcript path and records it in the result`, async () => {
    // Given
    const { root, suiteDir, outFile } = await createEvalDir();
    const transcriptDir = join(root, "transcripts");
    await createTask(suiteDir, "records-transcript", {
      prompt: "record transcript args",
      verify: [
        "node -e '",
        'const { readFileSync } = require("node:fs");',
        'const args = JSON.parse(readFileSync("agent-args.json", "utf8"));',
        'const transcript = args.indexOf("--transcript");',
        "if (transcript < 0) process.exit(1);",
        'if (!require("node:path").isAbsolute(args[transcript + 1])) process.exit(1);',
        "'\n",
      ].join(" "),
      solution: "printf '[]' > agent-args.json\n",
    });
    const cliEntry = join(root, "record-transcript-cli.js");
    await writeFile(
      cliEntry,
      [
        "import { writeFileSync, mkdirSync } from 'node:fs';",
        "import { dirname } from 'node:path';",
        "const args = process.argv.slice(2);",
        "const reportIndex = args.indexOf('--report');",
        "const transcriptIndex = args.indexOf('--transcript');",
        "writeFileSync('agent-args.json', JSON.stringify(args), 'utf8');",
        "mkdirSync(dirname(args[transcriptIndex + 1]), { recursive: true });",
        'writeFileSync(args[transcriptIndex + 1], \'{"schemaVersion":1,"type":"transcript","provider":"fake","model":"fake","systemPrompt":"test"}\\n\', \'utf8\');',
        "writeFileSync(args[reportIndex + 1], JSON.stringify({",
        "  schemaVersion: 17,",
        "  tasks: [{ ordinal: 1, trigger: 'user_prompt', humanInterventionCount: 0, agentRuns: [{ ordinal: 1, trigger: 'user_prompt', humanInterventionCount: 0, agentLoopTurns: 1, providerRetries: [], contextCompactions: [], stopReason: 'completed' }], outcome: 'completed' }],",
        "  humanInterventionCount: 0,",
        ...modelOperationReportLines("fake", "fake"),
        "  modelsUsed: [{ provider: 'fake', model: 'fake' }],",
        "  usageByModel: [{ provider: 'fake', model: 'fake', agentLoopTurns: 1, usage: { inputTokens: 1, cachedInputTokens: 0, uncachedInputTokens: 1, outputTokens: 1 }, costUsd: 0 }],",
        "  agentLoopTurns: 1,",
        "  stopReason: 'completed',",
        "  usage: { inputTokens: 1, cachedInputTokens: 0, uncachedInputTokens: 1, outputTokens: 1 },",
        "  durationMs: 1,",
        "  costUsd: 0,",
        "  costOvershootUsd: 0,",
        "  contextCompactions: [],",
        "  skillActivations: [], activeSkills: [], skillCatalog: { exposed: 0, omitted: 0, total: 0, budgetChars: 8000, usedChars: 0 },",
        "  skillPolicy: { mode: 'enabled', disabledPackages: 0 },",
        "  undoProtection: { status: 'not_applicable', checkpointsWritten: 0, failures: [], latestCheckpoint: null },",
        "  memory: { enabled: false, scope: null, loadedIds: [], loadedEntries: [], renderedBytes: 0, estimatedTokens: 0, operations: [] }",
        "}), 'utf8');",
      ].join("\n"),
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
        cliEntry,
      });

      // Then
      expect(exitCode).toBe(0);
      const lines = await readResultLines(outFile);
      expect(lines).toMatchObject([
        { taskId: "records-transcript", pass: true, outcome: "verified" },
      ]);
      expect(lines[0]?.transcriptPath).toContain("records-transcript-");
      expect(lines[0]?.transcriptPath).toContain("-trial-1");
      expect(isAbsolute(lines[0]?.transcriptPath ?? "")).toBe(true);
      await expect(
        readFile(lines[0]?.transcriptPath ?? "", "utf8"),
      ).resolves.toContain('"type":"transcript"');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test(`Given task ids collide after filename sanitization,
    When the eval runner writes trial transcripts,
    Then each result points at a distinct transcript artifact`, async () => {
    // Given
    const { root, suiteDir, outFile } = await createEvalDir();
    const transcriptDir = join(root, "transcripts");
    await createTask(suiteDir, "name one", {
      ...FIX_NOTE_TASK,
      verify: "exit 0\n",
    });
    await createTask(suiteDir, "name_one", {
      ...FIX_NOTE_TASK,
      verify: "exit 0\n",
    });
    const cliEntry = join(root, "write-transcript-cli.js");
    await writeFile(
      cliEntry,
      [
        "import { writeFileSync, mkdirSync } from 'node:fs';",
        "import { dirname } from 'node:path';",
        "const args = process.argv.slice(2);",
        "const reportIndex = args.indexOf('--report');",
        "const transcriptIndex = args.indexOf('--transcript');",
        "mkdirSync(dirname(args[transcriptIndex + 1]), { recursive: true });",
        'writeFileSync(args[transcriptIndex + 1], \'{"schemaVersion":1,"type":"transcript","provider":"fake","model":"fake","systemPrompt":"test"}\\n\', \'utf8\');',
        "writeFileSync(args[reportIndex + 1], JSON.stringify({",
        "  schemaVersion: 17,",
        "  tasks: [{ ordinal: 1, trigger: 'user_prompt', humanInterventionCount: 0, agentRuns: [{ ordinal: 1, trigger: 'user_prompt', humanInterventionCount: 0, agentLoopTurns: 1, providerRetries: [], contextCompactions: [], stopReason: 'completed' }], outcome: 'completed' }],",
        "  humanInterventionCount: 0,",
        ...modelOperationReportLines("fake", "fake"),
        "  modelsUsed: [{ provider: 'fake', model: 'fake' }],",
        "  usageByModel: [{ provider: 'fake', model: 'fake', agentLoopTurns: 1, usage: { inputTokens: 1, cachedInputTokens: 0, uncachedInputTokens: 1, outputTokens: 1 }, costUsd: 0 }],",
        "  agentLoopTurns: 1,",
        "  stopReason: 'completed',",
        "  usage: { inputTokens: 1, cachedInputTokens: 0, uncachedInputTokens: 1, outputTokens: 1 },",
        "  durationMs: 1,",
        "  costUsd: 0,",
        "  costOvershootUsd: 0,",
        "  contextCompactions: [],",
        "  skillActivations: [], activeSkills: [], skillCatalog: { exposed: 0, omitted: 0, total: 0, budgetChars: 8000, usedChars: 0 },",
        "  skillPolicy: { mode: 'enabled', disabledPackages: 0 },",
        "  undoProtection: { status: 'not_applicable', checkpointsWritten: 0, failures: [], latestCheckpoint: null },",
        "  memory: { enabled: false, scope: null, loadedIds: [], loadedEntries: [], renderedBytes: 0, estimatedTokens: 0, operations: [] }",
        "}), 'utf8');",
      ].join("\n"),
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
        cliEntry,
      });

      // Then
      expect(exitCode).toBe(0);
      const transcriptPaths = (await readResultLines(outFile)).map(
        (line) => line.transcriptPath,
      );
      expect(transcriptPaths).toHaveLength(2);
      expect(transcriptPaths.every((path) => path !== undefined)).toBe(true);
      expect(new Set(transcriptPaths).size).toBe(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test.each([
    {
      name: "malformed JSON",
      transcriptAction:
        "writeFileSync(args[transcriptIndex + 1], '{not-json}\\n', 'utf8');",
    },
    {
      name: "wrong header schema",
      transcriptAction:
        'writeFileSync(args[transcriptIndex + 1], \'{"schemaVersion":1,"type":"message"}\\n\', \'utf8\');',
    },
    {
      name: "empty file",
      transcriptAction: "writeFileSync(args[transcriptIndex + 1], '', 'utf8');",
    },
    {
      name: "directory path",
      transcriptAction:
        "mkdirSync(args[transcriptIndex + 1], { recursive: true });",
    },
  ])(
    `Given the child writes a $name transcript artifact,
    When the eval runner records the result,
    Then the result omits the transcript path`,
    async ({ transcriptAction }) => {
      // Given
      const { root, suiteDir, outFile } = await createEvalDir();
      const transcriptDir = join(root, "transcripts");
      await createTask(suiteDir, "invalid-transcript", {
        ...FIX_NOTE_TASK,
        verify: "exit 0\n",
      });
      const cliEntry = join(root, "invalid-transcript-cli.js");
      await writeFile(
        cliEntry,
        [
          "import { writeFileSync, mkdirSync } from 'node:fs';",
          "import { dirname } from 'node:path';",
          "const args = process.argv.slice(2);",
          "const reportIndex = args.indexOf('--report');",
          "const transcriptIndex = args.indexOf('--transcript');",
          "mkdirSync(dirname(args[transcriptIndex + 1]), { recursive: true });",
          transcriptAction,
          "writeFileSync(args[reportIndex + 1], JSON.stringify({",
          "  schemaVersion: 17,",
          "  tasks: [{ ordinal: 1, trigger: 'user_prompt', humanInterventionCount: 0, agentRuns: [{ ordinal: 1, trigger: 'user_prompt', humanInterventionCount: 0, agentLoopTurns: 1, providerRetries: [], contextCompactions: [], stopReason: 'completed' }], outcome: 'completed' }],",
          "  humanInterventionCount: 0,",
          ...modelOperationReportLines("fake", "fake"),
          "  modelsUsed: [{ provider: 'fake', model: 'fake' }],",
          "  usageByModel: [{ provider: 'fake', model: 'fake', agentLoopTurns: 1, usage: { inputTokens: 1, cachedInputTokens: 0, uncachedInputTokens: 1, outputTokens: 1 }, costUsd: 0 }],",
          "  agentLoopTurns: 1,",
          "  stopReason: 'completed',",
          "  usage: { inputTokens: 1, cachedInputTokens: 0, uncachedInputTokens: 1, outputTokens: 1 },",
          "  durationMs: 1,",
          "  costUsd: 0,",
          "  costOvershootUsd: 0,",
          "  contextCompactions: [],",
          "  skillActivations: [], activeSkills: [], skillCatalog: { exposed: 0, omitted: 0, total: 0, budgetChars: 8000, usedChars: 0 },",
          "  skillPolicy: { mode: 'enabled', disabledPackages: 0 },",
          "  undoProtection: { status: 'not_applicable', checkpointsWritten: 0, failures: [], latestCheckpoint: null },",
          "  memory: { enabled: false, scope: null, loadedIds: [], loadedEntries: [], renderedBytes: 0, estimatedTokens: 0, operations: [] }",
          "}), 'utf8');",
        ].join("\n"),
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
          cliEntry,
        });

        // Then
        expect(exitCode).toBe(0);
        expect(
          (await readResultLines(outFile))[0]?.transcriptPath,
        ).toBeUndefined();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
