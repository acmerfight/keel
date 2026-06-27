import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  createSessionStore,
  persistSessionBashApprovalGrant,
  persistSessionMessages,
  persistSessionQueuedInput,
  resumeSessionStore,
  type SessionQueuedInput,
  SessionStoreError,
} from "../../../src/cli/session-store.ts";
import type { Message } from "../../../src/llm/types.ts";
import type { BashApprovalGrant } from "../../../src/permissions/bash.ts";
import {
  appendLine,
  expectedStoredMessages,
  headerLine,
  inputAdmittedLine,
  inputConsumedLine,
  runtime,
  snapshotLine,
} from "../../../src/testing/session-store-fixtures.ts";

describe("Session Store Oversized Snapshot", () => {
  test(`Given a persisted session ledger is larger than the resume cap,
    When the session is resumed,
    Then the store reports recovery guidance before parsing JSONL records`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const ledgerPath = join(home, "sessions", "huge", "ledger.jsonl");
    await mkdir(join(home, "sessions", "huge"), { recursive: true });
    await writeFile(
      ledgerPath,
      `${headerLine("huge", workspace)}\n{not-json`,
      "utf8",
    );
    await truncate(ledgerPath, 32 * 1024 * 1024 + 1);

    try {
      // When
      let resumeError: unknown;
      try {
        resumeSessionStore({
          sessionId: "huge",
          workspace,
          runtime: runtime(home),
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
        'Error: cannot resume session "huge": cannot load session ledger',
      );
      expect(resumeError.message).toContain(
        "ledger is too large to resume safely",
      );
      expect(resumeError.message).not.toContain("not valid JSON");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given an oversized session ledger has no header line,
    When the session is resumed,
    Then the store reports the missing header before tail replay`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const ledgerPath = join(home, "sessions", "no-header", "ledger.jsonl");
    await mkdir(join(home, "sessions", "no-header"), { recursive: true });
    await writeFile(ledgerPath, "\n", "utf8");
    await truncate(ledgerPath, 32 * 1024 * 1024 + 1);

    try {
      // When
      let resumeError: unknown;
      try {
        resumeSessionStore({
          sessionId: "no-header",
          workspace,
          runtime: runtime(home),
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
        'Error: cannot resume session "no-header": cannot load session ledger',
      );
      expect(resumeError.message).toContain("ledger has no session header");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given an oversized session ledger cannot be opened for reading,
    When the session is resumed,
    Then the store reports that the ledger cannot be read`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const ledgerWorkspace = await realpath(workspace);
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const ledgerPath = join(
      home,
      "sessions",
      "unreadable-huge",
      "ledger.jsonl",
    );
    await mkdir(join(home, "sessions", "unreadable-huge"), {
      recursive: true,
    });
    await writeFile(
      ledgerPath,
      `${headerLine("unreadable-huge", ledgerWorkspace)}\n`,
      "utf8",
    );
    await truncate(ledgerPath, 32 * 1024 * 1024 + 1);
    await chmod(ledgerPath, 0o000);

    try {
      // When
      let resumeError: unknown;
      try {
        resumeSessionStore({
          sessionId: "unreadable-huge",
          workspace,
          runtime: runtime(home),
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
        'Error: cannot resume session "unreadable-huge": cannot read session ledger',
      );
    } finally {
      await chmod(ledgerPath, 0o600);
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given an oversized session ledger tail has no complete records,
    When the session is resumed,
    Then the store reports recovery guidance without parsing partial bytes`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const ledgerWorkspace = await realpath(workspace);
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const ledgerPath = join(home, "sessions", "partial-tail", "ledger.jsonl");
    const header = `${headerLine("partial-tail", ledgerWorkspace)}\n`;
    await mkdir(join(home, "sessions", "partial-tail"), { recursive: true });
    await writeFile(ledgerPath, header, "utf8");
    await truncate(ledgerPath, header.length + 32 * 1024 * 1024 + 1);

    try {
      // When
      let resumeError: unknown;
      try {
        resumeSessionStore({
          sessionId: "partial-tail",
          workspace,
          runtime: runtime(home),
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
        'Error: cannot resume session "partial-tail": cannot load session ledger',
      );
      expect(resumeError.message).toContain(
        "ledger is too large to resume safely",
      );
      expect(resumeError.message).not.toContain("not valid JSON");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given an oversized session ledger tail has records but no snapshot,
    When the session is resumed,
    Then the store refuses to replay from an unbounded suffix`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const ledgerWorkspace = await realpath(workspace);
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const ledgerPath = join(home, "sessions", "suffix-only", "ledger.jsonl");
    await mkdir(join(home, "sessions", "suffix-only"), { recursive: true });
    await writeFile(
      ledgerPath,
      `${headerLine("suffix-only", ledgerWorkspace)}\n`,
      "utf8",
    );
    await truncate(ledgerPath, 32 * 1024 * 1024 + 1);
    await writeFile(
      ledgerPath,
      `\n${appendLine([{ role: "user", content: "unbounded suffix" }])}\n`,
      { encoding: "utf8", flag: "a" },
    );

    try {
      // When
      let resumeError: unknown;
      try {
        resumeSessionStore({
          sessionId: "suffix-only",
          workspace,
          runtime: runtime(home),
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
        'Error: cannot resume session "suffix-only": cannot load session ledger',
      );
      expect(resumeError.message).toContain("no bounded snapshot was found");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given an oversized session ledger tail starts on a record boundary,
    When the session is resumed,
    Then the store restores the latest snapshot from that bounded tail`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const ledgerWorkspace = await realpath(workspace);
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const ledgerPath = join(home, "sessions", "boundary-tail", "ledger.jsonl");
    const snapshottedMessages: readonly Message[] = [
      { role: "user", content: "remember boundary" },
      { role: "assistant", content: "Boundary retained.", toolCalls: [] },
    ];
    const snapshotRecord = `${snapshotLine(snapshottedMessages, [])}\n`;
    const emptyPaddingRecord = `${appendLine([
      { role: "user", content: "" },
    ])}\n`;
    const paddingContentLength =
      32 * 1024 * 1024 -
      Buffer.byteLength(snapshotRecord, "utf8") -
      Buffer.byteLength(emptyPaddingRecord, "utf8");
    expect(paddingContentLength).toBeGreaterThan(0);
    const tail = `${appendLine([
      { role: "user", content: "x".repeat(paddingContentLength) },
    ])}\n${snapshotRecord}`;
    expect(Buffer.byteLength(tail, "utf8")).toBe(32 * 1024 * 1024);
    await mkdir(join(home, "sessions", "boundary-tail"), { recursive: true });
    await writeFile(
      ledgerPath,
      `${headerLine("boundary-tail", ledgerWorkspace)}\n`,
      "utf8",
    );
    await writeFile(ledgerPath, tail, { encoding: "utf8", flag: "a" });

    try {
      // When
      const resumed = resumeSessionStore({
        sessionId: "boundary-tail",
        workspace,
        runtime: runtime(home),
      });

      // Then
      expect(resumed.messages).toEqual(snapshottedMessages);
      expect(resumed.pendingInputs).toEqual([]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given an oversized session ledger tail has a corrupt snapshot record,
    When the session is resumed,
    Then the store refuses to trust the corrupt snapshot`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const ledgerWorkspace = await realpath(workspace);
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const ledgerPath = join(
      home,
      "sessions",
      "corrupt-snapshot",
      "ledger.jsonl",
    );
    await mkdir(join(home, "sessions", "corrupt-snapshot"), {
      recursive: true,
    });
    await writeFile(
      ledgerPath,
      `${headerLine("corrupt-snapshot", ledgerWorkspace)}\n`,
      "utf8",
    );
    await truncate(ledgerPath, 32 * 1024 * 1024 + 1);
    await writeFile(
      ledgerPath,
      `\n${JSON.stringify({
        schemaVersion: 2,
        type: "snapshot",
        timestamp: "1970-01-01T00:00:00.001Z",
        reason: "size_threshold",
        messages: "not-message-array",
        pendingInputs: [],
      })}\n`,
      { encoding: "utf8", flag: "a" },
    );

    try {
      // When
      let resumeError: unknown;
      try {
        resumeSessionStore({
          sessionId: "corrupt-snapshot",
          workspace,
          runtime: runtime(home),
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
        'Error: cannot resume session "corrupt-snapshot": cannot load session ledger',
      );
      expect(resumeError.message).toContain("no bounded snapshot was found");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given an oversized session ledger has a bounded snapshot and newer records,
    When the session is resumed,
    Then snapshot state is restored and only the suffix is replayed`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const ledgerWorkspace = await realpath(workspace);
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const ledgerPath = join(home, "sessions", "snapshot-huge", "ledger.jsonl");
    const snapshottedMessages: readonly Message[] = [
      { role: "user", content: "remember alpha" },
      { role: "assistant", content: "Remembered alpha.", toolCalls: [] },
    ];
    const suffixMessages: readonly Message[] = [
      { role: "user", content: "continue with beta" },
      { role: "assistant", content: "Beta complete.", toolCalls: [] },
    ];
    const retainedInput: SessionQueuedInput = {
      id: "retained-before-snapshot",
      timestamp: "1970-01-01T00:00:00.002Z",
      sequence: 1,
      line: "continue with alpha",
    };
    const consumedInput: SessionQueuedInput = {
      id: "consumed-after-snapshot",
      timestamp: "1970-01-01T00:00:00.003Z",
      sequence: 2,
      line: "skip after suffix",
    };
    const admittedInput: SessionQueuedInput = {
      id: "admitted-after-snapshot",
      timestamp: "1970-01-01T00:00:00.004Z",
      sequence: 3,
      line: "continue with gamma",
    };
    await mkdir(join(home, "sessions", "snapshot-huge"), { recursive: true });
    await writeFile(
      ledgerPath,
      `${headerLine("snapshot-huge", ledgerWorkspace)}\n`,
      "utf8",
    );
    await truncate(ledgerPath, 32 * 1024 * 1024 + 1);
    await writeFile(
      ledgerPath,
      `\n${[
        snapshotLine(snapshottedMessages, [retainedInput, consumedInput]),
        appendLine(suffixMessages),
        inputConsumedLine([consumedInput.id]),
        inputAdmittedLine(admittedInput),
      ].join("\n")}\n`,
      { encoding: "utf8", flag: "a" },
    );

    try {
      // When
      const resumed = resumeSessionStore({
        sessionId: "snapshot-huge",
        workspace,
        runtime: runtime(home),
      });

      // Then
      expect(resumed.messages).toEqual([
        ...snapshottedMessages,
        ...suffixMessages,
      ]);
      expect(resumed.pendingInputs).toEqual([retainedInput, admittedInput]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a completed turn pushes a session ledger past the snapshot threshold,
    When the turn is persisted,
    Then the ledger stores a bounded snapshot with pending input`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const largeMessages: readonly Message[] = [
      { role: "user", content: "x".repeat(16 * 1024 * 1024) },
      { role: "assistant", content: "Large context noted.", toolCalls: [] },
    ];
    const compactedMessages: readonly Message[] = [
      { role: "user", content: "summary: alpha is important" },
      { role: "assistant", content: "Summary retained.", toolCalls: [] },
    ];

    try {
      const session = createSessionStore({
        sessionId: "snapshot-threshold",
        workspace,
        runtime: runtime(home),
      });
      const queuedInput = persistSessionQueuedInput({
        session,
        sequence: 7,
        line: "continue after the summary",
        runtime: runtime(home, 1),
      });
      const persistedLargeMessages = persistSessionMessages({
        session,
        previousMessages: [],
        currentMessages: largeMessages,
        runtime: runtime(home, 2),
        reason: "turn",
      });

      // When
      persistSessionMessages({
        session,
        previousMessages: persistedLargeMessages,
        currentMessages: compactedMessages,
        runtime: runtime(home, 3),
        reason: "compaction",
      });

      // Then
      const ledgerLines = (await readFile(session.filePath, "utf8"))
        .trimEnd()
        .split("\n");
      const lastLine = ledgerLines.at(-1);
      expect(lastLine).toBeDefined();
      if (lastLine === undefined) {
        throw new Error("Expected snapshot line");
      }
      expect(JSON.parse(lastLine)).toEqual({
        schemaVersion: 2,
        type: "snapshot",
        timestamp: "1970-01-01T00:00:00.003Z",
        reason: "size_threshold",
        messages: expectedStoredMessages(compactedMessages),
        pendingInputs: [queuedInput],
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given session bash approval grants are snapshotted,
    When the session is resumed from the bounded snapshot,
    Then the approval grants are restored`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const ledgerWorkspace = await realpath(workspace);
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const grant = {
      type: "exact",
      cwd: ledgerWorkspace,
      command: "npm test",
    } satisfies BashApprovalGrant;
    const largeMessages: readonly Message[] = [
      { role: "user", content: "x".repeat(16 * 1024 * 1024) },
    ];

    try {
      const session = createSessionStore({
        sessionId: "snapshot-bash-approvals",
        workspace,
        runtime: runtime(home),
      });
      persistSessionBashApprovalGrant({
        session,
        grant,
        runtime: runtime(home, 1),
      });

      // When
      persistSessionMessages({
        session,
        previousMessages: [],
        currentMessages: largeMessages,
        runtime: runtime(home, 2),
        reason: "turn",
      });
      const resumed = resumeSessionStore({
        sessionId: "snapshot-bash-approvals",
        workspace,
        runtime: runtime(home, 3),
      });

      // Then
      expect(resumed.bashApprovalGrants).toEqual([grant]);
      const ledgerLines = (await readFile(session.filePath, "utf8"))
        .trimEnd()
        .split("\n");
      const lastLine = ledgerLines.at(-1);
      expect(lastLine).toBeDefined();
      if (lastLine === undefined) {
        throw new Error("Expected snapshot line");
      }
      expect(JSON.parse(lastLine)).toMatchObject({
        type: "snapshot",
        bashApprovalGrants: [grant],
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });
});
