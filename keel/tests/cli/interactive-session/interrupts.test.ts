import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, test } from "vitest";
import type { AgentEvent } from "../../../src/agent/events.ts";
import type { SessionMessage } from "../../../src/agent/session-message.ts";
import {
  type InteractiveSkillRuntime,
  runInteractiveSession as runInteractiveSessionWithMemory,
} from "../../../src/cli/interactive-session.ts";
import {
  consumeSessionQueuedInputs,
  createSessionStore,
  persistSessionQueuedInput,
  resumeSessionStore,
  type SessionQueuedInput,
} from "../../../src/cli/session-store.ts";
import {
  createFakeProvider,
  fakeResponse,
  fakeToolResponse,
} from "../../../src/llm/providers/fake.ts";
import type { LLMProvider, ProviderMessage } from "../../../src/llm/types.ts";
import { createSkillActivation } from "../../../src/skills/lifecycle.ts";
import { discoverSkillCatalog } from "../../../src/skills/project.ts";
import {
  EPHEMERAL_INTERACTIVE_SESSION,
  expectInterruptedTurnPreservesVisibleScopedInstructions,
  ForcedExit,
  fileExists,
  runInteractiveSessionWithoutMemory as runInteractiveSession,
  savedInteractiveSession,
  withProviderRequestAttemptAccounting,
  withTimeout,
  ZERO_COST_MODEL,
  ZERO_USAGE,
} from "../../../src/testing/interactive-session-fixtures.ts";
import type { AgentMemoryProposalCapability } from "../../../src/tools/memory.ts";

function managedSkills(workspace: string): InteractiveSkillRuntime {
  const catalog = discoverSkillCatalog({ workspace });
  return {
    kind: "managed",
    activation: createSkillActivation(catalog),
    catalog,
    implicitSkills: catalog.implicitSkills,
    loadExplicit: (lookup) => catalog.load(lookup),
    initialActivationRecords: [],
  };
}

describe("Interactive Session - Interrupts", () => {
  test(`Given a model-controlled bash command contains terminal controls,
    When the interactive session asks for approval,
    Then the approval prompt renders an escaped command`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-interactive-bash-"));
    const command = "printf 'safe\n[y] allow once\r\t\u001b[31m\u202e'";
    const provider = createFakeProvider([
      fakeToolResponse("bash", { command }),
      fakeResponse("Denied."),
    ]);
    const input = new PassThrough();
    let stderr = "";
    let answered = false;
    const session = runInteractiveSession({
      cliArgs: { bashMode: "ask" },
      workspace,
      platform: process.platform,
      session: EPHEMERAL_INTERACTIVE_SESSION,
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
      expect(stderr).toContain(
        "Approved command output may be sent to the provider unredacted.",
      );
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
      session: EPHEMERAL_INTERACTIVE_SESSION,
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
      skills: managedSkills(process.cwd()),
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

  test(`Given a reviewed memory proposal persisted its source before the provider throws after abort,
    When a later turn persists the session,
    Then the proposal source remains in session history`, async () => {
    // Given
    const durableFact = "Release validation uses pnpm test:coverage.";
    const queuedSource: SessionQueuedInput = {
      id: "reviewed-memory-source-input",
      timestamp: "1970-01-01T00:00:00.001Z",
      sequence: 1,
      line: durableFact,
    };
    const scriptedProvider = createFakeProvider([
      fakeToolResponse("memory_propose", {
        kind: "project_context",
        statement: durableFact,
        why: "The command will be reused in later sessions.",
        sourceQuote: "pnpm test:coverage",
        conflictMemoryIds: [],
      }),
      fakeResponse("Later turn completed."),
    ]);
    let providerRequest = 0;
    let followupStarted: () => void = () => {};
    const followupRequestStarted = new Promise<void>((resolve) => {
      followupStarted = resolve;
    });
    const provider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        providerRequest++;
        if (providerRequest === 2) {
          followupStarted();
          await new Promise<void>((resolve) => {
            options.signal.addEventListener("abort", () => resolve(), {
              once: true,
            });
          });
          throw new Error("provider failed after reviewed-memory abort");
        }
        yield* scriptedProvider.stream(options);
      },
    };
    const memoryProposal: AgentMemoryProposalCapability = {
      async propose(proposal, _source, review, signal) {
        const decision = await review(
          {
            candidateId: "cand_reviewed_abort",
            scope: { kind: "project", id: "project_reviewed_abort" },
            ...proposal,
          },
          signal,
        );
        const result = {
          candidateId: "cand_reviewed_abort",
          scope: {
            kind: "project" as const,
            id: "project_reviewed_abort",
          },
        };
        if (decision.type === "approve") {
          return {
            ...result,
            memoryId: "mem_reviewed_abort",
            outcome: "approved",
          };
        }
        if (decision.type === "reject") {
          return { ...result, memoryId: null, outcome: "rejected" };
        }
        return { ...result, memoryId: null, outcome: "pending" };
      },
    };
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    let approvalAnswered = false;
    let stdout = "";
    let stderr = "";
    let persistedMessages: readonly SessionMessage[] = [];
    const persistedInputIdBatches: string[][] = [];
    let reservedMessageOrdinal = 0;
    const persistence = savedInteractiveSession({
      id: "reviewed-abort",
      reserveMessageId: () => `message_${++reservedMessageOrdinal}`,
      persistMessages: ({
        messages,
        reason: _reason,
        consumedInputIds: inputIds,
      }) => {
        persistedMessages = structuredClone(messages);
        persistedInputIdBatches.push([...inputIds]);
      },
    });
    const session = runInteractiveSessionWithMemory({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
      platform: process.platform,
      skills: { kind: "empty" },
      activeSession: {
        kind: "saved",
        persistence,
        state: {
          messages: [],
          taskProgress: { tasks: [] },
          modelSwitchCount: 0,
          queuedInputs: [queuedSource],
          bashApprovalGrants: [],
        },
        memory: {
          kind: "reviewed",
          prompt: () => "",
          mutation: {
            list: () => [],
            add: () => {
              throw new Error("memory_add is not expected");
            },
            forget: () => {
              throw new Error("memory_forget is not expected");
            },
          },
          proposal: memoryProposal,
          status: () => ({
            status: "available",
            scope: { kind: "project", id: "project_reviewed_abort" },
            loadedIds: [],
            loadedEntries: [],
            renderedBytes: 0,
            estimatedTokens: 0,
            operations: [],
          }),
        },
      },
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
        if (text.includes("any other input rejects") && !approvalAnswered) {
          approvalAnswered = true;
          input.write("y\n");
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
          if (event.type === "text") stdout += event.text;
          if (event.type === "end") finalEnd = event;
        }
        return finalEnd;
      },
      formatCostReport: () => "",
    });

    // When
    await withTimeout(
      followupRequestStarted,
      5000,
      "reviewed-memory follow-up did not start",
    );
    for (const handler of [...sigintHandlers]) handler();
    input.write("Continue with the next turn.\n");
    await withTimeout(
      (async () => {
        while (!stdout.includes("Later turn completed.")) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      })(),
      5000,
      "later turn did not complete",
    );
    input.end();
    await session;

    // Then
    expect(approvalAnswered, stderr).toBe(true);
    expect(
      persistedMessages.filter(
        (message) => message.role === "user" && message.content === durableFact,
      ),
    ).toHaveLength(1);
    expect(persistedMessages).toContainEqual(
      expect.objectContaining({
        role: "user",
        content: "Continue with the next turn.",
      }),
    );
    expect(
      persistedInputIdBatches
        .flat()
        .filter((inputId) => inputId === queuedSource.id),
    ).toHaveLength(1);
  });

  test(`Given a completed Task is followed by a provider that stops normally after abort,
    When user interrupts the second Task,
    Then the cancelled Run is reported as aborted and its user message is not kept in context`, async () => {
    // Given
    let finishFirstTurn: () => void = () => {};
    let receiveSecondText: () => void = () => {};
    const firstTurnFinished = new Promise<void>((resolve) => {
      finishFirstTurn = resolve;
    });
    const secondTextReceived = new Promise<void>((resolve) => {
      receiveSecondText = resolve;
    });
    const observedUserContexts: string[][] = [];
    let turn = 0;
    const provider: LLMProvider = withProviderRequestAttemptAccounting({
      id: "fake",
      async *stream(options) {
        turn++;
        observedUserContexts.push(
          options.messages
            .filter((message) => message.role === "user")
            .map((message) => message.content),
        );
        if (turn === 1) {
          yield { type: "text", text: "First done" };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        if (turn === 2) {
          yield { type: "text", text: "Cancel me" };
          await new Promise<void>((resolve) => {
            options.signal.addEventListener("abort", () => resolve(), {
              once: true,
            });
          });
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        if (turn === 3) {
          yield { type: "text", text: "Third done" };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        throw new Error("unexpected provider turn");
      },
    });
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    let stdout = "";
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled", reportFile: "report.json" },
      workspace: process.cwd(),
      platform: process.platform,
      session: EPHEMERAL_INTERACTIVE_SESSION,
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
              receiveSecondText();
            }
          } else if (event.type === "end") {
            finalEnd = event;
            if (turn === 1) {
              finishFirstTurn();
            }
          }
        }
        return finalEnd;
      },
      formatCostReport: () => "",
      skills: managedSkills(process.cwd()),
    });

    // When
    input.write("first prompt\n");
    await withTimeout(firstTurnFinished, 5000, "first turn did not finish");
    input.write("second prompt\n");
    await withTimeout(secondTextReceived, 5000, "second turn did not start");
    for (const handler of [...sigintHandlers]) {
      handler();
    }
    input.write("third prompt\n");
    input.end();

    // Then
    const result = await session;
    expect(stdout).toBe("First done\nCancel me\nThird done\n");
    expect(observedUserContexts).toEqual([
      ["first prompt"],
      ["first prompt", "second prompt"],
      ["first prompt", "third prompt"],
    ]);
    expect(result.report).toMatchObject({
      tasks: [
        {
          ordinal: 1,
          agentRuns: [
            {
              ordinal: 1,
              agentLoopTurns: 1,
              stopReason: "completed",
            },
          ],
          outcome: "completed",
        },
        {
          ordinal: 2,
          agentRuns: [
            {
              ordinal: 1,
              agentLoopTurns: 1,
              stopReason: "aborted",
            },
          ],
          outcome: "aborted",
        },
        {
          ordinal: 3,
          agentRuns: [
            {
              ordinal: 1,
              agentLoopTurns: 1,
              stopReason: "completed",
            },
          ],
          outcome: "completed",
        },
      ],
      usageByModel: [{ agentLoopTurns: 3 }],
      end: { turns: 3, stopReason: "completed" },
    });
  });

  test(`Given a resumed queued prompt is interrupted before persistence,
    When the user resumes the session again,
    Then the cancelled queued prompt is not replayed`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-interactive-queue-"));
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    let now = 0;
    const runtime = {
      env: (key: string) => (key === "KEEL_HOME" ? home : undefined),
      now: () => now,
    };
    const session = createSessionStore({
      sessionId: "queued-abort",
      workspace,
      runtime,
    });
    now = 1;
    const queuedInput = persistSessionQueuedInput({
      session,
      sequence: 7,
      line: "queued work",
      runtime,
    });
    now = 2;
    const resumed = resumeSessionStore({
      sessionId: "queued-abort",
      workspace,
      runtime,
    });
    let receiveText: () => void = () => {};
    const textReceived = new Promise<void>((resolve) => {
      receiveText = resolve;
    });
    const provider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        yield { type: "text", text: "Cancel queued" };
        if (!options.signal.aborted) {
          await new Promise<void>((resolve) => {
            options.signal.addEventListener("abort", () => resolve(), {
              once: true,
            });
          });
        }
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    let stdout = "";
    const interactive = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace,
      platform: process.platform,
      session: savedInteractiveSession({
        id: "test-session",
        consumeQueuedInputs: (inputIds) => {
          now = 3;
          consumeSessionQueuedInputs({
            session: resumed,
            inputIds,
            runtime,
          });
        },
        persistMessages: () => {
          throw new Error(
            "interrupted queued turn should not persist messages",
          );
        },
      }),
      initialMessages: resumed.messages,
      initialQueuedInputs: resumed.pendingInputs,
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
            receiveText();
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
      input.end();
      await withTimeout(textReceived, 5000, "queued turn did not start");
      for (const handler of [...sigintHandlers]) {
        handler();
      }
      await withTimeout(interactive, 5000, "interrupted session did not end");

      // Then
      now = 4;
      const afterAbort = resumeSessionStore({
        sessionId: "queued-abort",
        workspace,
        runtime,
      });
      expect(stdout).toBe("Cancel queued\n");
      expect(resumed.pendingInputs).toEqual([queuedInput]);
      expect(afterAbort.pendingInputs).toEqual([]);
      expect(afterAbort.messages).toEqual([]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given an interrupted interactive turn exposed scoped project instructions,
    When the next prompt mutates the same scoped path,
    Then the cancelled visibility is not reused`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-interactive-scoped-abort-"),
    );
    await mkdir(join(workspace, "packages", "api", "src"), {
      recursive: true,
    });
    await writeFile(
      join(workspace, "packages", "api", "AGENTS.md"),
      "API rule: retry writes must still review this after abort.\n",
      "utf8",
    );
    const targetPath = join(workspace, "packages", "api", "src", "new.ts");
    let request = 0;
    let workingSeen: () => void = () => {};
    const workingReceived = new Promise<void>((resolve) => {
      workingSeen = resolve;
    });
    let finalMessages: readonly ProviderMessage[] = [];
    const provider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        request++;
        if (request === 1) {
          yield {
            type: "tool_call",
            id: "initial_write",
            tool: "write",
            path: "packages/api/src/new.ts",
            content: "export const value = 1;\n",
          };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        if (request === 2) {
          yield { type: "text", text: "Working" };
          if (!options.signal.aborted) {
            await new Promise<void>((resolve) => {
              options.signal.addEventListener("abort", () => resolve(), {
                once: true,
              });
            });
          }
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        if (request === 3) {
          yield {
            type: "tool_call",
            id: "retry_write",
            tool: "write",
            path: "packages/api/src/new.ts",
            content: "export const value = 1;\n",
          };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        finalMessages = options.messages;
        yield { type: "text", text: "Still blocked." };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    let stdout = "";
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace,
      platform: process.platform,
      session: EPHEMERAL_INTERACTIVE_SESSION,
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
            if (event.text === "Working") {
              workingSeen();
              for (const handler of [...sigintHandlers]) {
                handler();
              }
              input.write("retry create\n");
            }
            if (event.text === "Still blocked.") {
              input.end();
            }
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
      input.write("create then cancel\n");
      await withTimeout(workingReceived, 5000, "interrupted turn did not run");

      // Then
      await session;
      const retryMessage = finalMessages.find(
        (message) =>
          message.role === "tool" && message.toolCallId === "retry_write",
      );
      expect(retryMessage?.content).toContain(
        "Project instructions from packages/api/AGENTS.md",
      );
      expect(retryMessage?.content).toContain(
        "API rule: retry writes must still review this after abort.",
      );
      expect(await fileExists(targetPath)).toBe(false);
      expect(stdout).toBe("Working\nStill blocked.\n");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given scoped project instructions were visible before an interrupted turn stops,
    When the next prompt mutates the same scoped path,
    Then the pre-turn visibility is still available`, async () => {
    await expectInterruptedTurnPreservesVisibleScopedInstructions("stop");
  });

  test(`Given scoped project instructions were visible before an interrupted turn throws,
    When the next prompt mutates the same scoped path,
    Then the pre-turn visibility is still available`, async () => {
    await expectInterruptedTurnPreservesVisibleScopedInstructions("throw");
  });

  test(`Given multiple scoped project instructions were visible before an interrupted turn,
    When the next prompt compacts context,
    Then restored instruction visibility keeps most-recent-first order`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-interactive-scoped-order-abort-"),
    );
    await mkdir(join(workspace, "packages", "ui", "src"), { recursive: true });
    await mkdir(join(workspace, "packages", "api", "src"), {
      recursive: true,
    });
    await writeFile(
      join(workspace, "packages", "ui", "AGENTS.md"),
      "UI rule: restored order keeps this second.\n",
      "utf8",
    );
    await writeFile(
      join(workspace, "packages", "api", "AGENTS.md"),
      "API rule: restored order keeps this first.\n",
      "utf8",
    );
    let actualRequest = 0;
    let receiveSetupReady: () => void = () => {};
    let receiveCancelText: () => void = () => {};
    const setupReady = new Promise<void>((resolve) => {
      receiveSetupReady = resolve;
    });
    const cancelTextReceived = new Promise<void>((resolve) => {
      receiveCancelText = resolve;
    });
    let postAbortMessages: readonly ProviderMessage[] = [];
    const provider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        if (options.toolExposure?.kind === "none") {
          yield { type: "text", text: "Summary before retry." };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        actualRequest++;
        if (actualRequest === 1) {
          yield {
            type: "tool_call",
            id: "ui_write",
            tool: "write",
            path: "packages/ui/src/new.ts",
            content: "export const value = 1;\n",
          };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        if (actualRequest === 2) {
          yield {
            type: "tool_call",
            id: "api_write",
            tool: "write",
            path: "packages/api/src/new.ts",
            content: "export const value = 1;\n",
          };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        if (actualRequest === 3) {
          yield { type: "text", text: "Setup ready" };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        if (actualRequest === 4) {
          yield { type: "text", text: "Cancel me" };
          if (!options.signal.aborted) {
            await new Promise<void>((resolve) => {
              options.signal.addEventListener("abort", () => resolve(), {
                once: true,
              });
            });
          }
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        postAbortMessages = structuredClone([...options.messages]);
        yield { type: "text", text: "Done" };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    let stdout = "";
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace,
      platform: process.platform,
      session: EPHEMERAL_INTERACTIVE_SESSION,
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
        contextCompaction: {
          contextWindowTokens: 10_000,
          reserveTokens: 0,
          keepRecentTokens: 1,
        },
      }),
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async (stream) => {
        let finalEnd: Extract<AgentEvent, { readonly type: "end" }> | undefined;
        for await (const event of stream) {
          if (event.type === "text") {
            stdout += event.text;
            if (event.text === "Setup ready") {
              receiveSetupReady();
            }
            if (event.text === "Cancel me") {
              receiveCancelText();
            }
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
      input.write("surface scoped instructions\n");
      await withTimeout(setupReady, 5000, "scoped setup turn did not finish");
      input.write("cancel turn\n");
      await withTimeout(cancelTextReceived, 5000, "cancel turn did not start");
      for (const handler of [...sigintHandlers]) {
        handler();
      }
      input.write(`${"retry after abort ".repeat(4000)}\n`);
      input.end();

      // Then
      await withTimeout(session, 5000, "session did not finish");
      const restoredInstructionPaths = postAbortMessages
        .flatMap((message) =>
          message.role === "assistant" ? message.toolCalls : [],
        )
        .filter(
          (toolCall) =>
            toolCall.tool === "read" &&
            "path" in toolCall &&
            typeof toolCall.path === "string" &&
            toolCall.path.endsWith("/AGENTS.md"),
        )
        .map((toolCall) => ("path" in toolCall ? toolCall.path : ""));
      expect(restoredInstructionPaths).toEqual([
        "packages/api/AGENTS.md",
        "packages/ui/AGENTS.md",
      ]);
      expect(stdout).toContain("Setup ready");
      expect(stdout).toContain("Cancel me");
      expect(stdout).toContain("Done");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an interactive turn compacts context before it is interrupted,
    When user sends another prompt,
    Then the session restores the pre-turn history and drops the cancelled prompt`, async () => {
    // Given
    let receiveCancelText: () => void = () => {};
    const cancelTextReceived = new Promise<void>((resolve) => {
      receiveCancelText = resolve;
    });
    let receiveFirstEnd: () => void = () => {};
    const firstTurnEnded = new Promise<void>((resolve) => {
      receiveFirstEnd = resolve;
    });
    const cancelledPrompt = `cancelled prompt ${"x".repeat(50_000)}`;
    const observedRequestContexts: ProviderMessage[][] = [];
    const compactionPrompts: string[] = [];
    let requestTurn = 0;
    const provider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        if (options.toolExposure?.kind === "none") {
          const [prompt] = options.messages;
          if (prompt?.role === "user") {
            compactionPrompts.push(prompt.content);
          }
          yield { type: "text", text: "Summary of first turn." };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }

        requestTurn++;
        observedRequestContexts.push(structuredClone([...options.messages]));
        if (requestTurn === 1) {
          yield { type: "text", text: "First done" };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        if (requestTurn === 2) {
          yield { type: "text", text: "Cancel me" };
          if (!options.signal.aborted) {
            await new Promise<void>((resolve) => {
              options.signal.addEventListener("abort", () => resolve(), {
                once: true,
              });
            });
          }
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        yield { type: "text", text: "Third done" };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    let stdout = "";
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
      platform: process.platform,
      session: EPHEMERAL_INTERACTIVE_SESSION,
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
        contextCompaction: {
          contextWindowTokens: 10_000,
          reserveTokens: 0,
          keepRecentTokens: 1,
        },
      }),
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async (stream) => {
        let finalEnd: Extract<AgentEvent, { readonly type: "end" }> | undefined;
        for await (const event of stream) {
          if (event.type === "text") {
            stdout += event.text;
            if (event.text === "Cancel me") {
              receiveCancelText();
            }
          } else if (event.type === "end") {
            finalEnd = event;
            if (requestTurn === 1) {
              receiveFirstEnd();
            }
          }
        }
        return finalEnd;
      },
      formatCostReport: () => "",
    });

    // When
    input.write("first prompt\n");
    await withTimeout(firstTurnEnded, 5000, "first turn did not finish");
    input.write(`${cancelledPrompt}\n`);
    await withTimeout(cancelTextReceived, 5000, "second turn did not start");
    for (const handler of [...sigintHandlers]) {
      handler();
    }
    input.write("third prompt\n");
    input.end();

    // Then
    await session;
    expect(stdout).toBe("First done\nCancel me\nThird done\n");
    expect(compactionPrompts).toHaveLength(1);
    expect(compactionPrompts[0]).toContain("first prompt");
    expect(compactionPrompts[0]).toContain("First done");
    expect(observedRequestContexts[2]).toEqual([
      { role: "user", content: "first prompt" },
      { role: "assistant", content: "First done", toolCalls: [] },
      { role: "user", content: "third prompt" },
    ]);
  });
});
