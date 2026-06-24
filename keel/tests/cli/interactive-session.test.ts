import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { describe, expect, test } from "vitest";
import type { AgentEvent } from "../../src/agent/loop.ts";
import { runInteractiveSession } from "../../src/cli/interactive-session.ts";
import {
  createSessionStore,
  persistSessionBashApprovalGrant,
  persistSessionMessages,
  persistSessionQueuedInput,
  resumeSessionStore,
  type SessionQueuedInput,
} from "../../src/cli/session-store.ts";
import type { CostModel } from "../../src/core/cost.ts";
import {
  createFakeProvider,
  fakeResponse,
  fakeToolResponse,
} from "../../src/llm/providers/fake.ts";
import type { LLMProvider, Message, Usage } from "../../src/llm/types.ts";

const ZERO_USAGE: Usage = {
  inputTokens: 0,
  cachedInputTokens: 0,
  uncachedInputTokens: 0,
  outputTokens: 0,
};

const ZERO_COST_MODEL: CostModel = {
  type: "fixed",
  uncachedInputPerMillionTokens: 0,
  cachedInputPerMillionTokens: 0,
  outputPerMillionTokens: 0,
};

const EXPENSIVE_USAGE: Usage = {
  inputTokens: 2_000_000,
  cachedInputTokens: 0,
  uncachedInputTokens: 2_000_000,
  outputTokens: 0,
};

const ONE_DOLLAR_PER_MILLION_INPUT: CostModel = {
  type: "fixed",
  uncachedInputPerMillionTokens: 1,
  cachedInputPerMillionTokens: 0,
  outputPerMillionTokens: 0,
};

class ForcedExit extends Error {
  readonly code: number;

  constructor(code: number) {
    super(`forced exit ${code}`);
    this.code = code;
  }
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(message));
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

describe("Interactive Session", () => {
  test(`Given the interactive session is idle,
    When user interrupts,
    Then the session exits as interrupted`, async () => {
    // Given
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    let stdout = "";
    let exitCode: number | undefined;
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
      setExitCode: (code) => {
        exitCode = code;
      },
      forceExit: (code) => {
        throw new ForcedExit(code);
      },
      resolveProvider: () => {
        throw new Error("idle interrupt should not resolve a provider");
      },
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async () => undefined,
      formatCostReport: () => "",
    });

    // When
    for (const handler of [...sigintHandlers]) {
      handler();
    }

    // Then
    await session;
    expect(stdout).toBe("\n");
    expect(exitCode).toBe(130);
    expect(sigintHandlers.size).toBe(0);
  });

  test(`Given the interactive session is idle,
    When user enters /help,
    Then help is printed without starting a model turn`, async () => {
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
        throw new Error("help should not resolve a provider");
      },
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async () => {
        throw new Error("help should not start a model turn");
      },
      formatCostReport: () => "",
    });

    // When
    input.end("/help\n");

    // Then
    await session;
    expect(stdout).toContain("Interactive commands:");
    expect(stdout).toContain("/help");
    expect(stdout).toContain("/compact [focus]");
    expect(stdout).toContain("keel sessions");
    expect(stdout).toContain("keel sessions fork");
    expect(stderr).toBe("");
    expect(providerResolved).toBe(false);
    expect(sigintHandlers.size).toBe(0);
  });

  test(`Given the interactive session is idle,
    When user enters /fork with a target and fork point,
    Then the fork is created locally without starting a model turn`, async () => {
    // Given
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    let stdout = "";
    let stderr = "";
    let forkTarget = "";
    let forkBeforeUser: number | undefined;
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
        throw new Error("fork should not resolve a provider");
      },
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async () => {
        throw new Error("fork should not start a model turn");
      },
      formatCostReport: () => "",
      forkSession: (request) => {
        forkTarget = request.targetSessionId;
        forkBeforeUser = request.beforeUser;
        return 'Forked session "source" to "target" before restored user message 2.\nresume: keel --resume target\n';
      },
    });

    // When
    input.end("/fork target --before-user=2\n");

    // Then
    await session;
    expect(stdout).toBe(
      'Forked session "source" to "target" before restored user message 2.\nresume: keel --resume target\n',
    );
    expect(stderr).toBe("");
    expect(forkTarget).toBe("target");
    expect(forkBeforeUser).toBe(2);
    expect(providerResolved).toBe(false);
    expect(sigintHandlers.size).toBe(0);
  });

  test(`Given the interactive session is idle,
    When user lists fork points,
    Then the command prints local fork commands without starting a model turn`, async () => {
    // Given
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    let stdout = "";
    let stderr = "";
    let providerResolved = false;
    let listCalls = 0;
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
        throw new Error("fork points should not resolve a provider");
      },
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async () => {
        throw new Error("fork points should not start a model turn");
      },
      formatCostReport: () => "",
      listForkPoints: () => {
        listCalls += 1;
        return {
          sessionId: "source",
          points:
            listCalls === 1
              ? [
                  { beforeUser: 1, preview: "remember alpha" },
                  { beforeUser: 2, preview: "remember beta" },
                ]
              : [],
        };
      },
    });

    // When
    input.end("/fork-points\n/fork-points\n");

    // Then
    await session;
    expect(stdout).toBe(
      [
        'Fork points for session "source":',
        "1. before user message 1: remember alpha",
        "   use: /fork <new-id> --before-user 1",
        "2. before user message 2: remember beta",
        "   use: /fork <new-id> --before-user 2",
        'No restored user messages in session "source".',
        "",
      ].join("\n"),
    );
    expect(stderr).toBe("");
    expect(providerResolved).toBe(false);
    expect(sigintHandlers.size).toBe(0);
  });

  test(`Given the interactive session is idle,
    When user picks a fork point,
    Then the fork is created from the selected point without starting a model turn`, async () => {
    // Given
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    let stdout = "";
    let stderr = "";
    let forkTarget = "";
    let forkBeforeUser: number | undefined;
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
        throw new Error("fork picker should not resolve a provider");
      },
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async () => {
        throw new Error("fork picker should not start a model turn");
      },
      formatCostReport: () => "",
      listForkPoints: () => ({
        sessionId: "source",
        points: [
          { beforeUser: 1, preview: "remember alpha" },
          { beforeUser: 2, preview: "remember beta" },
        ],
      }),
      forkSession: (request) => {
        forkTarget = request.targetSessionId;
        forkBeforeUser = request.beforeUser;
        return 'Forked session "source" to "target" before restored user message 2.\nresume: keel --resume target\n';
      },
    });

    // When
    input.end("/fork target --pick\n2\n");

    // Then
    await session;
    expect(stdout).toBe(
      [
        'Fork points for session "source":',
        "0. full restored history",
        "1. before user message 1: remember alpha",
        "2. before user message 2: remember beta",
        "",
        "Select fork point [0-2], or q to cancel:",
        'Forked session "source" to "target" before restored user message 2.',
        "resume: keel --resume target",
        "",
      ].join("\n"),
    );
    expect(stderr).toBe("");
    expect(forkTarget).toBe("target");
    expect(forkBeforeUser).toBe(2);
    expect(providerResolved).toBe(false);
    expect(sigintHandlers.size).toBe(0);
  });

  test(`Given the interactive session is idle,
    When user picks full restored history,
    Then the fork is created without a before-user fork point`, async () => {
    // Given
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    let stdout = "";
    let stderr = "";
    let forkBeforeUser: number | undefined = 1;
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
        throw new Error(
          "full-history fork picker should not resolve a provider",
        );
      },
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async () => {
        throw new Error(
          "full-history fork picker should not start a model turn",
        );
      },
      formatCostReport: () => "",
      listForkPoints: () => ({
        sessionId: "source",
        points: [{ beforeUser: 1, preview: "remember alpha" }],
      }),
      forkSession: (request) => {
        forkBeforeUser = request.beforeUser;
        return 'Forked session "source" to "target".\nresume: keel --resume target\n';
      },
    });

    // When
    input.end("/fork target --pick\n0\n");

    // Then
    await session;
    expect(stdout).toContain('Forked session "source" to "target".\n');
    expect(stderr).toBe("");
    expect(forkBeforeUser).toBeUndefined();
    expect(providerResolved).toBe(false);
    expect(sigintHandlers.size).toBe(0);
  });

  test(`Given the interactive fork picker input closes before a selection,
    When the session exits,
    Then no fork is created and no model turn starts`, async () => {
    // Given
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    let stdout = "";
    let stderr = "";
    let forkCalled = false;
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
        throw new Error("closed fork picker should not resolve a provider");
      },
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async () => {
        throw new Error("closed fork picker should not start a model turn");
      },
      formatCostReport: () => "",
      listForkPoints: () => ({
        sessionId: "source",
        points: [{ beforeUser: 1, preview: "remember alpha" }],
      }),
      forkSession: () => {
        forkCalled = true;
        throw new Error("fork picker should have been closed");
      },
    });

    // When
    input.end("/fork target --pick\n");

    // Then
    await session;
    expect(stdout).toBe(
      [
        'Fork points for session "source":',
        "0. full restored history",
        "1. before user message 1: remember alpha",
        "",
        "Select fork point [0-1], or q to cancel:",
        "",
      ].join("\n"),
    );
    expect(stderr).toBe("");
    expect(forkCalled).toBe(false);
    expect(providerResolved).toBe(false);
    expect(sigintHandlers.size).toBe(0);
  });

  test(`Given the interactive fork picker operation fails,
    When user selects a fork point,
    Then the failure is reported without starting a model turn`, async () => {
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
        throw new Error("failed fork picker should not resolve a provider");
      },
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async () => {
        throw new Error("failed fork picker should not start a model turn");
      },
      formatCostReport: () => "",
      listForkPoints: () => ({
        sessionId: "source",
        points: [{ beforeUser: 1, preview: "remember alpha" }],
      }),
      forkSession: () => {
        throw "picker fork failed";
      },
    });

    // When
    input.end("/fork target --pick\n1\n");

    // Then
    await session;
    expect(stdout).toBe(
      [
        'Fork points for session "source":',
        "0. full restored history",
        "1. before user message 1: remember alpha",
        "",
        "Select fork point [0-1], or q to cancel:",
        "",
      ].join("\n"),
    );
    expect(stderr).toBe("picker fork failed\n");
    expect(providerResolved).toBe(false);
    expect(sigintHandlers.size).toBe(0);
  });

  test(`Given picker support is unavailable in a fork-capable session,
    When user asks to pick a fork point,
    Then the command fails locally without starting a model turn`, async () => {
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
        throw new Error(
          "unavailable fork picker should not resolve a provider",
        );
      },
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async () => {
        throw new Error(
          "unavailable fork picker should not start a model turn",
        );
      },
      formatCostReport: () => "",
      forkSession: () => {
        throw new Error("fork picker should fail before forking");
      },
    });

    // When
    input.end("/fork target --pick\n");

    // Then
    await session;
    expect(stdout).toBe("");
    expect(stderr).toBe(
      "Error: /fork requires a named session. Start with --session or --resume.\n",
    );
    expect(providerResolved).toBe(false);
    expect(sigintHandlers.size).toBe(0);
  });

  test(`Given queued input contains an interactive fork picker command,
    When the picker consumes a queued selection,
    Then both queued inputs are marked consumed without starting a model turn`, async () => {
    // Given
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    let stdout = "";
    let stderr = "";
    let forkBeforeUser: number | undefined;
    let providerResolved = false;
    const consumedInputIds: string[][] = [];
    const initialQueuedInputs: readonly SessionQueuedInput[] = [
      {
        id: "queued-command",
        timestamp: "1970-01-01T00:00:00.000Z",
        sequence: 1,
        line: "/fork target --pick",
      },
      {
        id: "queued-selection",
        timestamp: "1970-01-01T00:00:00.000Z",
        sequence: 2,
        line: "2",
      },
    ];
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
      platform: process.platform,
      initialQueuedInputs,
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
        throw new Error("queued fork picker should not resolve a provider");
      },
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async () => {
        throw new Error("queued fork picker should not start a model turn");
      },
      formatCostReport: () => "",
      consumeQueuedInputs: (inputIds) => {
        consumedInputIds.push([...inputIds]);
      },
      listForkPoints: () => ({
        sessionId: "source",
        points: [
          { beforeUser: 1, preview: "remember alpha" },
          { beforeUser: 2, preview: "remember beta" },
        ],
      }),
      forkSession: (request) => {
        forkBeforeUser = request.beforeUser;
        return 'Forked session "source" to "target" before restored user message 2.\nresume: keel --resume target\n';
      },
    });

    // When
    input.end();

    // Then
    await session;
    expect(stdout).toContain(
      'Forked session "source" to "target" before restored user message 2.\n',
    );
    expect(stderr).toBe("");
    expect(forkBeforeUser).toBe(2);
    expect(consumedInputIds).toEqual([["queued-command", "queued-selection"]]);
    expect(providerResolved).toBe(false);
    expect(sigintHandlers.size).toBe(0);
  });

  test(`Given the interactive fork picker receives an invalid answer,
    When user cancels after the retry prompt,
    Then no fork is created and no model turn starts`, async () => {
    // Given
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    let stdout = "";
    let stderr = "";
    let forkCalled = false;
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
        throw new Error("cancelled fork picker should not resolve a provider");
      },
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async () => {
        throw new Error("cancelled fork picker should not start a model turn");
      },
      formatCostReport: () => "",
      listForkPoints: () => ({
        sessionId: "source",
        points: [{ beforeUser: 1, preview: "remember alpha" }],
      }),
      forkSession: () => {
        forkCalled = true;
        throw new Error("fork picker should have been cancelled");
      },
    });

    // When
    input.end("/fork target --pick\n\n2\nx\nq\n");

    // Then
    await session;
    expect(stdout).toBe(
      [
        'Fork points for session "source":',
        "0. full restored history",
        "1. before user message 1: remember alpha",
        "",
        "Select fork point [0-1], or q to cancel:",
        "Select fork point [0-1], or q to cancel:",
        "Select fork point [0-1], or q to cancel:",
        "Select fork point [0-1], or q to cancel:",
        "Fork cancelled.",
        "",
      ].join("\n"),
    );
    expect(stderr).toBe(
      "Error: selection must be 0-1 or q.\nError: selection must be 0-1 or q.\nError: selection must be 0-1 or q.\n",
    );
    expect(forkCalled).toBe(false);
    expect(providerResolved).toBe(false);
    expect(sigintHandlers.size).toBe(0);
  });

  test(`Given the interactive session has no persisted session,
    When user enters /fork,
    Then the command fails locally without starting a model turn`, async () => {
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
        throw new Error("fork should not resolve a provider");
      },
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async () => {
        throw new Error("fork should not start a model turn");
      },
      formatCostReport: () => "",
    });

    // When
    input.end("/fork-points\n/fork target\n/fork target --pick\n");

    // Then
    await session;
    expect(stdout).toBe("");
    expect(stderr).toBe(
      [
        "Error: /fork-points requires a named session. Start with --session or --resume.",
        "Error: /fork requires a named session. Start with --session or --resume.",
        "Error: /fork requires a named session. Start with --session or --resume.",
        "",
      ].join("\n"),
    );
    expect(providerResolved).toBe(false);
    expect(sigintHandlers.size).toBe(0);
  });

  test(`Given the interactive session receives malformed fork commands,
    When user enters them at the prompt,
    Then each command reports a local error without starting a model turn`, async () => {
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
        throw new Error("malformed fork should not resolve a provider");
      },
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async () => {
        throw new Error("malformed fork should not start a model turn");
      },
      formatCostReport: () => "",
    });

    // When
    input.end(
      [
        "/fork",
        "/fork --before-user 1",
        "/fork target --before-user",
        "/fork target --before-user=0",
        "/fork target --before-user=9007199254740992",
        "/fork target --pick --before-user 1",
        "/fork target --pick=1",
        "/fork-points extra",
        "/fork target --all",
        "",
      ].join("\n"),
    );

    // Then
    await session;
    expect(stdout).toBe("");
    expect(stderr).toBe(
      [
        "Error: /fork requires <target-id>.",
        "Error: /fork requires <target-id>.",
        "Error: --before-user requires a value.",
        "Error: --before-user must be a positive integer.",
        "Error: --before-user must be a positive integer.",
        "Error: --pick cannot be combined with --before-user.",
        'Error: unknown /fork option "--pick=1".',
        "Error: /fork-points does not accept arguments.",
        'Error: unknown /fork option "--all".',
        "",
      ].join("\n"),
    );
    expect(providerResolved).toBe(false);
    expect(sigintHandlers.size).toBe(0);
  });

  test(`Given the interactive fork operation fails,
    When user enters /fork,
    Then the failure is reported locally without starting a model turn`, async () => {
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
        throw new Error("failed fork should not resolve a provider");
      },
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async () => {
        throw new Error("failed fork should not start a model turn");
      },
      formatCostReport: () => "",
      forkSession: () => {
        throw "fork failed";
      },
    });

    // When
    input.end("/fork target\n");

    // Then
    await session;
    expect(stdout).toBe("");
    expect(stderr).toBe("fork failed\n");
    expect(providerResolved).toBe(false);
    expect(sigintHandlers.size).toBe(0);
  });

  test(`Given an interactive turn has cost tracking,
    When the turn completes,
    Then the session prints the cost report`, async () => {
    // Given
    const provider: LLMProvider = {
      id: "fake",
      async *stream() {
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    let stderr = "";
    let resolvedProviders = 0;
    const session = runInteractiveSession({
      cliArgs: { bashMode: "trusted", maxCostUsd: 1 },
      workspace: process.cwd(),
      platform: process.platform,
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
      resolveProvider: () => {
        resolvedProviders++;
        return {
          provider,
          providerId: "fake",
          model: "fake",
          costModel: ZERO_COST_MODEL,
        };
      },
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async (stream) => {
        let finalEnd: Extract<AgentEvent, { readonly type: "end" }> | undefined;
        for await (const event of stream) {
          if (event.type === "end") {
            finalEnd = event;
          }
        }
        return finalEnd;
      },
      formatCostReport: () => "Cost: $0\n",
    });

    // When
    input.write("\nhello\n");
    input.end();

    // Then
    await session;
    expect(stderr).toBe("Cost: $0\n");
    expect(resolvedProviders).toBe(1);
    expect(sigintHandlers.size).toBe(0);
  });

  test(`Given an interactive session cost limit is exhausted,
    When more prompt input is already queued,
    Then the session stops before starting another model turn`, async () => {
    // Given
    let providerCalls = 0;
    const provider: LLMProvider = {
      id: "fake",
      async *stream() {
        providerCalls++;
        yield { type: "text", text: "expensive answer" };
        yield { type: "stop", reason: "stop", usage: EXPENSIVE_USAGE };
      },
    };
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    let stderr = "";
    const session = runInteractiveSession({
      cliArgs: { bashMode: "trusted", maxCostUsd: 1 },
      workspace: process.cwd(),
      platform: process.platform,
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
      resolveProvider: () => ({
        provider,
        providerId: "fake",
        model: "fake",
        costModel: ONE_DOLLAR_PER_MILLION_INPUT,
      }),
      requireKnownCostModel: () => ONE_DOLLAR_PER_MILLION_INPUT,
      printAgentEvents: async (stream) => {
        let finalEnd: Extract<AgentEvent, { readonly type: "end" }> | undefined;
        for await (const event of stream) {
          if (event.type === "end") {
            finalEnd = event;
          }
        }
        return finalEnd;
      },
      formatCostReport: (cost) =>
        `Cost: ${cost.spentUsd.toFixed(2)} exceeded=${String(
          cost.budgetExceeded,
        )}\n`,
    });

    // When
    input.end("first prompt\nsecond prompt\n");

    // Then
    await session;
    expect(providerCalls).toBe(1);
    expect(stderr).toBe("Cost: 2.00 exceeded=true\n");
    expect(sigintHandlers.size).toBe(0);
  });

  test(`Given a named session resumes with queued input from an interrupted run,
    When stdin closes before new input arrives,
    Then the queued input runs once and is consumed with the persisted turn`, async () => {
    // Given
    const pendingInput: SessionQueuedInput = {
      id: "queued-follow-up",
      timestamp: "1970-01-01T00:00:00.001Z",
      sequence: 7,
      line: "continue with beta",
    };
    const observedUserContexts: string[][] = [];
    const provider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        observedUserContexts.push(
          options.messages
            .filter((message) => message.role === "user")
            .map((message) => message.content),
        );
        yield { type: "text", text: "Queued turn done." };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const input = new PassThrough();
    const consumedInputIds: string[][] = [];
    let persistedMessages: readonly Message[] = [];
    let stdout = "";
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
      platform: process.platform,
      initialQueuedInputs: [pendingInput],
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: () => {},
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
      }),
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
      persistSessionMessages: (messages, _reason, inputIds) => {
        persistedMessages = [...messages];
        consumedInputIds.push([...inputIds]);
      },
    });
    input.end();

    // When / Then
    await withTimeout(session, 5000, "resumed queued input was not processed");
    expect(stdout).toBe("Queued turn done.\n");
    expect(observedUserContexts).toEqual([["continue with beta"]]);
    expect(consumedInputIds).toEqual([["queued-follow-up"]]);
    expect(persistedMessages).toEqual([
      { role: "user", content: "continue with beta" },
      { role: "assistant", content: "Queued turn done.", toolCalls: [] },
    ]);
  });

  test(`Given a named session resumes with blank queued input,
    When stdin closes before new input arrives,
    Then the blank input is consumed without starting a model turn`, async () => {
    // Given
    const pendingInput: SessionQueuedInput = {
      id: "blank-queued-input",
      timestamp: "1970-01-01T00:00:00.001Z",
      sequence: 8,
      line: "   ",
    };
    const consumedInputIds: string[][] = [];
    const input = new PassThrough();
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
      platform: process.platform,
      initialQueuedInputs: [pendingInput],
      input,
      writeStdout: () => {},
      writeStderr: () => {},
      onSigint: () => {},
      offSigint: () => {},
      setExitCode: () => {},
      forceExit: (code) => {
        throw new ForcedExit(code);
      },
      resolveProvider: () => {
        throw new Error("blank queued input should not resolve a provider");
      },
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async () => undefined,
      formatCostReport: () => "",
      consumeQueuedInputs: (inputIds) => {
        consumedInputIds.push([...inputIds]);
      },
    });
    input.end();

    // When
    await withTimeout(session, 5000, "blank queued input was not consumed");

    // Then
    expect(consumedInputIds).toEqual([["blank-queued-input"]]);
  });

  test(`Given a queued prompt is typed while a named session turn is running,
    When the process stops before the turn transcript is persisted,
    Then the queued prompt is durable and resumes exactly once`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-interactive-inbox-"));
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    let now = 0;
    const runtime = {
      env: (key: string) => (key === "KEEL_HOME" ? home : undefined),
      now: () => now,
    };
    const session = createSessionStore({
      sessionId: "durable-inbox",
      workspace,
      runtime,
    });
    let persistedMessages: readonly Message[] = session.messages;
    const crash = new Error("simulated process stop");
    const firstProvider: LLMProvider = {
      id: "fake",
      async *stream() {
        yield {
          type: "tool_call",
          id: "durable_inbox_read",
          tool: "read",
          path: "package.json",
        };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const firstInput = new PassThrough();
    const firstRun = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace,
      platform: process.platform,
      initialMessages: session.messages,
      initialQueuedInputs: session.pendingInputs,
      input: firstInput,
      writeStdout: () => {},
      writeStderr: () => {},
      onSigint: () => {},
      offSigint: () => {},
      setExitCode: () => {},
      forceExit: (code) => {
        throw new ForcedExit(code);
      },
      resolveProvider: () => ({
        provider: firstProvider,
        providerId: "fake",
        model: "fake",
        costModel: ZERO_COST_MODEL,
      }),
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async (stream) => {
        for await (const event of stream) {
          if (event.type === "tool_start") {
            now = 1;
            firstInput.write("continue after restart\n");
            await setImmediate();
            firstInput.end();
            throw crash;
          }
        }
        return undefined;
      },
      formatCostReport: () => "",
      persistQueuedInput: (input) =>
        persistSessionQueuedInput({
          session,
          sequence: input.sequence,
          line: input.line,
          runtime,
        }),
      persistSessionMessages: (messages, reason, consumedInputIds) => {
        now = 2;
        persistedMessages = persistSessionMessages({
          session,
          previousMessages: persistedMessages,
          currentMessages: messages,
          runtime,
          reason,
          consumedInputIds,
        });
      },
    });

    try {
      firstInput.write("start slow tool\n");
      await expect(firstRun).rejects.toThrow("simulated process stop");

      const ledgerAfterCrash = (await readFile(session.filePath, "utf8"))
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(ledgerAfterCrash).toHaveLength(2);
      expect(ledgerAfterCrash[1]).toMatchObject({
        type: "input_admitted",
        line: "continue after restart",
      });
      const resumed = resumeSessionStore({
        sessionId: "durable-inbox",
        workspace,
        runtime,
      });
      expect(resumed.messages).toEqual([]);
      expect(resumed.pendingInputs).toHaveLength(1);

      const observedUserContexts: string[][] = [];
      const secondProvider: LLMProvider = {
        id: "fake",
        async *stream(options) {
          observedUserContexts.push(
            options.messages
              .filter((message) => message.role === "user")
              .map((message) => message.content),
          );
          yield { type: "text", text: "Recovered queued prompt." };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
        },
      };
      const secondInput = new PassThrough();
      let resumedPersistedMessages: readonly Message[] = resumed.messages;
      const secondRun = runInteractiveSession({
        cliArgs: { bashMode: "disabled" },
        workspace,
        platform: process.platform,
        initialMessages: resumed.messages,
        initialQueuedInputs: resumed.pendingInputs,
        input: secondInput,
        writeStdout: () => {},
        writeStderr: () => {},
        onSigint: () => {},
        offSigint: () => {},
        setExitCode: () => {},
        forceExit: (code) => {
          throw new ForcedExit(code);
        },
        resolveProvider: () => ({
          provider: secondProvider,
          providerId: "fake",
          model: "fake",
          costModel: ZERO_COST_MODEL,
        }),
        requireKnownCostModel: () => ZERO_COST_MODEL,
        printAgentEvents: async (stream) => {
          let finalEnd:
            | Extract<AgentEvent, { readonly type: "end" }>
            | undefined;
          for await (const event of stream) {
            if (event.type === "end") {
              finalEnd = event;
            }
          }
          return finalEnd;
        },
        formatCostReport: () => "",
        persistSessionMessages: (messages, reason, consumedInputIds) => {
          now = 3;
          resumedPersistedMessages = persistSessionMessages({
            session: resumed,
            previousMessages: resumedPersistedMessages,
            currentMessages: messages,
            runtime,
            reason,
            consumedInputIds,
          });
        },
      });
      secondInput.end();

      // When
      await withTimeout(
        secondRun,
        5000,
        "durable queued prompt was not resumed",
      );
      const finalResume = resumeSessionStore({
        sessionId: "durable-inbox",
        workspace,
        runtime,
      });

      // Then
      expect(observedUserContexts).toEqual([["continue after restart"]]);
      expect(finalResume.pendingInputs).toEqual([]);
      expect(finalResume.messages).toEqual([
        { role: "user", content: "continue after restart" },
        {
          role: "assistant",
          content: "Recovered queued prompt.",
          toolCalls: [],
        },
      ]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given an interactive report is requested but no end event is returned,
    When the user finishes a prompt,
    Then no session report is produced`, async () => {
    // Given
    const provider: LLMProvider = {
      id: "fake",
      async *stream() {
        yield { type: "text", text: "answer" };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const input = new PassThrough();
    let stdout = "";
    const session = runInteractiveSession({
      cliArgs: { bashMode: "trusted", reportFile: "session.json" },
      workspace: process.cwd(),
      platform: process.platform,
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: () => {},
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
      }),
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async (stream) => {
        for await (const event of stream) {
          if (event.type === "text") {
            stdout += event.text;
          }
        }
        return undefined;
      },
      formatCostReport: () => "",
    });

    // When
    input.end("hello\n");

    // Then
    const result = await session;
    expect(stdout).toBe("answer\n");
    expect(result.report).toBeUndefined();
  });

  test(`Given an interactive assistant turn is still working,
    When user sends a follow-up before it finishes,
    Then the follow-up runs next with previous context`, async () => {
    // Given
    let finishFirstTurn: () => void = () => {};
    let receiveFirstText: () => void = () => {};
    const firstTurnCanFinish = new Promise<void>((resolve) => {
      finishFirstTurn = resolve;
    });
    const firstTextReceived = new Promise<void>((resolve) => {
      receiveFirstText = resolve;
    });
    const observedContexts: Array<
      Array<{ readonly role: Message["role"]; readonly content: string }>
    > = [];
    let turn = 0;
    const provider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        turn++;
        observedContexts.push(
          options.messages.map((message) => ({
            role: message.role,
            content: message.content,
          })),
        );

        if (turn === 1) {
          yield { type: "text", text: "First answer" };
          receiveFirstText();
          await firstTurnCanFinish;
        } else {
          yield { type: "text", text: "Second saw prior context" };
        }
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const input = new PassThrough();
    let stdout = "";
    const session = runInteractiveSession({
      cliArgs: { bashMode: "ask" },
      workspace: process.cwd(),
      platform: process.platform,
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: () => {
        throw new Error("follow-up input should not be treated as approval");
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
      }),
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
    input.write("first prompt\n");
    await withTimeout(firstTextReceived, 5000, "first turn did not start");
    input.write("second prompt\n");
    input.end();
    finishFirstTurn();

    // Then
    await session;
    expect(stdout).toBe("First answer\nSecond saw prior context\n");
    expect(observedContexts).toEqual([
      [{ role: "user", content: "first prompt" }],
      [
        { role: "user", content: "first prompt" },
        { role: "assistant", content: "First answer" },
        { role: "user", content: "second prompt" },
      ],
    ]);
  });

  test(`Given a resumed session contains historical tool results,
    When the user sends a follow-up prompt,
    Then the model sees the history without re-running old tools`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-interactive-resume-"));
    const initialMessages: readonly Message[] = [
      { role: "user", content: "create the old file" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "historical_write",
            tool: "write",
            path: "old.txt",
            content: "old content\n",
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "historical_write",
        content: "Wrote old.txt",
      },
    ];
    let observedMessages: readonly Message[] = [];
    const provider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        observedMessages = options.messages;
        yield { type: "text", text: "Continuing from history." };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const input = new PassThrough();
    let stdout = "";
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace,
      platform: process.platform,
      initialMessages,
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: () => {},
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
      }),
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

    try {
      // When
      input.end("continue\n");

      // Then
      await session;
      expect(stdout).toBe("Continuing from history.\n");
      expect(observedMessages).toEqual([
        ...initialMessages,
        { role: "user", content: "continue" },
      ]);
      await expect(
        readFile(join(workspace, "old.txt"), "utf8"),
      ).rejects.toThrow("ENOENT");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an interactive session asks for bash permission,
    When the user approves the command for the session,
    Then repeated matching commands run without asking again`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-interactive-bash-"));
    const command =
      "node -e \"require('node:fs').appendFileSync('runs.txt', 'x')\"";
    const provider = createFakeProvider([
      fakeToolResponse("bash", { command }),
      fakeToolResponse("bash", { command }),
      fakeResponse("Ran twice."),
    ]);
    const input = new PassThrough();
    let stdout = "";
    let stderr = "";
    let approvalAnswered = false;
    const session = runInteractiveSession({
      cliArgs: { bashMode: "ask" },
      workspace,
      platform: process.platform,
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
        if (text.includes("Approve bash command") && !approvalAnswered) {
          approvalAnswered = true;
          input.write("s\n");
          input.end();
        }
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
      }),
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

    try {
      // When
      input.write("run twice\n");

      // Then
      await session;
      expect(stdout).toBe("Ran twice.\n");
      expect(await readFile(join(workspace, "runs.txt"), "utf8")).toBe("xx");
      expect(stderr.match(/Approve bash command/g)).toHaveLength(1);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an interactive user approves a bash command family,
    When the assistant runs matching commands in the same workspace,
    Then the later matching command runs without another prompt`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-interactive-bash-"));
    const firstCommand = "git status --short";
    const secondCommand = "git status --porcelain";
    const provider = createFakeProvider([
      fakeToolResponse("bash", { command: firstCommand }),
      fakeToolResponse("bash", { command: secondCommand }),
      fakeResponse("Checked status twice."),
    ]);
    const input = new PassThrough();
    let stdout = "";
    let stderr = "";
    let approvalPrompts = 0;
    const session = runInteractiveSession({
      cliArgs: { bashMode: "ask" },
      workspace,
      platform: process.platform,
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
        if (text.includes("Approve bash command")) {
          approvalPrompts++;
          input.write("p\n");
          input.end();
        }
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
      }),
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

    try {
      execFileSync("git", ["init", "--quiet"], { cwd: workspace });

      // When
      input.write("check status twice\n");

      // Then
      await withTimeout(
        session,
        5000,
        "command family approval did not finish",
      );
      expect(stdout).toBe("Checked status twice.\n");
      expect(stderr).toContain(
        "[p] allow command family for session: git status",
      );
      expect(approvalPrompts).toBe(1);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an interactive user answers prefix for a command without a family,
    When the assistant requests bash approval,
    Then the command is denied without offering a command family`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-interactive-bash-"));
    const command =
      "node -e \"require('node:fs').writeFileSync('created.txt', 'changed')\"";
    const provider = createFakeProvider([
      fakeToolResponse("bash", { command }),
      fakeResponse("No prefix approval."),
    ]);
    const input = new PassThrough();
    let stdout = "";
    let stderr = "";
    let approvalAnswered = false;
    const session = runInteractiveSession({
      cliArgs: { bashMode: "ask" },
      workspace,
      platform: process.platform,
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
        if (text.includes("Approve bash command") && !approvalAnswered) {
          approvalAnswered = true;
          input.write("p\n");
          input.end();
        }
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
      }),
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

    try {
      // When
      input.write("try prefix approval\n");

      // Then
      await withTimeout(session, 5000, "prefix denial did not finish");
      expect(stdout).toBe("No prefix approval.\n");
      expect(stderr).not.toContain("[p] allow command family for session:");
      await expect(
        readFile(join(workspace, "created.txt"), "utf8"),
      ).rejects.toThrow("ENOENT");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given git diff no-index requests interactive bash approval,
    When the user answers prefix,
    Then the command is denied without offering a command family`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-interactive-bash-"));
    const outsideSecret = join(tmpdir(), "keel-outside-secret.txt");
    const outsideEmpty = join(tmpdir(), "keel-outside-empty.txt");
    const command = `git diff --no-index ${outsideSecret} ${outsideEmpty}`;
    let secondTurnMessages: readonly Message[] = [];
    const provider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        if (options.messages.length === 1) {
          yield {
            type: "tool_call",
            id: "git_diff_no_index",
            tool: "bash",
            command,
          };
        } else {
          secondTurnMessages = options.messages;
          yield { type: "text", text: "No git diff family." };
        }
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const input = new PassThrough();
    let stdout = "";
    let stderr = "";
    let approvalAnswered = false;
    const session = runInteractiveSession({
      cliArgs: { bashMode: "ask" },
      workspace,
      platform: process.platform,
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
        if (text.includes("Approve bash command") && !approvalAnswered) {
          approvalAnswered = true;
          input.write("p\n");
          input.end();
        }
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
      }),
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

    try {
      // When
      input.write("try git diff prefix approval\n");

      // Then
      await withTimeout(session, 5000, "git diff prefix denial did not finish");
      expect(stdout).toBe("No git diff family.\n");
      expect(stderr).not.toContain(
        "[p] allow command family for session: git diff",
      );
      expect(secondTurnMessages).toContainEqual({
        role: "tool",
        toolCallId: "git_diff_no_index",
        content: expect.stringContaining("User did not approve this command."),
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a resumed session previously approved bash for the session,
    When the assistant repeats the command after resume,
    Then the command runs without another approval prompt`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-interactive-bash-"));
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const command =
      "node -e \"require('node:fs').appendFileSync('runs.txt', 'x')\"";
    const session = createSessionStore({
      sessionId: "bash-approval-resume",
      workspace,
      runtime: {
        env: (key) => (key === "KEEL_HOME" ? home : undefined),
        now: () => 0,
      },
    });
    let persistedMessages: readonly Message[] = session.messages;
    let firstApprovalPrompts = 0;
    const firstInput = new PassThrough();
    const firstProvider = createFakeProvider([
      fakeToolResponse("bash", { command }),
      fakeResponse("First run done."),
    ]);
    const firstSession = runInteractiveSession({
      cliArgs: { bashMode: "ask" },
      workspace,
      platform: process.platform,
      initialMessages: session.messages,
      initialQueuedInputs: session.pendingInputs,
      initialBashApprovalGrants: session.bashApprovalGrants,
      input: firstInput,
      writeStdout: () => {},
      writeStderr: (text) => {
        if (text.includes("Approve bash command")) {
          firstApprovalPrompts++;
          firstInput.write("s\n");
          firstInput.end();
        }
      },
      onSigint: () => {},
      offSigint: () => {},
      setExitCode: () => {},
      forceExit: (code) => {
        throw new ForcedExit(code);
      },
      resolveProvider: () => ({
        provider: firstProvider,
        providerId: "fake",
        model: "fake",
        costModel: ZERO_COST_MODEL,
      }),
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async (stream) => {
        let finalEnd: Extract<AgentEvent, { readonly type: "end" }> | undefined;
        for await (const event of stream) {
          if (event.type === "end") {
            finalEnd = event;
          }
        }
        return finalEnd;
      },
      formatCostReport: () => "",
      persistSessionMessages: (messages, reason, consumedInputIds) => {
        persistedMessages = persistSessionMessages({
          session,
          previousMessages: persistedMessages,
          currentMessages: messages,
          runtime: {
            env: (key) => (key === "KEEL_HOME" ? home : undefined),
            now: () => 1,
          },
          reason,
          consumedInputIds,
        });
      },
      persistBashApprovalGrant: (grant) => {
        persistSessionBashApprovalGrant({
          session,
          grant,
          runtime: {
            env: (key) => (key === "KEEL_HOME" ? home : undefined),
            now: () => 2,
          },
        });
      },
    });

    try {
      firstInput.write("run once\n");
      await firstSession;

      const resumedSession = resumeSessionStore({
        sessionId: "bash-approval-resume",
        workspace,
        runtime: {
          env: (key) => (key === "KEEL_HOME" ? home : undefined),
          now: () => 3,
        },
      });
      let secondApprovalPrompts = 0;
      const secondInput = new PassThrough();
      const secondProvider = createFakeProvider([
        fakeToolResponse("bash", { command }),
        fakeResponse("Second run done."),
      ]);
      const secondSession = runInteractiveSession({
        cliArgs: { bashMode: "ask" },
        workspace,
        platform: process.platform,
        initialMessages: resumedSession.messages,
        initialQueuedInputs: resumedSession.pendingInputs,
        initialBashApprovalGrants: resumedSession.bashApprovalGrants,
        input: secondInput,
        writeStdout: () => {},
        writeStderr: (text) => {
          if (text.includes("Approve bash command")) {
            secondApprovalPrompts++;
          }
        },
        onSigint: () => {},
        offSigint: () => {},
        setExitCode: () => {},
        forceExit: (code) => {
          throw new ForcedExit(code);
        },
        resolveProvider: () => ({
          provider: secondProvider,
          providerId: "fake",
          model: "fake",
          costModel: ZERO_COST_MODEL,
        }),
        requireKnownCostModel: () => ZERO_COST_MODEL,
        printAgentEvents: async (stream) => {
          let finalEnd:
            | Extract<AgentEvent, { readonly type: "end" }>
            | undefined;
          for await (const event of stream) {
            if (event.type === "end") {
              finalEnd = event;
            }
          }
          return finalEnd;
        },
        formatCostReport: () => "",
        persistBashApprovalGrant: (grant) => {
          persistSessionBashApprovalGrant({
            session: resumedSession,
            grant,
            runtime: {
              env: (key) => (key === "KEEL_HOME" ? home : undefined),
              now: () => 4,
            },
          });
        },
      });

      // When
      secondInput.write("run again\n");
      secondInput.end();

      // Then
      await withTimeout(
        secondSession,
        5000,
        "resumed approved command did not finish",
      );
      expect(firstApprovalPrompts).toBe(1);
      expect(secondApprovalPrompts).toBe(0);
      expect(await readFile(join(workspace, "runs.txt"), "utf8")).toBe("xx");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a resumed session previously approved a bash command family,
    When the assistant runs a matching command after resume,
    Then the command family runs without another approval prompt`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-interactive-bash-"));
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const firstCommand = "git status --short";
    const secondCommand = "git status --porcelain";
    const session = createSessionStore({
      sessionId: "bash-prefix-approval-resume",
      workspace,
      runtime: {
        env: (key) => (key === "KEEL_HOME" ? home : undefined),
        now: () => 0,
      },
    });
    let persistedMessages: readonly Message[] = session.messages;
    let firstApprovalPrompts = 0;
    const firstInput = new PassThrough();
    const firstProvider = createFakeProvider([
      fakeToolResponse("bash", { command: firstCommand }),
      fakeResponse("First status done."),
    ]);
    const firstSession = runInteractiveSession({
      cliArgs: { bashMode: "ask" },
      workspace,
      platform: process.platform,
      initialMessages: session.messages,
      initialQueuedInputs: session.pendingInputs,
      initialBashApprovalGrants: session.bashApprovalGrants,
      input: firstInput,
      writeStdout: () => {},
      writeStderr: (text) => {
        if (text.includes("Approve bash command")) {
          firstApprovalPrompts++;
          firstInput.write("p\n");
          firstInput.end();
        }
      },
      onSigint: () => {},
      offSigint: () => {},
      setExitCode: () => {},
      forceExit: (code) => {
        throw new ForcedExit(code);
      },
      resolveProvider: () => ({
        provider: firstProvider,
        providerId: "fake",
        model: "fake",
        costModel: ZERO_COST_MODEL,
      }),
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async (stream) => {
        let finalEnd: Extract<AgentEvent, { readonly type: "end" }> | undefined;
        for await (const event of stream) {
          if (event.type === "end") {
            finalEnd = event;
          }
        }
        return finalEnd;
      },
      formatCostReport: () => "",
      persistSessionMessages: (messages, reason, consumedInputIds) => {
        persistedMessages = persistSessionMessages({
          session,
          previousMessages: persistedMessages,
          currentMessages: messages,
          runtime: {
            env: (key) => (key === "KEEL_HOME" ? home : undefined),
            now: () => 1,
          },
          reason,
          consumedInputIds,
        });
      },
      persistBashApprovalGrant: (grant) => {
        persistSessionBashApprovalGrant({
          session,
          grant,
          runtime: {
            env: (key) => (key === "KEEL_HOME" ? home : undefined),
            now: () => 2,
          },
        });
      },
    });

    try {
      execFileSync("git", ["init", "--quiet"], { cwd: workspace });
      firstInput.write("check status\n");
      await firstSession;

      const resumedSession = resumeSessionStore({
        sessionId: "bash-prefix-approval-resume",
        workspace,
        runtime: {
          env: (key) => (key === "KEEL_HOME" ? home : undefined),
          now: () => 3,
        },
      });
      let secondApprovalPrompts = 0;
      const secondInput = new PassThrough();
      const secondProvider = createFakeProvider([
        fakeToolResponse("bash", { command: secondCommand }),
        fakeResponse("Second status done."),
      ]);
      const secondSession = runInteractiveSession({
        cliArgs: { bashMode: "ask" },
        workspace,
        platform: process.platform,
        initialMessages: resumedSession.messages,
        initialQueuedInputs: resumedSession.pendingInputs,
        initialBashApprovalGrants: resumedSession.bashApprovalGrants,
        input: secondInput,
        writeStdout: () => {},
        writeStderr: (text) => {
          if (text.includes("Approve bash command")) {
            secondApprovalPrompts++;
          }
        },
        onSigint: () => {},
        offSigint: () => {},
        setExitCode: () => {},
        forceExit: (code) => {
          throw new ForcedExit(code);
        },
        resolveProvider: () => ({
          provider: secondProvider,
          providerId: "fake",
          model: "fake",
          costModel: ZERO_COST_MODEL,
        }),
        requireKnownCostModel: () => ZERO_COST_MODEL,
        printAgentEvents: async (stream) => {
          let finalEnd:
            | Extract<AgentEvent, { readonly type: "end" }>
            | undefined;
          for await (const event of stream) {
            if (event.type === "end") {
              finalEnd = event;
            }
          }
          return finalEnd;
        },
        formatCostReport: () => "",
      });

      // When
      secondInput.write("check status again\n");
      secondInput.end();

      // Then
      await withTimeout(
        secondSession,
        5000,
        "resumed approved command family did not finish",
      );
      expect(firstApprovalPrompts).toBe(1);
      expect(secondApprovalPrompts).toBe(0);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given an interactive user approves bash once,
    When the assistant repeats the same command,
    Then the session asks for approval again`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-interactive-bash-"));
    const command =
      "node -e \"require('node:fs').appendFileSync('runs.txt', 'x')\"";
    const provider = createFakeProvider([
      fakeToolResponse("bash", { command }),
      fakeToolResponse("bash", { command }),
      fakeResponse("Ran twice."),
    ]);
    const input = new PassThrough();
    let stderr = "";
    let approvalPrompts = 0;
    const session = runInteractiveSession({
      cliArgs: { bashMode: "ask" },
      workspace,
      platform: process.platform,
      input,
      writeStdout: () => {},
      writeStderr: (text) => {
        stderr += text;
        if (text.includes("Approve bash command")) {
          approvalPrompts++;
          queueMicrotask(() => {
            input.write("y\n");
            if (approvalPrompts === 2) {
              input.end();
            }
          });
        }
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
      }),
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async (stream) => {
        let finalEnd: Extract<AgentEvent, { readonly type: "end" }> | undefined;
        for await (const event of stream) {
          if (event.type === "end") {
            finalEnd = event;
          }
        }
        return finalEnd;
      },
      formatCostReport: () => "",
    });

    try {
      // When
      input.write("run twice\n");

      // Then
      await session;
      expect(await readFile(join(workspace, "runs.txt"), "utf8")).toBe("xx");
      expect(stderr.match(/Approve bash command/g)).toHaveLength(2);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an interactive bash approval receives an empty answer,
    When the command is denied,
    Then the model receives a no-response denial`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-interactive-bash-"));
    const command =
      "node -e \"require('node:fs').writeFileSync('created.txt', 'changed')\"";
    let secondTurnMessages: readonly Message[] = [];
    const provider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        if (options.messages.length === 1) {
          yield {
            type: "tool_call",
            id: "empty_approval_bash",
            tool: "bash",
            command,
          };
        } else {
          secondTurnMessages = options.messages;
          yield { type: "text", text: "No approval." };
        }
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const input = new PassThrough();
    let stdout = "";
    let answered = false;
    const session = runInteractiveSession({
      cliArgs: { bashMode: "ask" },
      workspace,
      platform: process.platform,
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        if (text.includes("Approve bash command") && !answered) {
          answered = true;
          input.write("\n");
          input.end();
        }
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
      }),
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

    try {
      // When
      input.write("run shell\n");

      // Then
      await session;
      await expect(
        readFile(join(workspace, "created.txt"), "utf8"),
      ).rejects.toThrow("ENOENT");
      expect(stdout).toBe("No approval.\n");
      expect(secondTurnMessages).toContainEqual({
        role: "tool",
        toolCallId: "empty_approval_bash",
        content: expect.stringContaining("No approval response provided."),
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an interactive bash approval prompt is waiting,
    When user interrupts the active turn,
    Then the approval is denied without waiting for another input line`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-interactive-bash-"));
    const command =
      "node -e \"require('node:fs').writeFileSync('created.txt', 'changed')\"";
    const provider = createFakeProvider([
      fakeToolResponse("bash", { command }),
      fakeResponse("Interrupted approval."),
    ]);
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    let stdout = "";
    let stderr = "";
    const session = runInteractiveSession({
      cliArgs: { bashMode: "ask" },
      workspace,
      platform: process.platform,
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
        if (text.includes("Approve bash command")) {
          queueMicrotask(() => {
            for (const handler of [...sigintHandlers]) {
              handler();
            }
            input.end();
          });
        }
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
      }),
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

    try {
      // When
      input.write("run shell\n");

      // Then
      await withTimeout(session, 5000, "approval did not stop after SIGINT");
      await expect(
        readFile(join(workspace, "created.txt"), "utf8"),
      ).rejects.toThrow("ENOENT");
      expect(stdout).toBe("Interrupted approval.\n");
      expect(stderr).toContain("Approve bash command");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a bash approval signal is already aborted,
    When the approval reader starts waiting,
    Then the command is denied without consuming another input line`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-interactive-bash-"));
    const command =
      "node -e \"require('node:fs').writeFileSync('created.txt', 'changed')\"";
    const provider = createFakeProvider([
      fakeToolResponse("bash", { command }),
      fakeResponse("Approval already aborted."),
    ]);
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    let stdout = "";
    const session = runInteractiveSession({
      cliArgs: { bashMode: "ask" },
      workspace,
      platform: process.platform,
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        if (text.includes("Approve bash command")) {
          for (const handler of [...sigintHandlers]) {
            handler();
          }
          input.end();
        }
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
      }),
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

    try {
      // When
      input.write("run shell\n");

      // Then
      await withTimeout(session, 5000, "approval did not stop after abort");
      await expect(
        readFile(join(workspace, "created.txt"), "utf8"),
      ).rejects.toThrow("ENOENT");
      expect(stdout).toBe("Approval already aborted.\n");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given stdin closes before bash approval can be answered,
    When the command asks for permission,
    Then the command is denied as interrupted input`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-interactive-bash-"));
    const command =
      "node -e \"require('node:fs').writeFileSync('created.txt', 'changed')\"";
    let startFirstTurn: () => void = () => {};
    let allowToolCall: () => void = () => {};
    const firstTurnStarted = new Promise<void>((resolve) => {
      startFirstTurn = resolve;
    });
    const toolCallAllowed = new Promise<void>((resolve) => {
      allowToolCall = resolve;
    });
    const input = new PassThrough();
    const inputEnded = new Promise<void>((resolve) => {
      input.once("end", () => {
        resolve();
      });
    });
    let secondTurnMessages: readonly Message[] = [];
    let turn = 0;
    const provider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        turn++;
        if (turn === 1) {
          startFirstTurn();
          await toolCallAllowed;
          yield {
            type: "tool_call",
            id: "closed_approval_bash",
            tool: "bash",
            command,
          };
        } else {
          secondTurnMessages = options.messages;
          yield { type: "text", text: "Closed approval." };
        }
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    let stdout = "";
    let stderr = "";
    const session = runInteractiveSession({
      cliArgs: { bashMode: "ask" },
      workspace,
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
      }),
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

    try {
      // When
      input.write("run shell\n");
      await withTimeout(firstTurnStarted, 5000, "first turn did not start");
      input.end();
      await withTimeout(inputEnded, 5000, "stdin did not close");
      allowToolCall();

      // Then
      await session;
      await expect(
        readFile(join(workspace, "created.txt"), "utf8"),
      ).rejects.toThrow("ENOENT");
      expect(stdout).toBe("Closed approval.\n");
      expect(stderr).toContain("Approve bash command");
      expect(secondTurnMessages).toContainEqual({
        role: "tool",
        toolCallId: "closed_approval_bash",
        content: expect.stringContaining(
          "Command approval was interrupted or input closed.",
        ),
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a bash approval answer was typed before the prompt,
    When the command asks for permission,
    Then the queued line is not consumed as approval`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-interactive-bash-"));
    const command =
      "node -e \"require('node:fs').writeFileSync('created.txt', 'changed')\"";
    let turn = 0;
    const observedUserContexts: string[][] = [];
    const provider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        turn++;
        observedUserContexts.push(
          options.messages
            .filter((message) => message.role === "user")
            .map((message) => message.content),
        );
        if (turn === 1) {
          yield {
            type: "tool_call",
            id: "queued_approval_bash",
            tool: "bash",
            command,
          };
        } else if (turn === 2) {
          yield { type: "text", text: "Denied." };
        } else {
          yield { type: "text", text: "Queued line kept." };
        }
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const input = new PassThrough();
    let stdout = "";
    const session = runInteractiveSession({
      cliArgs: { bashMode: "ask" },
      workspace,
      platform: process.platform,
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: () => {},
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
      }),
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

    try {
      // When
      input.end("run shell\ns\n");

      // Then
      await session;
      await expect(
        readFile(join(workspace, "created.txt"), "utf8"),
      ).rejects.toThrow("ENOENT");
      expect(stdout).toBe("Denied.\nQueued line kept.\n");
      expect(observedUserContexts).toEqual([
        ["run shell"],
        ["run shell"],
        ["run shell", "s"],
      ]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a user types while an interactive tool turn is running,
    When the assistant continues after the tool result,
    Then the typed message steers the same turn`, async () => {
    // Given
    let turn = 0;
    let steeringWritten = false;
    const observedContexts: Message[][] = [];
    const provider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        turn++;
        observedContexts.push([...options.messages]);
        if (turn === 1) {
          yield {
            type: "tool_call",
            id: "interactive_steering_read",
            tool: "read",
            path: "package.json",
            limit: 1,
          };
        } else if (turn === 2) {
          yield { type: "text", text: "Steered." };
        } else {
          yield { type: "text", text: "Queued follow-up." };
        }
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const input = new PassThrough();
    let stdout = "";
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
      platform: process.platform,
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: () => {},
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
      }),
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async (stream) => {
        let finalEnd: Extract<AgentEvent, { readonly type: "end" }> | undefined;
        for await (const event of stream) {
          if (event.type === "tool_start" && !steeringWritten) {
            steeringWritten = true;
            input.write("focus on scripts\n");
          } else if (event.type === "text") {
            stdout += event.text;
          } else if (event.type === "end") {
            finalEnd = event;
            input.end();
          }
        }
        return finalEnd;
      },
      formatCostReport: () => "",
    });

    // When
    input.write("inspect package\n");

    // Then
    await session;
    expect(stdout).toBe("Steered.\n");
    expect(observedContexts).toEqual([
      [{ role: "user", content: "inspect package" }],
      [
        { role: "user", content: "inspect package" },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "interactive_steering_read",
              tool: "read",
              path: "package.json",
              limit: 1,
            },
          ],
        },
        expect.objectContaining({
          role: "tool",
          toolCallId: "interactive_steering_read",
        }),
        { role: "user", content: "focus on scripts" },
      ],
    ]);
  });

  test(`Given user enters /compact while an interactive tool turn is running,
    When the assistant continues after the tool result,
    Then the compact command is deferred instead of injected as steering`, async () => {
    // Given
    const focusInstruction = "keep the tool result and next action";
    let turn = 0;
    let compactWritten = false;
    const observedContexts: Message[][] = [];
    let summaryPrompt = "";
    const provider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        if (options.toolChoice === "none") {
          summaryPrompt = options.messages[0]?.content ?? "";
          yield { type: "text", text: "Deferred compact summary." };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }

        turn++;
        observedContexts.push(structuredClone([...options.messages]));
        if (turn === 1) {
          yield {
            type: "tool_call",
            id: "deferred_compact_read",
            tool: "read",
            path: "package.json",
            limit: 1,
          };
        } else if (turn === 2) {
          yield { type: "text", text: "Tool turn done." };
        } else {
          yield { type: "text", text: "After compact done." };
        }
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const input = new PassThrough();
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
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async (stream) => {
        let finalEnd: Extract<AgentEvent, { readonly type: "end" }> | undefined;
        for await (const event of stream) {
          if (event.type === "tool_start" && !compactWritten) {
            compactWritten = true;
            input.write(`/compact ${focusInstruction}\n`);
            input.end("after compact\n");
          } else if (event.type === "text") {
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
    input.write("inspect package\n");

    // Then
    await session;
    expect(stdout).toBe("Tool turn done.\nAfter compact done.\n");
    expect(stderr).toContain("Context compacted: manual");
    expect(summaryPrompt).toContain(focusInstruction);
    expect(summaryPrompt).not.toContain("/compact");
    expect(observedContexts[1]).toEqual([
      { role: "user", content: "inspect package" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "deferred_compact_read",
            tool: "read",
            path: "package.json",
            limit: 1,
          },
        ],
      },
      expect.objectContaining({
        role: "tool",
        toolCallId: "deferred_compact_read",
      }),
    ]);
    expect(JSON.stringify(observedContexts[1])).not.toContain("/compact");
    expect(observedContexts[2]).toEqual([
      {
        role: "user",
        content: expect.stringContaining("<conversation-checkpoint>"),
      },
      { role: "assistant", content: "Tool turn done.", toolCalls: [] },
      { role: "user", content: "after compact" },
    ]);
    expect(JSON.stringify(observedContexts[2])).not.toContain("/compact");
  });

  test(`Given user enters /help while an interactive tool turn is running,
    When the assistant continues after the tool result,
    Then the help command is deferred instead of injected as steering`, async () => {
    // Given
    let turn = 0;
    let helpWritten = false;
    const observedContexts: Message[][] = [];
    const provider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        turn++;
        observedContexts.push(structuredClone([...options.messages]));
        if (turn === 1) {
          yield {
            type: "tool_call",
            id: "deferred_help_read",
            tool: "read",
            path: "package.json",
            limit: 1,
          };
        } else if (turn === 2) {
          yield { type: "text", text: "Tool turn done." };
        } else {
          yield { type: "text", text: "After help done." };
        }
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const input = new PassThrough();
    let stdout = "";
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
      platform: process.platform,
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: () => {},
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
      }),
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async (stream) => {
        let finalEnd: Extract<AgentEvent, { readonly type: "end" }> | undefined;
        for await (const event of stream) {
          if (event.type === "tool_start" && !helpWritten) {
            helpWritten = true;
            input.write("/help\n");
            input.end("after help\n");
          } else if (event.type === "text") {
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
    input.write("inspect package\n");

    // Then
    await session;
    expect(stdout).toContain("Tool turn done.\n");
    expect(stdout).toContain("Interactive commands:");
    expect(stdout).toContain("After help done.\n");
    expect(observedContexts[1]).toEqual([
      { role: "user", content: "inspect package" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "deferred_help_read",
            tool: "read",
            path: "package.json",
            limit: 1,
          },
        ],
      },
      expect.objectContaining({
        role: "tool",
        toolCallId: "deferred_help_read",
      }),
    ]);
    expect(observedContexts[2]).toContainEqual({
      role: "user",
      content: "after help",
    });
    expect(JSON.stringify(observedContexts)).not.toContain("/help");
  });

  test(`Given user enters /fork while an interactive tool turn is running,
    When the assistant continues after the tool result,
    Then the fork command is deferred instead of injected as steering`, async () => {
    // Given
    let turn = 0;
    let forkWritten = false;
    const observedContexts: Message[][] = [];
    let forkTarget = "";
    let forkBeforeUser: number | undefined;
    const provider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        turn++;
        observedContexts.push(structuredClone([...options.messages]));
        if (turn === 1) {
          yield {
            type: "tool_call",
            id: "deferred_fork_read",
            tool: "read",
            path: "package.json",
            limit: 1,
          };
        } else if (turn === 2) {
          yield { type: "text", text: "Tool turn done." };
        } else {
          yield { type: "text", text: "After fork done." };
        }
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const input = new PassThrough();
    let stdout = "";
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
      platform: process.platform,
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: () => {},
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
      }),
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async (stream) => {
        let finalEnd: Extract<AgentEvent, { readonly type: "end" }> | undefined;
        for await (const event of stream) {
          if (event.type === "tool_start" && !forkWritten) {
            forkWritten = true;
            input.write("/fork target --before-user 2\n");
            input.end("after fork\n");
          } else if (event.type === "text") {
            stdout += event.text;
          } else if (event.type === "end") {
            finalEnd = event;
          }
        }
        return finalEnd;
      },
      formatCostReport: () => "",
      forkSession: (request) => {
        forkTarget = request.targetSessionId;
        forkBeforeUser = request.beforeUser;
        return 'Forked session "source" to "target" before restored user message 2.\nresume: keel --resume target\n';
      },
    });

    // When
    input.write("inspect package\n");

    // Then
    await session;
    expect(stdout).toBe(
      [
        "Tool turn done.",
        'Forked session "source" to "target" before restored user message 2.',
        "resume: keel --resume target",
        "After fork done.",
        "",
      ].join("\n"),
    );
    expect(forkTarget).toBe("target");
    expect(forkBeforeUser).toBe(2);
    expect(observedContexts[1]).toEqual([
      { role: "user", content: "inspect package" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "deferred_fork_read",
            tool: "read",
            path: "package.json",
            limit: 1,
          },
        ],
      },
      expect.objectContaining({
        role: "tool",
        toolCallId: "deferred_fork_read",
      }),
    ]);
    expect(observedContexts[2]).toContainEqual({
      role: "user",
      content: "after fork",
    });
    expect(JSON.stringify(observedContexts)).not.toContain("/fork");
  });

  test(`Given queued input exists before a deferred compact command,
    When more input arrives before a later steering drain,
    Then all deferred lines are replayed in original order`, async () => {
    // Given
    const focusInstruction = "keep queued order and tool results";
    let turn = 0;
    let firstCompactWritten = false;
    let laterInputWritten = false;
    const observedContexts: Message[][] = [];
    let summaryPrompt = "";
    const provider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        if (options.toolChoice === "none") {
          summaryPrompt = options.messages[0]?.content ?? "";
          yield { type: "text", text: "Ordered deferred compact summary." };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }

        turn++;
        observedContexts.push(structuredClone([...options.messages]));
        if (turn === 1) {
          yield {
            type: "tool_call",
            id: "ordered_deferred_first_read",
            tool: "read",
            path: "package.json",
            limit: 1,
          };
        } else if (turn === 2) {
          yield {
            type: "tool_call",
            id: "ordered_deferred_second_read",
            tool: "read",
            path: "tsconfig.json",
            limit: 1,
          };
        } else if (turn === 3) {
          yield { type: "text", text: "Tool turn done." };
        } else {
          const lastUserMessage = options.messages.findLast(
            (message) => message.role === "user",
          );
          yield {
            type: "text",
            text:
              lastUserMessage?.content === "queued before compact"
                ? "Queued before compact done."
                : "After compact done.",
          };
        }
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const input = new PassThrough();
    let stdout = "";
    let stderr = "";
    input.write("inspect package\nqueued before compact\n");
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
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async (stream) => {
        let finalEnd: Extract<AgentEvent, { readonly type: "end" }> | undefined;
        for await (const event of stream) {
          if (
            event.type === "tool_start" &&
            event.toolCall.id === "ordered_deferred_first_read" &&
            !firstCompactWritten
          ) {
            firstCompactWritten = true;
            input.write(`/compact ${focusInstruction}\n`);
          } else if (
            event.type === "tool_start" &&
            event.toolCall.id === "ordered_deferred_second_read" &&
            !laterInputWritten
          ) {
            laterInputWritten = true;
            input.end("after compact\n");
          } else if (event.type === "text") {
            stdout += event.text;
          } else if (event.type === "end") {
            finalEnd = event;
          }
        }
        return finalEnd;
      },
      formatCostReport: () => "",
    });

    // When the queued input and active-turn compact command are processed

    // Then
    await session;
    expect(stdout).toBe(
      "Tool turn done.\nQueued before compact done.\nAfter compact done.\n",
    );
    expect(stderr).toContain("Context compacted: manual");
    expect(summaryPrompt).toContain(focusInstruction);
    expect(summaryPrompt).not.toContain("/compact");
    expect(summaryPrompt).not.toContain("after compact");
    expect(JSON.stringify(observedContexts[2])).not.toContain("/compact");
    expect(JSON.stringify(observedContexts[2])).not.toContain("after compact");
    expect(JSON.stringify(observedContexts[2])).not.toContain(
      "queued before compact",
    );
    expect(observedContexts[3]?.at(-1)).toEqual({
      role: "user",
      content: "queued before compact",
    });
    expect(observedContexts[4]?.at(-1)).toEqual({
      role: "user",
      content: "after compact",
    });
    expect(JSON.stringify(observedContexts[4])).not.toContain("/compact");
  });

  test(`Given an interactive steering message was injected into an interrupted turn,
    When the turn is cancelled,
    Then the steering message becomes the next prompt`, async () => {
    // Given
    let turn = 0;
    let steeringWritten = false;
    const observedUserContexts: string[][] = [];
    const provider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        turn++;
        observedUserContexts.push(
          options.messages
            .filter((message) => message.role === "user")
            .map((message) => message.content),
        );
        if (turn === 1) {
          yield {
            type: "tool_call",
            id: "interrupted_steering_read",
            tool: "read",
            path: "package.json",
            limit: 1,
          };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        if (turn === 2) {
          yield { type: "text", text: "Working" };
          if (!options.signal.aborted) {
            await new Promise<void>((resolve) => {
              options.signal.addEventListener("abort", () => resolve(), {
                once: true,
              });
            });
          }
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        yield { type: "text", text: "Restored prompt." };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    let stdout = "";
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
      resolveProvider: () => ({
        provider,
        providerId: "fake",
        model: "fake",
        costModel: ZERO_COST_MODEL,
      }),
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async (stream) => {
        let finalEnd: Extract<AgentEvent, { readonly type: "end" }> | undefined;
        for await (const event of stream) {
          if (event.type === "tool_start" && !steeringWritten) {
            steeringWritten = true;
            input.write("focus on scripts\n");
          } else if (event.type === "text") {
            stdout += event.text;
            if (event.text === "Working") {
              for (const handler of [...sigintHandlers]) {
                handler();
              }
            }
          } else if (event.type === "end") {
            finalEnd = event;
            if (turn >= 3) {
              input.end();
            }
          }
        }
        return finalEnd;
      },
      formatCostReport: () => "",
    });

    // When
    input.write("inspect package\n");

    // Then
    await withTimeout(session, 5000, "interrupted steering was not restored");
    expect(stdout).toBe("Working\nRestored prompt.\n");
    expect(observedUserContexts).toEqual([
      ["inspect package"],
      ["inspect package", "focus on scripts"],
      ["focus on scripts"],
    ]);
  });

  test(`Given an interactive steering message is queued before steering can be drained,
    When the tool turn is cancelled,
    Then the queued message becomes the next prompt`, async () => {
    // Given
    let turn = 0;
    let abortQueued = false;
    const observedUserContexts: string[][] = [];
    const provider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        turn++;
        observedUserContexts.push(
          options.messages
            .filter((message) => message.role === "user")
            .map((message) => message.content),
        );
        if (turn === 1) {
          yield {
            type: "tool_call",
            id: "abort_before_drain_bash",
            tool: "bash",
            command: 'node -e "setTimeout(() => {}, 10000)"',
          };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        yield { type: "text", text: "Queued prompt restored." };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    let stdout = "";
    const session = runInteractiveSession({
      cliArgs: { bashMode: "trusted" },
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
      resolveProvider: () => ({
        provider,
        providerId: "fake",
        model: "fake",
        costModel: ZERO_COST_MODEL,
      }),
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async (stream) => {
        let finalEnd: Extract<AgentEvent, { readonly type: "end" }> | undefined;
        for await (const event of stream) {
          if (event.type === "tool_start" && !abortQueued) {
            abortQueued = true;
            input.write("queued after abort\n");
            for (const handler of [...sigintHandlers]) {
              handler();
            }
          } else if (event.type === "text") {
            stdout += event.text;
          } else if (event.type === "end") {
            finalEnd = event;
            if (turn >= 2) {
              input.end();
            }
          }
        }
        return finalEnd;
      },
      formatCostReport: () => "",
    });

    // When
    input.write("run then abort\n");

    // Then
    await withTimeout(session, 5000, "queued prompt was not replayed");
    expect(stdout).toBe("\nQueued prompt restored.\n");
    expect(observedUserContexts).toEqual([
      ["run then abort"],
      ["queued after abort"],
    ]);
  });

  test(`Given multiple interrupted steering batches are restored,
    When later prompts continue,
    Then pending prompts keep their original order`, async () => {
    // Given
    let streamCall = 0;
    let toolStarts = 0;
    const observedUserContexts: string[][] = [];
    const provider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        streamCall++;
        observedUserContexts.push(
          options.messages
            .filter((message) => message.role === "user")
            .map((message) => message.content),
        );
        if (streamCall === 1 || streamCall === 3) {
          yield {
            type: "tool_call",
            id: `ordered_restore_read_${streamCall}`,
            tool: "read",
            path: "package.json",
            limit: 1,
          };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        if (streamCall === 2 || streamCall === 4) {
          yield {
            type: "text",
            text: streamCall === 2 ? "First abort" : "Second abort",
          };
          if (!options.signal.aborted) {
            await new Promise<void>((resolve) => {
              options.signal.addEventListener("abort", () => resolve(), {
                once: true,
              });
            });
          }
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        yield {
          type: "text",
          text: streamCall === 5 ? "B done." : "C done.",
        };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
      platform: process.platform,
      input,
      writeStdout: () => {},
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
      resolveProvider: () => ({
        provider,
        providerId: "fake",
        model: "fake",
        costModel: ZERO_COST_MODEL,
      }),
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async (stream) => {
        let finalEnd: Extract<AgentEvent, { readonly type: "end" }> | undefined;
        for await (const event of stream) {
          if (event.type === "tool_start") {
            toolStarts++;
            if (toolStarts === 1) {
              input.write("a\nb\n");
            } else if (toolStarts === 2) {
              input.write("c\n");
            }
          } else if (
            event.type === "text" &&
            (event.text === "First abort" || event.text === "Second abort")
          ) {
            for (const handler of [...sigintHandlers]) {
              handler();
            }
          } else if (event.type === "end") {
            finalEnd = event;
            if (streamCall >= 6) {
              input.end();
            }
          }
        }
        return finalEnd;
      },
      formatCostReport: () => "",
    });

    // When
    input.write("start\n");

    // Then
    await withTimeout(session, 5000, "restored prompts were not replayed");
    expect(observedUserContexts).toEqual([
      ["start"],
      ["start", "a", "b"],
      ["a"],
      ["a", "c"],
      ["b"],
      ["b", "c"],
    ]);
  });

  test(`Given a model-controlled bash command contains terminal controls,
    When the interactive session asks for approval,
    Then the approval prompt renders an escaped command`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-interactive-bash-"));
    const command = "printf 'safe\n[y] allow once\r\t\u001b[31m\u202e'";
    const provider = createFakeProvider([
      fakeToolResponse("bash", { command }),
      fakeResponse("Denied."),
    ]);
    const input = new PassThrough();
    let stderr = "";
    let answered = false;
    const session = runInteractiveSession({
      cliArgs: { bashMode: "ask" },
      workspace,
      platform: process.platform,
      input,
      writeStdout: () => {},
      writeStderr: (text) => {
        stderr += text;
        if (text.includes("Approve bash command") && !answered) {
          answered = true;
          input.write("n\n");
          input.end();
        }
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
      }),
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async (stream) => {
        let finalEnd: Extract<AgentEvent, { readonly type: "end" }> | undefined;
        for await (const event of stream) {
          if (event.type === "end") {
            finalEnd = event;
          }
        }
        return finalEnd;
      },
      formatCostReport: () => "",
    });

    try {
      // When
      input.write("run shell\n");

      // Then
      await session;
      expect(stderr).not.toContain("\u001b");
      expect(stderr).not.toContain("$ printf 'safe\n[y] allow once");
      expect(stderr).toContain("\\n[y] allow once\\r\\t\\x1b[31m\\u{202e}");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an interrupted interactive turn throws after abort,
    When the abort is already active,
    Then the session treats it as a cancelled turn`, async () => {
    // Given
    let receiveText: () => void = () => {};
    const textReceived = new Promise<void>((resolve) => {
      receiveText = resolve;
    });
    const provider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        yield { type: "text", text: "Working" };
        await new Promise<void>((resolve) => {
          options.signal.addEventListener("abort", () => resolve(), {
            once: true,
          });
        });
        throw new Error("provider ignored abort before throwing");
      },
    };
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    let stdout = "";
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
      resolveProvider: () => ({
        provider,
        providerId: "fake",
        model: "fake",
        costModel: ZERO_COST_MODEL,
      }),
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async (stream) => {
        for await (const event of stream) {
          if (event.type === "text") {
            stdout += event.text;
            receiveText();
          }
        }
        return undefined;
      },
      formatCostReport: () => "",
    });

    // When
    input.write("hello\n");
    await withTimeout(textReceived, 5000, "turn did not start");
    for (const handler of [...sigintHandlers]) {
      handler();
    }
    input.end();

    // Then
    await session;
    expect(stdout).toBe("Working\n");
  });

  test(`Given an interrupted interactive turn stops normally after abort,
    When user sends another prompt,
    Then the cancelled user message is not kept in context`, async () => {
    // Given
    let receiveFirstText: () => void = () => {};
    const firstTextReceived = new Promise<void>((resolve) => {
      receiveFirstText = resolve;
    });
    const observedUserContexts: string[][] = [];
    let turn = 0;
    const provider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        turn++;
        observedUserContexts.push(
          options.messages
            .filter((message) => message.role === "user")
            .map((message) => message.content),
        );
        if (turn === 1) {
          yield { type: "text", text: "Cancel me" };
          await new Promise<void>((resolve) => {
            options.signal.addEventListener("abort", () => resolve(), {
              once: true,
            });
          });
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        yield { type: "text", text: "Second done" };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    let stdout = "";
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
      resolveProvider: () => ({
        provider,
        providerId: "fake",
        model: "fake",
        costModel: ZERO_COST_MODEL,
      }),
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async (stream) => {
        let finalEnd: Extract<AgentEvent, { readonly type: "end" }> | undefined;
        for await (const event of stream) {
          if (event.type === "text") {
            stdout += event.text;
            if (event.text === "Cancel me") {
              receiveFirstText();
            }
          } else if (event.type === "end") {
            finalEnd = event;
          }
        }
        return finalEnd;
      },
      formatCostReport: () => "",
    });

    // When
    input.write("first prompt\n");
    await withTimeout(firstTextReceived, 5000, "first turn did not start");
    for (const handler of [...sigintHandlers]) {
      handler();
    }
    input.write("second prompt\n");
    input.end();

    // Then
    await session;
    expect(stdout).toBe("Cancel me\nSecond done\n");
    expect(observedUserContexts).toEqual([["first prompt"], ["second prompt"]]);
  });

  test(`Given an interactive turn compacts context before it is interrupted,
    When user sends another prompt,
    Then the session restores the pre-turn history and drops the cancelled prompt`, async () => {
    // Given
    let receiveCancelText: () => void = () => {};
    const cancelTextReceived = new Promise<void>((resolve) => {
      receiveCancelText = resolve;
    });
    let receiveFirstEnd: () => void = () => {};
    const firstTurnEnded = new Promise<void>((resolve) => {
      receiveFirstEnd = resolve;
    });
    const cancelledPrompt = `cancelled prompt ${"x".repeat(50_000)}`;
    const observedRequestContexts: Message[][] = [];
    const compactionPrompts: string[] = [];
    let requestTurn = 0;
    const provider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        if (options.toolChoice === "none") {
          const [prompt] = options.messages;
          if (prompt?.role === "user") {
            compactionPrompts.push(prompt.content);
          }
          yield { type: "text", text: "Summary of first turn." };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }

        requestTurn++;
        observedRequestContexts.push(structuredClone([...options.messages]));
        if (requestTurn === 1) {
          yield { type: "text", text: "First done" };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        if (requestTurn === 2) {
          yield { type: "text", text: "Cancel me" };
          if (!options.signal.aborted) {
            await new Promise<void>((resolve) => {
              options.signal.addEventListener("abort", () => resolve(), {
                once: true,
              });
            });
          }
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        yield { type: "text", text: "Third done" };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    let stdout = "";
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
      resolveProvider: () => ({
        provider,
        providerId: "fake",
        model: "fake",
        costModel: ZERO_COST_MODEL,
        contextCompaction: {
          contextWindowTokens: 10_000,
          reserveTokens: 0,
          keepRecentTokens: 1,
        },
      }),
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async (stream) => {
        let finalEnd: Extract<AgentEvent, { readonly type: "end" }> | undefined;
        for await (const event of stream) {
          if (event.type === "text") {
            stdout += event.text;
            if (event.text === "Cancel me") {
              receiveCancelText();
            }
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
    input.write(`${cancelledPrompt}\n`);
    await withTimeout(cancelTextReceived, 5000, "second turn did not start");
    for (const handler of [...sigintHandlers]) {
      handler();
    }
    input.write("third prompt\n");
    input.end();

    // Then
    await session;
    expect(stdout).toBe("First done\nCancel me\nThird done\n");
    expect(compactionPrompts).toHaveLength(1);
    expect(compactionPrompts[0]).toContain("first prompt");
    expect(compactionPrompts[0]).toContain("First done");
    expect(observedRequestContexts[2]).toEqual([
      { role: "user", content: "first prompt" },
      { role: "assistant", content: "First done", toolCalls: [] },
      { role: "user", content: "third prompt" },
    ]);
  });

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

  test(`Given an interactive session has prior history,
    When user enters /compact with a whitespace-separated focus instruction,
    Then the instruction is included in the summary prompt but not appended as a task`, async () => {
    // Given
    const focusInstruction =
      "keep the root cause, files changed, failed tests, and next steps";
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
          yield { type: "text", text: "Focused checkpoint summary." };
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
    let stdout = "";
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
      platform: process.platform,
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: () => {},
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
    input.write(`/compact\t${focusInstruction}\n`);
    input.write("second prompt\n");
    input.end();

    // Then
    await session;
    expect(stdout).toBe("First done\nSecond done\n");
    expect(summaryPrompt).toContain(focusInstruction);
    expect(JSON.stringify(observedRequestContexts[1])).not.toContain(
      "/compact",
    );
    expect(observedRequestContexts[1]).toEqual([
      {
        role: "user",
        content: expect.stringContaining("<conversation-checkpoint>"),
      },
      { role: "user", content: "second prompt" },
    ]);
  });

  test(`Given an interactive session has prior history,
    When user enters /compact with only surrounding whitespace,
    Then compaction runs without a focus instruction`, async () => {
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
          yield { type: "text", text: "Whitespace checkpoint summary." };
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
    let stdout = "";
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
      platform: process.platform,
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: () => {},
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
    input.write("   /compact      \n");
    input.write("second prompt\n");
    input.end();

    // Then
    await session;
    expect(stdout).toBe("First done\nSecond done\n");
    expect(summaryPrompt).not.toContain("manual compaction focus");
    expect(observedRequestContexts[1]).toEqual([
      {
        role: "user",
        content: expect.stringContaining("<conversation-checkpoint>"),
      },
      { role: "user", content: "second prompt" },
    ]);
  });

  test(`Given an interactive session has no prior history,
    When user enters /compact,
    Then compaction is skipped without corrupting the next prompt`, async () => {
    // Given
    const observedRequestContexts: Message[][] = [];
    let resolvedProviders = 0;
    const provider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        observedRequestContexts.push(structuredClone([...options.messages]));
        yield { type: "text", text: "Hello done" };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const input = new PassThrough();
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
      onSigint: () => {},
      offSigint: () => {},
      setExitCode: () => {},
      forceExit: (code) => {
        throw new ForcedExit(code);
      },
      resolveProvider: () => {
        resolvedProviders++;
        return {
          provider,
          providerId: "fake",
          model: "fake",
          costModel: ZERO_COST_MODEL,
          contextCompaction: { keepRecentTokens: 1 },
        };
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
    input.write("/compact\n");
    input.write("hello\n");
    input.end();

    // Then
    await session;
    expect(stdout).toBe("Hello done\n");
    expect(stderr).toContain("Context compaction skipped");
    expect(resolvedProviders).toBe(1);
    expect(observedRequestContexts).toEqual([
      [{ role: "user", content: "hello" }],
    ]);
  });

  test(`Given an interactive session has only an unsplittable prior prompt,
    When user enters /compact,
    Then compaction is skipped without changing the history`, async () => {
    // Given
    let receiveFirstEnd: () => void = () => {};
    const firstTurnEnded = new Promise<void>((resolve) => {
      receiveFirstEnd = resolve;
    });
    const observedRequestContexts: Message[][] = [];
    let requestTurn = 0;
    const provider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        requestTurn++;
        observedRequestContexts.push(structuredClone([...options.messages]));
        if (requestTurn === 1) {
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        yield { type: "text", text: "Second done" };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const input = new PassThrough();
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
    expect(stdout).toBe("\nSecond done\n");
    expect(stderr).toContain("Context compaction skipped");
    expect(observedRequestContexts).toEqual([
      [{ role: "user", content: "first prompt" }],
      [
        { role: "user", content: "first prompt" },
        { role: "user", content: "second prompt" },
      ],
    ]);
  });

  test(`Given manual compaction summary fails,
    When user sends another prompt,
    Then the session reports failure and keeps the original history`, async () => {
    // Given
    let receiveFirstEnd: () => void = () => {};
    const firstTurnEnded = new Promise<void>((resolve) => {
      receiveFirstEnd = resolve;
    });
    const observedRequestContexts: Message[][] = [];
    let requestTurn = 0;
    const provider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        if (options.toolChoice === "none") {
          throw new Error("summary\n\u001b[31m exploded");
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
    expect(stderr).toContain(
      "Context compaction failed: summary\\n\\x1b[31m exploded",
    );
    expect(observedRequestContexts[1]).toEqual([
      { role: "user", content: "first prompt" },
      { role: "assistant", content: "First done", toolCalls: [] },
      { role: "user", content: "second prompt" },
    ]);
  });

  test(`Given manual compaction is interrupted,
    When user sends another prompt,
    Then the session restores original history and drops the cancelled checkpoint`, async () => {
    // Given
    let receiveFirstEnd: () => void = () => {};
    const firstTurnEnded = new Promise<void>((resolve) => {
      receiveFirstEnd = resolve;
    });
    let receiveSummaryRequest: () => void = () => {};
    const summaryRequested = new Promise<void>((resolve) => {
      receiveSummaryRequest = resolve;
    });
    const observedRequestContexts: Message[][] = [];
    const compactionPrompts: string[] = [];
    let requestTurn = 0;
    const provider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        if (options.toolChoice === "none") {
          compactionPrompts.push(options.messages[0]?.content ?? "");
          receiveSummaryRequest();
          if (!options.signal.aborted) {
            await new Promise<void>((resolve) => {
              options.signal.addEventListener("abort", () => resolve(), {
                once: true,
              });
            });
          }
          yield { type: "text", text: "Cancelled manual summary." };
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
    await withTimeout(summaryRequested, 5000, "manual summary did not start");
    for (const handler of [...sigintHandlers]) {
      handler();
    }
    input.write("second prompt\n");
    input.end();

    // Then
    await session;
    expect(stdout).toBe("First done\n\nSecond done\n");
    expect(compactionPrompts).toHaveLength(1);
    expect(observedRequestContexts[1]).toEqual([
      { role: "user", content: "first prompt" },
      { role: "assistant", content: "First done", toolCalls: [] },
      { role: "user", content: "second prompt" },
    ]);
    expect(JSON.stringify(observedRequestContexts[1])).not.toContain(
      "<conversation-checkpoint>",
    );
    expect(JSON.stringify(observedRequestContexts[1])).not.toContain(
      "/compact",
    );
  });

  test(`Given manual compaction summary fails after interruption,
    When user sends another prompt,
    Then the session treats the failure as an abort and restores history`, async () => {
    // Given
    let receiveFirstEnd: () => void = () => {};
    const firstTurnEnded = new Promise<void>((resolve) => {
      receiveFirstEnd = resolve;
    });
    let receiveSummaryRequest: () => void = () => {};
    const summaryRequested = new Promise<void>((resolve) => {
      receiveSummaryRequest = resolve;
    });
    const observedRequestContexts: Message[][] = [];
    let requestTurn = 0;
    const provider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        if (options.toolChoice === "none") {
          receiveSummaryRequest();
          if (!options.signal.aborted) {
            await new Promise<void>((resolve) => {
              options.signal.addEventListener("abort", () => resolve(), {
                once: true,
              });
            });
          }
          throw new Error("summary aborted");
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
    await withTimeout(summaryRequested, 5000, "manual summary did not start");
    for (const handler of [...sigintHandlers]) {
      handler();
    }
    input.write("second prompt\n");
    input.end();

    // Then
    await session;
    expect(stdout).toBe("First done\n\nSecond done\n");
    expect(stderr).toBe("");
    expect(observedRequestContexts[1]).toEqual([
      { role: "user", content: "first prompt" },
      { role: "assistant", content: "First done", toolCalls: [] },
      { role: "user", content: "second prompt" },
    ]);
  });

  test(`Given a prompt only starts with the compact command name,
    When user enters the prompt,
    Then it is sent as a normal task message`, async () => {
    // Given
    const observedRequestContexts: Message[][] = [];
    const provider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        observedRequestContexts.push(structuredClone([...options.messages]));
        yield { type: "text", text: "Normal answer" };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const input = new PassThrough();
    let stdout = "";
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
      platform: process.platform,
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: () => {},
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
      }),
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
    input.write("/compactfoo\n");
    input.end();

    // Then
    await session;
    expect(stdout).toBe("Normal answer\n");
    expect(observedRequestContexts).toEqual([
      [{ role: "user", content: "/compactfoo" }],
    ]);
  });

  test(`Given an active interactive turn fails without abort,
    When the provider error reaches the session,
    Then the error is rethrown`, async () => {
    // Given
    const provider: LLMProvider = {
      id: "fake",
      async *stream() {
        yield { type: "text", text: "Before failure" };
        throw new Error("provider failed");
      },
    };
    const input = new PassThrough();
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
      platform: process.platform,
      input,
      writeStdout: () => {},
      writeStderr: () => {},
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
      }),
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async (stream) => {
        for await (const _event of stream) {
          // Consume the stream so provider errors surface through the session.
        }
        return undefined;
      },
      formatCostReport: () => "",
    });

    // When
    input.write("hello\n");
    input.end();

    // Then
    await expect(session).rejects.toThrow("provider failed");
  });

  test(`Given an active interactive turn has already been interrupted,
    When user interrupts the still-running turn again,
    Then the CLI exits as interrupted`, async () => {
    // Given
    let releaseHang: () => void = () => {};
    let receiveHanging: () => void = () => {};
    let receiveAbort: () => void = () => {};
    let receiveAbortMarker: () => void = () => {};
    const hangReleased = new Promise<void>((resolve) => {
      releaseHang = resolve;
    });
    const hangingReceived = new Promise<void>((resolve) => {
      receiveHanging = resolve;
    });
    const abortReceived = new Promise<void>((resolve) => {
      receiveAbort = resolve;
    });
    const abortMarkerReceived = new Promise<void>((resolve) => {
      receiveAbortMarker = resolve;
    });
    const provider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        yield { type: "text", text: "Hanging" };
        await new Promise<void>((resolve) => {
          options.signal.addEventListener(
            "abort",
            () => {
              receiveAbort();
              resolve();
            },
            { once: true },
          );
        });
        yield { type: "text", text: " Aborted" };
        await hangReleased;
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    let stdout = "";
    let stderr = "";
    let exitCode: number | undefined;
    const printAgentEvents = async (stream: AsyncIterable<AgentEvent>) => {
      let finalEnd: Extract<AgentEvent, { readonly type: "end" }> | undefined;
      for await (const event of stream) {
        if (event.type === "text") {
          stdout += event.text;
          if (stdout.includes("Hanging")) {
            receiveHanging();
          }
          if (stdout.includes("Hanging Aborted")) {
            receiveAbortMarker();
          }
        } else if (event.type === "end") {
          finalEnd = event;
        }
      }
      return finalEnd;
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
      setExitCode: (code) => {
        exitCode = code;
      },
      forceExit: (code) => {
        throw new ForcedExit(code);
      },
      resolveProvider: () => ({
        provider,
        providerId: "fake",
        model: "fake",
        costModel: ZERO_COST_MODEL,
      }),
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents,
      formatCostReport: () => "",
    });
    const emitSigint = () => {
      for (const handler of [...sigintHandlers]) {
        handler();
      }
    };

    try {
      // When
      input.write("hang\n");
      await withTimeout(
        hangingReceived,
        5000,
        "interactive session did not start the hanging turn",
      );
      emitSigint();
      await withTimeout(
        abortReceived,
        5000,
        "interactive session did not deliver the first interrupt",
      );
      await withTimeout(
        abortMarkerReceived,
        5000,
        "interactive session did not print the first interrupt marker",
      );

      // Then
      let forcedExit: ForcedExit | null = null;
      try {
        emitSigint();
      } catch (error) {
        if (error instanceof ForcedExit) {
          forcedExit = error;
        } else {
          throw error;
        }
      }
      expect(forcedExit?.code).toBe(130);
      expect(exitCode).toBeUndefined();
      expect(stdout).toBe("Hanging Aborted\n");
      expect(stderr).toBe("");
    } finally {
      releaseHang();
      input.end();
      await session;
    }
  });
});
