import { describe, expect, test } from "vitest";
import {
  createFakeProvider,
  fakeGlobResponse,
  fakeLsResponse,
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
