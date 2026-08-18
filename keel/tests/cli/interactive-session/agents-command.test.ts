import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, test } from "vitest";
import type {
  AgentId,
  SubagentRunId,
} from "../../../src/agent/subagent-lifecycle.ts";
import { resolveBuiltinSubagentProfile } from "../../../src/agent/subagent-profile.ts";
import type { AbortableToolOutputArtifactStore } from "../../../src/agent/tool-output-artifacts.ts";
import { formatAgentHistoryDetail } from "../../../src/cli/agent-history-format.ts";
import type {
  AgentHistoryEntry,
  AgentTreeHistory,
} from "../../../src/cli/agent-tree-store.ts";
import { createAgentTreeHistory } from "../../../src/cli/agent-tree-store.ts";
import { parseInteractiveCommand } from "../../../src/cli/interactive-session/commands.ts";
import { createSessionStore } from "../../../src/cli/session-store.ts";
import {
  EPHEMERAL_INTERACTIVE_SESSION,
  ForcedExit,
  runInteractiveSessionWithoutMemory as runInteractiveSession,
  savedInteractiveSession,
  ZERO_COST_MODEL,
} from "../../../src/testing/interactive-session-fixtures.ts";

const reviewerCapability = resolveBuiltinSubagentProfile("reviewer").snapshot;
const writerCapability = resolveBuiltinSubagentProfile("writer").snapshot;

function entry(options: {
  readonly childAgentId: AgentId;
  readonly childRunId: SubagentRunId;
  readonly delegationId: string;
}): AgentHistoryEntry {
  const accounting = {
    usage: {
      inputTokens: 10,
      cachedInputTokens: 2,
      uncachedInputTokens: 8,
      outputTokens: 3,
    },
    turns: 1,
    costUsd: 0.0001,
  };
  return {
    index: 1,
    delegationId: options.delegationId,
    childAgentId: options.childAgentId,
    childRunId: options.childRunId,
    parentRunId: "parent-run",
    parentToolCallId: "delegate-call",
    task: "Inspect the saved child.",
    focusPaths: [],
    mode: "foreground",
    providerId: "deepseek",
    model: "deepseek-chat",
    effort: null,
    systemPrompt: "Read-only child instructions.",
    threadCapabilityCeiling: reviewerCapability,
    capability: reviewerCapability,
    workspace: null,
    transcriptRef: `agent-transcript:test/${options.childAgentId}`,
    acceptedAt: "2023-11-14T22:13:20.000Z",
    lineage: { kind: "root" },
    status: "failed",
    accounting,
    result: {
      delegationId: options.delegationId,
      childAgentId: options.childAgentId,
      childRunId: options.childRunId,
      task: "Inspect the saved child.",
      transcriptRef: `agent-transcript:test/${options.childAgentId}`,
      status: "failed",
      finalText: null,
      error: "Provider failed.",
      pendingInputCount: 1,
      workspace: null,
      ...accounting,
    },
  };
}

function history(
  entries: readonly AgentHistoryEntry[],
  transcript: (entry: AgentHistoryEntry) => string = () =>
    '{"type":"transcript"}\n',
): AgentTreeHistory {
  return {
    sessionId: "saved-session",
    persistence: {
      accepted: () => {
        throw new Error("not used by formatting");
      },
      rejected: () => {},
    },
    entries: () => entries,
    runs: (id) => entries.filter((entry) => entry.childAgentId === id),
    reconcileBuiltInReadOnlyDelegate: () => ({ kind: "unknown" }),
    pendingResultDeliveries: () => [],
    deliveredResult: () => {},
    transcript,
    messages: () => [],
  };
}

const unusedTranscriptStore: AbortableToolOutputArtifactStore = {
  abortSignalSupport: true,
  verifyReusable: async () => ({ status: "not_reusable" }),
  save: async () => {
    throw new Error("agent commands must not write transcripts");
  },
  discard: async () => {},
};

describe("Interactive /agents command", () => {
  test(`Given saved writer Runs preserve either a patch or cleanup failure,
    When the user inspects their /agents details,
    Then the branch, worktree, patch identity, summary, and error remain actionable`, () => {
    const base = entry({
      childAgentId: "agent-11111111-1111-4111-8111-111111111111",
      childRunId: "subagent-11111111-1111-4111-8111-111111111111",
      delegationId: "parent:writer",
    });
    if (base.result === null) throw new Error("expected terminal fixture");
    const workspaceBase = {
      kind: "isolated_write" as const,
      leaseId: base.childRunId,
      baseCommit: "a".repeat(40),
      branch: "keel/subagent/11111111-1111-4111-8111-111111111111",
      patchSourceTruncated: false,
      summary: "M README.md",
    };
    const preserved: AgentHistoryEntry = {
      ...base,
      mode: "foreground",
      threadCapabilityCeiling: writerCapability,
      capability: writerCapability,
      workspace: {
        kind: "isolated_write",
        leaseId: base.childRunId,
        baseCommit: workspaceBase.baseCommit,
        branch: workspaceBase.branch,
        worktreePath: "/tmp/keel-writer",
        workspaceRoot: "/tmp/keel-writer",
      },
      result: {
        ...base.result,
        workspace: {
          ...workspaceBase,
          disposition: "preserved",
          worktreePath: "/tmp/keel-writer",
          workspaceRoot: "/tmp/keel-writer",
          patchRef: "tool-output:test/writer-patch",
          patchSha256: "b".repeat(64),
          error: null,
        },
      },
    };
    const cleanupFailed: AgentHistoryEntry = {
      ...base,
      index: 2,
      childRunId: "subagent-22222222-2222-4222-8222-222222222222",
      mode: "foreground",
      threadCapabilityCeiling: writerCapability,
      capability: writerCapability,
      workspace: {
        kind: "isolated_write",
        leaseId: "subagent-22222222-2222-4222-8222-222222222222",
        baseCommit: workspaceBase.baseCommit,
        branch: workspaceBase.branch,
        worktreePath: "/tmp/keel-writer-failed",
        workspaceRoot: "/tmp/keel-writer-failed",
      },
      result: {
        ...base.result,
        workspace: {
          ...workspaceBase,
          leaseId: "subagent-22222222-2222-4222-8222-222222222222",
          disposition: "cleanup_failed",
          worktreePath: null,
          workspaceRoot: null,
          patchRef: null,
          patchSha256: null,
          error: "worktree identity changed",
        },
      },
    };

    const preservedDetail = formatAgentHistoryDetail(preserved);
    expect(preservedDetail).toContain("workspace worktree: /tmp/keel-writer");
    expect(preservedDetail).toContain(
      "workspace patch: tool-output:test/writer-patch",
    );
    expect(preservedDetail).toContain(
      `workspace patch sha256: ${"b".repeat(64)}`,
    );
    expect(preservedDetail).not.toContain("workspace error:");
    const failedDetail = formatAgentHistoryDetail(cleanupFailed);
    expect(failedDetail).toContain("workspace worktree: removed");
    expect(failedDetail).toContain("workspace patch: unavailable");
    expect(failedDetail).toContain(
      "workspace error: worktree identity changed",
    );
  });

  test(`Given a saved terminal child has durable context,
    When the user resumes it and waits through /agents,
    Then the same Agent ID completes a new Run without expanding its saved reviewer capability`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-agents-resume-"));
    const keelHome = join(workspace, ".keel-home");
    const sessionId = "agents-resume";
    const childAgentId = "agent-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const firstRunId = "subagent-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    let now = 1_700_000_000_000;
    const runtime = {
      env: (key: string) => (key === "KEEL_HOME" ? keelHome : undefined),
      now: () => now++,
    };
    createSessionStore({ sessionId, workspace, runtime });

    try {
      const agentHistory = createAgentTreeHistory({ sessionId, runtime });
      const first = agentHistory.persistence.accepted({
        delegationId: "parent:first",
        childAgentId,
        childRunId: firstRunId,
        parentRunId: "parent",
        parentToolCallId: "first",
        task: "Inspect the boundary.",
        focusPaths: [],
        mode: "foreground",
        providerId: "fake",
        model: "fake-model",
        effort: null,
        systemPrompt: "Read-only child instructions.",
        threadCapabilityCeiling: reviewerCapability,
        capability: reviewerCapability,
        workspace: null,
        lineage: { kind: "root" },
      });
      first.transcript.initialize([
        {
          role: "user",
          content: "Inspect the boundary.",
          origin: { type: "runtime_subagent_delegation" },
        },
      ]);
      first.transcript.append([
        {
          role: "assistant",
          content: "The boundary is sound.",
          toolCalls: [],
        },
      ]);
      first.running().terminal({
        status: "completed",
        finalText: "The boundary is sound.",
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
      const originalResult = agentHistory.runs(childAgentId)[0]?.result;
      const provider = {
        id: "fake",
        abortSignalSupport: true as const,
        estimateInputTokens: () => 1,
        async *stream(
          options: Parameters<
            import("../../../src/llm/types.ts").LLMProvider["stream"]
          >[0],
        ) {
          expect(options.toolExposure).toEqual({
            kind: "auto",
            profile: "subagent",
            capability: reviewerCapability,
          });
          expect(options.messages).toMatchObject([
            { role: "user", content: "Inspect the boundary." },
            { role: "assistant", content: "The boundary is sound." },
            { role: "user", content: "Now inspect its callers." },
          ]);
          const usage = {
            inputTokens: 1,
            cachedInputTokens: 0,
            uncachedInputTokens: 1,
            outputTokens: 1,
          };
          yield { type: "text" as const, text: "The callers are sound too." };
          options.providerRequestAttempts
            ?.begin()
            .finish({ outcome: "completed", usage });
          yield { type: "stop" as const, reason: "stop" as const, usage };
        },
      };
      const input = new PassThrough();
      let stdout = "";
      let stderr = "";
      const pending = runInteractiveSession({
        cliArgs: { bashMode: "disabled", maxCostUsd: 1 },
        workspace,
        platform: process.platform,
        session: savedInteractiveSession({ id: sessionId }),
        agentHistory,
        delegation: {
          policy: "explicit",
          transcriptStore: unusedTranscriptStore,
          maxCostUsd: 1,
        },
        input,
        writeStdout: (text) => {
          stdout += text;
        },
        writeStderr: (text) => {
          stderr += text;
        },
        onSigint: () => {},
        offSigint: () => {},
        setExitCode: () => {},
        forceExit: (code) => {
          throw new ForcedExit(code);
        },
        resolveProvider: () => ({
          provider,
          providerId: "fake",
          model: "fake-model",
          costModel: ZERO_COST_MODEL,
        }),
        requireKnownCostModel: () => ZERO_COST_MODEL,
        printAgentEvents: async () => {
          throw new Error("agent commands must not start a Main turn");
        },
        formatCostReport: () => "",
      });

      input.end(
        "/agents resume 1 Now inspect its callers.\n/agents wait 1\n/agents show 1\n",
      );
      await pending;

      expect(stderr).toContain("Background subagent");
      expect(stdout).toContain(`"agentId":"${childAgentId}"`);
      expect(stdout).toContain("The callers are sound too.");
      expect(stdout).toContain(`continuation of: ${firstRunId}`);
      expect(agentHistory.entries()).toMatchObject([
        { childAgentId, status: "completed" },
      ]);
      expect(agentHistory.runs(childAgentId)).toHaveLength(2);
      expect(agentHistory.runs(childAgentId)[0]?.result).toEqual(
        originalResult,
      );
      expect(agentHistory.runs(childAgentId)[1]).toMatchObject({
        childAgentId,
        status: "completed",
        capability: reviewerCapability,
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given supported agent-history command forms,
    When they are parsed,
    Then the command union preserves the requested action and selector`, () => {
    expect(parseInteractiveCommand("/agents")).toEqual({
      kind: "agents",
      action: "list",
    });
    expect(parseInteractiveCommand("/agents show 2")).toEqual({
      kind: "agents",
      action: "show",
      selector: "2",
    });
    expect(parseInteractiveCommand("/agents transcript agent-123")).toEqual({
      kind: "agents",
      action: "transcript",
      selector: "agent-123",
    });
    expect(parseInteractiveCommand("/agents wait agent-123")).toEqual({
      kind: "agents",
      action: "wait",
      selector: "agent-123",
    });
    expect(parseInteractiveCommand("/agents cancel 2")).toEqual({
      kind: "agents",
      action: "cancel",
      selector: "2",
    });
    expect(
      parseInteractiveCommand("/agents input agent-123 Inspect the callers"),
    ).toEqual({
      kind: "agents",
      action: "input",
      selector: "agent-123",
      message: "Inspect the callers",
    });
    expect(parseInteractiveCommand("/agents resume 2 Verify the fix")).toEqual({
      kind: "agents",
      action: "resume",
      selector: "2",
      message: "Verify the fix",
      skills: [],
      mcp: [],
    });
    expect(
      parseInteractiveCommand(
        "/agents resume 2 --skill repo:review-guide --mcp catalog/search -- Re-check callers",
      ),
    ).toEqual({
      kind: "agents",
      action: "resume",
      selector: "2",
      message: "Re-check callers",
      skills: ["repo:review-guide"],
      mcp: [{ server: "catalog", tool: "search" }],
    });
  });

  test(`Given an incomplete or over-specified agent-history command,
    When it is parsed,
    Then it fails as a command instead of reaching the model`, () => {
    for (const input of [
      "/agents show",
      "/agents transcript",
      "/agents show 1 extra",
      "/agents input 1",
      "/agents resume 1",
      "/agents resume 1 --mcp catalog -- Re-check callers",
      "/agents unknown 1",
    ]) {
      expect(parseInteractiveCommand(input)).toEqual({
        kind: "invalid",
        message:
          "Error: usage is /agents, /agents show <id|index>, /agents transcript <id|index>, /agents wait <id|index>, /agents cancel <id|index>, /agents input <id|index> <message>, or /agents resume <id|index> [--skill <name> | --mcp <server/tool> ... --] <message>.",
      });
    }
  });

  test(`Given /agents is used without saved history, with an unknown selector, or with a corrupt transcript,
    When the interactive command loop handles each request,
    Then it reports local errors without resolving a provider or exposing corrupt content`, async () => {
    const failed = entry({
      childAgentId: "agent-2222",
      childRunId: "subagent-2222",
      delegationId: "parent:delegate-2",
    });
    const detached = {
      ...entry({
        childAgentId: "agent-3333",
        childRunId: "subagent-3333",
        delegationId: "parent:delegate-3",
      }),
      index: 2,
      status: "running" as const,
      result: null,
    };
    const attachedHistory = history([failed, detached], () => {
      throw new Error("corrupt child transcript");
    });
    const cases = [
      {
        inputText: "/agents\n",
        session: EPHEMERAL_INTERACTIVE_SESSION,
        expected: "Error: /agents requires a saved interactive session.\n",
      },
      {
        inputText: [
          "/agents show 99",
          "/agents show missing",
          "/agents show subagent-2222",
          "/agents transcript agent-2222",
          "/agents transcript parent:delegate-2",
          "/agents wait 2",
          "/agents cancel 2",
          "/agents input 2 Inspect callers.",
          "",
        ].join("\n"),
        session: savedInteractiveSession({ id: "saved-session" }),
        agentHistory: attachedHistory,
        attached: true,
        expected:
          'Error: no subagent matches "99".\nError: no subagent matches "missing".\ncorrupt child transcript\ncorrupt child transcript\nSubagent agent-3333 is not owned by this live session.\nSubagent agent-3333 is not owned by this live session.\nSubagent agent-3333 is not owned by this live session.\n',
        stdoutIncludes:
          "pending input: 1 queued message(s) will be available to the next Run",
      },
      {
        inputText: "/agents wait 1\n",
        session: savedInteractiveSession({ id: "saved-session" }),
        agentHistory: history([failed]),
        expected:
          "Error: live agent control requires an attached saved-session owner.\n",
      },
    ];

    for (const scenario of cases) {
      const input = new PassThrough();
      let stdout = "";
      let stderr = "";
      let providerResolved = false;
      const pending = runInteractiveSession({
        cliArgs: { bashMode: "ask" },
        workspace: process.cwd(),
        platform: process.platform,
        session: scenario.session,
        ...(scenario.agentHistory === undefined
          ? {}
          : { agentHistory: scenario.agentHistory }),
        ...(scenario.attached === true
          ? {
              delegation: {
                policy: "explicit" as const,
                transcriptStore: unusedTranscriptStore,
                maxCostUsd: 1,
              },
            }
          : {}),
        input,
        writeStdout: (text) => {
          stdout += text;
        },
        writeStderr: (text) => {
          stderr += text;
        },
        onSigint: () => {},
        offSigint: () => {},
        setExitCode: () => {},
        forceExit: (code) => {
          throw new ForcedExit(code);
        },
        resolveProvider: () => {
          providerResolved = true;
          throw new Error("/agents should not resolve a provider");
        },
        requireKnownCostModel: () => ZERO_COST_MODEL,
        printAgentEvents: async () => {
          throw new Error("/agents should not start a model turn");
        },
        formatCostReport: () => "",
      });

      input.end(scenario.inputText);
      await pending;
      if (scenario.stdoutIncludes === undefined) {
        expect(stdout).toBe("");
      } else {
        expect(stdout).toContain(scenario.stdoutIncludes);
      }
      expect(stderr).toBe(scenario.expected);
      expect(providerResolved).toBe(false);
    }
  });
});
