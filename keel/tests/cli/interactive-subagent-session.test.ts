import { describe, expect, test } from "vitest";
import type {
  AgentId,
  SubagentCanonicalResult,
  SubagentRunId,
} from "../../src/agent/subagent-lifecycle.ts";
import type {
  AgentHistoryEntry,
  AgentTreeHistory,
} from "../../src/cli/agent-tree-store.ts";
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

const accounting = {
  usage: {
    inputTokens: 10,
    cachedInputTokens: 0,
    uncachedInputTokens: 10,
    outputTokens: 2,
  },
  turns: 1,
  costUsd: 0.0001,
} as const;

function activeEntry(
  childAgentId: AgentId,
  childRunId: SubagentRunId,
): AgentHistoryEntry {
  return {
    index: 1,
    delegationId: `delegation:${childAgentId}`,
    childAgentId,
    childRunId,
    parentRunId: "parent-run",
    parentToolCallId: `tool:${childAgentId}`,
    task: "Inspect one module.",
    focusPaths: [],
    providerId: "deepseek",
    model: "deepseek-chat",
    transcriptRef: `agent-transcript:saved-session/${childAgentId}`,
    acceptedAt: "2026-08-10T00:00:00.000Z",
    status: "running",
    accounting,
    result: null,
  };
}

function canonicalResult(
  entry: AgentHistoryEntry,
  status: "completed" | "cancelled" = "completed",
): SubagentCanonicalResult {
  const base = {
    delegationId: entry.delegationId,
    childAgentId: entry.childAgentId,
    childRunId: entry.childRunId,
    task: entry.task,
    transcriptRef: entry.transcriptRef,
    ...accounting,
  };
  return status === "completed"
    ? { ...base, status, finalText: "done", error: null }
    : { ...base, status, finalText: null, error: "cancelled" };
}

function mutableHistory(entries: AgentHistoryEntry[]): AgentTreeHistory {
  return {
    ...emptyHistory(),
    entries: () => entries,
  };
}

describe("Interactive subagent session", () => {
  test(`Given durable, unknown, and non-owned child records,
    When live controls inspect them under a small output budget,
    Then results stay bounded and ownership errors do not invent live state`, async () => {
    const terminal = activeEntry("agent-terminal", "subagent-terminal");
    const result = canonicalResult(terminal);
    const completed: AgentHistoryEntry = {
      ...terminal,
      status: "completed",
      result: { ...result, transcriptRef: terminal.transcriptRef },
    };
    const active = activeEntry("agent-active", "subagent-active");
    const session = createInteractiveSubagentSession({
      maxCostUsd: 1,
      initialCostUsd: 2,
      history: mutableHistory([completed, active]),
      now: () => 0,
      writeStderr: () => {},
      onBackgroundSettled: () => {},
    });

    expect(session.sharedCostBudget.remainingUsd()).toBe(0);
    expect(session.control.list({ maxResultChars: 5 }).content).toHaveLength(5);
    expect(session.control.list({ maxResultChars: 20 }).content).toHaveLength(
      20,
    );
    await expect(
      Promise.all([
        session.control.waitForSettlement({
          id: completed.childAgentId,
          signal: new AbortController().signal,
        }),
        session.control.waitForSettlement({
          id: "agent-unknown",
          signal: new AbortController().signal,
        }),
        session.control.waitForSettlement({
          id: active.childAgentId,
          signal: new AbortController().signal,
        }),
      ]),
    ).resolves.toEqual([undefined, undefined, undefined]);
    await expect(
      session.control.wait({
        id: completed.childAgentId,
        signal: new AbortController().signal,
        maxResultChars: 6_000,
      }),
    ).resolves.toMatchObject({
      ok: true,
      content: expect.stringContaining("done"),
    });
    await expect(
      session.control.cancel({
        id: completed.childAgentId,
        signal: new AbortController().signal,
        maxResultChars: 6_000,
      }),
    ).resolves.toMatchObject({
      ok: true,
      content: expect.stringContaining('"status":"completed"'),
    });

    for (const operation of [session.control.wait, session.control.cancel]) {
      await expect(
        operation({
          id: "agent-unknown",
          signal: new AbortController().signal,
          maxResultChars: 6_000,
        }),
      ).resolves.toMatchObject({
        ok: false,
        content: expect.stringContaining("No subagent"),
      });
      await expect(
        operation({
          id: active.childAgentId,
          signal: new AbortController().signal,
          maxResultChars: 6_000,
        }),
      ).resolves.toMatchObject({
        ok: false,
        content: expect.stringContaining("not owned by this live session"),
      });
    }
  });

  test(`Given a registered background child settles after a wait or cancel,
    When controls race abort and terminal persistence,
    Then the session returns durable truth, emits one notification, and rejects duplicate ownership`, async () => {
    const entry = activeEntry("agent-live", "subagent-live");
    const entries = [entry];
    const result = canonicalResult(entry);
    const completion = Promise.withResolvers<SubagentCanonicalResult>();
    let cancellations = 0;
    const session = createInteractiveSubagentSession({
      maxCostUsd: 1,
      initialCostUsd: 0,
      history: mutableHistory(entries),
      now: () => 0,
      writeStderr: () => {
        throw new Error("terminal output unavailable");
      },
      onBackgroundSettled: () => {},
    });
    const run = {
      delegationId: entry.delegationId,
      childAgentId: entry.childAgentId,
      childRunId: entry.childRunId,
      task: entry.task,
      result: completion.promise,
      cancel: () => {
        cancellations++;
      },
    };
    session.background.register(run);
    expect(() => session.background.register(run)).toThrow(
      "is already registered",
    );

    const aborted = new AbortController();
    aborted.abort(new Error("wait cancelled"));
    await expect(
      session.control.wait({
        id: entry.childAgentId,
        signal: aborted.signal,
        maxResultChars: 6_000,
      }),
    ).resolves.toMatchObject({
      ok: false,
      content: expect.stringContaining("wait cancelled"),
    });

    const waiting = session.control.wait({
      id: entry.childAgentId,
      signal: new AbortController().signal,
      maxResultChars: 6_000,
    });
    const settling = session.control.waitForSettlement({
      id: entry.childAgentId,
      signal: new AbortController().signal,
    });
    entries[0] = {
      ...entry,
      status: "completed",
      result: { ...result, transcriptRef: entry.transcriptRef },
    };
    completion.resolve(result);
    await expect(settling).resolves.toBeUndefined();
    await expect(waiting).resolves.toMatchObject({
      ok: true,
      content: expect.stringContaining("done"),
    });
    await Promise.resolve();
    expect(session.drainNotifications()).toEqual([
      expect.stringContaining(
        `Background subagent ${entry.childAgentId} completed.`,
      ),
    ]);
    expect(session.drainNotifications()).toEqual([]);
    await expect(
      session.control.cancel({
        id: entry.childAgentId,
        signal: new AbortController().signal,
        maxResultChars: 6_000,
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(cancellations).toBe(0);
    await session.shutdown();
  });

  test(`Given a live child settles without durable truth or rejects during settlement,
    When wait, cancel, and owner shutdown observe it,
    Then every control fails closed and propagates the underlying lifecycle failure`, async () => {
    const entry = activeEntry("agent-inconsistent", "subagent-inconsistent");
    const completion = Promise.withResolvers<SubagentCanonicalResult>();
    const session = createInteractiveSubagentSession({
      maxCostUsd: 1,
      initialCostUsd: 0,
      history: mutableHistory([entry]),
      now: () => 0,
      writeStderr: () => {},
      onBackgroundSettled: () => {},
    });
    session.background.register({
      delegationId: entry.delegationId,
      childAgentId: entry.childAgentId,
      childRunId: entry.childRunId,
      task: entry.task,
      result: completion.promise,
      cancel: () => {},
    });
    const waiting = session.control.wait({
      id: entry.childAgentId,
      signal: new AbortController().signal,
      maxResultChars: 6_000,
    });
    const cancelling = session.control.cancel({
      id: entry.childAgentId,
      signal: new AbortController().signal,
      maxResultChars: 6_000,
    });
    completion.resolve(canonicalResult(entry));
    await expect(waiting).resolves.toMatchObject({
      ok: false,
      content: expect.stringContaining("settled without a durable result"),
    });
    await expect(cancelling).resolves.toMatchObject({
      ok: false,
      content: expect.stringContaining("settled without a durable result"),
    });
    await session.shutdown();

    const rejectedEntry = activeEntry("agent-rejected", "subagent-rejected");
    const rejected = Promise.withResolvers<SubagentCanonicalResult>();
    const failed = createInteractiveSubagentSession({
      maxCostUsd: 1,
      initialCostUsd: 0,
      history: mutableHistory([rejectedEntry]),
      now: () => 0,
      writeStderr: () => {
        throw new Error("failure output unavailable");
      },
      onBackgroundSettled: () => {},
    });
    failed.background.register({
      delegationId: rejectedEntry.delegationId,
      childAgentId: rejectedEntry.childAgentId,
      childRunId: rejectedEntry.childRunId,
      task: rejectedEntry.task,
      result: rejected.promise,
      cancel: () => {},
    });
    const failedWait = failed.control.wait({
      id: rejectedEntry.childAgentId,
      signal: new AbortController().signal,
      maxResultChars: 6_000,
    });
    const failedCancel = failed.control.cancel({
      id: rejectedEntry.childAgentId,
      signal: new AbortController().signal,
      maxResultChars: 6_000,
    });
    rejected.reject(new Error("terminal persistence failed"));
    await expect(failedWait).resolves.toMatchObject({
      ok: false,
      content: expect.stringContaining("terminal persistence failed"),
    });
    await expect(failedCancel).resolves.toMatchObject({
      ok: false,
      content: expect.stringContaining("terminal persistence failed"),
    });
    await expect(failed.shutdown()).rejects.toThrow(
      "terminal persistence failed",
    );
  });

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
    expect(() => session.drainNotifications()).toThrow(
      "session accounting failed",
    );
  });
});
