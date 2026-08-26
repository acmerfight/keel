import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import type { AgentEvent } from "../../src/agent/events.ts";
import type { AgentProviderRecoveryLifecycle } from "../../src/agent/loop.ts";
import { sessionLedgerFromMessages } from "../../src/agent/session-ledger.ts";
import type { SessionMessage } from "../../src/agent/session-message.ts";
import type { SessionGoal } from "../../src/core/session-goal.ts";
import {
  emptySessionTaskProgress,
  type SessionTaskProgress,
} from "../../src/core/task-progress.ts";
import { createUndoProtectionTracker } from "../../src/core/undo-protection.ts";
import {
  createFakeProvider,
  fakeResponse,
  fakeToolResponse,
} from "../../src/llm/providers/fake.ts";
import type { LLMProvider } from "../../src/llm/types.ts";
import type { MainBashRuntime } from "../../src/permissions/bash.ts";
import {
  type MainTurnPreparedInvocation,
  type MainTurnQueuedInput,
  type RunMainTurnTransactionOptions,
  runMainTurnTransaction,
} from "../../src/runtime/main-turn-transaction.ts";
import type {
  SkillActivationCapability,
  SkillLifecycleState,
} from "../../src/skills/model.ts";

type EndEvent = Extract<AgentEvent, { readonly type: "end" }>;

interface QueuedInput extends MainTurnQueuedInput {
  readonly line: string;
}

interface HarnessOptions {
  readonly workspace: string;
  readonly controller: AbortController;
  readonly provider: LLMProvider;
  readonly consumed?: readonly QueuedInput[];
  readonly drained?: QueuedInput[];
  readonly deferred?: readonly QueuedInput[];
  readonly persistedInputIds?: Set<string>;
  readonly persistedDrainedCount?: () => number;
  readonly initialGoal?: SessionGoal;
  readonly skill?: {
    readonly activation: SkillActivationCapability;
    readonly before: SkillLifecycleState;
    readonly stateChanged: () => void;
  };
  readonly bash?: MainBashRuntime;
}

function activeGoal(objective: string): SessionGoal {
  return {
    objective,
    status: "active",
    budget: {},
    usage: { turns: 0, tokens: 0, activeTimeMs: 0 },
  };
}

function changedSkillCapability(options: {
  readonly state: SkillLifecycleState;
  readonly restore: (state: SkillLifecycleState) => void;
}): SkillActivationCapability {
  const unused = (): never => {
    throw new Error("unused Skill capability");
  };
  return {
    beginTurn: () => {},
    expose: () => {},
    registerExplicit: () => [],
    activateExplicit: unused,
    search: () => [],
    readResource: unused,
    activate: unused,
    deactivate: unused,
    reload: unused,
    active: () => [],
    activeStatuses: () => [],
    state: () => options.state,
    restore: options.restore,
  };
}

function providerRecoveryLifecycle(
  events: string[],
): AgentProviderRecoveryLifecycle {
  const attempts = { begin: () => ({ finish: () => {} }) };
  return {
    providerRequestAttempts: attempts,
    auxiliaryProviderRequestAttempts: attempts,
    beforeRequest: () => {
      events.push("provider request");
    },
    settled: () => {
      events.push("provider settled");
    },
    beforeToolCalls: () => {
      events.push("tool admitted");
    },
    toolSettled: () => {
      events.push("tool settled");
    },
  };
}

async function collectEnd(
  stream: AsyncIterable<AgentEvent>,
): Promise<EndEvent | undefined> {
  let end: EndEvent | undefined;
  for await (const event of stream) {
    if (event.type === "end") end = event;
  }
  return end;
}

function createHarness(options: HarnessOptions) {
  const initialMessages: readonly SessionMessage[] = [
    { role: "user", content: "prior" },
    { role: "assistant", content: "prior answer", toolCalls: [] },
  ];
  const currentUserMessage = {
    role: "user",
    content: "current",
  } as const;
  const ledger = sessionLedgerFromMessages(initialMessages);
  let taskProgress = emptySessionTaskProgress();
  let goal = options.initialGoal;
  const restoredInputs: QueuedInput[][] = [];
  const consumedInputs: QueuedInput[][] = [];
  const projectSnapshot = [
    { instructionPath: "/workspace/AGENTS.md", relativePath: "AGENTS.md" },
  ];
  const restoreProjectInstructions = vi.fn();
  const report = {
    abort: vi.fn(),
    complete: vi.fn(),
    fail: vi.fn(),
    recordAbortedEnd: vi.fn(),
  };
  const undoProtection = createUndoProtectionTracker();
  const afterCommit = vi.fn(() => "committed");
  const afterAbort = vi.fn(() => "aborted");
  const checkpointUnavailable = vi.fn();
  const preparedInvocation = (): MainTurnPreparedInvocation => ({
    kind: "interactive_turn",
    assembly: {
      workspace: options.workspace,
      provider: options.provider,
      systemPrompt: "You are helpful.",
      signal: options.controller.signal,
      effects: {
        bash: options.bash ?? { kind: "trusted" },
        hiddenWorkspacePaths: [],
      },
    },
    lifecycle: {
      ledger,
      taskProgress,
    },
  });
  const base: Omit<
    RunMainTurnTransactionOptions<QueuedInput, string>,
    "durability"
  > = {
    workspace: options.workspace,
    currentUserMessage,
    signal: options.controller.signal,
    state: {
      ledger,
      taskProgress: {
        current: () => taskProgress,
        restore: (next) => {
          taskProgress = next;
        },
      },
      goal: {
        current: () => goal,
        restore: (next) => {
          goal = next;
        },
      },
      projectInstructions: {
        snapshot: () => projectSnapshot,
        restoreSnapshot: restoreProjectInstructions,
      },
      ...(options.skill === undefined ? {} : { skill: options.skill }),
    },
    input: {
      consumed: options.consumed ?? [],
      drained: options.drained ?? [],
      deferred: options.deferred ?? [],
      persistedInputIds: options.persistedInputIds ?? new Set(),
      persistedDrainedCount: options.persistedDrainedCount ?? (() => 0),
      restore: (inputs) => {
        restoredInputs.push([...inputs]);
      },
      consume: (inputs) => {
        consumedInputs.push([...inputs]);
      },
    },
    updates: { taskProgress: [], goals: [] },
    reservedMessageIds: [],
    persistedMemorySourceMessages: () => null,
    report,
    undoProtection,
    prepareInvocation: preparedInvocation,
    observeEvents: (stream) => stream,
    consumeEvents: collectEnd,
    afterCommit,
    afterAbort,
    checkpointUnavailable,
  };
  return {
    base,
    initialMessages,
    currentUserMessage,
    ledger,
    report,
    afterCommit,
    afterAbort,
    checkpointUnavailable,
    restoredInputs,
    consumedInputs,
    restoreProjectInstructions,
    undoProtection,
    taskProgress: () => taskProgress,
    setTaskProgress: (next: SessionTaskProgress) => {
      taskProgress = next;
    },
    goal: () => goal,
    setGoal: (next: SessionGoal | undefined) => {
      goal = next;
    },
  };
}

function savedPersistence() {
  return {
    persistMessages: vi.fn((_request: unknown) => {}),
    persistTaskProgress: vi.fn((_request: unknown) => {}),
    persistGoal: vi.fn(
      (request: { readonly goal: SessionGoal | null }) =>
        request.goal ?? undefined,
    ),
  };
}

function activeRunReport() {
  const state = { active: true };
  return {
    abort: vi.fn(() => {
      state.active = false;
    }),
    complete: vi.fn(() => {
      state.active = false;
    }),
    fail: vi.fn(() => {
      if (!state.active) {
        throw new Error("internal: no report Agent Run is active");
      }
      state.active = false;
    }),
    recordAbortedEnd: vi.fn(),
  };
}

describe("Main turn transaction", () => {
  test(`Given a new durable Main turn with queued steering,
    When Runtime executes the transaction,
    Then admission precedes invocation and terminal commit consumes only unpersisted input`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-main-turn-durable-"));
    const controller = new AbortController();
    const drained = [
      { line: "persisted steering", inputId: "steer-1" },
      { line: "pending steering", inputId: "steer-2" },
    ];
    const beforeSkill: SkillLifecycleState = {
      skillActivations: [],
      activeSkillIds: [],
    };
    const changedSkill: SkillLifecycleState = {
      skillActivations: [],
      activeSkillIds: ["activated"],
    };
    const skillStateChanged = vi.fn();
    const harness = createHarness({
      workspace,
      controller,
      provider: createFakeProvider([fakeResponse("done")]),
      consumed: [{ line: "prompt", inputId: "prompt-1" }],
      drained,
      skill: {
        activation: changedSkillCapability({
          state: changedSkill,
          restore: vi.fn(),
        }),
        before: beforeSkill,
        stateChanged: skillStateChanged,
      },
    });
    const events: string[] = [];
    const persistence = savedPersistence();
    const admit = vi.fn((_request: unknown) => {
      events.push("admitted");
      return { runId: "run-1" };
    });
    const terminal = vi.fn((request: unknown) => {
      events.push("terminal");
      return request;
    });
    const reservedMessageIds = [
      { message: harness.currentUserMessage, id: "message-1" },
    ];

    try {
      const result = await runMainTurnTransaction({
        ...harness.base,
        reservedMessageIds,
        durability: {
          kind: "durable",
          persistence,
          provider: { providerId: "fake", model: "fake-model" },
          recovery: {
            admit,
            blockProviderBudget: vi.fn(),
            providerLifecycle: (_provider, inputPersistence) => {
              events.push("invocation prepared");
              expect(inputPersistence.pendingInputIds()).toEqual([
                "steer-1",
                "steer-2",
              ]);
              inputPersistence.committed(["steer-1"]);
              return providerRecoveryLifecycle(events);
            },
            terminal,
            finalizeCheckpoint: vi.fn(() => null),
          },
        },
        prepareInvocation: (context) => {
          events.push(`prepare ${context.durableRunId}`);
          return harness.base.prepareInvocation(context);
        },
      });

      expect(result).toBe("committed");
      expect(events).toEqual([
        "admitted",
        "prepare run-1",
        "invocation prepared",
        "provider request",
        "provider settled",
        "terminal",
      ]);
      expect(admit).toHaveBeenCalledWith({
        userMessage: harness.currentUserMessage,
        provider: { providerId: "fake", model: "fake-model" },
        consumedInputIds: ["prompt-1"],
        userMessageId: "message-1",
      });
      expect(terminal).toHaveBeenCalledWith(
        expect.objectContaining({
          outcome: "completed",
          consumedInputIds: ["steer-2"],
          skillState: changedSkill,
        }),
      );
      expect(reservedMessageIds).toEqual([]);
      expect(harness.report.complete).toHaveBeenCalledWith(1, "completed");
      expect(skillStateChanged).toHaveBeenCalledOnce();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a durable Main turn mutates the workspace and exhausts its provider budget,
    When Runtime commits it,
    Then budget blocking and durable checkpoint settlement happen in the same boundary`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-main-turn-budget-"));
    const controller = new AbortController();
    const beforeSkill: SkillLifecycleState = {
      skillActivations: [],
      activeSkillIds: [],
    };
    const changedSkill: SkillLifecycleState = {
      skillActivations: [],
      activeSkillIds: ["activated"],
    };
    const restoreSkill = vi.fn();
    const skillStateChanged = vi.fn();
    const harness = createHarness({
      workspace,
      controller,
      provider: createFakeProvider([
        fakeToolResponse("write", {
          path: "changed.txt",
          content: "yes\n",
        }),
        fakeResponse("done"),
      ]),
      bash: { kind: "trusted" },
      skill: {
        activation: changedSkillCapability({
          state: changedSkill,
          restore: restoreSkill,
        }),
        before: beforeSkill,
        stateChanged: skillStateChanged,
      },
    });
    const events: string[] = [];
    const persistence = savedPersistence();
    const blockProviderBudget = vi.fn();
    const terminal = vi.fn();
    const finalizeCheckpoint = vi.fn(() => ({ written: true }) as const);
    const afterCommit = vi.fn(
      (
        _end: EndEvent | undefined,
        facts: { readonly workspaceChanged: boolean },
      ) => {
        expect(facts.workspaceChanged).toBe(true);
        return "budget committed";
      },
    );

    try {
      const result = await runMainTurnTransaction({
        ...harness.base,
        durability: {
          kind: "durable",
          persistence,
          provider: { providerId: "fake", model: "fake-model" },
          recoveringRunId: "existing-run",
          recovery: {
            admit: vi.fn(),
            blockProviderBudget,
            providerLifecycle: () => providerRecoveryLifecycle(events),
            terminal,
            finalizeCheckpoint,
          },
        },
        consumeEvents: async (stream) => {
          const end = await collectEnd(stream);
          if (end === undefined) throw new Error("missing end event");
          return { ...end, stopReason: "cost_budget" };
        },
        afterCommit,
      });

      expect(result).toBe("budget committed");
      expect(blockProviderBudget).toHaveBeenCalledOnce();
      expect(terminal).not.toHaveBeenCalled();
      expect(finalizeCheckpoint).toHaveBeenCalledOnce();
      expect(harness.undoProtection.summary()).toMatchObject({
        status: "available",
        checkpointsWritten: 1,
      });
      expect(skillStateChanged).toHaveBeenCalledOnce();
      expect(restoreSkill).not.toHaveBeenCalled();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an admitted Main turn is aborted after producing an end event,
    When Runtime rolls it back,
    Then ledger, state, inputs, instructions, Skill state, and accounting return to the snapshot`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-main-turn-abort-"));
    const controller = new AbortController();
    const initialGoal = activeGoal("original goal");
    const drained: QueuedInput[] = [];
    const beforeSkill: SkillLifecycleState = {
      skillActivations: [],
      activeSkillIds: [],
    };
    const restoreSkill = vi.fn();
    const skillStateChanged = vi.fn();
    const harness = createHarness({
      workspace,
      controller,
      provider: createFakeProvider([fakeResponse("partial")]),
      consumed: [
        { line: "restore me", inputId: "queued-1" },
        { line: "already persisted", inputId: "queued-2" },
        { line: "local input" },
      ],
      drained,
      deferred: [{ line: "deferred", inputId: "queued-4" }],
      persistedInputIds: new Set(["queued-2"]),
      persistedDrainedCount: () => 1,
      initialGoal,
      skill: {
        activation: changedSkillCapability({
          state: { skillActivations: [], activeSkillIds: ["changed"] },
          restore: restoreSkill,
        }),
        before: beforeSkill,
        stateChanged: skillStateChanged,
      },
    });

    try {
      const result = await runMainTurnTransaction({
        ...harness.base,
        durability: { kind: "ephemeral" },
        consumeEvents: async (stream) => {
          const end = await collectEnd(stream);
          drained.push(
            { line: "persisted drain", inputId: "queued-2" },
            { line: "restore drain", inputId: "queued-3" },
          );
          harness.setTaskProgress({
            tasks: [{ step: "changed", status: "in_progress" }],
          });
          harness.setGoal(activeGoal("changed goal"));
          controller.abort();
          return end;
        },
      });

      expect(result).toBe("aborted");
      expect(harness.ledger.messages()).toEqual(harness.initialMessages);
      expect(harness.taskProgress()).toEqual(emptySessionTaskProgress());
      expect(harness.goal()).toEqual(initialGoal);
      expect(harness.restoredInputs).toEqual([
        [
          { line: "restore drain", inputId: "queued-3" },
          { line: "deferred", inputId: "queued-4" },
        ],
      ]);
      expect(harness.consumedInputs).toEqual([
        [{ line: "restore me", inputId: "queued-1" }, { line: "local input" }],
      ]);
      expect(harness.restoreProjectInstructions).toHaveBeenCalledOnce();
      expect(restoreSkill).toHaveBeenCalledWith(beforeSkill);
      expect(skillStateChanged).toHaveBeenCalledOnce();
      expect(harness.report.abort).toHaveBeenCalledWith(1);
      expect(harness.report.recordAbortedEnd).toHaveBeenCalledWith(
        expect.objectContaining({ stopReason: "aborted", turns: 1 }),
      );
      expect(harness.afterAbort).toHaveBeenCalledOnce();
      expect(harness.afterCommit).not.toHaveBeenCalled();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given persistence has committed a Main turn and the display adapter then fails,
    When the error leaves the transaction,
    Then Runtime settles without rolling back or misreporting the committed turn as failed`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-main-turn-commit-"));
    const controller = new AbortController();
    const harness = createHarness({
      workspace,
      controller,
      provider: createFakeProvider([fakeResponse("committed")]),
    });
    const displayError = new Error("display failed after commit");

    try {
      await expect(
        runMainTurnTransaction({
          ...harness.base,
          durability: { kind: "ephemeral" },
          afterCommit: () => {
            throw displayError;
          },
        }),
      ).rejects.toBe(displayError);

      expect(harness.ledger.messages()).toContainEqual(
        expect.objectContaining({ role: "assistant", content: "committed" }),
      );
      expect(harness.report.complete).toHaveBeenCalledOnce();
      expect(harness.report.fail).not.toHaveBeenCalled();
      expect(harness.restoreProjectInstructions).not.toHaveBeenCalled();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given cancellation wins before a Main invocation yields accounting,
    When the transaction observes the aborted signal,
    Then Runtime reports a zero-turn abort and restores the admission snapshot`, async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-main-turn-early-abort-"),
    );
    const controller = new AbortController();
    const harness = createHarness({
      workspace,
      controller,
      provider: createFakeProvider([fakeResponse("unused")]),
    });

    try {
      const result = await runMainTurnTransaction({
        ...harness.base,
        durability: { kind: "ephemeral" },
        consumeEvents: async () => {
          controller.abort();
          return undefined;
        },
      });

      expect(result).toBe("aborted");
      expect(harness.report.abort).toHaveBeenCalledWith(0);
      expect(harness.report.recordAbortedEnd).not.toHaveBeenCalled();
      expect(harness.ledger.messages()).toEqual(harness.initialMessages);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given invocation fails while a goal is active,
    When the error crosses the Runtime transaction boundary,
    Then failure reporting and rollback happen once before the error is rethrown`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-main-turn-failure-"));
    const controller = new AbortController();
    const harness = createHarness({
      workspace,
      controller,
      provider: createFakeProvider([fakeResponse("unused")]),
      initialGoal: activeGoal("restore this goal"),
    });
    const invocationError = new Error("invocation assembly failed");

    try {
      await expect(
        runMainTurnTransaction({
          ...harness.base,
          durability: { kind: "ephemeral" },
          prepareInvocation: () => {
            throw invocationError;
          },
        }),
      ).rejects.toBe(invocationError);

      expect(harness.report.fail).toHaveBeenCalledOnce();
      expect(harness.report.abort).not.toHaveBeenCalled();
      expect(harness.ledger.messages()).toEqual(harness.initialMessages);
      expect(harness.restoreProjectInstructions).toHaveBeenCalledOnce();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given saved-session persistence fails after the agent reaches a terminal event,
    When Runtime handles the failed commit,
    Then the active report fails once and the original persistence error survives rollback`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-main-turn-persist-"));
    const controller = new AbortController();
    const deferred = [{ line: "next saved turn", inputId: "deferred-saved" }];
    const harness = createHarness({
      workspace,
      controller,
      provider: createFakeProvider([fakeResponse("not committed")]),
      deferred,
    });
    const persistenceError = new Error("session persistence failed");
    const report = activeRunReport();

    try {
      await expect(
        runMainTurnTransaction({
          ...harness.base,
          durability: {
            kind: "saved",
            persistence: {
              ...savedPersistence(),
              persistMessages: () => {
                throw persistenceError;
              },
            },
          },
          report,
        }),
      ).rejects.toBe(persistenceError);

      expect(report.complete).not.toHaveBeenCalled();
      expect(report.fail).toHaveBeenCalledOnce();
      expect(harness.ledger.messages()).toEqual(harness.initialMessages);
      expect(harness.restoreProjectInstructions).toHaveBeenCalledOnce();
      expect(harness.restoredInputs).toEqual([deferred]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given durable terminal persistence fails after the agent reaches an end event,
    When Runtime handles the failed recovery commit,
    Then the active report fails once and transaction state rolls back`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-main-turn-terminal-"));
    const controller = new AbortController();
    const deferred = [
      { line: "next durable turn", inputId: "deferred-durable" },
    ];
    const harness = createHarness({
      workspace,
      controller,
      provider: createFakeProvider([fakeResponse("not committed")]),
      deferred,
    });
    const terminalError = new Error("durable terminal persistence failed");
    const report = activeRunReport();

    try {
      await expect(
        runMainTurnTransaction({
          ...harness.base,
          durability: {
            kind: "durable",
            persistence: savedPersistence(),
            provider: { providerId: "fake", model: "fake-model" },
            recoveringRunId: "existing-run",
            recovery: {
              admit: vi.fn(),
              blockProviderBudget: vi.fn(),
              providerLifecycle: () => providerRecoveryLifecycle([]),
              terminal: () => {
                throw terminalError;
              },
              finalizeCheckpoint: vi.fn(() => null),
            },
          },
          report,
        }),
      ).rejects.toBe(terminalError);

      expect(report.complete).not.toHaveBeenCalled();
      expect(report.fail).toHaveBeenCalledOnce();
      expect(harness.ledger.messages()).toEqual(harness.initialMessages);
      expect(harness.restoreProjectInstructions).toHaveBeenCalledOnce();
      expect(harness.restoredInputs).toEqual([deferred]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
