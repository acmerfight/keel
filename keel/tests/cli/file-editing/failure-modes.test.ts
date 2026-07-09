import { describe, expect, test } from "vitest";
import {
  close,
  createServer,
  getPort,
  join,
  listen,
  mkdtemp,
  readFile,
  rm,
  runCli,
  sseEditToolCall,
  sseEditToolFinish,
  tmpdir,
  writeFile,
} from "./fixtures.ts";

describe("CLI File Editing", () => {
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
});
