import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  createSessionStore,
  forkSessionStore,
  persistSessionMessages,
  persistSessionModelSwitch,
  persistSessionQueuedInput,
  resumeSessionStore,
  SessionStoreError,
} from "../../../src/cli/session-store.ts";
import type { Message } from "../../../src/llm/types.ts";
import {
  headerLine,
  restoredUserMessageId,
  runtime,
  snapshotLine,
} from "../../../src/testing/session-store-fixtures.ts";

describe("Session Store Model Switch", () => {
  test(`Given a queued model switch is persisted,
    When the named session is resumed,
    Then the restored session uses that active model and does not replay the model command`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));

    try {
      const session = createSessionStore({
        sessionId: "model-switch-source",
        workspace,
        runtime: runtime(home),
      });
      const modelInput = persistSessionQueuedInput({
        session,
        sequence: 1,
        line: "/model qwen/qwen3.7-plus",
        runtime: runtime(home, 1),
      });
      const promptInput = persistSessionQueuedInput({
        session,
        sequence: 2,
        line: "continue",
        runtime: runtime(home, 2),
      });

      // When
      persistSessionModelSwitch({
        session,
        from: null,
        to: { providerId: "qwen", model: "qwen3.7-plus" },
        consumedInputIds: [modelInput.id],
        runtime: runtime(home, 3),
      });
      const resumed = resumeSessionStore({
        sessionId: "model-switch-source",
        workspace,
        runtime: runtime(home, 4),
      });

      // Then
      expect(resumed.activeModel).toEqual({
        providerId: "qwen",
        model: "qwen3.7-plus",
      });
      expect(resumed.pendingInputs).toEqual([promptInput]);
      const ledgerLines = (await readFile(session.filePath, "utf8"))
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(ledgerLines.at(-1)).toEqual({
        schemaVersion: 5,
        type: "model_switch",
        timestamp: "1970-01-01T00:00:00.003Z",
        from: null,
        to: { providerId: "qwen", model: "qwen3.7-plus" },
        consumedInputIds: [modelInput.id],
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a model switch is included in a bounded snapshot,
    When the named session is resumed from that snapshot,
    Then the active model is restored with the snapshotted transcript`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const messages: readonly Message[] = [
      {
        role: "user",
        content: "x".repeat(16 * 1024 * 1024),
        origin: { type: "user_prompt" },
      },
    ];

    try {
      const session = createSessionStore({
        sessionId: "model-switch-snapshot",
        workspace,
        runtime: runtime(home),
      });
      persistSessionModelSwitch({
        session,
        from: { providerId: "fake", model: "fake" },
        to: { providerId: "qwen", model: "qwen3.7-plus" },
        runtime: runtime(home, 1),
      });

      // When
      persistSessionMessages({
        session,
        previousMessages: [],
        currentMessages: messages,
        reason: "turn",
        consumedInputIds: [],
        runtime: runtime(home, 2),
      });
      const resumed = resumeSessionStore({
        sessionId: "model-switch-snapshot",
        workspace,
        runtime: runtime(home, 3),
      });

      // Then
      expect(resumed.activeModel).toEqual({
        providerId: "qwen",
        model: "qwen3.7-plus",
      });
      expect(resumed.messages).toEqual(messages);
      const ledgerLines = (await readFile(session.filePath, "utf8"))
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(ledgerLines.at(-1)).toMatchObject({
        type: "snapshot",
        activeModel: { providerId: "qwen", model: "qwen3.7-plus" },
        modelSwitches: [
          {
            timestamp: "1970-01-01T00:00:00.001Z",
            from: { providerId: "fake", model: "fake" },
            to: { providerId: "qwen", model: "qwen3.7-plus" },
            messageOrdinal: 0,
          },
        ],
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a bounded snapshot has an active model but no switch history,
    When the named session is resumed from that snapshot,
    Then resume rejects the inconsistent snapshot model state`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const ledgerWorkspace = await realpath(workspace);
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const messages: readonly Message[] = [
      {
        role: "user",
        content: "remember alpha",
        origin: { type: "user_prompt" },
      },
      {
        role: "assistant",
        content: "Remembered: remember alpha",
        toolCalls: [],
      },
    ];
    await mkdir(join(home, "sessions", "active-model-only-snapshot"), {
      recursive: true,
    });
    await writeFile(
      join(home, "sessions", "active-model-only-snapshot", "ledger.jsonl"),
      [
        headerLine("active-model-only-snapshot", ledgerWorkspace),
        snapshotLine(messages, [], {
          activeModel: { providerId: "qwen", model: "qwen3.7-plus" },
        }),
      ].join("\n"),
      "utf8",
    );

    try {
      // When
      let resumeError: unknown;
      try {
        resumeSessionStore({
          sessionId: "active-model-only-snapshot",
          workspace,
          runtime: runtime(home, 1),
        });
      } catch (error) {
        resumeError = error;
      }

      // Then
      expect(resumeError).toBeInstanceOf(SessionStoreError);
      if (!(resumeError instanceof Error)) {
        throw new Error("Expected resume to throw an Error");
      }
      expect(resumeError.message).toContain(
        'Error: cannot resume session "active-model-only-snapshot": snapshot active model is missing matching model switch history.',
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a bounded snapshot has switch history but no active model,
    When the named session is resumed from that snapshot,
    Then resume rejects the inconsistent snapshot model state`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const ledgerWorkspace = await realpath(workspace);
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const messages: readonly Message[] = [
      {
        role: "user",
        content: "remember alpha",
        origin: { type: "user_prompt" },
      },
      {
        role: "assistant",
        content: "Remembered: remember alpha",
        toolCalls: [],
      },
    ];
    await mkdir(join(home, "sessions", "switch-history-only-snapshot"), {
      recursive: true,
    });
    await writeFile(
      join(home, "sessions", "switch-history-only-snapshot", "ledger.jsonl"),
      [
        headerLine("switch-history-only-snapshot", ledgerWorkspace),
        snapshotLine(messages, [], {
          modelSwitches: [
            {
              timestamp: "1970-01-01T00:00:00.000Z",
              from: null,
              to: { providerId: "qwen", model: "qwen3.7-plus" },
              messageOrdinal: 0,
            },
          ],
        }),
      ].join("\n"),
      "utf8",
    );

    try {
      // When
      let resumeError: unknown;
      try {
        resumeSessionStore({
          sessionId: "switch-history-only-snapshot",
          workspace,
          runtime: runtime(home, 1),
        });
      } catch (error) {
        resumeError = error;
      }

      // Then
      expect(resumeError).toBeInstanceOf(SessionStoreError);
      if (!(resumeError instanceof Error)) {
        throw new Error("Expected resume to throw an Error");
      }
      expect(resumeError.message).toContain(
        'Error: cannot resume session "switch-history-only-snapshot": snapshot model switch history is missing active model.',
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a bounded snapshot has a null-origin model switch,
    When the named session is resumed from that snapshot,
    Then the switch history is replayed for later forks`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const ledgerWorkspace = await realpath(workspace);
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const messages: readonly Message[] = [
      {
        role: "user",
        content: "remember alpha",
        origin: { type: "user_prompt" },
      },
      {
        role: "assistant",
        content: "Remembered: remember alpha",
        toolCalls: [],
      },
    ];
    await mkdir(join(home, "sessions", "null-origin-switch-snapshot"), {
      recursive: true,
    });
    await writeFile(
      join(home, "sessions", "null-origin-switch-snapshot", "ledger.jsonl"),
      [
        headerLine("null-origin-switch-snapshot", ledgerWorkspace),
        snapshotLine(messages, [], {
          activeModel: { providerId: "qwen", model: "qwen3.7-plus" },
          modelSwitches: [
            {
              timestamp: "1970-01-01T00:00:00.000Z",
              from: null,
              to: { providerId: "qwen", model: "qwen3.7-plus" },
              messageOrdinal: 0,
            },
          ],
        }),
      ].join("\n"),
      "utf8",
    );

    try {
      // When
      const resumed = resumeSessionStore({
        sessionId: "null-origin-switch-snapshot",
        workspace,
        runtime: runtime(home, 1),
      });
      const forked = forkSessionStore({
        source: resumed,
        targetSessionId: "null-origin-switch-target",
        runtime: runtime(home, 2),
      });

      // Then
      expect(resumed.activeModel).toEqual({
        providerId: "qwen",
        model: "qwen3.7-plus",
      });
      expect(forked.activeModel).toEqual({
        providerId: "qwen",
        model: "qwen3.7-plus",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given an active model exists when persisted messages replace history,
    When the named session is resumed,
    Then the replacement rebases model inheritance to the new transcript`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const originalMessages: readonly Message[] = [
      {
        role: "user",
        content: "remember alpha",
        origin: { type: "user_prompt" },
      },
      {
        role: "assistant",
        content: "Remembered: remember alpha",
        toolCalls: [],
      },
    ];
    const replacedMessages: readonly Message[] = [
      {
        role: "user",
        content: "remember beta",
        origin: { type: "user_prompt" },
      },
      {
        role: "assistant",
        content: "Remembered: remember beta",
        toolCalls: [],
      },
    ];

    try {
      const session = createSessionStore({
        sessionId: "model-switch-replaced-history",
        workspace,
        runtime: runtime(home),
      });
      const persistedMessages = persistSessionMessages({
        session,
        previousMessages: [],
        currentMessages: originalMessages,
        reason: "turn",
        consumedInputIds: [],
        runtime: runtime(home, 1),
      });
      persistSessionModelSwitch({
        session,
        from: { providerId: "fake", model: "fake" },
        to: { providerId: "qwen", model: "qwen3.7-plus" },
        consumedInputIds: [],
        runtime: runtime(home, 2),
      });

      // When
      persistSessionMessages({
        session,
        previousMessages: persistedMessages,
        currentMessages: replacedMessages,
        reason: "compaction",
        consumedInputIds: [],
        runtime: runtime(home, 3),
      });
      const resumed = resumeSessionStore({
        sessionId: "model-switch-replaced-history",
        workspace,
        runtime: runtime(home, 4),
      });
      const betaMessageId = restoredUserMessageId(resumed, "remember beta");
      const forked = forkSessionStore({
        source: resumed,
        targetSessionId: "model-switch-replaced-target",
        forkPoint: {
          beforeMessageId: betaMessageId,
          optionName: "--before-message",
        },
        runtime: runtime(home, 5),
      });

      // Then
      expect(resumed.activeModel).toEqual({
        providerId: "qwen",
        model: "qwen3.7-plus",
      });
      expect(resumed.messages).toEqual(replacedMessages);
      expect(forked.activeModel).toEqual({
        providerId: "qwen",
        model: "qwen3.7-plus",
      });
      expect(forked.messages).toEqual([]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a restored session switches models in the same process,
    When it is forked before another reload,
    Then the fork uses the updated active model from replay state`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const messages: readonly Message[] = [
      {
        role: "user",
        content: "remember alpha",
        origin: { type: "user_prompt" },
      },
      {
        role: "assistant",
        content: "Remembered: remember alpha",
        toolCalls: [],
      },
    ];

    try {
      const source = createSessionStore({
        sessionId: "same-process-switch-source",
        workspace,
        runtime: runtime(home),
      });
      persistSessionMessages({
        session: source,
        previousMessages: [],
        currentMessages: messages,
        reason: "turn",
        consumedInputIds: [],
        runtime: runtime(home, 1),
      });
      const restoredSource = resumeSessionStore({
        sessionId: "same-process-switch-source",
        workspace,
        runtime: runtime(home, 2),
      });
      persistSessionModelSwitch({
        session: restoredSource,
        from: { providerId: "fake", model: "fake" },
        to: { providerId: "qwen", model: "qwen3.7-plus" },
        consumedInputIds: [],
        runtime: runtime(home, 3),
      });

      // When
      const target = forkSessionStore({
        source: restoredSource,
        targetSessionId: "same-process-switch-target",
        runtime: runtime(home, 4),
      });
      const resumedTarget = resumeSessionStore({
        sessionId: "same-process-switch-target",
        workspace,
        runtime: runtime(home, 5),
      });

      // Then
      expect(target.activeModel).toEqual({
        providerId: "qwen",
        model: "qwen3.7-plus",
      });
      expect(resumedTarget.activeModel).toEqual({
        providerId: "qwen",
        model: "qwen3.7-plus",
      });
      expect(resumedTarget.messages).toEqual(messages);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });
});
