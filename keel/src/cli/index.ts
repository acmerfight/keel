#!/usr/bin/env node

import { z } from "zod";
import type { CostReport } from "../agent/loop.ts";
import { runAgent } from "../agent/loop.ts";
import { buildAgentSystemPrompt } from "../agent/prompt.ts";
import { restoreLastEditCheckpoint } from "../core/git.ts";
import {
  createDeepseekProvider,
  DEEPSEEK_V4_FLASH_COST_MODEL,
} from "../llm/providers/deepseek.ts";
import type { LLMProvider, ToolCall } from "../llm/types.ts";
import { createFakeProvider, fakeResponse } from "../testing/fake-provider.ts";
import { runDoctor } from "./doctor.ts";

interface CliEditRequest {
  readonly path: string;
  readonly oldString: string;
  readonly newString: string;
}

interface CliWriteRequest {
  readonly path: string;
  readonly content: string;
}

type CliArgs =
  | { readonly command: "doctor" }
  | { readonly command: "undo" }
  | {
      readonly command: "run";
      readonly allowBash: boolean;
      readonly userMessage?: string;
      readonly maxCostUsd?: number;
    };

const USAGE = [
  "Usage: keel [--allow-bash] [--max-cost <usd>] <message>",
  "       keel /undo",
  "",
  "--allow-bash enables trusted shell commands. Shell commands run with the current OS user's permissions and may read or modify gitignored files.",
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

function parseCliArgs(args: readonly string[]): CliArgs {
  if (args[0] === "--doctor") {
    return { command: "doctor" };
  }

  if (args[0] === "/undo") {
    return { command: "undo" };
  }

  let allowBash = false;
  let maxCostUsd: number | undefined;
  let userMessage: string | undefined;
  const maxCostPrefix = "--max-cost=";

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

    userMessage = arg;
    break;
  }

  return {
    command: "run",
    allowBash,
    ...(userMessage !== undefined ? { userMessage } : {}),
    ...(maxCostUsd !== undefined ? { maxCostUsd } : {}),
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
// also escape bidi controls (visual reordering, Trojan Source class) and
// zero-width characters (invisible path segments). The length cap keeps one
// tool call to exactly one readable stderr line.
function sanitizeToolLabel(label: string): string {
  const escaped = label.replace(
    // biome-ignore lint/suspicious/noControlCharactersInRegex: escaping control characters is the point
    /[\u0000-\u001f\u007f-\u009f\u200b-\u200d\u2060\u202a-\u202e\u2066-\u2069\ufeff]/g,
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

function resolveProvider(userMessage: string): LLMProvider {
  const providerId = env("KEEL_PROVIDER") ?? "deepseek";

  if (providerId === "fake") {
    return createCliFakeProvider(userMessage);
  }

  if (providerId === "deepseek") {
    const apiKey = env("DEEPSEEK_API_KEY");
    if (!apiKey) {
      process.stderr.write(
        "Error: DEEPSEEK_API_KEY is required. Set the API key to use DeepSeek.\n",
      );
      process.exit(1);
    }
    return createDeepseekProvider({
      apiKey,
      baseUrl: env("DEEPSEEK_BASE_URL") ?? "https://api.deepseek.com",
      model: "deepseek-v4-flash",
    });
  }

  process.stderr.write(`Error: unknown provider "${providerId}"\n`);
  process.exit(1);
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
    process.stderr.write(`${USAGE}\n`);
    process.exit(1);
  }

  const provider = resolveProvider(userMessage);
  const abortController = new AbortController();
  const abort = () => {
    abortController.abort();
  };
  process.once("SIGINT", abort);

  try {
    const workspace = process.cwd();
    const stream = runAgent({
      workspace,
      provider,
      userMessage,
      systemPrompt: buildAgentSystemPrompt({
        workspace,
        platform: process.platform,
      }),
      signal: abortController.signal,
      ...(cliArgs.allowBash ? { allowBash: true } : {}),
      ...(cliArgs.maxCostUsd !== undefined
        ? {
            costTracking: {
              model: DEEPSEEK_V4_FLASH_COST_MODEL,
              maxCostUsd: cliArgs.maxCostUsd,
            },
          }
        : {}),
    });

    let finalCost: CostReport | undefined;
    for await (const event of stream) {
      if (event.type === "text") {
        process.stdout.write(sanitizeAssistantText(event.text));
      } else if (event.type === "tool_start") {
        process.stderr.write(`Tool: ${toolCallLabel(event.toolCall)}\n`);
      } else if (event.type === "tool_end") {
        // Status lives in the line prefix because the label is
        // model-controlled text and could end with a forged failure marker.
        if (!event.ok) {
          process.stderr.write(
            `Tool failed: ${toolCallLabel(event.toolCall)}\n`,
          );
        }
      } else if (event.type === "end") {
        finalCost = event.cost;
      }
    }
    process.stdout.write("\n");
    if (finalCost !== undefined) {
      process.stderr.write(formatCostReport(finalCost));
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
