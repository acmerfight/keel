#!/usr/bin/env node

import { runAgent } from "../agent/loop.ts";
import { createDeepseekProvider } from "../llm/providers/deepseek.ts";
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

function env(key: string): string | undefined {
  return process.env[key];
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
  const userMessage = process.argv[2];
  if (userMessage === "--doctor") {
    const result = await runDoctor();
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    process.exitCode = result.exitCode;
    return;
  }

  if (!userMessage) {
    process.stderr.write("Usage: keel <message>\n");
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
    });

    for await (const event of stream) {
      if (event.type === "text") {
        process.stdout.write(event.text);
      }
    }
    process.stdout.write("\n");
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
