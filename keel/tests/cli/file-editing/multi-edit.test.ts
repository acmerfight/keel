import { describe, expect, test } from "vitest";
import {
  close,
  createServer,
  getPort,
  join,
  listen,
  mkdtemp,
  readFile,
  requestWithMessagesSchema,
  rm,
  runCli,
  sseData,
  sseEditToolFinish,
  sseMultipleEditToolCalls,
  sseReadToolCall,
  sseStopFinish,
  sseTextReply,
  tmpdir,
  writeFile,
} from "./fixtures.ts";

describe("CLI File Editing", () => {
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
        "Tool: read note.txt\nTool: edit note.txt\nTool: edit note.txt\nTool failed: edit note.txt\nWarning: change applied; undo checkpoint unavailable for this task.\n",
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
        "Tool: read a.txt\nTool: read b.txt\nTool: edit a.txt\nTool: edit b.txt\nWarning: change applied; undo checkpoint unavailable for this task.\n",
      );
      expect(requestCount).toBe(3);
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
