import { mkdtemp, realpath, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { runCli } from "../../src/testing/cli-harness.ts";

const requestSchema = z.object({
  messages: z.array(z.object({ role: z.string(), content: z.string() })),
});

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
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

const STOP_SSE = [
  `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\n`,
  `data: ${JSON.stringify({
    choices: [{ delta: {}, finish_reason: "stop" }],
    usage: {
      prompt_tokens: 1,
      prompt_cache_hit_tokens: 0,
      prompt_cache_miss_tokens: 1,
      completion_tokens: 1,
    },
  })}\n\n`,
  "data: [DONE]\n\n",
].join("");

describe("CLI System Prompt", () => {
  test(`Given a user message and a configured provider,
    When the user runs keel in their workspace,
    Then the agent runs under a coding-agent system prompt naming its workspace and tool discipline, not a generic assistant`, async () => {
    // Given
    const workspace = await realpath(
      await mkdtemp(join(tmpdir(), "keel-prompt-")),
    );
    const bodies: string[] = [];
    const server = createServer((req, res) => {
      if (req.url !== "/chat/completions") {
        res.writeHead(404);
        res.end();
        return;
      }
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        bodies.push(Buffer.concat(chunks).toString("utf8"));
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.write(STOP_SSE);
        res.end();
      });
    });
    await listen(server);

    try {
      // When
      const result = await runCli(["fix the bug"], {
        cwd: workspace,
        env: {
          DEEPSEEK_API_KEY: "test-key",
          DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
        },
      });

      // Then
      expect(result.exitCode).toBe(0);
      expect(bodies.length).toBeGreaterThan(0);
      const firstBody = bodies[0];
      if (firstBody === undefined) {
        throw new Error("provider received no request body");
      }
      const request = requestSchema.parse(JSON.parse(firstBody));
      const system = request.messages.find((m) => m.role === "system");
      if (system === undefined) {
        throw new Error("provider request had no system message");
      }
      const content = system.content;
      const lower = content.toLowerCase();

      // It is a coding-agent identity, not the generic placeholder.
      expect(content).not.toContain("You are a helpful assistant");
      expect(lower).toContain("keel");
      expect(lower).toContain("coding agent");

      // The workspace root is injected so the model knows where it operates.
      expect(content).toContain(workspace);

      // It carries cross-cutting tool discipline that schemas cannot express.
      expect(lower).toContain("grep");
      expect(lower).toMatch(/read[\s\S]*before[\s\S]*edit/);
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
