import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { AgentEvent } from "../../src/agent/events.ts";
import { runAgentTurn } from "../../src/agent/loop.ts";
import { defaultStopPolicy } from "../../src/agent/stop-policy.ts";
import type { SessionGoal } from "../../src/core/session-goal.ts";
import type { LLMProvider, Message, Usage } from "../../src/llm/types.ts";

const ZERO_USAGE: Usage = {
  inputTokens: 0,
  cachedInputTokens: 0,
  uncachedInputTokens: 0,
  outputTokens: 0,
};

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

describe("Task Progress", () => {
  test(`Given a model updates its task plan during a turn,
    When the agent continues after the tool call,
    Then the user sees task progress and the model receives the task update result`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-task-progress-"));
    const messages: Message[] = [
      { role: "user", content: "Fix the bug and verify it." },
    ];
    const providerRequests: (readonly Message[])[] = [];
    const provider: LLMProvider = {
      id: "task-progress-provider",
      async *stream(options) {
        providerRequests.push(structuredClone([...options.messages]));
        if (providerRequests.length === 1) {
          yield {
            type: "tool_call",
            id: "plan_1",
            tool: "update_plan",
            plan: [
              { step: "Inspect the failure", status: "in_progress" },
              { step: "Patch the bug", status: "pending" },
              { step: "Run verification", status: "pending" },
            ],
          };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        yield { type: "text", text: "I am inspecting the failure." };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };

    try {
      // When
      const events = await collect(
        runAgentTurn({
          workspace,
          provider,
          messages,
          systemPrompt: "You are helpful.",
          signal: freshSignal(),
          allowBash: false,
          stopPolicy: defaultStopPolicy(),
        }),
      );

      // Then
      expect(events).toContainEqual({
        type: "task_progress_updated",
        messageOrdinal: 3,
        taskProgress: {
          tasks: [
            { step: "Inspect the failure", status: "in_progress" },
            { step: "Patch the bug", status: "pending" },
            { step: "Run verification", status: "pending" },
          ],
        },
      });
      expect(providerRequests).toHaveLength(2);
      expect(providerRequests[1]).toEqual([
        { role: "user", content: "Fix the bug and verify it." },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "plan_1",
              tool: "update_plan",
              plan: [
                { step: "Inspect the failure", status: "in_progress" },
                { step: "Patch the bug", status: "pending" },
                { step: "Run verification", status: "pending" },
              ],
            },
          ],
        },
        {
          role: "tool",
          toolCallId: "plan_1",
          content: expect.stringContaining(
            "Task progress updated: 0/3 completed; current: Inspect the failure.",
          ),
        },
      ]);
      expect(messages.at(-1)).toEqual({
        role: "assistant",
        content: "I am inspecting the failure.",
        toolCalls: [],
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a model marks an active session goal completed without command evidence,
    When the agent continues after the tool call,
    Then Keel keeps the goal active and returns a recovery message to the model`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-goal-progress-"));
    const messages: Message[] = [
      { role: "user", content: "Finish the durable session goal." },
    ];
    const providerRequests: (readonly Message[])[] = [];
    const sessionGoal: SessionGoal = {
      objective: "Finish the durable session goal",
      status: "active",
    };
    const provider: LLMProvider = {
      id: "goal-progress-provider",
      async *stream(options) {
        providerRequests.push(structuredClone([...options.messages]));
        if (providerRequests.length === 1) {
          yield {
            type: "tool_call",
            id: "goal_1",
            tool: "update_goal",
            status: "completed",
          };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        yield {
          type: "text",
          text: "The session goal still needs command evidence.",
        };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };

    try {
      // When
      const events = await collect(
        runAgentTurn({
          workspace,
          provider,
          messages,
          systemPrompt: "You are helpful.",
          signal: freshSignal(),
          allowBash: false,
          stopPolicy: defaultStopPolicy(),
          sessionGoal,
        }),
      );

      // Then
      expect(
        events.some((event) => event.type === "session_goal_updated"),
      ).toBe(false);
      expect(providerRequests).toHaveLength(2);
      expect(providerRequests[1]).toEqual([
        { role: "user", content: "Finish the durable session goal." },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "goal_1",
              tool: "update_goal",
              status: "completed",
            },
          ],
        },
        {
          role: "tool",
          toolCallId: "goal_1",
          content: expect.stringContaining(
            "Tool failed: update_goal failed: no completion criterion is set",
          ),
        },
      ]);
      expect(messages.at(-1)).toEqual({
        role: "assistant",
        content: "The session goal still needs command evidence.",
        toolCalls: [],
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a model marks an active session goal blocked,
    When the agent continues after the tool call,
    Then Keel persists the blocked goal and returns the blocker reason to the model`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-goal-blocked-"));
    const messages: Message[] = [
      { role: "user", content: "Finish the durable session goal." },
    ];
    const providerRequests: (readonly Message[])[] = [];
    const sessionGoal: SessionGoal = {
      objective: "Finish the durable session goal",
      status: "active",
      criterionKind: "command",
      completionCriterion: "pnpm test",
    };
    const provider: LLMProvider = {
      id: "goal-blocked-provider",
      async *stream(options) {
        providerRequests.push(structuredClone([...options.messages]));
        if (providerRequests.length === 1) {
          yield {
            type: "tool_call",
            id: "goal_1",
            tool: "update_goal",
            status: "blocked",
            reason: "Need credentials from the user.",
          };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        yield {
          type: "text",
          text: "The session goal is blocked on credentials.",
        };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };

    try {
      // When
      const events = await collect(
        runAgentTurn({
          workspace,
          provider,
          messages,
          systemPrompt: "You are helpful.",
          signal: freshSignal(),
          allowBash: false,
          stopPolicy: defaultStopPolicy(),
          sessionGoal,
        }),
      );

      // Then
      expect(events).toContainEqual({
        type: "session_goal_updated",
        messageOrdinal: 3,
        goal: {
          objective: "Finish the durable session goal",
          status: "blocked",
          statusReason: "Need credentials from the user.",
          criterionKind: "command",
          completionCriterion: "pnpm test",
        },
      });
      expect(providerRequests).toHaveLength(2);
      expect(providerRequests[1]).toEqual([
        { role: "user", content: "Finish the durable session goal." },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "goal_1",
              tool: "update_goal",
              status: "blocked",
              reason: "Need credentials from the user.",
            },
          ],
        },
        {
          role: "tool",
          toolCallId: "goal_1",
          content:
            "Session goal blocked: Finish the durable session goal. Reason: Need credentials from the user.",
        },
      ]);
      expect(messages.at(-1)).toEqual({
        role: "assistant",
        content: "The session goal is blocked on credentials.",
        toolCalls: [],
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a model verifies an active session goal with its command completion criterion,
    When the model proposes completion after the successful command,
    Then Keel persists the completed goal and returns the goal result`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-goal-command-evidence-"),
    );
    const messages: Message[] = [
      { role: "user", content: "Finish the durable session goal." },
    ];
    const providerRequests: (readonly Message[])[] = [];
    const sessionGoal: SessionGoal = {
      objective: "Finish the durable session goal",
      status: "active",
      criterionKind: "command",
      completionCriterion: 'node -e "process.exit(0)"',
    };
    const provider: LLMProvider = {
      id: "goal-command-evidence-provider",
      async *stream(options) {
        providerRequests.push(structuredClone([...options.messages]));
        if (providerRequests.length === 1) {
          yield {
            type: "tool_call",
            id: "verify_1",
            tool: "bash",
            command: 'node -e "process.exit(0)"',
          };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        if (providerRequests.length === 2) {
          yield {
            type: "tool_call",
            id: "goal_1",
            tool: "update_goal",
            status: "completed",
          };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        yield { type: "text", text: "The session goal is complete." };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };

    try {
      // When
      const events = await collect(
        runAgentTurn({
          workspace,
          provider,
          messages,
          systemPrompt: "You are helpful.",
          signal: freshSignal(),
          allowBash: true,
          stopPolicy: defaultStopPolicy(),
          sessionGoal,
        }),
      );

      // Then
      expect(events).toContainEqual({
        type: "session_goal_updated",
        messageOrdinal: 5,
        goal: {
          objective: "Finish the durable session goal",
          status: "completed",
          criterionKind: "command",
          completionCriterion: 'node -e "process.exit(0)"',
        },
      });
      expect(providerRequests).toHaveLength(3);
      expect(providerRequests[2]).toEqual([
        { role: "user", content: "Finish the durable session goal." },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "verify_1",
              tool: "bash",
              command: 'node -e "process.exit(0)"',
            },
          ],
        },
        {
          role: "tool",
          toolCallId: "verify_1",
          content: "Exit code: 0\n\n(no output)",
        },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "goal_1",
              tool: "update_goal",
              status: "completed",
            },
          ],
        },
        {
          role: "tool",
          toolCallId: "goal_1",
          content: "Session goal completed: Finish the durable session goal.",
        },
      ]);
      expect(messages.at(-1)).toEqual({
        role: "assistant",
        content: "The session goal is complete.",
        toolCalls: [],
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a model mutates the workspace after running the command completion criterion,
    When the model proposes completion from stale command evidence,
    Then Keel keeps the goal active and asks for fresh evidence`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-goal-stale-command-evidence-"),
    );
    const messages: Message[] = [
      { role: "user", content: "Finish the durable session goal." },
    ];
    const providerRequests: (readonly Message[])[] = [];
    const sessionGoal: SessionGoal = {
      objective: "Finish the durable session goal",
      status: "active",
      criterionKind: "command",
      completionCriterion: 'node -e "process.exit(0)"',
    };
    const provider: LLMProvider = {
      id: "goal-stale-command-evidence-provider",
      async *stream(options) {
        providerRequests.push(structuredClone([...options.messages]));
        if (providerRequests.length === 1) {
          yield {
            type: "tool_call",
            id: "verify_1",
            tool: "bash",
            command: 'node -e "process.exit(0)"',
          };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        if (providerRequests.length === 2) {
          yield {
            type: "tool_call",
            id: "write_1",
            tool: "write",
            path: "note.txt",
            content: "changed after verification\n",
          };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        if (providerRequests.length === 3) {
          yield {
            type: "tool_call",
            id: "goal_1",
            tool: "update_goal",
            status: "completed",
          };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        yield { type: "text", text: "I need to rerun verification." };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };

    try {
      // When
      const events = await collect(
        runAgentTurn({
          workspace,
          provider,
          messages,
          systemPrompt: "You are helpful.",
          signal: freshSignal(),
          allowBash: true,
          stopPolicy: defaultStopPolicy(),
          sessionGoal,
        }),
      );

      // Then
      expect(
        events.some((event) => event.type === "session_goal_updated"),
      ).toBe(false);
      expect(providerRequests).toHaveLength(4);
      expect(providerRequests[3]?.at(-1)).toEqual({
        role: "tool",
        toolCallId: "goal_1",
        content: expect.stringContaining(
          "Tool failed: update_goal failed: command completion criterion evidence is stale",
        ),
      });
      expect(messages.at(-1)).toEqual({
        role: "assistant",
        content: "I need to rerun verification.",
        toolCalls: [],
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an assertion session goal has surfaced completion evidence,
    When the model proposes completion and the fresh evaluator approves it,
    Then Keel completes the goal and returns the evidence basis`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-goal-assertion-approved-"),
    );
    await writeFile(
      join(workspace, "RELEASE.md"),
      "Release notes:\n- command-a now supports dry-run.\n- command-b now validates config.\n",
    );
    const messages: Message[] = [
      { role: "user", content: "Publish the migration notes." },
    ];
    const providerRequests: {
      readonly messages: readonly Message[];
      readonly toolChoice?: "none";
      readonly allowBash?: boolean;
    }[] = [];
    const sessionGoal: SessionGoal = {
      objective: "Publish the migration notes",
      status: "active",
      criterionKind: "assertion",
      completionCriterion: "The release notes explain every changed command.",
    };
    const provider: LLMProvider = {
      id: "goal-assertion-approved-provider",
      async *stream(options) {
        providerRequests.push({
          messages: structuredClone([...options.messages]),
          ...(options.toolChoice !== undefined
            ? { toolChoice: options.toolChoice }
            : {}),
          ...(options.allowBash !== undefined
            ? { allowBash: options.allowBash }
            : {}),
        });
        if (options.toolChoice === "none") {
          yield {
            type: "text",
            text: JSON.stringify({
              completed: true,
              reason:
                "The surfaced notes explicitly cover every changed command.",
            }),
          };
          yield {
            type: "stop",
            reason: "stop",
            usage: {
              inputTokens: 7,
              cachedInputTokens: 0,
              uncachedInputTokens: 7,
              outputTokens: 5,
            },
          };
          return;
        }
        if (
          providerRequests.filter((request) => request.toolChoice !== "none")
            .length === 1
        ) {
          yield {
            type: "tool_call",
            id: "read_1",
            tool: "read",
            path: "RELEASE.md",
          };
          yield {
            type: "stop",
            reason: "stop",
            usage: {
              inputTokens: 3,
              cachedInputTokens: 0,
              uncachedInputTokens: 3,
              outputTokens: 2,
            },
          };
          return;
        }
        if (
          providerRequests.filter((request) => request.toolChoice !== "none")
            .length === 2
        ) {
          yield {
            type: "text",
            text: "The release notes show both changed commands.",
          };
          yield {
            type: "tool_call",
            id: "goal_1",
            tool: "update_goal",
            status: "completed",
          };
          yield {
            type: "stop",
            reason: "stop",
            usage: {
              inputTokens: 5,
              cachedInputTokens: 0,
              uncachedInputTokens: 5,
              outputTokens: 2,
            },
          };
          return;
        }
        yield {
          type: "text",
          text: "The migration notes are complete.",
        };
        yield {
          type: "stop",
          reason: "stop",
          usage: {
            inputTokens: 11,
            cachedInputTokens: 0,
            uncachedInputTokens: 11,
            outputTokens: 4,
          },
        };
      },
    };

    try {
      // When
      const events = await collect(
        runAgentTurn({
          workspace,
          provider,
          messages,
          systemPrompt: "You are helpful.",
          signal: freshSignal(),
          allowBash: false,
          stopPolicy: defaultStopPolicy(),
          sessionGoal,
        }),
      );

      // Then
      expect(events).toContainEqual({
        type: "session_goal_updated",
        messageOrdinal: 5,
        goal: {
          objective: "Publish the migration notes",
          status: "completed",
          criterionKind: "assertion",
          completionCriterion:
            "The release notes explain every changed command.",
        },
      });
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "end",
          usage: {
            inputTokens: 26,
            cachedInputTokens: 0,
            uncachedInputTokens: 26,
            outputTokens: 13,
          },
        }),
      );
      expect(providerRequests).toHaveLength(4);
      expect(providerRequests[2]).toMatchObject({ toolChoice: "none" });
      expect(providerRequests[2]?.allowBash).not.toBe(true);
      expect(providerRequests[2]?.messages).toHaveLength(1);
      expect(providerRequests[2]?.messages[0]).toEqual({
        role: "user",
        content: expect.stringContaining(
          "Objective: Publish the migration notes",
        ),
      });
      expect(providerRequests[2]?.messages[0]).toEqual({
        role: "user",
        content: expect.stringContaining(
          "Completion criterion: The release notes explain every changed command.",
        ),
      });
      expect(providerRequests[2]?.messages[0]).toEqual({
        role: "user",
        content: expect.stringContaining("command-a now supports dry-run"),
      });
      expect(providerRequests[2]?.messages[0]).toEqual({
        role: "user",
        content: expect.stringContaining("command-b now validates config"),
      });
      expect(providerRequests[3]?.messages.at(-1)).toEqual({
        role: "tool",
        toolCallId: "goal_1",
        content: expect.stringContaining(
          "Evidence: The surfaced notes explicitly cover every changed command.",
        ),
      });
      expect(messages.at(-1)).toEqual({
        role: "assistant",
        content: "The migration notes are complete.",
        toolCalls: [],
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an assertion session goal lacks surfaced completion evidence,
    When the model proposes completion and the fresh evaluator rejects it,
    Then Keel keeps the goal active and returns an actionable reason`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-goal-assertion-rejected-"),
    );
    const messages: Message[] = [
      { role: "user", content: "Publish the migration notes." },
    ];
    const providerRequests: {
      readonly messages: readonly Message[];
      readonly toolChoice?: "none";
    }[] = [];
    const sessionGoal: SessionGoal = {
      objective: "Publish the migration notes",
      status: "active",
      criterionKind: "assertion",
      completionCriterion: "The release notes explain every changed command.",
    };
    const provider: LLMProvider = {
      id: "goal-assertion-rejected-provider",
      async *stream(options) {
        providerRequests.push({
          messages: structuredClone([...options.messages]),
          ...(options.toolChoice !== undefined
            ? { toolChoice: options.toolChoice }
            : {}),
        });
        if (options.toolChoice === "none") {
          yield {
            type: "text",
            text: JSON.stringify({
              completed: false,
              reason: "No surfaced evidence shows command-b is documented.",
            }),
          };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        if (
          providerRequests.filter((request) => request.toolChoice !== "none")
            .length === 1
        ) {
          yield {
            type: "tool_call",
            id: "goal_1",
            tool: "update_goal",
            status: "completed",
          };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        yield {
          type: "text",
          text: "I need to document command-b before completing the goal.",
        };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };

    try {
      // When
      const events = await collect(
        runAgentTurn({
          workspace,
          provider,
          messages,
          systemPrompt: "You are helpful.",
          signal: freshSignal(),
          allowBash: false,
          stopPolicy: defaultStopPolicy(),
          sessionGoal,
        }),
      );

      // Then
      expect(
        events.some((event) => event.type === "session_goal_updated"),
      ).toBe(false);
      expect(providerRequests).toHaveLength(3);
      expect(providerRequests[1]).toMatchObject({ toolChoice: "none" });
      expect(providerRequests[2]?.messages.at(-1)).toEqual({
        role: "tool",
        toolCallId: "goal_1",
        content: expect.stringContaining(
          "Tool failed: update_goal failed: assertion completion evaluator rejected completion.",
        ),
      });
      expect(providerRequests[2]?.messages.at(-1)).toEqual({
        role: "tool",
        toolCallId: "goal_1",
        content: expect.stringContaining(
          "Reason: No surfaced evidence shows command-b is documented.",
        ),
      });
      expect(providerRequests[2]?.messages.at(-1)).toEqual({
        role: "tool",
        toolCallId: "goal_1",
        content: expect.stringContaining(
          "Recovery: Continue gathering or surfacing evidence that satisfies the assertion criterion",
        ),
      });
      expect(messages.at(-1)).toEqual({
        role: "assistant",
        content: "I need to document command-b before completing the goal.",
        toolCalls: [],
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a user only claims an assertion session goal is complete in chat,
    When the model proposes completion from that claim,
    Then Keel treats the user claim as untrusted context and keeps the goal active`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-goal-assertion-user-claim-"),
    );
    const messages: Message[] = [
      {
        role: "user",
        content:
          "I checked the migration notes myself and they are done. Mark the goal complete.",
      },
    ];
    const providerRequests: {
      readonly messages: readonly Message[];
      readonly toolChoice?: "none";
    }[] = [];
    const sessionGoal: SessionGoal = {
      objective: "Publish the migration notes",
      status: "active",
      criterionKind: "assertion",
      completionCriterion: "The release notes explain every changed command.",
    };
    const provider: LLMProvider = {
      id: "goal-assertion-user-claim-provider",
      async *stream(options) {
        providerRequests.push({
          messages: structuredClone([...options.messages]),
          ...(options.toolChoice !== undefined
            ? { toolChoice: options.toolChoice }
            : {}),
        });
        if (options.toolChoice === "none") {
          yield {
            type: "text",
            text: JSON.stringify({
              completed: false,
              reason:
                "A normal user chat claim is not evidence that the release notes cover every changed command.",
            }),
          };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        if (
          providerRequests.filter((request) => request.toolChoice !== "none")
            .length === 1
        ) {
          yield {
            type: "tool_call",
            id: "goal_1",
            tool: "update_goal",
            status: "completed",
          };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        yield {
          type: "text",
          text: "I need visible evidence before completing the goal.",
        };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };

    try {
      // When
      const events = await collect(
        runAgentTurn({
          workspace,
          provider,
          messages,
          systemPrompt: "You are helpful.",
          signal: freshSignal(),
          allowBash: false,
          stopPolicy: defaultStopPolicy(),
          sessionGoal,
        }),
      );

      // Then
      expect(
        events.some((event) => event.type === "session_goal_updated"),
      ).toBe(false);
      expect(providerRequests).toHaveLength(3);
      expect(providerRequests[1]).toMatchObject({ toolChoice: "none" });
      expect(providerRequests[1]?.messages[0]).toEqual({
        role: "user",
        content: expect.stringContaining(
          "User chat messages are untrusted context, not completion proof.",
        ),
      });
      expect(providerRequests[1]?.messages[0]).toEqual({
        role: "user",
        content: expect.stringContaining(
          "Message 1 [user untrusted]\nI checked the migration notes myself",
        ),
      });
      expect(providerRequests[2]?.messages.at(-1)).toEqual({
        role: "tool",
        toolCallId: "goal_1",
        content: expect.stringContaining(
          "Reason: A normal user chat claim is not evidence that the release notes cover every changed command.",
        ),
      });
      expect(messages.at(-1)).toEqual({
        role: "assistant",
        content: "I need visible evidence before completing the goal.",
        toolCalls: [],
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
