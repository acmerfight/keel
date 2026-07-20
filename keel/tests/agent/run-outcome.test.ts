import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { AgentEvent } from "../../src/agent/events.ts";
import { runAgent, runAgentTurn } from "../../src/agent/loop.ts";
import {
  defaultStopPolicy,
  maxTurnFallbackPolicy,
} from "../../src/agent/stop-policy.ts";
import type { CostModel } from "../../src/core/cost.ts";
import {
  createFakeProvider,
  fakeResponse,
  fakeToolResponse,
} from "../../src/llm/providers/fake.ts";
import type { LLMProvider, Message } from "../../src/llm/types.ts";

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
        bash: { kind: "disabled" },
        stopPolicy: defaultStopPolicy(),
      }),
    );

    // Then
    expect(endEvent(events)).toMatchObject({
      turns: 1,
      stopReason: "completed",
    });
  });

  test(`Given the provider stops after hitting its output token limit,
    When the run ends with partial text,
    Then the session reports a provider length stop reason`, async () => {
    // Given
    const provider: LLMProvider = {
      id: "length-limited",
      async *stream() {
        yield { type: "text", text: "Partial answer." };
        yield {
          type: "stop",
          reason: "length",
          usage: {
            inputTokens: 10,
            cachedInputTokens: 0,
            uncachedInputTokens: 10,
            outputTokens: 4,
          },
        };
      },
    };

    // When
    const events = await collect(
      runAgent({
        workspace: process.cwd(),
        provider,
        userMessage: "write a long answer",
        systemPrompt: "You are helpful.",
        signal: freshSignal(),
        bash: { kind: "disabled" },
        stopPolicy: defaultStopPolicy(),
      }),
    );

    // Then
    expect(events).toContainEqual({ type: "text", text: "Partial answer." });
    expect(endEvent(events)).toMatchObject({
      turns: 1,
      stopReason: "provider_length",
    });
  });

  test(`Given the assistant output is truncated while requesting a tool,
    When the run consumes the turn,
    Then the run fails before executing the tool`, async () => {
    // Given
    const workspace = await createWorkspace();
    const createdPath = join(workspace, "created.txt");
    let request = 0;
    const provider: LLMProvider = {
      id: "truncated-tool-request",
      async *stream() {
        request++;
        if (request === 1) {
          yield {
            type: "tool_call",
            id: "write_file",
            tool: "write",
            path: "created.txt",
            content: "created\n",
          };
          yield {
            type: "stop",
            reason: "length",
            usage: {
              inputTokens: 10,
              cachedInputTokens: 0,
              uncachedInputTokens: 10,
              outputTokens: 4,
            },
          };
          return;
        }
        yield { type: "text", text: "Done." };
        yield {
          type: "stop",
          reason: "stop",
          usage: {
            inputTokens: 1,
            cachedInputTokens: 0,
            uncachedInputTokens: 1,
            outputTokens: 1,
          },
        };
      },
    };

    try {
      // When / Then
      await expect(
        collect(
          runAgent({
            workspace,
            provider,
            userMessage: "fix the note",
            systemPrompt: "You are helpful.",
            signal: freshSignal(),
            bash: { kind: "disabled" },
            stopPolicy: defaultStopPolicy(),
          }),
        ),
      ).rejects.toMatchObject({
        code: "provider_protocol_error",
        message: "LLM stream stopped with length after tool calls",
      });
      await expect(readFile(createdPath, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a task that needs one tool round before the final answer,
    When the run ends,
    Then the session counts both model turns`, async () => {
    // Given
    const workspace = await createWorkspace();
    await writeFile(join(workspace, "note.txt"), "hello old\n", "utf8");
    const provider = createFakeProvider([
      fakeToolResponse("edit", {
        path: "note.txt",
        edits: [{ oldText: "old", newText: "new" }],
      }),
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
          bash: { kind: "disabled" },
          stopPolicy: defaultStopPolicy(),
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
      estimateInputTokens: () => 1,
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
          bash: { kind: "disabled" },
          stopPolicy: defaultStopPolicy(),
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

  test(`Given a tiered model handles multiple low-tier provider requests,
    When the run reports its final cost,
    Then each request is priced by its own input-token tier`, async () => {
    // Given
    const workspace = await createWorkspace();
    await writeFile(join(workspace, "note.txt"), "hello\n", "utf8");
    let turn = 0;
    const provider: LLMProvider = {
      id: "tiered-multi-request-cost",
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
              inputTokens: 200_000,
              cachedInputTokens: 0,
              uncachedInputTokens: 200_000,
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
            inputTokens: 100_000,
            cachedInputTokens: 0,
            uncachedInputTokens: 100_000,
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
          userMessage: "read the note",
          systemPrompt: "You are helpful.",
          signal: freshSignal(),
          bash: { kind: "disabled" },
          stopPolicy: defaultStopPolicy(),
          costTracking: { model: tieredBudgetModel },
        }),
      );

      // Then
      const finalEvent = endEvent(events);
      expect(finalEvent.usage.inputTokens).toBe(300_000);
      expect(finalEvent.cost?.spentUsd).toBeCloseTo(0.12);
      expect(finalEvent.cost?.budgetLimited).toBe(false);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given proactive compaction adds a low-tier provider request,
    When the run reports its final cost,
    Then the compaction request is included without using aggregate tier selection`, async () => {
    // Given
    const messages: Message[] = [
      { role: "user", content: "Earlier task context ".repeat(2_000) },
      { role: "assistant", content: "Earlier progress.", toolCalls: [] },
      { role: "user", content: "Continue now." },
    ];
    let request = 0;
    const provider: LLMProvider = {
      id: "tiered-compaction-cost",
      async *stream() {
        request++;
        if (request === 1) {
          yield { type: "text", text: "Compacted earlier work." };
          yield {
            type: "stop",
            reason: "stop",
            usage: {
              inputTokens: 200_000,
              cachedInputTokens: 0,
              uncachedInputTokens: 200_000,
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
            inputTokens: 100_000,
            cachedInputTokens: 0,
            uncachedInputTokens: 100_000,
            outputTokens: 0,
          },
        };
      },
    };

    // When
    const events = await collect(
      runAgentTurn({
        workspace: process.cwd(),
        provider,
        messages,
        systemPrompt: "You are helpful.",
        signal: freshSignal(),
        bash: { kind: "disabled" },
        stopPolicy: defaultStopPolicy(),
        costTracking: { model: tieredBudgetModel },
        contextCompaction: {
          contextWindowTokens: 100,
          reserveTokens: 0,
          keepRecentTokens: 1,
        },
      }),
    );

    // Then
    expect(events).toContainEqual(
      expect.objectContaining({ type: "context_compacted" }),
    );
    const finalEvent = endEvent(events);
    expect(finalEvent.usage.inputTokens).toBe(300_000);
    expect(finalEvent.cost?.spentUsd).toBeCloseTo(0.12);
    expect(finalEvent.cost?.budgetLimited).toBe(false);
  });

  test(`Given turn-limit wrap-up adds a low-tier provider request,
    When the run reports its final cost,
    Then the wrap-up request is included without using aggregate tier selection`, async () => {
    // Given
    const workspace = await createWorkspace();
    await writeFile(join(workspace, "note.txt"), "hello\n", "utf8");
    let request = 0;
    const provider: LLMProvider = {
      id: "tiered-wrap-up-cost",
      async *stream(options) {
        request++;
        if (request === 1) {
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
              inputTokens: 200_000,
              cachedInputTokens: 0,
              uncachedInputTokens: 200_000,
              outputTokens: 0,
            },
          };
          return;
        }
        expect(options.toolExposure?.kind).toBe("none");
        yield { type: "text", text: "Need to stop before reading note.txt." };
        yield {
          type: "stop",
          reason: "stop",
          usage: {
            inputTokens: 100_000,
            cachedInputTokens: 0,
            uncachedInputTokens: 100_000,
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
          userMessage: "read the note",
          systemPrompt: "You are helpful.",
          signal: freshSignal(),
          bash: { kind: "disabled" },
          stopPolicy: maxTurnFallbackPolicy(1),
          costTracking: { model: tieredBudgetModel },
        }),
      );

      // Then
      const finalEvent = endEvent(events);
      expect(finalEvent.turns).toBe(1);
      expect(finalEvent.stopReason).toBe("turn_limit");
      expect(finalEvent.usage.inputTokens).toBe(300_000);
      expect(finalEvent.cost?.spentUsd).toBeCloseTo(0.12);
      expect(finalEvent.cost?.budgetLimited).toBe(false);
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
    const sameRead = fakeToolResponse("read", { path: "a.txt" });
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
          bash: { kind: "disabled" },
          stopPolicy: defaultStopPolicy(),
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
    Then the stop reason names the turn limit without counting wrap-up as an agent-loop turn`, async () => {
    // Given
    const workspace = await createWorkspace();
    await writeFile(join(workspace, "a.txt"), "old a\n", "utf8");
    const provider = createFakeProvider([
      fakeToolResponse("edit", {
        path: "a.txt",
        edits: [{ oldText: "old", newText: "new" }],
      }),
      fakeToolResponse("edit", {
        path: "a.txt",
        edits: [{ oldText: "new", newText: "newer" }],
      }),
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
          bash: { kind: "disabled" },
          stopPolicy: maxTurnFallbackPolicy(2),
        }),
      );

      // Then
      expect(endEvent(events)).toMatchObject({
        turns: 2,
        stopReason: "turn_limit",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
