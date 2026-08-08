import { readFileSync } from "node:fs";
import { errorMessage } from "../core/error.ts";
import type { RunReport } from "./report-schema.ts";
import {
  type EvalHarnessOutcome,
  type EvalResultLine,
  type EvalTaskOutcome,
  evalHarnessOutcomes,
  evalResultLineSchema,
  evalTaskOutcomes,
} from "./result-schema.ts";

interface MetricSummary {
  readonly count: number;
  readonly average: number | null;
}

interface SelectionSummary {
  readonly count: number;
  readonly observed: number;
  readonly satisfied: number;
}

interface HarnessOutcomeCount {
  readonly outcome: EvalHarnessOutcome;
  readonly count: number;
}

interface TaskOutcomeCount {
  readonly outcome: EvalTaskOutcome;
  readonly count: number;
}

interface TaskSummary {
  readonly taskId: string;
  readonly trials: number;
  readonly passes: number;
  readonly passRate: number;
  readonly harnessOutcomes: readonly HarnessOutcomeCount[];
  readonly taskOutcomes: readonly TaskOutcomeCount[];
  readonly harnessFailures: number;
  readonly harnessFailureRate: number;
  readonly failedTranscripts: readonly string[];
  readonly selection: SelectionSummary;
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

function readEvalResultLines(filePath: string): readonly EvalResultLine[] {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (error) {
    throw new Error(
      `cannot read eval result file ${filePath}: ${errorMessage(error)}`,
    );
  }

  const results: EvalResultLine[] = [];
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
        `cannot read eval result file ${filePath}: line ${index + 1} is not a schemaVersion 3 eval result.`,
      );
    }
    results.push(parsedLine.data);
  }

  if (results.length === 0) {
    throw new Error(`eval result file ${filePath} has no result lines.`);
  }

  return results;
}

function groupByTask(
  lines: readonly EvalResultLine[],
): ReadonlyMap<string, readonly EvalResultLine[]> {
  const groups = new Map<string, EvalResultLine[]>();
  for (const line of lines) {
    const groupId =
      line.condition === "standard"
        ? line.taskId
        : `${line.taskId} [${line.condition}]`;
    let group = groups.get(groupId);
    if (group === undefined) {
      group = [];
      groups.set(groupId, group);
    }
    group.push(line);
  }
  return groups;
}

function summarizeMetric(values: readonly number[]): MetricSummary {
  if (values.length === 0) return { count: 0, average: null };
  const total = values.reduce((sum, value) => sum + value, 0);
  return { count: values.length, average: total / values.length };
}

function reportMetric(
  lines: readonly EvalResultLine[],
  read: (report: RunReport) => number,
): MetricSummary {
  const values: number[] = [];
  for (const line of lines) {
    if (line.report !== undefined) values.push(read(line.report));
  }
  return summarizeMetric(values);
}

function summarizeTask(
  taskId: string,
  lines: readonly EvalResultLine[],
): TaskSummary {
  const passes = lines.filter((line) => line.pass).length;
  const harnessOutcomes = evalHarnessOutcomes.map((outcome) => ({
    outcome,
    count: lines.filter((line) => line.harnessOutcome === outcome).length,
  }));
  const taskOutcomes = evalTaskOutcomes.map((outcome) => ({
    outcome,
    count: lines.filter(
      (line) =>
        line.harnessOutcome === "completed" && line.taskOutcome === outcome,
    ).length,
  }));
  const harnessFailures = lines.filter(
    (line) => line.harnessOutcome !== "completed",
  ).length;
  const failedTranscripts = lines.flatMap((line) =>
    line.pass === false && line.transcriptPath !== undefined
      ? [line.transcriptPath]
      : [],
  );
  const selectionLines = lines.flatMap((line) =>
    line.delegationSelection === undefined ? [] : [line.delegationSelection],
  );

  return {
    taskId,
    trials: lines.length,
    passes,
    passRate: passes / lines.length,
    harnessOutcomes,
    taskOutcomes,
    harnessFailures,
    harnessFailureRate: harnessFailures / lines.length,
    failedTranscripts,
    selection: {
      count: selectionLines.length,
      observed: selectionLines.filter(
        (selection) => selection.status === "observed",
      ).length,
      satisfied: selectionLines.filter(
        (selection) => selection.status === "observed" && selection.satisfied,
      ).length,
    },
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
  baseGroups: ReadonlyMap<string, readonly EvalResultLine[]>,
  headGroups: ReadonlyMap<string, readonly EvalResultLine[]>,
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

function formatOutcomeCounts(
  outcomes: readonly { readonly outcome: string; readonly count: number }[],
): string {
  const parts = outcomes.flatMap((outcome) =>
    outcome.count === 0 ? [] : [`${outcome.outcome}=${outcome.count}`],
  );
  return parts.join(", ");
}

function formatHarnessOutcomes(summary: TaskSummary | undefined): string {
  if (summary === undefined) return "missing";
  return formatOutcomeCounts(summary.harnessOutcomes);
}

function formatTaskOutcomes(summary: TaskSummary | undefined): string {
  if (summary === undefined) return "missing";
  return formatOutcomeCounts(summary.taskOutcomes);
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

function selectionRate(selection: SelectionSummary): number | null {
  return selection.count === 0 ? null : selection.satisfied / selection.count;
}

function selectionRegressed(base: TaskSummary, head: TaskSummary): boolean {
  const baseRate = selectionRate(base.selection);
  const headRate = selectionRate(head.selection);
  return baseRate !== null && headRate !== null && headRate < baseRate;
}

function selectionImproved(base: TaskSummary, head: TaskSummary): boolean {
  const baseRate = selectionRate(base.selection);
  const headRate = selectionRate(head.selection);
  return baseRate !== null && headRate !== null && headRate > baseRate;
}

function statusFor(
  base: TaskSummary | undefined,
  head: TaskSummary | undefined,
): string {
  if (base === undefined) return "ADDED";
  if (head === undefined) return "REMOVED";
  if (head.harnessFailureRate > base.harnessFailureRate) {
    return "HARNESS FAILURE";
  }
  if (head.passRate < base.passRate) return "REGRESSION";
  if (head.passRate > base.passRate) return "IMPROVEMENT";
  if (selectionRegressed(base, head)) return "SELECTION REGRESSION";
  if (selectionImproved(base, head)) return "SELECTION IMPROVEMENT";
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

function formatSelection(summary: TaskSummary | undefined): string {
  if (summary === undefined) return "missing";
  if (summary.selection.count === 0) return "n/a";
  return `${summary.selection.satisfied}/${summary.selection.count} satisfied, ${summary.selection.observed}/${summary.selection.count} observed`;
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
    `  harness: ${formatHarnessOutcomes(base)} -> ${formatHarnessOutcomes(head)}`,
    `  task outcomes: ${formatTaskOutcomes(base)} -> ${formatTaskOutcomes(head)}`,
    `  selection: ${formatSelection(base)} -> ${formatSelection(head)}`,
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

  if (
    head !== undefined &&
    head.failedTranscripts.length > 0 &&
    (status === "REGRESSION" || status === "HARNESS FAILURE")
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
  const baseGroups = groupByTask(baseLines);
  const headGroups = groupByTask(headLines);
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
      summarizeTask(
        "suite",
        baseLines.filter((line) => line.requiredToPass),
      ),
      summarizeTask(
        "suite",
        headLines.filter((line) => line.requiredToPass),
      ),
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
