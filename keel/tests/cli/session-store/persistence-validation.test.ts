import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  createSessionStore,
  persistSessionMessages,
  resumeSessionStore,
  SessionStoreError,
} from "../../../src/cli/session-store.ts";
import type { Message } from "../../../src/llm/types.ts";
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
          schemaVersion: 3,
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
        schemaVersion: 4,
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
      ).toThrow(/unsupported session schema version 4/u);
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
    const messages: readonly Message[] = [{ role: "user", content: "hello" }];

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
    const firstTurn: readonly Message[] = [
      { role: "user", content: "start" },
      { role: "assistant", content: "started", toolCalls: [] },
    ];
    const malformedFollowUp: readonly Message[] = [
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
