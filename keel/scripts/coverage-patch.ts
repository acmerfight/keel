#!/usr/bin/env node
import {
  formatPatchCoverageReport,
  runPatchCoverageCheck,
} from "../src/core/coverage-patch.ts";
import { errorMessage } from "../src/core/error.ts";

interface CliOptions {
  readonly compareBranch: string;
  readonly coveragePath: string;
  readonly minimumLineCoverage: number;
  readonly minimumBranchCoverage: number;
}

function parseArgs(args: readonly string[]): CliOptions {
  let compareBranch = "origin/main";
  let coveragePath = "coverage/lcov.info";
  let minimumLineCoverage = 95;
  let minimumBranchCoverage = 90;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--compare-branch") {
      compareBranch = requiredValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--coverage") {
      coveragePath = requiredValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--fail-under-lines") {
      minimumLineCoverage = coverageThreshold(
        requiredValue(args, index, arg),
        arg,
      );
      index += 1;
      continue;
    }
    if (arg === "--fail-under-branches") {
      minimumBranchCoverage = coverageThreshold(
        requiredValue(args, index, arg),
        arg,
      );
      index += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(helpText());
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return {
    compareBranch,
    coveragePath,
    minimumLineCoverage,
    minimumBranchCoverage,
  };
}

function coverageThreshold(raw: string, flag: string): number {
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new Error(`Invalid ${flag} value: ${raw}`);
  }
  return value;
}

function requiredValue(
  args: readonly string[],
  index: number,
  flag: string,
): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

function helpText(): string {
  return `Usage: coverage-patch [--compare-branch <branch>] [--coverage <path>] [--fail-under-lines <percent>] [--fail-under-branches <percent>]

Checks changed measured LCOV lines and branches independently against a git compare branch.
`;
}

try {
  const options = parseArgs(process.argv.slice(2));
  const report = runPatchCoverageCheck({
    cwd: process.cwd(),
    compareBranch: options.compareBranch,
    coveragePath: options.coveragePath,
    minimumLineCoverage: options.minimumLineCoverage,
    minimumBranchCoverage: options.minimumBranchCoverage,
  });
  process.stdout.write(formatPatchCoverageReport(report));
  process.exitCode = report.passed ? 0 : 1;
} catch (error) {
  process.stderr.write(`${errorMessage(error)}\n`);
  process.exitCode = 2;
}
