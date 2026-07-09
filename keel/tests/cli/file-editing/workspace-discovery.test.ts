import { describe, expect, test } from "vitest";
import {
  close,
  createServer,
  getPort,
  join,
  listen,
  mkdir,
  mkdtemp,
  readFile,
  requestWithMessagesSchema,
  requestWithToolsSchema,
  rm,
  runCli,
  sseEditToolCall,
  sseEditToolFinish,
  sseGlobToolCall,
  sseGrepSecretToolCall,
  sseGrepToolCall,
  sseReadToolCall,
  sseStopFinish,
  sseTextReply,
  tmpdir,
  writeFile,
} from "./fixtures.ts";

describe("CLI File Editing", () => {
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
        "update_goal",
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
});
