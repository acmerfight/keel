import { PassThrough } from "node:stream";
import { describe, expect, test } from "vitest";
import type { AgentEvent } from "../../../src/agent/events.ts";
import type {
  ToolOutputArtifactSaveInput,
  ToolOutputArtifactStore,
} from "../../../src/agent/tool-output-artifacts.ts";
import type { ProviderSelection } from "../../../src/cli/interactive-session/types.ts";
import { runInteractiveSession } from "../../../src/cli/interactive-session.ts";
import type { LLMProvider, Message } from "../../../src/llm/types.ts";
import { verifiedToolOutputArtifactFixture } from "../../../src/testing/context-compaction-fixtures.ts";
import {
  ForcedExit,
  resolvedProvider,
  ZERO_COST_MODEL,
  ZERO_USAGE,
} from "../../../src/testing/interactive-session-fixtures.ts";

describe("Interactive Session - Model Switch Compaction Recovery", () => {
  test(`Given the current history does not fit a selected target context window,
    When user enters /model for that target,
    Then Keel compacts with the old provider before accepting the switch`, async () => {
    // Given
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    let stdout = "";
    let stderr = "";
    let oldProviderTurns = 0;
    let oldProviderSummaryRequests = 0;
    let targetProviderTurns = 0;
    let targetProviderSummaryRequests = 0;
    const targetRequestContexts: Message[][] = [];
    const largePrompt = "large history ".repeat(3_000).trim();
    const oldProvider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        if (options.toolChoice === "none") {
          oldProviderSummaryRequests++;
          yield { type: "text", text: "Downshift checkpoint summary." };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        oldProviderTurns++;
        yield { type: "text", text: `old provider ${oldProviderTurns}` };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const targetProvider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        if (options.toolChoice === "none") {
          targetProviderSummaryRequests++;
          yield { type: "text", text: "unexpected target summary" };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        targetProviderTurns++;
        targetRequestContexts.push(structuredClone([...options.messages]));
        yield { type: "text", text: `target provider ${targetProviderTurns}` };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
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
    input.end(`${largePrompt}\n/model qwen/tiny\nsecond prompt\n`);

    // Then
    await session;
    expect(stderr).toContain("Context compacted: model switch");
    expect(stdout).toContain("Model switched to qwen/tiny");
    expect(stdout).toContain("old provider 1");
    expect(stdout).toContain("target provider 1");
    expect(oldProviderTurns).toBe(1);
    expect(oldProviderSummaryRequests).toBe(1);
    expect(targetProviderTurns).toBe(1);
    expect(targetProviderSummaryRequests).toBe(0);
    expect(targetRequestContexts).toHaveLength(1);
    expect(targetRequestContexts[0]).toEqual([
      {
        role: "user",
        content: expect.stringContaining("<conversation-checkpoint>"),
      },
      { role: "user", content: "second prompt" },
    ]);
    expect(targetRequestContexts[0]?.[0]?.content).toContain(
      "Downshift checkpoint summary.",
    );
    expect(JSON.stringify(targetRequestContexts[0])).not.toContain("/model");
    expect(sigintHandlers.size).toBe(0);
  });

  test(`Given model-switch compaction fails,
    When user enters /model for a smaller target,
    Then the old provider remains active and the transcript is unchanged`, async () => {
    // Given
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    let stdout = "";
    let stderr = "";
    let oldProviderTurns = 0;
    let oldProviderSummaryRequests = 0;
    let targetProviderTurns = 0;
    const oldRequestContexts: Message[][] = [];
    const largePrompt = "large history ".repeat(3_000).trim();
    const oldProvider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        if (options.toolChoice === "none") {
          oldProviderSummaryRequests++;
          throw new Error("summary model unavailable");
        }
        oldProviderTurns++;
        oldRequestContexts.push(structuredClone([...options.messages]));
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
    input.end(`${largePrompt}\n/model qwen/tiny\nsecond prompt\n`);

    // Then
    await session;
    expect(stderr).toContain(
      "Context compaction failed: summary model unavailable",
    );
    expect(stdout).toContain("old provider 1");
    expect(stdout).toContain("old provider 2");
    expect(stdout).not.toContain("unexpected target");
    expect(oldProviderTurns).toBe(2);
    expect(oldProviderSummaryRequests).toBe(1);
    expect(targetProviderTurns).toBe(0);
    expect(oldRequestContexts).toHaveLength(2);
    expect(oldRequestContexts[1]).toEqual([
      { role: "user", content: largePrompt },
      { role: "assistant", content: "old provider 1", toolCalls: [] },
      { role: "user", content: "second prompt" },
    ]);
    expect(sigintHandlers.size).toBe(0);
  });

  test(`Given model-switch compaction still exceeds the target context window,
    When user enters /model for that target,
    Then the switch is rejected and the old provider remains active`, async () => {
    // Given
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    let stdout = "";
    let stderr = "";
    let oldProviderTurns = 0;
    let oldProviderSummaryRequests = 0;
    let targetProviderTurns = 0;
    const oldRequestContexts: Message[][] = [];
    const largePrompt = "large history ".repeat(3_000).trim();
    const oldProvider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        if (options.toolChoice === "none") {
          oldProviderSummaryRequests++;
          yield { type: "text", text: "Still too large summary." };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        oldProviderTurns++;
        oldRequestContexts.push(structuredClone([...options.messages]));
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
            { contextWindowTokens: 1, reserveTokens: 0, keepRecentTokens: 1 },
          );
        }
        return resolvedProvider("fake", "fake", oldProvider);
      },
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
    input.end(`${largePrompt}\n/model qwen/tiny\nsecond prompt\n`);

    // Then
    await session;
    expect(stderr).toContain(
      "still exceeds the target context window after model-switch compaction",
    );
    expect(stdout).toContain("old provider 1");
    expect(stdout).toContain("old provider 2");
    expect(stdout).not.toContain("unexpected target");
    expect(oldProviderTurns).toBe(2);
    expect(oldProviderSummaryRequests).toBe(1);
    expect(targetProviderTurns).toBe(0);
    expect(oldRequestContexts).toHaveLength(2);
    expect(oldRequestContexts[1]).toEqual([
      { role: "user", content: largePrompt },
      { role: "assistant", content: "old provider 1", toolCalls: [] },
      { role: "user", content: "second prompt" },
    ]);
    expect(sigintHandlers.size).toBe(0);
  });

  test(`Given model-switch compaction artifact-backs retained stale tool output,
    When user switches model and continues,
    Then the target model response is based on the newly retained artifact handle`, async () => {
    // Given
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    const largeToolOutput = [
      "MODEL_SWITCH_LOG_START",
      "model switch log line ".repeat(5_000),
      "MODEL_SWITCH_LOG_END",
    ].join("\n");
    const initialMessages: readonly Message[] = [
      { role: "user", content: "Remember the setup." },
      { role: "assistant", content: "Setup remembered.", toolCalls: [] },
      { role: "user", content: "Read the old report." },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "read_model_switch_report",
            tool: "read",
            path: "model-switch-report.log",
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "read_model_switch_report",
        content: largeToolOutput,
      },
      {
        role: "assistant",
        content: "The model switch report was inspected.",
        toolCalls: [],
      },
      { role: "user", content: "Continue later." },
    ];
    const saved: ToolOutputArtifactSaveInput[] = [];
    const store: ToolOutputArtifactStore = {
      verifyReusable: async () => ({ status: "not_reusable" }),
      save: async (input) => {
        const ref = `tool-output:test/${saved.length + 1}`;
        saved.push(input);
        return { status: "stored", ref, contentSha256: "0".repeat(64) };
      },
    };
    let stdout = "";
    let stderr = "";
    let currentSummaryRequests = 0;
    let targetTurns = 0;
    const currentProvider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        expect(options.toolChoice).toBe("none");
        currentSummaryRequests++;
        yield { type: "text", text: "Model switch artifact summary." };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const targetProvider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        if (options.toolChoice === "none") {
          yield { type: "text", text: "unexpected target summary" };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        targetTurns++;
        const context = JSON.stringify(options.messages);
        const evidenceSurvived =
          context.includes("<conversation-checkpoint>") &&
          context.includes("tool-output:test/1") &&
          context.includes("keel artifacts show tool-output:test/1");
        yield {
          type: "text",
          text: evidenceSurvived
            ? "Target artifact handle survived."
            : "Target artifact handle missing.",
        };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
      platform: process.platform,
      initialMessages,
      toolOutputArtifacts: { store },
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
              contextWindowTokens: 20_000,
              reserveTokens: 0,
              keepRecentTokens: 100_000,
              toolOutputMaxChars: 128,
            },
          );
        }
        return resolvedProvider("fake", "fake", currentProvider);
      },
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
    input.end("/model qwen/tiny\ncontinue on target\n");

    // Then
    await session;
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      toolCallId: "read_model_switch_report",
      toolName: "read",
      purpose: "stale-compaction",
      content: largeToolOutput,
    });
    expect(stderr).toContain("Context compacted: model switch");
    expect(stderr).toContain(
      "Tool output artifact: tool-output:test/1 (keel artifacts show tool-output:test/1)",
    );
    expect(stdout).toContain("Model switched to qwen/tiny");
    expect(stdout).toContain("Target artifact handle survived.");
    expect(currentSummaryRequests).toBe(1);
    expect(targetTurns).toBe(1);
    expect(sigintHandlers.size).toBe(0);
  });

  test(`Given model-switch compaction summarizes artifact-backed tool output,
    When user switches model and continues,
    Then the target model response is based on the retained evidence handle`, async () => {
    // Given
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    const artifactRef = "tool-output:model-switch/report";
    const previewContent = "model switch report line\n".repeat(300).trimEnd();
    const artifact = verifiedToolOutputArtifactFixture({
      ref: artifactRef,
      toolCallId: "read_model_switch_report",
      previewContent,
      omittedChars: 90_000,
      sourceStatus: "complete",
    });
    const initialMessages: readonly Message[] = [
      { role: "user", content: "Read the old report." },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "read_model_switch_report",
            tool: "read",
            path: "model-switch-report.log",
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "read_model_switch_report",
        content: `${previewContent}\n${artifact.marker}`,
      },
      {
        role: "assistant",
        content: "The model switch report was inspected.",
        toolCalls: [],
      },
      { role: "user", content: "Continue later." },
    ];
    let stdout = "";
    let stderr = "";
    let currentSummaryRequests = 0;
    let targetTurns = 0;
    const currentProvider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        expect(options.toolChoice).toBe("none");
        currentSummaryRequests++;
        yield {
          type: "text",
          text: "Model switch summary that omits the artifact ref.",
        };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const targetProvider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        if (options.toolChoice === "none") {
          yield { type: "text", text: "unexpected target summary" };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        targetTurns++;
        const context = JSON.stringify(options.messages);
        const evidenceSurvived =
          context.includes("<conversation-checkpoint>") &&
          context.includes("Evidence retained:") &&
          context.includes(artifactRef) &&
          context.includes(`inspect: keel artifacts show ${artifactRef}`);
        yield {
          type: "text",
          text: evidenceSurvived
            ? "Target evidence survived."
            : "Target evidence missing.",
        };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
      platform: process.platform,
      initialMessages,
      toolOutputArtifacts: { store: artifact.store },
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
              contextWindowTokens: 1_000,
              reserveTokens: 0,
              keepRecentTokens: 1,
              toolOutputMaxChars: 128,
            },
          );
        }
        return resolvedProvider("fake", "fake", currentProvider);
      },
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
    input.end("/model qwen/tiny\ncontinue on target\n");

    // Then
    await session;
    expect(stderr).toContain("Context compacted: model switch");
    expect(stdout).toContain("Model switched to qwen/tiny");
    expect(stdout).toContain("Target evidence survived.");
    expect(currentSummaryRequests).toBe(1);
    expect(targetTurns).toBe(1);
    expect(sigintHandlers.size).toBe(0);
  });
});
