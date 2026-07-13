import { createServer } from "node:http";
import type { Server } from "node:net";
import { expect } from "vitest";
import {
  type CommandResult,
  createGitWorkspace as createHarnessGitWorkspace,
  runCli as runCliHarness,
} from "../../../src/testing/cli-harness.ts";

export { readFile, rm, writeFile } from "node:fs/promises";
export { join } from "node:path";
export {
  commitFile,
  runGit,
} from "../../../src/testing/cli-harness.ts";
export { runCliHarness as runCli };

export function createGitWorkspace(): Promise<string> {
  return createHarnessGitWorkspace("keel-cli-undo-");
}

function getPort(server: Server): number {
  const addr = server.address();
  if (addr === null || typeof addr === "string") {
    throw new Error("Server not listening on a TCP port");
  }
  return addr.port;
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
}

function close(server: Server): Promise<void> {
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

function sseToolCall(
  id: string,
  tool: string,
  args: Record<string, unknown>,
): string {
  return sseData({
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              id,
              type: "function",
              function: {
                name: tool,
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

function usageFixture(): {
  readonly prompt_tokens: number;
  readonly prompt_cache_hit_tokens: number;
  readonly prompt_cache_miss_tokens: number;
  readonly completion_tokens: number;
} {
  return {
    prompt_tokens: 0,
    prompt_cache_hit_tokens: 0,
    prompt_cache_miss_tokens: 0,
    completion_tokens: 0,
  };
}

function sseToolFinish(): string {
  return sseData({
    choices: [{ delta: {}, finish_reason: "tool_calls" }],
    usage: usageFixture(),
  });
}

function sseTextReply(text: string): string {
  return sseData({
    choices: [{ delta: { content: text }, finish_reason: null }],
    usage: null,
  });
}

function sseStopFinish(): string {
  return sseData({
    choices: [{ delta: {}, finish_reason: "stop" }],
    usage: usageFixture(),
  });
}

export async function runTwoFileEditTask(
  workspace: string,
): Promise<CommandResult> {
  let requestCount = 0;
  const server = createServer((req, res) => {
    if (req.url !== "/chat/completions") {
      res.writeHead(404);
      res.end();
      return;
    }

    req.on("data", () => {});
    req.on("end", () => {
      requestCount++;
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });

      if (requestCount === 1) {
        res.write(
          sseToolCall("call_read_first", "read", { path: "first.txt" }),
        );
        res.write(sseToolFinish());
      } else if (requestCount === 2) {
        res.write(
          sseToolCall("call_edit_first", "edit", {
            path: "first.txt",
            edits: [{ oldText: "old", newText: "new" }],
          }),
        );
        res.write(sseToolFinish());
      } else if (requestCount === 3) {
        res.write(
          sseToolCall("call_read_second", "read", { path: "second.txt" }),
        );
        res.write(sseToolFinish());
      } else if (requestCount === 4) {
        res.write(
          sseToolCall("call_edit_second", "edit", {
            path: "second.txt",
            edits: [{ oldText: "old", newText: "new" }],
          }),
        );
        res.write(sseToolFinish());
      } else {
        res.write(sseTextReply("Updated both files."));
        res.write(sseStopFinish());
      }
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await listen(server);

  try {
    const edit = await runCliHarness(["update both files"], {
      cwd: workspace,
      env: {
        DEEPSEEK_API_KEY: "test-key",
        DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
      },
    });
    expect(edit.exitCode).toBe(0);
    return edit;
  } finally {
    await close(server);
  }
}
