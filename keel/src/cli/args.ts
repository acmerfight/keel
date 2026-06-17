import { join } from "node:path";
import { z } from "zod";
import {
  type BashMode,
  type BashPolicy,
  bashModeFromPolicy,
} from "../permissions/bash.ts";

interface EvalCliArgs {
  readonly command: "eval";
  readonly suiteDir: string;
  readonly outFile: string;
  readonly trials: number;
  readonly taskId?: string;
  readonly check: boolean;
}

export type CliArgs =
  | { readonly command: "doctor" }
  | { readonly command: "undo" }
  | EvalCliArgs
  | {
      readonly command: "run";
      readonly bashMode: BashMode;
      readonly userMessage?: string;
      readonly maxCostUsd?: number;
      readonly reportFile?: string;
    };

type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly message: string };

function parseOk<T>(value: T): ParseResult<T> {
  return { ok: true, value };
}

function parseError(message: string): ParseResult<never> {
  return { ok: false, message };
}

export const USAGE = [
  "Usage: keel [--allow-bash] [--bash-policy <ask|deny|trusted>] [--max-cost <usd>] [--report <file>] <message>",
  "       keel eval [--suite <dir>] [--task <id>] [--trials <n>] [--out <file>] [--check]",
  "       keel /undo",
  "",
  "--allow-bash enables trusted shell commands. Shell commands run with the current OS user's permissions and may read or modify gitignored files.",
  "--bash-policy controls shell command approval: ask requires a real TTY approval prompt, deny disables bash, trusted runs commands without per-command approval. Do not combine it with --allow-bash; use --bash-policy trusted instead.",
  "--report writes a machine-readable JSON run report (turns, stop reason, token usage, cost) to the given file.",
  "Provider env: KEEL_PROVIDER=deepseek|kimi|qwen, DEEPSEEK_API_KEY, KIMI_API_KEY, DASHSCOPE_API_KEY, optional *_BASE_URL, *_MODEL, and KEEL_CONTEXT_WINDOW_TOKENS.",
  "Context compaction uses an estimated 256000-token default window for real providers; set KEEL_CONTEXT_WINDOW_TOKENS for a model-specific window.",
  "Qwen default endpoint is https://dashscope-intl.aliyuncs.com/compatible-mode/v1; set QWEN_BASE_URL if your key belongs to China region or a workspace-scoped DashScope endpoint.",
].join("\n");

const maxCostSchema = z.coerce.number().finite().positive();
const bashPolicySchema = z.enum(["ask", "deny", "trusted"]);
const trialsSchema = z.coerce.number().int().positive();

function parseMaxCost(raw: string | undefined): ParseResult<number> {
  const result = maxCostSchema.safeParse(raw);
  if (!result.success) {
    return parseError("Error: --max-cost must be a positive number.");
  }
  return parseOk(result.data);
}

function parseReportFile(raw: string | undefined): ParseResult<string> {
  if (raw === undefined || raw === "") {
    return parseError("Error: --report requires a file path.");
  }
  return parseOk(raw);
}

function parseBashPolicy(raw: string | undefined): ParseResult<BashPolicy> {
  const result = bashPolicySchema.safeParse(raw);
  if (!result.success) {
    return parseError(
      "Error: --bash-policy must be one of: ask, deny, trusted.",
    );
  }
  return parseOk(result.data);
}

function parseTrials(raw: string | undefined): ParseResult<number> {
  const result = trialsSchema.safeParse(raw);
  if (!result.success) {
    return parseError("Error: --trials must be a positive integer.");
  }
  return parseOk(result.data);
}

function requireOptionValue(
  option: string,
  raw: string | undefined,
): ParseResult<string> {
  if (raw === undefined || raw === "") {
    return parseError(`Error: ${option} requires a value.`);
  }
  return parseOk(raw);
}

function parseEvalArgs(args: readonly string[]): ParseResult<EvalCliArgs> {
  let suiteDir = join("evals", "tasks");
  let outFile = "eval-results.jsonl";
  let trials = 1;
  let taskId: string | undefined;
  let check = false;

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
    if (arg === "--check") {
      check = true;
      continue;
    }

    return parseError(`Error: unknown eval option "${arg}"`);
  }

  return parseOk({
    command: "eval",
    suiteDir,
    outFile,
    trials,
    ...(taskId !== undefined ? { taskId } : {}),
    check,
  });
}

export function parseCliArgs(args: readonly string[]): ParseResult<CliArgs> {
  if (args[0] === "--doctor") {
    return parseOk({ command: "doctor" });
  }

  if (args[0] === "/undo") {
    return parseOk({ command: "undo" });
  }

  if (args[0] === "eval") {
    return parseEvalArgs(args.slice(1));
  }

  let bashMode: BashMode = "disabled";
  let allowBashOptionSeen = false;
  let bashPolicyOptionSeen = false;
  let maxCostUsd: number | undefined;
  let reportFile: string | undefined;
  let userMessage: string | undefined;
  const maxCostPrefix = "--max-cost=";
  const reportPrefix = "--report=";
  const bashPolicyPrefix = "--bash-policy=";

  let skipNext = false;
  for (const [index, arg] of args.entries()) {
    if (skipNext) {
      skipNext = false;
      continue;
    }

    if (arg === "--allow-bash") {
      if (bashPolicyOptionSeen) {
        return parseError(
          "Error: --allow-bash cannot be combined with --bash-policy; use --bash-policy trusted instead.",
        );
      }
      allowBashOptionSeen = true;
      bashMode = "trusted";
      continue;
    }

    if (arg === "--bash-policy") {
      if (allowBashOptionSeen) {
        return parseError(
          "Error: --allow-bash cannot be combined with --bash-policy; use --bash-policy trusted instead.",
        );
      }
      const parsed = parseBashPolicy(args[index + 1]);
      if (!parsed.ok) return parsed;
      bashPolicyOptionSeen = true;
      bashMode = bashModeFromPolicy(parsed.value);
      skipNext = true;
      continue;
    }

    if (arg.startsWith(bashPolicyPrefix)) {
      if (allowBashOptionSeen) {
        return parseError(
          "Error: --allow-bash cannot be combined with --bash-policy; use --bash-policy trusted instead.",
        );
      }
      const parsed = parseBashPolicy(arg.slice(bashPolicyPrefix.length));
      if (!parsed.ok) return parsed;
      bashPolicyOptionSeen = true;
      bashMode = bashModeFromPolicy(parsed.value);
      continue;
    }

    if (arg === "--max-cost") {
      const parsed = parseMaxCost(args[index + 1]);
      if (!parsed.ok) return parsed;
      maxCostUsd = parsed.value;
      skipNext = true;
      continue;
    }

    if (arg.startsWith(maxCostPrefix)) {
      const parsed = parseMaxCost(arg.slice(maxCostPrefix.length));
      if (!parsed.ok) return parsed;
      maxCostUsd = parsed.value;
      continue;
    }

    if (arg === "--report") {
      const parsed = parseReportFile(args[index + 1]);
      if (!parsed.ok) return parsed;
      reportFile = parsed.value;
      skipNext = true;
      continue;
    }

    if (arg.startsWith(reportPrefix)) {
      const parsed = parseReportFile(arg.slice(reportPrefix.length));
      if (!parsed.ok) return parsed;
      reportFile = parsed.value;
      continue;
    }

    userMessage = args.slice(index).join(" ");
    break;
  }

  return parseOk({
    command: "run",
    bashMode,
    ...(userMessage !== undefined ? { userMessage } : {}),
    ...(maxCostUsd !== undefined ? { maxCostUsd } : {}),
    ...(reportFile !== undefined ? { reportFile } : {}),
  });
}
