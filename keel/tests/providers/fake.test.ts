import { describe, expect, test } from "vitest";
import {
  createFakeProvider,
  type FakeResponse,
  fakeBashResponse,
  fakeGlobResponse,
  fakeGrepResponse,
  fakeLsResponse,
  fakeToolResponse,
} from "../../src/llm/providers/fake.ts";
import type { LLMEvent, LLMProvider } from "../../src/llm/types.ts";

async function collectProviderEvents(
  provider: LLMProvider,
): Promise<LLMEvent[]> {
  const events: LLMEvent[] = [];
  for await (const event of provider.stream({
    systemPrompt: "You are helpful.",
    messages: [],
    signal: new AbortController().signal,
  })) {
    events.push(event);
  }
  return events;
}

describe("Fake Provider", () => {
  test(`Given the fake provider is scripted with a generic builtin tool response,
    When it streams tool events,
    Then the call is validated and emitted through the registry`, async () => {
    // Given
    const provider = createFakeProvider([
      fakeToolResponse("grep", { pattern: "needle", path: "src" }),
    ]);

    // When
    const events = await collectProviderEvents(provider);

    // Then
    expect(events[0]).toEqual({
      type: "tool_call",
      id: "fake_tool_call_1",
      tool: "grep",
      pattern: "needle",
      path: "src",
    });
  });

  test(`Given the fake provider is scripted with invalid generic tool arguments,
    When the response is created,
    Then the registry rejects the script before streaming`, () => {
    // Given / When / Then
    expect(() => fakeToolResponse("ls", { limit: 0 })).toThrow(
      "Invalid fake tool response arguments for ls",
    );
  });

  test(`Given the fake provider is scripted with a manually constructed invalid tool response,
    When it streams tool events,
    Then the registry rejects the script during streaming`, async () => {
    // Given
    const invalidResponse: FakeResponse = {
      type: "tool",
      tool: "ls",
      args: { limit: 0 },
      usage: {
        inputTokens: 0,
        cachedInputTokens: 0,
        uncachedInputTokens: 0,
        outputTokens: 0,
      },
    };
    const provider = createFakeProvider([invalidResponse]);

    // When / Then
    await expect(collectProviderEvents(provider)).rejects.toThrow(
      "Invalid fake tool response arguments for ls",
    );
  });

  test(`Given the fake provider script has no next response,
    When it is streamed again,
    Then it reports that the script is exhausted`, async () => {
    // Given
    const provider = createFakeProvider([fakeToolResponse("ls", {})]);
    await collectProviderEvents(provider);

    // When / Then
    await expect(collectProviderEvents(provider)).rejects.toThrow(
      "fake provider: script exhausted",
    );
  });

  test(`Given compatibility helpers are used for grep and bash tool calls,
    When the fake provider streams tool events,
    Then the helpers route through generic registry validation`, async () => {
    // Given
    const provider = createFakeProvider([
      fakeGrepResponse("needle"),
      fakeBashResponse("printf ok", undefined, { timeoutMs: 1000 }),
    ]);

    // When
    const firstTurnEvents = await collectProviderEvents(provider);
    const secondTurnEvents = await collectProviderEvents(provider);

    // Then
    expect(firstTurnEvents[0]).toEqual({
      type: "tool_call",
      id: "fake_tool_call_1",
      tool: "grep",
      pattern: "needle",
    });
    expect(secondTurnEvents[0]).toEqual({
      type: "tool_call",
      id: "fake_tool_call_2",
      tool: "bash",
      command: "printf ok",
      timeoutMs: 1000,
    });
  });

  test(`Given the fake provider is scripted to list the workspace root,
    When it streams tool events,
    Then the ls call omits the optional path`, async () => {
    // Given
    const provider = createFakeProvider([fakeLsResponse()]);

    // When
    const events = await collectProviderEvents(provider);

    // Then
    expect(events[0]).toEqual({
      type: "tool_call",
      id: "fake_tool_call_1",
      tool: "ls",
    });
  });

  test(`Given the fake provider is scripted to list a directory with a limit,
    When it streams tool events,
    Then the ls call preserves optional path and limit`, async () => {
    // Given
    const provider = createFakeProvider([
      fakeLsResponse(undefined, { path: "src", limit: 25 }),
    ]);

    // When
    const events = await collectProviderEvents(provider);

    // Then
    expect(events[0]).toEqual({
      type: "tool_call",
      id: "fake_tool_call_1",
      tool: "ls",
      path: "src",
      limit: 25,
    });
  });

  test(`Given the fake provider is scripted to glob from the workspace root,
    When it streams tool events,
    Then the glob call omits the optional path`, async () => {
    // Given
    const provider = createFakeProvider([fakeGlobResponse("**/*.test.ts")]);

    // When
    const events = await collectProviderEvents(provider);

    // Then
    expect(events[0]).toEqual({
      type: "tool_call",
      id: "fake_tool_call_1",
      tool: "glob",
      pattern: "**/*.test.ts",
    });
  });
});
