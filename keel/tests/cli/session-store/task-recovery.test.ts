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
  persistSessionTaskRecoveryState,
  persistSessionTaskStep,
  persistSessionTaskTerminal,
  resumeSessionStore,
} from "../../../src/cli/session-store.ts";
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
          schemaVersion: 7,
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
          schemaVersion: 7,
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
        "settled_without_tool",
        "already_blocked",
        "known_terminal",
        "same_run",
        "invalid_blocked_reason",
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

        if (scenario === "settled_without_tool") {
          const lifecycle = recovery.providerLifecycle(PROVIDER);
          lifecycle.providerRequestAttempts
            .begin()
            .finish({ outcome: "completed", usage: USAGE });
          lifecycle.settled({
            assistantMessage: {
              role: "assistant",
              content: "text cannot become a blocked tool plan",
              toolCalls: [],
            },
            usage: USAGE,
            stopReason: "stop",
          });
        } else if (scenario === "already_blocked") {
          recovery.blockProviderBudget();
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
          phase: "provider_ready",
        } as const;
        const nextTask =
          scenario === "settled_without_tool"
            ? {
                ...current,
                phase: "recovery_blocked" as const,
                recovered: true,
                reason: "tool_plan" as const,
              }
            : scenario === "invalid_blocked_reason"
              ? {
                  ...current,
                  phase: "recovery_blocked" as const,
                  recovered: true,
                  reason: "tool_plan" as const,
                }
              : readyTask;
        await appendFile(
          session.filePath,
          `${JSON.stringify({
            schemaVersion: 7,
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
      expect(() => recovery.blockProviderBudget()).toThrow(
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
      recovery.blockProviderBudget();
      expect(() => recovery.blockProviderBudget()).toThrow(
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
        const blocked = recovery.blockProviderBudget();
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
          schemaVersion: 7,
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

      const blocked = recovery.blockProviderBudget();
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

      const blocked = recovery.blockProviderBudget();

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
          schemaVersion: 7,
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
          schemaVersion: 7,
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
          schemaVersion: 7,
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
          schemaVersion: 7,
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
            phase: "recovery_blocked" as const,
            reason: "provider_budget" as const,
            stopReason: "stop" as const,
          },
          messages: [user],
          error: /invalid provider state/u,
        },
        {
          name: "tool-plan-without-tools",
          activeTask: {
            ...pendingTask,
            phase: "recovery_blocked" as const,
            reason: "tool_plan" as const,
            providerAttempt: completedAttempt,
            assistantMessage: assistant,
            stopReason: "stop" as const,
          },
          messages: [user],
          error: /invalid provider state/u,
        },
        {
          name: "tool-plan-without-assistant",
          activeTask: {
            ...pendingTask,
            phase: "recovery_blocked" as const,
            reason: "tool_plan" as const,
            providerAttempt: completedAttempt,
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
          name: "last-outcome-duplicate-unknown",
          messages: [user],
          lastTaskOutcome: {
            taskId: "task_terminal_snapshot",
            runId: "run_terminal_snapshot",
            outcome: "failed" as const,
            timestamp: "1970-01-01T00:00:00.001Z",
            recovered: true,
            unknownProviderAttemptIds: ["attempt_unknown", "attempt_unknown"],
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
            schemaVersion: 7,
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
          schemaVersion: 7,
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
          schemaVersion: 7,
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

        expect(providerRequests).toBe(0);
        expect(directive.kind).toBe(
          scenario === "text" ? "delivered" : "blocked",
        );
        if (scenario === "tool" && directive.kind === "blocked") {
          expect(directive.task.reason).toBe("tool_plan");
          const taskRecords = (await readFile(session.filePath, "utf8"))
            .trimEnd()
            .split("\n")
            .map((line) =>
              RECOVERY_LEDGER_RECORD_SCHEMA.parse(JSON.parse(line)),
            )
            .filter((record) => record.task !== undefined);
          const previousTask = taskRecords.at(-2)?.task;
          const blockedTask = taskRecords.at(-1)?.task;
          expect(blockedTask).toEqual({
            ...previousTask,
            phase: "recovery_blocked",
            recovered: true,
            reason: "tool_plan",
          });
          expect(
            resumeSessionStore({
              sessionId: session.id,
              workspace,
              runtime: runtime(home, 4),
            }).activeTask,
          ).toEqual(directive.task);
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
          schemaVersion: 7,
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
