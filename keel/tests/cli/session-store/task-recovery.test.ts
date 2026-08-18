import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import type { SessionMessage } from "../../../src/agent/session-message.ts";
import { createSessionTaskRecovery } from "../../../src/cli/interactive-session/task-recovery.ts";
import {
  activeSessionTask,
  createSessionStore,
  forkSessionStore,
  listSessionCatalog,
  persistSessionProviderAttemptSettlement,
  persistSessionProviderIntent,
  persistSessionProviderResponse,
  persistSessionQueuedInput,
  persistSessionTaskRecoveryDisposition,
  persistSessionTaskRecoveryState,
  persistSessionTaskStep,
  persistSessionTaskTerminal,
  persistSessionToolEffectReconciliation,
  persistSessionToolIntents,
  persistSessionToolSettlement,
  resumeSessionStore,
  sessionStoredMessages,
} from "../../../src/cli/session-store.ts";
import { listUndoCheckpoints } from "../../../src/core/git.ts";
import { createGitWorkspace } from "../../../src/testing/cli-harness.ts";
import { runtime } from "../../../src/testing/session-store-fixtures.ts";

const PROVIDER = {
  providerId: "deepseek" as const,
  model: "deepseek-chat",
};
const USAGE = {
  inputTokens: 11,
  cachedInputTokens: 0,
  uncachedInputTokens: 11,
  outputTokens: 7,
};
const LEDGER_RECORD_TYPE_SCHEMA = z.object({ type: z.string() }).passthrough();
const PROVIDER_INTENT_RECORD_SCHEMA = z
  .object({
    task: z
      .object({
        providerAttempt: z.record(z.string(), z.unknown()),
      })
      .passthrough(),
  })
  .passthrough();
const STEP_COMMITTED_RECORD_SCHEMA = z
  .object({
    type: z.literal("step_committed"),
    task: z
      .object({
        providerRequestIds: z.array(
          z
            .object({
              attemptId: z.string(),
              responseMessageId: z.string(),
            })
            .strict(),
        ),
      })
      .passthrough(),
  })
  .passthrough();
const RECOVERY_LEDGER_RECORD_SCHEMA = z
  .object({
    type: z.string(),
    task: z.record(z.string(), z.unknown()).optional(),
    userMessage: z.record(z.string(), z.unknown()).optional(),
    messages: z.array(z.unknown()).optional(),
  })
  .passthrough();

describe("Session Store Task Recovery", () => {
  test.each([
    {
      name: "planned effect-capable invocation",
      toolCall: {
        id: "planned_bash",
        tool: "bash",
        command: "echo once",
      } as const,
      start: false,
      settle: false,
      expectedKind: "not_executed_after_restart",
    },
    {
      name: "started no-effect invocation",
      toolCall: { id: "pending_read", tool: "read", path: "note.txt" } as const,
      start: true,
      settle: false,
      expectedKind: "interrupted_no_effect",
    },
    {
      name: "durably settled invocation",
      toolCall: { id: "settled_read", tool: "read", path: "note.txt" } as const,
      start: true,
      settle: true,
      expectedKind: "completed",
    },
  ])(
    `Given a $name when the process ends before transcript promotion,
    When the named session resumes,
    Then recovery promotes one complete tool group and starts a fresh Run`,
    async ({ toolCall, start, settle, expectedKind }) => {
      const workspace = await mkdtemp(join(tmpdir(), "keel-task-workspace-"));
      const home = await mkdtemp(join(tmpdir(), "keel-task-home-"));
      let messages: readonly SessionMessage[] = [];
      try {
        const session = createSessionStore({
          sessionId: `tool-recovery-${expectedKind}`,
          workspace,
          runtime: runtime(home),
        });
        const recovery = createSessionTaskRecovery({
          session: () => session,
          runtime: runtime(home, 1),
          currentMessages: () => messages,
          onMessagesPersisted: (persisted) => {
            messages = persisted;
          },
        });
        const userMessage = {
          role: "user",
          content: "recover this tool round",
          origin: { type: "user_prompt" },
        } as const;
        recovery.admit({
          userMessage,
          provider: PROVIDER,
          consumedInputIds: [],
        });
        const lifecycle = recovery.providerLifecycle(PROVIDER);
        lifecycle.providerRequestAttempts
          .begin()
          .finish({ outcome: "completed", usage: USAGE });
        const assistantMessage = {
          role: "assistant",
          content: "",
          toolCalls: [toolCall],
        } as const;
        lifecycle.settled({
          assistantMessage,
          usage: USAGE,
          stopReason: "stop",
        });
        if (start) lifecycle.beforeToolCalls([toolCall]);
        if (settle) {
          lifecycle.toolSettled({
            toolMessage: {
              role: "tool",
              toolCallId: toolCall.id,
              content: "durable exact result",
            },
            effects: { checkpointOperations: [] },
          });
        }

        const opened = resumeSessionStore({
          sessionId: session.id,
          workspace,
          runtime: runtime(home, 2),
        });
        const interruptedRunId = opened.activeTask?.runId;
        messages = opened.messages;
        const directive = createSessionTaskRecovery({
          session: () => opened,
          runtime: runtime(home, 3),
          currentMessages: () => messages,
          onMessagesPersisted: (persisted) => {
            messages = persisted;
          },
        }).resume();

        expect(directive.kind).toBe("run");
        if (directive.kind !== "run") throw new Error("expected fresh Run");
        expect(directive.task.runId).not.toBe(interruptedRunId);
        expect(directive.recoveredMessages).toHaveLength(2);
        const recoveredToolMessage = directive.recoveredMessages[1];
        if (recoveredToolMessage?.role !== "tool") {
          throw new Error("expected recovered tool result");
        }
        expect(
          settle
            ? recoveredToolMessage
            : JSON.parse(recoveredToolMessage.content),
        ).toMatchObject(
          settle
            ? { role: "tool", content: "durable exact result" }
            : { status: expectedKind },
        );
        if (!settle) {
          expect(recoveredToolMessage.recovery).toEqual({
            kind: expectedKind,
            taskId: directive.task.taskId,
            runId: interruptedRunId,
            operationId: expect.stringMatching(/^tool_operation_/u),
          });
        }
        const reopened = resumeSessionStore({
          sessionId: session.id,
          workspace,
          runtime: runtime(home, 4),
        });
        expect(reopened.messages).toHaveLength(3);
        expect(
          reopened.messages.filter((message) => message.role === "tool"),
        ).toHaveLength(1);
        if (!settle) {
          expect(
            reopened.messages.find((message) => message.role === "tool"),
          ).toMatchObject({
            recovery: {
              kind: expectedKind,
              taskId: directive.task.taskId,
              runId: interruptedRunId,
            },
          });
        }
        expect(reopened.activeTask).toMatchObject({
          phase: "provider_ready",
          recovered: true,
        });
      } finally {
        await rm(workspace, { recursive: true, force: true });
        await rm(home, { recursive: true, force: true });
      }
    },
  );

  test(`Given an opaque tool invocation was started before the process ended,
    When the named session resumes,
    Then Keel records unknown effect once and blocks without redispatching or asking the user`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-task-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-task-home-"));
    let messages: readonly SessionMessage[] = [];

    try {
      const session = createSessionStore({
        sessionId: "opaque-tool-effect-unknown",
        workspace,
        runtime: runtime(home),
      });
      const recovery = createSessionTaskRecovery({
        session: () => session,
        runtime: runtime(home, 1),
        currentMessages: () => messages,
        onMessagesPersisted: (persisted) => {
          messages = persisted;
        },
      });
      recovery.admit({
        userMessage: {
          role: "user",
          content: "write exactly once",
          origin: { type: "user_prompt" },
        },
        provider: PROVIDER,
        consumedInputIds: [],
      });
      expect(() =>
        persistSessionTaskRecoveryDisposition({
          session,
          disposition: {
            kind: "accept_unknown",
            operationIds: ["tool_operation_not_started"],
          },
          runtime: runtime(home, 1),
        }),
      ).toThrow(/cannot accept unknown tool effects/u);
      const lifecycle = recovery.providerLifecycle(PROVIDER);
      lifecycle.providerRequestAttempts
        .begin()
        .finish({ outcome: "completed", usage: USAGE });
      const toolCalls = [
        {
          id: "opaque_write",
          tool: "write",
          path: "result.txt",
          content: "once\n",
        },
        { id: "opaque_read", tool: "read", path: "result.txt" },
      ] as const;
      lifecycle.settled({
        assistantMessage: {
          role: "assistant",
          content: "",
          toolCalls,
        },
        usage: USAGE,
        stopReason: "stop",
      });
      lifecycle.beforeToolCalls(toolCalls);

      const opened = resumeSessionStore({
        sessionId: session.id,
        workspace,
        runtime: runtime(home, 2),
      });
      messages = opened.messages;
      const directive = createSessionTaskRecovery({
        session: () => opened,
        runtime: runtime(home, 3),
        currentMessages: () => messages,
        onMessagesPersisted: (persisted) => {
          messages = persisted;
        },
      }).resume();
      expect(directive.kind).toBe("blocked");
      if (directive.kind !== "blocked") {
        throw new Error("expected opaque effect to block recovery");
      }
      expect(directive.task).toMatchObject({
        phase: "recovery_blocked",
        reason: "tool_effect",
        toolInvocations: [
          {
            phase: "settled",
            kind: "interrupted_effect_unknown",
            toolMessage: {
              message: {
                role: "tool",
                toolCallId: toolCalls[0].id,
                recovery: { kind: "interrupted_effect_unknown" },
              },
            },
          },
          {
            phase: "settled",
            kind: "interrupted_no_effect",
            toolMessage: {
              message: {
                role: "tool",
                toolCallId: toolCalls[1].id,
                recovery: { kind: "interrupted_no_effect" },
              },
            },
          },
        ],
      });
      expect(messages).toHaveLength(4);

      const reopened = resumeSessionStore({
        sessionId: session.id,
        workspace,
        runtime: runtime(home, 4),
      });
      expect(
        createSessionTaskRecovery({
          session: () => reopened,
          runtime: runtime(home, 5),
          currentMessages: () => reopened.messages,
          onMessagesPersisted: () => {},
        }).resume(),
      ).toMatchObject({
        kind: "blocked",
        task: { reason: "tool_effect" },
      });
      const ledger = await readFile(session.filePath, "utf8");
      expect(ledger.match(/"type":"tool_settled"/gu)).toHaveLength(2);
      expect(ledger.match(/"type":"step_committed"/gu)).toHaveLength(1);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given agent-tree evidence was persisted before the process died again,
    When recovery replays that evidence from a snapshot,
    Then it does not query the owner again and commits one resolved interruption`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-task-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-task-home-"));
    let messages: readonly SessionMessage[] = [];

    try {
      const session = createSessionStore({
        sessionId: "delegate-effect-reconciled",
        workspace,
        runtime: runtime(home),
      });
      const recovery = createSessionTaskRecovery({
        session: () => session,
        runtime: runtime(home, 1),
        currentMessages: () => messages,
        onMessagesPersisted: (persisted) => {
          messages = persisted;
        },
      });
      const admittedTask = recovery.admit({
        userMessage: {
          role: "user",
          content: "recover the accepted delegate",
          origin: { type: "user_prompt" },
        },
        provider: PROVIDER,
        consumedInputIds: [],
      });
      expect(() =>
        persistSessionToolEffectReconciliation({
          session,
          toolCallId: "delegate_reconciled",
          reconciliation: {
            ownerKey: "agent_tree",
            effect: "applied",
            evidence: {
              kind: "agent_tree_delegate",
              sessionId: session.id,
              delegationId: `${admittedTask.runId}:delegate_reconciled`,
              childAgentId: "agent-11111111-1111-4111-8111-111111111111",
              childRunId: "subagent-11111111-1111-4111-8111-111111111111",
              parentRunId: admittedTask.runId,
              parentToolCallId: "delegate_reconciled",
              status: "queued",
              result: null,
            },
          },
          runtime: runtime(home, 1),
        }),
      ).toThrow(/has no active tool execution/u);
      const lifecycle = recovery.providerLifecycle(PROVIDER);
      lifecycle.providerRequestAttempts
        .begin()
        .finish({ outcome: "completed", usage: USAGE });
      const toolCall = {
        id: "delegate_reconciled",
        tool: "delegate",
        profile: "explorer",
        mode: "foreground",
        task: "Inspect one module.",
      } as const;
      const companionRead = {
        id: "read_after_delegate",
        tool: "read",
        path: "module.ts",
      } as const;
      lifecycle.settled({
        assistantMessage: {
          role: "assistant",
          content: "",
          toolCalls: [toolCall, companionRead],
        },
        usage: USAGE,
        stopReason: "stop",
      });
      lifecycle.beforeToolCalls([toolCall, companionRead]);
      const pendingTask = activeSessionTask(session);
      if (pendingTask?.phase !== "tool_execution") {
        throw new Error("expected delegate tool execution");
      }
      const pendingInvocation = pendingTask.toolInvocations.find(
        (invocation) => invocation.toolCallId === toolCall.id,
      );
      if (pendingInvocation?.phase !== "effect_pending") {
        throw new Error("expected effect-pending delegate");
      }
      expect(() =>
        persistSessionToolEffectReconciliation({
          session,
          toolCallId: toolCall.id,
          reconciliation: {
            ownerKey: "agent_tree",
            effect: "applied",
            evidence: {
              kind: "agent_tree_delegate",
              sessionId: "another-session",
              delegationId: `${pendingInvocation.runId}:${toolCall.id}`,
              childAgentId: "agent-11111111-1111-4111-8111-111111111111",
              childRunId: "subagent-11111111-1111-4111-8111-111111111111",
              parentRunId: pendingInvocation.runId,
              parentToolCallId: toolCall.id,
              status: "interrupted",
              result: {
                status: "interrupted",
                finalText: null,
                error: "Child owner exited.",
                pendingInputCount: 0,
              },
            },
          },
          runtime: runtime(home, 2),
        }),
      ).toThrow(/cannot accept this effect reconciliation/u);
      expect(() =>
        persistSessionToolEffectReconciliation({
          session,
          toolCallId: toolCall.id,
          reconciliation: {
            ownerKey: "agent_tree",
            effect: "applied",
            evidence: {
              kind: "agent_tree_delegate",
              sessionId: session.id,
              delegationId: `${pendingInvocation.runId}:${toolCall.id}`,
              childAgentId: "agent-11111111-1111-4111-8111-111111111111",
              childRunId: "subagent-11111111-1111-4111-8111-111111111111",
              parentRunId: pendingInvocation.runId,
              parentToolCallId: toolCall.id,
              status: "queued",
              result: {
                status: "interrupted",
                finalText: null,
                error: "inconsistent result",
                pendingInputCount: 0,
              },
            },
          },
          runtime: runtime(home, 2),
        }),
      ).toThrow(/cannot accept this effect reconciliation/u);
      persistSessionToolEffectReconciliation({
        session,
        toolCallId: toolCall.id,
        reconciliation: {
          ownerKey: "agent_tree",
          effect: "applied",
          evidence: {
            kind: "agent_tree_delegate",
            sessionId: session.id,
            delegationId: `${pendingInvocation.runId}:${toolCall.id}`,
            childAgentId: "agent-11111111-1111-4111-8111-111111111111",
            childRunId: "subagent-11111111-1111-4111-8111-111111111111",
            parentRunId: pendingInvocation.runId,
            parentToolCallId: toolCall.id,
            status: "interrupted",
            result: {
              status: "interrupted",
              finalText: null,
              error: "Child owner exited.",
              pendingInputCount: 0,
            },
          },
        },
        runtime: runtime(home, 2),
      });
      const reconciledTask = activeSessionTask(session);
      if (reconciledTask?.phase !== "tool_execution") {
        throw new Error("expected reconciled delegate tool execution");
      }
      await appendFile(
        session.filePath,
        `${JSON.stringify({
          schemaVersion: 10,
          type: "snapshot",
          timestamp: "1970-01-01T00:00:02.000Z",
          reason: "size_threshold",
          messages: sessionStoredMessages(session),
          pendingInputs: [],
          skillStateCheckpoints: [
            { messageOrdinal: 0, skillActivations: [], activeSkillIds: [] },
          ],
          activeTask: reconciledTask,
        })}\n`,
        "utf8",
      );

      const opened = resumeSessionStore({
        sessionId: session.id,
        workspace,
        runtime: runtime(home, 3),
      });
      messages = opened.messages;
      let ownerQueries = 0;
      const directive = createSessionTaskRecovery({
        session: () => opened,
        runtime: runtime(home, 4),
        currentMessages: () => messages,
        onMessagesPersisted: (persisted) => {
          messages = persisted;
        },
        toolEffectRecoveryOwners: () =>
          new Map([
            [
              "agent_tree",
              {
                reconcile: () => {
                  ownerQueries++;
                  return { kind: "unknown" as const };
                },
              },
            ],
          ]),
      }).resume();

      expect(directive.kind).toBe("run");
      expect(ownerQueries).toBe(0);
      if (directive.kind !== "run") throw new Error("expected fresh Run");
      expect(directive.recoveredMessages[1]).toMatchObject({
        role: "tool",
        recovery: { kind: "interrupted_effect_unknown" },
      });
      expect(
        JSON.parse(directive.recoveredMessages[1]?.content ?? "{}"),
      ).toMatchObject({
        reconciliation: {
          ownerKey: "agent_tree",
          effect: "applied",
          evidence: { status: "interrupted" },
        },
      });
      const ledger = await readFile(session.filePath, "utf8");
      expect(ledger.match(/"type":"effect_reconciled"/gu)).toHaveLength(1);
      expect(ledger.match(/"type":"tool_settled"/gu)).toHaveLength(2);
      expect(ledger).not.toContain('"type":"task_recovery_disposition"');
      expect(
        resumeSessionStore({
          sessionId: session.id,
          workspace,
          runtime: runtime(home, 5),
        }).activeTask,
      ).toMatchObject({ phase: "provider_ready", recovered: true });
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a no-effect tool invocation is pending,
    When agent-tree evidence is offered for that invocation,
    Then the session store rejects evidence from an owner that does not own the effect`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-task-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-task-home-"));

    try {
      const session = createSessionStore({
        sessionId: "no-effect-owner-mismatch",
        workspace,
        runtime: runtime(home),
      });
      const recovery = createSessionTaskRecovery({
        session: () => session,
        runtime: runtime(home, 1),
        currentMessages: () => [],
        onMessagesPersisted: () => {},
      });
      recovery.admit({
        userMessage: {
          role: "user",
          content: "read one module",
          origin: { type: "user_prompt" },
        },
        provider: PROVIDER,
        consumedInputIds: [],
      });
      const lifecycle = recovery.providerLifecycle(PROVIDER);
      lifecycle.providerRequestAttempts
        .begin()
        .finish({ outcome: "completed", usage: USAGE });
      const toolCall = {
        id: "read_no_effect",
        tool: "read",
        path: "module.ts",
      } as const;
      lifecycle.settled({
        assistantMessage: {
          role: "assistant",
          content: "",
          toolCalls: [toolCall],
        },
        usage: USAGE,
        stopReason: "stop",
      });
      lifecycle.beforeToolCalls([toolCall]);
      const pendingTask = activeSessionTask(session);
      if (pendingTask?.phase !== "tool_execution") {
        throw new Error("expected read tool execution");
      }
      const pendingInvocation = pendingTask.toolInvocations[0];
      if (pendingInvocation?.phase !== "effect_pending") {
        throw new Error("expected effect-pending read");
      }

      expect(() =>
        persistSessionToolEffectReconciliation({
          session,
          toolCallId: toolCall.id,
          reconciliation: {
            ownerKey: "agent_tree",
            effect: "not_applied",
            evidence: {
              kind: "agent_tree_delegate_not_accepted",
              sessionId: session.id,
              delegationId: `${pendingInvocation.runId}:${toolCall.id}`,
              parentRunId: pendingInvocation.runId,
              parentToolCallId: toolCall.id,
              profile: "explorer",
              mode: "foreground",
              argumentsSha256: pendingInvocation.argumentsSha256,
            },
          },
          runtime: runtime(home, 2),
        }),
      ).toThrow(/cannot accept this effect reconciliation/u);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given agent-tree absence was persisted before the process died again,
    When recovery reopens the interrupted foreground reviewer delegate,
    Then it reuses not-applied evidence without querying the owner or applying host policy`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-task-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-task-home-"));
    let messages: readonly SessionMessage[] = [];

    try {
      const session = createSessionStore({
        sessionId: "delegate-effect-not-applied",
        workspace,
        runtime: runtime(home),
      });
      const recovery = createSessionTaskRecovery({
        session: () => session,
        runtime: runtime(home, 1),
        currentMessages: () => messages,
        onMessagesPersisted: (persisted) => {
          messages = persisted;
        },
      });
      recovery.admit({
        userMessage: {
          role: "user",
          content: "recover the unaccepted reviewer delegate",
          origin: { type: "user_prompt" },
        },
        provider: PROVIDER,
        consumedInputIds: [],
      });
      const lifecycle = recovery.providerLifecycle(PROVIDER);
      lifecycle.providerRequestAttempts
        .begin()
        .finish({ outcome: "completed", usage: USAGE });
      const toolCall = {
        id: "delegate_not_accepted",
        tool: "delegate",
        profile: "reviewer",
        mode: "foreground",
        task: "Review one module.",
      } as const;
      lifecycle.settled({
        assistantMessage: {
          role: "assistant",
          content: "",
          toolCalls: [toolCall],
        },
        usage: USAGE,
        stopReason: "stop",
      });
      lifecycle.beforeToolCalls([toolCall]);
      const pendingTask = activeSessionTask(session);
      if (pendingTask?.phase !== "tool_execution") {
        throw new Error("expected delegate tool execution");
      }
      const pendingInvocation = pendingTask.toolInvocations[0];
      if (pendingInvocation?.phase !== "effect_pending") {
        throw new Error("expected effect-pending delegate");
      }
      expect(() =>
        persistSessionToolEffectReconciliation({
          session,
          toolCallId: toolCall.id,
          reconciliation: {
            ownerKey: "agent_tree",
            effect: "not_applied",
            evidence: {
              kind: "agent_tree_delegate_not_accepted",
              sessionId: session.id,
              delegationId: `${pendingInvocation.runId}:${toolCall.id}`,
              parentRunId: pendingInvocation.runId,
              parentToolCallId: toolCall.id,
              profile: "explorer",
              mode: "foreground",
              argumentsSha256: pendingInvocation.argumentsSha256,
            },
          },
          runtime: runtime(home, 2),
        }),
      ).toThrow(/cannot accept this effect reconciliation/u);
      persistSessionToolEffectReconciliation({
        session,
        toolCallId: toolCall.id,
        reconciliation: {
          ownerKey: "agent_tree",
          effect: "not_applied",
          evidence: {
            kind: "agent_tree_delegate_not_accepted",
            sessionId: session.id,
            delegationId: `${pendingInvocation.runId}:${toolCall.id}`,
            parentRunId: pendingInvocation.runId,
            parentToolCallId: toolCall.id,
            profile: "reviewer",
            mode: "foreground",
            argumentsSha256: pendingInvocation.argumentsSha256,
          },
        },
        runtime: runtime(home, 3),
      });

      const opened = resumeSessionStore({
        sessionId: session.id,
        workspace,
        runtime: runtime(home, 4),
      });
      messages = opened.messages;
      let ownerQueries = 0;
      const directive = createSessionTaskRecovery({
        session: () => opened,
        runtime: runtime(home, 5),
        currentMessages: () => messages,
        onMessagesPersisted: (persisted) => {
          messages = persisted;
        },
        toolEffectRecoveryOwners: () =>
          new Map([
            [
              "agent_tree",
              {
                reconcile: () => {
                  ownerQueries++;
                  return { kind: "unknown" as const };
                },
              },
            ],
          ]),
      }).resume();

      expect(directive.kind).toBe("run");
      expect(ownerQueries).toBe(0);
      if (directive.kind !== "run") throw new Error("expected fresh Run");
      expect(
        JSON.parse(directive.recoveredMessages[1]?.content ?? "{}"),
      ).toMatchObject({
        status: "interrupted_effect_unknown",
        reconciliation: {
          ownerKey: "agent_tree",
          effect: "not_applied",
          evidence: {
            kind: "agent_tree_delegate_not_accepted",
            profile: "reviewer",
          },
        },
      });
      const ledger = await readFile(session.filePath, "utf8");
      expect(ledger.match(/"type":"effect_reconciled"/gu)).toHaveLength(1);
      expect(ledger.match(/"type":"tool_settled"/gu)).toHaveLength(1);
      expect(ledger).not.toContain('"type":"task_recovery_disposition"');
      expect(
        resumeSessionStore({
          sessionId: session.id,
          workspace,
          runtime: runtime(home, 6),
        }).activeTask,
      ).toMatchObject({ phase: "provider_ready", recovered: true });
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test.each([
    {
      name: "a different Task identity",
      scenario: "identity" as const,
      expected: /effect_reconciled does not match the active tool plan/u,
    },
    {
      name: "forged owner evidence",
      scenario: "evidence" as const,
      expected: /effect_reconciled is not a canonical transition/u,
    },
  ])(
    `Given an effect_reconciled record contains $name,
    When the session replays it,
    Then recovery fails closed before changing effect truth`,
    async ({ scenario, expected }) => {
      const workspace = await mkdtemp(join(tmpdir(), "keel-task-workspace-"));
      const home = await mkdtemp(join(tmpdir(), "keel-task-home-"));
      let messages: readonly SessionMessage[] = [];

      try {
        const session = createSessionStore({
          sessionId: `invalid-effect-reconciliation-${scenario}`,
          workspace,
          runtime: runtime(home),
        });
        const recovery = createSessionTaskRecovery({
          session: () => session,
          runtime: runtime(home, 1),
          currentMessages: () => messages,
          onMessagesPersisted: (persisted) => {
            messages = persisted;
          },
        });
        recovery.admit({
          userMessage: {
            role: "user",
            content: "reject forged reconciliation evidence",
            origin: { type: "user_prompt" },
          },
          provider: PROVIDER,
          consumedInputIds: [],
        });
        const lifecycle = recovery.providerLifecycle(PROVIDER);
        lifecycle.providerRequestAttempts
          .begin()
          .finish({ outcome: "completed", usage: USAGE });
        const toolCall = {
          id: "delegate_forged_reconciliation",
          tool: "delegate",
          profile: "explorer",
          mode: "foreground",
          task: "Inspect one module.",
        } as const;
        lifecycle.settled({
          assistantMessage: {
            role: "assistant",
            content: "",
            toolCalls: [toolCall],
          },
          usage: USAGE,
          stopReason: "stop",
        });
        lifecycle.beforeToolCalls([toolCall]);
        const pendingTask = activeSessionTask(session);
        if (pendingTask?.phase !== "tool_execution") {
          throw new Error("expected delegate tool execution");
        }
        const pendingInvocation = pendingTask.toolInvocations[0];
        if (pendingInvocation?.phase !== "effect_pending") {
          throw new Error("expected effect-pending delegate");
        }
        const reconciliation = {
          ownerKey: "agent_tree" as const,
          effect: "applied" as const,
          evidence: {
            kind: "agent_tree_delegate" as const,
            sessionId: scenario === "evidence" ? "forged-session" : session.id,
            delegationId: `${pendingInvocation.runId}:${toolCall.id}`,
            childAgentId: "agent-11111111-1111-4111-8111-111111111111",
            childRunId: "subagent-11111111-1111-4111-8111-111111111111",
            parentRunId: pendingInvocation.runId,
            parentToolCallId: toolCall.id,
            status: "interrupted" as const,
            result: {
              status: "interrupted" as const,
              finalText: null,
              error: "Child owner exited.",
              pendingInputCount: 0,
            },
          },
        };
        const reconciledTask = {
          ...pendingTask,
          ...(scenario === "identity" ? { taskId: "task_forged" } : {}),
          toolInvocations: pendingTask.toolInvocations.map((invocation) =>
            invocation.toolCallId === toolCall.id
              ? { ...pendingInvocation, reconciliation }
              : invocation,
          ),
        };
        await appendFile(
          session.filePath,
          `${JSON.stringify({
            schemaVersion: 10,
            type: "effect_reconciled",
            timestamp: "1970-01-01T00:00:02.000Z",
            task: reconciledTask,
            operationId: pendingInvocation.operationId,
            reconciliation,
          })}\n`,
          "utf8",
        );

        expect(() =>
          resumeSessionStore({
            sessionId: session.id,
            workspace,
            runtime: runtime(home, 3),
          }),
        ).toThrow(expected);
      } finally {
        await rm(workspace, { recursive: true, force: true });
        await rm(home, { recursive: true, force: true });
      }
    },
  );

  test.each([
    { name: "missing owner", ownerMode: "missing" as const },
    { name: "failing owner", ownerMode: "throws" as const },
  ])(
    `Given a started delegate has $name,
    When the named session resumes,
    Then it preserves unknown truth and the existing block policy`,
    async ({ ownerMode }) => {
      const workspace = await mkdtemp(join(tmpdir(), "keel-task-workspace-"));
      const home = await mkdtemp(join(tmpdir(), "keel-task-home-"));
      let messages: readonly SessionMessage[] = [];

      try {
        const session = createSessionStore({
          sessionId: "delegate-owner-unavailable",
          workspace,
          runtime: runtime(home),
        });
        const recovery = createSessionTaskRecovery({
          session: () => session,
          runtime: runtime(home, 1),
          currentMessages: () => messages,
          onMessagesPersisted: (persisted) => {
            messages = persisted;
          },
        });
        recovery.admit({
          userMessage: {
            role: "user",
            content: "delegate without owner evidence",
            origin: { type: "user_prompt" },
          },
          provider: PROVIDER,
          consumedInputIds: [],
        });
        const lifecycle = recovery.providerLifecycle(PROVIDER);
        lifecycle.providerRequestAttempts
          .begin()
          .finish({ outcome: "completed", usage: USAGE });
        const toolCall = {
          id: "delegate_without_owner",
          tool: "delegate",
          profile: "explorer",
          mode: "foreground",
          task: "Inspect one module.",
        } as const;
        lifecycle.settled({
          assistantMessage: {
            role: "assistant",
            content: "",
            toolCalls: [toolCall],
          },
          usage: USAGE,
          stopReason: "stop",
        });
        lifecycle.beforeToolCalls([toolCall]);

        const directive = createSessionTaskRecovery({
          session: () => session,
          runtime: runtime(home, 2),
          currentMessages: () => messages,
          onMessagesPersisted: (persisted) => {
            messages = persisted;
          },
          ...(ownerMode === "missing"
            ? {}
            : {
                toolEffectRecoveryOwners: () =>
                  new Map([
                    [
                      "agent_tree",
                      {
                        reconcile: () => {
                          throw new Error("agent-tree owner unavailable");
                        },
                      },
                    ],
                  ]),
              }),
        }).resume();

        expect(directive).toMatchObject({
          kind: "blocked",
          task: {
            reason: "tool_effect",
            toolInvocations: [
              {
                phase: "settled",
                kind: "interrupted_effect_unknown",
              },
            ],
          },
        });
        const ledger = await readFile(session.filePath, "utf8");
        expect(ledger).not.toContain('"type":"effect_reconciled"');
      } finally {
        await rm(workspace, { recursive: true, force: true });
        await rm(home, { recursive: true, force: true });
      }
    },
  );

  test(`Given accept_unknown was captured before an opaque effect and its disposition is durable,
    When recovery restarts between disposition and continuation,
    Then it reuses that decision once and terminalizes with disclosed unknown effects`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-task-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-task-home-"));
    let messages: readonly SessionMessage[] = [];

    try {
      const session = createSessionStore({
        sessionId: "accepted-unknown-disposition",
        workspace,
        runtime: runtime(home),
      });
      const recovery = createSessionTaskRecovery({
        session: () => session,
        runtime: runtime(home, 1),
        toolEffectRecoveryPolicy: "accept_unknown",
        currentMessages: () => messages,
        onMessagesPersisted: (persisted) => {
          messages = persisted;
        },
      });
      recovery.admit({
        userMessage: {
          role: "user",
          content: "continue after an accepted unknown effect",
          origin: { type: "user_prompt" },
        },
        provider: PROVIDER,
        consumedInputIds: [],
      });
      const lifecycle = recovery.providerLifecycle(PROVIDER);
      lifecycle.providerRequestAttempts
        .begin()
        .finish({ outcome: "completed", usage: USAGE });
      const toolCall = {
        id: "accepted_unknown_write",
        tool: "write",
        path: "result.txt",
        content: "possibly written\n",
      } as const;
      lifecycle.settled({
        assistantMessage: {
          role: "assistant",
          content: "",
          toolCalls: [toolCall],
        },
        usage: USAGE,
        stopReason: "stop",
      });
      lifecycle.beforeToolCalls([toolCall]);
      const pendingTask = activeSessionTask(session);
      if (pendingTask?.phase !== "tool_execution") {
        throw new Error("expected pending opaque tool effect");
      }
      const pendingInvocation = pendingTask.toolInvocations[0];
      if (pendingInvocation?.phase !== "effect_pending") {
        throw new Error("expected effect-pending invocation");
      }
      persistSessionToolSettlement({
        session,
        toolCallId: toolCall.id,
        settlementKind: "interrupted_effect_unknown",
        toolMessage: {
          role: "tool",
          toolCallId: toolCall.id,
          content: "unknown effect persisted before disposition",
          recovery: {
            kind: "interrupted_effect_unknown",
            taskId: pendingTask.taskId,
            runId: pendingInvocation.runId,
            operationId: pendingInvocation.operationId,
          },
        },
        effects: { checkpointOperations: [] },
        runtime: runtime(home, 2),
      });
      const settledUnknownTask = activeSessionTask(session);
      if (settledUnknownTask?.phase !== "tool_execution") {
        throw new Error("expected settled unknown tool execution");
      }
      const ledgerBeforeDisposition = await readFile(session.filePath, "utf8");
      const noncanonicalDispositionLedger = `${ledgerBeforeDisposition}${JSON.stringify(
        {
          schemaVersion: 10,
          type: "task_recovery_disposition",
          timestamp: "1970-01-01T00:00:03.000Z",
          task: {
            ...settledUnknownTask,
            acceptedUnknownEffectOperationIds: [
              pendingInvocation.operationId,
              "tool_operation_fabricated",
            ],
          },
          disposition: {
            kind: "accept_unknown",
            operationIds: [pendingInvocation.operationId],
          },
        },
      )}\n`;
      expect(() =>
        persistSessionTaskRecoveryDisposition({
          session,
          disposition: {
            kind: "accept_unknown",
            operationIds: ["tool_operation_wrong"],
          },
          runtime: runtime(home, 3),
        }),
      ).toThrow(/does not match unknown effects/u);
      persistSessionTaskRecoveryDisposition({
        session,
        disposition: {
          kind: "accept_unknown",
          operationIds: [pendingInvocation.operationId],
        },
        runtime: runtime(home, 3),
      });
      expect(() =>
        persistSessionTaskRecoveryDisposition({
          session,
          disposition: {
            kind: "accept_unknown",
            operationIds: [pendingInvocation.operationId],
          },
          runtime: runtime(home, 3),
        }),
      ).toThrow(/does not match unknown effects/u);
      const acceptedUnknownTask = activeSessionTask(session);
      if (acceptedUnknownTask?.phase !== "tool_execution") {
        throw new Error("expected accepted unknown tool execution");
      }
      await appendFile(
        session.filePath,
        `${JSON.stringify({
          schemaVersion: 10,
          type: "snapshot",
          timestamp: "1970-01-01T00:00:03.000Z",
          reason: "size_threshold",
          messages: sessionStoredMessages(session),
          pendingInputs: [],
          skillStateCheckpoints: [
            { messageOrdinal: 0, skillActivations: [], activeSkillIds: [] },
          ],
          activeTask: acceptedUnknownTask,
        })}\n`,
        "utf8",
      );

      const opened = resumeSessionStore({
        sessionId: session.id,
        workspace,
        runtime: runtime(home, 4),
      });
      messages = opened.messages;
      const resumedRecovery = createSessionTaskRecovery({
        session: () => opened,
        runtime: runtime(home, 5),
        currentMessages: () => messages,
        onMessagesPersisted: (persisted) => {
          messages = persisted;
        },
      });
      const directive = resumedRecovery.resume();
      expect(directive.kind).toBe("run");
      if (directive.kind !== "run") {
        throw new Error("expected accepted unknown effect to continue");
      }
      expect(directive.task).toMatchObject({
        taskId: pendingTask.taskId,
        phase: "provider_ready",
        toolEffectRecoveryPolicy: "accept_unknown",
        acceptedUnknownEffectOperationIds: [pendingInvocation.operationId],
      });
      expect(directive.task.runId).not.toBe(pendingTask.runId);

      const resumedLifecycle = resumedRecovery.providerLifecycle(PROVIDER);
      resumedLifecycle.providerRequestAttempts
        .begin()
        .finish({ outcome: "completed", usage: USAGE });
      const finalMessage = {
        role: "assistant",
        content: "completed with the unknown effect disclosed",
        toolCalls: [],
      } as const;
      resumedLifecycle.settled({
        assistantMessage: finalMessage,
        usage: USAGE,
        stopReason: "stop",
      });
      const completedOutcome = resumedRecovery.terminal({
        messages: [...messages, finalMessage],
        outcome: "completed",
      });
      expect(completedOutcome).toMatchObject({
        outcome: "completed_with_unknown_effects",
        unknownToolEffectOperationIds: [pendingInvocation.operationId],
      });
      await appendFile(
        opened.filePath,
        `${JSON.stringify({
          schemaVersion: 10,
          type: "snapshot",
          timestamp: "1970-01-01T00:00:06.000Z",
          reason: "size_threshold",
          messages: sessionStoredMessages(opened),
          pendingInputs: [],
          skillStateCheckpoints: [
            { messageOrdinal: 0, skillActivations: [], activeSkillIds: [] },
          ],
          lastTaskOutcome: completedOutcome,
        })}\n`,
        "utf8",
      );

      const terminal = resumeSessionStore({
        sessionId: session.id,
        workspace,
        runtime: runtime(home, 6),
      });
      expect(terminal.activeTask).toBeUndefined();
      expect(terminal.lastTaskOutcome).toMatchObject({
        outcome: "completed_with_unknown_effects",
        unknownToolEffectOperationIds: [pendingInvocation.operationId],
      });
      const ledger = await readFile(session.filePath, "utf8");
      expect(ledger.match(/"type":"task_recovery_disposition"/gu)).toHaveLength(
        1,
      );
      const dispositionLine = ledger
        .trimEnd()
        .split("\n")
        .find((line) => line.includes('"type":"task_recovery_disposition"'));
      if (dispositionLine === undefined) {
        throw new Error("expected recovery disposition record");
      }
      await writeFile(session.filePath, noncanonicalDispositionLedger, "utf8");
      expect(() =>
        resumeSessionStore({
          sessionId: session.id,
          workspace,
          runtime: runtime(home, 7),
        }),
      ).toThrow(/task_recovery_disposition is not a canonical transition/u);
      await writeFile(
        session.filePath,
        `${ledger}${dispositionLine}\n`,
        "utf8",
      );
      expect(() =>
        resumeSessionStore({
          sessionId: session.id,
          workspace,
          runtime: runtime(home, 8),
        }),
      ).toThrow(/task_recovery_disposition does not match the active Task/u);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given accept_unknown covers multiple interrupted opaque effects,
    When recovery synthesizes their settlements,
    Then one ordered disposition advances the same Task into a fresh Run`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-task-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-task-home-"));
    let messages: readonly SessionMessage[] = [];

    try {
      const session = createSessionStore({
        sessionId: "automatic-accepted-unknown-effects",
        workspace,
        runtime: runtime(home),
      });
      const recovery = createSessionTaskRecovery({
        session: () => session,
        runtime: runtime(home, 1),
        toolEffectRecoveryPolicy: "accept_unknown",
        currentMessages: () => messages,
        onMessagesPersisted: (persisted) => {
          messages = persisted;
        },
      });
      const admitted = recovery.admit({
        userMessage: {
          role: "user",
          content: "continue after both opaque effects",
          origin: { type: "user_prompt" },
        },
        provider: PROVIDER,
        consumedInputIds: [],
      });
      const lifecycle = recovery.providerLifecycle(PROVIDER);
      lifecycle.providerRequestAttempts
        .begin()
        .finish({ outcome: "completed", usage: USAGE });
      const toolCalls = [
        {
          id: "write_first_unknown",
          tool: "write",
          path: "first.txt",
          content: "first\n",
        },
        {
          id: "write_second_unknown",
          tool: "write",
          path: "second.txt",
          content: "second\n",
        },
      ] as const;
      lifecycle.settled({
        assistantMessage: { role: "assistant", content: "", toolCalls },
        usage: USAGE,
        stopReason: "stop",
      });
      lifecycle.beforeToolCalls(toolCalls);

      const opened = resumeSessionStore({
        sessionId: session.id,
        workspace,
        runtime: runtime(home, 2),
      });
      messages = opened.messages;
      const directive = createSessionTaskRecovery({
        session: () => opened,
        runtime: runtime(home, 3),
        currentMessages: () => messages,
        onMessagesPersisted: (persisted) => {
          messages = persisted;
        },
      }).resume();
      expect(directive.kind).toBe("run");
      if (directive.kind !== "run") throw new Error("expected fresh Run");
      expect(directive.task.taskId).toBe(admitted.taskId);
      expect(directive.task.runId).not.toBe(admitted.runId);
      expect(directive.recoveredMessages.slice(1)).toMatchObject([
        {
          role: "tool",
          toolCallId: toolCalls[0].id,
          recovery: { kind: "interrupted_effect_unknown" },
        },
        {
          role: "tool",
          toolCallId: toolCalls[1].id,
          recovery: { kind: "interrupted_effect_unknown" },
        },
      ]);
      expect(
        (await readFile(session.filePath, "utf8")).match(
          /"type":"task_recovery_disposition"/gu,
        ),
      ).toHaveLength(1);
      expect(
        activeSessionTask(
          resumeSessionStore({
            sessionId: session.id,
            workspace,
            runtime: runtime(home, 4),
          }),
        ),
      ).toMatchObject({
        phase: "provider_ready",
        acceptedUnknownEffectOperationIds: [
          expect.any(String),
          expect.any(String),
        ],
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given parallel no-effect invocations settle in completion order,
    When the process ends after only the later source invocation settles,
    Then recovery reuses it once and promotes synthetic plus real results in source order`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-task-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-task-home-"));
    let messages: readonly SessionMessage[] = [];
    try {
      const session = createSessionStore({
        sessionId: "parallel-tool-settlement",
        workspace,
        runtime: runtime(home),
      });
      const recovery = createSessionTaskRecovery({
        session: () => session,
        runtime: runtime(home, 1),
        currentMessages: () => messages,
        onMessagesPersisted: (persisted) => {
          messages = persisted;
        },
      });
      recovery.admit({
        userMessage: {
          role: "user",
          content: "read two resources",
          origin: { type: "user_prompt" },
        },
        provider: PROVIDER,
        consumedInputIds: [],
      });
      const lifecycle = recovery.providerLifecycle(PROVIDER);
      lifecycle.providerRequestAttempts
        .begin()
        .finish({ outcome: "completed", usage: USAGE });
      const toolCalls = [
        { id: "read_first", tool: "read", path: "first.txt" },
        { id: "read_second", tool: "read", path: "second.txt" },
      ] as const;
      lifecycle.settled({
        assistantMessage: {
          role: "assistant",
          content: "",
          toolCalls,
        },
        usage: USAGE,
        stopReason: "stop",
      });
      lifecycle.beforeToolCalls(toolCalls);
      lifecycle.toolSettled({
        toolMessage: {
          role: "tool",
          toolCallId: "read_second",
          content: "second completed first",
        },
        effects: {
          checkpointOperations: [],
          taskProgress: {
            tasks: [{ step: "second settled", status: "in_progress" }],
          },
        },
      });

      const opened = resumeSessionStore({
        sessionId: session.id,
        workspace,
        runtime: runtime(home, 2),
      });
      expect(opened.taskProgress).toEqual({
        tasks: [{ step: "second settled", status: "in_progress" }],
      });
      messages = opened.messages;
      const directive = createSessionTaskRecovery({
        session: () => opened,
        runtime: runtime(home, 3),
        currentMessages: () => messages,
        onMessagesPersisted: (persisted) => {
          messages = persisted;
        },
      }).resume();
      expect(directive.kind).toBe("run");
      if (directive.kind !== "run") throw new Error("expected fresh Run");
      expect(
        directive.recoveredMessages
          .slice(1)
          .map((message) =>
            message.role === "tool" ? message.toolCallId : "unexpected",
          ),
      ).toEqual(["read_first", "read_second"]);
      const firstRecoveredToolMessage = directive.recoveredMessages[1];
      if (firstRecoveredToolMessage?.role !== "tool") {
        throw new Error("expected first recovered tool result");
      }
      expect(firstRecoveredToolMessage.content).toContain(
        "interrupted_no_effect",
      );
      expect(directive.recoveredMessages[2]).toMatchObject({
        role: "tool",
        content: "second completed first",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a completed tool carries every durable continuation effect,
    When its Task settles and provider budget stops the next request,
    Then one owned checkpoint and the exact continuation state survive reopen`, async () => {
    const workspace = await createGitWorkspace("keel-task-effects-");
    const home = await mkdtemp(join(tmpdir(), "keel-task-home-"));
    const editedPath = join(workspace, "edited.txt");
    const createdPath = join(workspace, "created.txt");
    const executablePath = join(workspace, "executable.sh");
    const deletedPath = join(workspace, "deleted.txt");
    await writeFile(editedPath, "after\n", "utf8");
    await writeFile(createdPath, "created\n", "utf8");
    await writeFile(executablePath, "#!/bin/sh\n", "utf8");
    let messages: readonly SessionMessage[] = [];

    try {
      const session = createSessionStore({
        sessionId: "tool-continuation-effects",
        workspace,
        runtime: runtime(home),
      });
      const recovery = createSessionTaskRecovery({
        session: () => session,
        runtime: runtime(home, 1),
        currentMessages: () => messages,
        onMessagesPersisted: (persisted) => {
          messages = persisted;
        },
      });
      expect(recovery.finalizeCheckpoint()).toBeNull();
      const userMessage = {
        role: "user",
        content: "persist all continuation effects",
        origin: { type: "user_prompt" },
      } as const;
      recovery.admit({
        userMessage,
        provider: PROVIDER,
        consumedInputIds: [],
      });
      expect(recovery.finalizeCheckpoint()).toBeNull();
      const lifecycle = recovery.providerLifecycle(PROVIDER);
      lifecycle.providerRequestAttempts
        .begin()
        .finish({ outcome: "completed", usage: USAGE });
      const toolCall = {
        id: "write_effects",
        tool: "write",
        path: "created.txt",
        content: "created\n",
      } as const;
      const assistantMessage = {
        role: "assistant",
        content: "",
        toolCalls: [toolCall],
      } as const;
      lifecycle.settled({
        assistantMessage,
        usage: USAGE,
        stopReason: "stop",
      });
      lifecycle.beforeToolCalls([toolCall]);
      const toolMessage = {
        role: "tool",
        toolCallId: toolCall.id,
        content: "all effects settled",
      } as const;
      lifecycle.toolSettled({
        toolMessage,
        effects: {
          checkpointOperations: [
            {
              operation: "edit",
              filePath: editedPath,
              beforeContent: "before\n",
              afterContent: "after\n",
              modeOwnership: { kind: "unowned" },
            },
            {
              operation: "create",
              filePath: createdPath,
              afterContent: "created\n",
            },
            {
              operation: "create",
              filePath: executablePath,
              afterContent: "#!/bin/sh\n",
              mode: 0o755,
            },
            {
              operation: "delete",
              filePath: deletedPath,
              beforeContent: "deleted\n",
              mode: 0o644,
            },
          ],
          taskProgress: {
            tasks: [{ step: "effects persisted", status: "in_progress" }],
          },
          goal: {
            objective: "Persist continuation effects",
            status: "active",
            budget: {},
            usage: { turns: 1, tokens: 18, activeTimeMs: 25 },
          },
          skillState: { skillActivations: [], activeSkillIds: [] },
          delegation: [{ usage: USAGE, costUsd: 0.001 }],
        },
      });

      expect(recovery.finalizeCheckpoint()).toEqual({ written: true });
      expect(listUndoCheckpoints(workspace)).toEqual([
        { restoredLabel: "4 files" },
      ]);
      const blocked = recovery.blockProviderBudget([
        userMessage,
        assistantMessage,
        toolMessage,
      ]);
      expect(blocked).toMatchObject({
        phase: "recovery_blocked",
        reason: "provider_budget",
      });

      const opened = resumeSessionStore({
        sessionId: session.id,
        workspace,
        runtime: runtime(home, 2),
      });
      expect(opened.messages).toEqual([
        userMessage,
        assistantMessage,
        toolMessage,
      ]);
      expect(opened.taskProgress).toEqual({
        tasks: [{ step: "effects persisted", status: "in_progress" }],
      });
      expect(opened.goal).toMatchObject({
        objective: "Persist continuation effects",
        status: "active",
      });
      expect(opened.activeSkillIds).toEqual([]);
      expect(opened.activeTask).toMatchObject({
        phase: "recovery_blocked",
        reason: "provider_budget",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given recovery itself ends after one synthetic settlement,
    When the session resumes recovery again,
    Then the settled invocation is reused and each source call is promoted exactly once`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-task-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-task-home-"));
    let messages: readonly SessionMessage[] = [];
    try {
      const session = createSessionStore({
        sessionId: "recovery-restart-idempotence",
        workspace,
        runtime: runtime(home),
      });
      const recovery = createSessionTaskRecovery({
        session: () => session,
        runtime: runtime(home, 1),
        currentMessages: () => messages,
        onMessagesPersisted: (persisted) => {
          messages = persisted;
        },
      });
      recovery.admit({
        userMessage: {
          role: "user",
          content: "recover twice safely",
          origin: { type: "user_prompt" },
        },
        provider: PROVIDER,
        consumedInputIds: [],
      });
      const lifecycle = recovery.providerLifecycle(PROVIDER);
      lifecycle.providerRequestAttempts
        .begin()
        .finish({ outcome: "completed", usage: USAGE });
      lifecycle.settled({
        assistantMessage: {
          role: "assistant",
          content: "",
          toolCalls: [
            { id: "planned_one", tool: "read", path: "one.txt" },
            { id: "planned_two", tool: "read", path: "two.txt" },
          ],
        },
        usage: USAGE,
        stopReason: "stop",
      });
      const plannedTask = activeSessionTask(session);
      if (plannedTask?.phase !== "tool_execution") {
        throw new Error("expected a durable tool plan");
      }
      const plannedInvocation = plannedTask.toolInvocations[0];
      if (plannedInvocation === undefined) {
        throw new Error("expected the first planned invocation");
      }
      persistSessionToolSettlement({
        session,
        toolCallId: "planned_one",
        settlementKind: "not_executed_after_restart",
        toolMessage: {
          role: "tool",
          toolCallId: "planned_one",
          content: "first synthetic result",
          recovery: {
            kind: "not_executed_after_restart",
            taskId: plannedTask.taskId,
            runId: plannedInvocation.runId,
            operationId: plannedInvocation.operationId,
          },
        },
        effects: { checkpointOperations: [] },
        runtime: runtime(home, 2),
      });

      const opened = resumeSessionStore({
        sessionId: session.id,
        workspace,
        runtime: runtime(home, 3),
      });
      messages = opened.messages;
      const directive = createSessionTaskRecovery({
        session: () => opened,
        runtime: runtime(home, 4),
        currentMessages: () => messages,
        onMessagesPersisted: (persisted) => {
          messages = persisted;
        },
      }).resume();
      expect(directive.kind).toBe("run");
      if (directive.kind !== "run") throw new Error("expected fresh Run");
      expect(directive.recoveredMessages[1]).toMatchObject({
        role: "tool",
        toolCallId: "planned_one",
        content: "first synthetic result",
      });
      expect(directive.recoveredMessages[2]).toMatchObject({
        role: "tool",
        toolCallId: "planned_two",
      });
      const ledger = await readFile(session.filePath, "utf8");
      expect(ledger.match(/"type":"tool_settled"/gu)).toHaveLength(2);
      expect(ledger.match(/"type":"step_committed"/gu)).toHaveLength(1);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given an ordinary prompt completes through a durable provider boundary,
    When the Task reaches its terminal transition,
    Then replay exposes one transcript and the stable terminal outcome`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-task-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-task-home-"));
    const messages: SessionMessage[] = [];

    try {
      const session = createSessionStore({
        sessionId: "task-terminal",
        workspace,
        runtime: runtime(home),
      });
      const recovery = createSessionTaskRecovery({
        session: () => session,
        runtime: runtime(home, 1),
        currentMessages: () => messages,
        onMessagesPersisted: (persisted) => {
          messages.splice(0, messages.length, ...persisted);
        },
      });
      const userMessage = {
        role: "user",
        content: "finish this durable task",
        origin: { type: "user_prompt" },
      } as const;
      const task = recovery.admit({
        userMessage,
        provider: PROVIDER,
        consumedInputIds: [],
      });
      const lifecycle = recovery.providerLifecycle(PROVIDER);
      const attempt = lifecycle.providerRequestAttempts.begin();
      attempt.finish({ outcome: "completed", usage: USAGE });
      const assistantMessage = {
        role: "assistant",
        content: "done",
        toolCalls: [],
      } as const;
      lifecycle.settled({
        assistantMessage,
        usage: USAGE,
        stopReason: "stop",
      });
      recovery.terminal({
        messages: [...messages, assistantMessage],
        outcome: "completed",
        consumedInputIds: ["input-terminal"],
      });

      const resumed = resumeSessionStore({
        sessionId: session.id,
        workspace,
        runtime: runtime(home, 2),
      });
      expect(resumed.messages).toEqual([userMessage, assistantMessage]);
      expect(resumed.activeTask).toBeUndefined();
      expect(resumed.lastTaskOutcome).toMatchObject({
        taskId: task.taskId,
        runId: task.runId,
        outcome: "completed",
        recovered: false,
        unknownProviderAttemptIds: [],
      });
      const records = (await readFile(session.filePath, "utf8"))
        .trimEnd()
        .split("\n")
        .map((line) => LEDGER_RECORD_TYPE_SCHEMA.parse(JSON.parse(line)));
      expect(records.map((record) => record.type)).toEqual([
        "session",
        "task_admitted",
        "provider_intent",
        "provider_attempt_settled",
        "provider_settled",
        "task_terminal",
      ]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a provider attempt has no durable response settlement,
    When the session is opened and recovery runs twice across hard crashes,
    Then open is read-only, one replacement keeps the Task id, and the second is blocked`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-task-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-task-home-"));
    let messages: readonly SessionMessage[] = [];

    try {
      const session = createSessionStore({
        sessionId: "task-provider-unknown",
        workspace,
        runtime: runtime(home),
      });
      const initial = createSessionTaskRecovery({
        session: () => session,
        runtime: runtime(home, 1),
        currentMessages: () => messages,
        onMessagesPersisted: (persisted) => {
          messages = persisted;
        },
      });
      const admitted = initial.admit({
        userMessage: {
          role: "user",
          content: "recover me",
          origin: { type: "user_prompt" },
        },
        provider: PROVIDER,
        consumedInputIds: [],
      });
      const firstPending = initial
        .providerLifecycle(PROVIDER)
        .providerRequestAttempts.begin();
      void firstPending;
      const ledgerBeforeOpen = await readFile(session.filePath, "utf8");

      const opened = resumeSessionStore({
        sessionId: session.id,
        workspace,
        runtime: runtime(home, 2),
      });
      expect(await readFile(session.filePath, "utf8")).toBe(ledgerBeforeOpen);
      messages = opened.messages;
      const resumedRecovery = createSessionTaskRecovery({
        session: () => opened,
        runtime: runtime(home, 3),
        currentMessages: () => messages,
        onMessagesPersisted: (persisted) => {
          messages = persisted;
        },
      });
      const replacement = resumedRecovery.resume();
      expect(replacement.kind).toBe("run");
      if (replacement.kind !== "run") throw new Error("expected recovery run");
      expect(replacement.task.taskId).toBe(admitted.taskId);
      expect(replacement.task.runId).not.toBe(admitted.runId);
      expect(replacement.task.providerReplacementsUsed).toBe(1);
      expect(replacement.task.unknownProviderAttemptIds).toHaveLength(1);

      resumedRecovery
        .providerLifecycle(PROVIDER)
        .providerRequestAttempts.begin();
      const blocked = resumedRecovery.resume();
      expect(blocked.kind).toBe("blocked");
      if (blocked.kind !== "blocked") throw new Error("expected blocked Task");
      expect(blocked.task.taskId).toBe(admitted.taskId);
      expect(blocked.task.reason).toBe("provider_replacement_limit");
      expect(blocked.task.providerReplacementsUsed).toBe(1);
      expect(blocked.task.unknownProviderAttemptIds).toHaveLength(2);
      expect(
        resumeSessionStore({
          sessionId: session.id,
          workspace,
          runtime: runtime(home, 4),
        }).activeTask,
      ).toEqual(blocked.task);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a recovery record replaces the stable identity of an active provider attempt,
    When the session ledger is replayed,
    Then resume fails closed instead of accepting the conflicting transition`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-task-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-task-home-"));
    let messages: readonly SessionMessage[] = [];

    try {
      const session = createSessionStore({
        sessionId: "task-conflicting-attempt",
        workspace,
        runtime: runtime(home),
      });
      const recovery = createSessionTaskRecovery({
        session: () => session,
        runtime: runtime(home, 1),
        currentMessages: () => messages,
        onMessagesPersisted: (persisted) => {
          messages = persisted;
        },
      });
      recovery.admit({
        userMessage: {
          role: "user",
          content: "reject conflicting recovery identity",
          origin: { type: "user_prompt" },
        },
        provider: PROVIDER,
        consumedInputIds: [],
      });
      recovery.providerLifecycle(PROVIDER).providerRequestAttempts.begin();
      const records = (await readFile(session.filePath, "utf8"))
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      const intent = PROVIDER_INTENT_RECORD_SCHEMA.parse(records.at(-1));
      await appendFile(
        session.filePath,
        `${JSON.stringify({
          schemaVersion: 10,
          type: "provider_attempt_settled",
          timestamp: "1970-01-01T00:00:02.000Z",
          task: {
            ...intent.task,
            providerAttempt: {
              ...intent.task.providerAttempt,
              attemptId: "provider_attempt_conflict",
              settlement: { outcome: "completed", usage: USAGE },
            },
          },
        })}\n`,
        "utf8",
      );

      expect(() =>
        resumeSessionStore({
          sessionId: session.id,
          workspace,
          runtime: runtime(home, 2),
        }),
      ).toThrow(/provider_attempt_settled.*active provider attempt/u);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a recovery transition omits the pending attempt from unknown evidence,
    When the session ledger is replayed,
    Then resume rejects the transition instead of erasing uncertainty`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-task-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-task-home-"));
    let messages: readonly SessionMessage[] = [];

    try {
      const session = createSessionStore({
        sessionId: "task-erased-unknown-attempt",
        workspace,
        runtime: runtime(home),
      });
      const recovery = createSessionTaskRecovery({
        session: () => session,
        runtime: runtime(home, 1),
        currentMessages: () => messages,
        onMessagesPersisted: (persisted) => {
          messages = persisted;
        },
      });
      recovery.admit({
        userMessage: {
          role: "user",
          content: "preserve provider uncertainty",
          origin: { type: "user_prompt" },
        },
        provider: PROVIDER,
        consumedInputIds: [],
      });
      recovery.providerLifecycle(PROVIDER).providerRequestAttempts.begin();
      const pending = activeSessionTask(session);
      if (pending?.phase !== "provider_pending") {
        throw new Error("missing pending provider attempt");
      }
      await appendFile(
        session.filePath,
        `${JSON.stringify({
          schemaVersion: 10,
          type: "task_recovery_started",
          timestamp: "1970-01-01T00:00:02.000Z",
          task: {
            taskId: pending.taskId,
            runId: "run_conflicting_recovery",
            trigger: pending.trigger,
            admittedAt: pending.admittedAt,
            userMessageId: pending.userMessageId,
            provider: pending.provider,
            maxProviderReplacements: pending.maxProviderReplacements,
            providerReplacementsUsed: 0,
            recovered: true,
            providerRequestIds: pending.providerRequestIds,
            unknownProviderAttemptIds: [],
            toolEffectRecoveryPolicy: pending.toolEffectRecoveryPolicy,
            acceptedUnknownEffectOperationIds:
              pending.acceptedUnknownEffectOperationIds,
            phase: "provider_ready",
          },
        })}\n`,
        "utf8",
      );

      expect(() =>
        resumeSessionStore({
          sessionId: session.id,
          workspace,
          runtime: runtime(home, 2),
        }),
      ).toThrow(/task_recovery_started.*active Task/u);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given current-schema recovery records violate distinct Task transition invariants,
    When each ledger is replayed,
    Then identity, recovery, phase, terminal-evidence, and run-generation conflicts fail closed`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-task-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-task-home-"));

    try {
      for (const scenario of [
        "identity",
        "not_recovered",
        "already_blocked",
        "known_terminal",
        "same_run",
      ] as const) {
        let messages: readonly SessionMessage[] = [];
        const session = createSessionStore({
          sessionId: `task-invalid-recovery-${scenario}`,
          workspace,
          runtime: runtime(home),
        });
        const recovery = createSessionTaskRecovery({
          session: () => session,
          runtime: runtime(home, 1),
          currentMessages: () => messages,
          onMessagesPersisted: (persisted) => {
            messages = persisted;
          },
        });
        recovery.admit({
          userMessage: {
            role: "user",
            content: `reject ${scenario}`,
            origin: { type: "user_prompt" },
          },
          provider: PROVIDER,
          consumedInputIds: [],
        });

        if (scenario === "already_blocked") {
          recovery.blockProviderBudget(messages);
        } else if (scenario === "known_terminal") {
          recovery
            .providerLifecycle(PROVIDER)
            .auxiliaryProviderRequestAttempts.begin()
            .finish({
              outcome: "terminal_error",
              errorCode: "provider_http_error",
            });
        }

        const current = activeSessionTask(session);
        if (current === undefined) throw new Error("missing active Task");
        const readyTask = {
          taskId: scenario === "identity" ? "task_conflicting" : current.taskId,
          runId:
            scenario === "same_run"
              ? current.runId
              : `run_recovery_${scenario}`,
          trigger: current.trigger,
          admittedAt: current.admittedAt,
          userMessageId: current.userMessageId,
          provider: current.provider,
          maxProviderReplacements: current.maxProviderReplacements,
          providerReplacementsUsed: current.providerReplacementsUsed,
          recovered: scenario !== "not_recovered",
          providerRequestIds: current.providerRequestIds,
          unknownProviderAttemptIds: current.unknownProviderAttemptIds,
          toolEffectRecoveryPolicy: current.toolEffectRecoveryPolicy,
          acceptedUnknownEffectOperationIds:
            current.acceptedUnknownEffectOperationIds,
          phase: "provider_ready",
        } as const;
        const nextTask = readyTask;
        await appendFile(
          session.filePath,
          `${JSON.stringify({
            schemaVersion: 10,
            type: "task_recovery_started",
            timestamp: "1970-01-01T00:00:03.000Z",
            task: nextTask,
          })}\n`,
          "utf8",
        );

        expect(() =>
          resumeSessionStore({
            sessionId: session.id,
            workspace,
            runtime: runtime(home, 2),
          }),
        ).toThrow(/task_recovery_started.*active Task/u);
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a provider attempt ends with a known terminal failure,
    When its durable attempt lifecycle finishes,
    Then the Task fails terminally and resume never dispatches a replacement`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-task-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-task-home-"));
    let messages: readonly SessionMessage[] = [];

    try {
      const session = createSessionStore({
        sessionId: "task-provider-terminal-error",
        workspace,
        runtime: runtime(home),
      });
      const recovery = createSessionTaskRecovery({
        session: () => session,
        runtime: runtime(home, 1),
        currentMessages: () => messages,
        onMessagesPersisted: (persisted) => {
          messages = persisted;
        },
      });
      recovery.admit({
        userMessage: {
          role: "user",
          content: "do not retry a known terminal failure",
          origin: { type: "user_prompt" },
        },
        provider: PROVIDER,
        consumedInputIds: [],
      });
      const attempt = recovery
        .providerLifecycle(PROVIDER)
        .providerRequestAttempts.begin();
      attempt.finish({
        outcome: "terminal_error",
        errorCode: "provider_http_error",
      });

      const resumed = resumeSessionStore({
        sessionId: session.id,
        workspace,
        runtime: runtime(home, 2),
      });
      expect(resumed.activeTask).toBeUndefined();
      expect(resumed.lastTaskOutcome).toMatchObject({
        outcome: "failed",
        recovered: false,
        unknownProviderAttemptIds: [],
      });
      expect(recovery.resume()).toEqual({ kind: "none" });
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given context-overflow and abort settlements cross the durable attempt boundary,
    When observers finish or recovery reopens the Task,
    Then each outcome is recorded once and abort terminalizes without replacement`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-task-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-task-home-"));

    try {
      for (const outcome of [
        "context_overflow",
        "aborted",
        "completed",
      ] as const) {
        let messages: readonly SessionMessage[] = [];
        const session = createSessionStore({
          sessionId: `task-${outcome}`,
          workspace,
          runtime: runtime(home),
        });
        const recovery = createSessionTaskRecovery({
          session: () => session,
          runtime: runtime(home, 1),
          currentMessages: () => messages,
          onMessagesPersisted: (persisted) => {
            messages = persisted;
          },
        });
        recovery.admit({
          userMessage: {
            role: "user",
            content: `settle ${outcome}`,
            origin: { type: "user_prompt" },
          },
          provider: PROVIDER,
          consumedInputIds: [],
        });
        const handle = recovery
          .providerLifecycle(PROVIDER)
          .auxiliaryProviderRequestAttempts.begin();
        handle.finish(
          outcome === "completed" ? { outcome, usage: USAGE } : { outcome },
        );
        handle.finish({ outcome: "completed", usage: USAGE });
        expect(activeSessionTask(session)).toMatchObject({
          phase: "provider_pending",
          providerAttempt: { settlement: { outcome } },
        });
        const settledAttemptId =
          activeSessionTask(session)?.providerAttempt?.attemptId;
        if (settledAttemptId === undefined) {
          throw new Error("expected settled provider attempt");
        }

        if (outcome === "aborted") {
          expect(recovery.resume()).toEqual({ kind: "none" });
          expect(session.lastTaskOutcome).toBeUndefined();
          expect(
            resumeSessionStore({
              sessionId: session.id,
              workspace,
              runtime: runtime(home, 2),
            }).lastTaskOutcome,
          ).toMatchObject({ outcome: "aborted" });
        } else if (outcome === "completed") {
          const resumed = recovery.resume();
          expect(resumed.kind).toBe("run");
          if (resumed.kind !== "run") {
            throw new Error("expected completed-attempt recovery");
          }
          expect(resumed.task.unknownProviderAttemptIds).toEqual([
            settledAttemptId,
          ]);
          expect(
            resumeSessionStore({
              sessionId: session.id,
              workspace,
              runtime: runtime(home, 2),
            }).activeTask,
          ).toEqual(resumed.task);
        } else {
          const resumed = recovery.resume();
          expect(resumed.kind).toBe("run");
          if (resumed.kind !== "run") {
            throw new Error("expected context-overflow recovery");
          }
          expect(resumed.task).toMatchObject({
            providerReplacementsUsed: 1,
            unknownProviderAttemptIds: [],
          });
          expect(
            resumeSessionStore({
              sessionId: session.id,
              workspace,
              runtime: runtime(home, 2),
            }).activeTask,
          ).toEqual(resumed.task);
        }
      }

      let mainMessages: readonly SessionMessage[] = [];
      const mainSession = createSessionStore({
        sessionId: "task-main-aborted",
        workspace,
        runtime: runtime(home, 3),
      });
      const mainRecovery = createSessionTaskRecovery({
        session: () => mainSession,
        runtime: runtime(home, 4),
        currentMessages: () => mainMessages,
        onMessagesPersisted: (persisted) => {
          mainMessages = persisted;
        },
      });
      mainRecovery.admit({
        userMessage: {
          role: "user",
          content: "terminalize main abort",
          origin: { type: "user_prompt" },
        },
        provider: PROVIDER,
        consumedInputIds: [],
      });
      mainRecovery
        .providerLifecycle(PROVIDER)
        .providerRequestAttempts.begin()
        .finish({ outcome: "aborted" });
      expect(
        resumeSessionStore({
          sessionId: mainSession.id,
          workspace,
          runtime: runtime(home, 5),
        }).lastTaskOutcome,
      ).toMatchObject({ outcome: "aborted" });
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given no Task or an already blocked Task,
    When provider-budget blocking is requested,
    Then the recovery owner rejects the invalid transition`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-task-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-task-home-"));
    let messages: readonly SessionMessage[] = [];

    try {
      const session = createSessionStore({
        sessionId: "task-invalid-budget-block",
        workspace,
        runtime: runtime(home),
      });
      const recovery = createSessionTaskRecovery({
        session: () => session,
        runtime: runtime(home, 1),
        currentMessages: () => messages,
        onMessagesPersisted: (persisted) => {
          messages = persisted;
        },
      });
      expect(() => recovery.blockProviderBudget(messages)).toThrow(
        /provider budget cannot block/u,
      );
      recovery.admit({
        userMessage: {
          role: "user",
          content: "block once",
          origin: { type: "user_prompt" },
        },
        provider: PROVIDER,
        consumedInputIds: [],
      });
      recovery.blockProviderBudget(messages);
      expect(() => recovery.blockProviderBudget(messages)).toThrow(
        /provider budget cannot block/u,
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given provider-budget blocking occurs before, during, or after a provider request,
    When each current-schema blocked Task is copied and reopened,
    Then every supported optional evidence shape round-trips intact`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-task-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-task-home-"));

    try {
      for (const phase of ["ready", "pending", "settled"] as const) {
        let messages: readonly SessionMessage[] = [];
        const session = createSessionStore({
          sessionId: `task-blocked-shape-${phase}`,
          workspace,
          runtime: runtime(home),
        });
        const recovery = createSessionTaskRecovery({
          session: () => session,
          runtime: runtime(home, 1),
          currentMessages: () => messages,
          onMessagesPersisted: (persisted) => {
            messages = persisted;
          },
        });
        recovery.admit({
          userMessage: {
            role: "user",
            content: `block from ${phase}`,
            origin: { type: "user_prompt" },
          },
          provider: PROVIDER,
          consumedInputIds: [],
        });
        if (phase !== "ready") {
          const lifecycle = recovery.providerLifecycle(PROVIDER);
          lifecycle.providerRequestAttempts
            .begin()
            .finish({ outcome: "completed", usage: USAGE });
          if (phase === "settled") {
            lifecycle.settled({
              assistantMessage: {
                role: "assistant",
                content: "settled before budget block",
                toolCalls: [],
              },
              usage: USAGE,
              stopReason: "stop",
            });
          }
        }
        const blocked = recovery.blockProviderBudget(messages);
        expect(activeSessionTask(session)).toEqual(blocked);

        const opened = resumeSessionStore({
          sessionId: session.id,
          workspace,
          runtime: runtime(home, 2),
        });
        expect(opened.activeTask).toEqual(blocked);
        expect(activeSessionTask(opened)).toEqual(blocked);
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given callers violate durable Task writer preconditions,
    When they try to cross provider, step, recovery, or terminal boundaries,
    Then every boundary fails closed without mutating the active Task`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-task-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-task-home-"));
    const messages: SessionMessage[] = [];

    try {
      const session = createSessionStore({
        sessionId: "task-writer-preconditions",
        workspace,
        runtime: runtime(home),
      });
      expect(() =>
        persistSessionProviderIntent({
          session,
          provider: PROVIDER,
          runtime: runtime(home, 1),
        }),
      ).toThrow(/no active durable Task/u);

      const recovery = createSessionTaskRecovery({
        session: () => session,
        runtime: runtime(home, 2),
        currentMessages: () => messages,
        onMessagesPersisted: (persisted) => {
          messages.splice(0, messages.length, ...persisted);
        },
      });
      const userMessage = {
        role: "user",
        content: "enforce every durable writer precondition",
        origin: { type: "user_prompt" },
      } as const;
      const assistantMessage = {
        role: "assistant",
        content: "durable writer response",
        toolCalls: [],
      } as const;
      recovery.admit({
        userMessage,
        provider: PROVIDER,
        consumedInputIds: [],
      });
      expect(() =>
        recovery.admit({
          userMessage,
          provider: PROVIDER,
          consumedInputIds: [],
        }),
      ).toThrow(/already has active Task/u);
      expect(() =>
        persistSessionProviderResponse({
          session,
          assistantMessage,
          usage: { outcome: "completed", usage: USAGE },
          stopReason: "stop",
          runtime: runtime(home, 3),
        }),
      ).toThrow(/no pending provider attempt/u);
      expect(() =>
        persistSessionProviderIntent({
          session,
          provider: { ...PROVIDER, model: "deepseek-reasoner" },
          runtime: runtime(home, 3),
        }),
      ).toThrow(/captured provider/u);

      const pending = persistSessionProviderIntent({
        session,
        provider: PROVIDER,
        runtime: runtime(home, 4),
      });
      expect(() =>
        persistSessionProviderIntent({
          session,
          provider: PROVIDER,
          runtime: runtime(home, 5),
        }),
      ).toThrow(/not ready for a provider request/u);
      expect(() =>
        persistSessionProviderAttemptSettlement({
          session,
          attemptId: "wrong-attempt",
          settlement: { outcome: "completed", usage: USAGE },
          runtime: runtime(home, 6),
        }),
      ).toThrow(/cannot be settled/u);
      persistSessionProviderAttemptSettlement({
        session,
        attemptId: pending.providerAttempt.attemptId,
        settlement: { outcome: "completed", usage: USAGE },
        runtime: runtime(home, 7),
      });
      expect(() =>
        persistSessionProviderAttemptSettlement({
          session,
          attemptId: pending.providerAttempt.attemptId,
          settlement: { outcome: "completed", usage: USAGE },
          runtime: runtime(home, 8),
        }),
      ).toThrow(/cannot be settled/u);

      expect(() =>
        persistSessionProviderResponse({
          session,
          assistantMessage,
          usage: {
            outcome: "completed",
            usage: { ...USAGE, outputTokens: USAGE.outputTokens + 1 },
          },
          stopReason: "stop",
          runtime: runtime(home, 9),
        }),
      ).toThrow(/does not match attempt/u);
      persistSessionProviderResponse({
        session,
        assistantMessage,
        usage: { outcome: "completed", usage: USAGE },
        stopReason: "stop",
        runtime: runtime(home, 10),
      });
      expect(() =>
        persistSessionTaskStep({
          session,
          currentMessages: [userMessage],
          runtime: runtime(home, 11),
        }),
      ).toThrow(/does not contain response/u);
      expect(() =>
        persistSessionTaskStep({
          session,
          currentMessages: [assistantMessage],
          runtime: runtime(home, 12),
        }),
      ).toThrow(/missing admitted user message/u);
      expect(() =>
        persistSessionTaskTerminal({
          session,
          currentMessages: [userMessage],
          outcome: "completed",
          runtime: runtime(home, 13),
        }),
      ).toThrow(/missing its settled final response/u);

      const otherSession = createSessionStore({
        sessionId: "task-writer-other",
        workspace,
        runtime: runtime(home, 14),
      });
      const otherRecovery = createSessionTaskRecovery({
        session: () => otherSession,
        runtime: runtime(home, 15),
        currentMessages: () => [],
        onMessagesPersisted: () => {},
      });
      const otherTask = otherRecovery.admit({
        userMessage: {
          role: "user",
          content: "different task",
          origin: { type: "user_prompt" },
        },
        provider: PROVIDER,
        consumedInputIds: [],
      });
      expect(() =>
        persistSessionTaskRecoveryState({
          session,
          task: otherTask,
          runtime: runtime(home, 16),
        }),
      ).toThrow(/recovery state does not match/u);
      expect(
        persistSessionTaskStep({
          session,
          currentMessages: [userMessage, assistantMessage],
          runtime: runtime(home, 17),
        }),
      ).toBe(true);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given callers violate durable tool-plan writer preconditions,
    When they start, settle, or commit calls outside the canonical transition,
    Then every invalid transition fails closed and one valid group can commit`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-task-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-task-home-"));
    const userMessage = {
      role: "user",
      content: "enforce tool-plan writer preconditions",
      origin: { type: "user_prompt" },
    } as const;
    const toolCalls = [
      { id: "read_guard", tool: "read", path: "note.txt" },
      {
        id: "write_guard",
        tool: "write",
        path: "result.txt",
        content: "done\n",
      },
    ] as const;
    const assistantMessage = {
      role: "assistant",
      content: "",
      toolCalls,
    } as const;
    const readResult = {
      role: "tool",
      toolCallId: "read_guard",
      content: "read settled",
    } as const;
    const writeResult = {
      role: "tool",
      toolCallId: "write_guard",
      content: "write was not dispatched",
    } as const;

    try {
      const session = createSessionStore({
        sessionId: "tool-writer-preconditions",
        workspace,
        runtime: runtime(home),
      });
      const recovery = createSessionTaskRecovery({
        session: () => session,
        runtime: runtime(home, 1),
        currentMessages: () => [],
        onMessagesPersisted: () => {},
      });
      recovery.admit({
        userMessage,
        provider: PROVIDER,
        consumedInputIds: [],
      });
      expect(() =>
        persistSessionToolIntents({
          session,
          toolCallIds: ["read_guard"],
          runtime: runtime(home, 2),
        }),
      ).toThrow(/no tool plan to start/u);

      const lifecycle = recovery.providerLifecycle(PROVIDER);
      lifecycle.providerRequestAttempts
        .begin()
        .finish({ outcome: "completed", usage: USAGE });
      expect(() =>
        lifecycle.settled({
          assistantMessage: {
            role: "assistant",
            content: "",
            toolCalls: [toolCalls[0], toolCalls[0]],
          },
          usage: USAGE,
          stopReason: "stop",
        }),
      ).toThrow(/duplicate call ids/u);
      lifecycle.settled({
        assistantMessage,
        usage: USAGE,
        stopReason: "stop",
      });
      const plannedTask = activeSessionTask(session);
      if (plannedTask?.phase !== "tool_execution") {
        throw new Error("expected a durable tool plan");
      }
      const writeInvocation = plannedTask.toolInvocations.find(
        (invocation) => invocation.toolCallId === "write_guard",
      );
      if (writeInvocation === undefined) {
        throw new Error("expected the planned write invocation");
      }
      const writeRecoveryResult = {
        ...writeResult,
        recovery: {
          kind: "not_executed_after_restart" as const,
          taskId: plannedTask.taskId,
          runId: writeInvocation.runId,
          operationId: writeInvocation.operationId,
        },
      };
      for (const invalidIds of [
        [],
        ["read_guard", "read_guard"],
        ["unknown_guard"],
      ]) {
        expect(() =>
          persistSessionToolIntents({
            session,
            toolCallIds: invalidIds,
            runtime: runtime(home, 3),
          }),
        ).toThrow(/tool intent/u);
      }

      persistSessionToolIntents({
        session,
        toolCallIds: ["read_guard"],
        runtime: runtime(home, 4),
      });
      expect(() =>
        persistSessionToolIntents({
          session,
          toolCallIds: ["read_guard"],
          runtime: runtime(home, 5),
        }),
      ).toThrow(/is not planned/u);
      expect(() =>
        persistSessionToolSettlement({
          session,
          toolCallId: "unknown_guard",
          settlementKind: "completed",
          toolMessage: readResult,
          effects: { checkpointOperations: [] },
          runtime: runtime(home, 6),
        }),
      ).toThrow(/not in the durable tool plan/u);
      expect(() =>
        persistSessionToolSettlement({
          session,
          toolCallId: "write_guard",
          settlementKind: "completed",
          toolMessage: writeResult,
          effects: { checkpointOperations: [] },
          runtime: runtime(home, 7),
        }),
      ).toThrow(/cannot be settled from phase planned/u);
      expect(() =>
        persistSessionToolSettlement({
          session,
          toolCallId: "read_guard",
          settlementKind: "completed",
          toolMessage: writeResult,
          effects: { checkpointOperations: [] },
          runtime: runtime(home, 8),
        }),
      ).toThrow(/does not match its invocation/u);
      expect(() =>
        persistSessionToolSettlement({
          session,
          toolCallId: "write_guard",
          settlementKind: "not_executed_after_restart",
          toolMessage: writeResult,
          effects: { checkpointOperations: [] },
          runtime: runtime(home, 9),
        }),
      ).toThrow(/evidence is not canonical/u);
      expect(() =>
        persistSessionToolSettlement({
          session,
          toolCallId: "write_guard",
          settlementKind: "interrupted_effect_unknown",
          toolMessage: {
            ...writeRecoveryResult,
            recovery: {
              ...writeRecoveryResult.recovery,
              kind: "interrupted_effect_unknown",
            },
          },
          effects: { checkpointOperations: [] },
          runtime: runtime(home, 9),
        }),
      ).toThrow(/evidence is not canonical/u);
      expect(() =>
        persistSessionToolSettlement({
          session,
          toolCallId: "read_guard",
          settlementKind: "completed",
          toolMessage: {
            ...readResult,
            recovery: {
              kind: "interrupted_no_effect",
              taskId: plannedTask.taskId,
              runId: plannedTask.runId,
              operationId:
                plannedTask.toolInvocations[0]?.operationId ?? "missing",
            },
          },
          effects: { checkpointOperations: [] },
          runtime: runtime(home, 9),
        }),
      ).toThrow(/evidence is not canonical/u);

      persistSessionToolSettlement({
        session,
        toolCallId: "read_guard",
        settlementKind: "completed",
        toolMessage: readResult,
        effects: { checkpointOperations: [] },
        runtime: runtime(home, 9),
      });
      expect(() =>
        persistSessionToolSettlement({
          session,
          toolCallId: "read_guard",
          settlementKind: "interrupted_no_effect",
          toolMessage: readResult,
          effects: { checkpointOperations: [] },
          runtime: runtime(home, 10),
        }),
      ).toThrow(/cannot be settled from phase settled/u);
      expect(() =>
        persistSessionTaskStep({
          session,
          currentMessages: [userMessage, assistantMessage, readResult],
          runtime: runtime(home, 11),
        }),
      ).toThrow(/cannot commit an incomplete tool group/u);

      persistSessionToolSettlement({
        session,
        toolCallId: "write_guard",
        settlementKind: "not_executed_after_restart",
        toolMessage: writeRecoveryResult,
        effects: { checkpointOperations: [] },
        runtime: runtime(home, 12),
      });
      expect(() =>
        persistSessionTaskStep({
          session,
          currentMessages: [userMessage, assistantMessage, readResult],
          runtime: runtime(home, 13),
        }),
      ).toThrow(/incomplete tool calls/u);
      expect(() =>
        persistSessionTaskStep({
          session,
          currentMessages: [
            userMessage,
            assistantMessage,
            { ...readResult, content: "wrong durable result" },
            writeRecoveryResult,
          ],
          runtime: runtime(home, 14),
        }),
      ).toThrow(/missing result.*source order/u);
      expect(
        persistSessionTaskStep({
          session,
          currentMessages: [
            userMessage,
            assistantMessage,
            readResult,
            writeRecoveryResult,
          ],
          runtime: runtime(home, 15),
        }),
      ).toBe(true);
      expect(() =>
        persistSessionToolSettlement({
          session,
          toolCallId: "read_guard",
          settlementKind: "completed",
          toolMessage: readResult,
          effects: { checkpointOperations: [] },
          runtime: runtime(home, 16),
        }),
      ).toThrow(/no active tool execution/u);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given schema-valid ledger records violate admission, provider, or step ordering,
    When replay evaluates each independent invariant,
    Then it rejects active/duplicate admission, orphaned/reused provider records, and orphaned/incomplete steps`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-task-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-task-home-"));

    try {
      let admissionMessages: readonly SessionMessage[] = [];
      const admissionSource = createSessionStore({
        sessionId: "task-ledger-admission-source",
        workspace,
        runtime: runtime(home),
      });
      const admissionRecovery = createSessionTaskRecovery({
        session: () => admissionSource,
        runtime: runtime(home, 1),
        currentMessages: () => admissionMessages,
        onMessagesPersisted: (persisted) => {
          admissionMessages = persisted;
        },
      });
      admissionRecovery.admit({
        userMessage: {
          role: "user",
          content: "admission source",
          origin: { type: "user_prompt" },
        },
        provider: PROVIDER,
        consumedInputIds: [],
      });
      const admissionRecord = (await readFile(admissionSource.filePath, "utf8"))
        .trimEnd()
        .split("\n")
        .map((line) => RECOVERY_LEDGER_RECORD_SCHEMA.parse(JSON.parse(line)))
        .find((record) => record.type === "task_admitted");
      if (
        admissionRecord?.task === undefined ||
        admissionRecord.userMessage === undefined
      ) {
        throw new Error("missing admission source record");
      }
      admissionRecovery.terminal({
        messages: admissionMessages,
        outcome: "failed",
      });
      const admissionTerminal = (
        await readFile(admissionSource.filePath, "utf8")
      )
        .trimEnd()
        .split("\n")
        .map((line) => RECOVERY_LEDGER_RECORD_SCHEMA.parse(JSON.parse(line)))
        .find((record) => record.type === "task_terminal");
      if (admissionTerminal === undefined) {
        throw new Error("missing admission terminal record");
      }

      const admissionCases = [
        {
          name: "active",
          records: [admissionRecord, admissionRecord],
          error: /admitted while another Task was active/u,
        },
        {
          name: "duplicate-message",
          records: [admissionRecord, admissionTerminal, admissionRecord],
          error: /task user message id.*not unique/u,
        },
        {
          name: "mismatched-message",
          records: [
            {
              ...admissionRecord,
              task: {
                ...admissionRecord.task,
                userMessageId: "message_conflicting",
              },
            },
          ],
          error: /task admission does not match/u,
        },
      ];
      for (const scenario of admissionCases) {
        const target = createSessionStore({
          sessionId: `task-ledger-admission-${scenario.name}`,
          workspace,
          runtime: runtime(home, 2),
        });
        await appendFile(
          target.filePath,
          `${scenario.records.map((record) => JSON.stringify(record)).join("\n")}\n`,
          "utf8",
        );
        expect(() =>
          resumeSessionStore({
            sessionId: target.id,
            workspace,
            runtime: runtime(home, 3),
          }),
        ).toThrow(scenario.error);
      }

      let providerMessages: readonly SessionMessage[] = [];
      const providerSource = createSessionStore({
        sessionId: "task-ledger-provider-source",
        workspace,
        runtime: runtime(home, 4),
      });
      const providerRecovery = createSessionTaskRecovery({
        session: () => providerSource,
        runtime: runtime(home, 5),
        currentMessages: () => providerMessages,
        onMessagesPersisted: (persisted) => {
          providerMessages = persisted;
        },
      });
      const userMessage = {
        role: "user",
        content: "provider source",
        origin: { type: "user_prompt" },
      } as const;
      providerRecovery.admit({
        userMessage,
        provider: PROVIDER,
        consumedInputIds: [],
      });
      const lifecycle = providerRecovery.providerLifecycle(PROVIDER);
      lifecycle.providerRequestAttempts
        .begin()
        .finish({ outcome: "completed", usage: USAGE });
      const assistantMessage = {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "read_source", tool: "read", path: "note.txt" }],
      } as const;
      lifecycle.settled({
        assistantMessage,
        usage: USAGE,
        stopReason: "stop",
      });
      lifecycle.beforeToolCalls(assistantMessage.toolCalls);
      lifecycle.toolSettled({
        toolMessage: {
          role: "tool",
          toolCallId: "read_source",
          content: "source",
        },
        effects: { checkpointOperations: [] },
      });
      lifecycle.beforeRequest([
        userMessage,
        assistantMessage,
        { role: "tool", toolCallId: "read_source", content: "source" },
      ]);
      const providerRecords = (await readFile(providerSource.filePath, "utf8"))
        .trimEnd()
        .split("\n")
        .map((line) => RECOVERY_LEDGER_RECORD_SCHEMA.parse(JSON.parse(line)));
      const admission = providerRecords.find(
        (record) => record.type === "task_admitted",
      );
      const intent = providerRecords.find(
        (record) => record.type === "provider_intent",
      );
      const attemptSettled = providerRecords.find(
        (record) => record.type === "provider_attempt_settled",
      );
      const providerSettled = providerRecords.find(
        (record) => record.type === "provider_settled",
      );
      const step = providerRecords.find(
        (record) => record.type === "step_committed",
      );
      if (
        admission === undefined ||
        intent === undefined ||
        attemptSettled === undefined ||
        providerSettled === undefined ||
        step === undefined
      ) {
        throw new Error("missing provider source records");
      }
      const intentTask = z
        .object({
          providerRequestIds: z.array(
            z.object({
              attemptId: z.string(),
              responseMessageId: z.string(),
            }),
          ),
          providerAttempt: z
            .object({
              attemptId: z.string(),
              responseMessageId: z.string(),
              startedAt: z.string(),
            })
            .passthrough(),
        })
        .passthrough()
        .parse(intent.task);
      const settledTask = z
        .object({
          providerRequestIds: z.array(
            z.object({
              attemptId: z.string(),
              responseMessageId: z.string(),
            }),
          ),
          providerAttempt: z
            .object({
              attemptId: z.string(),
              responseMessageId: z.string(),
              startedAt: z.string(),
            })
            .passthrough(),
        })
        .passthrough()
        .parse(attemptSettled.task);
      const newAttemptId = "provider_attempt_reused_response";
      const reusedResponseIntent = {
        ...intent,
        task: {
          ...settledTask,
          providerRequestIds: [
            ...settledTask.providerRequestIds,
            {
              attemptId: newAttemptId,
              responseMessageId: settledTask.providerAttempt.responseMessageId,
            },
          ],
          providerAttempt: {
            attemptId: newAttemptId,
            responseMessageId: settledTask.providerAttempt.responseMessageId,
            startedAt: "1970-01-01T00:00:00.009Z",
          },
        },
      };
      const providerCases = [
        {
          name: "orphaned-intent",
          records: [intent],
          error: /provider_intent.*active Task/u,
        },
        {
          name: "reused-intent",
          records: [admission, intent, intent],
          error: /provider_intent.*valid transition/u,
        },
        {
          name: "intent-carries-settlement",
          records: [
            admission,
            {
              ...intent,
              task: {
                ...intentTask,
                providerAttempt: {
                  ...intentTask.providerAttempt,
                  settlement: { outcome: "completed", usage: USAGE },
                },
              },
            },
          ],
          error: /provider_intent.*valid transition/u,
        },
        {
          name: "reused-settled-attempt",
          records: [admission, intent, attemptSettled, intent],
          error: /provider_intent.*valid transition/u,
        },
        {
          name: "reused-response-id",
          records: [admission, intent, attemptSettled, reusedResponseIntent],
          error: /provider_intent.*valid transition/u,
        },
        {
          name: "orphaned-response",
          records: [providerSettled],
          error: /provider_settled.*active provider attempt/u,
        },
        {
          name: "orphaned-step",
          records: [step],
          error: /step_committed.*active Task/u,
        },
        {
          name: "missing-step-response",
          records: [
            admission,
            intent,
            attemptSettled,
            providerSettled,
            { ...step, messages: [] },
          ],
          error: /step_committed is missing the settled provider response/u,
        },
      ];
      for (const scenario of providerCases) {
        const target = createSessionStore({
          sessionId: `task-ledger-provider-${scenario.name}`,
          workspace,
          runtime: runtime(home, 6),
        });
        await appendFile(
          target.filePath,
          `${scenario.records.map((record) => JSON.stringify(record)).join("\n")}\n`,
          "utf8",
        );
        expect(() =>
          resumeSessionStore({
            sessionId: target.id,
            workspace,
            runtime: runtime(home, 7),
          }),
        ).toThrow(scenario.error);
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given schema-valid tool intent and settlement records are reordered or altered,
    When ledger replay evaluates each tool-plan transition,
    Then orphaned, repeated, unknown, and non-canonical records all fail closed`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-task-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-task-home-"));
    let messages: readonly SessionMessage[] = [];

    try {
      const source = createSessionStore({
        sessionId: "tool-ledger-source",
        workspace,
        runtime: runtime(home),
      });
      const recovery = createSessionTaskRecovery({
        session: () => source,
        runtime: runtime(home, 1),
        currentMessages: () => messages,
        onMessagesPersisted: (persisted) => {
          messages = persisted;
        },
      });
      recovery.admit({
        userMessage: {
          role: "user",
          content: "produce canonical tool ledger records",
          origin: { type: "user_prompt" },
        },
        provider: PROVIDER,
        consumedInputIds: [],
      });
      const lifecycle = recovery.providerLifecycle(PROVIDER);
      lifecycle.providerRequestAttempts
        .begin()
        .finish({ outcome: "completed", usage: USAGE });
      const toolCalls = [
        { id: "ledger_read_one", tool: "read", path: "one.txt" },
        { id: "ledger_read_two", tool: "read", path: "two.txt" },
      ] as const;
      lifecycle.settled({
        assistantMessage: { role: "assistant", content: "", toolCalls },
        usage: USAGE,
        stopReason: "stop",
      });
      const plannedTask = activeSessionTask(source);
      if (plannedTask?.phase !== "tool_execution") {
        throw new Error("expected planned tool Task");
      }
      const {
        providerAttempt: _providerAttempt,
        assistantMessage: _assistantMessage,
        stopReason: _stopReason,
        toolInvocations: _toolInvocations,
        ...plannedTaskBase
      } = plannedTask;
      lifecycle.beforeToolCalls(toolCalls);
      lifecycle.toolSettled({
        toolMessage: {
          role: "tool",
          toolCallId: toolCalls[0].id,
          content: "first read settled",
        },
        effects: { checkpointOperations: [] },
      });

      const records = (await readFile(source.filePath, "utf8"))
        .trimEnd()
        .split("\n")
        .map((line) => RECOVERY_LEDGER_RECORD_SCHEMA.parse(JSON.parse(line)));
      const required = (type: string) => {
        const record = records.find((candidate) => candidate.type === type);
        if (record === undefined) throw new Error(`missing ${type} record`);
        return record;
      };
      const admission = required("task_admitted");
      const providerIntent = required("provider_intent");
      const attemptSettled = required("provider_attempt_settled");
      const providerSettled = required("provider_settled");
      const toolIntent = z
        .object({
          type: z.literal("tool_intent"),
          operationIds: z.array(z.string()),
          task: z
            .object({
              taskId: z.string(),
              toolInvocations: z.array(z.record(z.string(), z.unknown())),
            })
            .passthrough(),
        })
        .passthrough()
        .parse(required("tool_intent"));
      const toolSettled = z
        .object({
          type: z.literal("tool_settled"),
          operationId: z.string(),
          task: z
            .object({
              taskId: z.string(),
              toolInvocations: z.array(z.record(z.string(), z.unknown())),
            })
            .passthrough(),
        })
        .passthrough()
        .parse(required("tool_settled"));
      const settledPrefix = [
        admission,
        providerIntent,
        attemptSettled,
        providerSettled,
      ];
      const invalidToolRecovery = {
        schemaVersion: 10,
        type: "task_recovery_started",
        timestamp: "1970-01-01T00:00:00.009Z",
        task: {
          ...plannedTaskBase,
          runId: "run_invalid_tool_recovery",
          phase: "provider_ready",
          recovered: true,
        },
      };
      const scenarios = [
        {
          name: "orphan-intent",
          records: [toolIntent],
          error: /tool_intent does not match/u,
        },
        {
          name: "wrong-phase-intent",
          records: [admission, toolIntent],
          error: /tool_intent does not match/u,
        },
        {
          name: "wrong-identity-intent",
          records: [
            ...settledPrefix,
            {
              ...toolIntent,
              task: { ...toolIntent.task, taskId: "task_wrong" },
            },
          ],
          error: /tool_intent does not match/u,
        },
        {
          name: "empty-intent",
          records: [...settledPrefix, { ...toolIntent, operationIds: [] }],
          error: /not a valid session mutation record/u,
        },
        {
          name: "duplicate-intent",
          records: [
            ...settledPrefix,
            {
              ...toolIntent,
              operationIds: [
                toolIntent.operationIds[0],
                toolIntent.operationIds[0],
              ],
            },
          ],
          error: /tool_intent does not match/u,
        },
        {
          name: "unknown-intent",
          records: [
            ...settledPrefix,
            { ...toolIntent, operationIds: ["tool_operation_unknown"] },
          ],
          error: /tool_intent is not a canonical transition/u,
        },
        {
          name: "repeated-intent",
          records: [...settledPrefix, toolIntent, toolIntent],
          error: /tool_intent is not a canonical transition/u,
        },
        {
          name: "noncanonical-intent-task",
          records: [
            ...settledPrefix,
            { ...toolIntent, task: providerSettled.task },
          ],
          error: /tool_intent is not a canonical transition/u,
        },
        {
          name: "orphan-settlement",
          records: [toolSettled],
          error: /tool_settled does not match/u,
        },
        {
          name: "wrong-phase-settlement",
          records: [admission, toolSettled],
          error: /tool_settled does not match/u,
        },
        {
          name: "wrong-identity-settlement",
          records: [
            ...settledPrefix,
            toolIntent,
            {
              ...toolSettled,
              task: { ...toolSettled.task, taskId: "task_wrong" },
            },
          ],
          error: /tool_settled does not match/u,
        },
        {
          name: "unknown-settlement",
          records: [
            ...settledPrefix,
            toolIntent,
            { ...toolSettled, operationId: "tool_operation_unknown" },
          ],
          error: /tool_settled is not a canonical transition/u,
        },
        {
          name: "short-settlement-task",
          records: [
            ...settledPrefix,
            toolIntent,
            {
              ...toolSettled,
              task: {
                ...toolSettled.task,
                toolInvocations: toolSettled.task.toolInvocations.slice(0, 1),
              },
            },
          ],
          error: /tool_settled is not a canonical transition/u,
        },
        {
          name: "recovery-from-tool-execution",
          records: [...settledPrefix, invalidToolRecovery],
          error: /task_recovery_started does not match/u,
        },
      ];

      for (const scenario of scenarios) {
        const target = createSessionStore({
          sessionId: `tool-ledger-${scenario.name}`,
          workspace,
          runtime: runtime(home, 2),
        });
        await appendFile(
          target.filePath,
          `${scenario.records.map((record) => JSON.stringify(record)).join("\n")}\n`,
          "utf8",
        );
        expect(() =>
          resumeSessionStore({
            sessionId: target.id,
            workspace,
            runtime: runtime(home, 3),
          }),
        ).toThrow(scenario.error);
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a known terminal provider settlement was durable before the process died,
    When the same Task resumes before its terminal record existed,
    Then recovery terminalizes the failure without another provider request`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-task-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-task-home-"));
    let messages: readonly SessionMessage[] = [];

    try {
      const session = createSessionStore({
        sessionId: "task-terminal-settlement-crash",
        workspace,
        runtime: runtime(home),
      });
      const initial = createSessionTaskRecovery({
        session: () => session,
        runtime: runtime(home, 1),
        currentMessages: () => messages,
        onMessagesPersisted: (persisted) => {
          messages = persisted;
        },
      });
      initial.admit({
        userMessage: {
          role: "user",
          content: "finish the known failure after restart",
          origin: { type: "user_prompt" },
        },
        provider: PROVIDER,
        consumedInputIds: [],
      });
      const pending = initial
        .providerLifecycle(PROVIDER)
        .providerRequestAttempts.begin();
      const activeTask = activeSessionTask(session);
      const attemptId = activeTask?.providerAttempt?.attemptId;
      if (attemptId === undefined) throw new Error("missing provider attempt");
      void pending;
      persistSessionProviderAttemptSettlement({
        session,
        attemptId,
        settlement: {
          outcome: "terminal_error",
          errorCode: "provider_http_error",
        },
        runtime: runtime(home, 2),
      });

      const opened = resumeSessionStore({
        sessionId: session.id,
        workspace,
        runtime: runtime(home, 3),
      });
      messages = opened.messages;
      const resumed = createSessionTaskRecovery({
        session: () => opened,
        runtime: runtime(home, 4),
        currentMessages: () => messages,
        onMessagesPersisted: (persisted) => {
          messages = persisted;
        },
      });
      expect(resumed.resume()).toEqual({ kind: "none" });
      const terminal = resumeSessionStore({
        sessionId: session.id,
        workspace,
        runtime: runtime(home, 5),
      });
      expect(terminal.activeTask).toBeUndefined();
      expect(terminal.lastTaskOutcome?.outcome).toBe("failed");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a terminal record contradicts the recovered Task evidence,
    When the session ledger is replayed,
    Then resume rejects the record instead of erasing interrupted-attempt facts`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-task-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-task-home-"));
    let messages: readonly SessionMessage[] = [];

    try {
      const session = createSessionStore({
        sessionId: "task-terminal-erased-evidence",
        workspace,
        runtime: runtime(home),
      });
      const recovery = createSessionTaskRecovery({
        session: () => session,
        runtime: runtime(home, 1),
        currentMessages: () => messages,
        onMessagesPersisted: (persisted) => {
          messages = persisted;
        },
      });
      recovery.admit({
        userMessage: {
          role: "user",
          content: "keep terminal recovery evidence",
          origin: { type: "user_prompt" },
        },
        provider: PROVIDER,
        consumedInputIds: [],
      });
      recovery.providerLifecycle(PROVIDER).providerRequestAttempts.begin();
      expect(recovery.resume().kind).toBe("run");
      const recovered = activeSessionTask(session);
      if (recovered?.phase !== "provider_ready") {
        throw new Error("missing recovered provider-ready Task");
      }
      await appendFile(
        session.filePath,
        `${JSON.stringify({
          schemaVersion: 10,
          type: "task_terminal",
          timestamp: "1970-01-01T00:00:03.000Z",
          taskId: recovered.taskId,
          runId: recovered.runId,
          messages: [],
          lastTaskOutcome: {
            taskId: recovered.taskId,
            runId: recovered.runId,
            outcome: "failed",
            timestamp: "1970-01-01T00:00:03.000Z",
            recovered: false,
            unknownProviderAttemptIds: [],
            unknownToolEffectOperationIds: [],
          },
        })}\n`,
        "utf8",
      );

      expect(() =>
        resumeSessionStore({
          sessionId: session.id,
          workspace,
          runtime: runtime(home, 2),
        }),
      ).toThrow(/task_terminal.*active Task/u);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a queued steering message is placed before the next provider request,
    When the durable step is checkpointed more than once,
    Then its input id is consumed in exactly one placement mutation`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-task-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-task-home-"));
    let messages: readonly SessionMessage[] = [];
    const committedInputIds = new Set<string>();

    try {
      const session = createSessionStore({
        sessionId: "task-steering-placement",
        workspace,
        runtime: runtime(home),
      });
      const recovery = createSessionTaskRecovery({
        session: () => session,
        runtime: runtime(home, 1),
        currentMessages: () => messages,
        onMessagesPersisted: (persisted) => {
          messages = persisted;
        },
      });
      recovery.admit({
        userMessage: {
          role: "user",
          content: "start a multi-request task",
          origin: { type: "user_prompt" },
        },
        provider: PROVIDER,
        consumedInputIds: [],
      });
      const lifecycle = recovery.providerLifecycle(PROVIDER, {
        pendingInputIds: () =>
          committedInputIds.size === 0 ? [steering.id] : [],
        committed: (inputIds) => {
          for (const inputId of inputIds) committedInputIds.add(inputId);
        },
      });
      const attempt = lifecycle.providerRequestAttempts.begin();
      attempt.finish({ outcome: "completed", usage: USAGE });
      const assistantMessage = {
        role: "assistant",
        content: "first response",
        toolCalls: [],
      } as const;
      lifecycle.settled({
        assistantMessage,
        usage: USAGE,
        stopReason: "stop",
      });
      const steering = persistSessionQueuedInput({
        session,
        sequence: 2,
        line: "steer the next request",
        runtime: runtime(home, 2),
      });
      const steeringMessage = {
        role: "user",
        content: steering.line,
        origin: { type: "steer" },
      } as const;
      const nextMessages = [...messages, assistantMessage, steeringMessage];

      lifecycle.beforeRequest(nextMessages);
      lifecycle.beforeRequest(nextMessages);

      const opened = resumeSessionStore({
        sessionId: session.id,
        workspace,
        runtime: runtime(home, 3),
      });
      expect(opened.pendingInputs).toEqual([]);
      expect(opened.messages).toEqual(nextMessages);
      expect(
        listSessionCatalog({ workspace, runtime: runtime(home, 4) }).sessions[0]
          ?.pendingInputCount,
      ).toBe(0);
      const ledger = await readFile(session.filePath, "utf8");
      expect(
        ledger.split(`"consumedInputIds":["${steering.id}"]`),
      ).toHaveLength(2);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given an auxiliary provider attempt settled before replacement budget admission failed,
    When the Task records the budget decision,
    Then resume returns the same blocked Task without manufacturing completion`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-task-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-task-home-"));
    let messages: readonly SessionMessage[] = [];

    try {
      const session = createSessionStore({
        sessionId: "task-provider-budget-blocked",
        workspace,
        runtime: runtime(home),
      });
      const recovery = createSessionTaskRecovery({
        session: () => session,
        runtime: runtime(home, 1),
        currentMessages: () => messages,
        onMessagesPersisted: (persisted) => {
          messages = persisted;
        },
      });
      recovery.admit({
        userMessage: {
          role: "user",
          content: "preserve me when provider budget is unavailable",
          origin: { type: "user_prompt" },
        },
        provider: PROVIDER,
        consumedInputIds: [],
      });
      const auxiliary = recovery
        .providerLifecycle(PROVIDER)
        .auxiliaryProviderRequestAttempts.begin();
      auxiliary.finish({ outcome: "completed", usage: USAGE });

      const blocked = recovery.blockProviderBudget(messages);
      expect(blocked.reason).toBe("provider_budget");
      expect(blocked.phase).toBe("recovery_blocked");
      expect(blocked.providerAttempt?.settlement?.outcome).toBe("completed");

      const opened = resumeSessionStore({
        sessionId: session.id,
        workspace,
        runtime: runtime(home, 2),
      });
      const resumed = createSessionTaskRecovery({
        session: () => opened,
        runtime: runtime(home, 3),
        currentMessages: () => opened.messages,
        onMessagesPersisted: () => {},
      }).resume();
      expect(resumed.kind).toBe("blocked");
      if (resumed.kind !== "blocked") throw new Error("expected blocked Task");
      expect(resumed.task.reason).toBe("provider_budget");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given the final provider response is settled when the cost policy reaches its cap,
    When the durable Task records the provider-budget stop,
    Then the response evidence is preserved in one structured blocked state`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-task-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-task-home-"));
    let messages: readonly SessionMessage[] = [];

    try {
      const session = createSessionStore({
        sessionId: "task-settled-provider-budget",
        workspace,
        runtime: runtime(home),
      });
      const recovery = createSessionTaskRecovery({
        session: () => session,
        runtime: runtime(home, 1),
        currentMessages: () => messages,
        onMessagesPersisted: (persisted) => {
          messages = persisted;
        },
      });
      recovery.admit({
        userMessage: {
          role: "user",
          content: "stop at the provider budget",
          origin: { type: "user_prompt" },
        },
        provider: PROVIDER,
        consumedInputIds: [],
      });
      const lifecycle = recovery.providerLifecycle(PROVIDER);
      lifecycle.providerRequestAttempts
        .begin()
        .finish({ outcome: "completed", usage: USAGE });
      const assistantMessage = {
        role: "assistant",
        content: "the budget-capped response",
        toolCalls: [],
      } as const;
      lifecycle.settled({
        assistantMessage,
        usage: USAGE,
        stopReason: "stop",
      });
      const blocked = recovery.blockProviderBudget(messages);

      expect(blocked).toMatchObject({
        phase: "recovery_blocked",
        reason: "provider_budget",
        assistantMessage: { message: assistantMessage },
        providerAttempt: { settlement: { outcome: "completed" } },
      });
      const resumed = resumeSessionStore({
        sessionId: session.id,
        workspace,
        runtime: runtime(home, 2),
      });
      expect(resumed.activeTask).toMatchObject({
        phase: "recovery_blocked",
        reason: "provider_budget",
        assistantMessage: { message: assistantMessage },
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a provider attempt has durable terminal evidence,
    When another provider intent tries to overwrite it,
    Then both the live writer and ledger replay reject the transition`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-task-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-task-home-"));
    let messages: readonly SessionMessage[] = [];

    try {
      const session = createSessionStore({
        sessionId: "task-terminal-intent",
        workspace,
        runtime: runtime(home),
      });
      const recovery = createSessionTaskRecovery({
        session: () => session,
        runtime: runtime(home, 1),
        currentMessages: () => messages,
        onMessagesPersisted: (persisted) => {
          messages = persisted;
        },
      });
      recovery.admit({
        userMessage: {
          role: "user",
          content: "do not overwrite terminal evidence",
          origin: { type: "user_prompt" },
        },
        provider: PROVIDER,
        consumedInputIds: [],
      });
      const lifecycle = recovery.providerLifecycle(PROVIDER);
      lifecycle.auxiliaryProviderRequestAttempts.begin().finish({
        outcome: "terminal_error",
        errorCode: "provider_http_error",
      });
      const terminal = activeSessionTask(session);
      if (terminal?.phase !== "provider_pending") {
        throw new Error("missing terminal provider settlement");
      }

      expect(() => lifecycle.auxiliaryProviderRequestAttempts.begin()).toThrow(
        /not ready for a provider request/u,
      );
      await appendFile(
        session.filePath,
        `${JSON.stringify({
          schemaVersion: 10,
          type: "provider_intent",
          timestamp: "1970-01-01T00:00:00.003Z",
          task: {
            ...terminal,
            providerAttempt: {
              attemptId: "provider_attempt_after_terminal",
              responseMessageId: "message_after_terminal",
              startedAt: "1970-01-01T00:00:00.003Z",
            },
          },
        })}\n`,
        "utf8",
      );
      expect(() =>
        resumeSessionStore({
          sessionId: session.id,
          workspace,
          runtime: runtime(home, 2),
        }),
      ).toThrow(/provider_intent.*not a valid transition/u);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a current-schema admission already claims recovery evidence,
    When the ledger is replayed,
    Then resume rejects the non-canonical initial Task projection`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-task-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-task-home-"));

    try {
      const session = createSessionStore({
        sessionId: "task-invalid-admission",
        workspace,
        runtime: runtime(home),
      });
      await appendFile(
        session.filePath,
        `${JSON.stringify({
          schemaVersion: 10,
          type: "task_admitted",
          timestamp: "1970-01-01T00:00:00.001Z",
          task: {
            taskId: "task_invalid",
            runId: "run_invalid",
            trigger: "user_prompt",
            admittedAt: "1970-01-01T00:00:00.001Z",
            userMessageId: "message_invalid",
            provider: PROVIDER,
            maxProviderReplacements: 1,
            providerReplacementsUsed: 1,
            recovered: true,
            providerRequestIds: [],
            unknownProviderAttemptIds: ["attempt_manufactured"],
            toolEffectRecoveryPolicy: "block",
            acceptedUnknownEffectOperationIds: [],
            phase: "provider_ready",
          },
          userMessage: {
            id: "message_invalid",
            message: {
              role: "user",
              content: "manufacture recovery evidence",
              origin: { type: "user_prompt" },
            },
          },
        })}\n`,
        "utf8",
      );

      expect(() =>
        resumeSessionStore({
          sessionId: session.id,
          workspace,
          runtime: runtime(home, 2),
        }),
      ).toThrow(/task admission.*canonical initial Task/u);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given snapshots contain durable tool plans,
    When canonical and independently corrupted metadata is reopened,
    Then canonical active and blocked plans survive while altered identities fail closed`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-task-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-task-home-"));

    try {
      const source = createSessionStore({
        sessionId: "tool-snapshot-source",
        workspace,
        runtime: runtime(home),
      });
      const userMessage = {
        role: "user",
        content: "snapshot the tool plan",
        origin: { type: "user_prompt" },
      } as const;
      const recovery = createSessionTaskRecovery({
        session: () => source,
        runtime: runtime(home, 1),
        currentMessages: () => [],
        onMessagesPersisted: () => {},
      });
      recovery.admit({
        userMessage,
        provider: PROVIDER,
        consumedInputIds: [],
      });
      const lifecycle = recovery.providerLifecycle(PROVIDER);
      lifecycle.providerRequestAttempts
        .begin()
        .finish({ outcome: "completed", usage: USAGE });
      const snapshotToolCalls = [
        { id: "snapshot_read_one", tool: "read", path: "one.txt" },
        { id: "snapshot_read_two", tool: "read", path: "two.txt" },
      ] as const;
      lifecycle.settled({
        assistantMessage: {
          role: "assistant",
          content: "",
          toolCalls: snapshotToolCalls,
        },
        usage: USAGE,
        stopReason: "stop",
      });
      const plannedTask = activeSessionTask(source);
      if (plannedTask?.phase !== "tool_execution") {
        throw new Error("expected planned tool snapshot source");
      }
      const sourceMessages = sessionStoredMessages(source);
      const snapshotRecord = (
        activeTask: unknown,
        stored = sourceMessages,
      ) => ({
        schemaVersion: 10,
        type: "snapshot",
        timestamp: "1970-01-01T00:00:00.010Z",
        reason: "size_threshold",
        messages: stored,
        pendingInputs: [],
        skillStateCheckpoints: [
          { messageOrdinal: 0, skillActivations: [], activeSkillIds: [] },
        ],
        activeTask,
      });
      const reopenSnapshot = async (
        name: string,
        activeTask: unknown,
        stored = sourceMessages,
      ) => {
        const target = createSessionStore({
          sessionId: `tool-snapshot-${name}`,
          workspace,
          runtime: runtime(home, 2),
        });
        await appendFile(
          target.filePath,
          `${JSON.stringify(snapshotRecord(activeTask, stored))}\n`,
          "utf8",
        );
        return () =>
          resumeSessionStore({
            sessionId: target.id,
            workspace,
            runtime: runtime(home, 3),
          });
      };

      const openCanonical = await reopenSnapshot("canonical", plannedTask);
      expect(openCanonical().activeTask).toEqual(plannedTask);

      lifecycle.beforeToolCalls(snapshotToolCalls);
      lifecycle.toolSettled({
        toolMessage: {
          role: "tool",
          toolCallId: snapshotToolCalls[0].id,
          content: "snapshot read settled",
        },
        effects: { checkpointOperations: [] },
      });
      const partiallySettledTask = activeSessionTask(source);
      if (partiallySettledTask?.phase !== "tool_execution") {
        throw new Error("expected partially settled tool snapshot source");
      }
      const openSettled = await reopenSnapshot("settled", partiallySettledTask);
      expect(openSettled().activeTask).toEqual(partiallySettledTask);

      const [firstInvocation, secondInvocation] = plannedTask.toolInvocations;
      if (firstInvocation === undefined || secondInvocation === undefined) {
        throw new Error("expected two planned invocations");
      }
      const corruptions = [
        {
          name: "length",
          task: {
            ...plannedTask,
            toolInvocations: [firstInvocation],
          },
        },
        {
          name: "operation-id",
          task: {
            ...plannedTask,
            toolInvocations: [
              firstInvocation,
              { ...secondInvocation, operationId: firstInvocation.operationId },
            ],
          },
        },
        {
          name: "result-id",
          task: {
            ...plannedTask,
            toolInvocations: [
              firstInvocation,
              {
                ...secondInvocation,
                resultMessageId: firstInvocation.resultMessageId,
              },
            ],
          },
        },
        {
          name: "tool-call-id",
          task: {
            ...plannedTask,
            toolInvocations: [
              firstInvocation,
              { ...secondInvocation, toolCallId: firstInvocation.toolCallId },
            ],
          },
        },
        {
          name: "tool-call-reference",
          task: {
            ...plannedTask,
            toolInvocations: [
              firstInvocation,
              { ...secondInvocation, toolCallId: "snapshot_other_call" },
            ],
          },
        },
        {
          name: "source-index",
          task: {
            ...plannedTask,
            toolInvocations: [
              firstInvocation,
              { ...secondInvocation, sourceIndex: 0 },
            ],
          },
        },
        {
          name: "tool-name",
          task: {
            ...plannedTask,
            toolInvocations: [
              firstInvocation,
              { ...secondInvocation, toolName: "grep" },
            ],
          },
        },
        {
          name: "run-id",
          task: {
            ...plannedTask,
            toolInvocations: [
              firstInvocation,
              { ...secondInvocation, runId: "run_other" },
            ],
          },
        },
      ];
      for (const corruption of corruptions) {
        const openCorrupt = await reopenSnapshot(
          corruption.name,
          corruption.task,
        );
        expect(openCorrupt).toThrow(/invalid tool recovery state/u);
      }

      const [settledInvocation, pendingInvocation] =
        partiallySettledTask.toolInvocations;
      if (
        settledInvocation?.phase !== "settled" ||
        pendingInvocation === undefined
      ) {
        throw new Error("expected one settled snapshot invocation");
      }
      for (const corruption of [
        {
          name: "settled-result-role",
          task: {
            ...partiallySettledTask,
            toolInvocations: [
              {
                ...settledInvocation,
                toolMessage: {
                  ...settledInvocation.toolMessage,
                  message: {
                    role: "assistant",
                    content: "wrong role",
                    toolCalls: [],
                  },
                },
              },
              pendingInvocation,
            ],
          },
        },
        {
          name: "settled-result-call",
          task: {
            ...partiallySettledTask,
            toolInvocations: [
              {
                ...settledInvocation,
                toolMessage: {
                  ...settledInvocation.toolMessage,
                  message: {
                    ...settledInvocation.toolMessage.message,
                    toolCallId: "snapshot_other_call",
                  },
                },
              },
              pendingInvocation,
            ],
          },
        },
        {
          name: "settled-result-id",
          task: {
            ...partiallySettledTask,
            toolInvocations: [
              {
                ...settledInvocation,
                toolMessage: {
                  ...settledInvocation.toolMessage,
                  id: "message_other_result",
                },
              },
              pendingInvocation,
            ],
          },
        },
        {
          name: "completed-with-recovery-metadata",
          task: {
            ...partiallySettledTask,
            toolInvocations: [
              {
                ...settledInvocation,
                toolMessage: {
                  ...settledInvocation.toolMessage,
                  message: {
                    ...settledInvocation.toolMessage.message,
                    recovery: {
                      kind: "interrupted_no_effect",
                      taskId: partiallySettledTask.taskId,
                      runId: settledInvocation.runId,
                      operationId: settledInvocation.operationId,
                    },
                  },
                },
              },
              pendingInvocation,
            ],
          },
        },
      ]) {
        const openCorrupt = await reopenSnapshot(
          corruption.name,
          corruption.task,
        );
        expect(openCorrupt).toThrow(/invalid tool recovery state/u);
      }

      let blockedMessages: readonly SessionMessage[] = [];
      const blockedSource = createSessionStore({
        sessionId: "tool-snapshot-blocked-source",
        workspace,
        runtime: runtime(home, 4),
      });
      const blockedRecovery = createSessionTaskRecovery({
        session: () => blockedSource,
        runtime: runtime(home, 5),
        currentMessages: () => blockedMessages,
        onMessagesPersisted: (persisted) => {
          blockedMessages = persisted;
        },
      });
      blockedRecovery.admit({
        userMessage: {
          role: "user",
          content: "snapshot an unknown tool effect",
          origin: { type: "user_prompt" },
        },
        provider: PROVIDER,
        consumedInputIds: [],
      });
      const blockedLifecycle = blockedRecovery.providerLifecycle(PROVIDER);
      blockedLifecycle.providerRequestAttempts
        .begin()
        .finish({ outcome: "completed", usage: USAGE });
      const blockedToolCall = {
        id: "snapshot_opaque_write",
        tool: "write",
        path: "blocked.txt",
        content: "unknown\n",
      } as const;
      blockedLifecycle.settled({
        assistantMessage: {
          role: "assistant",
          content: "",
          toolCalls: [blockedToolCall],
        },
        usage: USAGE,
        stopReason: "stop",
      });
      blockedLifecycle.beforeToolCalls([blockedToolCall]);
      expect(blockedRecovery.resume().kind).toBe("blocked");
      const blockedTask = activeSessionTask(blockedSource);
      if (
        blockedTask?.phase !== "recovery_blocked" ||
        blockedTask.reason !== "tool_effect"
      ) {
        throw new Error("expected blocked tool snapshot source");
      }
      const openBlocked = await reopenSnapshot(
        "blocked",
        blockedTask,
        sessionStoredMessages(blockedSource),
      );
      expect(openBlocked().activeTask).toEqual(blockedTask);
      const blockedInvocation = blockedTask.toolInvocations?.[0];
      if (
        blockedInvocation?.phase !== "settled" ||
        blockedInvocation.toolMessage.message.role !== "tool"
      ) {
        throw new Error("expected a settled blocked invocation");
      }
      const openMissingRecovery = await reopenSnapshot(
        "blocked-missing-recovery",
        {
          ...blockedTask,
          toolInvocations: [
            {
              ...blockedInvocation,
              toolMessage: {
                ...blockedInvocation.toolMessage,
                message: {
                  role: "tool",
                  toolCallId: blockedInvocation.toolCallId,
                  content: blockedInvocation.toolMessage.message.content,
                },
              },
            },
          ],
        },
        sessionStoredMessages(blockedSource),
      );
      expect(openMissingRecovery).toThrow(/invalid tool recovery state/u);
      const openWrongRecovery = await reopenSnapshot(
        "blocked-wrong-recovery",
        {
          ...blockedTask,
          toolInvocations: [
            {
              ...blockedInvocation,
              toolMessage: {
                ...blockedInvocation.toolMessage,
                message: {
                  ...blockedInvocation.toolMessage.message,
                  recovery: {
                    ...blockedInvocation.toolMessage.message.recovery,
                    runId: "run_other",
                  },
                },
              },
            },
          ],
        },
        sessionStoredMessages(blockedSource),
      );
      expect(openWrongRecovery).toThrow(/invalid tool recovery state/u);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a latest snapshot contains an active Task whose admitted input is absent,
    When the bounded ledger is reopened,
    Then snapshot replay fails before recovery can act on orphaned state`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-task-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-task-home-"));

    try {
      const session = createSessionStore({
        sessionId: "task-invalid-snapshot",
        workspace,
        runtime: runtime(home),
      });
      await appendFile(
        session.filePath,
        `${JSON.stringify({
          schemaVersion: 10,
          type: "snapshot",
          timestamp: "1970-01-01T00:00:00.001Z",
          reason: "size_threshold",
          messages: [
            {
              id: "message_present",
              message: {
                role: "user",
                content: "present input",
                origin: { type: "user_prompt" },
              },
            },
          ],
          pendingInputs: [],
          skillStateCheckpoints: [
            { messageOrdinal: 0, skillActivations: [], activeSkillIds: [] },
          ],
          activeTask: {
            taskId: "task_orphaned",
            runId: "run_orphaned",
            trigger: "user_prompt",
            admittedAt: "1970-01-01T00:00:00.001Z",
            userMessageId: "message_missing",
            provider: PROVIDER,
            maxProviderReplacements: 1,
            providerReplacementsUsed: 0,
            recovered: false,
            providerRequestIds: [],
            unknownProviderAttemptIds: [],
            toolEffectRecoveryPolicy: "block",
            acceptedUnknownEffectOperationIds: [],
            phase: "provider_ready",
          },
        })}\n`,
        "utf8",
      );

      expect(() =>
        resumeSessionStore({
          sessionId: session.id,
          workspace,
          runtime: runtime(home, 2),
        }),
      ).toThrow(/snapshot active Task.*admitted user message/u);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a current-schema snapshot marks its still-active provider attempt as already unknown,
    When the bounded ledger is reopened,
    Then replay rejects the contradictory recovery evidence before deduplication is needed`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-task-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-task-home-"));

    try {
      const session = createSessionStore({
        sessionId: "task-current-attempt-already-unknown",
        workspace,
        runtime: runtime(home),
      });
      await appendFile(
        session.filePath,
        `${JSON.stringify({
          schemaVersion: 10,
          type: "snapshot",
          timestamp: "1970-01-01T00:00:00.001Z",
          reason: "size_threshold",
          messages: [
            {
              id: "message_user",
              message: {
                role: "user",
                content: "do not double count the active attempt",
                origin: { type: "user_prompt" },
              },
            },
          ],
          pendingInputs: [],
          skillStateCheckpoints: [
            { messageOrdinal: 0, skillActivations: [], activeSkillIds: [] },
          ],
          activeTask: {
            taskId: "task_pending_snapshot",
            runId: "run_pending_snapshot",
            trigger: "user_prompt",
            admittedAt: "1970-01-01T00:00:00.001Z",
            userMessageId: "message_user",
            provider: PROVIDER,
            maxProviderReplacements: 1,
            providerReplacementsUsed: 1,
            recovered: true,
            providerRequestIds: [
              {
                attemptId: "provider_attempt_current",
                responseMessageId: "message_response_current",
              },
            ],
            unknownProviderAttemptIds: ["provider_attempt_current"],
            toolEffectRecoveryPolicy: "block",
            acceptedUnknownEffectOperationIds: [],
            phase: "provider_pending",
            providerAttempt: {
              attemptId: "provider_attempt_current",
              responseMessageId: "message_response_current",
              startedAt: "1970-01-01T00:00:00.001Z",
            },
          },
        })}\n`,
        "utf8",
      );

      expect(() =>
        resumeSessionStore({
          sessionId: session.id,
          workspace,
          runtime: runtime(home, 2),
        }),
      ).toThrow(/snapshot active Task has invalid recovery evidence/u);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given current-schema snapshots violate independent provider and terminal evidence invariants,
    When each bounded ledger is reopened,
    Then request history, response ownership, blocked reasons, and last outcomes fail closed`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-task-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-task-home-"));
    const user = {
      id: "message_snapshot_user",
      message: {
        role: "user",
        content: "validate snapshot evidence",
        origin: { type: "user_prompt" },
      },
    } as const;
    const request = {
      attemptId: "provider_attempt_snapshot",
      responseMessageId: "message_snapshot_response",
    } as const;
    const pendingTask = {
      taskId: "task_snapshot",
      runId: "run_snapshot",
      trigger: "user_prompt",
      admittedAt: "1970-01-01T00:00:00.001Z",
      userMessageId: user.id,
      provider: PROVIDER,
      maxProviderReplacements: 1,
      providerReplacementsUsed: 0,
      recovered: false,
      providerRequestIds: [request],
      unknownProviderAttemptIds: [],
      toolEffectRecoveryPolicy: "block",
      acceptedUnknownEffectOperationIds: [],
      phase: "provider_pending",
      providerAttempt: {
        ...request,
        startedAt: "1970-01-01T00:00:00.001Z",
      },
    } as const;
    const completedAttempt = {
      ...pendingTask.providerAttempt,
      settlement: { outcome: "completed", usage: USAGE },
    } as const;
    const assistant = {
      id: request.responseMessageId,
      message: {
        role: "assistant",
        content: "snapshot response",
        toolCalls: [],
      },
    } as const;
    const canonicalReplacementLimitTask = {
      ...pendingTask,
      phase: "recovery_blocked" as const,
      reason: "provider_replacement_limit" as const,
      providerAttempt: completedAttempt,
      providerReplacementsUsed: 1,
      recovered: true,
      unknownProviderAttemptIds: [request.attemptId],
    } as const;

    try {
      const cases = [
        {
          name: "accepted-unknown-without-recovery-evidence",
          activeTask: {
            taskId: pendingTask.taskId,
            runId: pendingTask.runId,
            trigger: pendingTask.trigger,
            admittedAt: pendingTask.admittedAt,
            userMessageId: pendingTask.userMessageId,
            provider: pendingTask.provider,
            maxProviderReplacements: 1,
            providerReplacementsUsed: 0,
            recovered: true,
            providerRequestIds: [],
            unknownProviderAttemptIds: [],
            toolEffectRecoveryPolicy: "accept_unknown" as const,
            acceptedUnknownEffectOperationIds: ["tool_operation_fabricated"],
            phase: "provider_ready" as const,
          },
          messages: [user],
          error: /snapshot active Task has invalid recovery evidence/u,
        },
        {
          name: "request-history",
          activeTask: {
            ...pendingTask,
            providerRequestIds: [
              {
                attemptId: "provider_attempt_other",
                responseMessageId: request.responseMessageId,
              },
            ],
          },
          messages: [user],
          error: /reuses its provider response message id/u,
        },
        {
          name: "response-id-already-stored",
          activeTask: pendingTask,
          messages: [
            user,
            {
              id: request.responseMessageId,
              message: {
                role: "user",
                content: "conflicting response reservation",
                origin: { type: "steer" },
              },
            },
          ],
          error: /reuses its provider response message id/u,
        },
        {
          name: "assistant-without-completed-attempt",
          activeTask: {
            ...pendingTask,
            phase: "recovery_blocked" as const,
            reason: "provider_budget" as const,
            assistantMessage: assistant,
            stopReason: "stop" as const,
          },
          messages: [user],
          error: /settled provider response is invalid/u,
        },
        {
          name: "assistant-without-stop-reason",
          activeTask: {
            ...pendingTask,
            phase: "recovery_blocked" as const,
            reason: "provider_budget" as const,
            providerAttempt: completedAttempt,
            assistantMessage: assistant,
          },
          messages: [user],
          error: /settled provider response is invalid/u,
        },
        {
          name: "stop-without-assistant",
          activeTask: {
            taskId: pendingTask.taskId,
            runId: pendingTask.runId,
            trigger: pendingTask.trigger,
            admittedAt: pendingTask.admittedAt,
            userMessageId: pendingTask.userMessageId,
            provider: pendingTask.provider,
            maxProviderReplacements: 1,
            providerReplacementsUsed: 0,
            recovered: false,
            providerRequestIds: [],
            unknownProviderAttemptIds: [],
            toolEffectRecoveryPolicy: "block" as const,
            acceptedUnknownEffectOperationIds: [],
            phase: "recovery_blocked" as const,
            reason: "provider_budget" as const,
            stopReason: "stop" as const,
          },
          messages: [user],
          error: /invalid provider state/u,
        },
        {
          name: "replacement-limit-without-attempt",
          activeTask: {
            taskId: pendingTask.taskId,
            runId: pendingTask.runId,
            trigger: pendingTask.trigger,
            admittedAt: pendingTask.admittedAt,
            userMessageId: pendingTask.userMessageId,
            provider: pendingTask.provider,
            maxProviderReplacements: 1,
            providerReplacementsUsed: 1,
            recovered: true,
            providerRequestIds: [],
            unknownProviderAttemptIds: [],
            toolEffectRecoveryPolicy: "block" as const,
            acceptedUnknownEffectOperationIds: [],
            phase: "recovery_blocked" as const,
            reason: "provider_replacement_limit" as const,
          },
          messages: [user],
          error: /invalid provider state/u,
        },
        {
          name: "replacement-limit-unrecovered",
          activeTask: {
            ...pendingTask,
            phase: "recovery_blocked" as const,
            reason: "provider_replacement_limit" as const,
            providerAttempt: completedAttempt,
          },
          messages: [user],
          error: /invalid provider state/u,
        },
        {
          name: "replacement-limit-unused-budget",
          activeTask: {
            ...canonicalReplacementLimitTask,
            providerReplacementsUsed: 0,
          },
          messages: [user],
          error: /invalid provider state/u,
        },
        {
          name: "replacement-limit-missing-current-unknown",
          activeTask: {
            ...canonicalReplacementLimitTask,
            unknownProviderAttemptIds: [],
          },
          messages: [user],
          error: /invalid provider state/u,
        },
        {
          name: "replacement-limit-current-unknown-not-latest",
          activeTask: {
            ...canonicalReplacementLimitTask,
            providerRequestIds: [
              {
                attemptId: "provider_attempt_snapshot_prior",
                responseMessageId: "message_snapshot_prior_response",
              },
              request,
            ],
            unknownProviderAttemptIds: [
              request.attemptId,
              "provider_attempt_snapshot_prior",
            ],
          },
          messages: [user],
          error: /invalid provider state/u,
        },
        {
          name: "replacement-limit-known-attempt-marked-unknown",
          activeTask: {
            ...canonicalReplacementLimitTask,
            providerAttempt: {
              ...pendingTask.providerAttempt,
              settlement: { outcome: "context_overflow" as const },
            },
          },
          messages: [user],
          error: /invalid provider state/u,
        },
        {
          name: "replacement-limit-terminal-attempt",
          activeTask: {
            ...canonicalReplacementLimitTask,
            providerAttempt: {
              ...pendingTask.providerAttempt,
              settlement: {
                outcome: "terminal_error" as const,
                errorCode: "provider_http_error",
              },
            },
            unknownProviderAttemptIds: [],
          },
          messages: [user],
          error: /invalid provider state/u,
        },
        {
          name: "replacement-limit-aborted-attempt",
          activeTask: {
            ...canonicalReplacementLimitTask,
            providerAttempt: {
              ...pendingTask.providerAttempt,
              settlement: { outcome: "aborted" as const },
            },
            unknownProviderAttemptIds: [],
          },
          messages: [user],
          error: /invalid provider state/u,
        },
        {
          name: "replacement-limit-with-assistant",
          activeTask: {
            ...canonicalReplacementLimitTask,
            assistantMessage: assistant,
            stopReason: "stop" as const,
          },
          messages: [user],
          error: /invalid provider state/u,
        },
        {
          name: "replacement-limit-with-stop-only",
          activeTask: {
            ...canonicalReplacementLimitTask,
            stopReason: "stop" as const,
          },
          messages: [user],
          error: /invalid provider state/u,
        },
        {
          name: "last-outcome-ungrounded-unknown-effect",
          messages: [user],
          lastTaskOutcome: {
            taskId: "task_terminal_snapshot",
            runId: "run_terminal_snapshot",
            outcome: "completed_with_unknown_effects" as const,
            timestamp: "1970-01-01T00:00:00.001Z",
            recovered: true,
            unknownProviderAttemptIds: [],
            unknownToolEffectOperationIds: ["tool_operation_fabricated"],
          },
          error: /snapshot last Task outcome is invalid/u,
        },
        {
          name: "last-outcome-duplicate-unknown",
          messages: [user],
          lastTaskOutcome: {
            taskId: "task_terminal_snapshot",
            runId: "run_terminal_snapshot",
            outcome: "failed" as const,
            timestamp: "1970-01-01T00:00:00.001Z",
            recovered: true,
            unknownProviderAttemptIds: ["attempt_unknown", "attempt_unknown"],
            unknownToolEffectOperationIds: [],
          },
          error: /snapshot last Task outcome is invalid/u,
        },
        {
          name: "last-outcome-unrecovered-unknown",
          messages: [user],
          lastTaskOutcome: {
            taskId: "task_terminal_snapshot",
            runId: "run_terminal_snapshot",
            outcome: "failed" as const,
            timestamp: "1970-01-01T00:00:00.001Z",
            recovered: false,
            unknownProviderAttemptIds: ["attempt_unknown"],
            unknownToolEffectOperationIds: [],
          },
          error: /snapshot last Task outcome is invalid/u,
        },
        {
          name: "last-outcome-missing-response",
          messages: [user],
          lastTaskOutcome: {
            taskId: "task_terminal_snapshot",
            runId: "run_terminal_snapshot",
            outcome: "completed" as const,
            timestamp: "1970-01-01T00:00:00.001Z",
            recovered: false,
            unknownProviderAttemptIds: [],
            unknownToolEffectOperationIds: [],
            responseMessageId: "message_missing_response",
          },
          error: /snapshot last Task outcome is invalid/u,
        },
      ];

      for (const scenario of cases) {
        const session = createSessionStore({
          sessionId: `task-snapshot-invariant-${scenario.name}`,
          workspace,
          runtime: runtime(home),
        });
        await appendFile(
          session.filePath,
          `${JSON.stringify({
            schemaVersion: 10,
            type: "snapshot",
            timestamp: "1970-01-01T00:00:00.001Z",
            reason: "size_threshold",
            messages: scenario.messages,
            pendingInputs: [],
            skillStateCheckpoints: [
              { messageOrdinal: 0, skillActivations: [], activeSkillIds: [] },
            ],
            ...(scenario.activeTask === undefined
              ? {}
              : { activeTask: scenario.activeTask }),
            ...(scenario.lastTaskOutcome === undefined
              ? {}
              : { lastTaskOutcome: scenario.lastTaskOutcome }),
          })}\n`,
          "utf8",
        );

        expect(() =>
          resumeSessionStore({
            sessionId: session.id,
            workspace,
            runtime: runtime(home, 2),
          }),
        ).toThrow(scenario.error);
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a latest snapshot mismatches the settled response and reserved response id,
    When the bounded ledger is reopened,
    Then snapshot replay rejects the unsafe provider projection`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-task-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-task-home-"));

    try {
      const session = createSessionStore({
        sessionId: "task-invalid-settled-snapshot",
        workspace,
        runtime: runtime(home),
      });
      await appendFile(
        session.filePath,
        `${JSON.stringify({
          schemaVersion: 10,
          type: "snapshot",
          timestamp: "1970-01-01T00:00:00.001Z",
          reason: "size_threshold",
          messages: [
            {
              id: "message_user",
              message: {
                role: "user",
                content: "settle safely",
                origin: { type: "user_prompt" },
              },
            },
          ],
          pendingInputs: [],
          skillStateCheckpoints: [
            { messageOrdinal: 0, skillActivations: [], activeSkillIds: [] },
          ],
          activeTask: {
            taskId: "task_bad_settlement",
            runId: "run_bad_settlement",
            trigger: "user_prompt",
            admittedAt: "1970-01-01T00:00:00.001Z",
            userMessageId: "message_user",
            provider: PROVIDER,
            maxProviderReplacements: 1,
            providerReplacementsUsed: 0,
            recovered: false,
            providerRequestIds: [
              {
                attemptId: "provider_attempt_snapshot",
                responseMessageId: "message_reserved",
              },
            ],
            unknownProviderAttemptIds: [],
            toolEffectRecoveryPolicy: "block",
            acceptedUnknownEffectOperationIds: [],
            phase: "provider_settled",
            providerAttempt: {
              attemptId: "provider_attempt_snapshot",
              responseMessageId: "message_reserved",
              startedAt: "1970-01-01T00:00:00.001Z",
              settlement: { outcome: "completed", usage: USAGE },
            },
            assistantMessage: {
              id: "message_wrong",
              message: {
                role: "assistant",
                content: "unsafe",
                toolCalls: [],
              },
            },
            stopReason: "stop",
          },
        })}\n`,
        "utf8",
      );

      expect(() =>
        resumeSessionStore({
          sessionId: session.id,
          workspace,
          runtime: runtime(home, 2),
        }),
      ).toThrow(/snapshot settled provider response is invalid/u);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given in-turn compaction shifts the admitted prompt before a committed provider step,
    When the process dies and reopens the provider-ready Task,
    Then the stable prompt id still resolves and automatic recovery can run`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-task-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-task-home-"));
    let messages: readonly SessionMessage[] = [];

    try {
      const session = createSessionStore({
        sessionId: "task-compacted-step",
        workspace,
        runtime: runtime(home),
      });
      const recovery = createSessionTaskRecovery({
        session: () => session,
        runtime: runtime(home, 1),
        currentMessages: () => messages,
        onMessagesPersisted: (persisted) => {
          messages = persisted;
        },
      });
      const userMessage = {
        role: "user",
        content: "retain my stable recovery identity",
        origin: { type: "user_prompt" },
      } as const;
      const admitted = recovery.admit({
        userMessage,
        provider: PROVIDER,
        consumedInputIds: [],
      });
      const lifecycle = recovery.providerLifecycle(PROVIDER);
      lifecycle.providerRequestAttempts
        .begin()
        .finish({ outcome: "completed", usage: USAGE });
      const assistantMessage = {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "read_once", tool: "read", path: "note.txt" }],
      } as const;
      lifecycle.settled({
        assistantMessage,
        usage: USAGE,
        stopReason: "stop",
      });
      lifecycle.beforeToolCalls(assistantMessage.toolCalls);
      lifecycle.toolSettled({
        toolMessage: {
          role: "tool",
          toolCallId: "read_once",
          content: "stable",
        },
        effects: { checkpointOperations: [] },
      });
      const compactedMessages: readonly SessionMessage[] = [
        {
          role: "user",
          content: "Earlier context was compacted.",
          origin: { type: "compaction_checkpoint" },
        },
        userMessage,
        assistantMessage,
        { role: "tool", toolCallId: "read_once", content: "stable" },
      ];
      lifecycle.beforeRequest(compactedMessages);

      const opened = resumeSessionStore({
        sessionId: session.id,
        workspace,
        runtime: runtime(home, 2),
      });
      expect(opened.activeTask).toMatchObject({
        taskId: admitted.taskId,
        phase: "provider_ready",
      });
      const directive = createSessionTaskRecovery({
        session: () => opened,
        runtime: runtime(home, 3),
        currentMessages: () => opened.messages,
        onMessagesPersisted: () => {},
      }).resume();
      expect(directive).toMatchObject({
        kind: "run",
        userMessage,
      });
      expect(
        listSessionCatalog({ workspace, runtime: runtime(home, 4) }).sessions,
      ).toEqual([
        expect.objectContaining({
          id: session.id,
          preview: "Earlier context was compacted.",
        }),
      ]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a committed step tries to erase prior physical request identities,
    When a later intent reuses the erased attempt and response ids,
    Then replay rejects the step before identity reuse can be accepted`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-task-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-task-home-"));
    let messages: readonly SessionMessage[] = [];

    try {
      const session = createSessionStore({
        sessionId: "task-request-id-reuse",
        workspace,
        runtime: runtime(home),
      });
      const recovery = createSessionTaskRecovery({
        session: () => session,
        runtime: runtime(home, 1),
        currentMessages: () => messages,
        onMessagesPersisted: (persisted) => {
          messages = persisted;
        },
      });
      const userMessage = {
        role: "user",
        content: "preserve every physical request identity",
        origin: { type: "user_prompt" },
      } as const;
      recovery.admit({
        userMessage,
        provider: PROVIDER,
        consumedInputIds: [],
      });
      const lifecycle = recovery.providerLifecycle(PROVIDER);
      lifecycle.providerRequestAttempts
        .begin()
        .finish({ outcome: "completed", usage: USAGE });
      const assistantMessage = {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "read_identity", tool: "read", path: "note.txt" }],
      } as const;
      lifecycle.settled({
        assistantMessage,
        usage: USAGE,
        stopReason: "stop",
      });
      lifecycle.beforeToolCalls(assistantMessage.toolCalls);
      lifecycle.toolSettled({
        toolMessage: {
          role: "tool",
          toolCallId: "read_identity",
          content: "stable",
        },
        effects: { checkpointOperations: [] },
      });
      lifecycle.beforeRequest([
        userMessage,
        assistantMessage,
        { role: "tool", toolCallId: "read_identity", content: "stable" },
      ]);

      const lines = (await readFile(session.filePath, "utf8"))
        .trimEnd()
        .split("\n");
      const stepIndex = lines.findIndex(
        (line) =>
          LEDGER_RECORD_TYPE_SCHEMA.parse(JSON.parse(line)).type ===
          "step_committed",
      );
      const step = STEP_COMMITTED_RECORD_SCHEMA.parse(
        JSON.parse(lines[stepIndex] ?? "{}"),
      );
      const [firstRequest] = step.task.providerRequestIds;
      if (firstRequest === undefined) {
        throw new Error("missing first provider request identity");
      }
      const corruptedStep = {
        ...step,
        task: { ...step.task, providerRequestIds: [] },
      };
      lines[stepIndex] = JSON.stringify(corruptedStep);
      await writeFile(session.filePath, `${lines.join("\n")}\n`, "utf8");
      await appendFile(
        session.filePath,
        `${JSON.stringify({
          schemaVersion: 10,
          type: "provider_intent",
          timestamp: "1970-01-01T00:00:00.009Z",
          task: {
            ...corruptedStep.task,
            phase: "provider_pending",
            providerRequestIds: [firstRequest],
            providerAttempt: {
              ...firstRequest,
              startedAt: "1970-01-01T00:00:00.009Z",
            },
          },
        })}\n`,
        "utf8",
      );

      expect(() =>
        resumeSessionStore({
          sessionId: session.id,
          workspace,
          runtime: runtime(home, 2),
        }),
      ).toThrow(/step_committed.*active Task/u);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given transport failures settle before the process repeatedly dies,
    When each fresh process would reset the provider retry controller,
    Then the durable cross-process replacement limit still blocks the second restart`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-task-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-task-home-"));
    let messages: readonly SessionMessage[] = [];

    try {
      const session = createSessionStore({
        sessionId: "task-known-retry-limit",
        workspace,
        runtime: runtime(home),
      });
      const recovery = createSessionTaskRecovery({
        session: () => session,
        runtime: runtime(home, 1),
        currentMessages: () => messages,
        onMessagesPersisted: (persisted) => {
          messages = persisted;
        },
      });
      recovery.admit({
        userMessage: {
          role: "user",
          content: "bound retries across process death",
          origin: { type: "user_prompt" },
        },
        provider: PROVIDER,
        consumedInputIds: [],
      });
      const first = recovery
        .providerLifecycle(PROVIDER)
        .providerRequestAttempts.begin();
      first.finish({
        outcome: "retryable_error",
        retryDecision: {
          provider: "deepseek",
          reason: "provider_server_error",
          attempt: 0,
          maxRetries: 2,
          delayMs: 0,
        },
      });
      const replacement = recovery.resume();
      expect(replacement.kind).toBe("run");
      if (replacement.kind !== "run") throw new Error("expected retry run");
      expect(replacement.task.providerReplacementsUsed).toBe(1);
      expect(replacement.task.unknownProviderAttemptIds).toEqual([]);

      const second = recovery
        .providerLifecycle(PROVIDER)
        .providerRequestAttempts.begin();
      second.finish({
        outcome: "retryable_error",
        retryDecision: {
          provider: "deepseek",
          reason: "provider_server_error",
          attempt: 0,
          maxRetries: 2,
          delayMs: 0,
        },
      });
      const blocked = recovery.resume();
      expect(blocked.kind).toBe("blocked");
      if (blocked.kind !== "blocked") throw new Error("expected retry block");
      expect(blocked.task.reason).toBe("provider_replacement_limit");
      expect(blocked.task.providerReplacementsUsed).toBe(1);
      expect(blocked.task.unknownProviderAttemptIds).toEqual([]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a process dies after Task admission but before provider intent,
    When recovery starts a fresh Agent Run,
    Then it preserves the Task id without consuming provider replacement allowance`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-task-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-task-home-"));
    let messages: readonly SessionMessage[] = [];

    try {
      const session = createSessionStore({
        sessionId: "task-admitted-before-provider",
        workspace,
        runtime: runtime(home),
      });
      const recovery = createSessionTaskRecovery({
        session: () => session,
        runtime: runtime(home, 1),
        currentMessages: () => messages,
        onMessagesPersisted: (persisted) => {
          messages = persisted;
        },
      });
      const admitted = recovery.admit({
        userMessage: {
          role: "user",
          content: "resume before any request",
          origin: { type: "user_prompt" },
        },
        provider: PROVIDER,
        consumedInputIds: [],
      });

      const resumed = recovery.resume();
      expect(resumed.kind).toBe("run");
      if (resumed.kind !== "run") throw new Error("expected admitted recovery");
      expect(resumed.task.taskId).toBe(admitted.taskId);
      expect(resumed.task.runId).not.toBe(admitted.runId);
      expect(resumed.task.providerReplacementsUsed).toBe(0);
      expect(resumed.task.unknownProviderAttemptIds).toEqual([]);
      recovery.terminal({
        messages: [
          {
            role: "user",
            content: "Compacted durable Task transcript.",
            origin: { type: "compaction_checkpoint" },
          },
          {
            role: "assistant",
            content: "failed after compaction",
            toolCalls: [],
          },
        ],
        outcome: "failed",
      });
      expect(
        resumeSessionStore({
          sessionId: session.id,
          workspace,
          runtime: runtime(home, 2),
        }).messages,
      ).toEqual([
        {
          role: "user",
          content: "Compacted durable Task transcript.",
          origin: { type: "compaction_checkpoint" },
        },
        {
          role: "assistant",
          content: "failed after compaction",
          toolCalls: [],
        },
      ]);
      expect(
        listSessionCatalog({ workspace, runtime: runtime(home, 3) }).sessions,
      ).toEqual([
        expect.objectContaining({
          id: session.id,
          preview: "Compacted durable Task transcript.",
        }),
      ]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a complete provider response is durable but not terminal,
    When recovery resumes text or a tool plan,
    Then text commits without a request and an old tool plan is not dispatched`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-task-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-task-home-"));

    try {
      for (const scenario of ["text", "tool"] as const) {
        let messages: readonly SessionMessage[] = [];
        const session = createSessionStore({
          sessionId: `settled-${scenario}`,
          workspace,
          runtime: runtime(home),
        });
        const recovery = createSessionTaskRecovery({
          session: () => session,
          runtime: runtime(home, 1),
          currentMessages: () => messages,
          onMessagesPersisted: (persisted) => {
            messages = persisted;
          },
        });
        recovery.admit({
          userMessage: {
            role: "user",
            content: scenario,
            origin: { type: "user_prompt" },
          },
          provider: PROVIDER,
          consumedInputIds: [],
        });
        const lifecycle = recovery.providerLifecycle(PROVIDER);
        lifecycle.providerRequestAttempts
          .begin()
          .finish({ outcome: "completed", usage: USAGE });
        lifecycle.settled({
          assistantMessage:
            scenario === "text"
              ? { role: "assistant", content: "complete", toolCalls: [] }
              : {
                  role: "assistant",
                  content: "",
                  toolCalls: [
                    { id: "old-bash", tool: "bash", command: "echo unsafe" },
                  ],
                },
          usage: USAGE,
          stopReason: "stop",
        });
        const opened = resumeSessionStore({
          sessionId: session.id,
          workspace,
          runtime: runtime(home, 2),
        });
        messages = opened.messages;
        let providerRequests = 0;
        const resumed = createSessionTaskRecovery({
          session: () => opened,
          runtime: runtime(home, 3),
          currentMessages: () => messages,
          onMessagesPersisted: (persisted) => {
            messages = persisted;
          },
        });
        const directive = resumed.resume();
        if (directive.kind === "run") providerRequests++;

        expect(providerRequests).toBe(scenario === "text" ? 0 : 1);
        expect(directive.kind).toBe(scenario === "text" ? "delivered" : "run");
        if (scenario === "tool" && directive.kind === "run") {
          expect(directive.recoveredMessages.at(-1)).toMatchObject({
            role: "tool",
            toolCallId: "old-bash",
          });
          expect(JSON.stringify(directive.recoveredMessages.at(-1))).toContain(
            "not_executed_after_restart",
          );
          expect(
            resumeSessionStore({
              sessionId: session.id,
              workspace,
              runtime: runtime(home, 4),
            }).activeTask,
          ).toMatchObject({
            taskId: directive.task.taskId,
            runId: directive.task.runId,
            phase: "provider_ready",
            recovered: true,
          });
        }
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a source session owns an active Task,
    When it is forked,
    Then the fork copies only committed transcript and drops execution ownership`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-task-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-task-home-"));
    let messages: readonly SessionMessage[] = [];

    try {
      const source = createSessionStore({
        sessionId: "active-task-source",
        workspace,
        runtime: runtime(home),
      });
      const recovery = createSessionTaskRecovery({
        session: () => source,
        runtime: runtime(home, 1),
        currentMessages: () => messages,
        onMessagesPersisted: (persisted) => {
          messages = persisted;
        },
      });
      recovery.admit({
        userMessage: {
          role: "user",
          content: "owned only by source",
          origin: { type: "user_prompt" },
        },
        provider: PROVIDER,
        consumedInputIds: [],
      });
      const restoredSource = resumeSessionStore({
        sessionId: source.id,
        workspace,
        runtime: runtime(home, 2),
      });

      const fork = forkSessionStore({
        source: restoredSource,
        targetSessionId: "active-task-fork",
        runtime: runtime(home, 3),
      });
      expect(fork.messages).toEqual(restoredSource.messages);
      expect(fork.activeTask).toBeUndefined();
      expect(fork.lastTaskOutcome).toBeUndefined();
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given an active Task grows the ledger past the snapshot threshold and exhausts provider replacement,
    When each bounded recovery state is reopened,
    Then both provider-ready and replacement-limit evidence survive`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-task-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-task-home-"));
    let messages: readonly SessionMessage[] = [];

    try {
      const session = createSessionStore({
        sessionId: "active-task-snapshot",
        workspace,
        runtime: runtime(home),
      });
      const recovery = createSessionTaskRecovery({
        session: () => session,
        runtime: runtime(home, 1),
        currentMessages: () => messages,
        onMessagesPersisted: (persisted) => {
          messages = persisted;
        },
      });
      const admitted = recovery.admit({
        userMessage: {
          role: "user",
          content: "x".repeat(16 * 1024 * 1024),
          origin: { type: "user_prompt" },
        },
        provider: PROVIDER,
        consumedInputIds: [],
      });

      const records = (await readFile(session.filePath, "utf8"))
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(records.at(-1)).toMatchObject({
        type: "snapshot",
        activeTask: {
          taskId: admitted.taskId,
          runId: admitted.runId,
          phase: "provider_ready",
        },
      });
      const resumed = resumeSessionStore({
        sessionId: session.id,
        workspace,
        runtime: runtime(home, 2),
      });
      expect(resumed.activeTask).toMatchObject({
        taskId: admitted.taskId,
        runId: admitted.runId,
        phase: "provider_ready",
      });

      recovery.providerLifecycle(PROVIDER).providerRequestAttempts.begin();
      const replacement = recovery.resume();
      expect(replacement.kind).toBe("run");
      if (replacement.kind !== "run") {
        throw new Error("expected first provider replacement");
      }
      recovery.providerLifecycle(PROVIDER).providerRequestAttempts.begin();
      const blocked = recovery.resume();
      expect(blocked.kind).toBe("blocked");
      if (blocked.kind !== "blocked") {
        throw new Error("expected provider replacement limit");
      }
      expect(blocked.task).toMatchObject({
        phase: "recovery_blocked",
        reason: "provider_replacement_limit",
        providerReplacementsUsed: 1,
        recovered: true,
      });
      expect(blocked.task.unknownProviderAttemptIds).toHaveLength(2);
      expect(blocked.task.unknownProviderAttemptIds.at(-1)).toBe(
        blocked.task.providerAttempt?.attemptId,
      );

      const resumedBlocked = resumeSessionStore({
        sessionId: session.id,
        workspace,
        runtime: runtime(home, 3),
      });
      expect(resumedBlocked.activeTask).toEqual(blocked.task);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given replacement is exhausted after a provider attempt completed without a durable response,
    When that blocked Task becomes a snapshot root,
    Then replay accepts its current attempt as the latest unknown attempt`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-task-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-task-home-"));
    let messages: readonly SessionMessage[] = [];
    const userMessage = {
      role: "user",
      content: "preserve completed attempt uncertainty in snapshot",
      origin: { type: "user_prompt" },
    } as const;

    try {
      const session = createSessionStore({
        sessionId: "completed-attempt-limit-snapshot",
        workspace,
        runtime: runtime(home),
      });
      const recovery = createSessionTaskRecovery({
        session: () => session,
        runtime: runtime(home, 1),
        currentMessages: () => messages,
        onMessagesPersisted: (persisted) => {
          messages = persisted;
        },
      });
      const admitted = recovery.admit({
        userMessage,
        provider: PROVIDER,
        consumedInputIds: [],
      });
      recovery.providerLifecycle(PROVIDER).providerRequestAttempts.begin();
      const replacement = recovery.resume();
      if (replacement.kind !== "run") {
        throw new Error("expected first provider replacement");
      }
      recovery
        .providerLifecycle(PROVIDER)
        .providerRequestAttempts.begin()
        .finish({ outcome: "completed", usage: USAGE });
      const blocked = recovery.resume();
      if (blocked.kind !== "blocked") {
        throw new Error("expected provider replacement limit");
      }

      await appendFile(
        session.filePath,
        `${JSON.stringify({
          schemaVersion: 10,
          type: "snapshot",
          timestamp: "1970-01-01T00:00:03.000Z",
          reason: "size_threshold",
          messages: [{ id: admitted.userMessageId, message: userMessage }],
          pendingInputs: [],
          skillStateCheckpoints: [
            {
              messageOrdinal: 0,
              skillActivations: [],
              activeSkillIds: [],
            },
          ],
          activeTask: blocked.task,
        })}\n`,
        "utf8",
      );

      const reopened = resumeSessionStore({
        sessionId: session.id,
        workspace,
        runtime: runtime(home, 2),
      });
      expect(reopened.activeTask).toEqual(blocked.task);
      expect(reopened.activeTask?.unknownProviderAttemptIds.at(-1)).toBe(
        blocked.task.providerAttempt?.attemptId,
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });
});
