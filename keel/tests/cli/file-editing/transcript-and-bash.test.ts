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
  sseBashSecretToolCall,
  sseEditToolFinish,
  sseReadToolCall,
  sseStopFinish,
  sseTextReply,
  tmpdir,
  writeFile,
} from "./fixtures.ts";

describe("CLI File Editing", () => {
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
      expect(transcript).not.toContain("read_projection");
      expect(transcript).toContain("[REDACTED_SECRET]");
      expect(JSON.stringify(capturedBodies[1])).not.toContain(
        "read_projection",
      );
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
});
