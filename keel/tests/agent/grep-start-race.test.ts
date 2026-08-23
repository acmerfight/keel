import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { AgentEvent } from "../../src/agent/events.ts";
import type { LLMProvider } from "../../src/llm/types.ts";

const ZERO_USAGE = {
  inputTokens: 0,
  cachedInputTokens: 0,
  uncachedInputTokens: 0,
  outputTokens: 0,
};

class MockRipgrepProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn();
}

function mockRipgrepStartFailure(): void {
  vi.resetModules();

  vi.doMock("node:child_process", () => ({
    spawn: vi.fn(() => {
      const child = new MockRipgrepProcess();
      queueMicrotask(() => {
        child.emit(
          "error",
          Object.assign(new Error("spawn /test/rg ENOENT"), {
            code: "ENOENT",
          }),
        );
        child.stdout.end();
        child.stderr.end();
      });
      return child;
    }),
  }));
}

async function collect(
  source: AsyncIterable<AgentEvent>,
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of source) {
    events.push(event);
  }
  return events;
}

afterEach(() => {
  vi.doUnmock("node:child_process");
  vi.resetModules();
  vi.restoreAllMocks();
});

describe("Searching Code", () => {
  test.sequential(`Given workspace search cannot start,
    When the assistant tries grep,
    Then the agent returns recovery guidance to the model and continues`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-grep-agent-"));
    await writeFile(join(workspace, "app.ts"), "needle\n", "utf8");
    mockRipgrepStartFailure();
    const { runAgent } = await import("../../src/agent/loop.ts");
    const { defaultStopPolicy } = await import(
      "../../src/agent/stop-policy.ts"
    );

    let toolFeedback = "";
    let turn = 0;
    const provider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        turn++;
        if (turn === 1) {
          yield {
            type: "tool_call",
            id: "g1",
            tool: "grep",
            pattern: "needle",
          };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        toolFeedback =
          options.messages.findLast((m) => m.role === "tool")?.content ?? "";
        yield { type: "text", text: "I can inspect known files next." };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };

    try {
      // When
      const events = await collect(
        runAgent({
          workspace,
          provider,
          userMessage: "find needle",
          systemPrompt: "You are a helpful assistant.",
          signal: new AbortController().signal,
          bash: { kind: "trusted" },
          stopPolicy: defaultStopPolicy(),
        }),
      );

      // Then
      const text = events
        .filter((event) => event.type === "text")
        .map((event) => event.text)
        .join("");
      expect(text).toContain("I can inspect known files next.");
      expect(toolFeedback).toContain("Tool failed: grep failed");
      expect(toolFeedback).toContain("ripgrep could not start (ENOENT)");
      expect(toolFeedback).toContain("Recovery:");
      expect(toolFeedback).not.toContain("/test/rg");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
