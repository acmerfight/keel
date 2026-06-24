import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { AgentEvent } from "../../src/agent/loop.ts";
import { runAgent } from "../../src/agent/loop.ts";
import { defaultStopPolicy } from "../../src/agent/stop-policy.ts";
import {
  createFakeProvider,
  fakeResponse,
  fakeToolResponse,
} from "../../src/llm/providers/fake.ts";
import type { LLMProvider, Message, Usage } from "../../src/llm/types.ts";
import { createSessionBashPermissionPolicy } from "../../src/permissions/bash.ts";

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

const ZERO_USAGE: Usage = {
  inputTokens: 0,
  cachedInputTokens: 0,
  uncachedInputTokens: 0,
  outputTokens: 0,
};

describe("Bash Commands", () => {
  test(`Given shell commands are not allowed,
    When the assistant tries to run a command,
    Then the command is rejected without changing the workspace`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-agent-bash-"));
    let secondTurnMessages: readonly Message[] = [];
    const provider: LLMProvider = {
      id: "disabled-bash",
      async *stream(options) {
        if (secondTurnMessages.length === 0 && options.messages.length > 1) {
          secondTurnMessages = options.messages;
        }
        if (options.messages.length === 1) {
          yield {
            type: "tool_call",
            id: "write_file",
            tool: "bash",
            command:
              "node -e \"require('node:fs').writeFileSync('created.txt', 'changed')\"",
          };
        } else {
          yield { type: "text", text: "I cannot run shell commands." };
        }
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };

    try {
      // When
      const events = await collect(
        runAgent({
          workspace,
          provider,
          userMessage: "create a file",
          systemPrompt: "You are helpful.",
          signal: freshSignal(),
          allowBash: false,
          stopPolicy: defaultStopPolicy(),
        }),
      );

      // Then
      expect(existsSync(join(workspace, "created.txt"))).toBe(false);
      expect(events).toContainEqual({
        type: "text",
        text: "I cannot run shell commands.",
      });
      expect(secondTurnMessages).toContainEqual({
        role: "tool",
        toolCallId: "write_file",
        content:
          "Tool failed: bash failed: shell commands are disabled. Re-run with --bash-policy ask, --bash-policy trusted, or --allow-bash to enable them.",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given shell commands are allowed,
    When the assistant runs a workspace command before replying,
    Then the command result is sent back and the workspace is updated`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-agent-bash-"));
    let secondTurnMessages: readonly Message[] = [];
    const provider: LLMProvider = {
      id: "enabled-bash",
      async *stream(options) {
        if (options.messages.length === 1) {
          yield {
            type: "tool_call",
            id: "write_file",
            tool: "bash",
            command:
              "node -e \"require('node:fs').writeFileSync('created.txt', 'changed')\"",
          };
        } else {
          secondTurnMessages = options.messages;
          yield { type: "text", text: "Created the file." };
        }
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };

    try {
      // When
      const events = await collect(
        runAgent({
          workspace,
          provider,
          userMessage: "create a file",
          systemPrompt: "You are helpful.",
          signal: freshSignal(),
          allowBash: true,
          stopPolicy: defaultStopPolicy(),
        }),
      );

      // Then
      expect(await readFile(join(workspace, "created.txt"), "utf8")).toBe(
        "changed",
      );
      expect(events).toContainEqual({
        type: "text",
        text: "Created the file.",
      });
      expect(secondTurnMessages).toContainEqual({
        role: "tool",
        toolCallId: "write_file",
        content: expect.stringContaining("Exit code: 0"),
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an allowed shell command exits with failure,
    When the assistant runs it before replying,
    Then the failure output is sent back for recovery`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-agent-bash-"));
    let secondTurnMessages: readonly Message[] = [];
    const provider: LLMProvider = {
      id: "failed-bash",
      async *stream(options) {
        if (options.messages.length === 1) {
          yield {
            type: "tool_call",
            id: "failed_command",
            tool: "bash",
            command: `node -e "console.error('missing dependency'); process.exit(3)"`,
          };
        } else {
          secondTurnMessages = options.messages;
          yield { type: "text", text: "The command failed." };
        }
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };

    try {
      // When
      const events = await collect(
        runAgent({
          workspace,
          provider,
          userMessage: "run the check",
          systemPrompt: "You are helpful.",
          signal: freshSignal(),
          allowBash: true,
          stopPolicy: defaultStopPolicy(),
        }),
      );

      // Then
      expect(events).toContainEqual({
        type: "text",
        text: "The command failed.",
      });
      expect(secondTurnMessages).toContainEqual({
        role: "tool",
        toolCallId: "failed_command",
        content: expect.stringContaining("Exit code: 3"),
      });
      expect(secondTurnMessages).toContainEqual({
        role: "tool",
        toolCallId: "failed_command",
        content: expect.stringContaining("missing dependency"),
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an allowed shell command has a custom timeout,
    When the assistant runs it before replying,
    Then the timeout is applied and the timed-out result is sent back`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-agent-bash-"));
    let secondTurnMessages: readonly Message[] = [];
    const provider: LLMProvider = {
      id: "timed-bash",
      async *stream(options) {
        if (options.messages.length === 1) {
          yield {
            type: "tool_call",
            id: "slow_command",
            tool: "bash",
            command: `node -e "setTimeout(() => {}, 1000)"`,
            timeoutMs: 25,
          };
        } else {
          secondTurnMessages = options.messages;
          yield { type: "text", text: "The command timed out." };
        }
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };

    try {
      // When
      const events = await collect(
        runAgent({
          workspace,
          provider,
          userMessage: "run the slow check",
          systemPrompt: "You are helpful.",
          signal: freshSignal(),
          allowBash: true,
          stopPolicy: defaultStopPolicy(),
        }),
      );

      // Then
      expect(events).toContainEqual({
        type: "text",
        text: "The command timed out.",
      });
      expect(secondTurnMessages).toContainEqual({
        role: "tool",
        toolCallId: "slow_command",
        content: expect.stringContaining("Command timed out after 25ms"),
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an allowed shell command has an invalid timeout,
    When the assistant tries to run it,
    Then the registry guard reports the malformed timeout field`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-agent-bash-"));
    const provider: LLMProvider = {
      id: "domain-invalid-bash",
      async *stream() {
        yield {
          type: "tool_call",
          id: "invalid_timeout",
          tool: "bash",
          command: 'node -e ""',
          timeoutMs: 0,
        };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };

    try {
      // When / Then
      await expect(
        collect(
          runAgent({
            workspace,
            provider,
            userMessage: "run with an invalid timeout",
            systemPrompt: "You are helpful.",
            signal: freshSignal(),
            allowBash: true,
            stopPolicy: defaultStopPolicy(),
          }),
        ),
      ).rejects.toThrow(
        /Invalid builtin tool call for bash: timeoutMs: Too small/,
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the first shell command is empty,
    When the agent reports the failure and receives a valid command,
    Then it runs the corrected command`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-agent-bash-"));
    const provider = createFakeProvider([
      fakeToolResponse("bash", { command: "" }),
      fakeToolResponse("bash", {
        command:
          "node -e \"require('node:fs').writeFileSync('created.txt', 'changed')\"",
      }),
      fakeResponse("Created the file."),
    ]);

    try {
      // When
      const events = await collect(
        runAgent({
          workspace,
          provider,
          userMessage: "create a file",
          systemPrompt: "You are helpful.",
          signal: freshSignal(),
          allowBash: true,
          stopPolicy: defaultStopPolicy(),
        }),
      );

      // Then
      expect(await readFile(join(workspace, "created.txt"), "utf8")).toBe(
        "changed",
      );
      expect(events).toContainEqual({
        type: "text",
        text: "Created the file.",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given shell commands require permission,
    When the policy denies the command,
    Then the command is rejected before it changes the workspace`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-agent-bash-"));
    const command =
      "node -e \"require('node:fs').writeFileSync('created.txt', 'changed')\"";
    const provider = createFakeProvider([
      fakeToolResponse("bash", { command }),
      fakeResponse("I will avoid the shell."),
    ]);
    let reviewedCommand = "";

    try {
      // When
      const events = await collect(
        runAgent({
          workspace,
          provider,
          userMessage: "create a file",
          systemPrompt: "You are helpful.",
          signal: freshSignal(),
          allowBash: true,
          stopPolicy: defaultStopPolicy(),
          bashPermission: {
            review: (request) => {
              reviewedCommand = request.command;
              return {
                type: "deny",
                message: "User denied this command.",
              };
            },
          },
        }),
      );

      // Then
      expect(reviewedCommand).toBe(command);
      expect(existsSync(join(workspace, "created.txt"))).toBe(false);
      expect(events).toContainEqual({
        type: "text",
        text: "I will avoid the shell.",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a shell command is approved once,
    When the assistant repeats the same command,
    Then the repeated command asks for permission again`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-agent-bash-"));
    const command =
      "node -e \"require('node:fs').appendFileSync('runs.txt', 'x')\"";
    const provider = createFakeProvider([
      fakeToolResponse("bash", { command }),
      fakeToolResponse("bash", { command }),
      fakeResponse("Ran twice."),
    ]);
    let promptCount = 0;
    const bashPermission = createSessionBashPermissionPolicy({
      prompt: () => {
        promptCount++;
        return { type: "allow", scope: "once" };
      },
    });

    try {
      // When
      await collect(
        runAgent({
          workspace,
          provider,
          userMessage: "run the command twice",
          systemPrompt: "You are helpful.",
          signal: freshSignal(),
          allowBash: true,
          stopPolicy: defaultStopPolicy(),
          bashPermission,
        }),
      );

      // Then
      expect(promptCount).toBe(2);
      expect(await readFile(join(workspace, "runs.txt"), "utf8")).toBe("xx");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a shell command is approved for the session,
    When the assistant repeats the same command in the same workspace,
    Then the repeated command runs without asking again`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-agent-bash-"));
    const command =
      "node -e \"require('node:fs').appendFileSync('runs.txt', 'x')\"";
    const provider = createFakeProvider([
      fakeToolResponse("bash", { command }),
      fakeToolResponse("bash", { command }),
      fakeResponse("Ran twice."),
    ]);
    let promptCount = 0;
    const bashPermission = createSessionBashPermissionPolicy({
      prompt: (request) => {
        promptCount++;
        expect(request.command).toBe(command);
        return { type: "allow", scope: "session" };
      },
    });

    try {
      // When
      const events = await collect(
        runAgent({
          workspace,
          provider,
          userMessage: "run the command twice",
          systemPrompt: "You are helpful.",
          signal: freshSignal(),
          allowBash: true,
          stopPolicy: defaultStopPolicy(),
          bashPermission,
        }),
      );

      // Then
      expect(promptCount).toBe(1);
      expect(await readFile(join(workspace, "runs.txt"), "utf8")).toBe("xx");
      expect(events).toContainEqual({
        type: "text",
        text: "Ran twice.",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a shell command family is approved for the session,
    When the assistant runs matching commands in the same workspace,
    Then the later matching command runs without asking again`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-agent-bash-"));
    const firstCommand = "git status --short";
    const secondCommand = "git status --porcelain";
    const provider = createFakeProvider([
      fakeToolResponse("bash", { command: firstCommand }),
      fakeToolResponse("bash", { command: secondCommand }),
      fakeResponse("Checked status twice."),
    ]);
    let promptCount = 0;
    const offeredFamilies: string[] = [];
    const bashPermission = createSessionBashPermissionPolicy({
      prompt: (request) => {
        promptCount++;
        if (request.prefixApproval !== undefined) {
          offeredFamilies.push(request.prefixApproval.display);
        }
        return { type: "allow", scope: "session-prefix" };
      },
    });

    try {
      execFileSync("git", ["init", "--quiet"], { cwd: workspace });

      // When
      const events = await collect(
        runAgent({
          workspace,
          provider,
          userMessage: "check git status twice",
          systemPrompt: "You are helpful.",
          signal: freshSignal(),
          allowBash: true,
          stopPolicy: defaultStopPolicy(),
          bashPermission,
        }),
      );

      // Then
      expect(promptCount).toBe(1);
      expect(offeredFamilies).toEqual(["git status"]);
      expect(events).toContainEqual({
        type: "text",
        text: "Checked status twice.",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a shell command family is approved for the session,
    When the assistant runs a matching command in another workspace,
    Then the other workspace asks for permission again`, async () => {
    // Given
    const firstWorkspace = await mkdtemp(join(tmpdir(), "keel-agent-bash-"));
    const secondWorkspace = await mkdtemp(join(tmpdir(), "keel-agent-bash-"));
    let promptCount = 0;
    const bashPermission = createSessionBashPermissionPolicy({
      prompt: () => {
        promptCount++;
        return { type: "allow", scope: "session-prefix" };
      },
    });

    try {
      execFileSync("git", ["init", "--quiet"], { cwd: firstWorkspace });
      execFileSync("git", ["init", "--quiet"], { cwd: secondWorkspace });

      // When
      await collect(
        runAgent({
          workspace: firstWorkspace,
          provider: createFakeProvider([
            fakeToolResponse("bash", { command: "git status --short" }),
            fakeResponse("Checked first status."),
          ]),
          userMessage: "check git status",
          systemPrompt: "You are helpful.",
          signal: freshSignal(),
          allowBash: true,
          stopPolicy: defaultStopPolicy(),
          bashPermission,
        }),
      );
      await collect(
        runAgent({
          workspace: secondWorkspace,
          provider: createFakeProvider([
            fakeToolResponse("bash", { command: "git status --porcelain" }),
            fakeResponse("Checked second status."),
          ]),
          userMessage: "check git status",
          systemPrompt: "You are helpful.",
          signal: freshSignal(),
          allowBash: true,
          stopPolicy: defaultStopPolicy(),
          bashPermission,
        }),
      );

      // Then
      expect(promptCount).toBe(2);
    } finally {
      await rm(firstWorkspace, { recursive: true, force: true });
      await rm(secondWorkspace, { recursive: true, force: true });
    }
  });

  test(`Given a shell command family approval is unavailable,
    When a prompt incorrectly approves a command family,
    Then the command is denied instead of cached broadly`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-agent-bash-"));
    let offeredFamily = false;
    const bashPermission = createSessionBashPermissionPolicy({
      prompt: (request) => {
        offeredFamily = request.prefixApproval !== undefined;
        return { type: "allow", scope: "session-prefix" };
      },
    });

    try {
      // When
      const decision = await bashPermission.review({
        command: "git status --short && git diff",
        cwd: workspace,
        signal: freshSignal(),
      });

      // Then
      expect(offeredFamily).toBe(false);
      expect(decision).toEqual({
        type: "deny",
        message: "No command family approval is available.",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given git diff can read absolute paths outside the workspace,
    When a prompt incorrectly approves it as a command family,
    Then the command is denied without offering a family`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-agent-bash-"));
    const outsideSecret = join(tmpdir(), "keel-outside-secret.txt");
    const outsideEmpty = join(tmpdir(), "keel-outside-empty.txt");
    let offeredFamily = false;
    const bashPermission = createSessionBashPermissionPolicy({
      prompt: (request) => {
        offeredFamily = request.prefixApproval !== undefined;
        return { type: "allow", scope: "session-prefix" };
      },
    });

    try {
      // When
      const decision = await bashPermission.review({
        command: `git diff --no-index ${outsideSecret} ${outsideEmpty}`,
        cwd: workspace,
        signal: freshSignal(),
      });

      // Then
      expect(offeredFamily).toBe(false);
      expect(decision).toEqual({
        type: "deny",
        message: "No command family approval is available.",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a simple shell command has no approved command family,
    When a prompt incorrectly approves a command family,
    Then the command is denied without offering a family`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-agent-bash-"));
    let offeredFamily = false;
    const bashPermission = createSessionBashPermissionPolicy({
      prompt: (request) => {
        offeredFamily = request.prefixApproval !== undefined;
        return { type: "allow", scope: "session-prefix" };
      },
    });

    try {
      // When
      const decision = await bashPermission.review({
        command: "echo hello",
        cwd: workspace,
        signal: freshSignal(),
      });

      // Then
      expect(offeredFamily).toBe(false);
      expect(decision).toEqual({
        type: "deny",
        message: "No command family approval is available.",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an empty shell command has no approved command family,
    When a prompt incorrectly approves a command family,
    Then the command is denied without offering a family`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-agent-bash-"));
    let offeredFamily = false;
    const bashPermission = createSessionBashPermissionPolicy({
      prompt: (request) => {
        offeredFamily = request.prefixApproval !== undefined;
        return { type: "allow", scope: "session-prefix" };
      },
    });

    try {
      // When
      const decision = await bashPermission.review({
        command: "  ",
        cwd: workspace,
        signal: freshSignal(),
      });

      // Then
      expect(offeredFamily).toBe(false);
      expect(decision).toEqual({
        type: "deny",
        message: "No command family approval is available.",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
