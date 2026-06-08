#!/usr/bin/env node

import { z } from "zod";
import type { CostReport } from "../agent/loop.ts";
import { runAgent } from "../agent/loop.ts";
import {
  createDeepseekProvider,
  DEEPSEEK_V4_FLASH_COST_MODEL,
} from "../llm/providers/deepseek.ts";
import type { LLMProvider } from "../llm/types.ts";
import {
  createFakeProvider,
  fakeEditResponse,
  fakeResponse,
} from "../testing/fake-provider.ts";
import { runDoctor } from "./doctor.ts";

interface CliEditRequest {
  readonly path: string;
  readonly oldString: string;
  readonly newString: string;
}

interface CliArgs {
  readonly doctor: boolean;
  readonly allowBash: boolean;
  readonly userMessage?: string;
  readonly maxCostUsd?: number;
}

const USAGE = [
  "Usage: keel [--allow-bash] [--max-cost <usd>] <message>",
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
    return { doctor: true, allowBash: false };
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
    doctor: false,
    allowBash,
    ...(userMessage !== undefined ? { userMessage } : {}),
    ...(maxCostUsd !== undefined ? { maxCostUsd } : {}),
  };
}

function formatUsd(value: number): string {
  return value < 0.0001 ? value.toFixed(6) : value.toFixed(4);
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

function createCliFakeProvider(userMessage: string): LLMProvider {
  const edit = parseCliEditDemo(userMessage);
  if (edit === null) {
    return createFakeProvider([fakeResponse("Hello from fake provider.")]);
  }

  return createFakeProvider([
    fakeEditResponse(edit.path, edit.oldString, edit.newString),
  ]);
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
  if (cliArgs.doctor) {
    const result = await runDoctor();
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    process.exitCode = result.exitCode;
    return;
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
    const stream = runAgent({
      workspace: process.cwd(),
      provider,
      userMessage,
      systemPrompt: "You are a helpful assistant.",
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
        process.stdout.write(event.text);
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
