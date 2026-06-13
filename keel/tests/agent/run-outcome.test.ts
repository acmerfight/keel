import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { AgentEvent } from "../../src/agent/loop.ts";
import { runAgent } from "../../src/agent/loop.ts";
import { maxTurnFallbackPolicy } from "../../src/agent/stop-policy.ts";
import type { CostModel } from "../../src/core/cost.ts";
import type { LLMProvider } from "../../src/llm/types.ts";
import {
  createFakeProvider,
  fakeEditResponse,
  fakeReadResponse,
  fakeResponse,
} from "../../src/testing/fake-provider.ts";

type EndEvent = Extract<AgentEvent, { readonly type: "end" }>;

async function collect(
  source: AsyncIterable<AgentEvent>,
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of source) {
    events.push(event);
  }
  return events;
}

function endEvent(events: readonly AgentEvent[]): EndEvent {
  const event = events.at(-1);
  if (event === undefined || event.type !== "end") {
    throw new Error("run did not finish with an end event");
  }
  return event;
}

function freshSignal(): AbortSignal {
  return new AbortController().signal;
}

async function createWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "keel-run-outcome-"));
}

const budgetModel: CostModel = {
  uncachedInputPerMillionTokens: 1,
  cachedInputPerMillionTokens: 0.5,
  outputPerMillionTokens: 2,
};

describe("Run Outcome Reporting", () => {
  test(`Given a task the assistant finishes with a plain answer,
    When the run ends,
    Then the session reports one model turn and a completed stop reason`, async () => {
    // Given
    const provider = createFakeProvider([fakeResponse("All done.")]);

    // When
    const events = await collect(
      runAgent({
        workspace: process.cwd(),
        provider,
        userMessage: "say hi",
        systemPrompt: "You are helpful.",
        signal: freshSignal(),
      }),
    );

    // Then
    expect(endEvent(events)).toMatchObject({
      turns: 1,
      stopReason: "completed",
    });
  });

  test(`Given a task that needs one tool round before the final answer,
    When the run ends,
    Then the session counts both model turns`, async () => {
    // Given
    const workspace = await createWorkspace();
    await writeFile(join(workspace, "note.txt"), "hello old\n", "utf8");
    const provider = createFakeProvider([
      fakeEditResponse("note.txt", "old", "new"),
      fakeResponse("Edited."),
    ]);

    try {
      // When
      const events = await collect(
        runAgent({
          workspace,
          provider,
          userMessage: "fix the note",
          systemPrompt: "You are helpful.",
          signal: freshSignal(),
        }),
      );

      // Then
      expect(endEvent(events)).toMatchObject({
        turns: 2,
        stopReason: "completed",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a session cost limit the first response already exceeds,
    When the agent stops,
    Then the stop reason names the cost budget`, async () => {
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
          costTracking: { model: budgetModel, maxCostUsd: 0.5 },
        }),
      );

      // Then
      expect(endEvent(events)).toMatchObject({
        turns: 1,
        stopReason: "cost_budget",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an assistant stuck repeating the identical tool call,
    When the default stop rules end the run,
    Then the stop reason names the repeated tool call`, async () => {
    // Given
    const workspace = await createWorkspace();
    await writeFile(join(workspace, "a.txt"), "alpha\n", "utf8");
    const sameRead = fakeReadResponse("a.txt");
    const provider = createFakeProvider(
      Array.from({ length: 16 }, () => sameRead),
    );

    try {
      // When
      const events = await collect(
        runAgent({
          workspace,
          provider,
          userMessage: "read the file forever",
          systemPrompt: "You are helpful.",
          signal: freshSignal(),
        }),
      );

      // Then
      expect(endEvent(events)).toMatchObject({
        stopReason: "repeated_tool_call",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the session hits its round limit mid-task,
    When the agent ends with a wrap-up summary,
    Then the stop reason names the turn limit and the wrap-up turn is counted`, async () => {
    // Given
    const workspace = await createWorkspace();
    await writeFile(join(workspace, "a.txt"), "old a\n", "utf8");
    const provider = createFakeProvider([
      fakeEditResponse("a.txt", "old", "new"),
      fakeEditResponse("a.txt", "new", "newer"),
      fakeResponse("Out of rounds: a.txt updated once, second change pending."),
    ]);

    try {
      // When
      const events = await collect(
        runAgent({
          workspace,
          provider,
          userMessage: "edit twice",
          systemPrompt: "You are helpful.",
          signal: freshSignal(),
          stopPolicy: maxTurnFallbackPolicy(2),
        }),
      );

      // Then
      expect(endEvent(events)).toMatchObject({
        turns: 3,
        stopReason: "turn_limit",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
