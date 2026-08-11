import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { narrowSubagentCapabilityLimits } from "../../src/agent/subagent-capability.ts";
import type {
  AgentId,
  PersistedSubagentCanonicalResult,
  SubagentAcceptedLifecycle,
  SubagentRunId,
} from "../../src/agent/subagent-lifecycle.ts";
import { resolveBuiltinSubagentProfile } from "../../src/agent/subagent-profile.ts";
import type {
  AgentResultRecord,
  AgentRunAcceptedRecord,
  AgentRunAccountingRecord,
  AgentRunRunningRecord,
  AgentRunTerminalRecord,
} from "../../src/cli/agent-tree-store/model.ts";
import { AGENT_TREE_SCHEMA_VERSION } from "../../src/cli/agent-tree-store/model.ts";
import { transcriptFilePath } from "../../src/cli/agent-tree-store/transcript.ts";
import { createAgentTreeHistory } from "../../src/cli/agent-tree-store.ts";
import { createSessionStore } from "../../src/cli/session-store.ts";

const explorerCapability = resolveBuiltinSubagentProfile("explorer").snapshot;
const reviewerCapability = resolveBuiltinSubagentProfile("reviewer").snapshot;

function acceptedLifecycle(
  childAgentId: AgentId,
  childRunId: SubagentRunId,
): SubagentAcceptedLifecycle {
  return {
    delegationId: `parent:tool-${childAgentId}`,
    childAgentId,
    childRunId,
    parentRunId: "parent",
    parentToolCallId: `tool-${childAgentId}`,
    task: "Inspect the durable child lifecycle.",
    focusPaths: ["src/module.ts"],
    mode: "foreground",
    providerId: "deepseek",
    model: "deepseek-chat",
    effort: null,
    systemPrompt: "Read-only child instructions.",
    threadCapabilityCeiling: explorerCapability,
    capability: explorerCapability,
    lineage: { kind: "root" },
  };
}

function acceptedRecord(
  lifecycle: SubagentAcceptedLifecycle,
  sessionId: string,
): AgentRunAcceptedRecord {
  return {
    schemaVersion: AGENT_TREE_SCHEMA_VERSION,
    type: "agent_run_accepted",
    timestamp: "2023-11-14T22:13:20.000Z",
    transcriptRef: `agent-transcript:${sessionId}/${lifecycle.childRunId}`,
    ...lifecycle,
  };
}

function runningRecord(
  accepted: AgentRunAcceptedRecord,
): AgentRunRunningRecord {
  return {
    schemaVersion: AGENT_TREE_SCHEMA_VERSION,
    type: "agent_run_running",
    timestamp: "2023-11-14T22:13:21.000Z",
    childAgentId: accepted.childAgentId,
    childRunId: accepted.childRunId,
  };
}

function accountingRecord(
  accepted: AgentRunAcceptedRecord,
): AgentRunAccountingRecord {
  return {
    schemaVersion: AGENT_TREE_SCHEMA_VERSION,
    type: "agent_run_accounting",
    timestamp: "2023-11-14T22:13:22.000Z",
    childAgentId: accepted.childAgentId,
    childRunId: accepted.childRunId,
    usage: {
      inputTokens: 10,
      cachedInputTokens: 0,
      uncachedInputTokens: 10,
      outputTokens: 2,
    },
    turns: 1,
    costUsd: 0.0001,
  };
}

function completedResult(
  accepted: AgentRunAcceptedRecord,
): PersistedSubagentCanonicalResult {
  return {
    delegationId: accepted.delegationId,
    childAgentId: accepted.childAgentId,
    childRunId: accepted.childRunId,
    task: accepted.task,
    transcriptRef: accepted.transcriptRef,
    status: "completed",
    finalText: "Complete.",
    error: null,
    usage: {
      inputTokens: 10,
      cachedInputTokens: 0,
      uncachedInputTokens: 10,
      outputTokens: 2,
    },
    turns: 1,
    costUsd: 0.0001,
    pendingInputCount: 0,
  };
}

function resultRecord(accepted: AgentRunAcceptedRecord): AgentResultRecord {
  return {
    schemaVersion: AGENT_TREE_SCHEMA_VERSION,
    type: "agent_result",
    timestamp: "2023-11-14T22:13:23.000Z",
    result: completedResult(accepted),
  };
}

function terminalRecord(
  accepted: AgentRunAcceptedRecord,
  status: AgentRunTerminalRecord["status"] = "completed",
): AgentRunTerminalRecord {
  return {
    schemaVersion: AGENT_TREE_SCHEMA_VERSION,
    type: "agent_run_terminal",
    timestamp: "2023-11-14T22:13:24.000Z",
    childAgentId: accepted.childAgentId,
    childRunId: accepted.childRunId,
    status,
  };
}

describe("Agent Tree Store", () => {
  test(`Given a terminal child thread has durable context and result,
    When a follow-up is accepted under the same Agent ID,
    Then a new Run continues the context while the previous Run stays immutable`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-agent-thread-"));
    const keelHome = join(workspace, ".keel-home");
    let now = 1_700_000_000_000;
    const runtime = {
      env: (key: string) => (key === "KEEL_HOME" ? keelHome : undefined),
      now: () => now++,
    };
    const sessionId = "continued-thread";
    const childAgentId = "agent-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const firstRunId = "subagent-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const secondRunId = "subagent-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    createSessionStore({ sessionId, workspace, runtime });

    try {
      const history = createAgentTreeHistory({ sessionId, runtime });
      const first = history.persistence.accepted(
        acceptedLifecycle(childAgentId, firstRunId),
      );
      first.transcript.initialize([
        {
          role: "user",
          content: "Inspect the original boundary.",
          origin: { type: "runtime_subagent_delegation" },
        },
      ]);
      first.transcript.append([
        {
          role: "assistant",
          content: "The original boundary is sound.",
          toolCalls: [],
        },
      ]);
      first.pendingInput([
        {
          role: "user",
          content: "Also inspect the pending caller note.",
          origin: { type: "runtime_subagent_input" },
        },
      ]);
      first.running().terminal({
        status: "failed",
        finalText: null,
        error: "Provider failed before the queued input boundary.",
        pendingInputCount: 1,
        usage: {
          inputTokens: 10,
          cachedInputTokens: 0,
          uncachedInputTokens: 10,
          outputTokens: 2,
        },
        turns: 1,
        costUsd: 0.0001,
      });
      const immutableFirstResult = history.runs(childAgentId)[0]?.result;

      const second = history.persistence.accepted({
        ...acceptedLifecycle(childAgentId, secondRunId),
        delegationId: "parent:resume-tool",
        parentToolCallId: "resume-tool",
        task: "Now inspect its callers.",
        lineage: { kind: "continuation", previousRunId: firstRunId },
      });
      second.transcript.initialize([
        {
          role: "user",
          content: "Now inspect its callers.",
          origin: { type: "runtime_subagent_input" },
        },
      ]);
      second.running().terminal({
        status: "completed",
        finalText: "The callers are sound too.",
        error: null,
        pendingInputCount: 0,
        usage: {
          inputTokens: 20,
          cachedInputTokens: 0,
          uncachedInputTokens: 20,
          outputTokens: 3,
        },
        turns: 1,
        costUsd: 0.0002,
      });

      expect(history.entries()).toHaveLength(1);
      expect(history.entries()[0]).toMatchObject({
        childAgentId,
        childRunId: secondRunId,
        status: "completed",
      });
      expect(history.runs(childAgentId)).toHaveLength(2);
      expect(history.runs(childAgentId)[0]?.result).toEqual(
        immutableFirstResult,
      );
      const continued = history.entries()[0];
      if (continued === undefined) throw new Error("missing continued thread");
      expect(history.messages(continued)).toMatchObject([
        { role: "user", content: "Inspect the original boundary." },
        {
          role: "assistant",
          content: "The original boundary is sound.",
        },
        { role: "user", content: "Also inspect the pending caller note." },
        { role: "user", content: "Now inspect its callers." },
      ]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given continuation acceptance may only narrow its Thread capability,
    When a caller narrows a Run or points to an expanding, unknown, different, active, or stale predecessor,
    Then the store accepts the narrowing and rejects every authority or lineage violation`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-agent-lineage-"));
    const keelHome = join(workspace, ".keel-home");
    let now = 1_700_000_000_000;
    const runtime = {
      env: (key: string) => (key === "KEEL_HOME" ? keelHome : undefined),
      now: () => now++,
    };
    const sessionId = "lineage-invariants";
    const childAgentId: AgentId = "agent-aaaaaaaa";
    const firstRunId: SubagentRunId = "subagent-aaaaaaaa";
    const secondRunId: SubagentRunId = "subagent-bbbbbbbb";
    createSessionStore({ sessionId, workspace, runtime });
    const narrowedExplorerCapability = narrowSubagentCapabilityLimits(
      explorerCapability,
      { maxTurns: 8, deadlineMs: 60_000 },
    );

    const continuation = (
      agentId: AgentId,
      runId: SubagentRunId,
      previousRunId: SubagentRunId,
      toolCallId: string,
    ): SubagentAcceptedLifecycle => ({
      ...acceptedLifecycle(agentId, runId),
      delegationId: `parent:${toolCallId}`,
      parentToolCallId: toolCallId,
      lineage: { kind: "continuation", previousRunId },
    });

    try {
      const history = createAgentTreeHistory({ sessionId, runtime });
      const first = history.persistence.accepted(
        acceptedLifecycle(childAgentId, firstRunId),
      );
      first.transcript.initialize([]);
      first.running().terminal({
        status: "completed",
        finalText: "first complete",
        error: null,
        pendingInputCount: 0,
        usage: {
          inputTokens: 1,
          cachedInputTokens: 0,
          uncachedInputTokens: 1,
          outputTokens: 1,
        },
        turns: 1,
        costUsd: 0,
      });
      expect(() =>
        history.persistence.accepted({
          ...continuation(
            childAgentId,
            "subagent-12121212",
            firstRunId,
            "capability-expansion",
          ),
          capability: reviewerCapability,
        }),
      ).toThrow("expands thread capability baseProfile");
      const second = history.persistence.accepted({
        ...continuation(childAgentId, secondRunId, firstRunId, "second"),
        capability: narrowedExplorerCapability,
      });
      second.transcript.initialize([]);
      const secondRunning = second.running();

      expect(() =>
        history.persistence.accepted(
          continuation(
            childAgentId,
            "subagent-cccccccc",
            "subagent-ffffffff",
            "unknown",
          ),
        ),
      ).toThrow("references unknown run");
      expect(() =>
        history.persistence.accepted(
          continuation(
            "agent-dddddddd",
            "subagent-dddddddd",
            firstRunId,
            "different-agent",
          ),
        ),
      ).toThrow("changes child agent identity");
      expect(() =>
        history.persistence.accepted({
          ...continuation(
            childAgentId,
            "subagent-eeeeeeee",
            secondRunId,
            "active",
          ),
          capability: narrowedExplorerCapability,
        }),
      ).toThrow("follows a non-terminal run");

      secondRunning.terminal({
        status: "completed",
        finalText: "second complete",
        error: null,
        pendingInputCount: 0,
        usage: {
          inputTokens: 1,
          cachedInputTokens: 0,
          uncachedInputTokens: 1,
          outputTokens: 1,
        },
        turns: 1,
        costUsd: 0,
      });
      expect(() =>
        history.persistence.accepted(
          continuation(
            childAgentId,
            "subagent-11111111",
            secondRunId,
            "capability-expansion",
          ),
        ),
      ).toThrow("expands maxTurns");
      expect(() =>
        history.persistence.accepted({
          ...continuation(
            childAgentId,
            "subagent-ffffffff",
            firstRunId,
            "stale",
          ),
          capability: narrowedExplorerCapability,
        }),
      ).toThrow("does not follow the latest run");
      expect(history.runs(childAgentId)).toHaveLength(2);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a Run transcript has one durable pending-input event,
    When terminal persistence claims that no input is pending,
    Then the store rejects the contradictory terminal fact`, async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-pending-input-truth-"),
    );
    const keelHome = join(workspace, ".keel-home");
    let now = 1_700_000_000_000;
    const runtime = {
      env: (key: string) => (key === "KEEL_HOME" ? keelHome : undefined),
      now: () => now++,
    };
    const sessionId = "pending-input-truth";
    createSessionStore({ sessionId, workspace, runtime });

    try {
      const history = createAgentTreeHistory({ sessionId, runtime });
      const run = history.persistence.accepted(
        acceptedLifecycle(
          "agent-12121212-1212-4212-8212-121212121212",
          "subagent-12121212-1212-4212-8212-121212121212",
        ),
      );
      run.transcript.initialize([]);
      const running = run.running();
      running.pendingInput([
        {
          role: "user",
          content: "Inspect one more caller.",
          origin: { type: "runtime_subagent_input" },
        },
      ]);

      expect(() =>
        running.terminal({
          status: "failed",
          finalText: null,
          error: "provider failed before the input boundary",
          pendingInputCount: 0,
          usage: {
            inputTokens: 1,
            cachedInputTokens: 0,
            uncachedInputTokens: 1,
            outputTokens: 0,
          },
          turns: 1,
          costUsd: 0,
        }),
      ).toThrow("conflicting terminal");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given one durable rejection and one accepted child move through the live lifecycle,
    When callers inspect each state and accidentally reuse stale lifecycle handles,
    Then history stays truthful and terminal facts cannot be mutated`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-agent-tree-"));
    const keelHome = join(workspace, ".keel-home");
    let now = 1_700_000_000_000;
    const runtime = {
      env: (key: string) => (key === "KEEL_HOME" ? keelHome : undefined),
      now: () => now++,
    };
    createSessionStore({ sessionId: "live-lifecycle", workspace, runtime });
    const lifecycle = acceptedLifecycle(
      "agent-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "subagent-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    );

    try {
      const history = createAgentTreeHistory({
        sessionId: "live-lifecycle",
        runtime,
      });
      history.persistence.rejected({
        delegationId: "parent:hard-rejection",
        parentRunId: "parent",
        parentToolCallId: "hard-rejection",
        task: "Do not admit this child.",
        reason: "Delegation rejected before admission.",
      });
      expect(history.entries()).toEqual([]);

      const run = history.persistence.accepted(lifecycle);
      run.transcript.initialize([
        {
          role: "user",
          content: "Inspect the live child.",
          origin: { type: "runtime_subagent_delegation" },
        },
      ]);
      run.transcript.replace([
        {
          role: "user",
          content: "Inspect only the durable boundary.",
          origin: { type: "runtime_subagent_delegation" },
        },
      ]);
      const queued = history.entries()[0];
      if (queued === undefined) throw new Error("missing queued child");
      expect(queued).toMatchObject({ status: "queued", result: null });
      expect(history.transcript(queued)).toContain(
        "Inspect only the durable boundary.",
      );
      expect(history.messages(queued)).toMatchObject([
        { role: "user", content: "Inspect only the durable boundary." },
      ]);

      const running = run.running();
      expect(() => run.running()).toThrow("started twice");
      running.accounting({
        usage: {
          inputTokens: 30,
          cachedInputTokens: 10,
          uncachedInputTokens: 20,
          outputTokens: 5,
        },
        turns: 1,
        costUsd: 0.00004,
      });
      expect(history.entries()).toMatchObject([
        { status: "running", accounting: { turns: 1 }, result: null },
      ]);
      running.terminal({
        status: "failed",
        finalText: null,
        error: "Provider rejected the request.",
        pendingInputCount: 0,
        usage: {
          inputTokens: 30,
          cachedInputTokens: 10,
          uncachedInputTokens: 20,
          outputTokens: 5,
        },
        turns: 1,
        costUsd: 0.00004,
      });

      expect(() =>
        running.accounting({
          usage: {
            inputTokens: 40,
            cachedInputTokens: 10,
            uncachedInputTokens: 30,
            outputTokens: 6,
          },
          turns: 2,
          costUsd: 0.00006,
        }),
      ).toThrow("is terminal");
      expect(() =>
        running.terminal({
          status: "completed",
          finalText: "must not replace the failure",
          error: null,
          pendingInputCount: 0,
          usage: {
            inputTokens: 40,
            cachedInputTokens: 10,
            uncachedInputTokens: 30,
            outputTokens: 6,
          },
          turns: 2,
          costUsd: 0.00006,
        }),
      ).toThrow("is terminal");
      expect(() => history.persistence.accepted(lifecycle)).toThrow(
        "duplicate child agent id",
      );

      const cancelledBeforeStart = history.persistence.accepted(
        acceptedLifecycle(
          "agent-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaac",
          "subagent-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaac",
        ),
      );
      cancelledBeforeStart.terminal({
        status: "cancelled",
        finalText: null,
        error: "Child was cancelled before execution started.",
        pendingInputCount: 0,
        usage: {
          inputTokens: 0,
          cachedInputTokens: 0,
          uncachedInputTokens: 0,
          outputTokens: 0,
        },
        turns: 0,
        costUsd: 0,
      });

      const reopened = createAgentTreeHistory({
        sessionId: "live-lifecycle",
        runtime,
      });
      const failed = reopened.entries()[0];
      if (failed === undefined) throw new Error("missing failed child");
      expect(failed).toMatchObject({
        status: "failed",
        result: {
          status: "failed",
          error: "Provider rejected the request.",
        },
      });
      expect(reopened.transcript(failed)).toContain(
        '"type":"transcript_terminal","status":"failed","pendingInputCount":0,"complete":true',
      );
      const cancelled = reopened.entries()[1];
      if (cancelled === undefined) throw new Error("missing cancelled child");
      expect(reopened.transcript(cancelled)).toContain(
        '"type":"transcript_initialize","messages":[]',
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given secret-like text crosses every child-history persistence boundary,
    When a rejected delegation and a completed child are stored,
    Then raw secrets never reach either durable JSONL ledger`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-agent-redaction-"));
    const keelHome = join(workspace, ".keel-home");
    let now = 1_700_000_000_000;
    const runtime = {
      env: (key: string) => (key === "KEEL_HOME" ? keelHome : undefined),
      now: () => now++,
    };
    const sessionId = "redacted-history";
    const secrets = {
      task: "sk-taskSecret123456",
      prompt: "sk-promptSecret123456",
      message: "sk-messageSecret123456",
      result: "sk-resultSecret123456",
      rejection: "sk-rejectionSecret123456",
    };
    createSessionStore({ sessionId, workspace, runtime });

    try {
      const history = createAgentTreeHistory({ sessionId, runtime });
      history.persistence.rejected({
        delegationId: "parent:secret-rejection",
        parentRunId: "parent",
        parentToolCallId: "secret-rejection",
        task: secrets.task,
        reason: secrets.rejection,
      });
      const run = history.persistence.accepted({
        ...acceptedLifecycle(
          "agent-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab",
          "subagent-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab",
        ),
        task: secrets.task,
        systemPrompt: secrets.prompt,
      });
      run.transcript.initialize([
        {
          role: "user",
          content: secrets.message,
          origin: { type: "runtime_subagent_delegation" },
        },
      ]);
      run.running().terminal({
        status: "completed",
        finalText: secrets.result,
        error: null,
        pendingInputCount: 0,
        usage: {
          inputTokens: 10,
          cachedInputTokens: 0,
          uncachedInputTokens: 10,
          outputTokens: 2,
        },
        turns: 1,
        costUsd: 0.0001,
      });

      const agentsDirectory = join(keelHome, "sessions", sessionId, "agents");
      const durableText = [
        await readFile(join(agentsDirectory, "events.jsonl"), "utf8"),
        await readFile(
          join(
            agentsDirectory,
            "transcripts",
            "subagent-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab.jsonl",
          ),
          "utf8",
        ),
      ].join("\n");
      expect(durableText).toContain("[REDACTED_SECRET]");
      for (const secret of Object.values(secrets)) {
        expect(durableText).not.toContain(secret);
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  const missingTranscriptStatuses: readonly ("running" | "completed")[] = [
    "running",
    "completed",
  ];
  test.each(missingTranscriptStatuses)(
    `Given a $status child has an accepted event but its transcript file is missing,
    When saved history is reopened,
    Then recovery fails closed instead of fabricating an empty transcript`,
    async (status) => {
      const workspace = await mkdtemp(join(tmpdir(), "keel-agent-missing-"));
      const keelHome = join(workspace, ".keel-home");
      let now = 1_700_000_000_000;
      const runtime = {
        env: (key: string) => (key === "KEEL_HOME" ? keelHome : undefined),
        now: () => now++,
      };
      const sessionId = `missing-${status}`;
      const lifecycle = acceptedLifecycle(
        "agent-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        "subagent-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      );
      createSessionStore({ sessionId, workspace, runtime });

      try {
        const history = createAgentTreeHistory({ sessionId, runtime });
        const run = history.persistence.accepted(lifecycle);
        run.transcript.initialize([
          {
            role: "user",
            content: "Inspect before the transcript disappears.",
            origin: { type: "runtime_subagent_delegation" },
          },
        ]);
        const running = run.running();
        if (status === "completed") {
          running.terminal({
            status: "completed",
            finalText: "Done.",
            error: null,
            pendingInputCount: 0,
            usage: {
              inputTokens: 10,
              cachedInputTokens: 0,
              uncachedInputTokens: 10,
              outputTokens: 2,
            },
            turns: 1,
            costUsd: 0.0001,
          });
        }
        await rm(
          join(
            keelHome,
            "sessions",
            sessionId,
            "agents",
            "transcripts",
            `${lifecycle.childRunId}.jsonl`,
          ),
        );

        expect(() => createAgentTreeHistory({ sessionId, runtime })).toThrow(
          "cannot read",
        );
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    },
  );

  test(`Given a completed child has a canonical result and transcript,
    When the saved session history is opened again,
    Then its terminal facts remain unchanged and are not duplicated`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-agent-tree-"));
    const keelHome = join(workspace, ".keel-home");
    let now = 1_700_000_000_000;
    const runtime = {
      env: (key: string) => (key === "KEEL_HOME" ? keelHome : undefined),
      now: () => now++,
    };
    createSessionStore({ sessionId: "completed", workspace, runtime });
    const lifecycle = acceptedLifecycle(
      "agent-11111111-1111-4111-8111-111111111111",
      "subagent-11111111-1111-4111-8111-111111111111",
    );

    try {
      const history = createAgentTreeHistory({
        sessionId: "completed",
        runtime,
      });
      const run = history.persistence.accepted(lifecycle);
      run.transcript.initialize([
        {
          role: "user",
          content: "Inspect the module.",
          origin: { type: "runtime_subagent_delegation" },
        },
      ]);
      const running = run.running();
      running.accounting({
        usage: {
          inputTokens: 100,
          cachedInputTokens: 0,
          uncachedInputTokens: 100,
          outputTokens: 20,
        },
        turns: 1,
        costUsd: 0.00014,
      });
      running.terminal({
        status: "completed",
        finalText: "The module exports 42.",
        error: null,
        pendingInputCount: 0,
        usage: {
          inputTokens: 100,
          cachedInputTokens: 0,
          uncachedInputTokens: 100,
          outputTokens: 20,
        },
        turns: 1,
        costUsd: 0.00014,
      });
      const eventPath = join(
        keelHome,
        "sessions",
        "completed",
        "agents",
        "events.jsonl",
      );
      const beforeCrash = (await readFile(eventPath, "utf8"))
        .trimEnd()
        .split("\n");
      expect(beforeCrash.at(-1)).toContain('"type":"agent_run_terminal"');
      await writeFile(
        eventPath,
        `${beforeCrash.slice(0, -1).join("\n")}\n`,
        "utf8",
      );

      const reopened = createAgentTreeHistory({
        sessionId: "completed",
        runtime,
      });
      expect(reopened.entries()).toMatchObject([
        {
          status: "completed",
          result: {
            status: "completed",
            finalText: "The module exports 42.",
          },
        },
      ]);
      const events = await readFile(eventPath, "utf8");
      expect(events.match(/"type":"agent_result"/gu)).toHaveLength(1);
      expect(events.match(/"type":"agent_run_terminal"/gu)).toHaveLength(1);
      const transcriptPath = join(
        keelHome,
        "sessions",
        "completed",
        "agents",
        "transcripts",
        `${lifecycle.childRunId}.jsonl`,
      );
      const transcriptLines = (await readFile(transcriptPath, "utf8"))
        .trimEnd()
        .split("\n");
      expect(transcriptLines.at(-1)).toContain('"type":"transcript_terminal"');
      await writeFile(
        transcriptPath,
        `${transcriptLines.slice(0, -1).join("\n")}\n`,
        "utf8",
      );
      createAgentTreeHistory({ sessionId: "completed", runtime });
      expect(
        (await readFile(transcriptPath, "utf8")).match(
          /"type":"transcript_terminal"/gu,
        ),
      ).toHaveLength(1);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a child with Unicode lifecycle data was running when its saved-session owner exited,
    When the exclusive owner opens the history repeatedly,
    Then recovery writes one interrupted result and marks the partial transcript incomplete`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-agent-tree-"));
    const keelHome = join(workspace, ".keel-home");
    let now = 1_700_000_000_000;
    const runtime = {
      env: (key: string) => (key === "KEEL_HOME" ? keelHome : undefined),
      now: () => now++,
    };
    createSessionStore({ sessionId: "interrupted", workspace, runtime });
    const lifecycle: SubagentAcceptedLifecycle = {
      ...acceptedLifecycle(
        "agent-22222222-2222-4222-8222-222222222222",
        "subagent-22222222-2222-4222-8222-222222222222",
      ),
      task: "检查持久化的 child 生命周期。",
      systemPrompt: "只读调查；保留可信证据。",
    };

    try {
      const history = createAgentTreeHistory({
        sessionId: "interrupted",
        runtime,
      });
      const run = history.persistence.accepted(lifecycle);
      run.transcript.initialize([
        {
          role: "user",
          content: "Inspect the module.",
          origin: { type: "runtime_subagent_delegation" },
        },
      ]);
      run.transcript.append([
        {
          role: "assistant",
          content: "partial evidence",
          toolCalls: [],
        },
      ]);
      const running = run.running();
      running.accounting({
        usage: {
          inputTokens: 80,
          cachedInputTokens: 0,
          uncachedInputTokens: 80,
          outputTokens: 10,
        },
        turns: 1,
        costUsd: 0.0001,
      });
      await appendFile(
        join(keelHome, "sessions", "interrupted", "agents", "events.jsonl"),
        '{"schemaVersion":8,"type":"agent_result"',
        "utf8",
      );
      await appendFile(
        join(
          keelHome,
          "sessions",
          "interrupted",
          "agents",
          "transcripts",
          `${lifecycle.childRunId}.jsonl`,
        ),
        '{"schemaVersion":8,"type":"transcript_append"',
        "utf8",
      );

      const recovered = createAgentTreeHistory({
        sessionId: "interrupted",
        runtime,
      });
      expect(recovered.entries()).toMatchObject([
        {
          status: "interrupted",
          accounting: { turns: 1, costUsd: 0.0001 },
          result: { status: "interrupted" },
        },
      ]);
      const recoveredEntry = recovered.entries()[0];
      if (recoveredEntry === undefined)
        throw new Error("missing recovered child");
      expect(recovered.transcript(recoveredEntry)).toContain(
        '"type":"transcript_terminal","status":"interrupted","pendingInputCount":0,"complete":false',
      );

      const reopenedAgain = createAgentTreeHistory({
        sessionId: "interrupted",
        runtime,
      });
      expect(reopenedAgain.entries()).toMatchObject([
        { status: "interrupted" },
      ]);
      const events = await readFile(
        join(keelHome, "sessions", "interrupted", "agents", "events.jsonl"),
        "utf8",
      );
      expect(events.match(/"type":"agent_result"/gu)).toHaveLength(1);
      expect(events.match(/"type":"agent_run_terminal"/gu)).toHaveLength(1);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a child persisted running immediately before its transcript initialization,
    When the foreground owner exits in that valid crash window,
    Then recovery creates one empty initialization and one incomplete interrupted terminal`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-agent-tree-"));
    const keelHome = join(workspace, ".keel-home");
    let now = 1_700_000_000_000;
    const runtime = {
      env: (key: string) => (key === "KEEL_HOME" ? keelHome : undefined),
      now: () => now++,
    };
    const sessionId = "running-before-transcript-initialize";
    const lifecycle = acceptedLifecycle(
      "agent-44444444-4444-4444-8444-444444444444",
      "subagent-44444444-4444-4444-8444-444444444444",
    );
    createSessionStore({ sessionId, workspace, runtime });

    try {
      const history = createAgentTreeHistory({ sessionId, runtime });
      history.persistence.accepted(lifecycle).running();

      const recovered = createAgentTreeHistory({ sessionId, runtime });
      const recoveredEntry = recovered.entries()[0];
      if (recoveredEntry === undefined)
        throw new Error("missing recovered child");
      expect(recoveredEntry).toMatchObject({
        status: "interrupted",
        result: { status: "interrupted" },
      });
      const transcript = recovered.transcript(recoveredEntry);
      expect(
        transcript.match(/"type":"transcript_initialize","messages":\[\]/gu),
      ).toHaveLength(1);
      expect(
        transcript.match(
          /"type":"transcript_terminal","status":"interrupted","pendingInputCount":0,"complete":false/gu,
        ),
      ).toHaveLength(1);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a running child result is durable but its transcript still has only a header,
    When recovery inspects the completed lifecycle,
    Then it rejects the missing started transcript instead of fabricating one`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-agent-tree-"));
    const keelHome = join(workspace, ".keel-home");
    let now = 1_700_000_000_000;
    const runtime = {
      env: (key: string) => (key === "KEEL_HOME" ? keelHome : undefined),
      now: () => now++,
    };
    const sessionId = "running-result-without-transcript";
    const lifecycle = acceptedLifecycle(
      "agent-66666666-6666-4666-8666-666666666666",
      "subagent-66666666-6666-4666-8666-666666666666",
    );
    createSessionStore({ sessionId, workspace, runtime });

    try {
      const history = createAgentTreeHistory({ sessionId, runtime });
      const running = history.persistence.accepted(lifecycle).running();
      expect(() =>
        running.terminal({
          status: "completed",
          finalText: "Done.",
          error: null,
          pendingInputCount: 0,
          usage: {
            inputTokens: 10,
            cachedInputTokens: 0,
            uncachedInputTokens: 10,
            outputTokens: 2,
          },
          turns: 1,
          costUsd: 0.0001,
        }),
      ).toThrow("was never initialized");
      expect(() => createAgentTreeHistory({ sessionId, runtime })).toThrow(
        "was never initialized",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given accounting proves a running child initialized its transcript,
    When the transcript is later truncated back to its header,
    Then recovery rejects the lost evidence instead of synthesizing an empty transcript`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-agent-tree-"));
    const keelHome = join(workspace, ".keel-home");
    let now = 1_700_000_000_000;
    const runtime = {
      env: (key: string) => (key === "KEEL_HOME" ? keelHome : undefined),
      now: () => now++,
    };
    const sessionId = "accounted-transcript-truncated";
    const lifecycle = acceptedLifecycle(
      "agent-77777777-7777-4777-8777-777777777777",
      "subagent-77777777-7777-4777-8777-777777777777",
    );
    createSessionStore({ sessionId, workspace, runtime });

    try {
      const history = createAgentTreeHistory({ sessionId, runtime });
      const run = history.persistence.accepted(lifecycle);
      run.transcript.initialize([]);
      run.running().accounting({
        usage: {
          inputTokens: 10,
          cachedInputTokens: 0,
          uncachedInputTokens: 10,
          outputTokens: 2,
        },
        turns: 1,
        costUsd: 0.0001,
      });
      const transcriptPath = join(
        keelHome,
        "sessions",
        sessionId,
        "agents",
        "transcripts",
        `${lifecycle.childRunId}.jsonl`,
      );
      const header = (await readFile(transcriptPath, "utf8")).split("\n")[0];
      if (header === undefined) throw new Error("missing transcript header");
      await writeFile(transcriptPath, `${header}\n`, "utf8");

      expect(() => createAgentTreeHistory({ sessionId, runtime })).toThrow(
        "was never initialized",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an accepted child never reached running but its ledger claims completion,
    When the untrusted history is replayed,
    Then the impossible queued result is rejected`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-agent-tree-"));
    const keelHome = join(workspace, ".keel-home");
    let now = 1_700_000_000_000;
    const runtime = {
      env: (key: string) => (key === "KEEL_HOME" ? keelHome : undefined),
      now: () => now++,
    };
    const sessionId = "queued-completed-result";
    const lifecycle = acceptedLifecycle(
      "agent-88888888-8888-4888-8888-888888888888",
      "subagent-88888888-8888-4888-8888-888888888888",
    );
    createSessionStore({ sessionId, workspace, runtime });

    try {
      const history = createAgentTreeHistory({ sessionId, runtime });
      history.persistence.accepted(lifecycle);
      await appendFile(
        join(keelHome, "sessions", sessionId, "agents", "events.jsonl"),
        `${JSON.stringify(resultRecord(acceptedRecord(lifecycle, sessionId)))}\n`,
        "utf8",
      );

      expect(() => createAgentTreeHistory({ sessionId, runtime })).toThrow(
        "completed before execution started",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a saved child transcript contradicts its acceptance or has an invalid middle record,
    When local history inspection reads that transcript,
    Then the disk trust boundary fails closed instead of rendering raw content`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-agent-tree-"));
    const keelHome = join(workspace, ".keel-home");
    let now = 1_700_000_000_000;
    const runtime = {
      env: (key: string) => (key === "KEEL_HOME" ? keelHome : undefined),
      now: () => now++,
    };
    createSessionStore({ sessionId: "corrupt-transcript", workspace, runtime });
    const lifecycle = acceptedLifecycle(
      "agent-55555555-5555-4555-8555-555555555555",
      "subagent-55555555-5555-4555-8555-555555555555",
    );

    try {
      const history = createAgentTreeHistory({
        sessionId: "corrupt-transcript",
        runtime,
      });
      const run = history.persistence.accepted(lifecycle);
      run.transcript.initialize([
        {
          role: "user",
          content: "Inspect the module.",
          origin: { type: "runtime_subagent_delegation" },
        },
      ]);
      const running = run.running();
      running.terminal({
        status: "completed",
        finalText: "Done.",
        error: null,
        pendingInputCount: 0,
        usage: {
          inputTokens: 10,
          cachedInputTokens: 0,
          uncachedInputTokens: 10,
          outputTokens: 2,
        },
        turns: 1,
        costUsd: 0.0001,
      });
      const transcriptPath = join(
        keelHome,
        "sessions",
        "corrupt-transcript",
        "agents",
        "transcripts",
        `${lifecycle.childRunId}.jsonl`,
      );
      const lines = (await readFile(transcriptPath, "utf8"))
        .trimEnd()
        .split("\n");
      const inspectTranscript = (): string => {
        const entry = history.entries()[0];
        if (entry === undefined) throw new Error("missing transcript entry");
        return history.transcript(entry);
      };
      const originalHeader = lines[0];
      if (originalHeader === undefined)
        throw new Error("missing transcript header");
      const terminalIndex = lines.length - 1;
      const originalTerminal = lines[terminalIndex];
      if (originalTerminal === undefined)
        throw new Error("missing transcript terminal");
      const originalLines = [...lines];
      lines[terminalIndex] = originalTerminal.replace(
        '"status":"completed"',
        '"status":"failed"',
      );
      await writeFile(transcriptPath, `${lines.join("\n")}\n`, "utf8");
      expect(inspectTranscript).toThrow("conflicting terminal");

      lines[terminalIndex] = originalTerminal.replace(
        '"pendingInputCount":0',
        '"pendingInputCount":1',
      );
      await writeFile(transcriptPath, `${lines.join("\n")}\n`, "utf8");
      expect(inspectTranscript).toThrow("conflicting terminal");

      lines[terminalIndex] = originalTerminal.replace(
        '"complete":true',
        '"complete":false',
      );
      await writeFile(transcriptPath, `${lines.join("\n")}\n`, "utf8");
      expect(inspectTranscript).toThrow("conflicting terminal");
      expect(() =>
        createAgentTreeHistory({ sessionId: "corrupt-transcript", runtime }),
      ).toThrow("conflicting terminal");

      lines[terminalIndex] = originalTerminal;
      const changedHeader = originalHeader.replace(
        '"model":"deepseek-chat"',
        '"model":"tampered-model"',
      );
      lines[0] = changedHeader;
      await writeFile(transcriptPath, `${lines.join("\n")}\n`, "utf8");
      expect(inspectTranscript).toThrow("identity mismatches acceptance");

      lines[0] = originalHeader.replace(
        JSON.stringify(explorerCapability),
        JSON.stringify(reviewerCapability),
      );
      await writeFile(transcriptPath, `${lines.join("\n")}\n`, "utf8");
      expect(inspectTranscript).toThrow("identity mismatches acceptance");

      lines[0] = originalHeader;
      lines[1] =
        '{"schemaVersion":8,"type":"transcript_initialize","messages":[{"role":"assistant"}]}';
      await writeFile(transcriptPath, `${lines.join("\n")}\n`, "utf8");
      expect(inspectTranscript).toThrow("invalid agent transcript record");

      await writeFile(
        transcriptPath,
        `${originalLines.slice(0, -1).join("\n")}\n`,
        "utf8",
      );
      expect(inspectTranscript).toThrow("has no terminal record");

      const initializeLine = originalLines[1];
      if (initializeLine === undefined)
        throw new Error("missing transcript initialization");
      await writeFile(
        transcriptPath,
        `${originalLines.join("\n")}\n${initializeLine}\n`,
        "utf8",
      );
      expect(inspectTranscript).toThrow("changed after terminal");

      const appendLine = initializeLine.replace(
        '"type":"transcript_initialize"',
        '"type":"transcript_append"',
      );
      await writeFile(
        transcriptPath,
        `${originalHeader}\n${appendLine}\n${originalTerminal}\n`,
        "utf8",
      );
      expect(inspectTranscript).toThrow("changed before initialization");

      await writeFile(
        transcriptPath,
        `${originalHeader}\n${initializeLine}\n${initializeLine}\n${originalTerminal}\n`,
        "utf8",
      );
      expect(inspectTranscript).toThrow("initialized more than once");

      await writeFile(
        transcriptPath,
        `${originalHeader}\n${originalTerminal}\n`,
        "utf8",
      );
      expect(inspectTranscript).toThrow("terminated before initialization");

      await writeFile(
        transcriptPath,
        '{"schemaVersion":8,"type":"unknown"}\n',
        "utf8",
      );
      expect(inspectTranscript).toThrow("invalid agent transcript header");

      await writeFile(transcriptPath, `${originalLines.join("\n")}\n`, "utf8");
      const transcriptsDirectory = join(
        keelHome,
        "sessions",
        "corrupt-transcript",
        "agents",
        "transcripts",
      );
      expect(() =>
        transcriptFilePath(transcriptsDirectory, "subagent-../../outside"),
      ).toThrow("invalid child run id");
      const orphanPath = join(transcriptsDirectory, "subagent-deadbeef.jsonl");
      const invalidNamePath = join(transcriptsDirectory, "notes.jsonl");
      const unrelatedPath = join(transcriptsDirectory, "notes.txt");
      await writeFile(orphanPath, "orphan", "utf8");
      await writeFile(invalidNamePath, "invalid agent id", "utf8");
      await writeFile(unrelatedPath, "unrelated", "utf8");
      createAgentTreeHistory({ sessionId: "corrupt-transcript", runtime });
      await expect(readFile(orphanPath, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(readFile(invalidNamePath, "utf8")).resolves.toBe(
        "invalid agent id",
      );
      await expect(readFile(unrelatedPath, "utf8")).resolves.toBe("unrelated");

      const openLifecycle = acceptedLifecycle(
        "agent-66666666-6666-4666-8666-666666666666",
        "subagent-66666666-6666-4666-8666-666666666666",
      );
      history.persistence.accepted(openLifecycle);
      const openEntry = history.entries()[1];
      if (openEntry === undefined) throw new Error("missing open child");
      await appendFile(
        join(transcriptsDirectory, `${openLifecycle.childRunId}.jsonl`),
        '{"schemaVersion":8,"type":"transcript_initialize","messages":[]}\n{"schemaVersion":8,"type":"transcript_terminal","status":"completed","pendingInputCount":0,"complete":true}\n',
        "utf8",
      );
      expect(() => history.transcript(openEntry)).toThrow(
        "open agent transcript",
      );
      expect(() =>
        createAgentTreeHistory({ sessionId: "corrupt-transcript", runtime }),
      ).toThrow("terminated before its interrupted result");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given current-schema agent events violate identity, ordering, or terminal immutability,
    When the exclusive owner replays the append-only ledger,
    Then every invalid lifecycle is rejected before recovery can rewrite history`, async () => {
    const scenarios: readonly {
      readonly id: string;
      readonly mutations: (
        accepted: AgentRunAcceptedRecord,
      ) => readonly object[];
      readonly expected: string;
    }[] = [
      {
        id: "wrong-run",
        mutations: (accepted) => [
          accepted,
          {
            ...runningRecord(accepted),
            childRunId: "subagent-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          },
        ],
        expected: "references unknown run",
      },
      {
        id: "duplicate-acceptance",
        mutations: (accepted) => [accepted, accepted],
        expected: "duplicate child agent id",
      },
      {
        id: "duplicate-delegation",
        mutations: (accepted) => [
          accepted,
          {
            ...accepted,
            childAgentId: "agent-dddddddd-dddd-4ddd-8ddd-dddddddddddd",
            childRunId: "subagent-dddddddd-dddd-4ddd-8ddd-dddddddddddd",
            parentToolCallId: "different-tool",
            transcriptRef:
              "agent-transcript:test/agent-dddddddd-dddd-4ddd-8ddd-dddddddddddd",
          },
        ],
        expected: "duplicate delegation id",
      },
      {
        id: "duplicate-parent-tool",
        mutations: (accepted) => [
          accepted,
          {
            ...accepted,
            delegationId: "parent:different-delegation",
            childAgentId: "agent-dddddddd-dddd-4ddd-8ddd-dddddddddddd",
            childRunId: "subagent-dddddddd-dddd-4ddd-8ddd-dddddddddddd",
            transcriptRef:
              "agent-transcript:test/agent-dddddddd-dddd-4ddd-8ddd-dddddddddddd",
          },
        ],
        expected: "duplicate parent tool call",
      },
      {
        id: "duplicate-child-run",
        mutations: (accepted) => [
          accepted,
          {
            ...accepted,
            delegationId: "parent:different-tool",
            childAgentId: "agent-dddddddd-dddd-4ddd-8ddd-dddddddddddd",
            parentToolCallId: "different-tool",
            transcriptRef:
              "agent-transcript:test/agent-dddddddd-dddd-4ddd-8ddd-dddddddddddd",
          },
        ],
        expected: "duplicate child run id",
      },
      {
        id: "double-start",
        mutations: (accepted) => [
          accepted,
          runningRecord(accepted),
          runningRecord(accepted),
        ],
        expected: "started twice",
      },
      {
        id: "early-accounting",
        mutations: (accepted) => [accepted, accountingRecord(accepted)],
        expected: "accounting outside a running lifecycle",
      },
      {
        id: "duplicate-result",
        mutations: (accepted) => [
          accepted,
          runningRecord(accepted),
          resultRecord(accepted),
          resultRecord(accepted),
        ],
        expected: "duplicate result",
      },
      {
        id: "delegation-mismatch",
        mutations: (accepted) => {
          const result = resultRecord(accepted);
          return [
            accepted,
            {
              ...result,
              result: { ...result.result, delegationId: "another:delegation" },
            },
          ];
        },
        expected: "result identity mismatches acceptance",
      },
      {
        id: "terminal-without-result",
        mutations: (accepted) => [accepted, terminalRecord(accepted)],
        expected: "terminated without exactly one result",
      },
      {
        id: "terminal-status-mismatch",
        mutations: (accepted) => [
          accepted,
          runningRecord(accepted),
          resultRecord(accepted),
          terminalRecord(accepted, "failed"),
        ],
        expected: "terminal status mismatches result",
      },
    ];

    for (const scenario of scenarios) {
      const workspace = await mkdtemp(join(tmpdir(), "keel-agent-tree-"));
      const keelHome = join(workspace, ".keel-home");
      let now = 1_700_000_000_000;
      const runtime = {
        env: (key: string) => (key === "KEEL_HOME" ? keelHome : undefined),
        now: () => now++,
      };
      const sessionId = `invalid-order-${scenario.id}`;
      const lifecycle = acceptedLifecycle(
        "agent-cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        "subagent-cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      );
      const accepted = acceptedRecord(lifecycle, sessionId);
      createSessionStore({ sessionId, workspace, runtime });

      try {
        createAgentTreeHistory({ sessionId, runtime });
        const events = [
          {
            schemaVersion: AGENT_TREE_SCHEMA_VERSION,
            type: "agent_tree",
            sessionId,
            createdAt: "2023-11-14T22:13:20.000Z",
          },
          ...scenario.mutations(accepted),
        ];
        await writeFile(
          join(keelHome, "sessions", sessionId, "agents", "events.jsonl"),
          `${events.map((record) => JSON.stringify(record)).join("\n")}\n`,
          "utf8",
        );

        expect(
          () => createAgentTreeHistory({ sessionId, runtime }),
          scenario.id,
        ).toThrow(scenario.expected);
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    }
  });

  test.each([
    {
      id: "empty",
      name: "an empty ledger",
      events: () => "\n",
      expected: "is empty",
    },
    {
      id: "header",
      name: "an invalid header",
      events: () =>
        `${JSON.stringify({ schemaVersion: AGENT_TREE_SCHEMA_VERSION, type: "unknown" })}\n`,
      expected: "invalid agent tree header",
    },
    {
      id: "session",
      name: "a header for another session",
      events: (sessionId: string) =>
        `${JSON.stringify({
          schemaVersion: AGENT_TREE_SCHEMA_VERSION,
          type: "agent_tree",
          sessionId: `${sessionId}-other`,
          createdAt: "2023-11-14T22:13:20.000Z",
        })}\n`,
      expected: "does not match",
    },
    {
      id: "json",
      name: "a malformed middle record",
      events: (sessionId: string) =>
        `${JSON.stringify({
          schemaVersion: AGENT_TREE_SCHEMA_VERSION,
          type: "agent_tree",
          sessionId,
          createdAt: "2023-11-14T22:13:20.000Z",
        })}\n{"schemaVersion":8,broken}\n`,
      expected: "cannot parse",
    },
    {
      id: "mutation",
      name: "an unsupported mutation",
      events: (sessionId: string) =>
        `${[
          {
            schemaVersion: AGENT_TREE_SCHEMA_VERSION,
            type: "agent_tree",
            sessionId,
            createdAt: "2023-11-14T22:13:20.000Z",
          },
          { schemaVersion: AGENT_TREE_SCHEMA_VERSION, type: "unknown" },
        ]
          .map((record) => JSON.stringify(record))
          .join("\n")}\n`,
      expected: "invalid agent tree record",
    },
  ])(
    `Given a saved session agent ledger contains $name,
    When the exclusive owner opens it,
    Then the disk trust boundary fails closed`,
    async ({ id, events, expected }) => {
      const workspace = await mkdtemp(join(tmpdir(), "keel-agent-tree-"));
      const keelHome = join(workspace, ".keel-home");
      let now = 1_700_000_000_000;
      const runtime = {
        env: (key: string) => (key === "KEEL_HOME" ? keelHome : undefined),
        now: () => now++,
      };
      const sessionId = `corrupt-tree-${id}`;
      createSessionStore({ sessionId, workspace, runtime });

      try {
        createAgentTreeHistory({ sessionId, runtime });
        await writeFile(
          join(keelHome, "sessions", sessionId, "agents", "events.jsonl"),
          events(sessionId),
          "utf8",
        );
        expect(() => createAgentTreeHistory({ sessionId, runtime })).toThrow(
          expected,
        );
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    },
  );
});
