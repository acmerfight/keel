import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

export interface PatchCoverageOptions {
  readonly cwd: string;
  readonly compareBranch: string;
  readonly coveragePath: string;
  readonly failUnder: number;
}

interface PatchCoverageFailure {
  readonly path: string;
  readonly line: number;
  readonly message: string;
}

export interface PatchCoverageReport {
  readonly passed: boolean;
  readonly coveredLines: number;
  readonly measuredLines: number;
  readonly unmeasuredLines: number;
  readonly percentCovered: number;
  readonly failures: readonly PatchCoverageFailure[];
}

type LineCoverage = {
  readonly hits: number | null;
  readonly branches: readonly BranchCoverage[];
};

interface BranchCoverage {
  readonly taken: number;
}

type ChangedLinesByPath = Map<string, Set<number>>;
type CoverageByPath = Map<string, Map<number, LineCoverage>>;

export function runPatchCoverageCheck(
  options: PatchCoverageOptions,
): PatchCoverageReport {
  const changedLines = changedLinesAgainstBranch(
    options.cwd,
    options.compareBranch,
  );
  const coverage = parseLcov(
    readFileSync(resolve(options.cwd, options.coveragePath), "utf8"),
    options.cwd,
  );
  return analyzePatchCoverage(changedLines, coverage, options.failUnder);
}

export function formatPatchCoverageReport(report: PatchCoverageReport): string {
  const lines: string[] = [];
  const status = report.passed ? "passed" : "failed";
  if (report.measuredLines === 0) {
    lines.push(`Patch coverage ${status}: no changed coverable lines`);
  } else {
    lines.push(
      `Patch coverage ${status}: ${report.coveredLines}/${report.measuredLines} changed coverable lines covered (${report.percentCovered.toFixed(2)}%)`,
    );
  }

  for (const failure of report.failures) {
    lines.push(`${failure.path}:${failure.line} ${failure.message}`);
  }

  if (report.unmeasuredLines > 0) {
    const noun = report.unmeasuredLines === 1 ? "line was" : "lines were";
    lines.push(
      `${report.unmeasuredLines} changed ${noun} not present in coverage data`,
    );
  }

  return `${lines.join("\n")}\n`;
}

function changedLinesAgainstBranch(
  cwd: string,
  compareBranch: string,
): ChangedLinesByPath {
  const diff = execFileSync(
    "git",
    [
      "-c",
      "core.quotePath=false",
      "diff",
      "--relative",
      "--unified=0",
      "--no-color",
      "--diff-filter=AMCR",
      `${compareBranch}...HEAD`,
      "--",
    ],
    { cwd, encoding: "utf8" },
  );
  return parseChangedLines(diff);
}

export function parseChangedLines(diff: string): ChangedLinesByPath {
  const changedLines: ChangedLinesByPath = new Map();
  let currentPath: string | null = null;

  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      currentPath = parseNewDiffPath(line);
      continue;
    }
    if (!line.startsWith("@@ ") || currentPath === null) continue;

    const hunk = parseHunkHeader(line);
    if (hunk === null) continue;
    const lines = changedLines.get(currentPath) ?? new Set<number>();
    for (let offset = 0; offset < hunk.count; offset += 1) {
      lines.add(hunk.start + offset);
    }
    changedLines.set(currentPath, lines);
  }

  return changedLines;
}

function parseLcov(content: string, cwd: string): CoverageByPath {
  const coverage: CoverageByPath = new Map();
  let currentCoverage: Map<number, LineCoverage> | null = null;

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("SF:")) {
      const currentPath = normalizeCoveragePath(line.slice(3), cwd);
      currentCoverage = coverage.get(currentPath) ?? new Map();
      coverage.set(currentPath, currentCoverage);
      continue;
    }
    if (currentCoverage === null) continue;

    if (line.startsWith("DA:")) {
      const lineCoverage = parseLineCoverage(line);
      if (lineCoverage === null) continue;
      const existing =
        currentCoverage.get(lineCoverage.line) ?? emptyLineCoverage();
      currentCoverage.set(lineCoverage.line, {
        hits:
          existing.hits === null
            ? lineCoverage.hits
            : Math.max(existing.hits, lineCoverage.hits),
        branches: existing.branches,
      });
      continue;
    }

    if (line.startsWith("BRDA:")) {
      const branchCoverage = parseBranchCoverage(line);
      if (branchCoverage === null) continue;
      const existing =
        currentCoverage.get(branchCoverage.line) ?? emptyLineCoverage();
      currentCoverage.set(branchCoverage.line, {
        hits: existing.hits,
        branches: [...existing.branches, { taken: branchCoverage.taken }],
      });
    }
  }

  return coverage;
}

function analyzePatchCoverage(
  changedLines: ChangedLinesByPath,
  coverage: CoverageByPath,
  failUnder: number,
): PatchCoverageReport {
  const failures: PatchCoverageFailure[] = [];
  let measuredLines = 0;
  let coveredLines = 0;
  let unmeasuredLines = 0;

  for (const [path, lines] of changedLines) {
    const fileCoverage = coverage.get(path);
    for (const line of [...lines].sort((left, right) => left - right)) {
      const lineCoverage = fileCoverage?.get(line);
      if (lineCoverage === undefined) {
        unmeasuredLines += 1;
        continue;
      }

      measuredLines += 1;
      if (lineCoverage.hits === 0) {
        failures.push({ path, line, message: "uncovered line" });
        continue;
      }

      const coveredBranches = lineCoverage.branches.filter(
        (branch) => branch.taken > 0,
      ).length;
      if (
        lineCoverage.branches.length > 0 &&
        coveredBranches < lineCoverage.branches.length
      ) {
        failures.push({
          path,
          line,
          message: `partial branch (${coveredBranches}/${lineCoverage.branches.length} branches covered)`,
        });
        continue;
      }

      coveredLines += 1;
    }
  }

  const percentCovered =
    measuredLines === 0 ? 100 : (coveredLines / measuredLines) * 100;
  return {
    passed: percentCovered >= failUnder,
    coveredLines,
    measuredLines,
    unmeasuredLines,
    percentCovered,
    failures,
  };
}

function parseNewDiffPath(line: string): string | null {
  const rawPath = line.slice(4);
  return normalizeGitPath(rawPath.slice(2));
}

function parseHunkHeader(
  line: string,
): { readonly start: number; readonly count: number } | null {
  if (!/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.test(line)) return null;
  const plusIndex = line.indexOf("+");
  const rangeEnd = line.indexOf(" ", plusIndex);
  const range = line.slice(plusIndex + 1, rangeEnd);
  const commaIndex = range.indexOf(",");
  return commaIndex === -1
    ? { start: Number.parseInt(range, 10), count: 1 }
    : {
        start: Number.parseInt(range.slice(0, commaIndex), 10),
        count: Number.parseInt(range.slice(commaIndex + 1), 10),
      };
}

function parseLineCoverage(
  line: string,
): { readonly line: number; readonly hits: number } | null {
  const [lineRaw, hitsRaw] = line.slice(3).split(",");
  if (lineRaw === undefined || hitsRaw === undefined) return null;
  const lineNumber = parseInteger(lineRaw);
  const hits = parseInteger(hitsRaw);
  if (lineNumber === null || hits === null) return null;
  return { line: lineNumber, hits };
}

function parseBranchCoverage(
  line: string,
): { readonly line: number; readonly taken: number } | null {
  const [lineRaw, , , takenRaw] = line.slice(5).split(",");
  if (lineRaw === undefined || takenRaw === undefined) return null;
  const lineNumber = parseInteger(lineRaw);
  const taken = takenRaw === "-" ? 0 : parseInteger(takenRaw);
  if (lineNumber === null || taken === null) return null;
  return { line: lineNumber, taken };
}

function emptyLineCoverage(): LineCoverage {
  return { hits: null, branches: [] };
}

function parseInteger(raw: string): number | null {
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

function normalizeCoveragePath(path: string, cwd: string): string {
  if (isAbsolute(path)) return normalizeGitPath(relative(cwd, path));
  return normalizeGitPath(path);
}

function normalizeGitPath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}
