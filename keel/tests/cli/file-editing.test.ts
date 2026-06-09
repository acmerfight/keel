import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { z } from "zod";

const CLI_PATH = join(import.meta.dirname, "../../src/cli/index.ts");

const requestWithToolsSchema = z
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

const requestWithMessagesSchema = z
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

function runCli(
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly env?: Record<string, string>;
  },
): Promise<{
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}> {
  return new Promise((resolve) => {
    const child = execFile(
      "node",
      ["--experimental-strip-types", CLI_PATH, ...args],
      {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        timeout: 5000,
      },
      (error, stdout, stderr) => {
        resolve({
          stdout,
          stderr,
          exitCode: error?.code ? Number(error.code) : (child.exitCode ?? 0),
        });
      },
    );
  });
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

function sseEditToolCall(): string {
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
                  oldString: "old",
                  newString: "new",
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

function sseReadToolCall(): string {
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
                  path: "note.txt",
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

function sseGrepToolCall(): string {
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

function sseGrepSecretToolCall(): string {
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

function sseBashSecretToolCall(): string {
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

function sseMultipleEditToolCalls(): string {
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
                  oldString: "old",
                  newString: "new",
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
                  oldString: "world",
                  newString: "there",
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

interface DeepseekUsageFixture {
  readonly prompt_tokens: number;
  readonly completion_tokens: number;
}

function usageFixture(usage: DeepseekUsageFixture): {
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

function sseEditToolFinish(usage?: DeepseekUsageFixture): string {
  return sseData({
    choices: [{ delta: {}, finish_reason: "tool_calls" }],
    ...(usage ? { usage: usageFixture(usage) } : {}),
  });
}

function sseTextReply(text: string): string {
  return sseData({
    choices: [{ delta: { content: text }, finish_reason: null }],
    usage: null,
  });
}

function sseStopFinish(usage: DeepseekUsageFixture): string {
  return sseData({
    choices: [{ delta: {}, finish_reason: "stop" }],
    usage: usageFixture(usage),
  });
}

describe("CLI File Editing", () => {
  test(`Given a workspace file contains text to replace,
    When user runs the CLI with the demo provider,
    Then the file is updated on disk`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-edit-"));
    await writeFile(join(workspace, "note.txt"), "hello old world\n", "utf8");

    try {
      // When
      const result = await runCli(["replace old with new in note.txt"], {
        cwd: workspace,
        env: { KEEL_PROVIDER: "fake" },
      });

      // Then
      expect(result.exitCode).toBe(0);
      expect(await readFile(join(workspace, "note.txt"), "utf8")).toBe(
        "hello new world\n",
      );
      expect(result.stdout).toBe("Edited note.txt\n");
      expect(result.stderr).toBe("");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the configured provider requests a file edit,
    When user asks the CLI to replace text in a workspace file,
    Then the file is updated on disk`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-edit-"));
    await writeFile(join(workspace, "note.txt"), "hello old world\n", "utf8");
    let capturedBody = "";
    let requestCount = 0;
    const server = createServer((req, res) => {
      if (req.url !== "/chat/completions") {
        res.writeHead(404);
        res.end();
        return;
      }

      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        requestCount++;
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });

        if (requestCount === 1) {
          capturedBody = body;
          res.write(sseEditToolCall());
          res.write(
            sseEditToolFinish({ prompt_tokens: 30, completion_tokens: 8 }),
          );
        } else {
          res.write(sseTextReply("Done."));
          res.write(sseStopFinish({ prompt_tokens: 40, completion_tokens: 2 }));
        }
        res.write("data: [DONE]\n\n");
        res.end();
      });
    });
    await listen(server);

    try {
      // When
      const result = await runCli(["replace old with new in note.txt"], {
        cwd: workspace,
        env: {
          DEEPSEEK_API_KEY: "test-key",
          DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
        },
      });

      // Then
      expect(result.exitCode).toBe(0);
      expect(await readFile(join(workspace, "note.txt"), "utf8")).toBe(
        "hello new world\n",
      );
      expect(result.stdout).toBe("Done.\n");
      expect(result.stderr).toBe("");

      const request = JSON.parse(capturedBody);
      expect(
        request.tools?.map(
          (tool: { readonly function?: { readonly name?: string } }) =>
            tool.function?.name,
        ),
      ).toEqual(["read", "grep", "edit"]);
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given user allows shell commands,
    When the CLI sends the provider request,
    Then bash is advertised for that session only`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-bash-"));
    let capturedBody = "";
    const server = createServer((req, res) => {
      if (req.url !== "/chat/completions") {
        res.writeHead(404);
        res.end();
        return;
      }

      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        capturedBody = body;
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.write(sseTextReply("ok"));
        res.write(sseStopFinish({ prompt_tokens: 10, completion_tokens: 2 }));
        res.write("data: [DONE]\n\n");
        res.end();
      });
    });
    await listen(server);

    try {
      // When
      const result = await runCli(["--allow-bash", "inspect workspace"], {
        cwd: workspace,
        env: {
          DEEPSEEK_API_KEY: "test-key",
          DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
        },
      });

      // Then
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("ok\n");
      const request = requestWithToolsSchema.parse(JSON.parse(capturedBody));
      expect(request.tools?.map((tool) => tool.function?.name)).toEqual([
        "read",
        "grep",
        "edit",
        "bash",
      ]);
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given user allows trusted shell commands,
    When the shell reads a gitignored file,
    Then the CLI returns the shell output as trusted access`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-bash-"));
    await writeFile(join(workspace, ".gitignore"), "secret.txt\n", "utf8");
    await writeFile(
      join(workspace, "secret.txt"),
      "SECRET_VALUE=trusted-shell-visible\n",
      "utf8",
    );
    const capturedBodies: unknown[] = [];
    const server = createServer((req, res) => {
      if (req.url !== "/chat/completions") {
        res.writeHead(404);
        res.end();
        return;
      }

      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        capturedBodies.push(JSON.parse(body));
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });

        if (capturedBodies.length === 1) {
          res.write(sseBashSecretToolCall());
          res.write(
            sseEditToolFinish({ prompt_tokens: 20, completion_tokens: 5 }),
          );
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }

        const request = requestWithMessagesSchema.parse(
          capturedBodies[capturedBodies.length - 1],
        );
        const toolMessage = request.messages?.find(
          (message) =>
            message.role === "tool" && message.tool_call_id === "call_bash",
        );
        const reply =
          toolMessage?.content?.includes("trusted-shell-visible") === true
            ? "SECRET_VALUE=trusted-shell-visible"
            : "missing shell output";
        res.write(sseTextReply(reply));
        res.write(sseStopFinish({ prompt_tokens: 25, completion_tokens: 4 }));
        res.write("data: [DONE]\n\n");
        res.end();
      });
    });
    await listen(server);

    try {
      // When
      const result = await runCli(
        ["--allow-bash", "read the ignored file with shell"],
        {
          cwd: workspace,
          env: {
            DEEPSEEK_API_KEY: "test-key",
            DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
          },
        },
      );

      // Then
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("SECRET_VALUE=trusted-shell-visible\n");
      expect(result.stderr).toBe("");
      expect(capturedBodies).toHaveLength(2);

      const secondRequest = requestWithMessagesSchema.parse(capturedBodies[1]);
      expect(secondRequest.messages).toContainEqual({
        role: "tool",
        tool_call_id: "call_bash",
        content: expect.stringContaining("trusted-shell-visible"),
      });
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the configured provider inspects a workspace file before editing,
    When user asks the CLI to fix that file,
    Then the agent sends the file content back and edits the file`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-read-edit-"));
    await writeFile(join(workspace, "note.txt"), "hello old world\n", "utf8");
    const capturedBodies: unknown[] = [];
    const server = createServer((req, res) => {
      if (req.url !== "/chat/completions") {
        res.writeHead(404);
        res.end();
        return;
      }

      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        capturedBodies.push(JSON.parse(body));
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });

        if (capturedBodies.length === 1) {
          res.write(sseReadToolCall());
          res.write(
            sseEditToolFinish({ prompt_tokens: 20, completion_tokens: 5 }),
          );
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }

        if (capturedBodies.length === 2) {
          res.write(sseEditToolCall());
          res.write(
            sseEditToolFinish({ prompt_tokens: 25, completion_tokens: 8 }),
          );
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }

        res.write(sseTextReply("Done."));
        res.write(sseStopFinish({ prompt_tokens: 30, completion_tokens: 2 }));
        res.write("data: [DONE]\n\n");
        res.end();
      });
    });
    await listen(server);

    try {
      // When
      const result = await runCli(["fix note.txt"], {
        cwd: workspace,
        env: {
          DEEPSEEK_API_KEY: "test-key",
          DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
        },
      });

      // Then
      expect(result.exitCode).toBe(0);
      expect(await readFile(join(workspace, "note.txt"), "utf8")).toBe(
        "hello new world\n",
      );
      expect(result.stdout).toBe("Done.\n");
      expect(result.stderr).toBe("");
      expect(capturedBodies).toHaveLength(3);

      const firstRequest = requestWithToolsSchema.parse(capturedBodies[0]);
      expect(firstRequest.tools?.map((tool) => tool.function?.name)).toEqual([
        "read",
        "grep",
        "edit",
      ]);

      const secondRequest = requestWithMessagesSchema.parse(capturedBodies[1]);
      expect(secondRequest.messages).toContainEqual({
        role: "tool",
        tool_call_id: "call_read",
        content: "hello old world\n",
      });
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the configured provider searches the workspace,
    When user asks the CLI to find a symbol,
    Then the agent sends search matches back before the final answer`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-grep-"));
    await writeFile(
      join(workspace, "app.ts"),
      "export function handleSubmit() {}\n",
      "utf8",
    );
    const capturedBodies: unknown[] = [];
    const server = createServer((req, res) => {
      if (req.url !== "/chat/completions") {
        res.writeHead(404);
        res.end();
        return;
      }

      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        capturedBodies.push(JSON.parse(body));
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });

        if (capturedBodies.length === 1) {
          res.write(sseGrepToolCall());
          res.write(
            sseEditToolFinish({ prompt_tokens: 20, completion_tokens: 5 }),
          );
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }

        res.write(sseTextReply("Found app.ts."));
        res.write(sseStopFinish({ prompt_tokens: 25, completion_tokens: 4 }));
        res.write("data: [DONE]\n\n");
        res.end();
      });
    });
    await listen(server);

    try {
      // When
      const result = await runCli(["find handleSubmit"], {
        cwd: workspace,
        env: {
          DEEPSEEK_API_KEY: "test-key",
          DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
        },
      });

      // Then
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("Found app.ts.\n");
      expect(result.stderr).toBe("");
      expect(capturedBodies).toHaveLength(2);

      const secondRequest = requestWithMessagesSchema.parse(capturedBodies[1]);
      expect(secondRequest.messages).toContainEqual({
        role: "tool",
        tool_call_id: "call_grep",
        content: "app.ts:1:export function handleSubmit() {}",
      });
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the configured provider searches an ignored file,
    When user runs the CLI,
    Then the agent sends the ignored path error back without exposing the ignored file contents`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-grep-"));
    await writeFile(join(workspace, ".gitignore"), "secret.txt\n", "utf8");
    await writeFile(
      join(workspace, "secret.txt"),
      "SECRET_VALUE=do-not-print\n",
      "utf8",
    );
    const capturedBodies: unknown[] = [];
    const server = createServer((req, res) => {
      if (req.url !== "/chat/completions") {
        res.writeHead(404);
        res.end();
        return;
      }

      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        capturedBodies.push(JSON.parse(body));
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });

        if (capturedBodies.length === 1) {
          res.write(sseGrepSecretToolCall());
          res.write(
            sseEditToolFinish({ prompt_tokens: 20, completion_tokens: 5 }),
          );
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }

        res.write(sseTextReply("grep failed: ignored path: secret.txt"));
        res.write(sseStopFinish({ prompt_tokens: 25, completion_tokens: 4 }));
        res.write("data: [DONE]\n\n");
        res.end();
      });
    });
    await listen(server);

    try {
      // When
      const result = await runCli(["find SECRET_VALUE"], {
        cwd: workspace,
        env: {
          DEEPSEEK_API_KEY: "test-key",
          DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
        },
      });

      // Then
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("ignored path");
      expect(result.stdout).toContain("secret.txt");
      expect(result.stdout).not.toContain("do-not-print");
      expect(result.stderr).toBe("");
      expect(capturedBodies).toHaveLength(2);

      const secondRequest = requestWithMessagesSchema.parse(capturedBodies[1]);
      expect(secondRequest.messages).toContainEqual({
        role: "tool",
        tool_call_id: "call_grep",
        content: "Tool failed: grep failed: ignored path: secret.txt",
      });
      const toolMessage = secondRequest.messages?.find(
        (message) =>
          message.role === "tool" && message.tool_call_id === "call_grep",
      );
      expect(toolMessage?.content).not.toContain("do-not-print");
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the provider response ends before completion,
    When user asks the CLI to replace text in a workspace file,
    Then the CLI fails and the file is unchanged`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-edit-"));
    await writeFile(join(workspace, "note.txt"), "hello old world\n", "utf8");
    const server = createServer((req, res) => {
      if (req.url !== "/chat/completions") {
        res.writeHead(404);
        res.end();
        return;
      }

      req.resume();
      req.on("end", () => {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.write(sseEditToolCall());
        res.write(
          sseEditToolFinish({ prompt_tokens: 30, completion_tokens: 8 }),
        );
        res.end();
      });
    });
    await listen(server);

    try {
      // When
      const result = await runCli(["replace old with new in note.txt"], {
        cwd: workspace,
        env: {
          DEEPSEEK_API_KEY: "test-key",
          DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
        },
      });

      // Then
      expect(result.exitCode).not.toBe(0);
      expect(await readFile(join(workspace, "note.txt"), "utf8")).toBe(
        "hello old world\n",
      );
      expect(result.stderr).toContain("DeepSeek stream ended without [DONE]");
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the configured provider proposes multiple file edits in one response,
    When user asks the CLI to replace text in a workspace file,
    Then the CLI fails and the file is unchanged`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-edit-"));
    await writeFile(join(workspace, "note.txt"), "hello old world\n", "utf8");
    const server = createServer((req, res) => {
      if (req.url !== "/chat/completions") {
        res.writeHead(404);
        res.end();
        return;
      }

      req.resume();
      req.on("end", () => {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.write(sseMultipleEditToolCalls());
        res.write(
          sseEditToolFinish({ prompt_tokens: 30, completion_tokens: 8 }),
        );
        res.write("data: [DONE]\n\n");
        res.end();
      });
    });
    await listen(server);

    try {
      // When
      const result = await runCli(["replace old with new in note.txt"], {
        cwd: workspace,
        env: {
          DEEPSEEK_API_KEY: "test-key",
          DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
        },
      });

      // Then
      expect(result.exitCode).not.toBe(0);
      expect(await readFile(join(workspace, "note.txt"), "utf8")).toBe(
        "hello old world\n",
      );
      expect(result.stderr).toContain(
        "Keel does not support multiple tool calls in one turn",
      );
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the provider completes a file edit response without token usage,
    When user asks the CLI to replace text in a workspace file,
    Then the CLI fails and the file is unchanged`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-edit-"));
    await writeFile(join(workspace, "note.txt"), "hello old world\n", "utf8");
    const server = createServer((req, res) => {
      if (req.url !== "/chat/completions") {
        res.writeHead(404);
        res.end();
        return;
      }

      req.resume();
      req.on("end", () => {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.write(sseEditToolCall());
        res.write(sseEditToolFinish());
        res.write("data: [DONE]\n\n");
        res.end();
      });
    });
    await listen(server);

    try {
      // When
      const result = await runCli(["replace old with new in note.txt"], {
        cwd: workspace,
        env: {
          DEEPSEEK_API_KEY: "test-key",
          DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
        },
      });

      // Then
      expect(result.exitCode).not.toBe(0);
      expect(await readFile(join(workspace, "note.txt"), "utf8")).toBe(
        "hello old world\n",
      );
      expect(result.stderr).toContain("DeepSeek stream ended without usage");
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given two workspace files each contain a typo,
    When user runs the CLI with a provider that edits both,
    Then both files are edited and stdout contains only the final reply`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-multi-edit-"));
    await writeFile(join(workspace, "a.txt"), "hello wrold\n", "utf8");
    await writeFile(join(workspace, "b.txt"), "goodby world\n", "utf8");
    let requestCount = 0;
    const server = createServer((req, res) => {
      if (req.url !== "/chat/completions") {
        res.writeHead(404);
        res.end();
        return;
      }

      req.resume();
      req.on("end", () => {
        requestCount++;
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });

        if (requestCount === 1) {
          res.write(
            sseData({
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: "call_edit_a",
                        type: "function",
                        function: {
                          name: "edit",
                          arguments: JSON.stringify({
                            path: "a.txt",
                            oldString: "wrold",
                            newString: "world",
                          }),
                        },
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ],
              usage: null,
            }),
          );
          res.write(
            sseEditToolFinish({ prompt_tokens: 20, completion_tokens: 5 }),
          );
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }

        if (requestCount === 2) {
          res.write(
            sseData({
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: "call_edit_b",
                        type: "function",
                        function: {
                          name: "edit",
                          arguments: JSON.stringify({
                            path: "b.txt",
                            oldString: "goodby",
                            newString: "goodbye",
                          }),
                        },
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ],
              usage: null,
            }),
          );
          res.write(
            sseEditToolFinish({ prompt_tokens: 30, completion_tokens: 5 }),
          );
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }

        res.write(sseTextReply("Fixed both files."));
        res.write(sseStopFinish({ prompt_tokens: 40, completion_tokens: 4 }));
        res.write("data: [DONE]\n\n");
        res.end();
      });
    });
    await listen(server);

    try {
      // When
      const result = await runCli(["fix typos in both files"], {
        cwd: workspace,
        env: {
          DEEPSEEK_API_KEY: "test-key",
          DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
        },
      });

      // Then
      expect(result.exitCode).toBe(0);
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe(
        "hello world\n",
      );
      expect(await readFile(join(workspace, "b.txt"), "utf8")).toBe(
        "goodbye world\n",
      );
      expect(result.stdout).toBe("Fixed both files.\n");
      expect(result.stderr).toBe("");
      expect(requestCount).toBe(3);
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
