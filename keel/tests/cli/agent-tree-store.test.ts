import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { narrowSubagentCapabilityLimits } from "../../src/agent/subagent-capability.ts";
import type {
  AgentId,
  PersistedSubagentCanonicalResult,
  ReadOnlySubagentAcceptedLifecycle,
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
import {
  AGENT_TREE_SCHEMA_VERSION,
  mutationRecordSchema,
} from "../../src/cli/agent-tree-store/model.ts";
import { transcriptFilePath } from "../../src/cli/agent-tree-store/transcript.ts";
import { createAgentTreeHistory } from "../../src/cli/agent-tree-store.ts";
import { createSessionStore } from "../../src/cli/session-store.ts";

const explorerCapability = resolveBuiltinSubagentProfile("explorer").snapshot;
const reviewerCapability = resolveBuiltinSubagentProfile("reviewer").snapshot;
const writerCapability = resolveBuiltinSubagentProfile("writer").snapshot;

function acceptedLifecycle(
  childAgentId: AgentId,
  childRunId: SubagentRunId,
): ReadOnlySubagentAcceptedLifecycle {
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
    workspace: null,
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
    workspace: null,
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
  test(`Given one accepted foreground read-only delegation plus unsupported background and writer delegations,
    When the authoritative owner reconciles by the original parent Run and tool call,
    Then it returns exact durable evidence only for the supported foreground child`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-agent-tree-"));
    const keelHome = join(workspace, ".keel-home");
    const runtime = {
      env: (key: string) => (key === "KEEL_HOME" ? keelHome : undefined),
      now: () => 1_700_000_000_000,
    };
    const sessionId = "delegate-effect-reconciliation";
    const foreground = acceptedLifecycle(
      "agent-11111111-1111-4111-8111-111111111111",
      "subagent-11111111-1111-4111-8111-111111111111",
    );
    const background = {
      ...acceptedLifecycle(
        "agent-22222222-2222-4222-8222-222222222222",
        "subagent-22222222-2222-4222-8222-222222222222",
      ),
      mode: "background" as const,
    };
    const writer: SubagentAcceptedLifecycle = {
      ...acceptedLifecycle(
        "agent-33333333-3333-4333-8333-333333333333",
        "subagent-33333333-3333-4333-8333-333333333333",
      ),
      mode: "foreground",
      task: "Make one isolated change.",
      threadCapabilityCeiling: writerCapability,
      capability: writerCapability,
      workspace: {
        kind: "isolated_write",
        leaseId: "subagent-33333333-3333-4333-8333-333333333333",
        baseCommit: "a".repeat(40),
        branch: "keel/subagent/33333333-3333-4333-8333-333333333333",
        worktreePath: join(keelHome, "worktrees", "writer"),
        workspaceRoot: join(keelHome, "worktrees", "writer"),
      },
    };
    createSessionStore({ sessionId, workspace, runtime });

    try {
      const history = createAgentTreeHistory({ sessionId, runtime });
      const foregroundRun = history.persistence.accepted(foreground);
      expect(
        history.reconcileForegroundReadOnlyDelegate({
          parentRunId: foreground.parentRunId,
          parentToolCallId: foreground.parentToolCallId,
        }),
      ).toMatchObject({
        kind: "applied",
        evidence: { status: "queued", result: null },
      });
      foregroundRun.transcript.initialize([]);
      foregroundRun.running().terminal({
        status: "completed",
        finalText: "The inspected module is sound.",
        error: null,
        pendingInputCount: 0,
        workspace: null,
        usage: {
          inputTokens: 1,
          cachedInputTokens: 0,
          uncachedInputTokens: 1,
          outputTokens: 1,
        },
        turns: 1,
        costUsd: 0,
      });
      history.persistence.accepted(background);
      history.persistence.accepted(writer);

      const reopened = createAgentTreeHistory({ sessionId, runtime });

      expect(
        reopened.reconcileForegroundReadOnlyDelegate({
          parentRunId: foreground.parentRunId,
          parentToolCallId: foreground.parentToolCallId,
        }),
      ).toMatchObject({
        kind: "applied",
        evidence: {
          kind: "agent_tree_delegate",
          sessionId,
          delegationId: foreground.delegationId,
          childAgentId: foreground.childAgentId,
          childRunId: foreground.childRunId,
          parentRunId: foreground.parentRunId,
          parentToolCallId: foreground.parentToolCallId,
          status: "completed",
          result: {
            status: "completed",
            finalText: "The inspected module is sound.",
            error: null,
            pendingInputCount: 0,
          },
        },
      });
      expect(
        reopened.reconcileForegroundReadOnlyDelegate({
          parentRunId: foreground.parentRunId,
          parentToolCallId: "wrong-tool-call",
        }),
      ).toEqual({ kind: "unknown" });
      expect(
        reopened.reconcileForegroundReadOnlyDelegate({
          parentRunId: writer.parentRunId,
          parentToolCallId: writer.parentToolCallId,
        }),
      ).toEqual({ kind: "unknown" });
      expect(
        reopened.reconcileForegroundReadOnlyDelegate({
          parentRunId: background.parentRunId,
          parentToolCallId: background.parentToolCallId,
        }),
      ).toEqual({ kind: "unknown" });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

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
        workspace: null,
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
        workspace: null,
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
    ): ReadOnlySubagentAcceptedLifecycle => ({
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
        workspace: null,
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
        workspace: null,
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
          workspace: null,
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
        workspace: null,
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
          workspace: null,
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
        workspace: null,
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
      workspaceSummary: "sk-workspaceSummary123456",
      workspaceSuccessSummary: "sk-workspaceSuccessSummary123456",
      workspaceError: "sk-workspaceError123456",
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
        workspace: null,
        usage: {
          inputTokens: 10,
          cachedInputTokens: 0,
          uncachedInputTokens: 10,
          outputTokens: 2,
        },
        turns: 1,
        costUsd: 0.0001,
      });
      const writerRunId: SubagentRunId =
        "subagent-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
      const writerRun = history.persistence.accepted({
        ...acceptedLifecycle(
          "agent-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          writerRunId,
        ),
        mode: "foreground",
        threadCapabilityCeiling: writerCapability,
        capability: writerCapability,
        workspace: {
          kind: "isolated_write",
          leaseId: writerRunId,
          baseCommit: "d".repeat(40),
          branch: "keel/subagent/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          worktreePath: join(keelHome, "worktrees", writerRunId),
          workspaceRoot: join(keelHome, "worktrees", writerRunId),
        },
      });
      writerRun.transcript.initialize([]);
      writerRun.running().terminal({
        status: "failed",
        finalText: null,
        error: secrets.workspaceError,
        pendingInputCount: 0,
        workspace: {
          kind: "isolated_write",
          leaseId: writerRunId,
          baseCommit: "d".repeat(40),
          branch: "keel/subagent/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          disposition: "cleanup_failed",
          worktreePath: null,
          workspaceRoot: null,
          patchRef: null,
          patchSha256: null,
          patchSourceTruncated: false,
          summary: secrets.workspaceSummary,
          error: secrets.workspaceError,
        },
        usage: {
          inputTokens: 0,
          cachedInputTokens: 0,
          uncachedInputTokens: 0,
          outputTokens: 0,
        },
        turns: 0,
        costUsd: 0,
      });
      const successfulWriterRunId: SubagentRunId =
        "subagent-cccccccc-cccc-4ccc-8ccc-cccccccccccc";
      const successfulWriterPath = join(
        keelHome,
        "worktrees",
        successfulWriterRunId,
      );
      const successfulWriter = history.persistence.accepted({
        ...acceptedLifecycle(
          "agent-cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          successfulWriterRunId,
        ),
        mode: "foreground",
        threadCapabilityCeiling: writerCapability,
        capability: writerCapability,
        workspace: {
          kind: "isolated_write",
          leaseId: successfulWriterRunId,
          baseCommit: "e".repeat(40),
          branch: "keel/subagent/cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          worktreePath: successfulWriterPath,
          workspaceRoot: successfulWriterPath,
        },
      });
      successfulWriter.transcript.initialize([]);
      successfulWriter.running().terminal({
        status: "completed",
        finalText: "Writer completed.",
        error: null,
        pendingInputCount: 0,
        workspace: {
          kind: "isolated_write",
          leaseId: successfulWriterRunId,
          baseCommit: "e".repeat(40),
          branch: "keel/subagent/cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          disposition: "preserved",
          worktreePath: successfulWriterPath,
          workspaceRoot: successfulWriterPath,
          patchRef: "tool-output:test/successful-writer",
          patchSha256: "c".repeat(64),
          patchSourceTruncated: false,
          summary: secrets.workspaceSuccessSummary,
          error: null,
        },
        usage: {
          inputTokens: 0,
          cachedInputTokens: 0,
          uncachedInputTokens: 0,
          outputTokens: 0,
        },
        turns: 1,
        costUsd: 0,
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
            workspace: null,
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
        workspace: null,
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

  test(`Given a writer intent is durable but its planned worktree is absent after a crash,
    When saved history repairs the interrupted run,
    Then it retains the lease identity without falsely reporting a preserved path`, async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-agent-writer-repair-"),
    );
    const keelHome = join(workspace, ".keel-home");
    let now = 1_700_000_000_000;
    const runtime = {
      env: (key: string) => (key === "KEEL_HOME" ? keelHome : undefined),
      now: () => now++,
    };
    const sessionId = "writer-before-worktree-activation";
    const childRunId: SubagentRunId =
      "subagent-56565656-5656-4656-8656-565656565656";
    const lifecycle: SubagentAcceptedLifecycle = {
      ...acceptedLifecycle(
        "agent-56565656-5656-4656-8656-565656565656",
        childRunId,
      ),
      mode: "foreground",
      task: "Make one isolated change.",
      systemPrompt: "Writer instructions.",
      threadCapabilityCeiling: writerCapability,
      capability: writerCapability,
      workspace: {
        kind: "isolated_write",
        leaseId: childRunId,
        baseCommit: "a".repeat(40),
        branch: "keel/subagent/56565656-5656-4656-8656-565656565656",
        worktreePath: join(keelHome, "worktrees", childRunId),
        workspaceRoot: join(keelHome, "worktrees", childRunId),
      },
    };
    createSessionStore({ sessionId, workspace, runtime });

    try {
      createAgentTreeHistory({ sessionId, runtime }).persistence.accepted(
        lifecycle,
      );

      const recovered = createAgentTreeHistory({ sessionId, runtime });

      expect(recovered.entries()).toMatchObject([
        {
          status: "interrupted",
          result: {
            workspace: {
              leaseId: childRunId,
              baseCommit: "a".repeat(40),
              disposition: "cleanup_failed",
              worktreePath: null,
              workspaceRoot: null,
              summary:
                "planned writer workspace was not materialized or no longer exists",
            },
          },
        },
      ]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given interrupted writer worktrees survive with and without their nested workspace root,
    When saved history repairs both Runs,
    Then it preserves only filesystem identities that still exist`, async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-agent-writer-existing-repair-"),
    );
    const keelHome = join(workspace, ".keel-home");
    let now = 1_700_000_000_000;
    const runtime = {
      env: (key: string) => (key === "KEEL_HOME" ? keelHome : undefined),
      now: () => now++,
    };
    const sessionId = "writer-existing-worktree-repair";
    const identities: readonly {
      readonly childAgentId: AgentId;
      readonly childRunId: SubagentRunId;
      readonly workspaceRootExists: boolean;
    }[] = [
      {
        childAgentId: "agent-10101010-1010-4010-8010-101010101010",
        childRunId: "subagent-10101010-1010-4010-8010-101010101010",
        workspaceRootExists: false,
      },
      {
        childAgentId: "agent-20202020-2020-4020-8020-202020202020",
        childRunId: "subagent-20202020-2020-4020-8020-202020202020",
        workspaceRootExists: true,
      },
    ];
    createSessionStore({ sessionId, workspace, runtime });

    try {
      const history = createAgentTreeHistory({ sessionId, runtime });
      for (const identity of identities) {
        const worktreePath = join(keelHome, "worktrees", identity.childRunId);
        const workspaceRoot = join(worktreePath, "project");
        history.persistence.accepted({
          ...acceptedLifecycle(identity.childAgentId, identity.childRunId),
          mode: "foreground",
          threadCapabilityCeiling: writerCapability,
          capability: writerCapability,
          workspace: {
            kind: "isolated_write",
            leaseId: identity.childRunId,
            baseCommit: "d".repeat(40),
            branch: `keel/subagent/${identity.childRunId.slice("subagent-".length)}`,
            worktreePath,
            workspaceRoot,
          },
        });
        await mkdir(
          identity.workspaceRootExists ? workspaceRoot : worktreePath,
          { recursive: true },
        );
      }

      const repaired = createAgentTreeHistory({ sessionId, runtime }).entries();

      expect(repaired).toHaveLength(2);
      expect(repaired[0]?.result?.workspace).toMatchObject({
        disposition: "cleanup_failed",
        worktreePath: join(
          keelHome,
          "worktrees",
          identities[0]?.childRunId ?? "missing",
        ),
        workspaceRoot: null,
        summary: "writer workspace requires inspection after interrupted owner",
      });
      expect(repaired[1]?.result?.workspace).toMatchObject({
        disposition: "cleanup_failed",
        worktreePath: join(
          keelHome,
          "worktrees",
          identities[1]?.childRunId ?? "missing",
        ),
        workspaceRoot: join(
          keelHome,
          "worktrees",
          identities[1]?.childRunId ?? "missing",
          "project",
        ),
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a persisted writer workspace is coupled to one child identity,
    When terminal persistence presents a different workspace identity,
    Then it rejects the writer identity drift`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-agent-workspace-id-"));
    const keelHome = join(workspace, ".keel-home");
    let now = 1_700_000_000_000;
    const runtime = {
      env: (key: string) => (key === "KEEL_HOME" ? keelHome : undefined),
      now: () => now++,
    };
    const sessionId = "workspace-identity";
    const childRunId: SubagentRunId =
      "subagent-67676767-6767-4676-8676-676767676767";
    const reference = {
      kind: "isolated_write" as const,
      leaseId: childRunId,
      baseCommit: "b".repeat(40),
      branch: "keel/subagent/67676767-6767-4676-8676-676767676767",
      worktreePath: join(keelHome, "worktrees", childRunId),
      workspaceRoot: join(keelHome, "worktrees", childRunId),
    };
    createSessionStore({ sessionId, workspace, runtime });

    try {
      const history = createAgentTreeHistory({ sessionId, runtime });
      const writer = history.persistence.accepted({
        ...acceptedLifecycle(
          "agent-67676767-6767-4676-8676-676767676767",
          childRunId,
        ),
        mode: "foreground",
        threadCapabilityCeiling: writerCapability,
        capability: writerCapability,
        workspace: reference,
      });

      const terminalBase = {
        status: "failed" as const,
        finalText: null,
        error: "activation failed",
        pendingInputCount: 0,
        usage: {
          inputTokens: 0,
          cachedInputTokens: 0,
          uncachedInputTokens: 0,
          outputTokens: 0,
        },
        turns: 0,
        costUsd: 0,
      };
      const workspaceBase = {
        kind: "isolated_write" as const,
        leaseId: childRunId,
        baseCommit: reference.baseCommit,
        branch: reference.branch,
        disposition: "cleanup_failed" as const,
        worktreePath: null,
        workspaceRoot: null,
        patchRef: null,
        patchSha256: null,
        patchSourceTruncated: false,
        summary: "failed",
        error: "failed",
      };
      const invalidWriterResults: PersistedSubagentCanonicalResult["workspace"][] =
        [
          null,
          { ...workspaceBase, leaseId: "subagent-99999999" },
          { ...workspaceBase, baseCommit: "c".repeat(40) },
          { ...workspaceBase, branch: "keel/subagent/other" },
          {
            ...workspaceBase,
            worktreePath: join(keelHome, "worktrees", "other"),
          },
          {
            ...workspaceBase,
            worktreePath: reference.worktreePath,
            workspaceRoot: join(keelHome, "worktrees", "other"),
          },
        ];
      const runningWriter = writer.running();

      for (const invalidWorkspace of invalidWriterResults) {
        expect(() =>
          runningWriter.terminal({
            ...terminalBase,
            workspace: invalidWorkspace,
          }),
        ).toThrow(
          invalidWorkspace === null
            ? "missing its workspace state"
            : "workspace result mismatches acceptance",
        );
      }

      const readerRunId: SubagentRunId =
        "subagent-68686868-6868-4686-8686-686868686868";
      const reader = history.persistence.accepted(
        acceptedLifecycle(
          "agent-68686868-6868-4686-8686-686868686868",
          readerRunId,
        ),
      );
      expect(() =>
        reader.running().terminal({
          ...terminalBase,
          status: "failed",
          workspace: { ...workspaceBase, leaseId: readerRunId },
        }),
      ).toThrow("recorded writer workspace state");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a terminal writer Run owns one preserved workspace identity,
    When the same Thread accepts a continuation or a caller substitutes another worktree,
    Then only the same workspace with a fresh Run lease is accepted and the old Run remains immutable`, async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-agent-writer-continuation-"),
    );
    const keelHome = join(workspace, ".keel-home");
    let now = 1_700_000_000_000;
    const runtime = {
      env: (key: string) => (key === "KEEL_HOME" ? keelHome : undefined),
      now: () => now++,
    };
    const sessionId = "writer-continuation-identity";
    const childAgentId: AgentId = "agent-69696969-6969-4696-8696-696969696969";
    const firstRunId: SubagentRunId =
      "subagent-69696969-6969-4696-8696-696969696969";
    const secondRunId: SubagentRunId =
      "subagent-70707070-7070-4707-8707-707070707070";
    const firstReference = {
      kind: "isolated_write" as const,
      leaseId: firstRunId,
      baseCommit: "e".repeat(40),
      branch: "keel/subagent/69696969-6969-4696-8696-696969696969",
      worktreePath: join(keelHome, "worktrees", firstRunId),
      workspaceRoot: join(keelHome, "worktrees", firstRunId),
    };
    createSessionStore({ sessionId, workspace, runtime });

    try {
      const history = createAgentTreeHistory({ sessionId, runtime });
      const first = history.persistence.accepted({
        ...acceptedLifecycle(childAgentId, firstRunId),
        mode: "foreground",
        threadCapabilityCeiling: writerCapability,
        capability: writerCapability,
        workspace: firstReference,
      });
      first.transcript.initialize([]);
      first.running().terminal({
        status: "completed",
        finalText: "First patch complete.",
        error: null,
        pendingInputCount: 0,
        usage: {
          inputTokens: 2,
          cachedInputTokens: 0,
          uncachedInputTokens: 2,
          outputTokens: 1,
        },
        turns: 1,
        costUsd: 0.0001,
        workspace: {
          ...firstReference,
          disposition: "preserved",
          patchRef: "tool-output:test/first-writer-patch",
          patchSha256: "f".repeat(64),
          patchSourceTruncated: false,
          summary: "M message.txt",
          error: null,
        },
      });
      const immutableFirstResult = history.runs(childAgentId)[0]?.result;
      const continuation = {
        ...acceptedLifecycle(childAgentId, secondRunId),
        delegationId: "parent:writer-follow-up",
        parentToolCallId: "writer-follow-up",
        task: "Adjust the preserved patch.",
        mode: "foreground" as const,
        threadCapabilityCeiling: writerCapability,
        capability: writerCapability,
        workspace: { ...firstReference, leaseId: secondRunId },
        lineage: {
          kind: "continuation" as const,
          previousRunId: firstRunId,
        },
      };

      expect(() =>
        history.persistence.accepted({
          ...continuation,
          childRunId: "subagent-71717171-7171-4717-8717-717171717171",
          delegationId: "parent:wrong-writer-worktree",
          parentToolCallId: "wrong-writer-worktree",
          workspace: {
            ...continuation.workspace,
            leaseId: "subagent-71717171-7171-4717-8717-717171717171",
            worktreePath: join(keelHome, "worktrees", "other"),
            workspaceRoot: join(keelHome, "worktrees", "other"),
          },
        }),
      ).toThrow("changes writer workspace identity");

      history.persistence.accepted(continuation);

      expect(history.entries()).toMatchObject([
        {
          childAgentId,
          childRunId: secondRunId,
          status: "queued",
          workspace: {
            ...firstReference,
            leaseId: secondRunId,
          },
          lineage: { kind: "continuation", previousRunId: firstRunId },
        },
      ]);
      expect(history.runs(childAgentId)[0]?.result).toEqual(
        immutableFirstResult,
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given untrusted accepted lifecycle records contradict writer authority,
    When the JSONL schema validates the disk boundary,
    Then every capability, mode, and workspace mismatch is rejected`, () => {
    const childAgentId: AgentId = "agent-78787878-7878-4787-8787-787878787878";
    const childRunId: SubagentRunId =
      "subagent-78787878-7878-4787-8787-787878787878";
    const readOnlyRecord = acceptedRecord(
      acceptedLifecycle(childAgentId, childRunId),
      "untrusted-writer-authority",
    );
    const workspace = {
      kind: "isolated_write" as const,
      leaseId: childRunId,
      baseCommit: "c".repeat(40),
      branch: "keel/subagent/78787878-7878-4787-8787-787878787878",
      worktreePath: "/tmp/keel-writer-authority",
      workspaceRoot: "/tmp/keel-writer-authority",
    };
    const writerRecord = {
      ...readOnlyRecord,
      mode: "foreground" as const,
      threadCapabilityCeiling: writerCapability,
      capability: writerCapability,
      workspace,
    };
    const invalidRecords = [
      { ...writerRecord, threadCapabilityCeiling: explorerCapability },
      { ...writerRecord, workspace: null },
      { ...writerRecord, mode: "background" as const },
      { ...readOnlyRecord, threadCapabilityCeiling: writerCapability },
      {
        ...writerRecord,
        workspace: { ...workspace, leaseId: "subagent-99999999" as const },
      },
      { ...readOnlyRecord, workspace },
    ];

    for (const invalidRecord of invalidRecords) {
      expect(mutationRecordSchema.safeParse(invalidRecord).success).toBe(false);
    }
  });

  test(`Given untrusted cleanup results split coupled workspace or patch identities,
    When the JSONL schema validates the disk boundary,
    Then it rejects every half-present pair`, () => {
    const childAgentId: AgentId = "agent-79797979-7979-4979-8979-797979797979";
    const childRunId: SubagentRunId =
      "subagent-79797979-7979-4979-8979-797979797979";
    const reference = {
      kind: "isolated_write" as const,
      leaseId: childRunId,
      baseCommit: "d".repeat(40),
      branch: "keel/subagent/79797979-7979-4979-8979-797979797979",
      worktreePath: "/tmp/keel-writer-result",
      workspaceRoot: "/tmp/keel-writer-result/project",
    };
    const accepted = acceptedRecord(
      {
        ...acceptedLifecycle(childAgentId, childRunId),
        mode: "foreground",
        threadCapabilityCeiling: writerCapability,
        capability: writerCapability,
        workspace: reference,
      },
      "untrusted-writer-result",
    );
    const validWorkspace = {
      ...reference,
      disposition: "cleanup_failed" as const,
      worktreePath: null,
      workspaceRoot: null,
      patchRef: null,
      patchSha256: null,
      patchSourceTruncated: false,
      summary: "workspace requires inspection",
      error: "activation failed",
    };
    const record = {
      schemaVersion: AGENT_TREE_SCHEMA_VERSION,
      type: "agent_result" as const,
      timestamp: "2023-11-14T22:13:23.000Z",
      result: { ...completedResult(accepted), workspace: validWorkspace },
    };

    expect(mutationRecordSchema.safeParse(record).success).toBe(true);
    for (const invalidWorkspace of [
      { ...validWorkspace, workspaceRoot: reference.workspaceRoot },
      {
        ...validWorkspace,
        worktreePath: reference.worktreePath,
        workspaceRoot: reference.workspaceRoot,
        patchRef: "tool-output:run/patch",
      },
      {
        ...validWorkspace,
        worktreePath: reference.worktreePath,
        workspaceRoot: reference.workspaceRoot,
        patchSha256: "a".repeat(64),
      },
    ]) {
      expect(
        mutationRecordSchema.safeParse({
          ...record,
          result: { ...record.result, workspace: invalidWorkspace },
        }).success,
      ).toBe(false);
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
          workspace: null,
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
        workspace: null,
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
      lines[1] = `{"schemaVersion":${AGENT_TREE_SCHEMA_VERSION},"type":"transcript_initialize","messages":[{"role":"assistant"}]}`;
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
        `{"schemaVersion":${AGENT_TREE_SCHEMA_VERSION},"type":"transcript_initialize","messages":[]}\n{"schemaVersion":${AGENT_TREE_SCHEMA_VERSION},"type":"transcript_terminal","status":"completed","pendingInputCount":0,"complete":true}\n`,
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
