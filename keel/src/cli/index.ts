#!/usr/bin/env node

import { realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import type { AgentEvent, CostReport } from "../agent/loop.ts";
import { runAgent } from "../agent/loop.ts";
import { buildAgentSystemPrompt } from "../agent/prompt.ts";
import type { CostModel } from "../core/cost.ts";
import {
  createDeepseekProvider,
  DEEPSEEK_V4_FLASH_COST_MODEL,
} from "../llm/providers/deepseek.ts";
import {
  createKimiProvider,
  KIMI_K2_6_COST_MODEL,
} from "../llm/providers/kimi.ts";
import { createQwenProvider, qwenCostModel } from "../llm/providers/qwen.ts";
import type { LLMProvider, ToolCall } from "../llm/types.ts";
import type { BashPermissionPolicy, BashPolicy } from "../permissions/bash.ts";
import { createFakeProvider, fakeResponse } from "../testing/fake-provider.ts";
import {
  type InteractiveResolvedProvider,
  runInteractiveSession,
} from "./interactive-session.ts";

interface CliEditRequest {
  readonly path: string;
  readonly oldString: string;
  readonly newString: string;
}

interface CliWriteRequest {
  readonly path: string;
  readonly content: string;
}

interface EvalCliArgs {
  readonly command: "eval";
  readonly suiteDir: string;
  readonly outFile: string;
  readonly trials: number;
  readonly taskId?: string;
  readonly check: boolean;
}

type CliArgs =
  | { readonly command: "doctor" }
  | { readonly command: "undo" }
  | EvalCliArgs
  | {
      readonly command: "run";
      readonly allowBash: boolean;
      readonly bashPolicy: BashPolicy;
      readonly userMessage?: string;
      readonly maxCostUsd?: number;
      readonly reportFile?: string;
    };

interface CliInput extends NodeJS.ReadableStream {
  readonly isTTY?: boolean;
}

export interface CliRuntime {
  readonly args: readonly string[];
  readonly cliEntry: string;
  readonly cwd: () => string;
  readonly env: (key: string) => string | undefined;
  readonly input: CliInput;
  readonly platform: NodeJS.Platform;
  readonly now: () => number;
  readonly writeStdout: (text: string) => void;
  readonly writeStderr: (text: string) => void;
  readonly onSigint: (handler: () => void) => void;
  readonly offSigint: (handler: () => void) => void;
  readonly forceExit: (code: number) => never;
}

class CliInputError extends Error {}

function cliInputError(message: string): never {
  throw new CliInputError(message);
}

type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly message: string };

function parseOk<T>(value: T): ParseResult<T> {
  return { ok: true, value };
}

function parseError(message: string): ParseResult<never> {
  return { ok: false, message };
}

const USAGE = [
  "Usage: keel [--allow-bash] [--bash-policy <ask|deny|trusted>] [--max-cost <usd>] [--report <file>] <message>",
  "       keel eval [--suite <dir>] [--task <id>] [--trials <n>] [--out <file>] [--check]",
  "       keel /undo",
  "",
  "--allow-bash enables trusted shell commands. Shell commands run with the current OS user's permissions and may read or modify gitignored files.",
  "--bash-policy controls shell command approval: ask requires interactive approval, deny disables bash, trusted runs commands without per-command approval. Do not combine it with --allow-bash; use --bash-policy trusted instead.",
  "--report writes a machine-readable JSON run report (turns, stop reason, token usage, cost) to the given file.",
  "Provider env: KEEL_PROVIDER=deepseek|kimi|qwen, DEEPSEEK_API_KEY, KIMI_API_KEY, DASHSCOPE_API_KEY, optional *_BASE_URL and *_MODEL.",
  "Qwen default endpoint is https://dashscope-intl.aliyuncs.com/compatible-mode/v1; set QWEN_BASE_URL if your key belongs to China region or a workspace-scoped DashScope endpoint.",
].join("\n");

const maxCostSchema = z.coerce.number().finite().positive();
const bashPolicySchema = z.enum(["ask", "deny", "trusted"]);

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

const trialsSchema = z.coerce.number().int().positive();

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

function parseCliArgs(args: readonly string[]): ParseResult<CliArgs> {
  if (args[0] === "--doctor") {
    return parseOk({ command: "doctor" });
  }

  if (args[0] === "/undo") {
    return parseOk({ command: "undo" });
  }

  if (args[0] === "eval") {
    return parseEvalArgs(args.slice(1));
  }

  let allowBash = false;
  let bashPolicy: BashPolicy = "deny";
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
      allowBash = true;
      bashPolicy = "trusted";
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
      bashPolicy = parsed.value;
      allowBash = parsed.value !== "deny";
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
      bashPolicy = parsed.value;
      allowBash = parsed.value !== "deny";
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

    userMessage = arg;
    break;
  }

  return parseOk({
    command: "run",
    allowBash,
    bashPolicy,
    ...(userMessage !== undefined ? { userMessage } : {}),
    ...(maxCostUsd !== undefined ? { maxCostUsd } : {}),
    ...(reportFile !== undefined ? { reportFile } : {}),
  });
}

function formatUsd(value: number): string {
  return value < 0.0001 ? value.toFixed(6) : value.toFixed(4);
}

const TOOL_LABEL_MAX_LENGTH = 160;

// Shared escape style for model-controlled bytes: control characters become
// visible \xNN (or \n-style) escapes so the terminal never interprets them.
function escapeControlChar(char: string): string {
  switch (char) {
    case "\n":
      return "\\n";
    case "\r":
      return "\\r";
    case "\t":
      return "\\t";
    default:
      return `\\x${char.charCodeAt(0).toString(16).padStart(2, "0")}`;
  }
}

// Assistant text is model-controlled. Newlines and tabs are legitimate prose
// formatting, but every other C0/C1 control character (ESC, BEL, raw CSI/OSC
// bytes) could drive the terminal: clear the screen, move the cursor over
// earlier output, retitle the window, or write the clipboard via OSC 52.
// Escaping per code unit keeps streamed chunks safe — no sequence can
// straddle a chunk boundary once ESC and C1 bytes are neutralized.
function sanitizeAssistantText(text: string): string {
  return text.replace(
    // biome-ignore lint/suspicious/noControlCharactersInRegex: escaping control characters is the point
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g,
    escapeControlChar,
  );
}

// Labels are paths/patterns/commands, not prose, so beyond C0/C1 controls we
// also escape bidi controls and invisible directional marks (visual
// reordering, Trojan Source class; UAX #9 marks ALM/LRM/RLM included) and
// zero-width characters (invisible path segments). The length cap keeps one
// tool call to exactly one readable stderr line.
function sanitizeToolLabel(label: string): string {
  const escaped = label.replace(
    // biome-ignore lint/suspicious/noControlCharactersInRegex: escaping control characters is the point
    /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2060\u202a-\u202e\u2066-\u2069\ufeff]/g,
    (char) => {
      const code = char.charCodeAt(0);
      return code <= 0x9f
        ? escapeControlChar(char)
        : `\\u{${code.toString(16)}}`;
    },
  );
  return escaped.length <= TOOL_LABEL_MAX_LENGTH
    ? escaped
    : `${escaped.slice(0, TOOL_LABEL_MAX_LENGTH)}...`;
}

function toolCallLabel(toolCall: ToolCall): string {
  switch (toolCall.tool) {
    case "read":
      return sanitizeToolLabel(`read ${toolCall.path}`);
    case "grep":
      return sanitizeToolLabel(
        toolCall.path === undefined
          ? `grep ${toolCall.pattern}`
          : `grep ${toolCall.pattern} ${toolCall.path}`,
      );
    case "edit":
      return sanitizeToolLabel(`edit ${toolCall.path}`);
    case "write":
      return sanitizeToolLabel(`write ${toolCall.path}`);
    case "bash":
      return sanitizeToolLabel(`bash ${toolCall.command}`);
  }
}

const providerRetryReasonLabels: Readonly<Record<string, string>> = {
  provider_rate_limited: "rate limited",
  provider_server_error: "server error",
  provider_network_error: "network error",
  provider_http_error: "HTTP error",
};

function providerRetryReasonLabel(reason: string): string {
  return providerRetryReasonLabels[reason] ?? "provider error";
}

// The report schema is consumed by external tooling (the eval runner and any
// script comparing runs across keel versions). Bump schemaVersion on any
// breaking change to the shape.
interface RunReportInput {
  readonly provider: string;
  readonly model: string;
  readonly end: EndEventWithCost;
  readonly durationMs: number;
}

interface RunReport {
  readonly schemaVersion: 1;
  readonly provider: string;
  readonly model: string;
  readonly turns: number;
  readonly stopReason: string;
  readonly usage: Extract<AgentEvent, { readonly type: "end" }>["usage"];
  readonly durationMs: number;
  readonly costUsd: number;
}

type EndEventWithCost = EndEvent & { readonly cost: CostReport };

function assertEndEventHasCost(end: EndEvent): asserts end is EndEventWithCost {
  /* v8 ignore next 3: --report enables cost tracking before the run starts. */
  if (end.cost === undefined) {
    throw new Error("run report requires cost tracking to be enabled");
  }
}

function writeRunReport(filePath: string, input: RunReportInput): void {
  const cost = input.end.cost;
  const report: RunReport = {
    schemaVersion: 1,
    provider: input.provider,
    model: input.model,
    turns: input.end.turns,
    stopReason: input.end.stopReason,
    usage: input.end.usage,
    durationMs: input.durationMs,
    costUsd: cost.spentUsd,
  };
  writeFileSync(filePath, `${JSON.stringify(report)}\n`, "utf8");
}

function formatCostReport(cost: CostReport, maxUsd: number): string {
  const spent = `$${formatUsd(cost.spentUsd)}`;
  const budget = `$${formatUsd(maxUsd)}`;
  return cost.budgetExceeded
    ? `Cost: ${spent} (budget ${budget} exceeded)\n`
    : `Cost: ${spent} (budget ${budget})\n`;
}

function parseCliEditDemo(message: string): CliEditRequest | null {
  const prefix = "replace ";
  const withToken = " with ";
  const inToken = " in ";

  if (!message.startsWith(prefix)) return null;

  const body = message.slice(prefix.length);
  const withIndex = body.indexOf(withToken);
  if (withIndex < 0) return null;

  const newStringStart = withIndex + withToken.length;
  const inIndex = body.indexOf(inToken, newStringStart);
  if (inIndex < 0) return null;

  const oldString = body.slice(0, withIndex);
  const newString = body.slice(newStringStart, inIndex);
  const path = body.slice(inIndex + inToken.length);

  if (oldString === "" || newString === "" || path === "") return null;

  return { path, oldString, newString };
}

function parseCliWriteDemo(message: string): CliWriteRequest | null {
  const prefix = "create ";
  if (!message.startsWith(prefix)) return null;

  const path = message.slice(prefix.length);
  if (path === "") return null;

  return { path, content: '{"created":true}\n' };
}

const ZERO_USAGE = {
  inputTokens: 0,
  cachedInputTokens: 0,
  uncachedInputTokens: 0,
  outputTokens: 0,
};

function createCliFakeProvider(userMessage: string): LLMProvider {
  const edit = parseCliEditDemo(userMessage);
  const write = parseCliWriteDemo(userMessage);
  if (edit === null) {
    if (write === null) {
      return createFakeProvider([fakeResponse("Hello from fake provider.")]);
    }

    let turn = 0;
    return {
      id: "fake",
      async *stream(options) {
        turn++;
        if (turn === 1) {
          yield {
            type: "tool_call",
            id: "fake_write",
            tool: "write",
            path: write.path,
            content: write.content,
          };
          yield { type: "stop", usage: ZERO_USAGE };
          return;
        }

        const toolContent = options.messages.findLast(
          (m) => m.role === "tool",
        )?.content;
        const reply = toolContent?.startsWith("Tool failed:")
          ? toolContent
          : `Created ${write.path}`;
        yield { type: "text", text: reply };
        yield { type: "stop", usage: ZERO_USAGE };
      },
    };
  }

  let turn = 0;
  return {
    id: "fake",
    async *stream(options) {
      turn++;
      if (turn === 1) {
        yield {
          type: "tool_call",
          id: "fake_edit",
          tool: "edit",
          path: edit.path,
          oldString: edit.oldString,
          newString: edit.newString,
        };
        yield { type: "stop", usage: ZERO_USAGE };
        return;
      }

      const toolContent = options.messages.findLast(
        (m) => m.role === "tool",
      )?.content;
      const reply = toolContent?.startsWith("Tool failed:")
        ? toolContent
        : `Edited ${edit.path}`;
      yield { type: "text", text: reply };
      yield { type: "stop", usage: ZERO_USAGE };
    },
  };
}

function createInteractiveFakeProvider(): LLMProvider {
  return {
    id: "fake",
    async *stream(options) {
      const userMessages = options.messages.filter(
        (message) => message.role === "user",
      );
      const latest = userMessages.at(-1)?.content ?? "";
      const previous = userMessages.at(-2)?.content;
      const text =
        previous !== undefined && latest.endsWith("remember?")
          ? `Earlier you said: ${previous}`
          : `Remembered: ${latest}`;
      yield { type: "text", text };
      yield { type: "stop", usage: ZERO_USAGE };
    },
  };
}

interface ResolvedProvider extends InteractiveResolvedProvider {
  readonly provider: LLMProvider;
  readonly model: string;
  readonly costModel: CostModel | null;
}

type EndEvent = Extract<AgentEvent, { readonly type: "end" }>;

const ZERO_COST_MODEL: CostModel = {
  uncachedInputPerMillionTokens: 0,
  cachedInputPerMillionTokens: 0,
  outputPerMillionTokens: 0,
};

function kimiCostModel(model: string): CostModel | null {
  if (model === "kimi-k2.6") return KIMI_K2_6_COST_MODEL;
  return null;
}

function resolveProvider(
  userMessage: string,
  runtime: CliRuntime,
): ResolvedProvider {
  const providerId = runtime.env("KEEL_PROVIDER") ?? "deepseek";

  if (providerId === "fake") {
    return {
      provider: createCliFakeProvider(userMessage),
      model: "fake",
      costModel: ZERO_COST_MODEL,
    };
  }

  if (providerId === "deepseek") {
    const apiKey = runtime.env("DEEPSEEK_API_KEY");
    if (!apiKey) {
      cliInputError(
        "Error: DEEPSEEK_API_KEY is required. Set the API key to use DeepSeek.",
      );
    }
    const model = "deepseek-v4-flash";
    return {
      provider: createDeepseekProvider({
        apiKey,
        baseUrl: runtime.env("DEEPSEEK_BASE_URL") ?? "https://api.deepseek.com",
        model,
      }),
      model,
      costModel: DEEPSEEK_V4_FLASH_COST_MODEL,
    };
  }

  if (providerId === "kimi") {
    const apiKey = runtime.env("KIMI_API_KEY");
    if (!apiKey) {
      cliInputError(
        "Error: KIMI_API_KEY is required. Set the API key to use Kimi.",
      );
    }
    const model = runtime.env("KIMI_MODEL") ?? "kimi-k2.6";
    return {
      provider: createKimiProvider({
        apiKey,
        baseUrl: runtime.env("KIMI_BASE_URL") ?? "https://api.moonshot.cn/v1",
        model,
      }),
      model,
      costModel: kimiCostModel(model),
    };
  }

  if (providerId === "qwen") {
    const apiKey =
      runtime.env("DASHSCOPE_API_KEY") ?? runtime.env("QWEN_API_KEY");
    if (!apiKey) {
      cliInputError(
        "Error: DASHSCOPE_API_KEY or QWEN_API_KEY is required. Qwen default endpoint is https://dashscope-intl.aliyuncs.com/compatible-mode/v1; set QWEN_BASE_URL if your key belongs to China region or a workspace-scoped DashScope endpoint.",
      );
    }
    const model = runtime.env("QWEN_MODEL") ?? "qwen3.7-plus";
    return {
      provider: createQwenProvider({
        apiKey,
        baseUrl:
          runtime.env("QWEN_BASE_URL") ??
          "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
        model,
      }),
      model,
      costModel: qwenCostModel(model),
    };
  }

  cliInputError(`Error: unknown provider "${providerId}"`);
}

function resolveInteractiveProvider(
  userMessage: string,
  runtime: CliRuntime,
): ResolvedProvider {
  const providerId = runtime.env("KEEL_PROVIDER") ?? "deepseek";
  if (providerId === "fake") {
    return {
      provider: createInteractiveFakeProvider(),
      model: "fake",
      costModel: ZERO_COST_MODEL,
    };
  }

  return resolveProvider(userMessage, runtime);
}

function requireKnownCostModel(resolved: ResolvedProvider): CostModel {
  if (resolved.costModel !== null) return resolved.costModel;

  if (resolved.provider.id === "kimi") {
    cliInputError(
      `Error: cost tracking is only supported for Kimi model "kimi-k2.6"; configured KIMI_MODEL="${resolved.model}".`,
    );
  }

  if (resolved.provider.id === "qwen") {
    cliInputError(
      `Error: cost tracking is not supported for Qwen model "${resolved.model}" because its official pricing is tiered by per-request input tokens.`,
    );
  }

  /* v8 ignore next 3: defensive guard for future providers with unknown pricing. */
  cliInputError(
    `Error: cost tracking is not supported for provider "${resolved.provider.id}" model "${resolved.model}".`,
  );
}

function oneShotBashPermissionPolicy(
  bashPolicy: BashPolicy,
): BashPermissionPolicy | undefined {
  if (bashPolicy === "ask") {
    return {
      review: () => ({
        type: "deny",
        message:
          "Shell command requires interactive approval; one-shot runs cannot approve bash commands.",
      }),
    };
  }
  if (bashPolicy === "deny") {
    return undefined;
  }
  return undefined;
}

async function printAgentEvents(
  stream: AsyncIterable<AgentEvent>,
  runtime: CliRuntime,
): Promise<EndEvent | undefined> {
  let finalEnd: EndEvent | undefined;
  for await (const event of stream) {
    if (event.type === "text") {
      runtime.writeStdout(sanitizeAssistantText(event.text));
    } else if (event.type === "provider_retry") {
      runtime.writeStderr(
        `Provider retry: ${sanitizeToolLabel(event.provider)} ${providerRetryReasonLabel(event.reason)} (attempt ${event.attempt}/${event.maxRetries} in ${Math.round(event.delayMs)}ms)\n`,
      );
    } else if (event.type === "tool_start") {
      runtime.writeStderr(`Tool: ${toolCallLabel(event.toolCall)}\n`);
    } else if (event.type === "tool_end") {
      // Status lives in the line prefix because the label is
      // model-controlled text and could end with a forged failure marker.
      if (!event.ok) {
        runtime.writeStderr(`Tool failed: ${toolCallLabel(event.toolCall)}\n`);
      }
    } else if (event.type === "end") {
      finalEnd = event;
    }
  }
  return finalEnd;
}

export async function runCliMain(runtime: CliRuntime): Promise<number> {
  let exitCode = 0;
  const parsedCliArgs = parseCliArgs(runtime.args);
  if (!parsedCliArgs.ok) {
    runtime.writeStderr(`${parsedCliArgs.message}\n`);
    return 1;
  }
  const cliArgs = parsedCliArgs.value;

  if (cliArgs.command === "doctor") {
    const { runDoctor } = await import("./doctor.ts");
    const result = await runDoctor();
    runtime.writeStdout(result.stdout);
    runtime.writeStderr(result.stderr);
    return result.exitCode;
  }

  if (cliArgs.command === "eval") {
    const { runEvalCommand } = await import("../eval/run.ts");
    return await runEvalCommand({
      suiteDir: cliArgs.suiteDir,
      outFile: cliArgs.outFile,
      trials: cliArgs.trials,
      ...(cliArgs.taskId !== undefined ? { taskId: cliArgs.taskId } : {}),
      check: cliArgs.check,
      cliEntry: runtime.cliEntry,
    });
  }

  if (cliArgs.command === "undo") {
    const { restoreLastEditCheckpoint } = await import("../core/git.ts");
    const result = restoreLastEditCheckpoint(runtime.cwd());
    switch (result.status) {
      case "restored":
        runtime.writeStdout(`Restored ${result.filePath}\n`);
        return 0;
      case "none":
        runtime.writeStderr(`${result.message}\n`);
        return 1;
      case "blocked":
        runtime.writeStderr(`${result.message}\n`);
        return 1;
    }
  }

  const userMessage = cliArgs.userMessage;
  if (!userMessage) {
    if (
      runtime.input.isTTY !== true &&
      runtime.env("KEEL_FORCE_INTERACTIVE") !== "1"
    ) {
      runtime.writeStderr(`${USAGE}\n`);
      return 1;
    }
    if (cliArgs.reportFile !== undefined) {
      runtime.writeStderr(
        "Error: --report is only supported for one-shot runs.\n",
      );
      return 1;
    }
    try {
      await runInteractiveSession({
        cliArgs,
        workspace: runtime.cwd(),
        platform: runtime.platform,
        input: runtime.input,
        writeStdout: (text) => {
          runtime.writeStdout(text);
        },
        writeStderr: (text) => {
          runtime.writeStderr(text);
        },
        onSigint: (handler) => {
          runtime.onSigint(handler);
        },
        offSigint: (handler) => {
          runtime.offSigint(handler);
        },
        setExitCode: (code) => {
          exitCode = code;
        },
        forceExit: runtime.forceExit,
        resolveProvider: (message) =>
          resolveInteractiveProvider(message, runtime),
        requireKnownCostModel,
        printAgentEvents: (stream) => printAgentEvents(stream, runtime),
        formatCostReport,
      });
    } catch (error) {
      if (error instanceof CliInputError) {
        runtime.writeStderr(`${error.message}\n`);
        return 1;
      }
      /* v8 ignore next: unexpected interactive runtime failures are allowed to escape. */
      throw error;
    }
    return exitCode;
  }

  const abortController = new AbortController();
  const abort = () => {
    abortController.abort();
  };
  try {
    const resolved = resolveProvider(userMessage, runtime);
    runtime.onSigint(abort);

    const workspace = runtime.cwd();
    const startedAt = runtime.now();
    const bashPermission = oneShotBashPermissionPolicy(cliArgs.bashPolicy);
    const stream = runAgent({
      workspace,
      provider: resolved.provider,
      userMessage,
      systemPrompt: buildAgentSystemPrompt({
        workspace,
        platform: runtime.platform,
      }),
      signal: abortController.signal,
      ...(cliArgs.allowBash ? { allowBash: true } : {}),
      ...(bashPermission !== undefined ? { bashPermission } : {}),
      ...(cliArgs.maxCostUsd !== undefined || cliArgs.reportFile !== undefined
        ? {
            costTracking: {
              model: requireKnownCostModel(resolved),
              ...(cliArgs.maxCostUsd !== undefined
                ? { maxCostUsd: cliArgs.maxCostUsd }
                : {}),
            },
          }
        : {}),
    });

    const finalEnd = await printAgentEvents(stream, runtime);
    runtime.writeStdout("\n");
    if (cliArgs.maxCostUsd !== undefined && finalEnd?.cost !== undefined) {
      runtime.writeStderr(formatCostReport(finalEnd.cost, cliArgs.maxCostUsd));
    }
    if (cliArgs.reportFile !== undefined && finalEnd !== undefined) {
      assertEndEventHasCost(finalEnd);
      writeRunReport(cliArgs.reportFile, {
        provider: resolved.provider.id,
        model: resolved.model,
        end: finalEnd,
        durationMs: runtime.now() - startedAt,
      });
    }
  } catch (error) {
    if (error instanceof CliInputError) {
      runtime.writeStderr(`${error.message}\n`);
      return 1;
    }
    /* v8 ignore next 4: unexpected runtime failures are allowed to escape. */
    if (!abortController.signal.aborted) {
      throw error;
    }
    runtime.writeStdout("\n");
    return 130;
  } finally {
    runtime.offSigint(abort);
  }
  return 0;
}

/* v8 ignore start: real process adapter is exercised by CLI subprocess tests. */
function defaultRuntime(): CliRuntime {
  return {
    args: process.argv.slice(2),
    cliEntry: import.meta.filename,
    cwd: () => process.cwd(),
    env: (key) => process.env[key],
    input: process.stdin,
    platform: process.platform,
    now: () => Date.now(),
    writeStdout: (text) => {
      process.stdout.write(text);
    },
    writeStderr: (text) => {
      process.stderr.write(text);
    },
    onSigint: (handler) => {
      process.on("SIGINT", handler);
    },
    offSigint: (handler) => {
      process.off("SIGINT", handler);
    },
    forceExit: (code) => process.exit(code),
  };
}

export async function main(): Promise<void> {
  process.exitCode = await runCliMain(defaultRuntime());
}

// process.argv[1] keeps the launch path; npm/pnpm install bins as symlinks,
// so resolve to the real path before comparing against the resolved module URL.
if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  await main();
}
/* v8 ignore stop */
