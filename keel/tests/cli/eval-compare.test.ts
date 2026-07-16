import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { runEvalCompareCommand } from "../../src/eval/compare.ts";
import {
  evalRunReport as report,
  evalResultLine as resultLine,
  writeEvalResultFile as writeResultFile,
} from "../../src/testing/eval-fixtures.ts";

interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

function runCompare(baseFile: string, headFile: string): CommandResult {
  let stdout = "";
  let stderr = "";
  const writeStdout = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: string | Uint8Array) => {
      stdout += chunk.toString();
      return true;
    });
  const writeStderr = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((chunk: string | Uint8Array) => {
      stderr += chunk.toString();
      return true;
    });

  try {
    const exitCode = runEvalCompareCommand({ baseFile, headFile });
    return { exitCode, stdout, stderr };
  } finally {
    writeStdout.mockRestore();
    writeStderr.mockRestore();
  }
}

describe("Eval Compare", () => {
  test(`Given two eval result files with score and efficiency changes,
    When the compare command runs,
    Then it reports task statuses, metric deltas, and regression transcripts`, async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "keel-eval-compare-unit-"));
    const baseFile = join(root, "base.jsonl");
    const headFile = join(root, "head.jsonl");
    await writeResultFile(baseFile, [
      resultLine({
        taskId: "added-or-removed",
        trial: 1,
        pass: true,
        report: report(),
      }),
      resultLine({
        taskId: "efficiency-improved",
        trial: 1,
        pass: true,
        report: report({ turns: 5, inputTokens: 200, outputTokens: 40 }),
        wallMs: 900,
      }),
      resultLine({
        taskId: "efficiency-regressed",
        trial: 1,
        pass: true,
        report: report({ turns: 2, inputTokens: 50, outputTokens: 10 }),
        wallMs: 500,
      }),
      resultLine({
        taskId: "improved-score",
        trial: 1,
        pass: false,
      }),
      resultLine({
        taskId: "intervention-improved",
        trial: 1,
        pass: true,
        report: report({ turns: 2, humanInterventions: 1 }),
      }),
      resultLine({
        taskId: "intervention-regressed",
        trial: 1,
        pass: true,
        report: report({ turns: 3, humanInterventions: 0 }),
      }),
      resultLine({
        taskId: "harness-failure",
        trial: 1,
        pass: true,
        report: report(),
      }),
      resultLine({
        taskId: "regressed-score",
        trial: 1,
        pass: true,
        report: report({ turns: 3, inputTokens: 100, outputTokens: 20 }),
        transcriptPath: "/tmp/base/regressed-score.jsonl",
      }),
      resultLine({
        taskId: "unchanged",
        trial: 1,
        pass: true,
        report: report(),
      }),
    ]);
    await writeResultFile(headFile, [
      resultLine({
        taskId: "brand-new",
        trial: 1,
        pass: true,
        report: report(),
      }),
      resultLine({
        taskId: "efficiency-improved",
        trial: 1,
        pass: true,
        report: report({ turns: 5, inputTokens: 200, outputTokens: 40 }),
        wallMs: 600,
      }),
      resultLine({
        taskId: "efficiency-regressed",
        trial: 1,
        pass: true,
        report: report({ turns: 2, inputTokens: 50, outputTokens: 10 }),
        wallMs: 800,
      }),
      resultLine({
        taskId: "improved-score",
        trial: 1,
        pass: true,
      }),
      resultLine({
        taskId: "intervention-improved",
        trial: 1,
        pass: true,
        report: report({ turns: 3, humanInterventions: 0 }),
      }),
      resultLine({
        taskId: "intervention-regressed",
        trial: 1,
        pass: true,
        report: report({ turns: 2, humanInterventions: 1 }),
      }),
      resultLine({
        taskId: "harness-failure",
        trial: 1,
        pass: false,
        outcome: "timeout",
        report: report(),
        transcriptPath: "/tmp/head/harness-failure.jsonl",
      }),
      resultLine({
        taskId: "regressed-score",
        trial: 1,
        pass: false,
        report: report({ turns: 4, inputTokens: 150, outputTokens: 30 }),
        wallMs: 1200,
        transcriptPath: "/tmp/head/regressed-score.jsonl",
      }),
      resultLine({
        taskId: "unchanged",
        trial: 1,
        pass: true,
        report: report(),
      }),
    ]);

    try {
      // When
      const result = runCompare(baseFile, headFile);

      // Then
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("task: added-or-removed");
      expect(result.stdout).toContain("status: REMOVED");
      expect(result.stdout).toContain("task: brand-new");
      expect(result.stdout).toContain("status: ADDED");
      expect(result.stdout).toContain("task: improved-score");
      expect(result.stdout).toContain("status: IMPROVEMENT");
      expect(result.stdout).toContain("task: intervention-improved");
      expect(result.stdout).toContain("status: INTERVENTION IMPROVEMENT");
      expect(result.stdout).toContain("task: intervention-regressed");
      expect(result.stdout).toContain("status: INTERVENTION REGRESSION");
      expect(result.stdout).toContain("task: regressed-score");
      expect(result.stdout).toContain("status: REGRESSION");
      expect(result.stdout).toContain("/tmp/head/regressed-score.jsonl");
      expect(result.stdout).toContain("task: harness-failure");
      expect(result.stdout).toContain("status: HARNESS FAILURE");
      expect(result.stdout).toContain("head harness failures: 1");
      expect(result.stdout).toContain("/tmp/head/harness-failure.jsonl");
      expect(result.stdout).toContain("task: efficiency-regressed");
      expect(result.stdout).toContain("status: EFFICIENCY REGRESSION");
      expect(result.stdout).toContain("task: efficiency-improved");
      expect(result.stdout).toContain("status: EFFICIENCY IMPROVEMENT");
      expect(result.stdout).toContain("task: unchanged");
      expect(result.stdout).toContain("status: UNCHANGED");
      expect(result.stdout).toContain(
        "suite pass: 8/9 (88.9%) -> 7/9 (77.8%) (-11.1pp)",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test(`Given paired memory conditions and a structural failure,
    When the compare command summarizes the results,
    Then it keeps conditions separate and surfaces the concrete invariant failure`, async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "keel-eval-compare-memory-"));
    const baseFile = join(root, "base.jsonl");
    const headFile = join(root, "head.jsonl");
    const basePairDelta = {
      successPercentagePoints: 100,
      toolCalls: 0,
      agentLoopTurns: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      wallMs: 0,
      renderedBytes: 0,
    };
    const headPairDelta = {
      successPercentagePoints: 0,
      toolCalls: 0,
      agentLoopTurns: null,
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
      wallMs: 0,
      renderedBytes: null,
    };
    await writeResultFile(baseFile, [
      {
        ...resultLine({
          taskId: "memory-case",
          trial: 1,
          pass: false,
          condition: "memory_disabled",
          requiredToPass: false,
          report: report(),
        }),
        pairDelta: basePairDelta,
      },
      {
        ...resultLine({
          taskId: "memory-case",
          trial: 1,
          pass: true,
          condition: "memory_enabled",
          report: report(),
        }),
        pairDelta: basePairDelta,
      },
    ]);
    await writeResultFile(headFile, [
      {
        ...resultLine({
          taskId: "memory-case",
          trial: 1,
          pass: false,
          condition: "memory_disabled",
          requiredToPass: false,
          report: report(),
        }),
        pairDelta: headPairDelta,
      },
      {
        ...resultLine({
          taskId: "memory-case",
          trial: 1,
          pass: false,
          condition: "memory_enabled",
          structuralFailures: [
            "enabled report loaded IDs differ from configured IDs",
          ],
          transcriptPath: "/tmp/head/memory-case-enabled.jsonl",
        }),
        pairDelta: headPairDelta,
      },
    ]);

    try {
      // When
      const result = runCompare(baseFile, headFile);

      // Then
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("task: memory-case [memory_disabled]");
      expect(result.stdout).toContain("task: memory-case [memory_enabled]");
      expect(result.stdout).toContain("status: STRUCTURAL FAILURE");
      expect(result.stdout).toContain(
        "enabled report loaded IDs differ from configured IDs",
      );
      expect(result.stdout).toContain("/tmp/head/memory-case-enabled.jsonl");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test(`Given a task has repeated trials with lower head cost,
    When the compare command summarizes the task,
    Then it averages repeated trials and reports the negative cost delta`, async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "keel-eval-compare-trials-"));
    const baseFile = join(root, "base.jsonl");
    const headFile = join(root, "head.jsonl");
    await writeResultFile(baseFile, [
      resultLine({
        taskId: "cheaper-task",
        trial: 1,
        repetitionCount: 2,
        pass: true,
        report: report({ costUsd: 0.002 }),
      }),
      resultLine({
        taskId: "cheaper-task",
        trial: 2,
        repetitionCount: 2,
        pass: true,
        report: report({ costUsd: 0.002 }),
      }),
    ]);
    await writeResultFile(headFile, [
      resultLine({
        taskId: "cheaper-task",
        trial: 1,
        repetitionCount: 2,
        pass: true,
        report: report({ costUsd: 0.001 }),
      }),
      resultLine({
        taskId: "cheaper-task",
        trial: 2,
        repetitionCount: 2,
        pass: true,
        report: report({ costUsd: 0.001 }),
      }),
    ]);

    try {
      // When
      const result = runCompare(baseFile, headFile);

      // Then
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("task: cheaper-task");
      expect(result.stdout).toContain("status: EFFICIENCY IMPROVEMENT");
      expect(result.stdout).toContain(
        "cost avg: $0.002000 -> $0.001000 (-$0.001000)",
      );
      expect(result.stdout).toContain(
        "suite pass: 2/2 (100.0%) -> 2/2 (100.0%) (+0.0pp)",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test(`Given head has more harness failures but a lower harness failure rate,
    When the compare command summarizes the task,
    Then it reports the pass-rate improvement without regression transcripts`, async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "keel-eval-compare-rate-"));
    const baseFile = join(root, "base.jsonl");
    const headFile = join(root, "head.jsonl");
    await writeResultFile(baseFile, [
      resultLine({
        taskId: "more-reliable-head",
        trial: 1,
        pass: false,
        outcome: "crashed",
        transcriptPath: "/tmp/base/crashed.jsonl",
      }),
    ]);
    await writeResultFile(headFile, [
      resultLine({
        taskId: "more-reliable-head",
        trial: 1,
        repetitionCount: 5,
        pass: false,
        outcome: "crashed",
        transcriptPath: "/tmp/head/crashed-1.jsonl",
      }),
      resultLine({
        taskId: "more-reliable-head",
        trial: 2,
        repetitionCount: 5,
        pass: false,
        outcome: "timeout",
        transcriptPath: "/tmp/head/timeout-2.jsonl",
      }),
      resultLine({
        taskId: "more-reliable-head",
        trial: 3,
        repetitionCount: 5,
        pass: true,
      }),
      resultLine({
        taskId: "more-reliable-head",
        trial: 4,
        repetitionCount: 5,
        pass: true,
      }),
      resultLine({
        taskId: "more-reliable-head",
        trial: 5,
        repetitionCount: 5,
        pass: true,
      }),
    ]);

    try {
      // When
      const result = runCompare(baseFile, headFile);

      // Then
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("task: more-reliable-head");
      expect(result.stdout).toContain("status: IMPROVEMENT");
      expect(result.stdout).toContain(
        "pass: 0/1 (0.0%) -> 3/5 (60.0%) (+60.0pp)",
      );
      expect(result.stdout).toContain("head harness failures: 2");
      expect(result.stdout).not.toContain("regression transcripts:");
      expect(result.stdout).not.toContain("/tmp/head/crashed-1.jsonl");
      expect(result.stdout).not.toContain("/tmp/head/timeout-2.jsonl");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test(`Given eval files contain mixed, incomplete, or mismatched cohort evidence,
    When the compare command validates the experiment,
    Then it rejects every invalid cohort instead of averaging it`, async () => {
    const root = await mkdtemp(join(tmpdir(), "keel-eval-compare-cohort-"));
    const baseFile = join(root, "base.jsonl");
    const headFile = join(root, "head.jsonl");
    const standard = resultLine({ taskId: "case", trial: 1, pass: true });
    const validPairDelta = {
      successPercentagePoints: 100,
      toolCalls: 0,
      agentLoopTurns: null,
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
      wallMs: 0,
      renderedBytes: null,
    };
    const disabled = {
      ...resultLine({
        taskId: "case",
        trial: 1,
        pass: false,
        condition: "memory_disabled",
        requiredToPass: false,
      }),
      pairDelta: validPairDelta,
    };
    const enabled = {
      ...resultLine({
        taskId: "case",
        trial: 1,
        pass: true,
        condition: "memory_enabled",
      }),
      pairDelta: validPairDelta,
    };
    if (
      disabled.memory.mode !== "disabled" ||
      enabled.memory.mode !== "enabled"
    ) {
      throw new Error("memory result fixture has the wrong mode");
    }
    const cases = [
      {
        base: [
          { ...standard, repetitionCount: 2 },
          { ...standard, repetitionCount: 2 },
        ],
        head: [standard],
        expected: "requires exactly trials 1..2",
      },
      {
        base: [
          { ...standard, repetitionCount: 2 },
          { ...standard, trial: 2, repetitionCount: 3 },
        ],
        head: [standard],
        expected: "mixes repetition counts",
      },
      {
        base: [
          { ...standard, repetitionCount: 2 },
          {
            ...standard,
            trial: 2,
            repetitionCount: 2,
            corpusVersion: "other-v1",
          },
        ],
        head: [standard],
        expected: "mixes corpus versions",
      },
      {
        base: [
          resultLine({
            taskId: "policy-case",
            trial: 1,
            repetitionCount: 2,
            pass: true,
            condition: "memory_disabled",
            requiredToPass: false,
          }),
          resultLine({
            taskId: "policy-case",
            trial: 2,
            repetitionCount: 2,
            pass: true,
            condition: "memory_disabled",
            requiredToPass: true,
          }),
          resultLine({
            taskId: "policy-case",
            trial: 1,
            repetitionCount: 2,
            pass: true,
            condition: "memory_enabled",
          }),
          resultLine({
            taskId: "policy-case",
            trial: 2,
            repetitionCount: 2,
            pass: true,
            condition: "memory_enabled",
          }),
        ],
        head: [standard],
        expected: "mixes pass policies",
      },
      {
        base: [
          standard,
          resultLine({
            taskId: "other",
            trial: 1,
            pass: true,
            provider: "kimi",
            model: "kimi-k2.6",
          }),
        ],
        head: [standard],
        expected: "mixes provider values",
      },
      {
        base: [
          standard,
          resultLine({
            taskId: "other",
            trial: 1,
            pass: true,
            keelRevision: "fedcba9876543210fedcba9876543210fedcba98",
          }),
        ],
        head: [standard],
        expected: "mixes Keel revisions",
      },
      {
        base: [disabled],
        head: [standard],
        expected: "incomplete memory pair",
      },
      {
        base: [
          {
            ...resultLine({
              taskId: "uneven-pair",
              trial: 1,
              pass: true,
              condition: "memory_disabled",
            }),
          },
          resultLine({
            taskId: "uneven-pair",
            trial: 1,
            repetitionCount: 2,
            pass: true,
            condition: "memory_enabled",
          }),
          resultLine({
            taskId: "uneven-pair",
            trial: 2,
            repetitionCount: 2,
            pass: true,
            condition: "memory_enabled",
          }),
        ],
        head: [standard],
        expected: "incomplete memory pair",
      },
      {
        base: [
          {
            ...resultLine({
              taskId: "misaligned-pair",
              trial: 1,
              repetitionCount: 2,
              pass: true,
              condition: "memory_disabled",
            }),
          },
          resultLine({
            taskId: "misaligned-pair",
            trial: 2,
            repetitionCount: 2,
            pass: true,
            condition: "memory_enabled",
          }),
        ],
        head: [standard],
        expected: "incomplete memory pair",
      },
      {
        base: [standard, disabled, enabled],
        head: [standard],
        expected: "mixes standard and memory conditions",
      },
      {
        base: [
          {
            ...disabled,
            memory: {
              ...disabled.memory,
              configuredIds: ["mem_disabled"],
            },
          },
          {
            ...enabled,
            memory: {
              ...enabled.memory,
              configuredIds: ["mem_enabled"],
            },
          },
        ],
        head: [standard],
        expected: "mismatched memory-pair evidence",
      },
      {
        base: [
          disabled,
          {
            ...enabled,
            memory: {
              ...enabled.memory,
              scope: { kind: "project" as const, id: "project_other" },
            },
          },
        ],
        head: [standard],
        expected: "mismatched memory-pair evidence",
      },
      {
        base: [
          disabled,
          {
            ...enabled,
            pairDelta: {
              successPercentagePoints: 0,
              toolCalls: 0,
              agentLoopTurns: null,
              inputTokens: null,
              outputTokens: null,
              costUsd: null,
              wallMs: 0,
              renderedBytes: null,
            },
          },
        ],
        head: [standard],
        expected: "invalid pair delta",
      },
      {
        base: [{ ...disabled, corpusVersion: "memory-v2" }, enabled],
        head: [standard],
        expected: "mismatched memory-pair evidence",
      },
      {
        base: [standard],
        head: [
          {
            ...standard,
            provider: "kimi",
            model: "kimi-k2.6",
          },
        ],
        expected: "provider differs",
      },
      {
        base: [standard],
        head: [{ ...standard, corpusVersion: "other-v1" }],
        expected: "corpus version differs",
      },
      {
        base: [disabled, enabled],
        head: [{ ...disabled, requiredToPass: true }, enabled],
        expected: "pass policy differs",
      },
    ];

    try {
      for (const cohort of cases) {
        await writeResultFile(baseFile, cohort.base);
        await writeResultFile(headFile, cohort.head);

        const result = runCompare(baseFile, headFile);

        expect(result.exitCode).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain(cohort.expected);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test(`Given an eval result file has no usable result lines,
    When the compare command reads it,
    Then it reports the empty file instead of printing a comparison`, async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "keel-eval-compare-empty-"));
    const baseFile = join(root, "base.jsonl");
    const headFile = join(root, "head.jsonl");
    await writeFile(baseFile, "\n", "utf8");
    await writeResultFile(headFile, [
      resultLine({ taskId: "fix-note", trial: 1, pass: true }),
    ]);

    try {
      // When
      const result = runCompare(baseFile, headFile);

      // Then
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("has no result lines");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test(`Given an eval result line does not match the eval schema,
    When the compare command reads it,
    Then it reports the invalid schema line`, async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "keel-eval-compare-schema-"));
    const baseFile = join(root, "base.jsonl");
    const headFile = join(root, "head.jsonl");
    await writeFile(baseFile, '{"schemaVersion":1}\n', "utf8");
    await writeResultFile(headFile, [
      resultLine({ taskId: "fix-note", trial: 1, pass: true }),
    ]);

    try {
      // When
      const result = runCompare(baseFile, headFile);

      // Then
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("line 1 is not a schemaVersion 2");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test(`Given an eval result line is not JSON,
    When the compare command reads it,
    Then it reports the JSONL line number`, async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "keel-eval-compare-json-"));
    const baseFile = join(root, "base.jsonl");
    const headFile = join(root, "head.jsonl");
    await writeFile(baseFile, "not-json\n", "utf8");
    await writeResultFile(headFile, [
      resultLine({ taskId: "fix-note", trial: 1, pass: true }),
    ]);

    try {
      // When
      const result = runCompare(baseFile, headFile);

      // Then
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("line 1 is not valid JSON");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test(`Given the base eval result file does not exist,
    When the compare command reads it,
    Then it reports the unreadable file path`, async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "keel-eval-compare-missing-"));
    const baseFile = join(root, "missing.jsonl");
    const headFile = join(root, "head.jsonl");
    await writeResultFile(headFile, [
      resultLine({ taskId: "fix-note", trial: 1, pass: true }),
    ]);

    try {
      // When
      const result = runCompare(baseFile, headFile);

      // Then
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(baseFile);
      expect(result.stderr).toContain("cannot read eval result file");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
