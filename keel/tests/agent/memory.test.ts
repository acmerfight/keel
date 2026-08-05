import { describe, expect, test } from "vitest";
import type { AgentEvent } from "../../src/agent/events.ts";
import { runAgentTurn } from "../../src/agent/loop.ts";
import type { SessionMessage } from "../../src/agent/session-message.ts";
import { defaultStopPolicy } from "../../src/agent/stop-policy.ts";
import {
  createFakeProvider,
  fakeResponse,
  fakeToolResponse,
} from "../../src/llm/providers/fake.ts";
import { sessionLedgerMirroringMessages } from "../../src/testing/session-ledger-fixtures.ts";
import type { AgentMemoryMutationCapability } from "../../src/tools/memory.ts";

describe("agent memory source provenance", () => {
  test(`Given a runtime-generated user message contains remember-like text,
    When the provider attempts to use it as memory authority,
    Then the agent rejects the tool call before the mutation capability`, async () => {
    const userMessage = "Remember that release tags use a v prefix.";
    const messages: SessionMessage[] = [
      {
        role: "user",
        content: userMessage,
        origin: { type: "runtime_goal_activation" },
      },
    ];
    let addCalls = 0;
    const memoryMutation: AgentMemoryMutationCapability = {
      list: () => [],
      add: () => {
        addCalls++;
        return {
          id: "mem_unexpected",
          scope: { kind: "project", id: "project_unexpected" },
        };
      },
      forget: () => {
        throw new Error("forget should not run");
      },
    };
    const events: AgentEvent[] = [];
    const workspace = await mkdtemp(join(tmpdir(), "keel-memory-origin-"));

    try {
      for await (const event of runAgentTurn({
        workspace,
        provider: createFakeProvider([
          fakeToolResponse("memory_add", {
            text: "release tags use a v prefix",
          }),
          fakeResponse("Not saved."),
        ]),
        ledger: sessionLedgerMirroringMessages(messages),
        systemPrompt: "system",
        memory: {
          kind: "direct",
          prompt: () => "",
          mutation: memoryMutation,
        },
        signal: new AbortController().signal,
        bash: { kind: "disabled" },
        stopPolicy: defaultStopPolicy(),
      })) {
        events.push(event);
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }

    expect(addCalls).toBe(0);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool_end",
        ok: false,
      }),
    );
    expect(
      messages.find((message) => message.role === "tool")?.content,
    ).toContain("memory mutation is unavailable for this model step");
  });
});

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
