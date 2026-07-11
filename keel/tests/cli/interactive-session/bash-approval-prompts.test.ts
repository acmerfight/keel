import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { PassThrough } from "node:stream";
import { describe, expect, test } from "vitest";
import type { AgentEvent } from "../../../src/agent/events.ts";
import { createPromptedBashPermissionPolicy } from "../../../src/cli/interactive-session/bash-approval.ts";
import { createLineReader } from "../../../src/cli/interactive-session/line-reader.ts";
import { runInteractiveSession } from "../../../src/cli/interactive-session.ts";
import {
  createFakeProvider,
  fakeResponse,
  fakeToolResponse,
} from "../../../src/llm/providers/fake.ts";
import type { LLMProvider, Message } from "../../../src/llm/types.ts";
import {
  ForcedExit,
  withTimeout,
  ZERO_COST_MODEL,
  ZERO_USAGE,
} from "../../../src/testing/interactive-session-fixtures.ts";

describe("Interactive Session - Bash Approval Prompts", () => {
  test(`Given a prompted bash policy has no project persistence callback,
    When the user approves a command family for the project,
    Then the policy allows the command without requiring a callback`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-interactive-bash-"));
    const input = new PassThrough();
    const promptInput = createInterface({
      input,
      crlfDelay: Number.POSITIVE_INFINITY,
    });
    const lineReader = createLineReader(promptInput, {});
    let stderr = "";
    const promptLifecycle: string[] = [];
    const policy = createPromptedBashPermissionPolicy(
      lineReader,
      (text) => {
        stderr += text;
        if (text.includes("Approve bash command?")) {
          input.end("r\n");
        }
      },
      {
        scopeLabel: "session",
        projectRoot: workspace,
        onPromptStart: () => {
          promptLifecycle.push("approval");
        },
        onPromptEnd: () => {
          promptLifecycle.push("steer");
        },
      },
    );

    try {
      // When
      const decision = await policy.review({
        command: "git status --short",
        cwd: workspace,
        signal: new AbortController().signal,
      });

      // Then
      expect(decision).toEqual({ type: "allow", scope: "project-prefix" });
      expect(stderr).toContain(
        "[r] allow command family for this project: git status",
      );
      expect(promptLifecycle).toEqual(["approval", "steer"]);
    } finally {
      promptInput.close();
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
});
