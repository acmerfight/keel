#!/usr/bin/env node

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { AgentEvent, CostReport } from "../agent/loop.ts";
import { runAgent } from "../agent/loop.ts";
import { buildAgentSystemPrompt } from "../agent/prompt.ts";
import type { CostModel } from "../core/cost.ts";
import { restoreLastEditCheckpoint } from "../core/git.ts";
import { runEvalCommand } from "../eval/run.ts";
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
import { createFakeProvider, fakeResponse } from "../testing/fake-provider.ts";
import { runDoctor } from "./doctor.ts";
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
      readonly userMessage?: string;
      readonly maxCostUsd?: number;
      readonly reportFile?: string;
    };

const USAGE = [
  "Usage: keel [--allow-bash] [--max-cost <usd>] [--report <file>] <message>",
  "       keel eval [--suite <dir>] [--task <id>] [--trials <n>] [--out <file>] [--check]",
  "       keel /undo",
  "",
  "--allow-bash enables trusted shell commands. Shell commands run with the current OS user's permissions and may read or modify gitignored files.",
  "--report writes a machine-readable JSON run report (turns, stop reason, token usage, cost) to the given file.",
  "Provider env: KEEL_PROVIDER=deepseek|kimi|qwen, DEEPSEEK_API_KEY, KIMI_API_KEY, DASHSCOPE_API_KEY, optional *_BASE_URL and *_MODEL.",
  "Qwen keys are region-bound; set QWEN_BASE_URL for China region or workspace-scoped DashScope endpoints.",
].join("\n");

const maxCostSchema = z.coerce.number().finite().positive();

function env(key: string): string | undefined {
  return process.env[key];
}

function parseMaxCost(raw: string | undefined): number {
  const result = maxCostSchema.safeParse(raw);
  if (!result.success) {
    process.stderr.write("Error: --max-cost must be a positive number.\n");
    process.exit(1);
  }
  return result.data;
}

function parseReportFile(raw: string | undefined): string {
  if (raw === undefined || raw === "") {
    process.stderr.write("Error: --report requires a file path.\n");
    process.exit(1);
  }
  return raw;
}

const trialsSchema = z.coerce.number().int().positive();

function parseTrials(raw: string | undefined): number {
  const result = trialsSchema.safeParse(raw);
  if (!result.success) {
    process.stderr.write("Error: --trials must be a positive integer.\n");
    process.exit(1);
  }
  return result.data;
}

function requireOptionValue(option: string, raw: string | undefined): string {
  if (raw === undefined || raw === "") {
    process.stderr.write(`Error: ${option} requires a value.\n`);
    process.exit(1);
  }
  return raw;
}

function parseEvalArgs(args: readonly string[]): EvalCliArgs {
  let suiteDir = join("evals", "tasks");
  let outFile = "eval-results.jsonl";
  let trials = 1;
  let taskId: string | undefined;
  let check = false;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === undefined) continue;

    if (arg === "--suite") {
      suiteDir = requireOptionValue("--suite", args[index + 1]);
      index++;
      continue;
    }
    if (arg === "--out") {
      outFile = requireOptionValue("--out", args[index + 1]);
      index++;
      continue;
    }
    if (arg === "--trials") {
      trials = parseTrials(args[index + 1]);
      index++;
      continue;
    }
    if (arg === "--task") {
      taskId = requireOptionValue("--task", args[index + 1]);
      index++;
      continue;
    }
    if (arg === "--check") {
      check = true;
      continue;
    }

    process.stderr.write(`Error: unknown eval option "${arg}"\n`);
    process.exit(1);
  }

  return {
    command: "eval",
    suiteDir,
    outFile,
    trials,
    ...(taskId !== undefined ? { taskId } : {}),
    check,
  };
}

function parseCliArgs(args: readonly string[]): CliArgs {
  if (args[0] === "--doctor") {
    return { command: "doctor" };
  }

  if (args[0] === "/undo") {
    return { command: "undo" };
  }

  if (args[0] === "eval") {
    return parseEvalArgs(args.slice(1));
  }

  let allowBash = false;
  let maxCostUsd: number | undefined;
  let reportFile: string | undefined;
  let userMessage: string | undefined;
  const maxCostPrefix = "--max-cost=";
  const reportPrefix = "--report=";

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === undefined) continue;

    if (arg === "--allow-bash") {
      allowBash = true;
      continue;
    }

    if (arg === "--max-cost") {
      maxCostUsd = parseMaxCost(args[index + 1]);
      index++;
      continue;
    }

    if (arg.startsWith(maxCostPrefix)) {
      maxCostUsd = parseMaxCost(arg.slice(maxCostPrefix.length));
      continue;
    }

    if (arg === "--report") {
      reportFile = parseReportFile(args[index + 1]);
      index++;
      continue;
    }

    if (arg.startsWith(reportPrefix)) {
      reportFile = parseReportFile(arg.slice(reportPrefix.length));
      continue;
    }

    userMessage = arg;
    break;
  }

  return {
    command: "run",
    allowBash,
    ...(userMessage !== undefined ? { userMessage } : {}),
    ...(maxCostUsd !== undefined ? { maxCostUsd } : {}),
    ...(reportFile !== undefined ? { reportFile } : {}),
  };
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

// The report schema is consumed by external tooling (the eval runner and any
// script comparing runs across keel versions). Bump schemaVersion on any
// breaking change to the shape.
interface RunReportInput {
  readonly provider: string;
  readonly model: string;
  readonly end: Extract<AgentEvent, { readonly type: "end" }>;
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

function writeRunReport(filePath: string, input: RunReportInput): void {
  const cost = input.end.cost;
  if (cost === undefined) {
    throw new Error("run report requires cost tracking to be enabled");
  }

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

function formatCostReport(cost: CostReport): string {
  const spent = `$${formatUsd(cost.spentUsd)}`;
  if (cost.maxUsd === undefined) return `Cost: ${spent}\n`;

  const budget = `$${formatUsd(cost.maxUsd)}`;
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

function resolveProvider(userMessage: string): ResolvedProvider {
  const providerId = env("KEEL_PROVIDER") ?? "deepseek";

  if (providerId === "fake") {
    return {
      provider: createCliFakeProvider(userMessage),
      model: "fake",
      costModel: ZERO_COST_MODEL,
    };
  }

  if (providerId === "deepseek") {
    const apiKey = env("DEEPSEEK_API_KEY");
    if (!apiKey) {
      process.stderr.write(
        "Error: DEEPSEEK_API_KEY is required. Set the API key to use DeepSeek.\n",
      );
      process.exit(1);
    }
    const model = "deepseek-v4-flash";
    return {
      provider: createDeepseekProvider({
        apiKey,
        baseUrl: env("DEEPSEEK_BASE_URL") ?? "https://api.deepseek.com",
        model,
      }),
      model,
      costModel: DEEPSEEK_V4_FLASH_COST_MODEL,
    };
  }

  if (providerId === "kimi") {
    const apiKey = env("KIMI_API_KEY");
    if (!apiKey) {
      process.stderr.write(
        "Error: KIMI_API_KEY is required. Set the API key to use Kimi.\n",
      );
      process.exit(1);
    }
    const model = env("KIMI_MODEL") ?? "kimi-k2.6";
    return {
      provider: createKimiProvider({
        apiKey,
        baseUrl: env("KIMI_BASE_URL") ?? "https://api.moonshot.cn/v1",
        model,
      }),
      model,
      costModel: kimiCostModel(model),
    };
  }

  if (providerId === "qwen") {
    const apiKey = env("DASHSCOPE_API_KEY") ?? env("QWEN_API_KEY");
    if (!apiKey) {
      process.stderr.write(
        "Error: DASHSCOPE_API_KEY or QWEN_API_KEY is required. Set QWEN_BASE_URL for China region or workspace-scoped DashScope endpoints.\n",
      );
      process.exit(1);
    }
    const model = env("QWEN_MODEL") ?? "qwen3.7-plus";
    return {
      provider: createQwenProvider({
        apiKey,
        baseUrl:
          env("QWEN_BASE_URL") ??
          "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
        model,
      }),
      model,
      costModel: qwenCostModel(model),
    };
  }

  process.stderr.write(`Error: unknown provider "${providerId}"\n`);
  process.exit(1);
}

function resolveInteractiveProvider(userMessage: string): ResolvedProvider {
  const providerId = env("KEEL_PROVIDER") ?? "deepseek";
  if (providerId === "fake") {
    return {
      provider: createInteractiveFakeProvider(),
      model: "fake",
      costModel: ZERO_COST_MODEL,
    };
  }

  return resolveProvider(userMessage);
}

function requireKnownCostModel(resolved: ResolvedProvider): CostModel {
  if (resolved.costModel !== null) return resolved.costModel;

  if (resolved.provider.id === "kimi") {
    process.stderr.write(
      `Error: cost tracking is only supported for Kimi model "kimi-k2.6"; configured KIMI_MODEL="${resolved.model}".\n`,
    );
    process.exit(1);
  }

  if (resolved.provider.id === "qwen") {
    process.stderr.write(
      `Error: cost tracking is not supported for Qwen model "${resolved.model}" because its official pricing is tiered by per-request input tokens.\n`,
    );
    process.exit(1);
  }

  process.stderr.write(
    `Error: cost tracking is not supported for provider "${resolved.provider.id}" model "${resolved.model}".\n`,
  );
  process.exit(1);
}

async function printAgentEvents(
  stream: AsyncIterable<AgentEvent>,
): Promise<EndEvent | undefined> {
  let finalEnd: EndEvent | undefined;
  for await (const event of stream) {
    if (event.type === "text") {
      process.stdout.write(sanitizeAssistantText(event.text));
    } else if (event.type === "tool_start") {
      process.stderr.write(`Tool: ${toolCallLabel(event.toolCall)}\n`);
    } else if (event.type === "tool_end") {
      // Status lives in the line prefix because the label is
      // model-controlled text and could end with a forged failure marker.
      if (!event.ok) {
        process.stderr.write(`Tool failed: ${toolCallLabel(event.toolCall)}\n`);
      }
    } else if (event.type === "end") {
      finalEnd = event;
    }
  }
  return finalEnd;
}

async function main(): Promise<void> {
  const cliArgs = parseCliArgs(process.argv.slice(2));
  if (cliArgs.command === "doctor") {
    const result = await runDoctor();
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    process.exitCode = result.exitCode;
    return;
  }

  if (cliArgs.command === "eval") {
    process.exitCode = await runEvalCommand({
      suiteDir: cliArgs.suiteDir,
      outFile: cliArgs.outFile,
      trials: cliArgs.trials,
      ...(cliArgs.taskId !== undefined ? { taskId: cliArgs.taskId } : {}),
      check: cliArgs.check,
      cliEntry: import.meta.filename,
    });
    return;
  }

  if (cliArgs.command === "undo") {
    const result = restoreLastEditCheckpoint(process.cwd());
    switch (result.status) {
      case "restored":
        process.stdout.write(`Restored ${result.filePath}\n`);
        return;
      case "none":
        process.stderr.write(`${result.message}\n`);
        process.exitCode = 1;
        return;
      case "blocked":
        process.stderr.write(`${result.message}\n`);
        process.exitCode = 1;
        return;
    }
  }

  const userMessage = cliArgs.userMessage;
  if (!userMessage) {
    if (process.stdin.isTTY !== true && env("KEEL_FORCE_INTERACTIVE") !== "1") {
      process.stderr.write(`${USAGE}\n`);
      process.exit(1);
    }
    if (cliArgs.reportFile !== undefined) {
      process.stderr.write(
        "Error: --report is only supported for one-shot runs.\n",
      );
      process.exit(1);
    }
    await runInteractiveSession({
      cliArgs,
      workspace: process.cwd(),
      platform: process.platform,
      input: process.stdin,
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
      setExitCode: (code) => {
        process.exitCode = code;
      },
      forceExit: (code) => process.exit(code),
      resolveProvider: resolveInteractiveProvider,
      requireKnownCostModel,
      printAgentEvents,
      formatCostReport,
    });
    return;
  }

  const resolved = resolveProvider(userMessage);
  const abortController = new AbortController();
  const abort = () => {
    abortController.abort();
  };
  process.once("SIGINT", abort);

  try {
    const workspace = process.cwd();
    const startedAt = Date.now();
    const stream = runAgent({
      workspace,
      provider: resolved.provider,
      userMessage,
      systemPrompt: buildAgentSystemPrompt({
        workspace,
        platform: process.platform,
      }),
      signal: abortController.signal,
      ...(cliArgs.allowBash ? { allowBash: true } : {}),
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

    const finalEnd = await printAgentEvents(stream);
    process.stdout.write("\n");
    if (cliArgs.maxCostUsd !== undefined && finalEnd?.cost !== undefined) {
      process.stderr.write(formatCostReport(finalEnd.cost));
    }
    if (cliArgs.reportFile !== undefined && finalEnd !== undefined) {
      writeRunReport(cliArgs.reportFile, {
        provider: resolved.provider.id,
        model: resolved.model,
        end: finalEnd,
        durationMs: Date.now() - startedAt,
      });
    }
  } catch (error) {
    if (!abortController.signal.aborted) {
      throw error;
    }
    process.stdout.write("\n");
    process.exitCode = 130;
  } finally {
    process.off("SIGINT", abort);
  }
}

main();
