import { writeFile } from "node:fs/promises";
import type { RunReport } from "../eval/report-schema.ts";
import type { EvalResultLine, TrialOutcome } from "../eval/result.ts";

export type EvalRunReport = RunReport;

export interface EvalRunReportOptions {
  readonly humanInterventions?: number;
  readonly turns?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly durationMs?: number;
  readonly costUsd?: number;
}

export interface EvalResultLineOptions {
  readonly taskId: string;
  readonly trial: number;
  readonly repetitionCount?: number;
  readonly pass: boolean;
  readonly outcome?: TrialOutcome;
  readonly wallMs?: number;
  readonly report?: EvalRunReport;
  readonly transcriptPath?: string;
  readonly condition?: "standard" | "memory_disabled" | "memory_enabled";
  readonly requiredToPass?: boolean;
  readonly structuralFailures?: readonly string[];
  readonly behavioralFailures?: readonly string[];
  readonly provider?: string;
  readonly model?: string;
  readonly corpusVersion?: string;
  readonly keelRevision?: string | null;
}

export function evalRunReport(
  options: EvalRunReportOptions = {},
): EvalRunReport {
  const humanInterventionCount = options.humanInterventions ?? 0;
  const inputTokens = options.inputTokens ?? 100;
  const usage = {
    inputTokens,
    cachedInputTokens: 0,
    uncachedInputTokens: inputTokens,
    outputTokens: options.outputTokens ?? 20,
  };
  const costUsd = options.costUsd ?? 0.001;
  const agentLoopTurns = options.turns ?? 3;
  const modelOperations = Array.from({ length: agentLoopTurns }, (_, index) => {
    const operationUsage =
      index === 0
        ? usage
        : {
            inputTokens: 0,
            cachedInputTokens: 0,
            uncachedInputTokens: 0,
            outputTokens: 0,
          };
    const operationCostUsd = index === 0 ? costUsd : 0;
    return {
      ordinal: index + 1,
      owner: {
        type: "agent_run" as const,
        taskOrdinal: 1,
        agentRunOrdinal: 1,
      },
      purpose: "agent_turn" as const,
      provider: "deepseek",
      model: "deepseek-v4-flash",
      outcome: "completed" as const,
      providerRequestAttempts: [
        {
          ordinal: 1,
          outcome: "completed" as const,
          usage: operationUsage,
          costUsd: operationCostUsd,
        },
      ],
      usage: operationUsage,
      costUsd: operationCostUsd,
    };
  });
  return {
    schemaVersion: 15,
    tasks: [
      {
        ordinal: 1,
        trigger: "user_prompt",
        humanInterventionCount,
        agentRuns: [
          {
            ordinal: 1,
            trigger: "user_prompt",
            humanInterventionCount,
            agentLoopTurns,
            providerRetries: [],
            contextCompactions: [],
            stopReason: "completed",
          },
        ],
        outcome: "completed",
      },
    ],
    humanInterventionCount,
    modelOperations,
    modelOperationCount: modelOperations.length,
    providerRequestAttemptCount: modelOperations.length,
    modelsUsed: [{ provider: "deepseek", model: "deepseek-v4-flash" }],
    usageByModel: [
      {
        provider: "deepseek",
        model: "deepseek-v4-flash",
        agentLoopTurns,
        usage,
        costUsd,
      },
    ],
    agentLoopTurns,
    stopReason: "completed",
    usage,
    durationMs: options.durationMs ?? 1000,
    costUsd,
    costOvershootUsd: 0,
    contextCompactions: [],
    skillActivations: [],
    activeSkills: [],
    skillCatalog: {
      exposed: 0,
      omitted: 0,
      total: 0,
      budgetChars: 8000,
      usedChars: 0,
    },
    skillPolicy: { mode: "enabled", disabledPackages: 0 },
    undoProtection: {
      status: "not_applicable",
      checkpointsWritten: 0,
      failures: [],
      latestCheckpoint: null,
    },
    memory: {
      enabled: false,
      scope: null,
      loadedIds: [],
      loadedEntries: [],
      renderedBytes: 0,
      estimatedTokens: 0,
      operations: [],
    },
  };
}

export function evalResultLine(options: EvalResultLineOptions): EvalResultLine {
  const report = options.report ?? null;
  const condition = options.condition ?? "standard";
  const outcome =
    options.outcome ?? (options.pass === true ? "verified" : "verify_failed");
  const outcomeFailure =
    outcome === "verified"
      ? []
      : outcome === "verify_failed"
        ? ["task verifier rejected the resulting workspace"]
        : outcome === "timeout"
          ? ["agent or verifier timed out"]
          : ["agent or evaluation harness crashed"];
  return {
    schemaVersion: 2,
    timestamp: "2026-06-22T00:00:00.000Z",
    keelVersion: "0.0.1",
    keelRevision:
      options.keelRevision === undefined
        ? "0123456789abcdef0123456789abcdef01234567"
        : options.keelRevision,
    corpusVersion: options.corpusVersion ?? "test-v1",
    taskId: options.taskId,
    trial: options.trial,
    repetitionCount: options.repetitionCount ?? 1,
    seed: null,
    provider: options.provider ?? report?.modelsUsed[0]?.provider ?? "deepseek",
    model: options.model ?? report?.modelsUsed[0]?.model ?? "deepseek-v4-flash",
    modelRevision: null,
    condition,
    requiredToPass: options.requiredToPass ?? true,
    pass: options.pass,
    outcome,
    wallMs: options.wallMs ?? 1000,
    structuralFailures: [...(options.structuralFailures ?? [])],
    behavioralFailures: [
      ...(options.behavioralFailures ?? (options.pass ? [] : outcomeFailure)),
    ],
    memory: {
      mode:
        condition === "standard"
          ? "not_applicable"
          : condition === "memory_disabled"
            ? "disabled"
            : "enabled",
      configuredIds: [],
      scope:
        condition === "standard"
          ? null
          : { kind: "project", id: "project_test" },
    },
    toolCalls: [],
    providerEvidence: {
      transcriptReadable: options.transcriptPath !== undefined,
      finalAssistantText: "",
    },
    pairDelta:
      condition === "standard"
        ? null
        : {
            successPercentagePoints: 0,
            toolCalls: 0,
            agentLoopTurns: 0,
            inputTokens: 0,
            outputTokens: 0,
            costUsd: 0,
            wallMs: 0,
            renderedBytes: 0,
          },
    report,
    transcriptPath: options.transcriptPath ?? null,
  };
}

export function evalResultLineJson(options: EvalResultLineOptions): string {
  return `${JSON.stringify(evalResultLine(options))}\n`;
}

export async function writeEvalResultFile(
  filePath: string,
  lines: readonly EvalResultLine[],
): Promise<void> {
  await writeFile(
    filePath,
    `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
    "utf8",
  );
}
