import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { AgentEvent } from "../../src/agent/events.ts";
import { runAgent, runAgentTurn } from "../../src/agent/loop.ts";
import type { AgentStopPolicy } from "../../src/agent/stop-policy.ts";
import {
  composeStopPolicies,
  costBudgetStopPolicy,
  defaultStopPolicy,
  maxTurnFallbackPolicy,
  repeatedToolCallPolicy,
} from "../../src/agent/stop-policy.ts";
import type { CostModel } from "../../src/core/cost.ts";
import {
  createFakeProvider,
  fakeResponse,
  fakeToolResponse,
} from "../../src/llm/providers/fake.ts";
import type { LLMProvider, Message, ToolCall } from "../../src/llm/types.ts";
import { toolCallFromParsedArguments } from "../../src/tools/registry.ts";

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
  type: "fixed",
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

function wrapUpBoundaryProvider(summary: string): LLMProvider {
  return {
    id: "wrap-up-boundary",
    async *stream(options) {
      const lastMessage = options.messages.at(-1);
      if (
        lastMessage?.role === "user" &&
        options.toolExposure?.kind === "none"
      ) {
        yield { type: "text", text: summary };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
        return;
      }

      yield { type: "text", text: "Editing a.txt next." };
      yield {
        type: "tool_call",
        id: "edit_a",
        tool: "edit",
        path: "a.txt",
        edits: [{ oldText: "old", newText: "new" }],
      };
      yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
    },
  };
}

describe("Agent Stopping", () => {
  test(`Given a caller limits the session to two tool rounds,
    When the task needs a third round,
    Then the run ends with a progress summary instead of an error and the extra change stays unapplied`, async () => {
    // Given
    const workspace = await createWorkspace();
    await writeFile(join(workspace, "a.txt"), "old a\n", "utf8");
    await writeFile(join(workspace, "b.txt"), "old b\n", "utf8");
    const provider = createFakeProvider([
      fakeToolResponse("read", {
        path: "a.txt",
      }),
      fakeToolResponse("edit", {
        path: "a.txt",
        edits: [{ oldText: "old", newText: "new" }],
      }),
      fakeToolResponse("edit", {
        path: "b.txt",
        edits: [{ oldText: "old", newText: "new" }],
      }),
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
          bash: { kind: "disabled" },
          stopPolicy: maxTurnFallbackPolicy(3),
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
          wrapUpToolChoices.push(options.toolExposure?.kind);
          wrapUpTranscripts.push(options.messages);
          yield { type: "text", text: "Stopping here." };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }

        yield { type: "text", text: "Editing a.txt next." };
        yield {
          type: "tool_call",
          id: "edit_a",
          tool: "edit",
          path: "a.txt",
          edits: [{ oldText: "old", newText: "new" }],
        };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
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
          bash: { kind: "disabled" },
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
        toolCalls: [],
      });
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("old a\n");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given streamed assistant text before the round limit summary,
    When the agent emits the wrap-up response,
    Then the streamed text and stored reply keep a readable boundary`, async () => {
    // Given
    const workspace = await createWorkspace();
    await writeFile(join(workspace, "a.txt"), "old a\n", "utf8");
    const messages: Message[] = [
      { role: "user", content: "edit the file and explain progress" },
    ];
    const provider = wrapUpBoundaryProvider("Stopping here.");

    try {
      // When
      const events = await collect(
        runAgentTurn({
          workspace,
          provider,
          messages,
          systemPrompt: "You are helpful.",
          signal: freshSignal(),
          bash: { kind: "disabled" },
          stopPolicy: maxTurnFallbackPolicy(1),
        }),
      );

      // Then
      const textEvents = events.filter((event) => event.type === "text");
      expect(textEvents.map((event) => event.text).join("")).toBe(
        "Editing a.txt next.\nStopping here.",
      );
      expect(messages.at(-1)).toEqual({
        role: "assistant",
        content: "Editing a.txt next.\nStopping here.",
        toolCalls: [],
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a round limit summary that already starts on a new line,
    When the agent emits the wrap-up response,
    Then it does not duplicate the readable boundary`, async () => {
    // Given
    const workspace = await createWorkspace();
    await writeFile(join(workspace, "a.txt"), "old a\n", "utf8");
    const messages: Message[] = [
      { role: "user", content: "edit the file and explain progress" },
    ];
    const provider = wrapUpBoundaryProvider("\nStopping here.");

    try {
      // When
      const events = await collect(
        runAgentTurn({
          workspace,
          provider,
          messages,
          systemPrompt: "You are helpful.",
          signal: freshSignal(),
          bash: { kind: "disabled" },
          stopPolicy: maxTurnFallbackPolicy(1),
        }),
      );

      // Then
      const textEvents = events.filter((event) => event.type === "text");
      expect(textEvents.map((event) => event.text).join("")).toBe(
        "Editing a.txt next.\nStopping here.",
      );
      expect(messages.at(-1)).toEqual({
        role: "assistant",
        content: "Editing a.txt next.\nStopping here.",
        toolCalls: [],
      });
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
      fakeToolResponse("edit", {
        path: "a.txt",
        edits: [{ oldText: "old", newText: "new" }],
      }),
      fakeToolResponse("edit", {
        path: "a.txt",
        edits: [{ oldText: "old a", newText: "rogue" }],
      }),
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
          bash: { kind: "disabled" },
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
      fakeToolResponse("edit", {
        path: "a.txt",
        edits: [{ oldText: "old", newText: "new" }],
      }),
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
          bash: { kind: "disabled" },
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
          budget: {
            kind: "budget_limited",
            maxUsd: 0.5,
            overshootUsd: 0.5,
          },
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
    const sameFailingEdit = fakeToolResponse("edit", {
      path: "note.txt",
      edits: [{ oldText: "missing", newText: "patched" }],
    });
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
          bash: { kind: "disabled" },
          stopPolicy: defaultStopPolicy(),
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
      fakeToolResponse("read", { path: "a.txt" }),
      fakeToolResponse("read", { path: "b.txt" }),
      fakeToolResponse("grep", { pattern: "alpha" }),
      fakeToolResponse("grep", { pattern: "beta" }),
      fakeToolResponse("read", { path: "a.txt", limit: 1 }),
      fakeToolResponse("read", { path: "b.txt", limit: 1 }),
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
          bash: { kind: "disabled" },
          stopPolicy: defaultStopPolicy(),
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
    const sameRead = fakeToolResponse("read", { path: "a.txt" });
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
          bash: { kind: "disabled" },
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

  test(`Given one turn contains three calls to the same MCP tool with distinct nested arguments,
    When the repeated-call guard compares the typed calls,
    Then it lets the whole batch proceed`, () => {
    // Given
    const reference = {
      kind: "mcp",
      serverId: "catalog",
      serverOrigin: "https://catalog.example",
      rawToolName: "search",
      configurationDigest: "a".repeat(64),
      catalogGeneration: `catalog:${"b".repeat(64)}`,
      descriptorDigest: "c".repeat(64),
    } as const;
    const toolCalls = [
      {
        kind: "mcp",
        id: "remote_alpha",
        tool: "mcp__catalog__search",
        reference,
        arguments: { query: "alpha", filters: { year: 2024 } },
      },
      {
        kind: "mcp",
        id: "remote_beta",
        tool: "mcp__catalog__search",
        reference,
        arguments: { query: "beta", filters: { year: 2025 } },
      },
      {
        kind: "mcp",
        id: "remote_gamma",
        tool: "mcp__catalog__search",
        reference,
        arguments: { query: "gamma", filters: { year: 2026 } },
      },
    ] satisfies readonly ToolCall[];

    // When
    const decision = repeatedToolCallPolicy().shouldStopAfterTurn({
      completedTurns: 1,
      priorToolCalls: [],
      toolCalls,
    });

    // Then
    expect(decision).toEqual({ type: "continue" });
  });

  test(`Given repeated MCP calls use equivalent nested arguments with different key insertion order,
    When the repeated-call guard canonicalizes the typed calls,
    Then it still recognizes the repeated-call streak`, () => {
    // Given
    const reference = {
      kind: "mcp",
      serverId: "catalog",
      serverOrigin: "https://catalog.example",
      rawToolName: "search",
      configurationDigest: "a".repeat(64),
      catalogGeneration: `catalog:${"b".repeat(64)}`,
      descriptorDigest: "c".repeat(64),
    } as const;
    const toolCalls = [
      {
        kind: "mcp",
        id: "remote_1",
        tool: "mcp__catalog__search",
        reference,
        arguments: { filters: { type: "paper", year: 2026 } },
      },
      {
        kind: "mcp",
        id: "remote_2",
        tool: "mcp__catalog__search",
        reference,
        arguments: { filters: { year: 2026, type: "paper" } },
      },
      {
        kind: "mcp",
        id: "remote_3",
        tool: "mcp__catalog__search",
        reference,
        arguments: { filters: { type: "paper", year: 2026 } },
      },
    ] satisfies readonly ToolCall[];

    // When
    const decision = repeatedToolCallPolicy().shouldStopAfterTurn({
      completedTurns: 1,
      priorToolCalls: [],
      toolCalls,
    });

    // Then
    expect(decision).toEqual({ type: "stop", reason: "repeated_tool_call" });
  });

  test(`Given repeated blocked goal proposals reach the blocker audit threshold,
    When the repeated-call guard evaluates the third matching proposal,
    Then it lets runtime execute the blocked audit transition`, () => {
    // Given
    const firstProposal = toolCallFromParsedArguments("goal_1", "update_goal", {
      status: "blocked",
      reason: "Need credentials.",
    });
    const secondProposal = toolCallFromParsedArguments(
      "goal_2",
      "update_goal",
      {
        status: "blocked",
        reason: "Need credentials.",
      },
    );
    const thirdProposal = toolCallFromParsedArguments("goal_3", "update_goal", {
      status: "blocked",
      reason: "Need credentials.",
    });
    const fourthProposal = toolCallFromParsedArguments(
      "goal_4",
      "update_goal",
      {
        status: "blocked",
        reason: "Need credentials.",
      },
    );
    if (
      firstProposal === null ||
      secondProposal === null ||
      thirdProposal === null ||
      fourthProposal === null
    ) {
      throw new Error("expected valid update_goal calls");
    }
    const policy = repeatedToolCallPolicy();

    // When / Then
    expect(
      policy.shouldStopAfterTurn({
        completedTurns: 3,
        priorToolCalls: [firstProposal, secondProposal],
        toolCalls: [thirdProposal],
      }),
    ).toEqual({ type: "continue" });
    expect(
      policy.shouldStopAfterTurn({
        completedTurns: 4,
        priorToolCalls: [firstProposal, secondProposal, thirdProposal],
        toolCalls: [fourthProposal],
      }),
    ).toEqual({ type: "stop", reason: "repeated_tool_call" });
  });

  test(`Given a caller reuses one stop policy instance across two sessions,
    When the second session starts with the same read the first session repeated,
    Then leftover history from the first session does not stop the second`, async () => {
    // Given
    const workspace = await createWorkspace();
    await writeFile(join(workspace, "a.txt"), "alpha\n", "utf8");
    const sharedPolicy = repeatedToolCallPolicy();
    const sameRead = fakeToolResponse("read", { path: "a.txt" });
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
          bash: { kind: "disabled" },
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
          bash: { kind: "disabled" },
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
    const sameRead = fakeToolResponse("read", { path: "a.txt" });
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
          bash: { kind: "disabled" },
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
          bash: { kind: "disabled" },
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
            bash: { kind: "disabled" },
            stopPolicy: neverStop,
          }),
        ),
      ).rejects.toThrow("LLM stream ended without stop event");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
