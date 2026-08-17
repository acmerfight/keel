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
import type { SessionMessage } from "../../../src/agent/session-message.ts";
import {
  consumeSessionQueuedInputs,
  createSessionStore,
  persistSessionMessages,
  persistSessionQueuedInput,
  resumeSessionStore,
} from "../../../src/cli/session-store.ts";
import {
  expectedStoredMessages,
  headerLine,
  runtime,
} from "../../../src/testing/session-store-fixtures.ts";

describe("Session Store Queued Input", () => {
  test(`Given prompt input was queued while a named session was busy,
    When the session is resumed before another turn consumes it,
    Then the queued input is restored without changing provider-visible history`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));

    try {
      const session = createSessionStore({
        sessionId: "pending-input",
        workspace,
        runtime: runtime(home),
      });
      const queuedInput = persistSessionQueuedInput({
        session,
        sequence: 3,
        line: "continue with beta",
        runtime: runtime(home, 1),
      });

      // When
      const resumed = resumeSessionStore({
        sessionId: "pending-input",
        workspace,
        runtime: runtime(home, 2),
      });

      // Then
      expect(resumed.messages).toEqual([]);
      expect(resumed.pendingInputs).toEqual([queuedInput]);
      const ledgerLines = (await readFile(session.filePath, "utf8"))
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(ledgerLines[1]).toEqual({
        schemaVersion: 10,
        type: "input_admitted",
        timestamp: "1970-01-01T00:00:00.001Z",
        id: queuedInput.id,
        sequence: 3,
        line: "continue with beta",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a queued input is consumed by a persisted turn,
    When the session is resumed,
    Then the turn is restored and the queued input is not replayed`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const messages: readonly SessionMessage[] = [
      {
        role: "user",
        content: "continue with beta",
        origin: { type: "user_prompt" },
      },
      { role: "assistant", content: "Beta complete.", toolCalls: [] },
    ];

    try {
      const session = createSessionStore({
        sessionId: "consume-input",
        workspace,
        runtime: runtime(home),
      });
      const queuedInput = persistSessionQueuedInput({
        session,
        sequence: 4,
        line: "continue with beta",
        runtime: runtime(home, 1),
      });

      // When
      persistSessionMessages({
        session,
        previousMessages: [],
        currentMessages: messages,
        runtime: runtime(home, 2),
        reason: "turn",
        consumedInputIds: [queuedInput.id, queuedInput.id],
      });
      const resumed = resumeSessionStore({
        sessionId: "consume-input",
        workspace,
        runtime: runtime(home, 3),
      });

      // Then
      expect(resumed.messages).toEqual(messages);
      expect(resumed.pendingInputs).toEqual([]);
      const ledgerLines = (await readFile(session.filePath, "utf8"))
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(ledgerLines[2]).toEqual({
        schemaVersion: 10,
        type: "append",
        timestamp: "1970-01-01T00:00:00.002Z",
        reason: "turn",
        messages: expectedStoredMessages(messages),
        consumedInputIds: [queuedInput.id],
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given pending inputs were admitted out of order,
    When the session is resumed,
    Then pending inputs replay by sequence, timestamp, and id`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const ledgerWorkspace = await realpath(workspace);
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    await mkdir(join(home, "sessions", "ordered-inputs"), {
      recursive: true,
    });
    await writeFile(
      join(home, "sessions", "ordered-inputs", "ledger.jsonl"),
      `${[
        headerLine("ordered-inputs", ledgerWorkspace),
        JSON.stringify({
          schemaVersion: 10,
          type: "input_admitted",
          timestamp: "1970-01-01T00:00:00.003Z",
          id: "sequence-last",
          sequence: 3,
          line: "third",
        }),
        JSON.stringify({
          schemaVersion: 10,
          type: "input_admitted",
          timestamp: "1970-01-01T00:00:00.002Z",
          id: "same-sequence-later",
          sequence: 1,
          line: "second by timestamp",
        }),
        JSON.stringify({
          schemaVersion: 10,
          type: "input_admitted",
          timestamp: "1970-01-01T00:00:00.001Z",
          id: "same-sequence-earlier",
          sequence: 1,
          line: "first by timestamp",
        }),
        JSON.stringify({
          schemaVersion: 10,
          type: "input_admitted",
          timestamp: "1970-01-01T00:00:00.004Z",
          id: "same-time-b",
          sequence: 2,
          line: "same timestamp second id",
        }),
        JSON.stringify({
          schemaVersion: 10,
          type: "input_admitted",
          timestamp: "1970-01-01T00:00:00.004Z",
          id: "same-time-a",
          sequence: 2,
          line: "same timestamp first id",
        }),
      ].join("\n")}\n`,
      "utf8",
    );

    try {
      // When
      const resumed = resumeSessionStore({
        sessionId: "ordered-inputs",
        workspace,
        runtime: runtime(home),
      });

      // Then
      expect(resumed.pendingInputs.map((input) => input.id)).toEqual([
        "same-sequence-earlier",
        "same-sequence-later",
        "same-time-a",
        "same-time-b",
        "sequence-last",
      ]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a queued command is handled without changing the transcript,
    When the queued input is marked consumed,
    Then later resumes do not replay that command`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));

    try {
      const session = createSessionStore({
        sessionId: "consume-command",
        workspace,
        runtime: runtime(home),
      });
      const queuedInput = persistSessionQueuedInput({
        session,
        sequence: 5,
        line: "/compact",
        runtime: runtime(home, 1),
      });

      // When
      consumeSessionQueuedInputs({
        session,
        inputIds: [queuedInput.id],
        runtime: runtime(home, 2),
      });
      const resumed = resumeSessionStore({
        sessionId: "consume-command",
        workspace,
        runtime: runtime(home, 3),
      });

      // Then
      expect(resumed.messages).toEqual([]);
      expect(resumed.pendingInputs).toEqual([]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given no queued input ids are consumed,
    When the consume request is persisted,
    Then the ledger is left unchanged`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));

    try {
      const session = createSessionStore({
        sessionId: "consume-empty",
        workspace,
        runtime: runtime(home),
      });
      const before = await readFile(session.filePath, "utf8");

      // When
      consumeSessionQueuedInputs({
        session,
        inputIds: [],
        runtime: runtime(home, 1),
      });

      // Then
      expect(await readFile(session.filePath, "utf8")).toBe(before);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a queued input is consumed after the transcript is already persisted,
    When persistence receives the same transcript with the consumed input id,
    Then it records only input consumption without duplicating messages`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const messages: readonly SessionMessage[] = [
      {
        role: "user",
        content: "remember alpha",
        origin: { type: "user_prompt" },
      },
      { role: "assistant", content: "Remembered alpha.", toolCalls: [] },
    ];

    try {
      const session = createSessionStore({
        sessionId: "consume-after-noop",
        workspace,
        runtime: runtime(home),
      });
      const queuedInput = persistSessionQueuedInput({
        session,
        sequence: 6,
        line: "/compact",
        runtime: runtime(home, 1),
      });
      const persisted = persistSessionMessages({
        session,
        previousMessages: [],
        currentMessages: messages,
        runtime: runtime(home, 2),
        reason: "turn",
      });

      // When
      persistSessionMessages({
        session,
        previousMessages: persisted,
        currentMessages: messages,
        runtime: runtime(home, 3),
        reason: "compaction",
        consumedInputIds: [queuedInput.id],
      });
      const resumed = resumeSessionStore({
        sessionId: "consume-after-noop",
        workspace,
        runtime: runtime(home, 4),
      });

      // Then
      expect(resumed.messages).toEqual(messages);
      expect(resumed.pendingInputs).toEqual([]);
      const ledgerLines = (await readFile(session.filePath, "utf8"))
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(ledgerLines.at(-1)).toEqual({
        schemaVersion: 10,
        type: "input_consumed",
        timestamp: "1970-01-01T00:00:00.003Z",
        inputIds: [queuedInput.id],
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });
});
