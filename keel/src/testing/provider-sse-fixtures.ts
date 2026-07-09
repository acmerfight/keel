import type { Server } from "node:net";

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
function sseData(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

export function sseToolCall(
  id: string,
  name: string,
  args: Record<string, unknown>,
  options: { readonly index?: number } = {},
): string {
  return sseData({
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: options.index ?? 0,
              id,
              type: "function",
              function: {
                name,
                arguments: JSON.stringify(args),
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

export function sseToolFinish(): string {
  return sseData({
    choices: [{ delta: {}, finish_reason: "tool_calls" }],
    usage: {
      prompt_tokens: 10,
      prompt_cache_hit_tokens: 0,
      prompt_cache_miss_tokens: 10,
      completion_tokens: 3,
    },
  });
}

export function sseTextReplyWithUsage(
  text: string,
  usage: {
    readonly prompt_tokens: number;
    readonly completion_tokens: number;
  } = { prompt_tokens: 10, completion_tokens: 3 },
): string {
  return [
    `data: ${JSON.stringify({
      choices: [{ delta: { content: text } }],
    })}\n\n`,
    `data: ${JSON.stringify({
      choices: [{ delta: {}, finish_reason: "stop" }],
      usage: {
        prompt_tokens: usage.prompt_tokens,
        prompt_cache_hit_tokens: 0,
        prompt_cache_miss_tokens: usage.prompt_tokens,
        completion_tokens: usage.completion_tokens,
      },
    })}\n\n`,
    "data: [DONE]\n\n",
  ].join("");
}
