import { describe, expect, test } from "vitest";
import type { SubagentCanonicalResult } from "../../src/agent/subagent-lifecycle.ts";
import type { AgentTreeHistory } from "../../src/cli/agent-tree-store.ts";
import { createInteractiveSubagentSession } from "../../src/cli/interactive-subagent-session.ts";

function emptyHistory(): AgentTreeHistory {
  return {
    sessionId: "saved-session",
    persistence: {
      accepted: () => {
        throw new Error("not used by the session controller test");
      },
      rejected: () => {},
    },
    entries: () => [],
    transcript: () => "",
  };
}

describe("Interactive subagent session", () => {
  test(`Given a background child has a canonical terminal but session accounting fails,
    When the saved-session owner shuts down,
    Then the asynchronous failure is propagated instead of being silently discarded`, async () => {
    const result: SubagentCanonicalResult = {
      delegationId: "delegation-1",
      childAgentId: "agent-1",
      childRunId: "subagent-1",
      task: "Inspect one module.",
      transcriptRef: "agent-transcript:saved-session/agent-1",
      status: "completed",
      finalText: "done",
      error: null,
      usage: {
        inputTokens: 10,
        cachedInputTokens: 0,
        uncachedInputTokens: 10,
        outputTokens: 2,
      },
      turns: 1,
      costUsd: 0.0001,
    };
    const session = createInteractiveSubagentSession({
      maxCostUsd: 1,
      initialCostUsd: 0,
      history: emptyHistory(),
      now: () => 0,
      writeStderr: () => {},
      onBackgroundSettled: () => {
        throw new Error("session accounting failed");
      },
    });
    session.background.register({
      delegationId: result.delegationId,
      childAgentId: result.childAgentId,
      childRunId: result.childRunId,
      task: result.task,
      result: Promise.resolve(result),
      cancel: () => {},
    });

    await expect(session.shutdown()).rejects.toThrow(
      "session accounting failed",
    );
  });
});
