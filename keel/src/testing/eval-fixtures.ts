import { writeFile } from "node:fs/promises";

type EvalTrialOutcome = "verified" | "verify_failed" | "timeout" | "crashed";

export interface EvalRunReport {
  readonly schemaVersion: 6;
  readonly modelsUsed: readonly {
    readonly provider: string;
    readonly model: string;
  }[];
  readonly usageByModel: readonly {
    readonly provider: string;
    readonly model: string;
    readonly turns: number;
    readonly usage: {
      readonly inputTokens: number;
      readonly cachedInputTokens: number;
      readonly uncachedInputTokens: number;
      readonly outputTokens: number;
    };
    readonly costUsd: number;
  }[];
  readonly turns: number;
  readonly stopReason: string;
  readonly usage: {
    readonly inputTokens: number;
    readonly cachedInputTokens: number;
    readonly uncachedInputTokens: number;
    readonly outputTokens: number;
  };
  readonly durationMs: number;
  readonly costUsd: number;
  readonly costBudgetUsd?: number;
  readonly costOvershootUsd: number;
  readonly contextCompactions: readonly unknown[];
  readonly skillActivations: readonly unknown[];
  readonly skillCatalog: {
    readonly exposed: number;
    readonly omitted: number;
    readonly total: number;
    readonly budgetChars: number;
    readonly usedChars: number;
  };
}

export interface EvalResultLine {
  readonly schemaVersion: 1;
  readonly timestamp: string;
  readonly keelVersion: string;
  readonly taskId: string;
  readonly trial: number;
  readonly pass: boolean;
  readonly outcome: EvalTrialOutcome;
  readonly wallMs: number;
  readonly report?: EvalRunReport;
  readonly transcriptPath?: string;
}

export interface EvalRunReportOptions {
  readonly turns?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly durationMs?: number;
  readonly costUsd?: number;
}

export interface EvalResultLineOptions {
  readonly taskId: string;
  readonly trial: number;
  readonly pass: boolean;
  readonly outcome?: EvalTrialOutcome;
  readonly wallMs?: number;
  readonly report?: EvalRunReport;
  readonly transcriptPath?: string;
}

export function evalRunReport(
  options: EvalRunReportOptions = {},
): EvalRunReport {
  const inputTokens = options.inputTokens ?? 100;
  const usage = {
    inputTokens,
    cachedInputTokens: 0,
    uncachedInputTokens: inputTokens,
    outputTokens: options.outputTokens ?? 20,
  };
  const costUsd = options.costUsd ?? 0.001;
  return {
    schemaVersion: 6,
    modelsUsed: [{ provider: "deepseek", model: "deepseek-v4-flash" }],
    usageByModel: [
      {
        provider: "deepseek",
        model: "deepseek-v4-flash",
        turns: options.turns ?? 3,
        usage,
        costUsd,
      },
    ],
    turns: options.turns ?? 3,
    stopReason: "completed",
    usage,
    durationMs: options.durationMs ?? 1000,
    costUsd,
    costOvershootUsd: 0,
    contextCompactions: [],
    skillActivations: [],
    skillCatalog: {
      exposed: 0,
      omitted: 0,
      total: 0,
      budgetChars: 8000,
      usedChars: 0,
    },
  };
}

export function evalResultLine(options: EvalResultLineOptions): EvalResultLine {
  return {
    schemaVersion: 1,
    timestamp: "2026-06-22T00:00:00.000Z",
    keelVersion: "0.0.1",
    taskId: options.taskId,
    trial: options.trial,
    pass: options.pass,
    outcome:
      options.outcome ?? (options.pass === true ? "verified" : "verify_failed"),
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
