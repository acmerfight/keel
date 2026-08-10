import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { SessionMessage } from "../../../src/agent/session-message.ts";
import {
  createSessionStore,
  persistSessionMessages,
  resumeSessionStore,
  SessionStoreError,
} from "../../../src/cli/session-store.ts";
import {
  headerLine,
  runtime,
} from "../../../src/testing/session-store-fixtures.ts";

describe("Session Store Persistence Validation", () => {
  test(`Given a persisted session record has an invalid shape,
    When the session is resumed,
    Then it fails closed before restoring partial history`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    await mkdir(join(home, "sessions", "bad-record"), { recursive: true });
    await writeFile(
      join(home, "sessions", "bad-record", "ledger.jsonl"),
      [
        headerLine("bad-record", workspace),
        JSON.stringify({
          schemaVersion: 6,
          type: "append",
          timestamp: "1970-01-01T00:00:00.000Z",
          reason: "turn",
          messages: [{ role: "assistant", content: "missing toolCalls" }],
        }),
      ].join("\n"),
      "utf8",
    );

    try {
      // When / Then
      expect(() =>
        resumeSessionStore({
          sessionId: "bad-record",
          workspace,
          runtime: runtime(home),
        }),
      ).toThrow(SessionStoreError);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a persisted session uses an unsupported schema version,
    When the session is resumed,
    Then it fails closed before restoring messages`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    await mkdir(join(home, "sessions", "future"), { recursive: true });
    await writeFile(
      join(home, "sessions", "future", "ledger.jsonl"),
      `${JSON.stringify({
        schemaVersion: 7,
        type: "session",
        id: "future",
        createdAt: "1970-01-01T00:00:00.000Z",
        workspace,
      })}\n`,
      "utf8",
    );

    try {
      // When / Then
      expect(() =>
        resumeSessionStore({
          sessionId: "future",
          workspace,
          runtime: runtime(home),
        }),
      ).toThrow(/unsupported session schema version 7/u);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a user message omits its required origin,
    When persistence attempts to save it,
    Then the ledger is rejected before any history is appended`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));

    try {
      const session = createSessionStore({
        sessionId: "reject-missing-origin",
        workspace,
        runtime: runtime(home),
      });
      const before = await readFile(session.filePath, "utf8");

      const persistMalformedMessage = () =>
        persistSessionMessages({
          session,
          previousMessages: [],
          currentMessages: [{ role: "user", content: "hello" }],
          runtime: runtime(home, 1),
          reason: "turn",
        });

      // When / Then
      expect(persistMalformedMessage).toThrow(SessionStoreError);
      expect(await readFile(session.filePath, "utf8")).toBe(before);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given reserved session-message IDs lose their message or collide,
    When persistence binds provenance to the transcript,
    Then it rejects both cases before appending ambiguous IDs`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const currentUser: SessionMessage = {
      role: "user",
      content: "Release validation uses pnpm test:coverage.",
      origin: { type: "user_prompt" },
    };
    const assistant: SessionMessage = {
      role: "assistant",
      content: "Understood.",
      toolCalls: [],
    };

    try {
      const session = createSessionStore({
        sessionId: "reserved-message-validation",
        workspace,
        runtime: runtime(home),
      });
      expect(() =>
        persistSessionMessages({
          session,
          previousMessages: [],
          currentMessages: [currentUser, assistant],
          runtime: runtime(home, 1),
          reason: "turn",
          reservedMessageIds: [
            {
              message: {
                role: "user",
                content: currentUser.content,
                origin: { type: "user_prompt" },
              },
              id: "msg_missing",
            },
          ],
        }),
      ).toThrow("reserved message is no longer present");
      expect(() =>
        persistSessionMessages({
          session,
          previousMessages: [],
          currentMessages: [currentUser, assistant],
          runtime: runtime(home, 2),
          reason: "turn",
          reservedMessageIds: [
            { message: currentUser, id: "msg_first" },
            { message: currentUser, id: "msg_second" },
          ],
        }),
      ).toThrow("reserved message id is not unique");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given no new messages were added after the last persisted state,
    When persistence is asked to save again,
    Then the ledger is left unchanged`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const messages: readonly SessionMessage[] = [
      {
        role: "user",
        content: "hello",
        origin: { type: "user_prompt" },
      },
    ];

    try {
      const session = createSessionStore({
        sessionId: "unchanged",
        workspace,
        runtime: runtime(home),
      });
      const persisted = persistSessionMessages({
        session,
        previousMessages: [],
        currentMessages: messages,
        runtime: runtime(home, 1),
        reason: "turn",
      });
      const before = await readFile(session.filePath, "utf8");

      // When
      const afterPersisted = persistSessionMessages({
        session,
        previousMessages: persisted,
        currentMessages: messages,
        runtime: runtime(home, 2),
        reason: "turn",
      });

      // Then
      const after = await readFile(session.filePath, "utf8");
      expect(afterPersisted).toEqual(messages);
      expect(after).toBe(before);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a completed transcript has already been persisted,
    When persistence receives a malformed follow-up transcript,
    Then it rejects the update before appending corrupted history`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const firstTurn: readonly SessionMessage[] = [
      {
        role: "user",
        content: "start",
        origin: { type: "user_prompt" },
      },
      { role: "assistant", content: "started", toolCalls: [] },
    ];
    const malformedFollowUp: readonly SessionMessage[] = [
      ...firstTurn,
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "duplicate", tool: "read", path: "a.txt" },
          { id: "duplicate", tool: "read", path: "b.txt" },
        ],
      },
    ];

    try {
      const session = createSessionStore({
        sessionId: "reject-malformed-persist",
        workspace,
        runtime: runtime(home),
      });
      const persisted = persistSessionMessages({
        session,
        previousMessages: [],
        currentMessages: firstTurn,
        runtime: runtime(home, 1),
        reason: "turn",
      });
      const before = await readFile(session.filePath, "utf8");

      const persistMalformedFollowUp = () =>
        persistSessionMessages({
          session,
          previousMessages: persisted,
          currentMessages: malformedFollowUp,
          runtime: runtime(home, 2),
          reason: "turn",
        });

      // When / Then
      expect(persistMalformedFollowUp).toThrow(SessionStoreError);
      expect(persistMalformedFollowUp).toThrow(
        'Error: cannot persist session "reject-malformed-persist": ledger contains duplicate pending tool call "duplicate".',
      );
      expect(await readFile(session.filePath, "utf8")).toBe(before);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });
});
