import { writeFile } from "node:fs/promises";
import type { RunReport } from "../eval/report-schema.ts";
import {
  type EvalResultLine,
  type EvalTrialCondition,
  type EvalTrialOutcome,
  evalResultRequirement,
  evalResultVerdict,
} from "../eval/result-schema.ts";

export type EvalRunReport = RunReport;
export type { EvalResultLine };

export interface EvalRunReportOptions {
  readonly humanInterventions?: number;
  readonly turns?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly durationMs?: number;
  readonly costUsd?: number;
}

interface EvalResultLineOptionsBase {
  readonly taskId: string;
  readonly trial: number;
  readonly condition?: EvalTrialCondition;
  readonly wallMs?: number;
  readonly report?: EvalRunReport;
  readonly transcriptPath?: string;
}

export type EvalResultLineOptions = EvalResultLineOptionsBase &
  (
    | { readonly pass: true; readonly outcome?: never }
    | {
        readonly pass: false;
        readonly outcome?: Exclude<EvalTrialOutcome, "verified">;
      }
  );

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
    schemaVersion: 18,
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
      status: "disabled",
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
  const condition = options.condition ?? "standard";
  const outcome =
    options.pass === true ? "verified" : (options.outcome ?? "verify_failed");
  return {
    schemaVersion: 2,
    timestamp: "2026-06-22T00:00:00.000Z",
    keelVersion: "0.0.1",
    taskId: options.taskId,
    trial: options.trial,
    ...evalResultRequirement(condition),
    ...evalResultVerdict(outcome),
    wallMs: options.wallMs ?? 1000,
    ...(options.report !== undefined ? { report: options.report } : {}),
    ...(options.transcriptPath !== undefined
      ? { transcriptPath: options.transcriptPath }
      : {}),
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
