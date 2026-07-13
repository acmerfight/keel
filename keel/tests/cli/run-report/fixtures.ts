import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { runCli, runCliProcess } from "../../../src/testing/cli-harness.ts";

export {
  createServer,
  join,
  mkdtemp,
  readFile,
  rm,
  runCli,
  runCliProcess,
  tmpdir,
  writeFile,
  z,
};
export const runReportSchema = z.object({
  schemaVersion: z.literal(8),
  turns: z.number().int().nonnegative(),
  stopReason: z.string(),
  usage: z.object({
    inputTokens: z.number().int().nonnegative(),
    cachedInputTokens: z.number().int().nonnegative(),
    uncachedInputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
  }),
  durationMs: z.number().nonnegative(),
  costUsd: z.number(),
  costBudgetUsd: z.number().positive().optional(),
  costOvershootUsd: z.number().nonnegative(),
  contextCompactions: z.array(z.unknown()),
  skillActivations: z.array(z.unknown()),
  modelsUsed: z.array(
    z.object({
      provider: z.string(),
      model: z.string(),
    }),
  ),
  usageByModel: z.array(
    z.object({
      provider: z.string(),
      model: z.string(),
      turns: z.number().int().nonnegative(),
      usage: z.object({
        inputTokens: z.number().int().nonnegative(),
        cachedInputTokens: z.number().int().nonnegative(),
        uncachedInputTokens: z.number().int().nonnegative(),
        outputTokens: z.number().int().nonnegative(),
      }),
      costUsd: z.number(),
    }),
  ),
  undoProtection: z.object({
    status: z.enum(["available", "not_applicable", "unavailable"]),
    checkpointsWritten: z.number().int().nonnegative(),
    failures: z.array(
      z.object({
        reason: z.enum([
          "checkpoint_write_failed",
          "git_workspace_unavailable",
          "target_unavailable",
        ]),
        count: z.number().int().positive(),
      }),
    ),
    latestCheckpoint: z
      .discriminatedUnion("written", [
        z.object({ written: z.literal(true) }),
        z.object({
          written: z.literal(false),
          reason: z.enum([
            "checkpoint_write_failed",
            "git_workspace_unavailable",
            "target_unavailable",
          ]),
        }),
      ])
      .nullable(),
  }),
});

export const requestModelSchema = z.object({
  model: z.string(),
});

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

export function sseTextReplyWithUsage(
  text: string,
  usage: {
    readonly promptTokens: number;
    readonly completionTokens: number;
  } = { promptTokens: 10, completionTokens: 3 },
  finishReason = "stop",
): string {
  return [
    `data: ${JSON.stringify({
      choices: [{ delta: { content: text } }],
    })}\n\n`,
    `data: ${JSON.stringify({
      choices: [{ delta: {}, finish_reason: finishReason }],
      usage: {
        prompt_tokens: usage.promptTokens,
        completion_tokens: usage.completionTokens,
      },
    })}\n\n`,
    "data: [DONE]\n\n",
  ].join("");
}
