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
  requestWithToolsSchema,
  rm,
  runCli,
  sseEditToolCall,
  sseEditToolFinish,
  sseReadToolCall,
  sseStopFinish,
  sseTextReply,
  sseWriteToolCall,
  tmpdir,
  writeFile,
} from "./fixtures.ts";

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
      expect(result.stderr).toBe(
        "Tool: read note.txt\nTool: edit note.txt\nWarning: change applied; undo checkpoint unavailable for this task.\n",
      );
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
      expect(result.stderr).toBe(
        "Tool: read note.txt\nTool: edit note.txt\nWarning: change applied; undo checkpoint unavailable for this task.\n",
      );
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
      expect(result.stderr).toBe(
        "Tool: read note.txt\nTool: edit note.txt\nWarning: change applied; undo checkpoint unavailable for this task.\n",
      );

      const request = JSON.parse(capturedBody);
      expect(
        request.tools?.map(
          (tool: { readonly function?: { readonly name?: string } }) =>
            tool.function?.name,
        ),
      ).toEqual([
        "update_plan",
        "update_goal",
        "skill_resource",
        "skill_search",
        "skill",
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
      expect(result.stderr).toBe(
        "Tool: write config.json\nWarning: change applied; undo checkpoint unavailable for this task.\n",
      );
      expect(capturedBodies).toHaveLength(2);

      const firstRequest = requestWithToolsSchema.parse(capturedBodies[0]);
      expect(firstRequest.tools?.map((tool) => tool.function?.name)).toEqual([
        "update_plan",
        "update_goal",
        "skill_resource",
        "skill_search",
        "skill",
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
});
