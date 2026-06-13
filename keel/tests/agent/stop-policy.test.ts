import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { AgentEvent } from "../../src/agent/loop.ts";
import { runAgent, runAgentTurn } from "../../src/agent/loop.ts";
import type { AgentStopPolicy } from "../../src/agent/stop-policy.ts";
import {
  composeStopPolicies,
  costBudgetStopPolicy,
  maxTurnFallbackPolicy,
  repeatedToolCallPolicy,
} from "../../src/agent/stop-policy.ts";
import type { CostModel } from "../../src/core/cost.ts";
import type { LLMProvider, Message } from "../../src/llm/types.ts";
import {
  createFakeProvider,
  fakeEditResponse,
  fakeGrepResponse,
  fakeReadResponse,
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

const ZERO_USAGE = {
  inputTokens: 0,
  cachedInputTokens: 0,
  uncachedInputTokens: 0,
  outputTokens: 0,
};

describe("Agent Stopping", () => {
  test(`Given a caller limits the session to two tool rounds,
    When the task needs a third round,
    Then the run ends with a progress summary instead of an error and the extra change stays unapplied`, async () => {
    // Given
    const workspace = await createWorkspace();
    await writeFile(join(workspace, "a.txt"), "old a\n", "utf8");
    await writeFile(join(workspace, "b.txt"), "old b\n", "utf8");
    const provider = createFakeProvider([
      fakeEditResponse("a.txt", "old", "new"),
      fakeEditResponse("b.txt", "old", "new"),
      fakeResponse(
        "Round limit reached: a.txt is updated, b.txt still needs the same edit.",
      ),
    ]);

    try {
      // When
      const events = await collect(
        runAgent({
          workspace,
          provider,
          userMessage: "edit both files",
          systemPrompt: "You are helpful.",
          signal: freshSignal(),
          stopPolicy: maxTurnFallbackPolicy(2),
        }),
      );

      // Then
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("new a\n");
      expect(await readFile(join(workspace, "b.txt"), "utf8")).toBe("old b\n");
      expect(events).toContainEqual({
        type: "text",
        text: "Round limit reached: a.txt is updated, b.txt still needs the same edit.",
      });
      expect(events.at(-1)).toMatchObject({ type: "end" });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the session hits its round limit mid-task,
    When the agent asks the assistant to wrap up,
    Then the wrap-up request forbids tools at the protocol level and keeps the assistant's last words`, async () => {
    // Given
    const workspace = await createWorkspace();
    await writeFile(join(workspace, "a.txt"), "old a\n", "utf8");
    const wrapUpInstructions: string[] = [];
    const wrapUpToolChoices: (string | undefined)[] = [];
    const wrapUpTranscripts: (readonly Message[])[] = [];
    const provider: LLMProvider = {
      id: "records-wrap-up",
      async *stream(options) {
        const lastMessage = options.messages.at(-1);
        if (options.messages.length > 1 && lastMessage?.role === "user") {
          wrapUpInstructions.push(lastMessage.content);
          wrapUpToolChoices.push(options.toolChoice);
          wrapUpTranscripts.push(options.messages);
          yield { type: "text", text: "Stopping here." };
          yield { type: "stop", usage: ZERO_USAGE };
          return;
        }

        yield { type: "text", text: "Editing a.txt next." };
        yield {
          type: "tool_call",
          id: "edit_a",
          tool: "edit",
          path: "a.txt",
          oldString: "old",
          newString: "new",
        };
        yield { type: "stop", usage: ZERO_USAGE };
      },
    };

    try {
      // When
      await collect(
        runAgent({
          workspace,
          provider,
          userMessage: "edit the file",
          systemPrompt: "You are helpful.",
          signal: freshSignal(),
          stopPolicy: maxTurnFallbackPolicy(1),
        }),
      );

      // Then
      expect(wrapUpInstructions).toHaveLength(1);
      expect(wrapUpInstructions[0]).toContain("summarize");
      expect(wrapUpToolChoices).toEqual(["none"]);
      expect(wrapUpTranscripts[0]).toContainEqual({
        role: "assistant",
        content: "Editing a.txt next.",
      });
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("old a\n");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a wrap-up assistant that ignores instructions and requests another tool,
    When the round limit has already been reached,
    Then the run ends with a visible notice instead of silent empty success`, async () => {
    // Given
    const workspace = await createWorkspace();
    await writeFile(join(workspace, "a.txt"), "old a\n", "utf8");
    const provider = createFakeProvider([
      fakeEditResponse("a.txt", "old", "new"),
      fakeEditResponse("a.txt", "old a", "rogue"),
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
          stopPolicy: maxTurnFallbackPolicy(1),
        }),
      );

      // Then
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("old a\n");
      const textEvents = events.filter((event) => event.type === "text");
      expect(textEvents.map((event) => event.text).join("")).toContain(
        "round limit",
      );
      expect(
        events.filter((event) => event.type === "tool_start"),
      ).toHaveLength(0);
      expect(events.at(-1)).toMatchObject({ type: "end" });
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
        context.completedTurns >= 1
          ? { type: "stop", reason: "caller_rule" }
          : { type: "continue" },
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
        turns: 1,
        stopReason: "caller_rule",
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

  test(`Given an assistant stuck retrying the identical failing edit,
    When the default stop rules are in effect,
    Then the run ends cleanly after a few repeats and the file stays unchanged`, async () => {
    // Given
    const workspace = await createWorkspace();
    await writeFile(join(workspace, "note.txt"), "original\n", "utf8");
    const sameFailingEdit = fakeEditResponse("note.txt", "missing", "patched");
    const provider = createFakeProvider(
      Array.from({ length: 16 }, () => sameFailingEdit),
    );

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
      expect(await readFile(join(workspace, "note.txt"), "utf8")).toBe(
        "original\n",
      );
      const executedCalls = events.filter(
        (event) => event.type === "tool_start",
      );
      expect(executedCalls).toHaveLength(2);
      expect(events.at(-1)).toMatchObject({ type: "end" });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a long task that needs many different tool calls,
    When the assistant works through them one after another,
    Then the run completes normally with the final answer`, async () => {
    // Given
    const workspace = await createWorkspace();
    await writeFile(join(workspace, "a.txt"), "alpha\n", "utf8");
    await writeFile(join(workspace, "b.txt"), "beta\n", "utf8");
    const provider = createFakeProvider([
      fakeReadResponse("a.txt"),
      fakeReadResponse("b.txt"),
      fakeGrepResponse("alpha"),
      fakeGrepResponse("beta"),
      fakeReadResponse("a.txt", undefined, { limit: 1 }),
      fakeReadResponse("b.txt", undefined, { limit: 1 }),
      fakeResponse("All done."),
    ]);

    try {
      // When
      const events = await collect(
        runAgent({
          workspace,
          provider,
          userMessage: "inspect the workspace",
          systemPrompt: "You are helpful.",
          signal: freshSignal(),
        }),
      );

      // Then
      const executedCalls = events.filter(
        (event) => event.type === "tool_start",
      );
      expect(executedCalls).toHaveLength(6);
      expect(events).toContainEqual({ type: "text", text: "All done." });
      expect(events.at(-1)).toMatchObject({ type: "end" });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the repeated-call guard combined with a generous round limit,
    When the assistant keeps requesting the exact same read,
    Then the agent stops gracefully long before the round limit`, async () => {
    // Given
    const workspace = await createWorkspace();
    await writeFile(join(workspace, "a.txt"), "alpha\n", "utf8");
    const sameRead = fakeReadResponse("a.txt");
    const provider = createFakeProvider(
      Array.from({ length: 100 }, () => sameRead),
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
          stopPolicy: composeStopPolicies([
            repeatedToolCallPolicy(),
            maxTurnFallbackPolicy(100),
          ]),
        }),
      );

      // Then
      const executedCalls = events.filter(
        (event) => event.type === "tool_start",
      );
      expect(executedCalls).toHaveLength(2);
      expect(events.at(-1)).toMatchObject({ type: "end" });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a caller reuses one stop policy instance across two sessions,
    When the second session starts with the same read the first session repeated,
    Then leftover history from the first session does not stop the second`, async () => {
    // Given
    const workspace = await createWorkspace();
    await writeFile(join(workspace, "a.txt"), "alpha\n", "utf8");
    const sharedPolicy = repeatedToolCallPolicy();
    const sameRead = fakeReadResponse("a.txt");
    const firstProvider = createFakeProvider([
      sameRead,
      sameRead,
      fakeResponse("First task done."),
    ]);
    const secondProvider = createFakeProvider([
      sameRead,
      fakeResponse("Second task done."),
    ]);

    try {
      // When
      await collect(
        runAgent({
          workspace,
          provider: firstProvider,
          userMessage: "first task",
          systemPrompt: "You are helpful.",
          signal: freshSignal(),
          stopPolicy: sharedPolicy,
        }),
      );
      const secondEvents = await collect(
        runAgent({
          workspace,
          provider: secondProvider,
          userMessage: "second task",
          systemPrompt: "You are helpful.",
          signal: freshSignal(),
          stopPolicy: sharedPolicy,
        }),
      );

      // Then
      expect(secondEvents).toContainEqual({
        type: "text",
        text: "Second task done.",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given one interactive session has repeated tool calls in an earlier user turn,
    When the next user turn starts with the same tool call,
    Then repeated-call detection starts fresh for the new request`, async () => {
    // Given
    const workspace = await createWorkspace();
    await writeFile(join(workspace, "a.txt"), "alpha\n", "utf8");
    const messages: Message[] = [{ role: "user", content: "first task" }];
    const sameRead = fakeReadResponse("a.txt");
    const firstProvider = createFakeProvider([
      sameRead,
      sameRead,
      fakeResponse("First task done."),
    ]);
    const secondProvider = createFakeProvider([
      sameRead,
      fakeResponse("Second task done."),
    ]);

    try {
      // When
      await collect(
        runAgentTurn({
          workspace,
          provider: firstProvider,
          messages,
          systemPrompt: "You are helpful.",
          signal: freshSignal(),
          stopPolicy: repeatedToolCallPolicy(),
        }),
      );
      messages.push({ role: "user", content: "second task" });
      const secondEvents = await collect(
        runAgentTurn({
          workspace,
          provider: secondProvider,
          messages,
          systemPrompt: "You are helpful.",
          signal: freshSignal(),
          stopPolicy: repeatedToolCallPolicy(),
        }),
      );

      // Then
      expect(secondEvents).toContainEqual({
        type: "text",
        text: "Second task done.",
      });
      expect(secondEvents.at(-1)).toMatchObject({
        type: "end",
        stopReason: "completed",
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
