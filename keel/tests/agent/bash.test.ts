import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { AgentEvent } from "../../src/agent/events.ts";
import { runAgent } from "../../src/agent/loop.ts";
import { defaultStopPolicy } from "../../src/agent/stop-policy.ts";
import {
  createFakeProvider,
  fakeResponse,
  fakeToolResponse,
} from "../../src/llm/providers/fake.ts";
import type { LLMProvider, Message, Usage } from "../../src/llm/types.ts";
import {
  type BashApprovalGrant,
  createSessionBashPermissionPolicy,
} from "../../src/permissions/bash.ts";

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
      expect(events).toContainEqual({
        type: "tool_end",
        toolCall: {
          id: "failed_command",
          tool: "bash",
          command: `node -e "console.error('missing dependency'); process.exit(3)"`,
        },
        ok: true,
        bashExitCode: 3,
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
    Then the agent reports the malformed timeout field and continues`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-agent-bash-"));
    let turn = 0;
    let toolFeedback = "";
    const provider: LLMProvider = {
      id: "domain-invalid-bash",
      async *stream(options) {
        turn++;
        if (turn > 1) {
          toolFeedback =
            options.messages.findLast((message) => message.role === "tool")
              ?.content ?? "";
          yield { type: "text", text: "The timeout was invalid." };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
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
      // When
      const events = await collect(
        runAgent({
          workspace,
          provider,
          userMessage: "run with an invalid timeout",
          systemPrompt: "You are helpful.",
          signal: freshSignal(),
          allowBash: true,
          stopPolicy: defaultStopPolicy(),
        }),
      );

      // Then
      expect(events).toContainEqual({
        type: "tool_end",
        toolCall: {
          id: "invalid_timeout",
          tool: "bash",
          command: 'node -e ""',
          timeoutMs: 0,
        },
        ok: false,
      });
      expect(toolFeedback).toContain("Tool failed:");
      expect(toolFeedback).toContain("timeoutMs");
      expect(toolFeedback).toContain("Recovery:");
      expect(events).toContainEqual({
        type: "text",
        text: "The timeout was invalid.",
      });
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

  test(`Given duplicate initial session approvals,
    When the matching command is reviewed,
    Then the policy deduplicates grants and allows the command without prompting`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-agent-bash-"));
    const command = "pnpm test";
    const grant = {
      type: "exact",
      cwd: workspace,
      command,
    } satisfies BashApprovalGrant;
    let promptCount = 0;
    const bashPermission = createSessionBashPermissionPolicy({
      initialGrants: [grant, grant],
      prompt: () => {
        promptCount++;
        return { type: "deny", message: "should already be approved" };
      },
    });

    try {
      // When
      const decision = await bashPermission.review({
        command,
        cwd: workspace,
        signal: freshSignal(),
      });

      // Then
      expect(decision).toEqual({ type: "allow", scope: "session" });
      expect(bashPermission.grants()).toEqual([grant]);
      expect(promptCount).toBe(0);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given identical exact command approvals resolve concurrently,
    When both prompts approve the command for the session,
    Then the policy records one active grant and emits one grant notification`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-agent-bash-"));
    const command = "pnpm test";
    const decisions: Array<
      (decision: { readonly type: "allow"; readonly scope: "session" }) => void
    > = [];
    const granted: BashApprovalGrant[] = [];
    const bashPermission = createSessionBashPermissionPolicy({
      prompt: () =>
        new Promise((resolve) => {
          decisions.push(resolve);
        }),
      onGrant: (grant) => {
        granted.push(grant);
      },
    });

    try {
      // When
      const first = bashPermission.review({
        command,
        cwd: workspace,
        signal: freshSignal(),
      });
      const second = bashPermission.review({
        command,
        cwd: workspace,
        signal: freshSignal(),
      });
      for (const resolve of decisions) {
        resolve({ type: "allow", scope: "session" });
      }
      await Promise.all([first, second]);

      // Then
      const grant = {
        type: "exact",
        cwd: workspace,
        command,
      } satisfies BashApprovalGrant;
      expect(granted).toEqual([grant]);
      expect(bashPermission.grants()).toEqual([grant]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given identical command-family approvals resolve concurrently,
    When both prompts approve the family for the session,
    Then the policy records one active family grant and emits one grant notification`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-agent-bash-"));
    const command = "git status --short";
    const decisions: Array<
      (decision: {
        readonly type: "allow";
        readonly scope: "session-prefix";
      }) => void
    > = [];
    const granted: BashApprovalGrant[] = [];
    const bashPermission = createSessionBashPermissionPolicy({
      prompt: () =>
        new Promise((resolve) => {
          decisions.push(resolve);
        }),
      onGrant: (grant) => {
        granted.push(grant);
      },
    });

    try {
      // When
      const first = bashPermission.review({
        command,
        cwd: workspace,
        signal: freshSignal(),
      });
      const second = bashPermission.review({
        command,
        cwd: workspace,
        signal: freshSignal(),
      });
      for (const resolve of decisions) {
        resolve({ type: "allow", scope: "session-prefix" });
      }
      await Promise.all([first, second]);

      // Then
      const grant = {
        type: "prefix",
        cwd: workspace,
        argvPrefix: ["git", "status"],
      } satisfies BashApprovalGrant;
      expect(granted).toEqual([grant]);
      expect(bashPermission.grants()).toEqual([grant]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given exact and family approvals are active,
    When the family approval is revoked and an unknown approval is revoked,
    Then only the matching family is removed from later decisions`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-agent-bash-"));
    const exactGrant = {
      type: "exact",
      cwd: workspace,
      command: "pnpm test",
    } satisfies BashApprovalGrant;
    const familyGrant = {
      type: "prefix",
      cwd: workspace,
      argvPrefix: ["git", "status"],
    } satisfies BashApprovalGrant;
    let promptCount = 0;
    const bashPermission = createSessionBashPermissionPolicy({
      initialGrants: [exactGrant, familyGrant],
      prompt: () => {
        promptCount++;
        return { type: "deny", message: "family revoked" };
      },
    });

    try {
      // When
      const missingRevoked = bashPermission.revokeGrant({
        type: "exact",
        cwd: workspace,
        command: "pnpm build",
      });
      const familyRevoked = bashPermission.revokeGrant(familyGrant);
      const exactDecision = await bashPermission.review({
        command: "pnpm test",
        cwd: workspace,
        signal: freshSignal(),
      });
      const familyDecision = await bashPermission.review({
        command: "git status --short",
        cwd: workspace,
        signal: freshSignal(),
      });

      // Then
      expect(missingRevoked).toBe(false);
      expect(familyRevoked).toBe(true);
      expect(exactDecision).toEqual({ type: "allow", scope: "session" });
      expect(familyDecision).toEqual({
        type: "deny",
        message: "family revoked",
      });
      expect(promptCount).toBe(1);
      expect(bashPermission.grants()).toEqual([exactGrant]);
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
      execFileSync("git", ["init", "--quiet", "--initial-branch=main"], {
        cwd: workspace,
      });

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

  test(`Given a project verification command requests bash approval,
    When the approval prompt is prepared,
    Then it describes verification risk and offers only that command family`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-agent-bash-"));
    const seenRisks: string[] = [];
    const offeredFamilies: string[] = [];
    const bashPermission = createSessionBashPermissionPolicy({
      prompt: (request) => {
        seenRisks.push(request.assessment.risk);
        if (request.prefixApproval !== undefined) {
          offeredFamilies.push(request.prefixApproval.display);
        }
        return { type: "deny", message: "checked metadata only" };
      },
    });

    try {
      // When
      await bashPermission.review({
        command: "pnpm typecheck",
        cwd: workspace,
        signal: freshSignal(),
      });

      // Then
      expect(seenRisks).toEqual(["project-verification"]);
      expect(offeredFamilies).toEqual(["pnpm typecheck"]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a workspace-writing command requests bash approval,
    When the approval prompt is prepared,
    Then it describes write risk without offering a command family`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-agent-bash-"));
    const seenRisks: string[] = [];
    let offeredFamily = false;
    const bashPermission = createSessionBashPermissionPolicy({
      prompt: (request) => {
        seenRisks.push(request.assessment.risk);
        offeredFamily = request.prefixApproval !== undefined;
        return { type: "deny", message: "checked metadata only" };
      },
    });

    try {
      // When
      await bashPermission.review({
        command: "pnpm lint:fix",
        cwd: workspace,
        signal: freshSignal(),
      });

      // Then
      expect(seenRisks).toEqual(["workspace-write"]);
      expect(offeredFamily).toBe(false);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a project verification family is approved for the session,
    When a later matching command adds a mutating flag,
    Then the later command asks again without offering that family`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-agent-bash-"));
    const promptedRequests: {
      readonly command: string;
      readonly risk: string;
      readonly family: string | null;
    }[] = [];
    let promptCount = 0;
    const bashPermission = createSessionBashPermissionPolicy({
      prompt: (request) => {
        promptCount++;
        promptedRequests.push({
          command: request.command,
          risk: request.assessment.risk,
          family: request.prefixApproval?.display ?? null,
        });
        if (promptCount === 1) {
          return { type: "allow", scope: "session-prefix" };
        }
        return { type: "deny", message: "do not write" };
      },
    });

    try {
      // When
      await bashPermission.review({
        command: "pnpm lint",
        cwd: workspace,
        signal: freshSignal(),
      });
      await bashPermission.review({
        command: "pnpm lint -- --write",
        cwd: workspace,
        signal: freshSignal(),
      });

      // Then
      expect(promptedRequests).toEqual([
        {
          command: "pnpm lint",
          risk: "project-verification",
          family: "pnpm lint",
        },
        {
          command: "pnpm lint -- --write",
          risk: "workspace-write",
          family: null,
        },
      ]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given project verification commands include mutating flag forms,
    When approval prompts are prepared,
    Then each command is described as workspace-writing without a family`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-agent-bash-"));
    const promptedRequests: {
      readonly command: string;
      readonly risk: string;
      readonly family: string | null;
    }[] = [];
    const bashPermission = createSessionBashPermissionPolicy({
      prompt: (request) => {
        promptedRequests.push({
          command: request.command,
          risk: request.assessment.risk,
          family: request.prefixApproval?.display ?? null,
        });
        return { type: "deny", message: "do not write" };
      },
    });

    try {
      // When
      for (const command of [
        "pnpm lint -- --write=true",
        "pnpm lint -- --fix=unsafe",
        "pnpm test -- -uw",
      ]) {
        await bashPermission.review({
          command,
          cwd: workspace,
          signal: freshSignal(),
        });
      }

      // Then
      expect(promptedRequests).toEqual([
        {
          command: "pnpm lint -- --write=true",
          risk: "workspace-write",
          family: null,
        },
        {
          command: "pnpm lint -- --fix=unsafe",
          risk: "workspace-write",
          family: null,
        },
        {
          command: "pnpm test -- -uw",
          risk: "workspace-write",
          family: null,
        },
      ]);
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
      execFileSync("git", ["init", "--quiet", "--initial-branch=main"], {
        cwd: firstWorkspace,
      });
      execFileSync("git", ["init", "--quiet", "--initial-branch=main"], {
        cwd: secondWorkspace,
      });

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

  test(`Given a command family is approved for a project,
    When a matching command runs from another cwd in that project,
    Then the project approval is reused without prompting`, async () => {
    // Given
    const projectRoot = await mkdtemp(join(tmpdir(), "keel-agent-bash-"));
    const nestedWorkspace = join(projectRoot, "packages", "app");
    await mkdir(nestedWorkspace, { recursive: true });
    let promptCount = 0;
    const bashPermission = createSessionBashPermissionPolicy({
      projectRoot,
      initialProjectGrants: [
        {
          projectRoot,
          cwd: projectRoot,
          argvPrefix: ["git", "status"],
        },
      ],
      prompt: () => {
        promptCount++;
        return { type: "deny", message: "should not prompt" };
      },
    });

    try {
      // When
      const decision = await bashPermission.review({
        command: "git status --porcelain",
        cwd: nestedWorkspace,
        signal: freshSignal(),
      });

      // Then
      expect(decision).toEqual({ type: "allow", scope: "project-prefix" });
      expect(promptCount).toBe(0);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  test(`Given project command approval is unavailable,
    When a prompt incorrectly approves a project command family,
    Then the command is denied instead of cached for the project`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-agent-bash-"));
    let offeredPrefix = false;
    let offeredProjectApproval = false;
    const bashPermission = createSessionBashPermissionPolicy({
      prompt: (request) => {
        offeredPrefix = request.prefixApproval !== undefined;
        offeredProjectApproval = request.projectApproval !== undefined;
        return { type: "allow", scope: "project-prefix" };
      },
    });

    try {
      // When
      const decision = await bashPermission.review({
        command: "git status --short",
        cwd: workspace,
        signal: freshSignal(),
      });

      // Then
      expect(offeredPrefix).toBe(true);
      expect(offeredProjectApproval).toBe(false);
      expect(decision).toEqual({
        type: "deny",
        message: "No project command approval is available.",
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
