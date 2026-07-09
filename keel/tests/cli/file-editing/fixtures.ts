import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { runCli } from "../../../src/testing/cli-harness.ts";

export {
  createServer,
  join,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  runCli,
  tmpdir,
  writeFile,
  z,
};
export const requestWithToolsSchema = z
  .object({
    tools: z
      .array(
        z
          .object({
            function: z
              .object({
                name: z.string().optional(),
              })
              .optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

export const requestWithMessagesSchema = z
  .object({
    messages: z
      .array(
        z
          .object({
            role: z.string().optional(),
            tool_call_id: z.string().optional(),
            content: z.string().nullable().optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

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

export function sseData(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

export function sseEditToolCall(): string {
  return sseData({
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              id: "call_edit",
              type: "function",
              function: {
                name: "edit",
                arguments: JSON.stringify({
                  path: "note.txt",
                  edits: [{ oldText: "old", newText: "new" }],
                }),
              },
            },
          ],
        },
        finish_reason: null,
      },
    ],
    usage: null,
  });
}

export function sseReadToolCall(path = "note.txt"): string {
  return sseData({
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              id: "call_read",
              type: "function",
              function: {
                name: "read",
                arguments: JSON.stringify({
                  path,
                }),
              },
            },
          ],
        },
        finish_reason: null,
      },
    ],
    usage: null,
  });
}

export function sseWriteToolCall(): string {
  return sseData({
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              id: "call_write",
              type: "function",
              function: {
                name: "write",
                arguments: JSON.stringify({
                  path: "config.json",
                  content: '{"created":true}\n',
                }),
              },
            },
          ],
        },
        finish_reason: null,
      },
    ],
    usage: null,
  });
}

export function sseGrepToolCall(): string {
  return sseData({
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              id: "call_grep",
              type: "function",
              function: {
                name: "grep",
                arguments: JSON.stringify({
                  pattern: "handleSubmit",
                }),
              },
            },
          ],
        },
        finish_reason: null,
      },
    ],
    usage: null,
  });
}

export function sseGlobToolCall(): string {
  return sseData({
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              id: "call_glob",
              type: "function",
              function: {
                name: "glob",
                arguments: JSON.stringify({
                  pattern: "**/*validator*.test.ts",
                }),
              },
            },
          ],
        },
        finish_reason: null,
      },
    ],
    usage: null,
  });
}

export function sseGrepSecretToolCall(): string {
  return sseData({
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              id: "call_grep",
              type: "function",
              function: {
                name: "grep",
                arguments: JSON.stringify({
                  pattern: "SECRET_VALUE",
                  path: "secret.txt",
                }),
              },
            },
          ],
        },
        finish_reason: null,
      },
    ],
    usage: null,
  });
}

export function sseBashSecretToolCall(): string {
  return sseData({
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              id: "call_bash",
              type: "function",
              function: {
                name: "bash",
                arguments: JSON.stringify({
                  command:
                    "node -e \"process.stdout.write(require('node:fs').readFileSync('secret.txt', 'utf8'))\"",
                }),
              },
            },
          ],
        },
        finish_reason: null,
      },
    ],
    usage: null,
  });
}

export function sseMultipleEditToolCalls(): string {
  return sseData({
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              id: "call_edit_0",
              type: "function",
              function: {
                name: "edit",
                arguments: JSON.stringify({
                  path: "note.txt",
                  edits: [{ oldText: "old", newText: "new" }],
                }),
              },
            },
            {
              index: 1,
              id: "call_edit_1",
              type: "function",
              function: {
                name: "edit",
                arguments: JSON.stringify({
                  path: "note.txt",
                  edits: [{ oldText: "world", newText: "there" }],
                }),
              },
            },
          ],
        },
        finish_reason: null,
      },
    ],
    usage: null,
  });
}

export interface DeepseekUsageFixture {
  readonly prompt_tokens: number;
  readonly completion_tokens: number;
}

export function usageFixture(usage: DeepseekUsageFixture): {
  readonly prompt_tokens: number;
  readonly prompt_cache_hit_tokens: number;
  readonly prompt_cache_miss_tokens: number;
  readonly completion_tokens: number;
} {
  return {
    prompt_tokens: usage.prompt_tokens,
    prompt_cache_hit_tokens: 0,
    prompt_cache_miss_tokens: usage.prompt_tokens,
    completion_tokens: usage.completion_tokens,
  };
}

export function sseEditToolFinish(usage?: DeepseekUsageFixture): string {
  return sseData({
    choices: [{ delta: {}, finish_reason: "tool_calls" }],
    ...(usage ? { usage: usageFixture(usage) } : {}),
  });
}

export function sseTextReply(text: string): string {
  return sseData({
    choices: [{ delta: { content: text }, finish_reason: null }],
    usage: null,
  });
}

export function sseStopFinish(usage: DeepseekUsageFixture): string {
  return sseData({
    choices: [{ delta: {}, finish_reason: "stop" }],
    usage: usageFixture(usage),
  });
}
