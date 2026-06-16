import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, test } from "vitest";
import type { AgentEvent } from "../../src/agent/loop.ts";
import { runInteractiveSession } from "../../src/cli/interactive-session.ts";
import type { CostModel } from "../../src/core/cost.ts";
import {
  createFakeProvider,
  fakeBashResponse,
  fakeResponse,
} from "../../src/llm/providers/fake.ts";
import type { LLMProvider, Message, Usage } from "../../src/llm/types.ts";

const ZERO_USAGE: Usage = {
  inputTokens: 0,
  cachedInputTokens: 0,
  uncachedInputTokens: 0,
  outputTokens: 0,
};

const ZERO_COST_MODEL: CostModel = {
  uncachedInputPerMillionTokens: 0,
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

  test(`Given an interactive turn has cost tracking,
    When the turn completes,
    Then the session prints the cost report`, async () => {
    // Given
    const provider: LLMProvider = {
      id: "fake",
      async *stream() {
        yield { type: "stop", usage: ZERO_USAGE };
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
        yield { type: "stop", usage: ZERO_USAGE };
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

  test(`Given an interactive session asks for bash permission,
    When the user approves the command for the session,
    Then repeated matching commands run without asking again`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-interactive-bash-"));
    const command =
      "node -e \"require('node:fs').appendFileSync('runs.txt', 'x')\"";
    const provider = createFakeProvider([
      fakeBashResponse(command),
      fakeBashResponse(command),
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

  test(`Given an interactive user approves bash once,
    When the assistant repeats the same command,
    Then the session asks for approval again`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-interactive-bash-"));
    const command =
      "node -e \"require('node:fs').appendFileSync('runs.txt', 'x')\"";
    const provider = createFakeProvider([
      fakeBashResponse(command),
      fakeBashResponse(command),
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
        yield { type: "stop", usage: ZERO_USAGE };
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
      fakeBashResponse(command),
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
      fakeBashResponse(command),
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
        yield { type: "stop", usage: ZERO_USAGE };
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
        yield { type: "stop", usage: ZERO_USAGE };
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

  test(`Given a model-controlled bash command contains terminal controls,
    When the interactive session asks for approval,
    Then the approval prompt renders an escaped command`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-interactive-bash-"));
    const command = "printf 'safe\n[y] allow once\r\t\u001b[31m\u202e'";
    const provider = createFakeProvider([
      fakeBashResponse(command),
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
          yield { type: "stop", usage: ZERO_USAGE };
          return;
        }
        yield { type: "text", text: "Second done" };
        yield { type: "stop", usage: ZERO_USAGE };
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
        yield { type: "stop", usage: ZERO_USAGE };
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
