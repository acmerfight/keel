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
  persistSessionQueuedInput,
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

  test(`Given an active Task grows the ledger past the snapshot threshold,
    When the session is reopened from the bounded snapshot,
    Then the same active Task and provider-ready phase survive`, async () => {
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
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });
});
