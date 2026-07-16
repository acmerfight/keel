import { describe, expect, test } from "vitest";
import type { RunReport } from "../../src/eval/report-schema.ts";
import {
  type ConfiguredMemory,
  evalResultLineSchema,
  memoryStructuralFailures,
  type TrialResult,
} from "../../src/eval/result.ts";
import type { MemoryPairEvalTask } from "../../src/eval/task.ts";
import {
  evalResultLine,
  evalRunReport,
} from "../../src/testing/eval-fixtures.ts";

const TASK: MemoryPairEvalTask = {
  kind: "memory_pair",
  id: "memory-contract",
  workspaceDir: "/tmp/workspace",
  verifyScript: "/tmp/verify.sh",
  solutionScript: "/tmp/solution.sh",
  corpusVersion: "memory-v1",
  prompt: "do the task",
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
    { operation: "forget", target: "fact" },
  ],
};

const CONFIGURED: ConfiguredMemory = {
  ids: ["mem_alpha"],
  statuses: ["current"],
  scope: { kind: "project", id: "project_alpha" },
};

const LOADED_ENTRY = {
  id: "mem_alpha",
  status: "current" as const,
  source: { type: "user_explicit" as const, channel: "cli" as const },
  createdAt: "2026-07-16T00:00:00.000Z",
  lastVerifiedAt: "2026-07-16T00:00:00.000Z",
  supersedes: [],
  supersededBy: null,
  reviewAfter: null,
  expiresAt: null,
};

function trial(options: {
  readonly report: RunReport | null;
  readonly readable: boolean;
  readonly systemPrompt?: string;
  readonly tool?: "memory_add";
  readonly outcome?: TrialResult["outcome"];
}): TrialResult {
  return {
    outcome: options.outcome ?? "verified",
    wallMs: 10,
    report: options.report,
    transcriptPath: null,
    transcript: {
      readable: options.readable,
      systemPrompt: options.systemPrompt ?? null,
      toolCalls:
        options.tool === undefined
          ? []
          : [
              {
                id: "call_memory",
                tool: options.tool,
                arguments: { text: "The durable fact is alpha." },
              },
            ],
    },
  };
}

describe("Eval Result Contract", () => {
  test.each([
    {
      name: "condition and memory mode disagree",
      value: {
        ...evalResultLine({ taskId: "case", trial: 1, pass: true }),
        memory: { mode: "enabled", configuredIds: [], scope: null },
      },
    },
    {
      name: "memory condition has no paired delta",
      value: {
        ...evalResultLine({ taskId: "case", trial: 1, pass: true }),
        condition: "memory_disabled",
        requiredToPass: false,
        memory: { mode: "disabled", configuredIds: [], scope: null },
      },
    },
    {
      name: "standard condition is not required",
      value: {
        ...evalResultLine({ taskId: "case", trial: 1, pass: true }),
        requiredToPass: false,
      },
    },
  ])("rejects a result when $name", ({ value }) => {
    expect(evalResultLineSchema.safeParse(value).success).toBe(false);
  });

  test(`Given a disabled run exposes every prohibited memory signal,
    When structural evidence is evaluated,
    Then every concrete clean-mode violation is retained`, () => {
    const base = evalRunReport();
    const report: RunReport = {
      ...base,
      memory: {
        enabled: true,
        scope: CONFIGURED.scope,
        loadedIds: ["mem_alpha"],
        loadedEntries: [LOADED_ENTRY],
        renderedBytes: 200,
        estimatedTokens: 50,
        operations: [
          {
            operation: "add",
            id: "mem_alpha",
            scope: CONFIGURED.scope ?? {
              kind: "project",
              id: "project_alpha",
            },
            outcome: "saved",
          },
        ],
      },
    };

    const failures = memoryStructuralFailures(
      TASK,
      "memory_disabled",
      CONFIGURED,
      trial({
        report,
        readable: true,
        systemPrompt:
          "mem_alpha The durable fact is alpha. should not be visible",
        tool: "memory_add",
      }),
      [],
    );

    expect(failures).toEqual([
      "--no-memory report says memory is enabled",
      "--no-memory report exposes a scope",
      "--no-memory report exposes loaded memory",
      "--no-memory report exposes rendered memory bytes",
      "--no-memory report exposes memory operations",
      "--no-memory provider context contains configured memory",
      "--no-memory run called a memory mutation tool",
    ]);
  });

  test(`Given enabled evidence disagrees with configured memory,
    When structural evidence is evaluated,
    Then scope, provenance, lifecycle, budget, and mutation failures stay separate`, () => {
    const base = evalRunReport();
    const report: RunReport = {
      ...base,
      memory: {
        enabled: false,
        scope: { kind: "project", id: "wrong_project" },
        loadedIds: ["mem_wrong"],
        loadedEntries: [{ ...LOADED_ENTRY, id: "mem_wrong", status: "stale" }],
        renderedBytes: 0,
        estimatedTokens: 0,
        operations: [
          {
            operation: "forget",
            id: "mem_wrong",
            scope: { kind: "project", id: "wrong_project" },
            outcome: "forgotten",
          },
        ],
      },
    };

    expect(
      memoryStructuralFailures(
        TASK,
        "memory_enabled",
        CONFIGURED,
        trial({ report, readable: true }),
        [],
      ),
    ).toEqual([
      "enabled report says memory is disabled",
      "enabled report scope differs from configured scope",
      "enabled report loaded IDs differ from configured IDs",
      "enabled report provenance differs from configured IDs",
      "enabled report lifecycle differs from configured memory",
      "enabled report violates the rendered memory byte budget",
      "evaluation prompt caused an unauthorized memory mutation",
    ]);
  });

  test(`Given structural evidence lacks scope, report, or transcript,
    When the evaluator classifies each run,
    Then unavailable evidence is explicit without obscuring setup failures`, () => {
    const missingReport = memoryStructuralFailures(
      TASK,
      "memory_enabled",
      { ids: [], statuses: [], scope: null },
      trial({ report: null, readable: false }),
      [],
    );
    const unreadableTranscript = memoryStructuralFailures(
      TASK,
      "memory_disabled",
      CONFIGURED,
      trial({ report: evalRunReport(), readable: false }),
      [],
    );
    const setupFailure = memoryStructuralFailures(
      TASK,
      "memory_disabled",
      CONFIGURED,
      trial({ report: null, readable: false, outcome: "crashed" }),
      ["fixture failed"],
    );

    expect(missingReport).toEqual([
      "configured memory IDs and scope are incomplete",
      "run report is unavailable",
    ]);
    expect(unreadableTranscript).toContain(
      "provider-visible transcript is unavailable",
    );
    expect(setupFailure).toEqual(["fixture failed"]);
  });
});
