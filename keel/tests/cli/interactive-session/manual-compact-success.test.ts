import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, test } from "vitest";
import type { AgentEvent } from "../../../src/agent/events.ts";
import { runInteractiveSession } from "../../../src/cli/interactive-session.ts";
import type { CostModel } from "../../../src/core/cost.ts";
import type { LLMProvider, Message } from "../../../src/llm/types.ts";
import {
  ForcedExit,
  withTimeout,
  ZERO_COST_MODEL,
  ZERO_USAGE,
} from "../../../src/testing/interactive-session-fixtures.ts";

describe("Interactive Session - Manual Compact Success", () => {
  test(`Given an interactive session has prior history,
    When user enters /compact,
    Then the session continues from a manual checkpoint`, async () => {
    // Given
    let receiveFirstEnd: () => void = () => {};
    const firstTurnEnded = new Promise<void>((resolve) => {
      receiveFirstEnd = resolve;
    });
    const observedRequestContexts: Message[][] = [];
    let summaryPrompt = "";
    let requestTurn = 0;
    const provider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        if (options.toolChoice === "none") {
          summaryPrompt = options.messages[0]?.content ?? "";
          yield { type: "text", text: "Manual checkpoint summary." };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }

        requestTurn++;
        observedRequestContexts.push(structuredClone([...options.messages]));
        yield {
          type: "text",
          text: requestTurn === 1 ? "First done" : "Second done",
        };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    let stdout = "";
    let stderr = "";
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
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
      resolveProvider: () => ({
        provider,
        providerId: "fake",
        model: "fake",
        costModel: ZERO_COST_MODEL,
        contextCompaction: { keepRecentTokens: 1 },
      }),
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async (stream) => {
        let finalEnd: Extract<AgentEvent, { readonly type: "end" }> | undefined;
        for await (const event of stream) {
          if (event.type === "text") {
            stdout += event.text;
          } else if (event.type === "end") {
            finalEnd = event;
            if (requestTurn === 1) {
              receiveFirstEnd();
            }
          }
        }
        return finalEnd;
      },
      formatCostReport: () => "",
    });

    // When
    input.write("first prompt\n");
    await withTimeout(firstTurnEnded, 5000, "first turn did not finish");
    input.write("/compact\n");
    input.write("second prompt\n");
    input.end();

    // Then
    await session;
    expect(stdout).toBe("First done\nSecond done\n");
    expect(stderr).toContain("Context compacted: manual");
    expect(summaryPrompt).toContain("first prompt");
    expect(summaryPrompt).toContain("First done");
    expect(observedRequestContexts[1]).toEqual([
      {
        role: "user",
        content: expect.stringContaining("<conversation-checkpoint>"),
      },
      { role: "user", content: "second prompt" },
    ]);
    expect(observedRequestContexts[1]?.[0]?.content).toContain(
      "Manual checkpoint summary.",
    );
    expect(JSON.stringify(observedRequestContexts[1])).not.toContain(
      "/compact",
    );
    expect(sigintHandlers.size).toBe(0);
  });

  test(`Given a resumed interactive session has restored history before provider resolution,
    When user enters /compact,
    Then manual compaction uses the restored transcript`, async () => {
    // Given
    const initialMessages: readonly Message[] = [
      { role: "user", content: "remember alpha" },
      { role: "assistant", content: "Alpha is saved.", toolCalls: [] },
    ];
    let summaryPrompt = "";
    const provider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        if (options.toolChoice !== "none") {
          throw new Error("manual compaction should not start an agent turn");
        }
        summaryPrompt = options.messages[0]?.content ?? "";
        yield { type: "text", text: "Restored checkpoint summary." };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    const resolvedMessages: string[] = [];
    const persisted: Array<{
      readonly reason: string;
      readonly messages: readonly Message[];
      readonly consumedInputIds: readonly string[];
    }> = [];
    let stderr = "";
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
      platform: process.platform,
      initialMessages,
      input,
      writeStdout: () => {},
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
      resolveProvider: (userMessage) => {
        resolvedMessages.push(userMessage);
        return {
          provider,
          providerId: "fake",
          model: "fake",
          costModel: ZERO_COST_MODEL,
          contextCompaction: { keepRecentTokens: 1 },
        };
      },
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async () => {
        throw new Error("manual compaction should not print agent events");
      },
      formatCostReport: () => "",
      persistSessionMessages: (messages, reason, consumedInputIds) => {
        persisted.push({
          reason,
          messages: structuredClone([...messages]),
          consumedInputIds: [...consumedInputIds],
        });
      },
    });

    // When
    input.end("/compact keep restored facts\n");

    // Then
    await session;
    expect(stderr).toContain("Context compacted: manual");
    expect(stderr).not.toContain("no conversation history");
    expect(summaryPrompt).toContain("remember alpha");
    expect(summaryPrompt).toContain("Alpha is saved.");
    expect(summaryPrompt).toContain("keep restored facts");
    expect(resolvedMessages).toEqual(["/compact keep restored facts"]);
    expect(JSON.stringify(persisted[0]?.messages)).toContain(
      "Restored checkpoint summary.",
    );
    expect(persisted[0]?.reason).toBe("compaction");
    expect(persisted[0]?.consumedInputIds).toEqual([]);
    expect(sigintHandlers.size).toBe(0);
  });

  test(`Given an interactive session has read a file before manual compaction,
    When user asks for an edit after /compact,
    Then the edit uses a fresh post-compaction read snapshot`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-interactive-compact-"),
    );
    await writeFile(join(workspace, "note.txt"), "hello old world\n", "utf8");
    let receiveFirstEnd: () => void = () => {};
    const firstTurnEnded = new Promise<void>((resolve) => {
      receiveFirstEnd = resolve;
    });
    let editRequestMessages: readonly Message[] = [];
    let requestTurn = 0;
    const provider: LLMProvider = {
      id: "manual-compact-read-restore",
      async *stream(options) {
        if (options.toolChoice === "none") {
          yield { type: "text", text: "Manual checkpoint summary." };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }

        if (requestTurn === 0) {
          requestTurn++;
          yield {
            type: "tool_call",
            id: "read_note",
            tool: "read",
            path: "note.txt",
          };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }

        if (requestTurn === 1) {
          requestTurn++;
          yield { type: "text", text: "Read note.txt." };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }

        if (requestTurn === 2) {
          requestTurn++;
          editRequestMessages = options.messages;
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

        requestTurn++;
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
      resolveProvider: () => ({
        provider,
        providerId: "fake",
        model: "fake",
        costModel: ZERO_COST_MODEL,
        contextCompaction: { keepRecentTokens: 1 },
      }),
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async (stream) => {
        let finalEnd: Extract<AgentEvent, { readonly type: "end" }> | undefined;
        for await (const event of stream) {
          if (event.type === "text") {
            stdout += event.text;
          } else if (event.type === "end") {
            finalEnd = event;
            if (requestTurn === 2) {
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
      input.write("read note.txt\n");
      await withTimeout(firstTurnEnded, 5000, "first turn did not finish");
      await writeFile(
        join(workspace, "note.txt"),
        "hello current world\n",
        "utf8",
      );
      input.write("/compact\n");
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
      expect(stdout).toBe("Read note.txt.\nUpdated note.txt.\n");
      expect(stderr).toContain("Context compacted: manual");
      expect(sigintHandlers.size).toBe(0);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given manual compaction has cost tracking enabled,
    When user enters /compact,
    Then the session prints the compaction cost report`, async () => {
    // Given
    let receiveFirstEnd: () => void = () => {};
    const firstTurnEnded = new Promise<void>((resolve) => {
      receiveFirstEnd = resolve;
    });
    let requestTurn = 0;
    const provider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        if (options.toolChoice === "none") {
          yield { type: "text", text: "Costed checkpoint summary." };
          yield {
            type: "stop",
            reason: "stop",
            usage: {
              inputTokens: 30,
              cachedInputTokens: 0,
              uncachedInputTokens: 30,
              outputTokens: 10,
            },
          };
          return;
        }

        requestTurn++;
        yield { type: "text", text: "First done" };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const input = new PassThrough();
    let stdout = "";
    let stderr = "";
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled", maxCostUsd: 0.01 },
      workspace: process.cwd(),
      platform: process.platform,
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
        model: "fake",
        costModel: {
          type: "fixed",
          uncachedInputPerMillionTokens: 100,
          cachedInputPerMillionTokens: 0,
          outputPerMillionTokens: 200,
        },
      }),
      requireKnownCostModel: () => ({
        type: "fixed",
        uncachedInputPerMillionTokens: 100,
        cachedInputPerMillionTokens: 0,
        outputPerMillionTokens: 200,
      }),
      printAgentEvents: async (stream) => {
        let finalEnd: Extract<AgentEvent, { readonly type: "end" }> | undefined;
        for await (const event of stream) {
          if (event.type === "text") {
            stdout += event.text;
          } else if (event.type === "end") {
            finalEnd = event;
            if (requestTurn === 1) {
              receiveFirstEnd();
            }
          }
        }
        return finalEnd;
      },
      formatCostReport: (cost, maxUsd) =>
        `Cost: ${cost.spentUsd.toFixed(6)} / ${maxUsd.toFixed(2)} exceeded=${cost.budgetExceeded}\n`,
    });

    // When
    input.write("first prompt\n");
    await withTimeout(firstTurnEnded, 5000, "first turn did not finish");
    input.write("/compact\n");
    input.end();

    // Then
    await session;
    expect(stdout).toBe("First done\n");
    expect(stderr).toContain("Context compacted: manual");
    expect(stderr).toContain("Cost: 0.005000 / 0.01 exceeded=false\n");
  });

  test(`Given manual compaction runs during a report-only interactive session,
    When user enters /compact,
    Then compaction cost is included without printing a budget report`, async () => {
    // Given
    let receiveFirstEnd: () => void = () => {};
    const firstTurnEnded = new Promise<void>((resolve) => {
      receiveFirstEnd = resolve;
    });
    let requestTurn = 0;
    const provider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        if (options.toolChoice === "none") {
          yield { type: "text", text: "Report checkpoint summary." };
          yield {
            type: "stop",
            reason: "stop",
            usage: {
              inputTokens: 30,
              cachedInputTokens: 0,
              uncachedInputTokens: 30,
              outputTokens: 10,
            },
          };
          return;
        }

        requestTurn++;
        yield { type: "text", text: "First done" };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const input = new PassThrough();
    let stdout = "";
    let stderr = "";
    const costModel: CostModel = {
      type: "fixed",
      uncachedInputPerMillionTokens: 100,
      cachedInputPerMillionTokens: 0,
      outputPerMillionTokens: 200,
    };
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled", reportFile: "session.json" },
      workspace: process.cwd(),
      platform: process.platform,
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
        model: "fake",
        costModel,
        contextCompaction: { keepRecentTokens: 1 },
      }),
      requireKnownCostModel: () => costModel,
      printAgentEvents: async (stream) => {
        let finalEnd: Extract<AgentEvent, { readonly type: "end" }> | undefined;
        for await (const event of stream) {
          if (event.type === "text") {
            stdout += event.text;
          } else if (event.type === "end") {
            finalEnd = event;
            if (requestTurn === 1) {
              receiveFirstEnd();
            }
          }
        }
        return finalEnd;
      },
      formatCostReport: (cost, maxUsd) =>
        `Cost: ${cost.spentUsd.toFixed(6)} / ${maxUsd.toFixed(2)} exceeded=${cost.budgetExceeded}\n`,
    });

    // When
    input.write("first prompt\n");
    await withTimeout(firstTurnEnded, 5000, "first turn did not finish");
    input.write("/compact\n");
    input.end();

    // Then
    const result = await session;
    expect(stdout).toBe("First done\n");
    expect(stderr).toContain("Context compacted: manual");
    expect(stderr).not.toContain("Cost:");
    expect(result.report?.end.stopReason).toBe("completed");
    expect(result.report?.end.usage).toEqual({
      inputTokens: 30,
      cachedInputTokens: 0,
      uncachedInputTokens: 30,
      outputTokens: 10,
    });
    expect(result.report?.end.cost.spentUsd).toBeCloseTo(0.005);
  });

  test(`Given manual compaction exhausts an interactive session cost limit,
    When more prompt input is already queued,
    Then the session report records a cost budget stop`, async () => {
    // Given
    let receiveFirstEnd: () => void = () => {};
    const firstTurnEnded = new Promise<void>((resolve) => {
      receiveFirstEnd = resolve;
    });
    let requestTurn = 0;
    const provider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        if (options.toolChoice === "none") {
          yield { type: "text", text: "Costed checkpoint summary." };
          yield {
            type: "stop",
            reason: "stop",
            usage: {
              inputTokens: 30,
              cachedInputTokens: 0,
              uncachedInputTokens: 30,
              outputTokens: 10,
            },
          };
          return;
        }

        requestTurn++;
        yield { type: "text", text: "First done" };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const input = new PassThrough();
    let stdout = "";
    let stderr = "";
    const costModel: CostModel = {
      type: "fixed",
      uncachedInputPerMillionTokens: 100,
      cachedInputPerMillionTokens: 0,
      outputPerMillionTokens: 200,
    };
    const session = runInteractiveSession({
      cliArgs: {
        bashMode: "disabled",
        maxCostUsd: 0.001,
        reportFile: "session.json",
      },
      workspace: process.cwd(),
      platform: process.platform,
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
        model: "fake",
        costModel,
        contextCompaction: { keepRecentTokens: 1 },
      }),
      requireKnownCostModel: () => costModel,
      printAgentEvents: async (stream) => {
        let finalEnd: Extract<AgentEvent, { readonly type: "end" }> | undefined;
        for await (const event of stream) {
          if (event.type === "text") {
            stdout += event.text;
          } else if (event.type === "end") {
            finalEnd = event;
            if (requestTurn === 1) {
              receiveFirstEnd();
            }
          }
        }
        return finalEnd;
      },
      formatCostReport: (cost, maxUsd) =>
        `Cost: ${cost.spentUsd.toFixed(6)} / ${maxUsd.toFixed(3)} exceeded=${cost.budgetExceeded}\n`,
    });

    // When
    input.write("first prompt\n");
    await withTimeout(firstTurnEnded, 5000, "first turn did not finish");
    input.write("/compact\n");
    input.write("second prompt\n");
    input.end();

    // Then
    const result = await session;
    expect(requestTurn).toBe(1);
    expect(stdout).toBe("First done\n");
    expect(stderr).toContain("Context compacted: manual");
    expect(stderr).toContain("Cost: 0.005000 / 0.001 exceeded=true\n");
    expect(result.report?.end.stopReason).toBe("cost_budget");
    expect(result.report?.end.cost.spentUsd).toBeCloseTo(0.005);
  });

  test(`Given manual compaction cost model resolution fails,
    When user enters /compact,
    Then the configuration error is not reported as compaction failure`, async () => {
    // Given
    let receiveFirstEnd: () => void = () => {};
    const firstTurnEnded = new Promise<void>((resolve) => {
      receiveFirstEnd = resolve;
    });
    let summaryRequests = 0;
    let costModelRequests = 0;
    const provider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        if (options.toolChoice === "none") {
          summaryRequests++;
          yield { type: "text", text: "Unexpected checkpoint summary." };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }

        yield { type: "text", text: "First done" };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const input = new PassThrough();
    let stdout = "";
    let stderr = "";
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled", maxCostUsd: 1 },
      workspace: process.cwd(),
      platform: process.platform,
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
        model: "fake",
        costModel: ZERO_COST_MODEL,
        contextCompaction: { keepRecentTokens: 1 },
      }),
      requireKnownCostModel: () => {
        costModelRequests++;
        if (costModelRequests === 1) {
          return ZERO_COST_MODEL;
        }
        throw new Error("known cost model missing");
      },
      printAgentEvents: async (stream) => {
        let finalEnd: Extract<AgentEvent, { readonly type: "end" }> | undefined;
        for await (const event of stream) {
          if (event.type === "text") {
            stdout += event.text;
          } else if (event.type === "end") {
            finalEnd = event;
            receiveFirstEnd();
          }
        }
        return finalEnd;
      },
      formatCostReport: () => "",
    });

    // When
    input.write("first prompt\n");
    await withTimeout(firstTurnEnded, 5000, "first turn did not finish");
    input.write("/compact\n");
    input.end();

    // Then
    await expect(session).rejects.toThrow("known cost model missing");
    expect(stdout).toBe("First done\n");
    expect(stderr).not.toContain("Context compaction failed");
    expect(summaryRequests).toBe(0);
  });
});
