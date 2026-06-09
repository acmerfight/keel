import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { AgentEvent } from "../../src/agent/loop.ts";
import { runAgent } from "../../src/agent/loop.ts";
import type { CostModel } from "../../src/core/cost.ts";
import type { LLMProvider } from "../../src/llm/types.ts";

async function collect(
  source: AsyncIterable<AgentEvent>,
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of source) {
    events.push(event);
  }
  return events;
}

function freshSignal(): AbortSignal {
  return new AbortController().signal;
}

const budgetModel: CostModel = {
  uncachedInputPerMillionTokens: 1,
  cachedInputPerMillionTokens: 0.5,
  outputPerMillionTokens: 2,
};

describe("Cost Budget", () => {
  test(`Given a session cost limit,
    When the projected session spend exceeds that limit before a file change,
    Then the agent stops and reports the spent cost without changing the file`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cost-budget-"));
    await writeFile(join(workspace, "note.txt"), "old value\n", "utf8");
    const provider: LLMProvider = {
      id: "expensive-tool-call",
      async *stream() {
        yield {
          type: "tool_call",
          id: "edit_note",
          tool: "edit",
          path: "note.txt",
          oldString: "old",
          newString: "new",
        };
        yield {
          type: "stop",
          usage: {
            inputTokens: 1_000_000,
            cachedInputTokens: 0,
            uncachedInputTokens: 1_000_000,
            outputTokens: 0,
          },
        };
      },
    };

    try {
      // When
      const events = await collect(
        runAgent({
          workspace,
          provider,
          userMessage: "edit note",
          systemPrompt: "You are helpful.",
          signal: freshSignal(),
          costTracking: {
            model: budgetModel,
            maxCostUsd: 0.5,
          },
        }),
      );

      // Then
      expect(await readFile(join(workspace, "note.txt"), "utf8")).toBe(
        "old value\n",
      );
      expect(events).toContainEqual({
        type: "end",
        usage: {
          inputTokens: 1_000_000,
          cachedInputTokens: 0,
          uncachedInputTokens: 1_000_000,
          outputTokens: 0,
        },
        cost: {
          spentUsd: 1,
          maxUsd: 0.5,
          budgetExceeded: true,
        },
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given no session cost limit is configured,
    When an expensive response requests a file change,
    Then the agent still applies the change`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cost-budget-"));
    await writeFile(join(workspace, "note.txt"), "old value\n", "utf8");
    let turn = 0;
    const provider: LLMProvider = {
      id: "unlimited-tool-call",
      async *stream() {
        if (turn === 0) {
          turn++;
          yield {
            type: "tool_call",
            id: "edit_note",
            tool: "edit",
            path: "note.txt",
            oldString: "old",
            newString: "new",
          };
          yield {
            type: "stop",
            usage: {
              inputTokens: 1_000_000,
              cachedInputTokens: 0,
              uncachedInputTokens: 1_000_000,
              outputTokens: 0,
            },
          };
          return;
        }
        yield { type: "text", text: "Done." };
        yield {
          type: "stop",
          usage: {
            inputTokens: 0,
            cachedInputTokens: 0,
            uncachedInputTokens: 0,
            outputTokens: 0,
          },
        };
      },
    };

    try {
      // When
      const events = await collect(
        runAgent({
          workspace,
          provider,
          userMessage: "edit note",
          systemPrompt: "You are helpful.",
          signal: freshSignal(),
        }),
      );

      // Then
      expect(await readFile(join(workspace, "note.txt"), "utf8")).toBe(
        "new value\n",
      );
      expect(events).toContainEqual({ type: "text", text: "Edited note.txt" });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a session cost limit and an expensive response proposes multiple file changes,
    When the response already exceeds the budget,
    Then the agent stops before validating or applying the changes`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cost-budget-"));
    await writeFile(join(workspace, "note.txt"), "old value\n", "utf8");
    const provider: LLMProvider = {
      id: "expensive-multiple-tool-calls",
      async *stream() {
        yield {
          type: "tool_call",
          id: "first_edit",
          tool: "edit",
          path: "note.txt",
          oldString: "old",
          newString: "first",
        };
        yield {
          type: "tool_call",
          id: "second_edit",
          tool: "edit",
          path: "note.txt",
          oldString: "old",
          newString: "second",
        };
        yield {
          type: "stop",
          usage: {
            inputTokens: 1_000_000,
            cachedInputTokens: 0,
            uncachedInputTokens: 1_000_000,
            outputTokens: 0,
          },
        };
      },
    };

    try {
      // When
      const events = await collect(
        runAgent({
          workspace,
          provider,
          userMessage: "edit note twice",
          systemPrompt: "You are helpful.",
          signal: freshSignal(),
          costTracking: {
            model: budgetModel,
            maxCostUsd: 0.5,
          },
        }),
      );

      // Then
      expect(await readFile(join(workspace, "note.txt"), "utf8")).toBe(
        "old value\n",
      );
      expect(events).toContainEqual({
        type: "end",
        usage: {
          inputTokens: 1_000_000,
          cachedInputTokens: 0,
          uncachedInputTokens: 1_000_000,
          outputTokens: 0,
        },
        cost: {
          spentUsd: 1,
          maxUsd: 0.5,
          budgetExceeded: true,
        },
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
