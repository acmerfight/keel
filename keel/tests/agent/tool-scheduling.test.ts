import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { AgentEvent } from "../../src/agent/events.ts";
import { runAgent, runAgentTurn } from "../../src/agent/loop.ts";
import type { SessionMessage } from "../../src/agent/session-message.ts";
import { defaultStopPolicy } from "../../src/agent/stop-policy.ts";
import { builtinSubagentProfileCatalog } from "../../src/agent/subagent-profile.ts";
import type { SubagentResultContinuationBudget } from "../../src/agent/subagent-tree-budget.ts";
import type {
  ToolOutputArtifactSaveInput,
  ToolOutputArtifactStore,
} from "../../src/agent/tool-output-artifacts.ts";
import { restoreLastEditCheckpoint } from "../../src/core/git.ts";
import type {
  LLMProvider,
  ProviderMessage,
  Usage,
} from "../../src/llm/types.ts";
import { mcpProviderSchemaTarget } from "../../src/mcp/provider-schema.ts";
import type { McpRuntime } from "../../src/mcp/runtime-types.ts";
import { createGitWorkspace } from "../../src/testing/cli-harness.ts";
import { sessionLedgerMirroringMessages } from "../../src/testing/session-ledger-fixtures.ts";
import type { AgentControlCapability } from "../../src/tools/agent-control.ts";
import type { DelegationCapability } from "../../src/tools/delegation.ts";

const unusedAgentMutationControl = {
  input: () => ({ ok: false, content: "unused" }),
  resume: async () => ({ ok: false, content: "unused" }),
} satisfies Pick<AgentControlCapability, "input" | "resume">;

const ZERO_USAGE: Usage = {
  inputTokens: 0,
  cachedInputTokens: 0,
  uncachedInputTokens: 0,
  outputTokens: 0,
};

async function collect(
  source: AsyncIterable<AgentEvent>,
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of source) {
    events.push(event);
  }
  return events;
}

function freshSignal(): AbortSignal {
  return new AbortController().signal;
}

function isToolMessage(
  message: ProviderMessage,
): message is Extract<ProviderMessage, { readonly role: "tool" }> {
  return message.role === "tool";
}

function toolEventTrace(events: readonly AgentEvent[]): readonly string[] {
  return events
    .filter((event) => event.type === "tool_start" || event.type === "tool_end")
    .map((event) =>
      event.type === "tool_start"
        ? `${event.toolCall.id}:start`
        : `${event.toolCall.id}:end:${event.ok}`,
    );
}

function storedArtifactStore(
  saved: ToolOutputArtifactSaveInput[],
): ToolOutputArtifactStore {
  return {
    verifyReusable: async () => ({ status: "not_reusable" }),
    save: async (input) => {
      saved.push(input);
      const ref = `tool-output:test/${saved.length}`;
      return { status: "stored", ref, contentSha256: "0".repeat(64) };
    },
    discard: async () => {
      saved.pop();
    },
  };
}

async function createWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "keel-tool-scheduling-"));
}

describe("Tool Scheduling", () => {
  test(`Given a running background child temporarily holds shared budget,
    When the model calls agent_wait,
    Then Keel waits for settlement before reserving and consuming the exact Main continuation`, async () => {
    const workspace = await createWorkspace();
    const messages: SessionMessage[] = [
      { role: "user", content: "Use the background result." },
    ];
    let ordinaryProviderCalls = 0;
    let leasedProviderCalls = 0;
    let releases = 0;
    let drainCalls = 0;
    let settled = false;
    const order: string[] = [];
    const provider: LLMProvider = {
      id: "ordinary-main-provider",
      async *stream() {
        ordinaryProviderCalls++;
        yield {
          type: "tool_call",
          id: "wait-result",
          tool: "agent_wait",
          agentId: "agent-a1",
        };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const continuationProvider: LLMProvider = {
      id: "leased-main-provider",
      async *stream() {
        leasedProviderCalls++;
        yield { type: "text", text: "Used the durable child result." };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const agentControl: AgentControlCapability = {
      ...unusedAgentMutationControl,
      list: () => ({ ok: true, content: "unused" }),
      waitForSettlement: async () => {
        order.push("settle");
        settled = true;
      },
      wait: async () => {
        order.push("result");
        return { ok: true, content: "canonical child result" };
      },
      cancel: async () => ({ ok: true, content: "unused" }),
    };
    const release = () => {
      releases++;
    };
    const resultBudget: SubagentResultContinuationBudget = {
      lease: () => {
        order.push("lease");
        if (!settled) return { kind: "rejected" };
        return {
          kind: "granted",
          maxResultChars: 6_000,
          continuation: {
            provider: continuationProvider,
            requestShape: {
              systemPrompt: "You are a helpful assistant.",
              toolExposure: { kind: "auto", agentControl: true },
            },
            release,
          },
          release,
        };
      },
    };

    try {
      const events = await collect(
        runAgentTurn({
          workspace,
          provider,
          ledger: sessionLedgerMirroringMessages(messages),
          systemPrompt: "You are a helpful assistant.",
          signal: freshSignal(),
          bash: { kind: "disabled" },
          stopPolicy: defaultStopPolicy(),
          agentControl,
          agentControlResultBudget: resultBudget,
          drainInjectedUserMessages: () => {
            drainCalls++;
            return [{ role: "user", content: "unpriced steering" }];
          },
        }),
      );

      expect(ordinaryProviderCalls).toBe(1);
      expect(leasedProviderCalls).toBe(1);
      expect(releases).toBe(1);
      expect(drainCalls).toBe(0);
      expect(order).toEqual(["settle", "lease", "result"]);
      expect(messages).not.toContainEqual({
        role: "user",
        content: "unpriced steering",
      });
      expect(messages).toContainEqual({
        role: "tool",
        toolCallId: "wait-result",
        content: "canonical child result",
      });
      expect(events).toContainEqual({
        type: "text",
        text: "Used the durable child result.",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a completed background result but no budget for Main's continuation,
    When the model calls agent_wait,
    Then Keel does not fetch the result and returns an admission failure for synthesis`, async () => {
    const workspace = await createWorkspace();
    const messages: SessionMessage[] = [
      { role: "user", content: "Use the background result." },
    ];
    let providerTurn = 0;
    let waitCalls = 0;
    const provider: LLMProvider = {
      id: "agent-wait-result-admission",
      async *stream() {
        if (providerTurn++ === 0) {
          yield {
            type: "tool_call",
            id: "wait-result",
            tool: "agent_wait",
            agentId: "agent-a1",
          };
        } else {
          yield { type: "text", text: "Result was not admitted." };
        }
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const agentControl: AgentControlCapability = {
      ...unusedAgentMutationControl,
      list: () => ({ ok: true, content: "unused" }),
      waitForSettlement: async () => {},
      wait: async () => {
        waitCalls++;
        return { ok: true, content: "must not enter Main context" };
      },
      cancel: async () => ({ ok: true, content: "unused" }),
    };
    const resultBudget: SubagentResultContinuationBudget = {
      lease: () => ({ kind: "rejected" }),
    };

    try {
      const events = await collect(
        runAgentTurn({
          workspace,
          provider,
          ledger: sessionLedgerMirroringMessages(messages),
          systemPrompt: "You are a helpful assistant.",
          signal: freshSignal(),
          bash: { kind: "disabled" },
          stopPolicy: defaultStopPolicy(),
          agentControl,
          agentControlResultBudget: resultBudget,
        }),
      );

      expect(waitCalls).toBe(0);
      expect(messages).toContainEqual({
        role: "tool",
        toolCallId: "wait-result",
        content: expect.stringContaining(
          "remaining session budget cannot preserve a Main continuation",
        ),
      });
      expect(events).toContainEqual({
        type: "text",
        text: "Result was not admitted.",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given agent_wait has reserved a Main continuation,
    When the running Main turn is aborted while fetching the child result,
    Then the result lease is released and no continuation request starts`, async () => {
    const workspace = await createWorkspace();
    const controller = new AbortController();
    let releases = 0;
    let continuationCalls = 0;
    const provider: LLMProvider = {
      id: "aborted-agent-wait",
      async *stream() {
        yield {
          type: "tool_call",
          id: "wait-result",
          tool: "agent_wait",
          agentId: "agent-a1",
        };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const continuationProvider: LLMProvider = {
      id: "unused-aborted-continuation",
      async *stream() {
        continuationCalls++;
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const agentControl: AgentControlCapability = {
      ...unusedAgentMutationControl,
      list: () => ({ ok: true, content: "unused" }),
      waitForSettlement: async () => {},
      wait: async () => {
        const failure = new Error("Main turn aborted during wait");
        controller.abort(failure);
        throw failure;
      },
      cancel: async () => ({ ok: true, content: "unused" }),
    };
    const release = () => {
      releases++;
    };
    const resultBudget: SubagentResultContinuationBudget = {
      lease: () => ({
        kind: "granted",
        maxResultChars: 6_000,
        continuation: {
          provider: continuationProvider,
          requestShape: {
            systemPrompt: "main",
            toolExposure: { kind: "auto", agentControl: true },
          },
          release,
        },
        release,
      }),
    };

    try {
      await expect(
        collect(
          runAgentTurn({
            workspace,
            provider,
            ledger: sessionLedgerMirroringMessages([
              { role: "user", content: "Wait for the child." },
            ]),
            systemPrompt: "main",
            signal: controller.signal,
            bash: { kind: "disabled" },
            stopPolicy: defaultStopPolicy(),
            agentControl,
            agentControlResultBudget: resultBudget,
          }),
        ),
      ).rejects.toThrow("Main turn aborted during wait");
      expect(releases).toBe(1);
      expect(continuationCalls).toBe(0);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given agent_wait has published its tool start but has not begun execution,
    When the session owner closes Main before the child settles,
    Then later settlement cannot acquire an orphaned continuation lease`, async () => {
    const workspace = await createWorkspace();
    const settlement = Promise.withResolvers<void>();
    let settlementWaitCalls = 0;
    let leaseCalls = 0;
    let releases = 0;
    const provider: LLMProvider = {
      id: "closed-before-agent-wait",
      async *stream() {
        yield {
          type: "tool_call",
          id: "wait-result",
          tool: "agent_wait",
          agentId: "agent-a1",
        };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const continuationProvider: LLMProvider = {
      id: "orphaned-continuation",
      async *stream() {
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const agentControl: AgentControlCapability = {
      ...unusedAgentMutationControl,
      list: () => ({ ok: true, content: "unused" }),
      waitForSettlement: async () => {
        settlementWaitCalls++;
        await settlement.promise;
      },
      wait: async () => ({ ok: true, content: "unused" }),
      cancel: async () => ({ ok: true, content: "unused" }),
    };
    const release = () => {
      releases++;
    };
    const resultBudget: SubagentResultContinuationBudget = {
      lease: () => {
        leaseCalls++;
        return {
          kind: "granted",
          maxResultChars: 6_000,
          continuation: {
            provider: continuationProvider,
            requestShape: {
              systemPrompt: "You are a helpful assistant.",
              toolExposure: { kind: "auto", agentControl: true },
            },
            release,
          },
          release,
        };
      },
    };

    try {
      const events = runAgentTurn({
        workspace,
        provider,
        ledger: sessionLedgerMirroringMessages([
          { role: "user", content: "Wait for the child." },
        ]),
        systemPrompt: "You are a helpful assistant.",
        signal: freshSignal(),
        bash: { kind: "disabled" },
        stopPolicy: defaultStopPolicy(),
        agentControl,
        agentControlResultBudget: resultBudget,
      });

      expect(await events.next()).toEqual({
        done: false,
        value: {
          type: "tool_start",
          toolCall: {
            id: "wait-result",
            tool: "agent_wait",
            agentId: "agent-a1",
          },
        },
      });
      await events.return(undefined);
      settlement.resolve();
      await settlement.promise;
      await Promise.resolve();

      expect(settlementWaitCalls).toBe(0);
      expect(leaseCalls).toBe(0);
      expect(releases).toBe(0);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a leased continuation pins a narrower tool surface than the next host snapshot,
    When the leased model emits an unexposed delegate call,
    Then pinned authority rejects it before delegation admission can create lifecycle state`, async () => {
    const workspace = await createWorkspace();
    const messages: SessionMessage[] = [
      { role: "user", content: "Use the background result." },
    ];
    let ordinaryProviderCalls = 0;
    let delegationPrepareCalls = 0;
    let leasedToolExposure: unknown;
    const provider: LLMProvider = {
      id: "fresh-main-tool-surface",
      async *stream() {
        if (ordinaryProviderCalls++ === 0) {
          yield {
            type: "tool_call",
            id: "wait-result",
            tool: "agent_wait",
            agentId: "agent-a1",
          };
        } else {
          yield { type: "text", text: "Recovered after the rejected call." };
        }
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const continuationProvider: LLMProvider = {
      id: "pinned-main-tool-surface",
      async *stream(options) {
        leasedToolExposure = options.toolExposure;
        yield {
          type: "tool_call",
          id: "unexposed-delegate",
          tool: "delegate",
          profile: "explorer",
          mode: "background",
          task: "Must not be admitted.",
        };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const agentControl: AgentControlCapability = {
      ...unusedAgentMutationControl,
      list: () => {
        return { ok: true, content: "unused" };
      },
      waitForSettlement: async () => {},
      wait: async () => ({ ok: true, content: "canonical child result" }),
      cancel: async () => ({ ok: true, content: "unused" }),
    };
    const delegation: DelegationCapability = {
      mode: "background",
      profileCatalog: builtinSubagentProfileCatalog,
      available: () => true,
      delegate: async () => ({
        ok: false,
        reason: "unused",
        delivery: "rejected",
        recovery: "Continue in Main.",
        maxResultChars: 6_000,
      }),
      prepareBatch: () => {
        delegationPrepareCalls++;
        throw new Error("unexposed delegation must not be prepared");
      },
    };
    const release = () => {};
    const resultBudget: SubagentResultContinuationBudget = {
      lease: () => ({
        kind: "granted",
        maxResultChars: 6_000,
        continuation: {
          provider: continuationProvider,
          requestShape: {
            systemPrompt: "Pinned system prompt.",
            toolExposure: { kind: "none" },
          },
          release,
        },
        release,
      }),
    };

    try {
      await collect(
        runAgentTurn({
          workspace,
          provider,
          ledger: sessionLedgerMirroringMessages(messages),
          systemPrompt: "Fresh system prompt.",
          signal: freshSignal(),
          bash: { kind: "disabled" },
          stopPolicy: defaultStopPolicy(),
          agentControl,
          agentControlResultBudget: resultBudget,
          delegation,
        }),
      );

      expect(leasedToolExposure).toEqual({ kind: "none" });
      expect(delegationPrepareCalls).toBe(0);
      expect(messages).toContainEqual({
        role: "tool",
        toolCallId: "unexposed-delegate",
        content: expect.stringContaining(
          "delegate is unavailable in the current tool authority context",
        ),
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given agent_wait holds a Main continuation lease,
    When preparing the next turn fails before the leased provider starts,
    Then Keel releases the held continuation`, async () => {
    const workspace = await createWorkspace();
    const messages: SessionMessage[] = [
      { role: "user", content: "Use the background result." },
    ];
    let availabilityCalls = 0;
    let leasedProviderCalls = 0;
    let releases = 0;
    const provider: LLMProvider = {
      id: "main-provider-before-preparation-failure",
      async *stream() {
        yield {
          type: "tool_call",
          id: "wait-result",
          tool: "agent_wait",
          agentId: "agent-a1",
        };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const continuationProvider: LLMProvider = {
      id: "unused-leased-provider",
      async *stream() {
        leasedProviderCalls++;
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const agentControl: AgentControlCapability = {
      ...unusedAgentMutationControl,
      list: () => ({ ok: true, content: "unused" }),
      waitForSettlement: async () => {},
      wait: async () => ({ ok: true, content: "canonical child result" }),
      cancel: async () => ({ ok: true, content: "unused" }),
    };
    const resultBudget: SubagentResultContinuationBudget = {
      lease: () => ({
        kind: "granted",
        maxResultChars: 6_000,
        continuation: {
          provider: continuationProvider,
          requestShape: {
            systemPrompt: "You are a helpful assistant.",
            toolExposure: { kind: "auto", agentControl: true },
          },
          release: () => {
            releases++;
          },
        },
        release: () => {
          releases++;
        },
      }),
    };
    const delegation: DelegationCapability = {
      mode: "background",
      profileCatalog: builtinSubagentProfileCatalog,
      available: () => {
        availabilityCalls++;
        if (availabilityCalls === 2) throw new Error("capability failed");
        return false;
      },
      delegate: async () => ({
        ok: false,
        reason: "unused",
        delivery: "rejected",
        recovery: "Continue in Main.",
        maxResultChars: 6_000,
      }),
      prepareBatch: () => {
        throw new Error("unused");
      },
    };

    try {
      await expect(
        collect(
          runAgentTurn({
            workspace,
            provider,
            ledger: sessionLedgerMirroringMessages(messages),
            systemPrompt: "You are a helpful assistant.",
            signal: freshSignal(),
            bash: { kind: "disabled" },
            stopPolicy: defaultStopPolicy(),
            agentControl,
            agentControlResultBudget: resultBudget,
            delegation,
          }),
        ),
      ).rejects.toThrow("capability failed");

      expect(availabilityCalls).toBe(2);
      expect(leasedProviderCalls).toBe(0);
      expect(releases).toBe(1);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given agent_wait carries a Main continuation into an MCP-enabled turn,
    When MCP preparation fails before the leased provider starts,
    Then Keel releases the continuation instead of leaking session budget`, async () => {
    const workspace = await createWorkspace();
    let preparationCalls = 0;
    let releases = 0;
    let continuationCalls = 0;
    const provider: LLMProvider = {
      id: "main-before-mcp-preparation-failure",
      async *stream() {
        yield {
          type: "tool_call",
          id: "wait-result",
          tool: "agent_wait",
          agentId: "agent-a1",
        };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const continuationProvider: LLMProvider = {
      id: "unused-after-mcp-preparation-failure",
      async *stream() {
        continuationCalls++;
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const mcp: McpRuntime = {
      prepareTurn: async () => {
        preparationCalls++;
        if (preparationCalls === 2) throw new Error("MCP preparation failed");
      },
      exposureSnapshot: async () => ({
        snapshotId: "empty",
        catalogAvailable: true,
        tools: [],
      }),
      search: async () => ({ ok: false, content: "unused" }),
      execute: async () => {
        throw new Error("unused");
      },
      close: async () => {},
    };
    const agentControl: AgentControlCapability = {
      ...unusedAgentMutationControl,
      list: () => ({ ok: true, content: "unused" }),
      waitForSettlement: async () => {},
      wait: async () => ({ ok: true, content: "canonical child result" }),
      cancel: async () => ({ ok: true, content: "unused" }),
    };
    const release = () => {
      releases++;
    };
    const resultBudget: SubagentResultContinuationBudget = {
      lease: () => ({
        kind: "granted",
        maxResultChars: 6_000,
        continuation: {
          provider: continuationProvider,
          requestShape: {
            systemPrompt: "main",
            toolExposure: { kind: "auto", agentControl: true },
          },
          release,
        },
        release,
      }),
    };

    try {
      await expect(
        collect(
          runAgentTurn({
            workspace,
            provider,
            ledger: sessionLedgerMirroringMessages([
              { role: "user", content: "Wait for the child." },
            ]),
            systemPrompt: "main",
            signal: freshSignal(),
            bash: { kind: "disabled" },
            stopPolicy: defaultStopPolicy(),
            agentControl,
            agentControlResultBudget: resultBudget,
            mcp: {
              runtime: mcp,
              schemaTarget: mcpProviderSchemaTarget("fake", "fake"),
            },
          }),
        ),
      ).rejects.toThrow("MCP preparation failed");
      expect(preparationCalls).toBe(2);
      expect(releases).toBe(1);
      expect(continuationCalls).toBe(0);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given agent_wait is mixed with an unrelated tool call,
    When the round cannot be priced as one bounded child-result continuation,
    Then Keel leaves the child result behind agent_wait and tells Main to retry it alone`, async () => {
    const workspace = await createWorkspace();
    const messages: SessionMessage[] = [
      { role: "user", content: "Wait and inspect a file." },
    ];
    let providerTurn = 0;
    let waitCalls = 0;
    let leaseCalls = 0;
    const provider: LLMProvider = {
      id: "mixed-agent-wait-round",
      async *stream() {
        if (providerTurn++ === 0) {
          yield {
            type: "tool_call",
            id: "wait-result",
            tool: "agent_wait",
            agentId: "agent-a1",
          };
          yield {
            type: "tool_call",
            id: "read-file",
            tool: "read",
            path: "missing.txt",
          };
        } else {
          yield { type: "text", text: "I will retry agent_wait alone." };
        }
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const agentControl: AgentControlCapability = {
      ...unusedAgentMutationControl,
      list: () => ({ ok: true, content: "unused" }),
      waitForSettlement: async () => {},
      wait: async () => {
        waitCalls++;
        return { ok: true, content: "must remain hidden" };
      },
      cancel: async () => ({ ok: true, content: "unused" }),
    };
    const resultBudget: SubagentResultContinuationBudget = {
      lease: () => {
        leaseCalls++;
        return { kind: "rejected" };
      },
    };

    try {
      await collect(
        runAgentTurn({
          workspace,
          provider,
          ledger: sessionLedgerMirroringMessages(messages),
          systemPrompt: "You are a helpful assistant.",
          signal: freshSignal(),
          bash: { kind: "disabled" },
          stopPolicy: defaultStopPolicy(),
          agentControl,
          agentControlResultBudget: resultBudget,
        }),
      );

      expect(waitCalls).toBe(0);
      expect(leaseCalls).toBe(0);
      expect(messages).toContainEqual({
        role: "tool",
        toolCallId: "wait-result",
        content: expect.stringContaining(
          "agent_wait must be isolated from non-wait tools",
        ),
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the assistant inspects independent files in one turn,
    When every requested tool is read-only,
    Then the user sees both reads start before either result and the model receives ordered results`, async () => {
    // Given
    const workspace = await createWorkspace();
    await writeFile(join(workspace, "existing.txt"), "visible\n", "utf8");
    let turn = 0;
    let followUpMessages: readonly ProviderMessage[] = [];
    const provider: LLMProvider = {
      id: "parallel-read-provider",
      async *stream(options) {
        if (turn === 0) {
          turn++;
          yield {
            type: "tool_call",
            id: "read_missing",
            tool: "read",
            path: "missing.txt",
          };
          yield {
            type: "tool_call",
            id: "read_existing",
            tool: "read",
            path: "existing.txt",
          };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }

        followUpMessages = options.messages;
        yield { type: "text", text: "Inspected both files." };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };

    try {
      // When
      const events = await collect(
        runAgent({
          workspace,
          provider,
          userMessage: "inspect the files",
          systemPrompt: "You are a helpful assistant.",
          signal: freshSignal(),
          bash: { kind: "disabled" },
          stopPolicy: defaultStopPolicy(),
        }),
      );

      // Then
      expect(toolEventTrace(events)).toEqual([
        "read_missing:start",
        "read_existing:start",
        "read_missing:end:false",
        "read_existing:end:true",
      ]);
      const toolMessages = followUpMessages.filter(isToolMessage);
      expect(toolMessages.map((message) => message.toolCallId)).toEqual([
        "read_missing",
        "read_existing",
      ]);
      expect(toolMessages[0]?.content).toContain("file not found");
      expect(toolMessages[1]?.content).toContain("visible");
      expect(events).toContainEqual({
        type: "text",
        text: "Inspected both files.",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a durable parallel batch exceeds the ten-worker limit,
    When the first wave is still being scheduled,
    Then Keel records intent only as each worker dispatches its tool call`, async () => {
    const workspace = await createWorkspace();
    const toolCallIds = Array.from(
      { length: 11 },
      (_, index) => `limited_read_${index + 1}`,
    );
    await Promise.all(
      toolCallIds.map((_, index) =>
        writeFile(
          join(workspace, `shared-${index + 1}.txt`),
          "visible\n",
          "utf8",
        ),
      ),
    );
    const durableIntents: string[] = [];
    const durableSettlements: string[] = [];
    let settledBeforeEleventhIntent = -1;
    let turn = 0;
    const provider: LLMProvider = {
      id: "parallel-durable-intent-limit-provider",
      async *stream() {
        if (turn++ === 0) {
          for (const [index, id] of toolCallIds.entries()) {
            yield {
              type: "tool_call",
              id,
              tool: "read",
              path: `shared-${index + 1}.txt`,
            };
          }
        } else {
          yield { type: "text", text: "All reads finished." };
        }
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };

    try {
      await collect(
        runAgentTurn({
          workspace,
          provider,
          ledger: sessionLedgerMirroringMessages([
            { role: "user", content: "read eleven times" },
          ]),
          systemPrompt: "You are a helpful assistant.",
          signal: freshSignal(),
          bash: { kind: "disabled" },
          stopPolicy: defaultStopPolicy(),
          providerRecovery: {
            beforeRequest: () => {},
            providerRequestAttempts: {
              begin: () => ({ finish: () => {} }),
            },
            auxiliaryProviderRequestAttempts: {
              begin: () => ({ finish: () => {} }),
            },
            settled: () => {},
            beforeToolCalls: (toolCalls) => {
              expect(toolCalls).toHaveLength(1);
              const [toolCall] = toolCalls;
              if (toolCall === undefined) {
                throw new Error("expected one dispatched tool call");
              }
              if (toolCall.id === toolCallIds[10]) {
                settledBeforeEleventhIntent = durableSettlements.length;
              }
              durableIntents.push(toolCall.id);
            },
            toolSettled: ({ toolMessage }) => {
              durableSettlements.push(toolMessage.toolCallId);
            },
          },
        }),
      );

      expect(durableIntents).toEqual(toolCallIds);
      expect(durableSettlements).toEqual(toolCallIds);
      expect(settledBeforeEleventhIntent).toBeGreaterThanOrEqual(1);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the assistant edits a file and reads it in one turn,
    When the batch includes a workspace mutation,
    Then the read waits for the edit and sees the updated content`, async () => {
    // Given
    const workspace = await createWorkspace();
    await writeFile(join(workspace, "note.txt"), "before\n", "utf8");
    let turn = 0;
    let followUpMessages: readonly ProviderMessage[] = [];
    const provider: LLMProvider = {
      id: "mixed-edit-read-provider",
      async *stream(options) {
        if (turn === 0) {
          turn++;
          yield {
            type: "tool_call",
            id: "read_note_before_edit",
            tool: "read",
            path: "note.txt",
          };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }

        if (turn === 1) {
          turn++;
          yield {
            type: "tool_call",
            id: "update_note",
            tool: "edit",
            path: "note.txt",
            edits: [{ oldText: "before", newText: "after" }],
          };
          yield {
            type: "tool_call",
            id: "read_note",
            tool: "read",
            path: "note.txt",
          };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }

        turn++;
        followUpMessages = options.messages;
        yield { type: "text", text: "Updated and checked the note." };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };

    try {
      // When
      const events = await collect(
        runAgent({
          workspace,
          provider,
          userMessage: "update note.txt and check it",
          systemPrompt: "You are a helpful assistant.",
          signal: freshSignal(),
          bash: { kind: "disabled" },
          stopPolicy: defaultStopPolicy(),
        }),
      );

      // Then
      expect(toolEventTrace(events)).toEqual([
        "read_note_before_edit:start",
        "read_note_before_edit:end:true",
        "update_note:start",
        "update_note:end:true",
        "read_note:start",
        "read_note:end:true",
      ]);
      expect(await readFile(join(workspace, "note.txt"), "utf8")).toBe(
        "after\n",
      );
      const toolMessages = followUpMessages.filter(isToolMessage);
      expect(toolMessages.map((message) => message.toolCallId)).toEqual([
        "read_note_before_edit",
        "update_note",
        "read_note",
      ]);
      expect(toolMessages[2]?.content).toContain("after");
      expect(events).toContainEqual({
        type: "text",
        text: "Updated and checked the note.",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the assistant inspects files before and after editing in one turn,
    When read-only calls are separated by a workspace mutation,
    Then independent reads overlap on each side while the edit remains a barrier`, async () => {
    // Given
    const workspace = await createWorkspace();
    await writeFile(join(workspace, "note.txt"), "before\n", "utf8");
    await writeFile(join(workspace, "todo.txt"), "todo: before\n", "utf8");
    let turn = 0;
    let followUpMessages: readonly ProviderMessage[] = [];
    const provider: LLMProvider = {
      id: "mixed-batch-provider",
      async *stream(options) {
        if (turn === 0) {
          turn++;
          yield {
            type: "tool_call",
            id: "read_note_initial",
            tool: "read",
            path: "note.txt",
          };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }

        if (turn === 1) {
          turn++;
          yield {
            type: "tool_call",
            id: "read_note_before",
            tool: "read",
            path: "note.txt",
          };
          yield {
            type: "tool_call",
            id: "grep_todo",
            tool: "grep",
            pattern: "todo",
          };
          yield {
            type: "tool_call",
            id: "update_note",
            tool: "edit",
            path: "note.txt",
            edits: [{ oldText: "before", newText: "after" }],
          };
          yield {
            type: "tool_call",
            id: "read_note_after",
            tool: "read",
            path: "note.txt",
          };
          yield {
            type: "tool_call",
            id: "list_workspace",
            tool: "ls",
          };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }

        turn++;
        followUpMessages = options.messages;
        yield { type: "text", text: "Updated the note after inspection." };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };

    try {
      // When
      const events = await collect(
        runAgent({
          workspace,
          provider,
          userMessage: "inspect the workspace, update note.txt, and verify it",
          systemPrompt: "You are a helpful assistant.",
          signal: freshSignal(),
          bash: { kind: "disabled" },
          stopPolicy: defaultStopPolicy(),
        }),
      );

      // Then
      expect(toolEventTrace(events)).toEqual([
        "read_note_initial:start",
        "read_note_initial:end:true",
        "read_note_before:start",
        "grep_todo:start",
        "read_note_before:end:true",
        "grep_todo:end:true",
        "update_note:start",
        "update_note:end:true",
        "read_note_after:start",
        "list_workspace:start",
        "read_note_after:end:true",
        "list_workspace:end:true",
      ]);
      expect(await readFile(join(workspace, "note.txt"), "utf8")).toBe(
        "after\n",
      );
      const toolMessages = followUpMessages.filter(isToolMessage);
      expect(toolMessages.map((message) => message.toolCallId)).toEqual([
        "read_note_initial",
        "read_note_before",
        "grep_todo",
        "update_note",
        "read_note_after",
        "list_workspace",
      ]);
      expect(toolMessages[4]?.content).toContain("after");
      expect(events).toContainEqual({
        type: "text",
        text: "Updated the note after inspection.",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the assistant requests dependent edits to the same file after one read,
    When the batch includes workspace mutations,
    Then the second edit is rejected until the assistant rereads the file`, async () => {
    // Given
    const workspace = await createWorkspace();
    await writeFile(join(workspace, "note.txt"), "alpha\n", "utf8");
    let turn = 0;
    const provider: LLMProvider = {
      id: "dependent-edits-provider",
      async *stream() {
        if (turn === 0) {
          turn++;
          yield {
            type: "tool_call",
            id: "read_note",
            tool: "read",
            path: "note.txt",
          };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }

        if (turn === 1) {
          turn++;
          yield {
            type: "tool_call",
            id: "expand_alpha",
            tool: "edit",
            path: "note.txt",
            edits: [{ oldText: "alpha", newText: "alpha beta" }],
          };
          yield {
            type: "tool_call",
            id: "expand_beta",
            tool: "edit",
            path: "note.txt",
            edits: [{ oldText: "alpha beta", newText: "alpha beta gamma" }],
          };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }

        yield { type: "text", text: "Expanded the note." };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };

    try {
      // When
      const events = await collect(
        runAgent({
          workspace,
          provider,
          userMessage: "expand note.txt",
          systemPrompt: "You are a helpful assistant.",
          signal: freshSignal(),
          bash: { kind: "disabled" },
          stopPolicy: defaultStopPolicy(),
        }),
      );

      // Then
      expect(toolEventTrace(events)).toEqual([
        "read_note:start",
        "read_note:end:true",
        "expand_alpha:start",
        "expand_alpha:end:true",
        "expand_beta:start",
        "expand_beta:end:false",
      ]);
      expect(await readFile(join(workspace, "note.txt"), "utf8")).toBe(
        "alpha beta\n",
      );
      expect(events).toContainEqual({
        type: "text",
        text: "Expanded the note.",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the assistant updates independent files in one turn,
    When both mutations target different files that were already read,
    Then the user sees both edits start in the same batch and one undo checkpoint restores the task`, async () => {
    // Given
    const workspace = await createGitWorkspace(
      "keel-tool-scheduling-independent-edits-",
    );
    await writeFile(join(workspace, "alpha.txt"), "alpha old\n", "utf8");
    await writeFile(join(workspace, "beta.txt"), "beta old\n", "utf8");
    let turn = 0;
    let followUpMessages: readonly ProviderMessage[] = [];
    const provider: LLMProvider = {
      id: "independent-edits-provider",
      async *stream(options) {
        if (turn === 0) {
          turn++;
          yield {
            type: "tool_call",
            id: "read_alpha",
            tool: "read",
            path: "alpha.txt",
          };
          yield {
            type: "tool_call",
            id: "read_beta",
            tool: "read",
            path: "beta.txt",
          };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }

        if (turn === 1) {
          turn++;
          yield {
            type: "tool_call",
            id: "edit_alpha",
            tool: "edit",
            path: "alpha.txt",
            edits: [{ oldText: "alpha old", newText: "alpha new" }],
          };
          yield {
            type: "tool_call",
            id: "edit_beta",
            tool: "edit",
            path: "beta.txt",
            edits: [{ oldText: "beta old", newText: "beta new" }],
          };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }

        followUpMessages = options.messages;
        yield { type: "text", text: "Updated both files." };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };

    try {
      // When
      const events = await collect(
        runAgent({
          workspace,
          provider,
          userMessage: "update alpha.txt and beta.txt",
          systemPrompt: "You are a helpful assistant.",
          signal: freshSignal(),
          bash: { kind: "disabled" },
          stopPolicy: defaultStopPolicy(),
        }),
      );

      // Then
      expect(toolEventTrace(events)).toEqual([
        "read_alpha:start",
        "read_beta:start",
        "read_alpha:end:true",
        "read_beta:end:true",
        "edit_alpha:start",
        "edit_beta:start",
        "edit_alpha:end:true",
        "edit_beta:end:true",
      ]);
      expect(await readFile(join(workspace, "alpha.txt"), "utf8")).toBe(
        "alpha new\n",
      );
      expect(await readFile(join(workspace, "beta.txt"), "utf8")).toBe(
        "beta new\n",
      );

      const restore = restoreLastEditCheckpoint(workspace);
      expect(restore).toEqual({
        status: "restored",
        restoredLabel: "2 files",
      });
      expect(await readFile(join(workspace, "alpha.txt"), "utf8")).toBe(
        "alpha old\n",
      );
      expect(await readFile(join(workspace, "beta.txt"), "utf8")).toBe(
        "beta old\n",
      );

      const toolMessages = followUpMessages.filter(isToolMessage);
      expect(toolMessages.map((message) => message.toolCallId)).toEqual([
        "read_alpha",
        "read_beta",
        "edit_alpha",
        "edit_beta",
      ]);
      expect(events).toContainEqual({
        type: "text",
        text: "Updated both files.",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the assistant creates independent files in one turn,
    When both writes target different paths,
    Then the user sees both writes start in the same batch and one undo checkpoint restores the task`, async () => {
    // Given
    const workspace = await createGitWorkspace(
      "keel-tool-scheduling-independent-writes-",
    );
    let followUpMessages: readonly ProviderMessage[] = [];
    let turn = 0;
    const provider: LLMProvider = {
      id: "independent-writes-provider",
      async *stream(options) {
        if (turn === 0) {
          turn++;
          yield {
            type: "tool_call",
            id: "write_alpha",
            tool: "write",
            path: "generated/alpha.txt",
            content: "alpha\n",
          };
          yield {
            type: "tool_call",
            id: "write_beta",
            tool: "write",
            path: "generated/beta.txt",
            content: "beta\n",
          };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }

        followUpMessages = options.messages;
        yield { type: "text", text: "Created both files." };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };

    try {
      // When
      const events = await collect(
        runAgent({
          workspace,
          provider,
          userMessage: "create alpha and beta files",
          systemPrompt: "You are a helpful assistant.",
          signal: freshSignal(),
          bash: { kind: "disabled" },
          stopPolicy: defaultStopPolicy(),
        }),
      );

      // Then
      expect(toolEventTrace(events)).toEqual([
        "write_alpha:start",
        "write_beta:start",
        "write_alpha:end:true",
        "write_beta:end:true",
      ]);
      expect(
        await readFile(join(workspace, "generated", "alpha.txt"), "utf8"),
      ).toBe("alpha\n");
      expect(
        await readFile(join(workspace, "generated", "beta.txt"), "utf8"),
      ).toBe("beta\n");

      const restore = restoreLastEditCheckpoint(workspace);
      expect(restore).toEqual({
        status: "restored",
        restoredLabel: "2 files",
      });
      await expect(
        readFile(join(workspace, "generated", "alpha.txt"), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        readFile(join(workspace, "generated", "beta.txt"), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });

      const toolMessages = followUpMessages.filter(isToolMessage);
      expect(toolMessages.map((message) => message.toolCallId)).toEqual([
        "write_alpha",
        "write_beta",
      ]);
      expect(events).toContainEqual({
        type: "text",
        text: "Created both files.",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a durable Task executes independent writes in one tool round,
    When each write finishes,
    Then each mutation checkpoint is independently included in its durable settlement`, async () => {
    const workspace = await createWorkspace();
    const messages: SessionMessage[] = [
      { role: "user", content: "create two durable files" },
    ];
    const durableSettlements: {
      readonly toolCallId: string;
      readonly checkpointOperationCount: number;
    }[] = [];
    let turn = 0;
    const provider: LLMProvider = {
      id: "durable-independent-writes-provider",
      async *stream() {
        if (turn === 0) {
          turn++;
          yield {
            type: "tool_call",
            id: "durable_write_alpha",
            tool: "write",
            path: "alpha.txt",
            content: "alpha\n",
          };
          yield {
            type: "tool_call",
            id: "durable_write_beta",
            tool: "write",
            path: "beta.txt",
            content: "beta\n",
          };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        yield { type: "text", text: "Both writes are durable." };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };

    try {
      await collect(
        runAgentTurn({
          workspace,
          provider,
          ledger: sessionLedgerMirroringMessages(messages),
          systemPrompt: "You are a helpful assistant.",
          signal: freshSignal(),
          bash: { kind: "disabled" },
          stopPolicy: defaultStopPolicy(),
          providerRecovery: {
            beforeRequest: () => {},
            providerRequestAttempts: {
              begin: () => ({ finish: () => {} }),
            },
            auxiliaryProviderRequestAttempts: {
              begin: () => ({ finish: () => {} }),
            },
            settled: () => {},
            beforeToolCalls: () => {},
            toolSettled: ({ toolMessage, effects }) => {
              durableSettlements.push({
                toolCallId: toolMessage.toolCallId,
                checkpointOperationCount: effects.checkpointOperations.length,
              });
            },
          },
        }),
      );

      expect(durableSettlements).toEqual([
        { toolCallId: "durable_write_alpha", checkpointOperationCount: 1 },
        { toolCallId: "durable_write_beta", checkpointOperationCount: 1 },
      ]);
      expect(await readFile(join(workspace, "alpha.txt"), "utf8")).toBe(
        "alpha\n",
      );
      expect(await readFile(join(workspace, "beta.txt"), "utf8")).toBe(
        "beta\n",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a read-only batch has a source-earlier success before cancellation,
    When a later scheduled tool rejects with a terminal error,
    Then the artifact-backed successful result is still recorded before the run fails`, async () => {
    // Given
    const workspace = await createWorkspace();
    await writeFile(
      join(workspace, "note.txt"),
      ["VISIBLE_START", "visible ".repeat(120), "VISIBLE_END"].join("\n"),
      "utf8",
    );
    const abortController = new AbortController();
    abortController.abort();
    const messages: SessionMessage[] = [
      { role: "user", content: "inspect and search" },
    ];
    const saved: ToolOutputArtifactSaveInput[] = [];
    const durableToolResults: SessionMessage[] = [];
    const provider: LLMProvider = {
      id: "terminal-parallel-search-provider",
      async *stream() {
        yield {
          type: "tool_call",
          id: "read_note",
          tool: "read",
          path: "note.txt",
        };
        yield {
          type: "tool_call",
          id: "cancelled_search",
          tool: "grep",
          pattern: "visible",
        };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const events: AgentEvent[] = [];

    try {
      // When / Then
      await expect(async () => {
        for await (const event of runAgentTurn({
          workspace,
          provider,
          ledger: sessionLedgerMirroringMessages(messages),
          systemPrompt: "You are a helpful assistant.",
          signal: abortController.signal,
          bash: { kind: "disabled" },
          stopPolicy: defaultStopPolicy(),
          toolOutputArtifacts: {
            store: storedArtifactStore(saved),
            maxInlineChars: 64,
          },
          providerRecovery: {
            beforeRequest: () => {},
            providerRequestAttempts: {
              begin: () => ({ finish: () => {} }),
            },
            auxiliaryProviderRequestAttempts: {
              begin: () => ({ finish: () => {} }),
            },
            settled: () => {},
            beforeToolCalls: () => {},
            toolSettled: ({ toolMessage }) => {
              durableToolResults.push(toolMessage);
            },
          },
        })) {
          events.push(event);
        }
      }).rejects.toMatchObject({
        name: "AbortError",
        code: "ABORT_ERR",
      });

      expect(toolEventTrace(events)).toEqual([
        "read_note:start",
        "cancelled_search:start",
        "read_note:end:true",
      ]);
      expect(events).toContainEqual({
        type: "tool_output_artifact",
        status: "stored",
        ref: "tool-output:test/1",
        toolCallId: "read_note",
        toolName: "read",
        sourceStatus: "complete",
        omittedChars: expect.any(Number),
      });
      expect(saved).toHaveLength(1);
      expect(durableToolResults).toEqual([
        expect.objectContaining({
          role: "tool",
          toolCallId: "read_note",
          content: expect.stringContaining("keel artifacts show"),
          evidenceShortened: true,
        }),
      ]);
      expect(messages).toContainEqual({
        role: "tool",
        toolCallId: "read_note",
        content: expect.stringContaining(
          "keel artifacts show tool-output:test/1",
        ),
        evidenceShortened: true,
        resourceObservation: expect.objectContaining({
          kind: "read_projection",
        }),
      });
      expect(
        messages.some(
          (message) =>
            message.role === "tool" &&
            message.toolCallId === "cancelled_search",
        ),
      ).toBe(false);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a sequential tool throws after a source-earlier success,
    When the pending success is artifact-backed,
    Then the artifact notice is emitted before the run fails`, async () => {
    // Given
    const workspace = await createWorkspace();
    await writeFile(
      join(workspace, "note.txt"),
      ["VISIBLE_START", "visible ".repeat(120), "VISIBLE_END"].join("\n"),
      "utf8",
    );
    const abortController = new AbortController();
    abortController.abort();
    const messages: SessionMessage[] = [
      { role: "user", content: "inspect then run" },
    ];
    const saved: ToolOutputArtifactSaveInput[] = [];
    const provider: LLMProvider = {
      id: "terminal-single-bash-provider",
      async *stream() {
        yield {
          type: "tool_call",
          id: "read_note",
          tool: "read",
          path: "note.txt",
        };
        yield {
          type: "tool_call",
          id: "cancelled_bash",
          tool: "bash",
          command: "printf done",
        };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const events: AgentEvent[] = [];

    try {
      // When / Then
      await expect(async () => {
        for await (const event of runAgentTurn({
          workspace,
          provider,
          ledger: sessionLedgerMirroringMessages(messages),
          systemPrompt: "You are a helpful assistant.",
          signal: abortController.signal,
          bash: { kind: "trusted" },
          stopPolicy: defaultStopPolicy(),
          toolOutputArtifacts: {
            store: storedArtifactStore(saved),
            maxInlineChars: 64,
          },
        })) {
          events.push(event);
        }
      }).rejects.toMatchObject({
        name: "KeelError",
        code: "tool_aborted",
      });

      expect(toolEventTrace(events)).toEqual([
        "read_note:start",
        "read_note:end:true",
        "cancelled_bash:start",
      ]);
      expect(events).toContainEqual({
        type: "tool_output_artifact",
        status: "stored",
        ref: "tool-output:test/1",
        toolCallId: "read_note",
        toolName: "read",
        sourceStatus: "complete",
        omittedChars: expect.any(Number),
      });
      expect(saved).toHaveLength(1);
      expect(messages).toContainEqual({
        role: "tool",
        toolCallId: "read_note",
        content: expect.stringContaining(
          "keel artifacts show tool-output:test/1",
        ),
        evidenceShortened: true,
        resourceObservation: expect.objectContaining({
          kind: "read_projection",
        }),
      });
      expect(
        messages.some(
          (message) =>
            message.role === "tool" && message.toolCallId === "cancelled_bash",
        ),
      ).toBe(false);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
