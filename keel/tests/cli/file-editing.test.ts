import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { runCli } from "../../src/testing/cli-harness.ts";

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

function sseReadToolCall(path = "note.txt"): string {
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

function sseWriteToolCall(): string {
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

function sseGlobToolCall(): string {
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
      expect(result.stderr).toBe("Tool: read note.txt\nTool: edit note.txt\n");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an unquoted multi-word one-shot request,
    When user runs the CLI with separate prompt words,
    Then the full request is sent to the agent`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-edit-"));
    await writeFile(join(workspace, "note.txt"), "hello old world\n", "utf8");

    try {
      // When
      const result = await runCli(
        ["replace", "old", "with", "new", "in", "note.txt"],
        {
          cwd: workspace,
          env: { KEEL_PROVIDER: "fake" },
        },
      );

      // Then
      expect(result.exitCode).toBe(0);
      expect(await readFile(join(workspace, "note.txt"), "utf8")).toBe(
        "hello new world\n",
      );
      expect(result.stdout).toBe("Edited note.txt\n");
      expect(result.stderr).toBe("Tool: read note.txt\nTool: edit note.txt\n");
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
          res.write(sseReadToolCall());
          res.write(
            sseEditToolFinish({ prompt_tokens: 20, completion_tokens: 5 }),
          );
        } else if (requestCount === 2) {
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
      expect(result.stderr).toBe("Tool: read note.txt\nTool: edit note.txt\n");

      const request = JSON.parse(capturedBody);
      expect(
        request.tools?.map(
          (tool: { readonly function?: { readonly name?: string } }) =>
            tool.function?.name,
        ),
      ).toEqual([
        "update_plan",
        "read",
        "ls",
        "glob",
        "grep",
        "git_status",
        "git_diff",
        "edit",
        "write",
        "apply_patch",
      ]);
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the configured provider requests a new file write,
    When user asks the CLI to create a workspace file,
    Then the file is created on disk and stdout contains only the final reply`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-write-"));
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
          res.write(sseWriteToolCall());
          res.write(
            sseEditToolFinish({ prompt_tokens: 30, completion_tokens: 8 }),
          );
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }

        res.write(sseTextReply("Created config.json."));
        res.write(sseStopFinish({ prompt_tokens: 40, completion_tokens: 2 }));
        res.write("data: [DONE]\n\n");
        res.end();
      });
    });
    await listen(server);

    try {
      // When
      const result = await runCli(["create config.json"], {
        cwd: workspace,
        env: {
          DEEPSEEK_API_KEY: "test-key",
          DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
        },
      });

      // Then
      expect(result.exitCode).toBe(0);
      expect(await readFile(join(workspace, "config.json"), "utf8")).toBe(
        '{"created":true}\n',
      );
      expect(result.stdout).toBe("Created config.json.\n");
      expect(result.stderr).toBe("Tool: write config.json\n");
      expect(capturedBodies).toHaveLength(2);

      const firstRequest = requestWithToolsSchema.parse(capturedBodies[0]);
      expect(firstRequest.tools?.map((tool) => tool.function?.name)).toEqual([
        "update_plan",
        "read",
        "ls",
        "glob",
        "grep",
        "git_status",
        "git_diff",
        "edit",
        "write",
        "apply_patch",
      ]);

      const secondRequest = requestWithMessagesSchema.parse(capturedBodies[1]);
      expect(secondRequest.messages).toContainEqual({
        role: "tool",
        tool_call_id: "call_write",
        content: "Wrote config.json",
      });
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a one-shot transcript captures a secret-like tool result,
    When user runs the CLI with transcript persistence,
    Then the transcript is redacted while live provider history stays unchanged`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-transcript-"));
    const transcriptPath = join(workspace, "transcript.jsonl");
    const githubToken = `ghp_${"C".repeat(36)}`;
    const googleApiKey = `AIza${"D".repeat(35)}`;
    await writeFile(
      join(workspace, "secret.txt"),
      `before sk-secret-213 after ${githubToken}\nAPI_KEY=env-secret-213\nGOOGLE_API_KEY=${googleApiKey}\n`,
      "utf8",
    );
    let requestCount = 0;
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
        requestCount++;
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });

        if (requestCount === 1) {
          res.write(sseReadToolCall("secret.txt"));
          res.write(
            sseEditToolFinish({ prompt_tokens: 20, completion_tokens: 5 }),
          );
        } else {
          res.write(sseTextReply("Inspected secret.txt."));
          res.write(sseStopFinish({ prompt_tokens: 30, completion_tokens: 3 }));
        }
        res.write("data: [DONE]\n\n");
        res.end();
      });
    });
    await listen(server);

    try {
      // When
      const result = await runCli(
        ["--transcript", transcriptPath, "inspect secret.txt"],
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
      expect(result.stdout).toBe("Inspected secret.txt.\n");
      expect(result.stderr).toBe("Tool: read secret.txt\n");
      expect(capturedBodies).toHaveLength(2);
      const transcript = await readFile(transcriptPath, "utf8");
      expect(transcript).not.toContain("sk-secret-213");
      expect(transcript).not.toContain("env-secret-213");
      expect(transcript).not.toContain(githubToken);
      expect(transcript).not.toContain(googleApiKey);
      expect(transcript).toContain("[REDACTED_SECRET]");
      const secondRequest = requestWithMessagesSchema.parse(capturedBodies[1]);
      const liveToolMessage = secondRequest.messages?.find(
        (message) =>
          message.role === "tool" && message.tool_call_id === "call_read",
      );
      expect(liveToolMessage?.content).toContain("sk-secret-213");
      expect(liveToolMessage?.content).toContain("env-secret-213");
      expect(liveToolMessage?.content).toContain(githubToken);
      expect(liveToolMessage?.content).toContain(googleApiKey);
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
        "update_plan",
        "read",
        "ls",
        "glob",
        "grep",
        "git_status",
        "git_diff",
        "edit",
        "write",
        "apply_patch",
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
      expect(result.stderr).toBe(
        `Tool: bash node -e "process.stdout.write(require('node:fs').readFileSync('secret.txt', 'utf8'))"\n`,
      );
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
      expect(result.stderr).toBe("Tool: read note.txt\nTool: edit note.txt\n");
      expect(capturedBodies).toHaveLength(3);

      const firstRequest = requestWithToolsSchema.parse(capturedBodies[0]);
      expect(firstRequest.tools?.map((tool) => tool.function?.name)).toEqual([
        "update_plan",
        "read",
        "ls",
        "glob",
        "grep",
        "git_status",
        "git_diff",
        "edit",
        "write",
        "apply_patch",
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
      expect(result.stderr).toBe("Tool: grep handleSubmit\n");
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

  test(`Given the configured provider discovers files by name,
    When user asks the CLI to find a matching test file,
    Then the agent sends discovered paths back before the final answer`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-glob-"));
    await mkdir(join(workspace, "tests"), { recursive: true });
    await writeFile(
      join(workspace, "tests", "validator.test.ts"),
      "test('validator', () => {});\n",
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
          res.write(sseGlobToolCall());
          res.write(
            sseEditToolFinish({ prompt_tokens: 20, completion_tokens: 5 }),
          );
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }

        res.write(sseTextReply("Found validator.test.ts."));
        res.write(sseStopFinish({ prompt_tokens: 25, completion_tokens: 4 }));
        res.write("data: [DONE]\n\n");
        res.end();
      });
    });
    await listen(server);

    try {
      // When
      const result = await runCli(["find validator tests"], {
        cwd: workspace,
        env: {
          DEEPSEEK_API_KEY: "test-key",
          DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
        },
      });

      // Then
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("Found validator.test.ts.\n");
      expect(result.stderr).toBe("Tool: glob **/*validator*.test.ts\n");
      expect(capturedBodies).toHaveLength(2);

      const secondRequest = requestWithMessagesSchema.parse(capturedBodies[1]);
      expect(secondRequest.messages).toContainEqual({
        role: "tool",
        tool_call_id: "call_glob",
        content: "tests/validator.test.ts",
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
      expect(result.stderr).toBe(
        "Tool: grep SECRET_VALUE secret.txt\nTool failed: grep SECRET_VALUE secret.txt\n",
      );
      expect(capturedBodies).toHaveLength(2);

      const secondRequest = requestWithMessagesSchema.parse(capturedBodies[1]);
      expect(secondRequest.messages).toContainEqual(
        expect.objectContaining({
          role: "tool",
          tool_call_id: "call_grep",
          content: expect.stringContaining(
            "Tool failed: grep failed: ignored path: secret.txt",
          ),
        }),
      );
      const toolMessage = secondRequest.messages?.find(
        (message) =>
          message.role === "tool" && message.tool_call_id === "call_grep",
      );
      expect(toolMessage?.content).toContain("Recovery:");
      expect(toolMessage?.content).toContain(
        "This file is excluded by project .gitignore.",
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
    Then each edit is applied and stdout contains only the final reply`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-edit-"));
    await writeFile(join(workspace, "note.txt"), "hello old world\n", "utf8");
    let requestCount = 0;
    let secondRequestBody = "";
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
          res.write(sseReadToolCall());
          res.write(
            sseEditToolFinish({ prompt_tokens: 20, completion_tokens: 5 }),
          );
        } else if (requestCount === 2) {
          res.write(sseMultipleEditToolCalls());
          res.write(
            sseEditToolFinish({ prompt_tokens: 30, completion_tokens: 8 }),
          );
        } else {
          secondRequestBody = body;
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
      expect(result.stderr).toBe(
        "Tool: read note.txt\nTool: edit note.txt\nTool: edit note.txt\nTool failed: edit note.txt\n",
      );
      expect(requestCount).toBe(3);
      const secondRequest = requestWithMessagesSchema.parse(
        JSON.parse(secondRequestBody),
      );
      expect(
        secondRequest.messages?.filter((message) => message.role === "tool"),
      ).toEqual([
        {
          role: "tool",
          tool_call_id: "call_read",
          content: "hello old world\n",
        },
        {
          role: "tool",
          tool_call_id: "call_edit_0",
          content: "Edited note.txt",
        },
        {
          role: "tool",
          tool_call_id: "call_edit_1",
          content: expect.stringContaining("file has not been read"),
        },
      ]);
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
                        id: "call_read_a",
                        type: "function",
                        function: {
                          name: "read",
                          arguments: JSON.stringify({
                            path: "a.txt",
                          }),
                        },
                      },
                      {
                        index: 1,
                        id: "call_read_b",
                        type: "function",
                        function: {
                          name: "read",
                          arguments: JSON.stringify({
                            path: "b.txt",
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
                        id: "call_edit_a",
                        type: "function",
                        function: {
                          name: "edit",
                          arguments: JSON.stringify({
                            path: "a.txt",
                            edits: [{ oldText: "wrold", newText: "world" }],
                          }),
                        },
                      },
                      {
                        index: 1,
                        id: "call_edit_b",
                        type: "function",
                        function: {
                          name: "edit",
                          arguments: JSON.stringify({
                            path: "b.txt",
                            edits: [{ oldText: "goodby", newText: "goodbye" }],
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
      expect(result.stderr).toBe(
        "Tool: read a.txt\nTool: read b.txt\nTool: edit a.txt\nTool: edit b.txt\n",
      );
      expect(requestCount).toBe(3);
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
