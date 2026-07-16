import { readFileSync } from "node:fs";
import { errorMessage } from "../core/error.ts";
import type { RunReport } from "./report-schema.ts";
import {
  evalResultLineSchema,
  type PairDelta,
  type EvalResultLine as ResultLine,
  type TrialOutcome,
  trialOutcomes,
} from "./result.ts";

interface MetricSummary {
  readonly count: number;
  readonly average: number | null;
}

interface OutcomeCount {
  readonly outcome: TrialOutcome;
  readonly count: number;
}

interface TaskSummary {
  readonly taskId: string;
  readonly trials: number;
  readonly passes: number;
  readonly passRate: number;
  readonly outcomes: readonly OutcomeCount[];
  readonly harnessFailures: number;
  readonly harnessFailureRate: number;
  readonly structuralFailures: readonly string[];
  readonly failedTranscripts: readonly string[];
  readonly humanInterventions: MetricSummary;
  readonly turns: MetricSummary;
  readonly inputTokens: MetricSummary;
  readonly outputTokens: MetricSummary;
  readonly costUsd: MetricSummary;
  readonly wallMs: MetricSummary;
}

export interface EvalCompareCommandArgs {
  readonly baseFile: string;
  readonly headFile: string;
}

type ResultGroup = [ResultLine, ...ResultLine[]];

function readEvalResultLines(filePath: string): ResultGroup {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (error) {
    throw new Error(
      `cannot read eval result file ${filePath}: ${errorMessage(error)}`,
    );
  }

  let results: ResultGroup | null = null;
  for (const [index, line] of raw.split(/\r?\n/u).entries()) {
    if (line.trim() === "") continue;

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(line);
    } catch {
      throw new Error(
        `cannot read eval result file ${filePath}: line ${index + 1} is not valid JSON.`,
      );
    }

    const parsedLine = evalResultLineSchema.safeParse(parsedJson);
    if (!parsedLine.success) {
      throw new Error(
        `cannot read eval result file ${filePath}: line ${index + 1} is not a schemaVersion 2 eval result.`,
      );
    }
    if (results === null) {
      results = [parsedLine.data];
    } else {
      results.push(parsedLine.data);
    }
  }

  if (results === null) {
    throw new Error(`eval result file ${filePath} has no result lines.`);
  }

  return results;
}

function groupByTask(lines: ResultGroup): ReadonlyMap<string, ResultGroup> {
  const groups = new Map<string, ResultGroup>();
  for (const line of lines) {
    const groupId =
      line.condition === "standard"
        ? line.taskId
        : `${line.taskId} [${line.condition}]`;
    const group = groups.get(groupId);
    if (group === undefined) {
      groups.set(groupId, [line]);
    } else {
      group.push(line);
    }
  }
  return groups;
}

function knownCohortValue(
  filePath: string,
  label: "provider" | "model",
  lines: ResultGroup,
): string {
  const values = new Set(lines.map((line) => line[label]));
  if (values.size > 1) {
    throw new Error(
      `eval result file ${filePath} mixes ${label} values in one cohort.`,
    );
  }
  return lines[0][label];
}

function sameStringArray(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function validateTaskGroup(
  filePath: string,
  groupId: string,
  lines: ResultGroup,
): void {
  const first = lines[0];
  if (lines.some((line) => line.corpusVersion !== first.corpusVersion)) {
    throw new Error(
      `eval result file ${filePath} mixes corpus versions for ${groupId}.`,
    );
  }
  if (lines.some((line) => line.repetitionCount !== first.repetitionCount)) {
    throw new Error(
      `eval result file ${filePath} mixes repetition counts for ${groupId}.`,
    );
  }
  if (lines.some((line) => line.requiredToPass !== first.requiredToPass)) {
    throw new Error(
      `eval result file ${filePath} mixes pass policies for ${groupId}.`,
    );
  }
  const trials = lines
    .map((line) => line.trial)
    .sort((left, right) => left - right);
  if (
    trials.length !== first.repetitionCount ||
    trials.some((trial, index) => trial !== index + 1)
  ) {
    throw new Error(
      `eval result file ${filePath} requires exactly trials 1..${first.repetitionCount} for ${groupId}.`,
    );
  }
}

function pairReportDelta(
  disabled: ResultLine,
  enabled: ResultLine,
  select: (report: RunReport) => number,
): number | null {
  return disabled.report === null || enabled.report === null
    ? null
    : select(enabled.report) - select(disabled.report);
}

function expectedPairDelta(
  disabled: ResultLine,
  enabled: ResultLine,
): PairDelta {
  return {
    successPercentagePoints:
      (Number(enabled.pass) - Number(disabled.pass)) * 100,
    toolCalls: enabled.toolCalls.length - disabled.toolCalls.length,
    agentLoopTurns: pairReportDelta(
      disabled,
      enabled,
      (report) => report.agentLoopTurns,
    ),
    inputTokens: pairReportDelta(
      disabled,
      enabled,
      (report) => report.usage.inputTokens,
    ),
    outputTokens: pairReportDelta(
      disabled,
      enabled,
      (report) => report.usage.outputTokens,
    ),
    costUsd: pairReportDelta(disabled, enabled, (report) => report.costUsd),
    wallMs: enabled.wallMs - disabled.wallMs,
    renderedBytes: pairReportDelta(
      disabled,
      enabled,
      (report) => report.memory.renderedBytes,
    ),
  };
}

function validateMemoryPairs(filePath: string, lines: ResultGroup): void {
  const byTask = new Map<string, ResultLine[]>();
  for (const line of lines) {
    const taskLines = byTask.get(line.taskId) ?? [];
    taskLines.push(line);
    byTask.set(line.taskId, taskLines);
  }
  for (const [taskId, taskLines] of byTask) {
    const conditions = new Set(taskLines.map((line) => line.condition));
    if (conditions.has("standard") && conditions.size > 1) {
      throw new Error(
        `eval result file ${filePath} mixes standard and memory conditions for ${taskId}.`,
      );
    }
    if (conditions.has("standard")) continue;
    if (
      !conditions.has("memory_disabled") ||
      !conditions.has("memory_enabled")
    ) {
      throw new Error(
        `eval result file ${filePath} has an incomplete memory pair for ${taskId}.`,
      );
    }
    const disabledLines = taskLines.filter(
      (line) => line.condition === "memory_disabled",
    );
    const enabledLines = taskLines.filter(
      (line) => line.condition === "memory_enabled",
    );
    if (disabledLines.length !== enabledLines.length) {
      throw new Error(
        `eval result file ${filePath} has an incomplete memory pair for ${taskId}.`,
      );
    }
    const enabledByTrial = new Map(
      enabledLines.map((line) => [line.trial, line]),
    );
    for (const disabled of disabledLines) {
      const enabled = enabledByTrial.get(disabled.trial);
      if (enabled === undefined) {
        throw new Error(
          `eval result file ${filePath} has an incomplete memory pair for ${taskId} trial ${disabled.trial}.`,
        );
      }
      if (
        disabled.corpusVersion !== enabled.corpusVersion ||
        disabled.repetitionCount !== enabled.repetitionCount ||
        !sameStringArray(
          disabled.memory.configuredIds,
          enabled.memory.configuredIds,
        ) ||
        JSON.stringify(disabled.memory.scope) !==
          JSON.stringify(enabled.memory.scope)
      ) {
        throw new Error(
          `eval result file ${filePath} has mismatched memory-pair evidence for ${taskId} trial ${disabled.trial}.`,
        );
      }
      const expectedDelta = expectedPairDelta(disabled, enabled);
      if (
        JSON.stringify(disabled.pairDelta) !== JSON.stringify(expectedDelta) ||
        JSON.stringify(enabled.pairDelta) !== JSON.stringify(expectedDelta)
      ) {
        throw new Error(
          `eval result file ${filePath} has an invalid pair delta for ${taskId} trial ${disabled.trial}.`,
        );
      }
    }
  }
}

function validateResultCohort(filePath: string, lines: ResultGroup): void {
  knownCohortValue(filePath, "provider", lines);
  knownCohortValue(filePath, "model", lines);
  const revisions = new Set(lines.map((line) => line.keelRevision));
  if (revisions.size > 1) {
    throw new Error(
      `eval result file ${filePath} mixes Keel revisions in one cohort.`,
    );
  }
  validateMemoryPairs(filePath, lines);
  for (const [groupId, taskLines] of groupByTask(lines)) {
    validateTaskGroup(filePath, groupId, taskLines);
  }
}

function validateComparableCohorts(
  baseFile: string,
  headFile: string,
  baseLines: ResultGroup,
  headLines: ResultGroup,
  baseGroups: ReadonlyMap<string, ResultGroup>,
  headGroups: ReadonlyMap<string, ResultGroup>,
): void {
  for (const label of ["provider", "model"] as const) {
    if (
      knownCohortValue(baseFile, label, baseLines) !==
      knownCohortValue(headFile, label, headLines)
    ) {
      throw new Error(
        `cannot compare eval cohorts: ${label} differs between ${baseFile} and ${headFile}.`,
      );
    }
  }
  for (const [groupId, baseLines] of baseGroups) {
    const headLines = headGroups.get(groupId);
    if (headLines === undefined) continue;
    const base = baseLines[0];
    const head = headLines[0];
    if (base.corpusVersion !== head.corpusVersion) {
      throw new Error(
        `cannot compare ${groupId}: corpus version differs between ${baseFile} and ${headFile}.`,
      );
    }
    if (base.requiredToPass !== head.requiredToPass) {
      throw new Error(
        `cannot compare ${groupId}: pass policy differs between ${baseFile} and ${headFile}.`,
      );
    }
  }
}

function summarizeMetric(values: readonly number[]): MetricSummary {
  if (values.length === 0) return { count: 0, average: null };
  const total = values.reduce((sum, value) => sum + value, 0);
  return { count: values.length, average: total / values.length };
}

function reportMetric(
  lines: readonly ResultLine[],
  read: (report: RunReport) => number,
): MetricSummary {
  const values: number[] = [];
  for (const line of lines) {
    if (line.report !== null) values.push(read(line.report));
  }
  return summarizeMetric(values);
}

function summarizeTask(
  taskId: string,
  lines: readonly ResultLine[],
): TaskSummary {
  const passes = lines.filter((line) => line.pass).length;
  const outcomesForTask = trialOutcomes.map((outcome) => ({
    outcome,
    count: lines.filter((line) => line.outcome === outcome).length,
  }));
  const harnessFailures = lines.filter(
    (line) => line.outcome === "timeout" || line.outcome === "crashed",
  ).length;
  const failedTranscripts = lines.flatMap((line) =>
    line.pass === false && line.transcriptPath !== null
      ? [line.transcriptPath]
      : [],
  );

  return {
    taskId,
    trials: lines.length,
    passes,
    passRate: passes / lines.length,
    outcomes: outcomesForTask,
    harnessFailures,
    harnessFailureRate: harnessFailures / lines.length,
    structuralFailures: lines.flatMap((line) => line.structuralFailures),
    failedTranscripts,
    humanInterventions: reportMetric(
      lines,
      (report) => report.humanInterventionCount,
    ),
    turns: reportMetric(lines, (report) => report.agentLoopTurns),
    inputTokens: reportMetric(lines, (report) => report.usage.inputTokens),
    outputTokens: reportMetric(lines, (report) => report.usage.outputTokens),
    costUsd: reportMetric(lines, (report) => report.costUsd),
    wallMs: summarizeMetric(lines.map((line) => line.wallMs)),
  };
}

function sortedTaskIds(
  baseGroups: ReadonlyMap<string, readonly ResultLine[]>,
  headGroups: ReadonlyMap<string, readonly ResultLine[]>,
): readonly string[] {
  const taskIds = new Set<string>();
  for (const taskId of baseGroups.keys()) taskIds.add(taskId);
  for (const taskId of headGroups.keys()) taskIds.add(taskId);
  return [...taskIds].sort();
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function formatSignedFixed(value: number, digits: number): string {
  const rounded = Number(value.toFixed(digits));
  return `${rounded >= 0 ? "+" : ""}${rounded.toFixed(digits)}`;
}

function formatSignedUsd(value: number): string {
  const rounded = Number(value.toFixed(6));
  const sign = rounded >= 0 ? "+" : "-";
  return `${sign}$${Math.abs(rounded).toFixed(6)}`;
}

function formatPass(summary: TaskSummary | undefined): string {
  if (summary === undefined) return "missing";
  return `${summary.passes}/${summary.trials} (${formatPercent(summary.passRate)})`;
}

function formatPassComparison(
  base: TaskSummary | undefined,
  head: TaskSummary | undefined,
): string {
  const delta =
    base !== undefined && head !== undefined
      ? ` (${formatSignedFixed((head.passRate - base.passRate) * 100, 1)}pp)`
      : "";
  return `${formatPass(base)} -> ${formatPass(head)}${delta}`;
}

function formatOutcomeCounts(summary: TaskSummary | undefined): string {
  if (summary === undefined) return "missing";
  const parts = summary.outcomes.flatMap((outcome) =>
    outcome.count === 0 ? [] : [`${outcome.outcome}=${outcome.count}`],
  );
  return parts.join(", ");
}

function formatMetricValue(
  summary: MetricSummary | undefined,
  format: (value: number) => string,
): string {
  if (summary === undefined || summary.average === null) return "n/a";
  return format(summary.average);
}

function formatMetricComparison(
  base: MetricSummary | undefined,
  head: MetricSummary | undefined,
  formatValue: (value: number) => string,
  formatDelta: (value: number) => string,
): string {
  const baseAverage = base?.average ?? null;
  const headAverage = head?.average ?? null;
  const delta =
    baseAverage !== null && headAverage !== null
      ? ` (${formatDelta(headAverage - baseAverage)})`
      : "";
  return `${formatMetricValue(base, formatValue)} -> ${formatMetricValue(head, formatValue)}${delta}`;
}

function metricIncreased(base: MetricSummary, head: MetricSummary): boolean {
  return (
    base.average !== null &&
    head.average !== null &&
    head.average > base.average
  );
}

function metricDecreased(base: MetricSummary, head: MetricSummary): boolean {
  return (
    base.average !== null &&
    head.average !== null &&
    head.average < base.average
  );
}

function efficiencyRegressed(base: TaskSummary, head: TaskSummary): boolean {
  return (
    metricIncreased(base.turns, head.turns) ||
    metricIncreased(base.inputTokens, head.inputTokens) ||
    metricIncreased(base.outputTokens, head.outputTokens) ||
    metricIncreased(base.costUsd, head.costUsd) ||
    metricIncreased(base.wallMs, head.wallMs)
  );
}

function efficiencyImproved(base: TaskSummary, head: TaskSummary): boolean {
  return (
    metricDecreased(base.turns, head.turns) ||
    metricDecreased(base.inputTokens, head.inputTokens) ||
    metricDecreased(base.outputTokens, head.outputTokens) ||
    metricDecreased(base.costUsd, head.costUsd) ||
    metricDecreased(base.wallMs, head.wallMs)
  );
}

function statusFor(
  base: TaskSummary | undefined,
  head: TaskSummary | undefined,
): string {
  if (base === undefined) return "ADDED";
  if (head === undefined) return "REMOVED";
  if (head.structuralFailures.length > 0) return "STRUCTURAL FAILURE";
  if (head.harnessFailureRate > base.harnessFailureRate) {
    return "HARNESS FAILURE";
  }
  if (head.passRate < base.passRate) return "REGRESSION";
  if (head.passRate > base.passRate) return "IMPROVEMENT";
  if (metricIncreased(base.humanInterventions, head.humanInterventions)) {
    return "INTERVENTION REGRESSION";
  }
  if (metricDecreased(base.humanInterventions, head.humanInterventions)) {
    return "INTERVENTION IMPROVEMENT";
  }
  if (efficiencyRegressed(base, head)) return "EFFICIENCY REGRESSION";
  if (efficiencyImproved(base, head)) return "EFFICIENCY IMPROVEMENT";
  return "UNCHANGED";
}

function renderTaskComparison(
  taskId: string,
  base: TaskSummary | undefined,
  head: TaskSummary | undefined,
): readonly string[] {
  const status = statusFor(base, head);
  const lines = [
    `task: ${taskId}`,
    `  status: ${status}`,
    `  pass: ${formatPassComparison(base, head)}`,
    `  outcomes: ${formatOutcomeCounts(base)} -> ${formatOutcomeCounts(head)}`,
    `  human interventions avg: ${formatMetricComparison(
      base?.humanInterventions,
      head?.humanInterventions,
      (value) => value.toFixed(1),
      (value) => formatSignedFixed(value, 1),
    )}`,
    `  turns avg: ${formatMetricComparison(
      base?.turns,
      head?.turns,
      (value) => value.toFixed(1),
      (value) => formatSignedFixed(value, 1),
    )}`,
    `  input tokens avg: ${formatMetricComparison(
      base?.inputTokens,
      head?.inputTokens,
      (value) => value.toFixed(1),
      (value) => formatSignedFixed(value, 1),
    )}`,
    `  output tokens avg: ${formatMetricComparison(
      base?.outputTokens,
      head?.outputTokens,
      (value) => value.toFixed(1),
      (value) => formatSignedFixed(value, 1),
    )}`,
    `  cost avg: ${formatMetricComparison(
      base?.costUsd,
      head?.costUsd,
      (value) => `$${value.toFixed(6)}`,
      formatSignedUsd,
    )}`,
    `  wall avg: ${formatMetricComparison(
      base?.wallMs,
      head?.wallMs,
      (value) => `${value.toFixed(0)}ms`,
      (value) => `${formatSignedFixed(value, 0)}ms`,
    )}`,
  ];

  if (head !== undefined && head.harnessFailures > 0) {
    lines.push(`  head harness failures: ${head.harnessFailures}`);
  }

  if (head !== undefined && head.structuralFailures.length > 0) {
    lines.push("  structural failures:");
    for (const failure of head.structuralFailures) {
      lines.push(`    ${failure}`);
    }
  }

  if (
    head !== undefined &&
    head.failedTranscripts.length > 0 &&
    (status === "REGRESSION" ||
      status === "HARNESS FAILURE" ||
      status === "STRUCTURAL FAILURE")
  ) {
    lines.push("  regression transcripts:");
    for (const transcriptPath of head.failedTranscripts) {
      lines.push(`    ${transcriptPath}`);
    }
  }

  return lines;
}

function renderEvalComparison(args: EvalCompareCommandArgs): string {
  const baseLines = readEvalResultLines(args.baseFile);
  const headLines = readEvalResultLines(args.headFile);
  validateResultCohort(args.baseFile, baseLines);
  validateResultCohort(args.headFile, headLines);
  const baseGroups = groupByTask(baseLines);
  const headGroups = groupByTask(headLines);
  validateComparableCohorts(
    args.baseFile,
    args.headFile,
    baseLines,
    headLines,
    baseGroups,
    headGroups,
  );
  const output = [
    "Eval comparison:",
    `base: ${args.baseFile}`,
    `head: ${args.headFile}`,
    "",
  ];

  for (const taskId of sortedTaskIds(baseGroups, headGroups)) {
    const baseGroup = baseGroups.get(taskId);
    const headGroup = headGroups.get(taskId);
    output.push(
      ...renderTaskComparison(
        taskId,
        baseGroup === undefined ? undefined : summarizeTask(taskId, baseGroup),
        headGroup === undefined ? undefined : summarizeTask(taskId, headGroup),
      ),
      "",
    );
  }

  output.push(
    `suite pass: ${formatPassComparison(
      summarizeTask("suite", baseLines),
      summarizeTask("suite", headLines),
    )}`,
  );

  return `${output.join("\n")}\n`;
}

export function runEvalCompareCommand(args: EvalCompareCommandArgs): number {
  try {
    process.stdout.write(renderEvalComparison(args));
    return 0;
  } catch (error) {
    process.stderr.write(`Error: ${errorMessage(error)}\n`);
    return 1;
  }
}
