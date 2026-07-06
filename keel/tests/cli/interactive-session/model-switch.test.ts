import { PassThrough } from "node:stream";
import { describe, expect, test } from "vitest";
import type { AgentEvent } from "../../../src/agent/events.ts";
import { parseInteractiveCommand } from "../../../src/cli/interactive-session/commands.ts";
import type { ProviderSelection } from "../../../src/cli/interactive-session/types.ts";
import { runInteractiveSession } from "../../../src/cli/interactive-session.ts";
import type { LLMProvider } from "../../../src/llm/types.ts";
import {
  ForcedExit,
  resolvedProvider,
  textProvider,
  ZERO_COST_MODEL,
  ZERO_USAGE,
} from "../../../src/testing/interactive-session-fixtures.ts";

describe("Interactive Session - Model Switch", () => {
  test(`Given user enters /model command variants,
    When the interactive parser handles valid and invalid model selections,
    Then it accepts supported provider/model targets and rejects malformed input`, () => {
    // Given / When / Then
    expect(parseInteractiveCommand("/model deepseek/deepseek-v4")).toEqual({
      kind: "model",
      selection: { providerId: "deepseek", model: "deepseek-v4" },
    });
    expect(parseInteractiveCommand("/model qwen/qwen3.7 plus")).toEqual({
      kind: "invalid",
      message: "Error: usage is /model <provider>/<model>.",
    });
    expect(parseInteractiveCommand("/model /qwen3.7-plus")).toEqual({
      kind: "invalid",
      message: "Error: usage is /model <provider>/<model>.",
    });
    expect(parseInteractiveCommand("/model qwen/")).toEqual({
      kind: "invalid",
      message: "Error: usage is /model <provider>/<model>.",
    });
    expect(parseInteractiveCommand("/model anthropic/claude")).toEqual({
      kind: "invalid",
      message: 'Error: unknown provider "anthropic".',
    });
  });

  test(`Given user enters malformed /model commands,
    When the interactive session handles those local commands,
    Then it reports usage errors without starting a provider turn`, async () => {
    // Given
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    let stdout = "";
    let stderr = "";
    let providerResolved = false;
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
      resolveProvider: () => {
        providerResolved = true;
        throw new Error("malformed /model should not resolve a provider");
      },
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async () => {
        throw new Error("malformed /model should not start a model turn");
      },
      formatCostReport: () => "",
    });

    // When
    input.end(
      "/model qwen/qwen3.7 plus\n/model /qwen3.7-plus\n/model qwen/\n/model anthropic/claude\n",
    );

    // Then
    await session;
    expect(stderr).toContain("Error: usage is /model <provider>/<model>.");
    expect(stderr).toContain('Error: unknown provider "anthropic".');
    expect(stdout).toBe("");
    expect(providerResolved).toBe(false);
    expect(sigintHandlers.size).toBe(0);
  });

  test(`Given no prompt has run,
    When user selects a model with /model before the first prompt,
    Then the first provider request uses the selected provider and model`, async () => {
    // Given
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    let stdout = "";
    const resolvedSelections: ProviderSelection[] = [];
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
      platform: process.platform,
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: () => {},
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
        if (selection !== undefined) {
          resolvedSelections.push(selection);
        }
        const providerId = selection?.providerId ?? "fake";
        const model = selection?.model ?? "fake";
        return resolvedProvider(
          providerId,
          model,
          textProvider(`${providerId}:${model}`),
        );
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
    input.end("/model qwen/qwen3.7-plus\nfirst prompt\n");

    // Then
    await session;
    expect(stdout).toContain("qwen:qwen3.7-plus");
    expect(resolvedSelections).toEqual([
      { providerId: "qwen", model: "qwen3.7-plus" },
    ]);
    expect(sigintHandlers.size).toBe(0);
  });

  test(`Given an interactive session already used one model,
    When user selects another model with /model,
    Then the next prompt uses the selected provider and the command stays local`, async () => {
    // Given
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    let stdout = "";
    const observedProviderVisibleContent: string[] = [];
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
      platform: process.platform,
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: () => {},
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
        const providerId = selection?.providerId ?? "fake";
        const model = selection?.model ?? "fake";
        const provider: LLMProvider = {
          id: "fake",
          async *stream(options) {
            observedProviderVisibleContent.push(
              JSON.stringify(options.messages),
            );
            yield { type: "text", text: `${providerId}:${model}` };
            yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          },
        };
        return resolvedProvider(providerId, model, provider);
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
    input.end("first prompt\n/model qwen/qwen3.7-max\nsecond prompt\n");

    // Then
    await session;
    expect(stdout).toContain("fake:fake");
    expect(stdout).toContain("qwen:qwen3.7-max");
    expect(observedProviderVisibleContent).toHaveLength(2);
    expect(observedProviderVisibleContent[1]).not.toContain("/model");
    expect(sigintHandlers.size).toBe(0);
  });

  test(`Given an interactive session already has history,
    When user selects an uncatalogued real model without a context override,
    Then Keel rejects the switch and keeps the previous model active`, async () => {
    // Given
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    let stdout = "";
    let stderr = "";
    let oldProviderTurns = 0;
    let targetProviderTurns = 0;
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
        yield { type: "text", text: "unexpected unknown target" };
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
          return {
            provider: targetProvider,
            providerId: "qwen",
            model: selection.model ?? "qwen-future",
            costModel: null,
            modelSource: selection.model === undefined ? "default" : "--model",
          };
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
    input.end("first prompt\n/model qwen/qwen-future\nsecond prompt\n");

    // Then
    await session;
    expect(stderr).toContain(
      "Error: cannot switch to qwen/qwen-future because model metadata is unavailable; set KEEL_CONTEXT_WINDOW_TOKENS to configure the target context window.",
    );
    expect(stdout).toContain("old provider 1");
    expect(stdout).toContain("old provider 2");
    expect(stdout).not.toContain("unexpected unknown target");
    expect(oldProviderTurns).toBe(2);
    expect(targetProviderTurns).toBe(0);
    expect(sigintHandlers.size).toBe(0);
  });

  test(`Given an interactive session already has history,
    When user selects an uncatalogued real model with a context override,
    Then Keel accepts the switch and uses the target model`, async () => {
    // Given
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    let stdout = "";
    let stderr = "";
    let targetProviderTurns = 0;
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
            selection.model ?? "qwen-future",
            {
              id: "fake",
              async *stream() {
                targetProviderTurns++;
                yield { type: "text", text: "target accepted" };
                yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
              },
            },
            ZERO_COST_MODEL,
            { contextWindowTokens: 100_000 },
            { status: "unknown" },
          );
        }
        return resolvedProvider("fake", "fake", textProvider("old provider"));
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
    input.end("first prompt\n/model qwen/qwen-future\nsecond prompt\n");

    // Then
    await session;
    expect(stderr).toBe("");
    expect(stdout).toContain("old provider");
    expect(stdout).toContain("Model switched to qwen/qwen-future");
    expect(stdout).toContain("target accepted");
    expect(targetProviderTurns).toBe(1);
    expect(sigintHandlers.size).toBe(0);
  });

  test(`Given the interactive session is idle,
    When user enters /model without arguments,
    Then the current model is printed without starting a model turn`, async () => {
    // Given
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    let stdout = "";
    let stderr = "";
    let providerStreams = 0;
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
      resolveProvider: () =>
        resolvedProvider("fake", "fake", {
          id: "fake",
          async *stream() {
            providerStreams++;
            yield { type: "text", text: "unexpected" };
            yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          },
        }),
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async () => {
        throw new Error("/model should not start a model turn");
      },
      formatCostReport: () => "",
    });

    // When
    input.end("/model\n");

    // Then
    await session;
    expect(stdout).toContain("Current model: fake/fake");
    expect(stdout).toContain("Usage: /model <provider>/<model>");
    expect(stderr).toBe("");
    expect(providerStreams).toBe(0);
    expect(sigintHandlers.size).toBe(0);
  });

  test(`Given interactive cost tracking is enabled,
    When user selects a model with unknown pricing,
    Then the switch fails before mutating the active model`, async () => {
    // Given
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    let stdout = "";
    let stderr = "";
    let fakeTurns = 0;
    const fakeProvider: LLMProvider = {
      id: "fake",
      async *stream() {
        fakeTurns++;
        yield { type: "text", text: `fake reply ${fakeTurns}` };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
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
        if (selection?.providerId === "kimi") {
          return resolvedProvider(
            "kimi",
            selection.model ?? "kimi-k2.5",
            textProvider("unexpected kimi"),
            null,
          );
        }
        return resolvedProvider("fake", "fake", fakeProvider);
      },
      requireKnownCostModel: (resolved) => {
        if (resolved.costModel === null) {
          throw new Error("unknown target pricing");
        }
        return resolved.costModel;
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
    input.end("first prompt\n/model kimi/kimi-k2.5\nsecond prompt\n");

    // Then
    await session;
    expect(stderr).toContain("unknown target pricing");
    expect(stdout).toContain("fake reply 1");
    expect(stdout).toContain("fake reply 2");
    expect(stdout).not.toContain("unexpected kimi");
    expect(fakeTurns).toBe(2);
    expect(sigintHandlers.size).toBe(0);
  });

  test(`Given the selected model is already active,
    When user enters /model for that same model,
    Then the command is a no-op and does not add provider-visible history`, async () => {
    // Given
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    let stdout = "";
    let resolveCalls = 0;
    const observedProviderVisibleContent: string[] = [];
    const provider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        observedProviderVisibleContent.push(JSON.stringify(options.messages));
        yield {
          type: "text",
          text: `turn ${observedProviderVisibleContent.length}`,
        };
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
      writeStderr: () => {},
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
      resolveProvider: () => {
        resolveCalls++;
        return resolvedProvider("fake", "fake", provider);
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
    input.end("first prompt\n/model fake/fake\nsecond prompt\n");

    // Then
    await session;
    expect(stdout).toContain("Model already set to fake/fake");
    expect(resolveCalls).toBe(1);
    expect(observedProviderVisibleContent).toHaveLength(2);
    expect(observedProviderVisibleContent[1]).not.toContain("/model");
    expect(sigintHandlers.size).toBe(0);
  });

  test(`Given a resumed interactive session has an active model,
    When user selects the same model before another prompt,
    Then Keel reports the model is already active without persisting a switch`, async () => {
    // Given
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    let stdout = "";
    const resolvedSelections: ProviderSelection[] = [];
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
      platform: process.platform,
      initialModelSelection: { providerId: "qwen", model: "qwen3.7-plus" },
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: () => {},
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
        if (selection !== undefined) {
          resolvedSelections.push(selection);
        }
        return resolvedProvider(
          selection?.providerId ?? "fake",
          selection?.model ?? "fake",
          textProvider("unexpected turn"),
        );
      },
      requireKnownCostModel: () => ZERO_COST_MODEL,
      persistModelSwitch: () => {
        throw new Error("same model should not persist a switch");
      },
      printAgentEvents: async () => {
        throw new Error("same model command should not start a turn");
      },
      formatCostReport: () => "",
    });

    // When
    input.end("/model qwen/qwen3.7-plus\n");

    // Then
    await session;
    expect(stdout).toBe("Model already set to qwen/qwen3.7-plus\n");
    expect(resolvedSelections).toEqual([
      { providerId: "qwen", model: "qwen3.7-plus" },
    ]);
    expect(sigintHandlers.size).toBe(0);
  });

  test(`Given a named session has queued model-switch input before the first prompt,
    When user selects a model before any turn,
    Then Keel persists a switch from no previous model and consumes the command`, async () => {
    // Given
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    let stdout = "";
    const switches: Array<{
      readonly from: {
        readonly providerId: string;
        readonly model: string;
      } | null;
      readonly to: { readonly providerId: string; readonly model: string };
      readonly consumedInputIds: readonly string[];
    }> = [];
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
      platform: process.platform,
      initialQueuedInputs: [
        {
          id: "model-input",
          timestamp: "2026-01-01T00:00:00.000Z",
          sequence: 1,
          line: "/model qwen/qwen3.7-plus",
        },
        {
          id: "prompt-input",
          timestamp: "2026-01-01T00:00:01.000Z",
          sequence: 2,
          line: "first prompt",
        },
      ],
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: () => {},
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
        resolvedProvider(
          selection?.providerId ?? "fake",
          selection?.model ?? "fake",
          textProvider(
            `${selection?.providerId ?? "fake"}:${selection?.model ?? "fake"}`,
          ),
        ),
      requireKnownCostModel: () => ZERO_COST_MODEL,
      persistModelSwitch: (switchRecord) => {
        switches.push(switchRecord);
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
    expect(stdout).toContain("Model switched to qwen/qwen3.7-plus\n");
    expect(stdout).toContain("qwen:qwen3.7-plus");
    expect(switches).toEqual([
      {
        from: null,
        to: { providerId: "qwen", model: "qwen3.7-plus" },
        consumedInputIds: ["model-input"],
      },
    ]);
    expect(sigintHandlers.size).toBe(0);
  });
});
