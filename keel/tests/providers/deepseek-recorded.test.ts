import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { Server } from "node:net";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { createDeepseekProvider } from "../../src/llm/providers/deepseek.ts";
import type { LLMEvent } from "../../src/llm/types.ts";

const FIXTURE_DIR = join(import.meta.dirname, "../fixtures/deepseek");

async function collect(stream: AsyncIterable<LLMEvent>): Promise<LLMEvent[]> {
  const events: LLMEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

function freshSignal(): AbortSignal {
  return new AbortController().signal;
}

function getPort(server: Server): number {
  const addr = server.address();
  if (addr === null || typeof addr === "string") {
    throw new Error("Server not listening on a TCP port");
  }
  return addr.port;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function withFixtureServer(
  fixtureName: string,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const fixture = await readFile(join(FIXTURE_DIR, fixtureName), "utf8");
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
      res.end(fixture);
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  try {
    await run(`http://127.0.0.1:${getPort(server)}`);
  } finally {
    await close(server);
  }
}

describe("DeepSeek Recorded Fixtures", () => {
  test(`Given a recorded DeepSeek text stream,
    When provider parses the fixture,
    Then text and usage are emitted`, async () => {
    await withFixtureServer("text-stream.sse", async (baseUrl) => {
      // Given
      const provider = createDeepseekProvider({
        apiKey: "test-key",
        baseUrl,
        model: "deepseek-v4-flash",
      });

      // When
      const events = await collect(
        provider.stream({
          systemPrompt: "You are helpful.",
          messages: [{ role: "user", content: "recorded text fixture" }],
          signal: freshSignal(),
        }),
      );

      // Then
      const textEvents = events.filter((event) => event.type === "text");
      expect(textEvents.map((event) => event.text).join("")).toBe(
        "Recorded DeepSeek text fixture.",
      );
      expect(events.at(-1)).toEqual({
        type: "stop",
        reason: "stop",
        usage: {
          inputTokens: 19,
          cachedInputTokens: 0,
          uncachedInputTokens: 19,
          outputTokens: 34,
        },
      });
    });
  });

  test(`Given a recorded DeepSeek edit tool call stream,
    When provider parses the fixture,
    Then the edit tool call and usage are emitted`, async () => {
    await withFixtureServer("edit-tool-call.sse", async (baseUrl) => {
      // Given
      const provider = createDeepseekProvider({
        apiKey: "test-key",
        baseUrl,
        model: "deepseek-v4-flash",
      });

      // When
      const events = await collect(
        provider.stream({
          systemPrompt: "You are helpful.",
          messages: [{ role: "user", content: "recorded edit fixture" }],
          signal: freshSignal(),
        }),
      );

      // Then
      expect(events).toEqual([
        {
          type: "tool_call",
          id: "call_00_stPO5gzpBGYPHQ4hSeAI6685",
          tool: "edit",
          path: "note.txt",
          edits: [{ oldText: "old", newText: "new" }],
        },
        {
          type: "stop",
          reason: "stop",
          usage: {
            inputTokens: 355,
            cachedInputTokens: 0,
            uncachedInputTokens: 355,
            outputTokens: 100,
          },
        },
      ]);
    });
  });
});
