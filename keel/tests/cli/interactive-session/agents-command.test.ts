import { PassThrough } from "node:stream";
import { describe, expect, test } from "vitest";
import type {
  AgentId,
  SubagentRunId,
} from "../../../src/agent/subagent-lifecycle.ts";
import type { AbortableToolOutputArtifactStore } from "../../../src/agent/tool-output-artifacts.ts";
import type {
  AgentHistoryEntry,
  AgentTreeHistory,
} from "../../../src/cli/agent-tree-store.ts";
import { parseInteractiveCommand } from "../../../src/cli/interactive-session/commands.ts";
import {
  EPHEMERAL_INTERACTIVE_SESSION,
  ForcedExit,
  runInteractiveSessionWithoutMemory as runInteractiveSession,
  savedInteractiveSession,
  ZERO_COST_MODEL,
} from "../../../src/testing/interactive-session-fixtures.ts";

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
    providerId: "deepseek",
    model: "deepseek-chat",
    transcriptRef: `agent-transcript:test/${options.childAgentId}`,
    acceptedAt: "2023-11-14T22:13:20.000Z",
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
    transcript,
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
  });

  test(`Given an incomplete or over-specified agent-history command,
    When it is parsed,
    Then it fails as a command instead of reaching the model`, () => {
    for (const input of [
      "/agents show",
      "/agents transcript",
      "/agents show 1 extra",
      "/agents unknown 1",
    ]) {
      expect(parseInteractiveCommand(input)).toEqual({
        kind: "invalid",
        message:
          "Error: usage is /agents, /agents show <id|index>, /agents transcript <id|index>, /agents wait <id|index>, or /agents cancel <id|index>.",
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
          "",
        ].join("\n"),
        session: savedInteractiveSession({ id: "saved-session" }),
        agentHistory: attachedHistory,
        attached: true,
        expected:
          'Error: no subagent matches "99".\nError: no subagent matches "missing".\ncorrupt child transcript\ncorrupt child transcript\nSubagent agent-3333 is not owned by this live session.\nSubagent agent-3333 is not owned by this live session.\n',
        stdoutIncludes: "Agent 1: agent-2222",
      },
      {
        inputText: "/agents wait 1\n",
        session: savedInteractiveSession({ id: "saved-session" }),
        agentHistory: history([failed]),
        expected:
          "Error: live agent wait/cancel requires an attached saved-session owner.\n",
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
