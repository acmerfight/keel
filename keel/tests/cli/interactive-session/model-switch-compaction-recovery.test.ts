import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, test } from "vitest";
import type { AgentEvent } from "../../../src/agent/events.ts";
import { createReadVisibilityState } from "../../../src/agent/read-visibility.ts";
import type {
  ToolOutputArtifactSaveInput,
  ToolOutputArtifactStore,
} from "../../../src/agent/tool-output-artifacts.ts";
import { executeModelSwitchCompaction } from "../../../src/cli/interactive-session/model-switch-compact.ts";
import type { ProviderSelection } from "../../../src/cli/interactive-session/types.ts";
import { runInteractiveSession } from "../../../src/cli/interactive-session.ts";
import type { LLMProvider, Message } from "../../../src/llm/types.ts";
import {
  ForcedExit,
  resolvedProvider,
  textProvider,
  ZERO_COST_MODEL,
  ZERO_USAGE,
} from "../../../src/testing/interactive-session-fixtures.ts";
import { createProjectInstructionVisibilityState } from "../../../src/tools/scoped-project-instructions.ts";

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
    When the compaction helper accepts the switch,
    Then stderr includes the artifact inspection command`, async () => {
    // Given
    const largeToolOutput = [
      "MODEL_SWITCH_LOG_START",
      "model switch log line ".repeat(500),
      "MODEL_SWITCH_LOG_END",
    ].join("\n");
    const messages: Message[] = [
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
    const existingRefs = new Set<string>();
    const store: ToolOutputArtifactStore = {
      exists: async (ref) => existingRefs.has(ref),
      save: async (input) => {
        const ref = `tool-output:test/${saved.length + 1}`;
        saved.push(input);
        existingRefs.add(ref);
        return { status: "stored", ref };
      },
    };
    const readVisibility = createReadVisibilityState();
    const projectInstructionVisibility =
      createProjectInstructionVisibilityState(process.cwd());
    let stdout = "";
    let stderr = "";
    const currentProvider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        expect(options.toolChoice).toBe("none");
        yield { type: "text", text: "Model switch artifact summary." };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };

    // When
    const result = await executeModelSwitchCompaction({
      current: resolvedProvider("fake", "fake", currentProvider),
      target: resolvedProvider(
        "qwen",
        "tiny",
        textProvider("unexpected target"),
        ZERO_COST_MODEL,
        {
          contextWindowTokens: 20_000,
          reserveTokens: 0,
          keepRecentTokens: 20_000,
          toolOutputMaxChars: 128,
        },
      ),
      workspace: process.cwd(),
      messages,
      systemPrompt: "system",
      signal: new AbortController().signal,
      readVisibility,
      projectInstructionVisibility,
      nextPostCompactionReadToolCallId: () => "post_compaction_read",
      options: {
        cliArgs: { bashMode: "disabled" },
        workspace: process.cwd(),
        platform: process.platform,
        toolOutputArtifacts: { store },
        input: new PassThrough(),
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
          throw new Error("provider resolution is not used");
        },
        requireKnownCostModel: () => ZERO_COST_MODEL,
        printAgentEvents: async () => undefined,
        formatCostReport: () => "",
      },
      recordCompactionCost: () => {
        throw new Error("cost is not tracked");
      },
    });

    // Then
    expect(result).toEqual({ status: "accepted" });
    expect(stdout).toBe("");
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
  });

  test(`Given model-switch compaction is aborted while restoring reads,
    When the compaction helper returns,
    Then messages and read visibility roll back before the model can switch`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-model-switch-abort-restore-"),
    );
    const notePath = join(workspace, "note.txt");
    await writeFile(notePath, "fresh file content\n", "utf8");
    const messages: Message[] = [
      { role: "user", content: "large history ".repeat(3_000).trim() },
      { role: "assistant", content: "old reply", toolCalls: [] },
    ];
    const messagesBeforeCompact = structuredClone(messages);
    const readVisibility = createReadVisibilityState();
    readVisibility.applyVisibleToolExecutions([
      { content: "", ok: true, readTargetPath: notePath },
    ]);
    const projectInstructionVisibility =
      createProjectInstructionVisibilityState(workspace);
    const abortController = new AbortController();
    let stdout = "";
    let stderr = "";
    let summaryRequests = 0;
    const currentProvider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        expect(options.toolChoice).toBe("none");
        summaryRequests++;
        yield { type: "text", text: "Interrupted checkpoint summary." };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };

    try {
      // When
      const result = await executeModelSwitchCompaction({
        current: resolvedProvider("fake", "fake", currentProvider),
        target: resolvedProvider(
          "qwen",
          "tiny",
          textProvider("unexpected target"),
          ZERO_COST_MODEL,
          {
            contextWindowTokens: 2_000,
            reserveTokens: 0,
            keepRecentTokens: 1,
          },
        ),
        workspace,
        messages,
        systemPrompt: "system",
        signal: abortController.signal,
        readVisibility,
        projectInstructionVisibility,
        nextPostCompactionReadToolCallId: () => {
          abortController.abort();
          return "post_compaction_read_after_abort";
        },
        options: {
          cliArgs: { bashMode: "disabled" },
          workspace,
          platform: process.platform,
          input: new PassThrough(),
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
            throw new Error("provider resolution is not used");
          },
          requireKnownCostModel: () => ZERO_COST_MODEL,
          printAgentEvents: async () => undefined,
          formatCostReport: () => "",
        },
        recordCompactionCost: () => {
          throw new Error("cost is not tracked");
        },
      });

      // Then
      expect(result).toEqual({ status: "rejected" });
      expect(stdout).toBe("\n");
      expect(stderr).toBe("");
      expect(summaryRequests).toBe(1);
      expect(messages).toEqual(messagesBeforeCompact);
      expect(readVisibility.visibleReadsMostRecentFirst()).toEqual([
        { targetPath: notePath },
      ]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given model-switch compaction is aborted after the summary returns,
    When the target has no explicit context-compaction profile,
    Then the helper rejects and restores the original transcript`, async () => {
    // Given
    const messages: Message[] = [
      { role: "user", content: "large history ".repeat(3_000).trim() },
      { role: "assistant", content: "old reply", toolCalls: [] },
    ];
    const messagesBeforeCompact = structuredClone(messages);
    const readVisibility = createReadVisibilityState();
    const projectInstructionVisibility =
      createProjectInstructionVisibilityState(process.cwd());
    const abortController = new AbortController();
    let stdout = "";
    let stderr = "";
    let summaryRequests = 0;
    const currentProvider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        expect(options.toolChoice).toBe("none");
        summaryRequests++;
        yield { type: "text", text: "Aborted checkpoint summary." };
        abortController.abort();
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };

    // When
    const result = await executeModelSwitchCompaction({
      current: resolvedProvider("fake", "fake", currentProvider),
      target: resolvedProvider(
        "qwen",
        "default-window",
        textProvider("unexpected target"),
      ),
      workspace: process.cwd(),
      messages,
      systemPrompt: "system",
      signal: abortController.signal,
      readVisibility,
      projectInstructionVisibility,
      nextPostCompactionReadToolCallId: () => "unexpected_restore_read",
      options: {
        cliArgs: { bashMode: "disabled" },
        workspace: process.cwd(),
        platform: process.platform,
        input: new PassThrough(),
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
          throw new Error("provider resolution is not used");
        },
        requireKnownCostModel: () => ZERO_COST_MODEL,
        printAgentEvents: async () => undefined,
        formatCostReport: () => "",
      },
      recordCompactionCost: () => {
        throw new Error("cost is not tracked");
      },
    });

    // Then
    expect(result).toEqual({ status: "rejected" });
    expect(stdout).toBe("\n");
    expect(stderr).toBe("");
    expect(summaryRequests).toBe(1);
    expect(messages).toEqual(messagesBeforeCompact);
  });

  test(`Given model-switch compaction summary throws after abort,
    When the compaction helper catches the error,
    Then it treats the failure as an abort and restores the original transcript`, async () => {
    // Given
    const messages: Message[] = [
      { role: "user", content: "large history ".repeat(3_000).trim() },
      { role: "assistant", content: "old reply", toolCalls: [] },
    ];
    const messagesBeforeCompact = structuredClone(messages);
    const readVisibility = createReadVisibilityState();
    const projectInstructionVisibility =
      createProjectInstructionVisibilityState(process.cwd());
    const abortController = new AbortController();
    let stdout = "";
    let stderr = "";
    let summaryRequests = 0;
    const currentProvider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        expect(options.toolChoice).toBe("none");
        summaryRequests++;
        yield {
          type: "provider_retry",
          provider: "fake",
          reason: "test retry",
          attempt: 1,
          maxRetries: 1,
          delayMs: 1,
        };
        abortController.abort();
        throw new Error("summary aborted");
      },
    };

    // When
    const result = await executeModelSwitchCompaction({
      current: resolvedProvider("fake", "fake", currentProvider),
      target: resolvedProvider(
        "qwen",
        "default-window",
        textProvider("unexpected target"),
      ),
      workspace: process.cwd(),
      messages,
      systemPrompt: "system",
      signal: abortController.signal,
      readVisibility,
      projectInstructionVisibility,
      nextPostCompactionReadToolCallId: () => "unexpected_restore_read",
      options: {
        cliArgs: { bashMode: "disabled" },
        workspace: process.cwd(),
        platform: process.platform,
        input: new PassThrough(),
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
          throw new Error("provider resolution is not used");
        },
        requireKnownCostModel: () => ZERO_COST_MODEL,
        printAgentEvents: async () => undefined,
        formatCostReport: () => "",
      },
      recordCompactionCost: () => {
        throw new Error("cost is not tracked");
      },
    });

    // Then
    expect(result).toEqual({ status: "rejected" });
    expect(stdout).toBe("\n");
    expect(stderr).toBe("");
    expect(summaryRequests).toBe(1);
    expect(messages).toEqual(messagesBeforeCompact);
  });

  test(`Given model-switch compaction still exceeds after restoring scoped reads,
    When the switch is rejected,
    Then read and project-instruction visibility roll back with the transcript`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-model-switch-visibility-rollback-"),
    );
    const packageRoot = join(workspace, "packages", "api");
    await mkdir(join(packageRoot, "src"), { recursive: true });
    const agentsPath = join(packageRoot, "AGENTS.md");
    const sourcePath = join(packageRoot, "src", "file.ts");
    await writeFile(
      agentsPath,
      "API rule: visibility rollback must preserve this instruction.\n",
      "utf8",
    );
    await writeFile(sourcePath, "export const value = 1;\n", "utf8");
    const realAgentsPath = await realpath(agentsPath);
    const realSourcePath = await realpath(sourcePath);
    const messages: Message[] = [
      { role: "user", content: "large history ".repeat(3_000).trim() },
      { role: "assistant", content: "old reply", toolCalls: [] },
    ];
    const messagesBeforeCompact = structuredClone(messages);
    const readVisibility = createReadVisibilityState();
    readVisibility.applyVisibleToolExecutions([
      {
        content: "",
        ok: true,
        readTargetPath: realSourcePath,
        readTargetOffset: 1,
        readTargetLimit: 1,
      },
    ]);
    const projectInstructionVisibility =
      createProjectInstructionVisibilityState(workspace);
    projectInstructionVisibility.markInstructionPathsVisible([realAgentsPath]);
    const abortController = new AbortController();
    let stdout = "";
    let stderr = "";
    let summaryRequests = 0;
    const currentProvider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        expect(options.toolChoice).toBe("none");
        summaryRequests++;
        yield { type: "text", text: "Still too large checkpoint summary." };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };

    try {
      // When
      const result = await executeModelSwitchCompaction({
        current: resolvedProvider("fake", "fake", currentProvider),
        target: resolvedProvider(
          "qwen",
          "tiny",
          textProvider("unexpected target"),
          ZERO_COST_MODEL,
          { contextWindowTokens: 1, reserveTokens: 0, keepRecentTokens: 1 },
        ),
        workspace,
        messages,
        systemPrompt: "system",
        signal: abortController.signal,
        readVisibility,
        projectInstructionVisibility,
        nextPostCompactionReadToolCallId: () => "post_compaction_read",
        options: {
          cliArgs: { bashMode: "disabled" },
          workspace,
          platform: process.platform,
          input: new PassThrough(),
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
            throw new Error("provider resolution is not used");
          },
          requireKnownCostModel: () => ZERO_COST_MODEL,
          printAgentEvents: async () => undefined,
          formatCostReport: () => "",
        },
        recordCompactionCost: () => {
          throw new Error("cost is not tracked");
        },
      });

      // Then
      expect(result).toEqual({ status: "rejected" });
      expect(stdout).toBe("");
      expect(stderr).toContain(
        "still exceeds the target context window after model-switch compaction",
      );
      expect(summaryRequests).toBe(1);
      expect(messages).toEqual(messagesBeforeCompact);
      expect(readVisibility.visibleReadsMostRecentFirst()).toEqual([
        { targetPath: realSourcePath, offset: 1, limit: 1 },
      ]);
      expect(
        projectInstructionVisibility
          .visibleInstructionsMostRecentFirst()
          .map((snapshot) => snapshot.instructionPath),
      ).toEqual([realAgentsPath]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
