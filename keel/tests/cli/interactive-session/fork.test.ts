import { PassThrough } from "node:stream";
import { describe, expect, test } from "vitest";
import { runInteractiveSession } from "../../../src/cli/interactive-session.ts";
import type { SessionQueuedInput } from "../../../src/cli/session-store.ts";
import {
  ForcedExit,
  ZERO_COST_MODEL,
} from "../../../src/testing/interactive-session-fixtures.ts";

describe("Interactive Session - Fork", () => {
  test(`Given the interactive session is idle,
    When user enters /fork with a target and fork point,
    Then the fork is created locally without starting a model turn`, async () => {
    // Given
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    let stdout = "";
    let stderr = "";
    let forkTarget = "";
    let forkBeforeMessageId: string | undefined;
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
        forkBeforeMessageId = request.beforeMessageId;
        return 'Forked session "source" to "target" before message msg_beta.\nresume: keel --resume target\n';
      },
    });

    // When
    input.end("/fork target --before-message=msg_beta\n");

    // Then
    await session;
    expect(stdout).toBe(
      'Forked session "source" to "target" before message msg_beta.\nresume: keel --resume target\n',
    );
    expect(stderr).toBe("");
    expect(forkTarget).toBe("target");
    expect(forkBeforeMessageId).toBe("msg_beta");
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
                  {
                    choice: 1,
                    messageId: "msg_alpha",
                    preview: "remember alpha",
                  },
                  {
                    choice: 2,
                    messageId: "msg_beta",
                    preview: "remember beta",
                  },
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
        "1. before message msg_alpha: remember alpha",
        "   use: /fork <new-id> --before-message msg_alpha",
        "2. before message msg_beta: remember beta",
        "   use: /fork <new-id> --before-message msg_beta",
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
    let forkBeforeMessageId: string | undefined;
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
          { choice: 1, messageId: "msg_alpha", preview: "remember alpha" },
          { choice: 2, messageId: "msg_beta", preview: "remember beta" },
        ],
      }),
      forkSession: (request) => {
        forkTarget = request.targetSessionId;
        forkBeforeMessageId = request.beforeMessageId;
        return 'Forked session "source" to "target" before message msg_beta.\nresume: keel --resume target\n';
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
        "1. before message msg_alpha: remember alpha",
        "2. before message msg_beta: remember beta",
        "",
        "Select fork point [0-2], or q to cancel:",
        'Forked session "source" to "target" before message msg_beta.',
        "resume: keel --resume target",
        "",
      ].join("\n"),
    );
    expect(stderr).toBe("");
    expect(forkTarget).toBe("target");
    expect(forkBeforeMessageId).toBe("msg_beta");
    expect(providerResolved).toBe(false);
    expect(sigintHandlers.size).toBe(0);
  });

  test(`Given the interactive session is idle,
    When user picks full restored history,
    Then the fork is created without a before-message fork point`, async () => {
    // Given
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    let stdout = "";
    let stderr = "";
    let forkBeforeMessageId: string | undefined = "msg_alpha";
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
        points: [
          { choice: 1, messageId: "msg_alpha", preview: "remember alpha" },
        ],
      }),
      forkSession: (request) => {
        forkBeforeMessageId = request.beforeMessageId;
        return 'Forked session "source" to "target".\nresume: keel --resume target\n';
      },
    });

    // When
    input.end("/fork target --pick\n0\n");

    // Then
    await session;
    expect(stdout).toContain('Forked session "source" to "target".\n');
    expect(stderr).toBe("");
    expect(forkBeforeMessageId).toBeUndefined();
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
        points: [
          { choice: 1, messageId: "msg_alpha", preview: "remember alpha" },
        ],
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
        "1. before message msg_alpha: remember alpha",
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
        points: [
          { choice: 1, messageId: "msg_alpha", preview: "remember alpha" },
        ],
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
        "1. before message msg_alpha: remember alpha",
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
    let forkBeforeMessageId: string | undefined;
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
          { choice: 1, messageId: "msg_alpha", preview: "remember alpha" },
          { choice: 2, messageId: "msg_beta", preview: "remember beta" },
        ],
      }),
      forkSession: (request) => {
        forkBeforeMessageId = request.beforeMessageId;
        return 'Forked session "source" to "target" before message msg_beta.\nresume: keel --resume target\n';
      },
    });

    // When
    input.end();

    // Then
    await session;
    expect(stdout).toContain(
      'Forked session "source" to "target" before message msg_beta.\n',
    );
    expect(stderr).toBe("");
    expect(forkBeforeMessageId).toBe("msg_beta");
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
        points: [
          { choice: 1, messageId: "msg_alpha", preview: "remember alpha" },
        ],
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
        "1. before message msg_alpha: remember alpha",
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
        "/fork --before-message msg_alpha",
        "/fork target --before-message",
        "/fork target --before-message=",
        "/fork target --pick --before-message msg_alpha",
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
        "Error: --before-message requires a value.",
        "Error: --before-message requires a value.",
        "Error: --pick cannot be combined with --before-message.",
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
});
