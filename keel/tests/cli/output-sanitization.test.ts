import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { runCli } from "../../src/testing/cli-harness.ts";

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

function sseTextReply(text: string): string {
  return [
    `data: ${JSON.stringify({
      choices: [{ delta: { content: text } }],
    })}\n\n`,
    `data: ${JSON.stringify({
      choices: [{ delta: {}, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 10,
        prompt_cache_hit_tokens: 0,
        prompt_cache_miss_tokens: 10,
        completion_tokens: 5,
      },
    })}\n\n`,
    "data: [DONE]\n\n",
  ].join("");
}

function createTextReplyServer(text: string): Server {
  return createServer((req, res) => {
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
      res.write(sseTextReply(text));
      res.end();
    });
  });
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: asserting the absence of control characters is the point
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;

describe("CLI Output Sanitization", () => {
  test(`Given the assistant reply carries terminal control sequences,
    When user runs the CLI,
    Then the reply is shown with visible escapes and the terminal receives no control bytes`, async () => {
    // Given — clear screen (CSI), clipboard write (OSC 52 + BEL), raw C1 CSI
    const reply =
      "Wipe: \u001b[2J\nClip: \u001b]52;c;aGk=\u0007\nCsi: \u009b31m done";
    const server = createTextReplyServer(reply);
    await listen(server);

    try {
      // When
      const result = await runCli(["summarize the workspace"], {
        env: {
          DEEPSEEK_API_KEY: "test-key",
          DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
        },
      });

      // Then
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(
        "Wipe: \\x1b[2J\nClip: \\x1b]52;c;aGk=\\x07\nCsi: \\x9b31m done\n",
      );
      expect(result.stdout).not.toMatch(CONTROL_CHARS);
    } finally {
      await close(server);
    }
  });

  test(`Given the assistant reply spans multiple lines,
    When user runs the CLI,
    Then line breaks and tabs in the reply are preserved as-is`, async () => {
    // Given
    const reply = "first line\n\tindented second line\nthird line";
    const server = createTextReplyServer(reply);
    await listen(server);

    try {
      // When
      const result = await runCli(["summarize the workspace"], {
        env: {
          DEEPSEEK_API_KEY: "test-key",
          DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
        },
      });

      // Then
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(
        "first line\n\tindented second line\nthird line\n",
      );
    } finally {
      await close(server);
    }
  });

  test(`Given a tool call path hides characters with bidi and zero-width codepoints,
    When user runs the CLI,
    Then the progress line shows them as visible unicode escapes`, async () => {
    // Given — U+202E reverses display order, U+200B is invisible
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-sanitize-"));
    const trickyPath = "note\u202etxt.kcab\u200b.txt";

    try {
      // When
      const result = await runCli([`replace old with new in ${trickyPath}`], {
        cwd: workspace,
        env: { KEEL_PROVIDER: "fake" },
      });

      // Then
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain(
        "Tool: read note\\u{202e}txt.kcab\\u{200b}.txt",
      );
      expect(result.stderr).not.toContain("\u202e");
      expect(result.stderr).not.toContain("\u200b");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a tool call path hides invisible directional marks,
    When user runs the CLI,
    Then the progress line shows them as visible unicode escapes`, async () => {
    // Given — U+200F (RLM) and U+061C (ALM) are invisible UAX #9 marks
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-sanitize-"));
    const trickyPath = "note\u200fmark\u061c.txt";

    try {
      // When
      const result = await runCli([`replace old with new in ${trickyPath}`], {
        cwd: workspace,
        env: { KEEL_PROVIDER: "fake" },
      });

      // Then
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain(
        "Tool: read note\\u{200f}mark\\u{61c}.txt",
      );
      expect(result.stderr).not.toContain("\u200f");
      expect(result.stderr).not.toContain("\u061c");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
