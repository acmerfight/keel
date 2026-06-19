import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { runCli, runCliProcess } from "../../src/testing/cli-harness.ts";

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

async function withCapturedProviderRequests<T>(
  action: (baseUrl: string) => Promise<T>,
): Promise<{ readonly result: T; readonly bodies: readonly string[] }> {
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
    const result = await action(`http://127.0.0.1:${getPort(server)}`);
    return { result, bodies };
  } finally {
    await close(server);
  }
}

function firstSystemPrompt(bodies: readonly string[]): string {
  const firstBody = bodies[0];
  if (firstBody === undefined) {
    throw new Error("provider received no request body");
  }
  const request = requestSchema.parse(JSON.parse(firstBody));
  const system = request.messages.find((m) => m.role === "system");
  if (system === undefined) {
    throw new Error("provider request had no system message");
  }
  return system.content;
}

describe("CLI System Prompt", () => {
  test(`Given a user message and a configured provider,
    When the user runs keel in their workspace,
    Then the agent runs under a coding-agent system prompt naming its workspace and tool discipline, not a generic assistant`, async () => {
    // Given
    const workspace = await realpath(
      await mkdtemp(join(tmpdir(), "keel-prompt-")),
    );

    try {
      // When
      const { result, bodies } = await withCapturedProviderRequests((baseUrl) =>
        runCli(["fix the bug"], {
          cwd: workspace,
          env: {
            DEEPSEEK_API_KEY: "test-key",
            DEEPSEEK_BASE_URL: baseUrl,
          },
        }),
      );

      // Then
      expect(result.exitCode).toBe(0);
      expect(bodies.length).toBeGreaterThan(0);
      const content = firstSystemPrompt(bodies);
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
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given root AGENTS instructions exist,
    When the user runs a one-shot task,
    Then the provider receives those project instructions in the system prompt`, async () => {
    // Given
    const workspace = await realpath(
      await mkdtemp(join(tmpdir(), "keel-prompt-agents-")),
    );
    await writeFile(
      join(workspace, "AGENTS.md"),
      [
        "Use pnpm for every package script.",
        "Write BDD tests before changing production code.",
      ].join("\n"),
      "utf8",
    );

    try {
      // When
      const { result, bodies } = await withCapturedProviderRequests((baseUrl) =>
        runCli(["fix the bug"], {
          cwd: workspace,
          env: {
            DEEPSEEK_API_KEY: "test-key",
            DEEPSEEK_BASE_URL: baseUrl,
          },
        }),
      );

      // Then
      expect(result.exitCode).toBe(0);
      const content = firstSystemPrompt(bodies);
      expect(content).toContain("Project instructions from AGENTS.md");
      expect(content).toContain("Use pnpm for every package script.");
      expect(content).toContain(
        "Write BDD tests before changing production code.",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given root AGENTS instructions exist,
    When the user starts an interactive task,
    Then the first provider request receives those project instructions in the system prompt`, async () => {
    // Given
    const workspace = await realpath(
      await mkdtemp(join(tmpdir(), "keel-prompt-interactive-agents-")),
    );
    await writeFile(
      join(workspace, "AGENTS.md"),
      "Prefer focused BDD slices over broad refactors.\n",
      "utf8",
    );

    try {
      // When
      const { result: completed, bodies } = await withCapturedProviderRequests(
        async (baseUrl) => {
          const { child, result } = runCliProcess([], {
            cwd: workspace,
            stdin: "pipe",
            env: {
              KEEL_FORCE_INTERACTIVE: "1",
              DEEPSEEK_API_KEY: "test-key",
              DEEPSEEK_BASE_URL: baseUrl,
            },
          });
          if (child.stdin === null) {
            throw new Error("interactive test requires writable stdin");
          }
          child.stdin.write("fix the bug\n");
          child.stdin.end();
          return await result;
        },
      );

      // Then
      expect(completed.exitCode).toBe(0);
      const content = firstSystemPrompt(bodies);
      expect(content).toContain("Project instructions from AGENTS.md");
      expect(content).toContain(
        "Prefer focused BDD slices over broad refactors.",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
