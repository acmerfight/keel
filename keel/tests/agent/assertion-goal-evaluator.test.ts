import { describe, expect, test } from "vitest";
import { evaluateAssertionGoalCompletionWithProvider } from "../../src/agent/assertion-goal-evaluator.ts";
import type { LLMProvider, Message, Usage } from "../../src/llm/types.ts";

const ZERO_USAGE: Usage = {
  inputTokens: 0,
  cachedInputTokens: 0,
  uncachedInputTokens: 0,
  outputTokens: 0,
};

function freshSignal(): AbortSignal {
  return new AbortController().signal;
}

describe("Assertion Goal Evaluator", () => {
  test.each([
    {
      output: "complete",
      expected: "invalid JSON instead of a yes/no judgment",
    },
    {
      output: JSON.stringify({ completed: true }),
      expected: "Assertion evaluator returned invalid JSON:",
    },
  ])(`Given the fresh assertion evaluator returns malformed output,
    When Keel evaluates assertion-goal completion,
    Then it rejects completion with a judgment-format reason`, async ({
    output,
    expected,
  }) => {
    // Given
    const providerRequests: {
      readonly messages: readonly Message[];
      readonly toolChoice?: "none";
      readonly allowBash?: boolean;
    }[] = [];
    const provider: LLMProvider = {
      id: "malformed-assertion-evaluator-provider",
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
        yield { type: "text", text: output };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };

    // When
    const evaluation = await evaluateAssertionGoalCompletionWithProvider({
      provider,
      signal: freshSignal(),
      goal: {
        objective: "Publish release notes",
        completionCriterion: "Release notes cover every changed command.",
      },
      evidenceMessages: [{ role: "user", content: "Publish release notes." }],
    });

    // Then
    expect(evaluation).toMatchObject({
      completed: false,
      reason: expect.stringContaining(expected),
      usage: ZERO_USAGE,
    });
    expect(providerRequests).toHaveLength(1);
    expect(providerRequests[0]).toMatchObject({ toolChoice: "none" });
    expect(providerRequests[0]?.allowBash).not.toBe(true);
    expect(providerRequests[0]?.messages).toHaveLength(1);
    expect(providerRequests[0]?.messages[0]).toEqual({
      role: "user",
      content: expect.stringContaining(
        "Completion criterion: Release notes cover every changed command.",
      ),
    });
  });

  test(`Given the fresh assertion evaluator attempts to call tools,
    When Keel evaluates assertion-goal completion,
    Then it rejects completion without executing evaluator work`, async () => {
    // Given
    const providerRequests: {
      readonly messages: readonly Message[];
      readonly toolChoice?: "none";
    }[] = [];
    const provider: LLMProvider = {
      id: "tool-calling-assertion-evaluator-provider",
      async *stream(options) {
        providerRequests.push({
          messages: structuredClone([...options.messages]),
          ...(options.toolChoice !== undefined
            ? { toolChoice: options.toolChoice }
            : {}),
        });
        yield {
          type: "tool_call",
          id: "plan_1",
          tool: "update_plan",
          plan: [{ step: "Keep working", status: "in_progress" }],
        };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };

    // When
    const evaluation = await evaluateAssertionGoalCompletionWithProvider({
      provider,
      signal: freshSignal(),
      goal: {
        objective: "Publish release notes",
        completionCriterion: "Release notes cover every changed command.",
      },
      evidenceMessages: [],
    });

    // Then
    expect(evaluation).toEqual({
      completed: false,
      reason:
        "Assertion evaluator attempted to call tools instead of returning a yes/no judgment.",
      usage: ZERO_USAGE,
    });
    expect(providerRequests).toHaveLength(1);
    expect(providerRequests[0]).toMatchObject({ toolChoice: "none" });
  });

  test(`Given the fresh assertion evaluator hits the provider output limit,
    When the partial text looks like an approval,
    Then Keel rejects completion because the judgment is incomplete`, async () => {
    // Given
    const provider: LLMProvider = {
      id: "length-stopped-assertion-evaluator-provider",
      async *stream() {
        yield {
          type: "text",
          text: JSON.stringify({
            completed: true,
            reason: "Partial approval before the provider stopped.",
          }),
        };
        yield { type: "stop", reason: "length", usage: ZERO_USAGE };
      },
    };

    // When
    const evaluation = await evaluateAssertionGoalCompletionWithProvider({
      provider,
      signal: freshSignal(),
      goal: {
        objective: "Publish release notes",
        completionCriterion: "Release notes cover every changed command.",
      },
      evidenceMessages: [
        { role: "tool", toolCallId: "read_1", content: "Release notes." },
      ],
    });

    // Then
    expect(evaluation).toEqual({
      completed: false,
      reason: "Assertion evaluator stopped before completing its judgment.",
      usage: ZERO_USAGE,
    });
  });

  test(`Given surfaced evidence includes assistant text and truncated tool output,
    When Keel builds the fresh assertion-evaluator request,
    Then the evaluator receives both evidence records in its no-tool context`, async () => {
    // Given
    const providerRequests: {
      readonly messages: readonly Message[];
      readonly toolChoice?: "none";
    }[] = [];
    const provider: LLMProvider = {
      id: "evidence-format-assertion-evaluator-provider",
      async *stream(options) {
        providerRequests.push({
          messages: structuredClone([...options.messages]),
          ...(options.toolChoice !== undefined
            ? { toolChoice: options.toolChoice }
            : {}),
        });
        yield {
          type: "text",
          text: JSON.stringify({
            completed: false,
            reason: "Need complete source output before approval.",
          }),
        };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };

    // When
    const evaluation = await evaluateAssertionGoalCompletionWithProvider({
      provider,
      signal: freshSignal(),
      goal: {
        objective: "Publish release notes",
        completionCriterion: "Release notes cover every changed command.",
      },
      evidenceMessages: [
        {
          role: "assistant",
          content: "I found partial evidence in the release notes.",
          toolCalls: [],
        },
        {
          role: "tool",
          toolCallId: "read_1",
          content: "Release notes mention command-a.",
          sourceTruncated: true,
        },
      ],
    });

    // Then
    expect(evaluation.completed).toBe(false);
    expect(providerRequests).toHaveLength(1);
    expect(providerRequests[0]).toMatchObject({ toolChoice: "none" });
    expect(providerRequests[0]?.messages[0]).toEqual({
      role: "user",
      content: expect.stringContaining(
        "Message 1 [assistant]\nI found partial evidence in the release notes.",
      ),
    });
    expect(providerRequests[0]?.messages[0]).toEqual({
      role: "user",
      content: expect.stringContaining(
        "Message 2 [tool read_1 source-truncated]\nRelease notes mention command-a.",
      ),
    });
  });
});
