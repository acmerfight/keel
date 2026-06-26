import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, test } from "vitest";
import type { AgentEvent } from "../../../src/agent/loop.ts";
import { runInteractiveSession } from "../../../src/cli/interactive-session.ts";
import {
  createSessionStore,
  persistSessionBashApprovalGrant,
  persistSessionMessages,
  resumeSessionStore,
} from "../../../src/cli/session-store.ts";
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

describe("Interactive Session - Bash Approval Grants", () => {
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
      expect(stderr).toContain(
        "Approved command output may be sent to the provider unredacted.",
      );
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
});
