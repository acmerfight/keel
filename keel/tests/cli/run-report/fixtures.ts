import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { runReportSchema } from "../../../src/eval/report-schema.ts";
import { runCli, runCliProcess } from "../../../src/testing/cli-harness.ts";

export {
  createServer,
  join,
  mkdtemp,
  readFile,
  rm,
  runCli,
  runCliProcess,
  runReportSchema,
  tmpdir,
  writeFile,
};

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
