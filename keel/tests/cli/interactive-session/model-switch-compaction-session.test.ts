import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, test } from "vitest";
import type { AgentEvent } from "../../../src/agent/events.ts";
import type { ToolOutputArtifactStore } from "../../../src/agent/tool-output-artifacts.ts";
import type { ProviderSelection } from "../../../src/cli/interactive-session/types.ts";
import { runInteractiveSession } from "../../../src/cli/interactive-session.ts";
import type { LLMProvider, Message } from "../../../src/llm/types.ts";
import {
  EXPENSIVE_USAGE,
  ForcedExit,
  ONE_DOLLAR_PER_MILLION_INPUT,
  resolvedProvider,
  textProvider,
  withTimeout,
  ZERO_COST_MODEL,
  ZERO_USAGE,
} from "../../../src/testing/interactive-session-fixtures.ts";

describe("Interactive Session - Model Switch Compaction Session", () => {
  test(`Given restored history has no safe model-switch compaction boundary,
    When user enters /model for a smaller target,
    Then the switch is rejected and the default provider remains active`, async () => {
    // Given
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    let stdout = "";
    let stderr = "";
    let oldProviderTurns = 0;
    let targetProviderTurns = 0;
    const largePrompt = "large history ".repeat(3_000).trim();
    const artifactStore: ToolOutputArtifactStore = {
      verifyReusable: async () => ({ status: "not_reusable" }),
      save: async () => ({
        status: "failed",
        reason: "unexpected artifact save in rescue test",
      }),
    };
    const oldProvider: LLMProvider = {
      id: "fake",
      async *stream() {
        oldProviderTurns++;
        yield { type: "text", text: `old provider ${oldProviderTurns}` };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const targetProvider: LLMProvider = {
      id: "fake",
      async *stream() {
        targetProviderTurns++;
        yield { type: "text", text: "unexpected target" };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
      platform: process.platform,
      initialMessages: [{ role: "user", content: largePrompt }],
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
      },
      onSigint: (handler) => {
        sigintHandlers.add(handler);
      },
      offSigint: (handler) => {
        sigintHandlers.delete(handler);
      },
      setExitCode: () => {},
      forceExit: (code) => {
        throw new ForcedExit(code);
      },
      resolveProvider: (_message, selection?: ProviderSelection) => {
        if (selection?.providerId === "qwen") {
          return resolvedProvider(
            "qwen",
            selection.model ?? "tiny",
            targetProvider,
            ZERO_COST_MODEL,
            {
              contextWindowTokens: 2_000,
              reserveTokens: 0,
              keepRecentTokens: 1,
            },
          );
        }
        return resolvedProvider("fake", "fake", oldProvider);
      },
      toolOutputArtifacts: { store: artifactStore },
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async (stream) => {
        let finalEnd: Extract<AgentEvent, { readonly type: "end" }> | undefined;
        for await (const event of stream) {
          if (event.type === "text") {
            stdout += event.text;
          } else if (event.type === "end") {
            finalEnd = event;
          }
        }
        return finalEnd;
      },
      formatCostReport: () => "",
    });

    // When
    input.end("/model qwen/tiny\nsecond prompt\n");

    // Then
    await session;
    expect(stderr).toContain("Context rescue:");
    expect(stderr).toContain("no safe compaction split");
    expect(stderr).toContain("switching to qwen/tiny requires compaction");
    expect(stdout).toContain("old provider 1");
    expect(stdout).not.toContain("unexpected target");
    expect(oldProviderTurns).toBe(1);
    expect(targetProviderTurns).toBe(0);
    expect(sigintHandlers.size).toBe(0);
  });

  test(`Given model-switch compaction exceeds the cost budget,
    When user enters /model for a smaller target,
    Then Keel records the compaction cost and stops before the queued prompt`, async () => {
    // Given
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    let stdout = "";
    let stderr = "";
    let oldProviderSummaryRequests = 0;
    let targetProviderTurns = 0;
    const initialMessages: readonly Message[] = [
      { role: "user", content: "large history ".repeat(3_000).trim() },
      { role: "assistant", content: "old provider 1", toolCalls: [] },
    ];
    const oldProvider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        if (options.toolChoice === "none") {
          oldProviderSummaryRequests++;
          yield { type: "text", text: "Costly checkpoint summary." };
          yield { type: "stop", reason: "stop", usage: EXPENSIVE_USAGE };
          return;
        }
        yield { type: "text", text: "unexpected old turn" };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const targetProvider: LLMProvider = {
      id: "fake",
      async *stream() {
        targetProviderTurns++;
        yield { type: "text", text: "unexpected target" };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled", maxCostUsd: 0.01 },
      workspace: process.cwd(),
      platform: process.platform,
      initialMessages,
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
      },
      onSigint: (handler) => {
        sigintHandlers.add(handler);
      },
      offSigint: (handler) => {
        sigintHandlers.delete(handler);
      },
      setExitCode: () => {},
      forceExit: (code) => {
        throw new ForcedExit(code);
      },
      resolveProvider: (_message, selection?: ProviderSelection) => {
        if (selection?.providerId === "qwen") {
          return resolvedProvider(
            "qwen",
            selection.model ?? "tiny",
            targetProvider,
            ONE_DOLLAR_PER_MILLION_INPUT,
            {
              contextWindowTokens: 2_000,
              reserveTokens: 0,
              keepRecentTokens: 1,
            },
          );
        }
        return resolvedProvider(
          "fake",
          "fake",
          oldProvider,
          ONE_DOLLAR_PER_MILLION_INPUT,
        );
      },
      requireKnownCostModel: () => ONE_DOLLAR_PER_MILLION_INPUT,
      printAgentEvents: async (stream) => {
        let finalEnd: Extract<AgentEvent, { readonly type: "end" }> | undefined;
        for await (const event of stream) {
          if (event.type === "text") {
            stdout += event.text;
          } else if (event.type === "end") {
            finalEnd = event;
          }
        }
        return finalEnd;
      },
      formatCostReport: (cost, maxUsd) =>
        `Cost: ${cost.spentUsd.toFixed(2)} / ${maxUsd.toFixed(2)} exceeded=${cost.budgetExceeded}\n`,
    });

    // When
    input.end("/model qwen/tiny\nsecond prompt\n");

    // Then
    await session;
    expect(stdout).toContain("Model switched to qwen/tiny");
    expect(stdout).not.toContain("unexpected target");
    expect(stderr).toContain("Context compacted: model switch");
    expect(stderr).toContain("Cost: 2.00 / 0.01 exceeded=true");
    expect(oldProviderSummaryRequests).toBe(1);
    expect(targetProviderTurns).toBe(0);
    expect(sigintHandlers.size).toBe(0);
  });

  test(`Given persisted model-switch compaction exceeds the cost budget,
    When a named session consumes the model command through compaction persistence,
    Then budget stopping does not consume the queued input a second time`, async () => {
    // Given
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    let stdout = "";
    let stderr = "";
    let oldProviderSummaryRequests = 0;
    let targetProviderTurns = 0;
    const persisted: Array<{
      readonly reason: "turn" | "compaction";
      readonly messages: readonly Message[];
      readonly consumedInputIds: readonly string[];
    }> = [];
    const initialMessages: readonly Message[] = [
      { role: "user", content: "large history ".repeat(3_000).trim() },
      { role: "assistant", content: "old provider 1", toolCalls: [] },
    ];
    const oldProvider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        if (options.toolChoice === "none") {
          oldProviderSummaryRequests++;
          yield { type: "text", text: "Persisted costly checkpoint summary." };
          yield { type: "stop", reason: "stop", usage: EXPENSIVE_USAGE };
          return;
        }
        yield { type: "text", text: "unexpected old turn" };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const targetProvider: LLMProvider = {
      id: "fake",
      async *stream() {
        targetProviderTurns++;
        yield { type: "text", text: "unexpected target" };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled", maxCostUsd: 0.01 },
      workspace: process.cwd(),
      platform: process.platform,
      initialMessages,
      initialQueuedInputs: [
        {
          id: "model-input",
          timestamp: "2026-01-01T00:00:00.000Z",
          sequence: 1,
          line: "/model qwen/tiny",
        },
        {
          id: "target-input",
          timestamp: "2026-01-01T00:00:01.000Z",
          sequence: 2,
          line: "second prompt",
        },
      ],
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
      },
      onSigint: (handler) => {
        sigintHandlers.add(handler);
      },
      offSigint: (handler) => {
        sigintHandlers.delete(handler);
      },
      setExitCode: () => {},
      forceExit: (code) => {
        throw new ForcedExit(code);
      },
      resolveProvider: (_message, selection?: ProviderSelection) =>
        selection?.providerId === "qwen"
          ? resolvedProvider(
              "qwen",
              selection.model ?? "tiny",
              targetProvider,
              ONE_DOLLAR_PER_MILLION_INPUT,
              {
                contextWindowTokens: 2_000,
                reserveTokens: 0,
                keepRecentTokens: 1,
              },
            )
          : resolvedProvider(
              "fake",
              "fake",
              oldProvider,
              ONE_DOLLAR_PER_MILLION_INPUT,
            ),
      requireKnownCostModel: () => ONE_DOLLAR_PER_MILLION_INPUT,
      persistSessionMessages: (messages, reason, consumedInputIds) => {
        persisted.push({
          reason,
          messages: structuredClone([...messages]),
          consumedInputIds,
        });
      },
      consumeQueuedInputs: () => {
        throw new Error("compaction persistence already consumed model input");
      },
      printAgentEvents: async (stream) => {
        let finalEnd: Extract<AgentEvent, { readonly type: "end" }> | undefined;
        for await (const event of stream) {
          if (event.type === "text") {
            stdout += event.text;
          } else if (event.type === "end") {
            finalEnd = event;
          }
        }
        return finalEnd;
      },
      formatCostReport: (cost, maxUsd) =>
        `Cost: ${cost.spentUsd.toFixed(2)} / ${maxUsd.toFixed(2)} exceeded=${cost.budgetExceeded}\n`,
    });

    // When
    input.end();

    // Then
    await session;
    expect(stdout).toContain("Model switched to qwen/tiny");
    expect(stdout).not.toContain("unexpected target");
    expect(stderr).toContain("Context compacted: model switch");
    expect(stderr).toContain("Cost: 2.00 / 0.01 exceeded=true");
    expect(oldProviderSummaryRequests).toBe(1);
    expect(targetProviderTurns).toBe(0);
    expect(persisted[0]?.reason).toBe("compaction");
    expect(persisted[0]?.consumedInputIds).toEqual(["model-input"]);
    expect(JSON.stringify(persisted[0]?.messages)).toContain(
      "Persisted costly checkpoint summary.",
    );
    expect(persisted).toHaveLength(1);
    expect(sigintHandlers.size).toBe(0);
  });

  test(`Given report-only cost tracking is active before any reported turn,
    When model-switch compaction succeeds,
    Then Keel records compaction cost without printing a budget report`, async () => {
    // Given
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    let stdout = "";
    let stderr = "";
    let oldProviderSummaryRequests = 0;
    const initialMessages: readonly Message[] = [
      { role: "user", content: "large history ".repeat(3_000).trim() },
      { role: "assistant", content: "old provider 1", toolCalls: [] },
    ];
    const oldProvider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        if (options.toolChoice === "none") {
          oldProviderSummaryRequests++;
          yield { type: "text", text: "Report checkpoint summary." };
          yield { type: "stop", reason: "stop", usage: EXPENSIVE_USAGE };
          return;
        }
        yield { type: "text", text: "unexpected old turn" };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled", reportFile: "session.json" },
      workspace: process.cwd(),
      platform: process.platform,
      initialMessages,
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
      },
      onSigint: (handler) => {
        sigintHandlers.add(handler);
      },
      offSigint: (handler) => {
        sigintHandlers.delete(handler);
      },
      setExitCode: () => {},
      forceExit: (code) => {
        throw new ForcedExit(code);
      },
      resolveProvider: (_message, selection?: ProviderSelection) =>
        selection?.providerId === "qwen"
          ? resolvedProvider(
              "qwen",
              selection.model ?? "tiny",
              textProvider("unused target"),
              ONE_DOLLAR_PER_MILLION_INPUT,
              {
                contextWindowTokens: 2_000,
                reserveTokens: 0,
                keepRecentTokens: 1,
              },
            )
          : resolvedProvider(
              "fake",
              "fake",
              oldProvider,
              ONE_DOLLAR_PER_MILLION_INPUT,
            ),
      requireKnownCostModel: () => ONE_DOLLAR_PER_MILLION_INPUT,
      printAgentEvents: async () => undefined,
      formatCostReport: () => "unexpected cost report\n",
    });

    // When
    input.end("/model qwen/tiny\n");

    // Then
    const result = await session;
    expect(result).toEqual({});
    expect(stdout).toContain("Model switched to qwen/tiny");
    expect(stderr).toContain("Context compacted: model switch");
    expect(stderr).not.toContain("unexpected cost report");
    expect(oldProviderSummaryRequests).toBe(1);
    expect(sigintHandlers.size).toBe(0);
  });

  test(`Given a named session has queued model-switch input,
    When model-switch compaction succeeds,
    Then the compaction record consumes the model command before the target prompt runs`, async () => {
    // Given
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    let stdout = "";
    let stderr = "";
    const persisted: Array<{
      readonly reason: "turn" | "compaction";
      readonly messages: readonly Message[];
      readonly consumedInputIds: readonly string[];
    }> = [];
    const switches: Array<{
      readonly from: {
        readonly providerId: string;
        readonly model: string;
      } | null;
      readonly to: { readonly providerId: string; readonly model: string };
      readonly consumedInputIds: readonly string[];
    }> = [];
    const targetRequestContexts: Message[][] = [];
    const initialMessages: readonly Message[] = [
      { role: "user", content: "large history ".repeat(3_000).trim() },
      { role: "assistant", content: "old provider 1", toolCalls: [] },
    ];
    const oldProvider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        if (options.toolChoice === "none") {
          yield { type: "text", text: "Persisted checkpoint summary." };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        yield { type: "text", text: "unexpected old turn" };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const targetProvider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        targetRequestContexts.push(structuredClone([...options.messages]));
        yield { type: "text", text: "target reply" };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
      platform: process.platform,
      initialMessages,
      initialQueuedInputs: [
        {
          id: "model-input",
          timestamp: "2026-01-01T00:00:00.000Z",
          sequence: 1,
          line: "/model qwen/tiny",
        },
        {
          id: "target-input",
          timestamp: "2026-01-01T00:00:01.000Z",
          sequence: 2,
          line: "second prompt",
        },
      ],
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
      },
      onSigint: (handler) => {
        sigintHandlers.add(handler);
      },
      offSigint: (handler) => {
        sigintHandlers.delete(handler);
      },
      setExitCode: () => {},
      forceExit: (code) => {
        throw new ForcedExit(code);
      },
      resolveProvider: (_message, selection?: ProviderSelection) =>
        selection?.providerId === "qwen"
          ? resolvedProvider(
              "qwen",
              selection.model ?? "tiny",
              targetProvider,
              ZERO_COST_MODEL,
              {
                contextWindowTokens: 2_000,
                reserveTokens: 0,
                keepRecentTokens: 1,
              },
            )
          : resolvedProvider("fake", "fake", oldProvider),
      requireKnownCostModel: () => ZERO_COST_MODEL,
      persistSessionMessages: (messages, reason, consumedInputIds) => {
        persisted.push({
          reason,
          messages: structuredClone([...messages]),
          consumedInputIds,
        });
      },
      persistModelSwitch: (switchRecord) => {
        switches.push(switchRecord);
      },
      consumeQueuedInputs: () => {
        throw new Error("persisted model switch should not consume separately");
      },
      printAgentEvents: async (stream) => {
        let finalEnd: Extract<AgentEvent, { readonly type: "end" }> | undefined;
        for await (const event of stream) {
          if (event.type === "text") {
            stdout += event.text;
          } else if (event.type === "end") {
            finalEnd = event;
          }
        }
        return finalEnd;
      },
      formatCostReport: () => "",
    });

    // When
    input.end();

    // Then
    await session;
    expect(stdout).toContain("Model switched to qwen/tiny");
    expect(stdout).toContain("target reply");
    expect(stderr).toContain("Context compacted: model switch");
    expect(persisted[0]?.reason).toBe("compaction");
    expect(persisted[0]?.consumedInputIds).toEqual(["model-input"]);
    expect(JSON.stringify(persisted[0]?.messages)).toContain(
      "Persisted checkpoint summary.",
    );
    expect(switches).toEqual([
      {
        from: { providerId: "fake", model: "fake" },
        to: { providerId: "qwen", model: "tiny" },
        consumedInputIds: [],
      },
    ]);
    expect(persisted[1]?.reason).toBe("turn");
    expect(persisted[1]?.consumedInputIds).toEqual(["target-input"]);
    expect(targetRequestContexts).toHaveLength(1);
    expect(targetRequestContexts[0]?.[0]?.content).toContain(
      "Persisted checkpoint summary.",
    );
    expect(sigintHandlers.size).toBe(0);
  });

  test(`Given model-switch compaction follows a file read,
    When user asks the target model to edit after the switch,
    Then the edit uses a fresh post-compaction read snapshot`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-interactive-model-switch-compact-"),
    );
    await writeFile(join(workspace, "note.txt"), "hello old world\n", "utf8");
    let receiveFirstEnd: () => void = () => {};
    const firstTurnEnded = new Promise<void>((resolve) => {
      receiveFirstEnd = resolve;
    });
    let oldRequestTurn = 0;
    let oldProviderSummaryRequests = 0;
    let targetRequestTurn = 0;
    let editRequestMessages: readonly Message[] = [];
    const oldProvider: LLMProvider = {
      id: "model-switch-read-restore-old",
      async *stream(options) {
        if (options.toolChoice === "none") {
          oldProviderSummaryRequests++;
          yield { type: "text", text: "Read checkpoint summary." };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }

        if (oldRequestTurn === 0) {
          oldRequestTurn++;
          yield {
            type: "tool_call",
            id: "read_note",
            tool: "read",
            path: "note.txt",
          };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }

        oldRequestTurn++;
        yield { type: "text", text: "Read note.txt." };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const targetProvider: LLMProvider = {
      id: "model-switch-read-restore-target",
      async *stream(options) {
        if (options.toolChoice === "none") {
          yield { type: "text", text: "unexpected target summary" };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }

        if (targetRequestTurn === 0) {
          targetRequestTurn++;
          editRequestMessages = structuredClone([...options.messages]);
          yield {
            type: "tool_call",
            id: "edit_note",
            tool: "edit",
            path: "note.txt",
            edits: [{ oldText: "current", newText: "fresh" }],
          };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }

        targetRequestTurn++;
        yield { type: "text", text: "Updated note.txt." };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    let stdout = "";
    let stderr = "";
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace,
      platform: process.platform,
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
      },
      onSigint: (handler) => {
        sigintHandlers.add(handler);
      },
      offSigint: (handler) => {
        sigintHandlers.delete(handler);
      },
      setExitCode: () => {},
      forceExit: (code) => {
        throw new ForcedExit(code);
      },
      resolveProvider: (_message, selection?: ProviderSelection) => {
        if (selection?.providerId === "qwen") {
          return resolvedProvider(
            "qwen",
            selection.model ?? "tiny",
            targetProvider,
            ZERO_COST_MODEL,
            {
              contextWindowTokens: 2_000,
              reserveTokens: 0,
              keepRecentTokens: 1,
            },
          );
        }
        return resolvedProvider("fake", "fake", oldProvider, ZERO_COST_MODEL, {
          keepRecentTokens: 1,
        });
      },
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async (stream) => {
        let finalEnd: Extract<AgentEvent, { readonly type: "end" }> | undefined;
        for await (const event of stream) {
          if (event.type === "text") {
            stdout += event.text;
          } else if (event.type === "end") {
            finalEnd = event;
            if (oldRequestTurn === 2) {
              receiveFirstEnd();
            }
          }
        }
        return finalEnd;
      },
      formatCostReport: () => "",
    });

    try {
      // When
      input.write(
        `read note.txt and remember ${"large history ".repeat(2_000).trim()}\n`,
      );
      await withTimeout(firstTurnEnded, 5000, "first turn did not finish");
      await writeFile(
        join(workspace, "note.txt"),
        "hello current world\n",
        "utf8",
      );
      input.write("/model qwen/tiny\n");
      input.write("replace the word\n");
      input.end();

      // Then
      await session;
      expect(await readFile(join(workspace, "note.txt"), "utf8")).toBe(
        "hello fresh world\n",
      );
      const restoredReadMessage = editRequestMessages.find(
        (message): message is Extract<Message, { readonly role: "tool" }> =>
          message.role === "tool" &&
          message.content.includes("hello current world"),
      );
      expect(restoredReadMessage?.toolCallId).toContain("post_compaction_read");
      expect(JSON.stringify(editRequestMessages)).not.toContain(
        "hello old world",
      );
      expect(stdout).toContain("Read note.txt.");
      expect(stdout).toContain("Model switched to qwen/tiny");
      expect(stdout).toContain("Updated note.txt.");
      expect(stderr).toContain("Context compacted: model switch");
      expect(oldProviderSummaryRequests).toBe(1);
      expect(sigintHandlers.size).toBe(0);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
