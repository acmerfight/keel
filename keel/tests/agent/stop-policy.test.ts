import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { AgentEvent } from "../../src/agent/loop.ts";
import { runAgent } from "../../src/agent/loop.ts";
import type { AgentStopPolicy } from "../../src/agent/stop-policy.ts";
import {
  composeStopPolicies,
  costBudgetStopPolicy,
  maxTurnFallbackPolicy,
} from "../../src/agent/stop-policy.ts";
import type { CostModel } from "../../src/core/cost.ts";
import type { LLMProvider } from "../../src/llm/types.ts";
import {
  createFakeProvider,
  fakeEditResponse,
  fakeResponse,
} from "../../src/testing/fake-provider.ts";

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

async function createWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "keel-stop-"));
}

const budgetModel: CostModel = {
  uncachedInputPerMillionTokens: 1,
  cachedInputPerMillionTokens: 0.5,
  outputPerMillionTokens: 2,
};

describe("Agent Stopping", () => {
  test(`Given a caller limits the session to two tool rounds,
    When the task needs a third round,
    Then the run fails with the action limit error before further changes are applied`, async () => {
    // Given
    const workspace = await createWorkspace();
    await writeFile(join(workspace, "a.txt"), "old a\n", "utf8");
    await writeFile(join(workspace, "b.txt"), "old b\n", "utf8");
    const provider = createFakeProvider([
      fakeEditResponse("a.txt", "old", "new"),
      fakeEditResponse("b.txt", "old", "new"),
      fakeResponse("Done."),
    ]);

    try {
      // When / Then
      await expect(
        collect(
          runAgent({
            workspace,
            provider,
            userMessage: "edit both files",
            systemPrompt: "You are helpful.",
            signal: freshSignal(),
            stopPolicy: maxTurnFallbackPolicy(2),
          }),
        ),
      ).rejects.toMatchObject({
        code: "agent_tool_call_limit_exceeded",
        message: "Agent exceeded tool call limit",
      });
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("new a\n");
      expect(await readFile(join(workspace, "b.txt"), "utf8")).toBe("old b\n");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a caller stop rule ends the session after the first round,
    When the assistant still requests another file change,
    Then the agent ends cleanly without applying that change`, async () => {
    // Given
    const workspace = await createWorkspace();
    await writeFile(join(workspace, "a.txt"), "old a\n", "utf8");
    const stopAfterFirstRound: AgentStopPolicy = {
      shouldStopAfterTurn: (context) =>
        context.completedTurns >= 1 ? { type: "stop" } : { type: "continue" },
    };
    const provider = createFakeProvider([
      fakeEditResponse("a.txt", "old", "new"),
      fakeResponse("Never reached."),
    ]);

    try {
      // When
      const events = await collect(
        runAgent({
          workspace,
          provider,
          userMessage: "edit the file",
          systemPrompt: "You are helpful.",
          signal: freshSignal(),
          stopPolicy: stopAfterFirstRound,
        }),
      );

      // Then
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("old a\n");
      expect(events).toContainEqual({
        type: "end",
        usage: {
          inputTokens: 0,
          cachedInputTokens: 0,
          uncachedInputTokens: 0,
          outputTokens: 0,
        },
      });
      expect(events.some((event) => event.type === "text")).toBe(false);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a cost budget combined with a generous round limit,
    When the first response already exceeds the budget,
    Then the agent stops before changing the file and reports the spend`, async () => {
    // Given
    const workspace = await createWorkspace();
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
          stopPolicy: composeStopPolicies([
            costBudgetStopPolicy(),
            maxTurnFallbackPolicy(100),
          ]),
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

  test(`Given a stop rule that never ends the session,
    When a response ends without completing,
    Then the terminal error still fails the run`, async () => {
    // Given
    const workspace = await createWorkspace();
    const neverStop: AgentStopPolicy = {
      shouldStopAfterTurn: () => ({ type: "continue" }),
    };
    const brokenProvider: LLMProvider = {
      id: "broken",
      async *stream() {
        yield { type: "text", text: "partial respon" };
      },
    };

    try {
      // When / Then
      await expect(
        collect(
          runAgent({
            workspace,
            provider: brokenProvider,
            userMessage: "hi",
            systemPrompt: "You are helpful.",
            signal: freshSignal(),
            stopPolicy: neverStop,
          }),
        ),
      ).rejects.toThrow("LLM stream ended without stop event");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
