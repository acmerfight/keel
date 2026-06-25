#!/usr/bin/env node
import {
  formatPatchCoverageReport,
  runPatchCoverageCheck,
} from "../src/core/coverage-patch.ts";
import { errorMessage } from "../src/core/error.ts";

interface CliOptions {
  readonly compareBranch: string;
  readonly coveragePath: string;
  readonly failUnder: number;
}

function parseArgs(args: readonly string[]): CliOptions {
  let compareBranch = "origin/main";
  let coveragePath = "coverage/lcov.info";
  let failUnder = 100;

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
    if (arg === "--fail-under") {
      const rawFailUnder = requiredValue(args, index, arg);
      failUnder = Number.parseFloat(rawFailUnder);
      if (!Number.isFinite(failUnder)) {
        throw new Error(`Invalid --fail-under value: ${rawFailUnder}`);
      }
      index += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(helpText());
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return { compareBranch, coveragePath, failUnder };
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
  return `Usage: coverage-patch [--compare-branch <branch>] [--coverage <path>] [--fail-under <percent>]

Checks changed measured LCOV lines and branch records against a git compare branch.
`;
}

try {
  const options = parseArgs(process.argv.slice(2));
  const report = runPatchCoverageCheck({
    cwd: process.cwd(),
    compareBranch: options.compareBranch,
    coveragePath: options.coveragePath,
    failUnder: options.failUnder,
  });
  process.stdout.write(formatPatchCoverageReport(report));
  process.exitCode = report.passed ? 0 : 1;
} catch (error) {
  process.stderr.write(`${errorMessage(error)}\n`);
  process.exitCode = 2;
}
