import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { USAGE } from "../../../src/cli/args.ts";
import {
  runCli as runCliCommand,
  runCliProcess as runCliProcessCommand,
} from "../../../src/testing/cli-harness.ts";

export {
  createServer,
  join,
  mkdtemp,
  readFile,
  rm,
  runCliCommand,
  runCliProcessCommand,
  tmpdir,
  USAGE,
  z,
};
export function runCli(
  args: readonly string[],
  env: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return runCliCommand(args, { env });
}

export function runCliProcess(
  args: readonly string[],
  env: Record<string, string> = {},
  options: { readonly stdin?: "pipe" | "ignore" } = {},
) {
  return runCliProcessCommand(args, { env, ...options });
}

export function getPort(server: Server): number {
  const addr = server.address();
  if (addr === null || typeof addr === "string") {
    throw new Error("Server not listening on a TCP port");
  }
  return addr.port;
}

export function listen(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
}

export function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

export const requestModelSchema = z.object({
  model: z.string(),
});

export function sseTextReplyWithUsage(
  text: string,
  usage: {
    readonly promptTokens: number;
    readonly promptCacheHitTokens: number;
    readonly promptCacheMissTokens: number;
    readonly completionTokens: number;
  },
): string {
  return [
    `data: ${JSON.stringify({
      choices: [{ delta: { content: text } }],
    })}\n\n`,
    `data: ${JSON.stringify({
      choices: [{ delta: {}, finish_reason: "stop" }],
      usage: {
        prompt_tokens: usage.promptTokens,
        prompt_cache_hit_tokens: usage.promptCacheHitTokens,
        prompt_cache_miss_tokens: usage.promptCacheMissTokens,
        completion_tokens: usage.completionTokens,
      },
    })}\n\n`,
    "data: [DONE]\n\n",
  ].join("");
}

export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(message));
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
