import { join } from "node:path";
import {
  type ParseResult,
  parseError,
  parseModel,
  parseOk,
  parseProviderId,
  parseTrials,
  requireOptionValue,
} from "./shared.ts";
import type {
  EvalCliArgs,
  EvalCompareCliArgs,
  EvalRunCliArgs,
} from "./types.ts";

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
      const parsed = requireOptionValue("--base", args[index + 1]);
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
      const parsed = requireOptionValue("--head", args[index + 1]);
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
  const providerPrefix = "--provider=";
  const modelPrefix = "--model=";
  const transcriptDirPrefix = "--transcript-dir=";

  let skipNext = false;
  for (const [index, arg] of args.entries()) {
    if (skipNext) {
      skipNext = false;
      continue;
    }

    if (arg === "--suite") {
      const parsed = requireOptionValue("--suite", args[index + 1]);
      if (!parsed.ok) return parsed;
      suiteDir = parsed.value;
      skipNext = true;
      continue;
    }
    if (arg === "--out") {
      const parsed = requireOptionValue("--out", args[index + 1]);
      if (!parsed.ok) return parsed;
      outFile = parsed.value;
      skipNext = true;
      continue;
    }
    if (arg === "--transcript-dir") {
      const parsed = requireOptionValue("--transcript-dir", args[index + 1]);
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
      const parsed = parseTrials(args[index + 1]);
      if (!parsed.ok) return parsed;
      trials = parsed.value;
      skipNext = true;
      continue;
    }
    if (arg === "--task") {
      const parsed = requireOptionValue("--task", args[index + 1]);
      if (!parsed.ok) return parsed;
      taskId = parsed.value;
      skipNext = true;
      continue;
    }
    if (arg === "--provider") {
      const parsed = parseProviderId(args[index + 1]);
      if (!parsed.ok) return parsed;
      providerId = parsed.value;
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
      const parsed = parseModel(args[index + 1]);
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
