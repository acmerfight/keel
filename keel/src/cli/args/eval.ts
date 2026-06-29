import { join } from "node:path";
import {
  type ParseResult,
  parseError,
  parseModel,
  parseOk,
  parseProviderId,
  parseTrials,
  requireOptionValue,
  requireSeparatedOptionValue,
} from "./shared.ts";
import type {
  EvalCliArgs,
  EvalCompareCliArgs,
  EvalRunCliArgs,
} from "./types.ts";

const EVAL_COMPARE_OPTIONS = ["--base", "--head"];
const EVAL_RUN_OPTIONS = [
  "--suite",
  "--out",
  "--transcript-dir",
  "--trials",
  "--task",
  "--provider",
  "--model",
  "--check",
];

function parseEvalCompareArgs(
  args: readonly string[],
): ParseResult<EvalCompareCliArgs> {
  let baseFile: string | undefined;
  let headFile: string | undefined;
  const basePrefix = "--base=";
  const headPrefix = "--head=";

  let skipNext = false;
  for (const [index, arg] of args.entries()) {
    if (skipNext) {
      skipNext = false;
      continue;
    }

    if (arg === "--base") {
      const parsed = requireSeparatedOptionValue(
        "--base",
        args[index + 1],
        EVAL_COMPARE_OPTIONS,
      );
      if (!parsed.ok) return parsed;
      baseFile = parsed.value;
      skipNext = true;
      continue;
    }
    if (arg.startsWith(basePrefix)) {
      const parsed = requireOptionValue("--base", arg.slice(basePrefix.length));
      if (!parsed.ok) return parsed;
      baseFile = parsed.value;
      continue;
    }
    if (arg === "--head") {
      const parsed = requireSeparatedOptionValue(
        "--head",
        args[index + 1],
        EVAL_COMPARE_OPTIONS,
      );
      if (!parsed.ok) return parsed;
      headFile = parsed.value;
      skipNext = true;
      continue;
    }
    if (arg.startsWith(headPrefix)) {
      const parsed = requireOptionValue("--head", arg.slice(headPrefix.length));
      if (!parsed.ok) return parsed;
      headFile = parsed.value;
      continue;
    }

    return parseError(`Error: unknown eval compare option "${arg}"`);
  }

  if (baseFile === undefined) {
    return parseError("Error: eval compare requires --base <file>.");
  }
  if (headFile === undefined) {
    return parseError("Error: eval compare requires --head <file>.");
  }

  return parseOk({
    command: "eval",
    mode: "compare",
    baseFile,
    headFile,
  });
}

export function parseEvalArgs(
  args: readonly string[],
): ParseResult<EvalCliArgs> {
  if (args[0] === "compare") {
    return parseEvalCompareArgs(args.slice(1));
  }

  let suiteDir = join("evals", "tasks");
  let outFile = "eval-results.jsonl";
  let transcriptDir: string | undefined;
  let trials = 1;
  let taskId: string | undefined;
  let providerId: EvalRunCliArgs["providerId"] | undefined;
  let model: string | undefined;
  let check = false;
  const suitePrefix = "--suite=";
  const outPrefix = "--out=";
  const providerPrefix = "--provider=";
  const modelPrefix = "--model=";
  const transcriptDirPrefix = "--transcript-dir=";
  const trialsPrefix = "--trials=";
  const taskPrefix = "--task=";

  let skipNext = false;
  for (const [index, arg] of args.entries()) {
    if (skipNext) {
      skipNext = false;
      continue;
    }

    if (arg === "--suite") {
      const parsed = requireSeparatedOptionValue(
        "--suite",
        args[index + 1],
        EVAL_RUN_OPTIONS,
      );
      if (!parsed.ok) return parsed;
      suiteDir = parsed.value;
      skipNext = true;
      continue;
    }
    if (arg.startsWith(suitePrefix)) {
      const parsed = requireOptionValue(
        "--suite",
        arg.slice(suitePrefix.length),
      );
      if (!parsed.ok) return parsed;
      suiteDir = parsed.value;
      continue;
    }
    if (arg === "--out") {
      const parsed = requireSeparatedOptionValue(
        "--out",
        args[index + 1],
        EVAL_RUN_OPTIONS,
      );
      if (!parsed.ok) return parsed;
      outFile = parsed.value;
      skipNext = true;
      continue;
    }
    if (arg.startsWith(outPrefix)) {
      const parsed = requireOptionValue("--out", arg.slice(outPrefix.length));
      if (!parsed.ok) return parsed;
      outFile = parsed.value;
      continue;
    }
    if (arg === "--transcript-dir") {
      const parsed = requireSeparatedOptionValue(
        "--transcript-dir",
        args[index + 1],
        EVAL_RUN_OPTIONS,
      );
      if (!parsed.ok) return parsed;
      transcriptDir = parsed.value;
      skipNext = true;
      continue;
    }
    if (arg.startsWith(transcriptDirPrefix)) {
      const parsed = requireOptionValue(
        "--transcript-dir",
        arg.slice(transcriptDirPrefix.length),
      );
      if (!parsed.ok) return parsed;
      transcriptDir = parsed.value;
      continue;
    }
    if (arg === "--trials") {
      const parsedValue = requireSeparatedOptionValue(
        "--trials",
        args[index + 1],
        EVAL_RUN_OPTIONS,
      );
      if (!parsedValue.ok) return parsedValue;
      const parsedTrials = parseTrials(parsedValue.value);
      if (!parsedTrials.ok) return parsedTrials;
      trials = parsedTrials.value;
      skipNext = true;
      continue;
    }
    if (arg.startsWith(trialsPrefix)) {
      const parsed = parseTrials(arg.slice(trialsPrefix.length));
      if (!parsed.ok) return parsed;
      trials = parsed.value;
      continue;
    }
    if (arg === "--task") {
      const parsed = requireSeparatedOptionValue(
        "--task",
        args[index + 1],
        EVAL_RUN_OPTIONS,
      );
      if (!parsed.ok) return parsed;
      taskId = parsed.value;
      skipNext = true;
      continue;
    }
    if (arg.startsWith(taskPrefix)) {
      const parsed = requireOptionValue("--task", arg.slice(taskPrefix.length));
      if (!parsed.ok) return parsed;
      taskId = parsed.value;
      continue;
    }
    if (arg === "--provider") {
      const parsedValue = requireSeparatedOptionValue(
        "--provider",
        args[index + 1],
        EVAL_RUN_OPTIONS,
      );
      if (!parsedValue.ok) return parsedValue;
      const parsedProvider = parseProviderId(parsedValue.value);
      if (!parsedProvider.ok) return parsedProvider;
      providerId = parsedProvider.value;
      skipNext = true;
      continue;
    }
    if (arg.startsWith(providerPrefix)) {
      const parsed = parseProviderId(arg.slice(providerPrefix.length));
      if (!parsed.ok) return parsed;
      providerId = parsed.value;
      continue;
    }
    if (arg === "--model") {
      const parsed = requireSeparatedOptionValue(
        "--model",
        args[index + 1],
        EVAL_RUN_OPTIONS,
      );
      if (!parsed.ok) return parsed;
      model = parsed.value;
      skipNext = true;
      continue;
    }
    if (arg.startsWith(modelPrefix)) {
      const parsed = parseModel(arg.slice(modelPrefix.length));
      if (!parsed.ok) return parsed;
      model = parsed.value;
      continue;
    }
    if (arg === "--check") {
      check = true;
      continue;
    }

    return parseError(`Error: unknown eval option "${arg}"`);
  }

  return parseOk({
    command: "eval",
    mode: "run",
    suiteDir,
    outFile,
    ...(transcriptDir !== undefined ? { transcriptDir } : {}),
    trials,
    ...(taskId !== undefined ? { taskId } : {}),
    ...(providerId !== undefined ? { providerId } : {}),
    ...(model !== undefined ? { model } : {}),
    check,
  });
}
