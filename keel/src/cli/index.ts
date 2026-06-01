#!/usr/bin/env node

import { runAgent } from "../agent/loop.ts";
import { createDeepseekProvider } from "../llm/providers/deepseek.ts";
import { createFakeProvider, fakeResponse } from "../llm/providers/fake.ts";
import type { LLMProvider } from "../llm/types.ts";

function env(key: string): string | undefined {
  return process.env[key];
}

function resolveProvider(): LLMProvider {
  const providerId = env("KEEL_PROVIDER") ?? "deepseek";

  if (providerId === "fake") {
    return createFakeProvider([fakeResponse("Hello from fake provider.")]);
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
  if (!userMessage) {
    process.stderr.write("Usage: keel <message>\n");
    process.exit(1);
  }

  const provider = resolveProvider();
  const abortController = new AbortController();
  const abort = () => {
    abortController.abort();
  };
  process.once("SIGINT", abort);

  try {
    const stream = runAgent({
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
