import { join } from "node:path";
import { z } from "zod";
import type { ProviderId } from "../core/provider-id.ts";
import {
  type BashMode,
  type BashPolicy,
  bashModeFromPolicy,
} from "../permissions/bash.ts";

interface EvalRunCliArgs {
  readonly command: "eval";
  readonly mode: "run";
  readonly suiteDir: string;
  readonly outFile: string;
  readonly transcriptDir?: string;
  readonly trials: number;
  readonly taskId?: string;
  readonly providerId?: ProviderId;
  readonly model?: string;
  readonly check: boolean;
}

interface EvalCompareCliArgs {
  readonly command: "eval";
  readonly mode: "compare";
  readonly baseFile: string;
  readonly headFile: string;
}

type EvalCliArgs = EvalRunCliArgs | EvalCompareCliArgs;

interface DoctorCliArgs {
  readonly command: "doctor";
  readonly offline: boolean;
  readonly providerId?: ProviderId;
  readonly model?: string;
}

export type CliArgs =
  | DoctorCliArgs
  | { readonly command: "undo" }
  | { readonly command: "sessions" }
  | EvalCliArgs
  | {
      readonly command: "run";
      readonly bashMode: BashMode;
      readonly userMessage?: string;
      readonly maxCostUsd?: number;
      readonly reportFile?: string;
      readonly transcriptFile?: string;
      readonly sessionId?: string;
      readonly resumeSessionId?: string;
      readonly forkSessionId?: string;
      readonly forkBeforeUser?: number;
      readonly forkPoints?: boolean;
      readonly providerId?: ProviderId;
      readonly model?: string;
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
  "Usage: keel [--provider <fake|deepseek|kimi|qwen>] [--model <id>] [--allow-bash] [--bash-policy <ask|deny|trusted>] [--max-cost <usd>] [--report <file>] [--transcript <file>] <message>",
  "       keel [--provider <fake|deepseek|kimi|qwen>] [--model <id>] [--allow-bash] [--bash-policy <ask|deny|trusted>] [--max-cost <usd>] [--report <file>] [--session <id> | --resume <id> [--fork-points | --fork <new-id> [--fork-before-user <n>]]]",
  "       keel --doctor [--offline] [--provider <fake|deepseek|kimi|qwen>] [--model <id>]",
  "       keel sessions",
  "       keel eval [--provider <fake|deepseek|kimi|qwen>] [--model <id>] [--suite <dir>] [--task <id>] [--trials <n>] [--out <file>] [--transcript-dir <dir>] [--check]",
  "       keel eval compare --base <old.jsonl> --head <new.jsonl>",
  "       keel /undo",
  "",
  "--allow-bash enables trusted shell commands. Shell commands run with the current OS user's permissions and may read or modify gitignored files.",
  "--bash-policy controls shell command approval: ask requires a real TTY approval prompt, deny disables bash, trusted runs commands without per-command approval. Do not combine it with --allow-bash; use --bash-policy trusted instead.",
  "--report writes a machine-readable JSON run report (turns, stop reason, token usage, cost) to the given file.",
  "--transcript writes provider-visible run messages as schema-versioned JSONL.",
  "--fork-points lists restored user message numbers for --fork-before-user; it requires --resume.",
  "--fork-before-user cuts a fork before the 1-based restored user message number; it requires --resume and --fork.",
  "--transcript-dir writes one provider-visible transcript JSONL file per eval trial.",
  "--provider and --model override provider env for the current run.",
  "Provider env: KEEL_PROVIDER=deepseek|kimi|qwen, DEEPSEEK_API_KEY, KIMI_API_KEY, DASHSCOPE_API_KEY or QWEN_API_KEY, optional *_BASE_URL, DEEPSEEK_MODEL, KIMI_MODEL, QWEN_MODEL, and KEEL_CONTEXT_WINDOW_TOKENS.",
  "Context compaction uses an estimated 256000-token default window for real providers; set KEEL_CONTEXT_WINDOW_TOKENS for a model-specific window.",
  "Qwen default endpoint is https://dashscope-intl.aliyuncs.com/compatible-mode/v1; set QWEN_BASE_URL if your key belongs to China region or a workspace-scoped DashScope endpoint.",
].join("\n");

const maxCostSchema = z.coerce.number().finite().positive();
const bashPolicySchema = z.enum(["ask", "deny", "trusted"]);
const providerIdSchema = z.enum(["fake", "deepseek", "kimi", "qwen"]);
const trialsSchema = z.coerce.number().int().positive();
const forkBeforeUserSchema = z.coerce.number().int().positive();

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

function parseProviderId(raw: string | undefined): ParseResult<ProviderId> {
  const parsedValue = requireOptionValue("--provider", raw);
  if (!parsedValue.ok) return parsedValue;
  const result = providerIdSchema.safeParse(parsedValue.value);
  if (!result.success) {
    return parseError(
      "Error: --provider must be one of: fake, deepseek, kimi, qwen.",
    );
  }
  return parseOk(result.data);
}

function parseModel(raw: string | undefined): ParseResult<string> {
  return requireOptionValue("--model", raw);
}

function parseTrials(raw: string | undefined): ParseResult<number> {
  const result = trialsSchema.safeParse(raw);
  if (!result.success) {
    return parseError("Error: --trials must be a positive integer.");
  }
  return parseOk(result.data);
}

function parseForkBeforeUser(raw: string | undefined): ParseResult<number> {
  const parsedValue = requireOptionValue("--fork-before-user", raw);
  if (!parsedValue.ok) return parsedValue;
  const result = forkBeforeUserSchema.safeParse(parsedValue.value);
  if (!result.success) {
    return parseError("Error: --fork-before-user must be a positive integer.");
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

function parseEvalArgs(args: readonly string[]): ParseResult<EvalCliArgs> {
  if (args[0] === "compare") {
    return parseEvalCompareArgs(args.slice(1));
  }

  let suiteDir = join("evals", "tasks");
  let outFile = "eval-results.jsonl";
  let transcriptDir: string | undefined;
  let trials = 1;
  let taskId: string | undefined;
  let providerId: ProviderId | undefined;
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

function parseDoctorArgs(args: readonly string[]): ParseResult<DoctorCliArgs> {
  let providerId: ProviderId | undefined;
  let model: string | undefined;
  const providerPrefix = "--provider=";
  const modelPrefix = "--model=";
  let offline = false;

  let skipNext = false;
  for (const [index, arg] of args.entries()) {
    if (skipNext) {
      skipNext = false;
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

    if (arg === "--offline") {
      offline = true;
      continue;
    }

    return parseError(`Error: unknown doctor option "${arg}"`);
  }

  return parseOk({
    command: "doctor",
    offline,
    ...(providerId !== undefined ? { providerId } : {}),
    ...(model !== undefined ? { model } : {}),
  });
}

export function parseCliArgs(args: readonly string[]): ParseResult<CliArgs> {
  if (args[0] === "--doctor") {
    return parseDoctorArgs(args.slice(1));
  }

  if (args[0] === "/undo") {
    return parseOk({ command: "undo" });
  }

  if (args[0] === "sessions") {
    const extraArg = args[1];
    if (extraArg !== undefined) {
      return parseError(`Error: unknown sessions option "${extraArg}"`);
    }
    return parseOk({ command: "sessions" });
  }

  if (args[0] === "eval") {
    return parseEvalArgs(args.slice(1));
  }

  let bashMode: BashMode = "disabled";
  let allowBashOptionSeen = false;
  let bashPolicyOptionSeen = false;
  let maxCostUsd: number | undefined;
  let reportFile: string | undefined;
  let transcriptFile: string | undefined;
  let sessionId: string | undefined;
  let resumeSessionId: string | undefined;
  let forkSessionId: string | undefined;
  let forkBeforeUser: number | undefined;
  let forkPoints = false;
  let providerId: ProviderId | undefined;
  let model: string | undefined;
  let userMessage: string | undefined;
  const maxCostPrefix = "--max-cost=";
  const reportPrefix = "--report=";
  const transcriptPrefix = "--transcript=";
  const bashPolicyPrefix = "--bash-policy=";
  const sessionPrefix = "--session=";
  const resumePrefix = "--resume=";
  const forkPrefix = "--fork=";
  const forkBeforeUserPrefix = "--fork-before-user=";
  const providerPrefix = "--provider=";
  const modelPrefix = "--model=";

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

    if (arg === "--transcript") {
      const parsed = requireOptionValue("--transcript", args[index + 1]);
      if (!parsed.ok) return parsed;
      transcriptFile = parsed.value;
      skipNext = true;
      continue;
    }

    if (arg.startsWith(transcriptPrefix)) {
      const parsed = requireOptionValue(
        "--transcript",
        arg.slice(transcriptPrefix.length),
      );
      if (!parsed.ok) return parsed;
      transcriptFile = parsed.value;
      continue;
    }

    if (arg === "--session") {
      const parsed = requireOptionValue("--session", args[index + 1]);
      if (!parsed.ok) return parsed;
      sessionId = parsed.value;
      skipNext = true;
      continue;
    }

    if (arg.startsWith(sessionPrefix)) {
      const parsed = requireOptionValue(
        "--session",
        arg.slice(sessionPrefix.length),
      );
      if (!parsed.ok) return parsed;
      sessionId = parsed.value;
      continue;
    }

    if (arg === "--resume") {
      const parsed = requireOptionValue("--resume", args[index + 1]);
      if (!parsed.ok) return parsed;
      resumeSessionId = parsed.value;
      skipNext = true;
      continue;
    }

    if (arg.startsWith(resumePrefix)) {
      const parsed = requireOptionValue(
        "--resume",
        arg.slice(resumePrefix.length),
      );
      if (!parsed.ok) return parsed;
      resumeSessionId = parsed.value;
      continue;
    }

    if (arg === "--fork") {
      const parsed = requireOptionValue("--fork", args[index + 1]);
      if (!parsed.ok) return parsed;
      forkSessionId = parsed.value;
      skipNext = true;
      continue;
    }

    if (arg.startsWith(forkPrefix)) {
      const parsed = requireOptionValue("--fork", arg.slice(forkPrefix.length));
      if (!parsed.ok) return parsed;
      forkSessionId = parsed.value;
      continue;
    }

    if (arg === "--fork-before-user") {
      const parsed = parseForkBeforeUser(args[index + 1]);
      if (!parsed.ok) return parsed;
      forkBeforeUser = parsed.value;
      skipNext = true;
      continue;
    }

    if (arg.startsWith(forkBeforeUserPrefix)) {
      const parsed = parseForkBeforeUser(
        arg.slice(forkBeforeUserPrefix.length),
      );
      if (!parsed.ok) return parsed;
      forkBeforeUser = parsed.value;
      continue;
    }

    if (arg === "--fork-points") {
      forkPoints = true;
      continue;
    }

    userMessage = args.slice(index).join(" ");
    break;
  }

  if (sessionId !== undefined && resumeSessionId !== undefined) {
    return parseError("Error: --session cannot be combined with --resume.");
  }
  if (forkPoints && resumeSessionId === undefined) {
    return parseError("Error: --fork-points requires --resume <id>.");
  }
  if (forkPoints && forkSessionId !== undefined) {
    return parseError("Error: --fork-points cannot be combined with --fork.");
  }
  if (forkPoints && forkBeforeUser !== undefined) {
    return parseError(
      "Error: --fork-points cannot be combined with --fork-before-user.",
    );
  }
  if (forkPoints && userMessage !== undefined) {
    return parseError(
      "Error: --fork-points cannot be combined with a message.",
    );
  }
  if (forkPoints && transcriptFile !== undefined) {
    return parseError(
      "Error: --fork-points cannot be combined with --transcript.",
    );
  }
  if (
    forkBeforeUser !== undefined &&
    (resumeSessionId === undefined || forkSessionId === undefined)
  ) {
    return parseError(
      "Error: --fork-before-user requires --resume <id> --fork <new-id>.",
    );
  }
  if (forkSessionId !== undefined && resumeSessionId === undefined) {
    return parseError("Error: --fork requires --resume <id>.");
  }

  return parseOk({
    command: "run",
    bashMode,
    ...(userMessage !== undefined ? { userMessage } : {}),
    ...(maxCostUsd !== undefined ? { maxCostUsd } : {}),
    ...(reportFile !== undefined ? { reportFile } : {}),
    ...(transcriptFile !== undefined ? { transcriptFile } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(resumeSessionId !== undefined ? { resumeSessionId } : {}),
    ...(forkSessionId !== undefined ? { forkSessionId } : {}),
    ...(forkBeforeUser !== undefined ? { forkBeforeUser } : {}),
    ...(forkPoints ? { forkPoints } : {}),
    ...(providerId !== undefined ? { providerId } : {}),
    ...(model !== undefined ? { model } : {}),
  });
}
