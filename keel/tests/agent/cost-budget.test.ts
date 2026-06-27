import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { AgentEvent } from "../../src/agent/events.ts";
import { runAgent } from "../../src/agent/loop.ts";
import { defaultStopPolicy } from "../../src/agent/stop-policy.ts";
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
  type: "fixed",
  uncachedInputPerMillionTokens: 1,
  cachedInputPerMillionTokens: 0.5,
  outputPerMillionTokens: 2,
};

const tieredBudgetModel: CostModel = {
  type: "input-token-tiers",
  tiers: [
    {
      startsAboveInputTokens: 0,
      uncachedInputPerMillionTokens: 0.4,
      cachedInputPerMillionTokens: 0.04,
      outputPerMillionTokens: 1.6,
    },
    {
      startsAboveInputTokens: 256_000,
      uncachedInputPerMillionTokens: 1.2,
      cachedInputPerMillionTokens: 0.12,
      outputPerMillionTokens: 4.8,
    },
  ],
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
          edits: [{ oldText: "old", newText: "new" }],
        };
        yield {
          type: "stop",
          reason: "stop",
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
          allowBash: false,
          stopPolicy: defaultStopPolicy(),
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
        turns: 1,
        stopReason: "cost_budget",
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
            id: "read_note",
            tool: "read",
            path: "note.txt",
          };
          yield {
            type: "stop",
            reason: "stop",
            usage: {
              inputTokens: 0,
              cachedInputTokens: 0,
              uncachedInputTokens: 0,
              outputTokens: 0,
            },
          };
          return;
        }

        if (turn === 1) {
          turn++;
          yield {
            type: "tool_call",
            id: "edit_note",
            tool: "edit",
            path: "note.txt",
            edits: [{ oldText: "old", newText: "new" }],
          };
          yield {
            type: "stop",
            reason: "stop",
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
          reason: "stop",
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
          allowBash: false,
          stopPolicy: defaultStopPolicy(),
        }),
      );

      // Then
      expect(await readFile(join(workspace, "note.txt"), "utf8")).toBe(
        "new value\n",
      );
      expect(events).toContainEqual({ type: "text", text: "Done." });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a tiered model request crosses the higher input-token tier,
    When the high-tier cost exceeds the session budget,
    Then the agent stops before changing files`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cost-budget-"));
    await writeFile(join(workspace, "note.txt"), "old value\n", "utf8");
    const provider: LLMProvider = {
      id: "high-tier-tool-call",
      async *stream() {
        yield {
          type: "tool_call",
          id: "edit_note",
          tool: "edit",
          path: "note.txt",
          edits: [{ oldText: "old", newText: "new" }],
        };
        yield {
          type: "stop",
          reason: "stop",
          usage: {
            inputTokens: 300_000,
            cachedInputTokens: 0,
            uncachedInputTokens: 300_000,
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
          allowBash: false,
          stopPolicy: defaultStopPolicy(),
          costTracking: {
            model: tieredBudgetModel,
            maxCostUsd: 0.2,
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
          inputTokens: 300_000,
          cachedInputTokens: 0,
          uncachedInputTokens: 300_000,
          outputTokens: 0,
        },
        turns: 1,
        stopReason: "cost_budget",
        cost: {
          spentUsd: 0.36,
          maxUsd: 0.2,
          budgetExceeded: true,
        },
      });
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
          edits: [{ oldText: "old", newText: "first" }],
        };
        yield {
          type: "tool_call",
          id: "second_edit",
          tool: "edit",
          path: "note.txt",
          edits: [{ oldText: "old", newText: "second" }],
        };
        yield {
          type: "stop",
          reason: "stop",
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
          allowBash: false,
          stopPolicy: defaultStopPolicy(),
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
        turns: 1,
        stopReason: "cost_budget",
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
