import { writeFile } from "node:fs/promises";
import type { RunReport } from "../eval/report-schema.ts";
import {
  type EvalDelegationSelection,
  type EvalHarnessOutcome,
  type EvalResultCondition,
  type EvalResultLine,
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
  readonly wallMs?: number;
  readonly report?: EvalRunReport;
  readonly transcriptPath?: string;
}

type EvalResultVerdictOptions =
  | {
      readonly pass: true;
      readonly harnessOutcome?: never;
      readonly taskOutcome?: never;
    }
  | {
      readonly pass: false;
      readonly harnessOutcome?: "completed";
      readonly taskOutcome?: "verify_failed";
    }
  | {
      readonly pass: false;
      readonly harnessOutcome: Exclude<EvalHarnessOutcome, "completed">;
      readonly taskOutcome?: never;
    };

type EvalResultConditionOptions =
  | {
      readonly condition?: "standard";
      readonly delegationSelection?: EvalDelegationSelection;
    }
  | {
      readonly condition:
        | "memory_enabled"
        | "memory_disabled"
        | "delegation_control";
      readonly delegationSelection?: never;
    }
  | {
      readonly condition: "delegation_treatment";
      readonly delegationSelection: EvalDelegationSelection;
    };

export type EvalResultLineOptions = EvalResultLineOptionsBase &
  EvalResultVerdictOptions &
  EvalResultConditionOptions;

function evalFixtureCondition(
  options: EvalResultConditionOptions,
): EvalResultCondition {
  if (options.condition === "delegation_treatment") {
    return {
      condition: options.condition,
      requiredToPass: true,
      delegationSelection: options.delegationSelection,
    };
  }
  if (options.condition === "memory_enabled") {
    return { condition: options.condition, requiredToPass: true };
  }
  if (
    options.condition === "memory_disabled" ||
    options.condition === "delegation_control"
  ) {
    return { condition: options.condition, requiredToPass: false };
  }
  return {
    condition: "standard",
    requiredToPass: true,
    ...(options.delegationSelection === undefined
      ? {}
      : { delegationSelection: options.delegationSelection }),
  };
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
    schemaVersion: 23,
    execution: {
      posture: "trusted",
      bashAuthority: "current_os_user",
      enabledMcpIntegrationsMayPerformExternalEffects: true,
    },
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
    subagents: { status: "observed", runs: [] },
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
  const observation =
    options.pass === true
      ? ({ harnessOutcome: "completed", taskOutcome: "verified" } as const)
      : options.harnessOutcome === "timeout" ||
          options.harnessOutcome === "crashed"
        ? { harnessOutcome: options.harnessOutcome }
        : ({
            harnessOutcome: "completed",
            taskOutcome: "verify_failed",
          } as const);
  const resultCondition = evalFixtureCondition(options);
  return {
    schemaVersion: 4,
    timestamp: "2026-06-22T00:00:00.000Z",
    keelVersion: "0.0.1",
    taskId: options.taskId,
    trial: options.trial,
    ...resultCondition,
    ...evalResultVerdict(observation),
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
